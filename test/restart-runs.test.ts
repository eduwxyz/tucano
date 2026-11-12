import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Runner } from '../src/core/runs'
import { fakeEngine } from '../src/core/engines/fake'
import { Memories } from '../src/core/memory'
import { settingsPatchError } from '../src/core/settings-patch'
import type { Engine, Turn } from '../src/core/engines/types'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'

let db: Db
let runner: Runner
let turns: Turn[]
let settings: Settings
let memory: Memories
const engines = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes'] as const

it('accepts the recovery setting only as a boolean', () => {
  expect(settingsPatchError({ resumeInterrupted: false })).toBeUndefined()
  expect(settingsPatchError({ resumeInterrupted: true })).toBeUndefined()
  expect(settingsPatchError({ resumeInterrupted: 'false' })).toBeTruthy()
})

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

it('resumes working replies by default, preserving progress and keeping explicit stops stopped', async () => {
  reply('running', 1000, 'working')
  const msg = db.message('running')!
  db.saveMessage({ ...msg, run: { ...msg.run!, task: 'Original task', work: 'TASK-123', steps: [{ id: 's', label: 'Saved file', status: 'done' }] } })
  reply('stopped', 2000, 'stopped')
  reply('old-interrupted', 3000, 'interrupted')
  expect(db.interruptStaleRuns()).toBe(1)
  await runner.resumeInterrupted()
  await runner.idle()
  expect(turns).toHaveLength(1)
  expect(turns[0]?.prompt).toContain('Original task')
  expect(turns[0]?.prompt).toContain('Partial running')
  expect(turns[0]?.prompt).toContain('Saved file')
  expect(db.message('running')?.run).toMatchObject({ status: 'done', work: 'TASK-123' })
  expect(db.message('running')?.run?.restartPending).toBeUndefined()
  expect(db.message('stopped')?.run?.status).toBe('stopped')
  expect(db.message('old-interrupted')?.run?.status).toBe('interrupted')
})

it('leaves replies interrupted when recovery is disabled, without replaying them on a later start', async () => {
  reply('running', 1000, 'working')
  db.interruptStaleRuns()
  settings.resumeInterrupted = false
  await runner.resumeInterrupted()
  settings.resumeInterrupted = true
  await runner.resumeInterrupted()
  await runner.idle()
  expect(turns).toHaveLength(0)
  expect(db.message('running')?.run?.status).toBe('interrupted')
})

it('queues all interrupted replies while paused and resumes each once', async () => {
  reply('one', 1000, 'working')
  reply('two', 2000, 'working')
  db.interruptStaleRuns()
  runner.setPaused(true)
  await runner.resumeInterrupted()
  await runner.resumeInterrupted()
  expect(turns).toHaveLength(0)
  expect(db.message('one')?.run?.restartPending).toBe(true)
  runner.setPaused(false)
  await runner.idle()
  expect(turns).toHaveLength(2)
  expect(db.message('one')?.run?.status).toBe('done')
  expect(db.message('two')?.run?.status).toBe('done')
})

it('does not restart approval waits, questions, budget pauses, failures or completed replies', async () => {
  for (const status of ['waiting_approval', 'waiting_input', 'paused', 'failed', 'done'] as const) reply(status, 1000, status)
  expect(db.interruptStaleRuns()).toBe(0)
  await runner.resumeInterrupted()
  expect(turns).toHaveLength(0)
})

it('does not recover an archived agent', async () => {
  reply('running', 1000, 'working')
  db.interruptStaleRuns()
  db.saveAgent({ ...db.agent('a')!, archived: true })
  await runner.resumeInterrupted()
  expect(turns).toHaveLength(0)
})

afterEach(async () => { await runner.idle(); db.close() })

function reply(id: string, at: number, status: NonNullable<Message['run']>['status']): void {
  db.saveMessage({ id: `ask-${id}`, conversationId: 'dm', author: { kind: 'person', id: db.ownerId() }, text: `Request ${id}`, at: at - 1 })
  db.saveMessage({ id, conversationId: 'dm', author: { kind: 'agent', id: 'a' }, text: `Partial ${id}`, at, run: { status, steps: [] } })
}

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
