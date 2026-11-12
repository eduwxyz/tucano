// A routine with nothing to report: it answers [SILENT], the reply is empty (one quiet line),
// and nobody is told — no notification, no unread badge. Outside a routine the marker is text
// like any other.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { silentOf, SILENT } from '../src/shared/silent'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const WEEKDAYS = [1, 2, 3, 4, 5]

describe('the [SILENT] marker', () => {
  it('is silence when it is all of it, however it was written', () => {
    for (const text of [SILENT, '  [SILENT]\n', '[silent]', '**[SILENT]**', '`[SILENT]`', '"[SILENT]"', '[SILENT].', '\n\n[SILENT]\n\n']) {
      expect(silentOf(text), text).toEqual({ silent: true, text: '' })
    }
  })

  it("isn't silence when there is something to read, and the marker never shows", () => {
    expect(silentOf('Nada novo por aqui.')).toEqual({ silent: false, text: 'Nada novo por aqui.' })
    expect(silentOf('Nada novo por aqui. [SILENT]')).toEqual({ silent: false, text: 'Nada novo por aqui.' })
    expect(silentOf('[SILENT]\n\nMas a fatura de ontem venceu.')).toEqual({ silent: false, text: 'Mas a fatura de ontem venceu.' })
    // In the middle of a sentence it's a word like any other: nothing is taken out.
    expect(silentOf('o marcador [SILENT] quer dizer silêncio')).toEqual({ silent: false, text: 'o marcador [SILENT] quer dizer silêncio' })
  })
})

describe('a routine with nothing to report', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false })

  let db: Db
  let gateway: Gateway
  let runner: Runner
  let routines: Routines
  let notes: { title: string; body: string }[]
  let said: string // what the engine answers
  let askFirst: boolean // …after asking something through the gateway
  let asked: string // the prompt of the last turn

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-silent-')), 'test.db'))
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1'] })
    notes = []
    asked = ''
    askFirst = false
    said = 'Resposta de teste'
    const base = fakeEngine('claude', { delayMs: 1 })
    // The fake engine, answering with this test's text and, when asked to, a question through the gateway.
    const claude: Engine = {
      id: 'claude',
      async *run(turn: Turn) {
        asked = turn.prompt
        if (askFirst && turn.mcpUrl) await callTool(turn.mcpUrl, 'ask_user', { question: 'Pra quando você precisa disso?' })
        for await (const e of base.run(turn)) {
          if (e.type === 'done') yield { ...e, text: said }
          else if (e.type !== 'text') yield e
        }
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') } as Record<EngineId, Engine>
    // As the core does it: every message that goes out is weighed for unread.
    const emit = (e: CoreEvent): void => {
      if (e.type === 'message') db.recordActivity(e.message, null)
    }
    gateway = new Gateway()
    await gateway.start()
    routines = new Routines({
      db,
      runner: { runRoutine: (r, when) => runner.runRoutine(r, when) },
      emit,
      now: () => at(2026, 10, 19, 9, 0),
      notify: (title, body) => notes.push({ title, body })
    })
    runner = new Runner({ db, engines, settings: async () => settings, emit, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, routines })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const settle = async (): Promise<void> => {
    await routines.idle()
    await runner.idle()
  }
  // One run of the routine, now; resolves once nothing is left working.
  const run = async (): Promise<void> => {
    const r = routines.save({ name: 'Bom dia', agentId: 'a1', conversationId: 'c1', prompt: 'Resume o que está aberto no Linear.', schedule: { days: WEEKDAYS, time: '09:00' }, enabled: true })
    routines.runNow(r.id)
    await settle()
  }
  const messages = () => db.messages().filter((m) => m.conversationId === 'c1')

  it('answers nothing: an empty reply, no notification, no unread badge', async () => {
    said = SILENT
    await run()
    const [request, answer] = messages()
    expect(request!.author.kind).toBe('routine') // the request is still in the conversation
    expect(answer!.text).toBe('') // and the reply has nothing in it
    expect(answer!.run).toMatchObject({ status: 'done', silent: true })
    expect(notes).toEqual([]) // nothing told
    expect(db.conversation('c1')?.unread).toBe(0) // and nothing counted
    // It did run, and the routine says so: the last run is that empty reply.
    expect(db.routine(request!.author.kind === 'routine' ? request!.author.id : '')?.lastMessageId).toBe(answer!.id)
  })

  it("teaches the marker in the routine's own request", async () => {
    said = SILENT
    await run()
    expect(asked).toContain('[SILENT]')
    expect(asked).toContain('não notifica e não marca a conversa como não lida')
  })

  it('one with something to say notifies, and counts once, at the answer', async () => {
    await run()
    const [, answer] = messages()
    expect(answer!.run?.silent).toBeUndefined()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.body).toContain('Resposta de teste')
    expect(db.conversation('c1')?.unread).toBe(1)
  })

  it('answers a question even when it ends with the marker: a question is not silence', async () => {
    askFirst = true
    said = `Te mandei uma pergunta.\n\n${SILENT}`
    await run()
    const [, answer] = messages()
    expect(answer!.run?.status).toBe('waiting_input')
    expect(answer!.run?.silent).toBeUndefined()
    expect(answer!.text).toBe('Te mandei uma pergunta.')
    expect(notes).toHaveLength(1)
  })

  it('outside a routine the marker is kept as the text it is', async () => {
    said = SILENT
    await runner.send('c1', 'Bom dia, alguém aí?', [])
    await settle()
    const answer = messages().at(-1)!
    expect(answer.author).toMatchObject({ kind: 'agent', id: 'a1' })
    expect(answer.text).toBe(SILENT)
    expect(answer.run?.silent).toBeUndefined()
    expect(db.conversation('c1')?.unread).toBe(1)
  })
})
