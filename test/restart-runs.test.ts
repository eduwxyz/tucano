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

it('resumes working replies when enabled, preserving progress and keeping explicit stops stopped', async () => {
  settings.resumeInterrupted = true
  reply('running', 1000, 'working')
  const msg = db.message('running')!
  db.saveMessage({ ...msg, run: { ...msg.run!, task: 'Original task', work: 'TASK-123', steps: [{ id: 's', label: 'Saved file', status: 'done' }] } })
  reply('stopped', 2000, 'stopped')
  reply('old-interrupted', 3000, 'interrupted')
  expect(db.interruptStaleRuns()).toHaveLength(1)
  await runner.resumeInterrupted()
  await runner.idle()
  expect(turns).toHaveLength(1)
  expect(turns[0]?.prompt).toContain('Original task')
  expect(turns[0]?.prompt).toContain('Partial running')
  expect(turns[0]?.prompt).toContain('Saved file')
  expect(db.message('running')?.run?.status).toBe('done')
  expect(db.messagesWithRun(['done']).some(m => m.id !== 'running' && m.run?.work === 'TASK-123')).toBe(true)
  expect(db.message('running')?.run?.restartPending).toBeUndefined()
  expect(db.message('stopped')?.run?.status).toBe('stopped')
  expect(db.message('old-interrupted')?.run?.status).toBe('interrupted')
})

it('leaves replies interrupted when recovery is disabled, without replaying them on a later start', async () => {
  settings.autoContinue = false // 0.2.41 resumes a cut reply by itself unless that is off
  settings.resumeInterrupted = true
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

it('does not resume by default or replay skipped work after enabling recovery', async () => {
  settings.autoContinue = false // the case the switch exists for: auto-continue off
  reply('running', 1000, 'working')
  db.interruptStaleRuns()
  await runner.resumeInterrupted()
  settings.resumeInterrupted = true
  await runner.resumeInterrupted()
  await runner.idle()
  expect(turns).toHaveLength(0)
  expect(db.message('running')?.run?.status).toBe('interrupted')
})

it('uses the Continue rule: thinking alone is not recovered, failed tool work is', async () => {
  settings.autoContinue = false // Recovery's own rule, without 0.2.41 auto-continue on top
  settings.resumeInterrupted = true
  reply('thinking', 1000, 'working')
  reply('failed-tool', 2000, 'working')
  for (const [id, label, status] of [['thinking', 'Thought', 'done'], ['failed-tool', 'Read file', 'error']] as const) {
    const msg = db.message(id)!
    db.saveMessage({ ...msg, run: { ...msg.run!, steps: [{ id: 's', label, status }] } })
  }
  db.interruptStaleRuns()
  await runner.resumeInterrupted()
  await runner.idle()
  expect(turns).toHaveLength(1)
  expect(db.message('thinking')?.run?.status).toBe('interrupted')
  expect(db.message('failed-tool')?.run?.status).toBe('done')
})

it('queues all interrupted replies while paused and resumes each once', async () => {
  settings.resumeInterrupted = true
  reply('one', 1000, 'working')
  reply('two', 2000, 'working')
  db.interruptStaleRuns()
  runner.setPaused(true)
  await runner.resumeInterrupted()
  await runner.resumeInterrupted()
  expect(turns).toHaveLength(0)
  expect(db.message('one')?.run?.restartPending).toBe(true)
  expect(db.message('one')?.run?.status).toBe('interrupted')
  runner.setPaused(false)
  await runner.idle()
  expect(turns).toHaveLength(2)
  expect(db.message('one')?.run?.status).toBe('done')
  expect(db.message('two')?.run?.status).toBe('done')
})

it('does not restart approval waits, questions, budget pauses, failures or completed replies', async () => {
  for (const status of ['waiting_approval', 'waiting_input', 'paused', 'failed', 'done'] as const) reply(status, 1000, status)
  expect(db.interruptStaleRuns()).toHaveLength(0)
  await runner.resumeInterrupted()
  expect(turns).toHaveLength(0)
})

it('does not recover an archived agent', async () => {
  settings.resumeInterrupted = true
  reply('running', 1000, 'working')
  db.interruptStaleRuns()
  db.saveAgent({ ...db.agent('a')!, archived: true })
  await runner.resumeInterrupted()
  expect(turns).toHaveLength(0)
})

it('brings back every cut reply, each exactly once, with auto-continue and with Recovery', async () => {
  // What a shutdown leaves behind: several sessions working at once, in their own conversations.
  // On 19 Nov the startup pass and the Recovery pass read the same rows, and one session came back
  // out of six: the first pass marked the reply done, so the second found nothing for it.
  const others = ['b', 'c', 'd']
  for (const id of others) {
    db.saveAgent({ ...db.agent('a')!, id, handle: id, name: id.toUpperCase() })
    db.createConversation({ id: `dm-${id}`, kind: 'dm', name: id, members: [id] })
  }
  for (const [i, id] of ['a', ...others].entries()) {
    const conv = id === 'a' ? 'dm' : `dm-${id}`
    db.saveMessage({ id: `ask-${id}`, conversationId: conv, author: { kind: 'person', id: db.ownerId() }, text: `Request ${id}`, at: 1000 + i })
    db.saveMessage({ id: `cut-${id}`, conversationId: conv, author: { kind: 'agent', id }, text: `Partial ${id}`, at: 1001 + i, run: { status: 'working', steps: [{ id: `s-${id}`, label: 'Read file', status: 'done' }] } })
  }
  expect(db.interruptStaleRuns()).toHaveLength(4)

  // Both switches on: the person's Recovery and the default auto-continue, read by one pass.
  settings.resumeInterrupted = true
  await runner.resumeInterrupted()
  await runner.resumeInterrupted() // startup reaches it twice; the second pass must not start them again
  await runner.idle()
  expect(turns).toHaveLength(4)
  for (const id of ['a', ...others]) {
    expect(db.message(`cut-${id}`)?.run?.status).toBe('done')
    expect(turns.filter((t) => t.prompt.includes(`Partial ${id}`)).length).toBeLessThanOrEqual(1)
  }
  // Each one went on in a new reply of its own conversation: four sessions, four replies.
  expect(db.messagesWithRun(['working']).every((m) => m.id.startsWith('cut-'))).toBe(true)

  // And with auto-continue off but Recovery on, the same four come back, once each.
  turns.length = 0
  for (const id of ['a', ...others]) {
    const conv = id === 'a' ? 'dm' : `dm-${id}`
    db.saveMessage({ id: `cut2-${id}`, conversationId: conv, author: { kind: 'agent', id }, text: `Again ${id}`, at: 2000, run: { status: 'working', steps: [{ id: `s2-${id}`, label: 'Read file', status: 'done' }] } })
  }
  db.interruptStaleRuns()
  settings.autoContinue = false
  await runner.resumeInterrupted()
  await runner.idle()
  expect(turns).toHaveLength(4)
})

afterEach(async () => { await runner.idle(); db.close() })

function reply(id: string, at: number, status: NonNullable<Message['run']>['status']): void {
  db.saveMessage({ id: `ask-${id}`, conversationId: 'dm', author: { kind: 'person', id: db.ownerId() }, text: `Request ${id}`, at: at - 1 })
  db.saveMessage({ id, conversationId: 'dm', author: { kind: 'agent', id: 'a' }, text: `Partial ${id}`, at, run: { status, steps: [{ id: `step-${id}`, label: 'Read file', status: 'done' }] } })
}
