import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Memories, WINDOW } from '../src/core/memory'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import type { EngineId, Settings } from '../src/shared/types'

function workspace() {
  const data = mkdtempSync(join(tmpdir(), 'tucano-retention-summary-'))
  const db = new Db(join(data, 'tucano.db'))
  db.createConversation({ id: 'room', kind: 'channel', name: 'room', members: [] })
  for (let n = 0; n < WINDOW + 2; n++) db.saveMessage({ id: `m${n}`, conversationId: 'room', author: { kind: 'person', id: db.ownerId() }, text: 'Private source text', at: n + 1 })
  return { db, data }
}

it('invalidates conversation and retained thread summaries when their history is removed', () => {
  const { db } = workspace()
  try {
    db.saveMessage({ id: 'child', conversationId: 'room', author: { kind: 'person', id: db.ownerId() }, text: 'Deleted context', at: 100, threadId: 'm0' })
    db.setSummary('room', 'Deleted context', 100)
    db.setThreadSummary('m0', 'Deleted context', 100)
    db.forget(['child'])
    expect(db.conversation('room')?.summary).toBeFalsy()
    expect(db.conversation('room')?.summaryUntil).toBeUndefined()
    expect(db.message('m0')?.threadSummary).toBeUndefined()
  } finally { db.close() }
})

it.each(['conversation', 'thread'] as const)('discards pending %s consolidation after history changes', async (kind) => {
  const { db, data } = workspace()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const base = fakeEngine('claude')
  const engine: Engine = { ...base, async *run() {
    entered()
    await gate
    yield { type: 'text', delta: JSON.stringify({ summary: 'Deleted context', memories: [{ op: 'add', text: 'Deleted context', evidence: [1] }] }) }
  } }
  const engines = Object.fromEntries(['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes'].map((id) => [id, engine])) as Record<EngineId, Engine>
  const settings = { workspaceName: 'Ana', memoryModel: 'haiku', memoryLearning: 'auto', engines: { claude: { installed: true, loggedIn: true } } } as Settings
  const memory = new Memories({ db, engines, settings: async () => settings, emit: () => {}, workDir: data })
  try {
    if (kind === 'thread') db.saveMessage({ id: 'child', conversationId: 'room', author: { kind: 'person', id: db.ownerId() }, text: 'Deleted context', at: 100, threadId: 'm0' })
    const pending = kind === 'thread' ? memory.consolidateThread('m0', 'now') : memory.consolidate('room', true)
    await started
    db.forget([kind === 'thread' ? 'child' : 'm1'])
    release()
    await pending
    expect(db.conversation('room')?.summary).toBeFalsy()
    expect(db.message('m0')?.threadSummary).toBeUndefined()
    expect(db.memories()).toHaveLength(0)
  } finally { release(); await memory.idle(); db.close() }
})
