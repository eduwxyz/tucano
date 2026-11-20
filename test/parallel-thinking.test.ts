// Engines run tool calls side by side (Pi, Codex and Claude Code all do): two commands
// started together used to close each other's row as "Thought" and each add its own
// "Thinking" when done, so the reply showed two "Thinking" rows that spun and stopped
// together. One call at a time or several at once, there is one "Thinking" row, and a
// command keeps its own label.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent } from '../src/shared/rpc'
import type { EngineId, Message, Settings, Step } from '../src/shared/types'
import { formatExec } from '../src/core/computer'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

let db: Db
let gateway: Gateway
let settings: Settings
let events: CoreEvent[]

// Two commands at once, as an engine with parallel tool calls sends them; then one more.
function parallel(id: EngineId): Engine {
  return {
    id,
    async *run(turn) {
      if (turn.mcpUrl) {
        await Promise.all([callTool(turn.mcpUrl, 'bash', { command: 'git worktree list' }), callTool(turn.mcpUrl, 'bash', { command: 'ls -la build' })])
        await callTool(turn.mcpUrl, 'bash', { command: 'echo ok' })
      }
      yield { type: 'text', delta: 'feito' }
      yield { type: 'done', text: 'feito', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

// The first command takes longer than the second, so they overlap and end apart.
const computers = {
  call: async (_a: unknown, _name: string, args: Record<string, unknown>) => {
    const command = String(args['command'])
    await new Promise((ok) => setTimeout(ok, command.startsWith('git') ? 80 : 20))
    return { result: textResult(formatExec({ code: 0, stdout: 'one\ntwo', stderr: '' }, 10)) }
  }
}

async function run(engine: EngineId, modelId: string): Promise<Step[]> {
  db.saveAgent({ id: 'theo', name: 'Theo', handle: 'theo', role: '', color: 'sky', instructions: '', modelId, effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: true, computerKind: 'mac', archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'theo', members: ['theo'] })
  const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor'] as EngineId[]).map((e) => [e, e === engine ? parallel(e) : fakeEngine(e)])) as Record<EngineId, Engine>
  const runner = new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'pt-w-')), gateway, computers })
  await runner.send('dm', 'confere o worktree')
  await runner.idle()
  return db.messages().filter((m: Message) => m.author.kind === 'agent').at(-1)!.run!.steps
}

beforeAll(() => setLang('en'))
afterAll(() => setLang('pt'))
beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'pt-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe.each([
  ['pi', 'pi:opencode-go/deepseek-v4.1-flash'],
  ['claude', 'sonnet'],
  ['codex', 'gpt-5.6-luna']
] as [EngineId, string][])('an agent on %s running two tool calls at once', (engine, modelId) => {
  it('never shows more than one "Thinking" row', async () => {
    await run(engine, modelId)
    const lists = events.flatMap((e) => (e.type === 'message' && e.message.author.kind === 'agent' && e.message.run ? [e.message.run.steps] : []))
    expect(lists.length).toBeGreaterThan(0)
    for (const steps of lists) expect(steps.filter((s) => s.label === 'Thinking').length).toBeLessThanOrEqual(1)
  })

  it('keeps each command as its own row, with its own label', async () => {
    const steps = await run(engine, modelId)
    expect(steps.map((s) => s.label)).toEqual(['Thought', 'Ran', 'Ran', 'Thought', 'Ran', 'Replied'])
    expect(steps.filter((s) => s.label === 'Ran').map((s) => s.input ?? s.detail).sort()).toEqual(['echo ok', 'git worktree list', 'ls -la build'])
    expect(steps.every((s) => s.status === 'done')).toBe(true)
  })
})
