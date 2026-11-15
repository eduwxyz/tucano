import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Runner } from '../src/core/runs'
import { fakeEngine } from '../src/core/engines/fake'
import { Memories } from '../src/core/memory'
import type { Engine, Turn } from '../src/core/engines/types'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'

let db: Db
let runner: Runner
let turns: Turn[]
let settings: Settings
let memory: Memories
const engines = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes'] as const

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-restart-'))
  db = new Db(join(dir, 'test.db'))
  turns = []
  settings = { workspaceName: 'Test', context: '', engines: Object.fromEntries(engines.map((id) => [id, { installed: true, loggedIn: true }])), routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'off', defaultLimit: 0, approvalTtlHours: 24, theme: 'system', language: 'en' } as Settings
  const impls = Object.fromEntries(engines.map((id) => {
    const fake = fakeEngine(id, { delayMs: 1 })
    return [id, { ...fake, run: (turn: Turn) => { turns.push(turn); return fake.run(turn) } }]
  })) as Record<EngineId, Engine>
  memory = new Memories({ db, engines: impls, settings: async () => settings, emit: () => {}, workDir: join(dir, 'work') })
  runner = new Runner({ db, engines: impls, settings: async () => settings, emit: () => {}, workDir: join(dir, 'work'), memory })
  const agent: Agent = { id: 'a', name: 'Agent', handle: 'agent', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'read', computer: false, archived: false }
  db.saveAgent(agent)
  db.createConversation({ id: 'dm', kind: 'dm', name: 'Agent', members: ['a'] })
})

it('retrieves an older retry before the SQL history limit, without later summary or messages', async () => {
  reply('old', 1000, 'stopped')
  for (let n = 0; n < 250; n++) db.saveMessage({ id: `later-${n}`, conversationId: 'dm', author: { kind: 'person', id: db.ownerId() }, text: `Later ${n}`, at: 2000 + n })
  db.setSummary('dm', 'Future summary', 2200)
  runner.retry('old')
  await runner.idle()
  expect(turns).toHaveLength(1)
  expect(turns[0]?.prompt).toContain('Request old')
  expect(turns[0]?.prompt).not.toContain('Later')
  expect(turns[0]?.prompt).not.toContain('Future summary')
})

it('retries every stopped reply in one DM, including older replies', async () => {
  reply('first', 1000, 'stopped')
  reply('second', 2000, 'stopped')
  reply('third', 3000, 'stopped')
  for (const id of ['first', 'second', 'third']) runner.retry(id)
  await runner.idle()
  expect(turns).toHaveLength(3)
  for (const id of ['first', 'second', 'third']) expect(db.message(id)?.run?.status).toBe('done')
  expect(turns[0]?.prompt).toContain('Request first')
  expect(turns[0]?.prompt).not.toContain('Request second')
})
afterEach(async () => { await runner.idle(); db.close() })

function reply(id: string, at: number, status: NonNullable<Message['run']>['status']): void {
  db.saveMessage({ id: `ask-${id}`, conversationId: 'dm', author: { kind: 'person', id: db.ownerId() }, text: `Request ${id}`, at: at - 1 })
  db.saveMessage({ id, conversationId: 'dm', author: { kind: 'agent', id: 'a' }, text: `Partial ${id}`, at, run: { status, steps: [] } })
}

