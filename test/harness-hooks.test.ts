import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { type Agent, type EngineId, type Message, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

let db: Db
let events: CoreEvent[]
let settings: Settings
let workDir: string

function runner(): Runner {
  const engines: Record<EngineId, ReturnType<typeof fakeEngine>> = {
    claude: fakeEngine('claude', { delayMs: 1 }),
    codex: fakeEngine('codex', { delayMs: 1 }),
    opencode: fakeEngine('opencode'),
    pi: fakeEngine('pi'),
    antigravity: fakeEngine('antigravity'),
    cursor: fakeEngine('cursor'),
    grok: fakeEngine('grok'),
    cline: fakeEngine('cline'),
    hermes: fakeEngine('hermes'),
    endpoint: fakeEngine('endpoint')
  }
  workDir = mkdtempSync(join(tmpdir(), 'ad-work-'))
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir })
}

const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

const hookScript = (out: string): { command: string; args: string[] } => {
  const file = join(mkdtempSync(join(tmpdir(), 'ad-hook-')), 'hook.mjs')
  writeFileSync(
    file,
    `
import { appendFileSync } from 'node:fs'
let s = ''
process.stdin.setEncoding('utf8')
for await (const c of process.stdin) s += c
appendFileSync(${JSON.stringify(out)}, s + '\\n')
`
  )
  return { command: process.execPath, args: [file] }
}

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('native turn hooks', () => {
  it('does not spawn anything when Settings leave hooks off', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(reply?.run?.hooks).toBeUndefined()
  })

  it('emits one turn-start and one turn-end with the contract, and records them on the run', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ad-hook-out-')), 'events.jsonl')
    const { command, args } = hookScript(out)
    settings = { ...settings, hooks: { enabled: true, command, args, captureOwner: true } }
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(reply?.run?.hooks).toHaveLength(2)
    expect(reply?.run?.hooks?.map((h) => h.event)).toEqual(['turn-start', 'turn-end'])
    expect(reply?.run?.hooks?.every((h) => h.exit === 0)).toBe(true)
    const lines = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; version: number; session: string; captureOwner?: string; reply?: { text: string }; cwd: string; message: { author: string; text: string } })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ version: 1, event: 'turn-start', session: `run-${reply!.id}`, captureOwner: 'tucano', cwd: join(workDir, 'a1'), message: { author: 'person', text: 'oi' } })
    expect(lines[1]).toMatchObject({ version: 1, event: 'turn-end', session: `run-${reply!.id}` })
    expect(lines[1]!.reply?.text).toBeTruthy()
  })

  it('fail-open: a missing command does not change the reply, and shows on the run', async () => {
    settings = { ...settings, hooks: { enabled: true, command: join(mkdtempSync(join(tmpdir(), 'ad-missing-')), 'nope') } }
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    const [reply] = replies()
    expect(reply?.run?.status).toBe('done')
    expect(reply?.text).toContain('Resposta de teste')
    expect(reply?.run?.hooks?.[0]?.exit).not.toBe(0)
  })

  it('an agent with hooks off is silent while others inherit', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'ad-hook-out-')), 'events.jsonl')
    const { command, args } = hookScript(out)
    settings = { ...settings, hooks: { enabled: true, command, args } }
    db.saveAgent(agent('a1', 'lia', { hooks: 'off' }))
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    expect(replies()[0]?.run?.hooks).toBeUndefined()
    expect(() => readFileSync(out, 'utf8')).toThrow()
  })
})
