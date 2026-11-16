import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { Db } from '../src/core/db'
import { Runner } from '../src/core/runs'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent } from '../src/core/engines/types'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import type { CoreEvent } from '../src/shared/rpc'


it.each(['thinking', 'silent', 'rejected'])('starts a clean reasoning attempt on a %s retry through Runner and the renderer store', async (retry) => {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'r245-concurrency-')), 'test.db'))
  const a: Agent = { id: 'a1', name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  db.saveAgent(a)
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  let attempt = 0
  const claude: Engine = { id: 'claude', run: () => (async function* (): AsyncIterable<EngineEvent> {
    attempt++
    if (attempt === 1 || retry === 'thinking') yield { type: 'thinking', delta: attempt === 1 ? 'FIRST-ATTEMPT' : 'SECOND-ATTEMPT' }
    if (attempt === 1) yield { type: 'error', message: 'synthetic failure' }
    else { yield { type: 'text', delta: 'answer' }; yield { type: 'done', text: 'answer', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } } }
  })() }
  const engines = Object.fromEntries((['claude','codex','opencode','pi','antigravity','cursor','grok','cline','hermes'] as EngineId[]).map(id => [id, id === 'claude' ? claude : fakeEngine(id)])) as Record<EngineId, Engine>
  const ready = { installed: true, loggedIn: true }
  const settings = { workspaceName: 'Review', context: '', engines: Object.fromEntries(Object.keys(engines).map(id => [id, ready])), routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en', showThinking: true } as Settings
  const events: CoreEvent[] = []
  const store = await renderer(settings)
  store.emit({ type: 'thinking', id: 'unrelated', text: 'STILL-WORKING' })
  const r = new Runner({ db, engines, settings: async () => settings, workDir: mkdtempSync(join(tmpdir(), 'r245-work-')), emit: e => { events.push(e); store.emit(e) } })
  await r.send('d1', 'hello')
  await r.idle()
  const reply = db.messages().find(m => m.author.kind === 'agent')!
  expect(reply.run?.status).toBe('failed')
  expect(store.liveThought(reply.id)).toBe('FIRST-ATTEMPT')
  r.setPaused(true)
  r.retry(reply.id)
  await r.idle()
  expect(store.liveThought(reply.id)).toBe('FIRST-ATTEMPT')
  expect(attempt).toBe(1)
  r.setPaused(false)
  if (retry === 'rejected') settings.engines.claude = { installed: true, loggedIn: false }
  r.retry(reply.id)
  await r.idle()
  expect(db.message(reply.id)?.run?.status).toBe(retry === 'rejected' ? 'failed' : 'done')
  expect(store.liveThought(reply.id)).toBe(retry === 'thinking' ? 'SECOND-ATTEMPT' : undefined)
  expect(store.liveThought('unrelated')).toBe('STILL-WORKING')
  expect(events.filter(e => e.type === 'message' && e.message.id === reply.id && e.attemptStart)).toHaveLength(2)
  // Recovery continuation uses a new reply; it must leave the cut reply's reasoning alone.
  settings.engines.claude = ready
  const cut = db.message(reply.id)!
  cut.run = { ...cut.run!, status: 'interrupted', steps: [{ id: 'worked', label: 'Read a page', status: 'done' }] }
  db.saveMessage(cut)
  const retained = store.liveThought(reply.id)
  await r.continue(reply.id)
  await r.idle()
  expect(store.liveThought(reply.id)).toBe(retained)
  expect(db.messages().filter(m => m.author.kind === 'agent')).toHaveLength(2)
  db.close()
})

async function renderer(settings: Settings) {
  vi.resetModules()
  let listener: (event: any) => void = () => {}
  const port = { onmessage: null as ((event: any) => void) | null, postMessage(request: any) { queueMicrotask(() => port.onmessage!({ data: { id: request.id, result: { settings, agents: [], conversations: [], messages: [], since: {}, connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'windows', packaged: false, isolatedComputers: true, people: [], you: '' } } })) } }
  const win = { addEventListener: (_: string, next: (event: any) => void) => { listener = next }, removeEventListener: () => {}, tucano: { onNavigate: () => {}, viewing: () => {}, connect: () => queueMicrotask(() => listener({ source: win, data: 'core:port', ports: [port] })) } }
  Object.assign(globalThis, { window: win })
  const store = await import('../src/renderer/src/store')
  await store.start()
  return { ...store, emit: (event: CoreEvent) => port.onmessage!({ data: { event } }) }
}

it('preserves reasoning on working updates and pause/steering continuation messages without an attempt boundary', async () => {
  const store = await renderer({ workspaceName: 'Review', language: 'en', showThinking: true } as Settings)
  const message = { id: 'reply', conversationId: 'room', author: { kind: 'agent' as const, id: 'a1' }, text: '', at: 1 }
  store.emit({ type: 'message', message: { ...message, run: { status: 'working', steps: [] } }, attemptStart: true })
  store.emit({ type: 'thinking', id: 'reply', text: 'current reasoning' })
  for (const status of ['working', 'waiting_input', 'working', 'paused', 'working'] as const) {
    store.emit({ type: 'message', message: { ...message, run: { status, steps: [] } } })
    expect(store.liveThought('reply')).toBe('current reasoning')
  }
})
