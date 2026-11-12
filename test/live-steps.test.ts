// An agent that works through a skill and shell commands (a databricks-query skill running the
// databricks CLI on its computer) reads as it goes, like its connector calls: which skill it read,
// the SQL it ran (pulled out of the command), the rows that came back or why it failed, and never a
// secret. Claude Code and Codex run here with their own shells off, so every command comes through
// the gateway's `bash`: the scripted turns below call it the way each CLI does.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings, Skill, Step } from '../src/shared/types'
import { formatExec } from '../src/core/computer'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const TOKEN = ['dapi', '0123456789abcdef'.repeat(2)].join('') // made up, and built so secret scanners don't take it for a real one
const SQL = 'select region, sum(total) as total from main.sales.daily_revenue group by region'
const BOX = '+--------+-------+\n| region | total |\n+--------+-------+\n| Sul    |   120 |\n| Norte  |    80 |\n+--------+-------+'

const skill: Skill = { id: 's1', name: 'databricks-query', description: 'Run SQL on Databricks with the CLI', body: 'Run `databricks sql execute --statement "<sql>"`.', agents: [], state: 'active', source: '/home/me/.claude/skills/databricks-query/SKILL.md', createdAt: 0, updatedAt: 0 }

let db: Db
let gateway: Gateway
let settings: Settings
let events: CoreEvent[]

// A turn like a CLI's: reads the skill, runs the SQL through the databricks CLI, then a command that fails.
function scripted(id: EngineId): Engine {
  return {
    id,
    async *run(turn) {
      if (turn.mcpUrl) {
        await callTool(turn.mcpUrl, 'ler_skill', { nome: 'databricks-query' })
        await callTool(turn.mcpUrl, 'bash', { command: `DATABRICKS_TOKEN=${TOKEN} databricks sql execute --warehouse-id w1 --statement "${SQL}"` })
        await callTool(turn.mcpUrl, 'bash', { command: `databricks fs ls dbfs:/missing --token ${TOKEN}` })
        await callTool(turn.mcpUrl, 'read_file', { path: 'out/report.csv' })
      }
      yield { type: 'text', delta: 'feito' }
      yield { type: 'done', text: 'feito', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

// The agent's computer, as the real one answers: "exit code N / --- stdout --- / --- stderr ---".
const computers = {
  call: async (_a: Agent, name: string, args: Record<string, unknown>) => {
    if (name === 'read_file') return { result: textResult('id,total\n1,10\n2,20\n3,30') }
    const command = String(args['command'])
    if (command.includes('dbfs:/missing')) return { result: textResult(formatExec({ code: 1, stdout: '', stderr: `Error: Invalid access token ${TOKEN}\nError: no such directory: dbfs:/missing` }, 120), true) }
    await new Promise((ok) => setTimeout(ok, 50))
    return { result: textResult(formatExec({ code: 0, stdout: BOX, stderr: '' }, 120)) }
  }
}
const skills = {
  forAgent: () => [skill],
  read: () => ({ reply: `# ${skill.name}\n${skill.body}`, skill }),
  propose: () => ({ reply: 'no', error: true })
}

async function run(engine: EngineId, modelId: string): Promise<Step[]> {
  db.saveAgent({ id: 'theo', name: 'Theo', handle: 'theo', role: '', color: 'sky', instructions: '', modelId, effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: true, computerKind: 'mac', archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'theo', members: ['theo'] })
  const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor'] as EngineId[]).map((e) => [e, e === engine ? scripted(e) : fakeEngine(e)])) as Record<EngineId, Engine>
  const runner = new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ls-w-')), gateway, computers, skills })
  await runner.send('dm', 'quanto vendemos por região?')
  await runner.idle()
  return db.messages().filter((m: Message) => m.author.kind === 'agent').at(-1)!.run!.steps
}

beforeAll(() => setLang('en'))
afterAll(() => setLang('pt'))
beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ls-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe.each([
  ['claude', 'sonnet'],
  ['codex', 'gpt-5.6-luna']
] as [EngineId, string][])('an agent on %s working through a skill and the databricks CLI', (engine, modelId) => {
  it('says which skill it read, the SQL it ran, and the rows that came back', async () => {
    const steps = await run(engine, modelId)
    expect(steps.find((s) => s.label === 'Read the skill')).toMatchObject({ detail: 'databricks-query', status: 'done' })
    const sql = steps.find((s) => s.label === 'Ran SQL')!
    expect(sql).toMatchObject({ status: 'done', input: SQL, output: '2 rows' })
    expect(sql.detail).toBe('DATABRICKS_TOKEN=•••• databricks sql execute --warehouse-id w1 --statement "…"')
    expect(steps.find((s) => s.label === 'Read')).toMatchObject({ detail: 'out/report.csv', output: '3 rows' })
  })

  it('shows the SQL while the command still runs', async () => {
    await run(engine, modelId)
    const running = events.flatMap((e) => (e.type === 'message' ? (e.message.run?.steps ?? []) : [])).find((s) => s.label === 'Ran SQL' && s.status === 'running')
    expect(running?.input).toBe(SQL)
  })

  it('a command that fails gives its exit code and stderr, and no step ever shows the token', async () => {
    const steps = await run(engine, modelId)
    const failed = steps.find((s) => s.status === 'error')!
    expect(failed).toMatchObject({ label: 'Ran', input: 'databricks fs ls dbfs:/missing --token ••••' })
    expect(failed.error).toBe('exit code 1: Error: Invalid access token ••••\nError: no such directory: dbfs:/missing')
    expect(JSON.stringify(events.filter((e) => e.type === 'message'))).not.toContain(TOKEN)
  })
})
