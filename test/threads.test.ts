import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Author, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { consolidationPrompt, MAX_AFTER, Memories, memorySystem } from '../src/core/memory'
import { routerSystem } from '../src/core/router'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra
})

let db: Db
let settings: Settings
let gateway: Gateway
let turns: Turn[]
let notes: { conversationId?: string; kind?: string; threadId?: string }[]
let memory: Memories

function runner(opts: { reply?: (t: Turn) => string; memory?: boolean } = {}): Runner {
  const base = fakeEngine('claude', { delayMs: 1, reply: opts.reply })
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
  const workDir = mkdtempSync(join(tmpdir(), 'ad-work-'))
  memory = new Memories({ db, engines, settings: async () => settings, emit: () => {}, workDir })
  return new Runner({
    db,
    engines,
    settings: async () => settings,
    emit: () => {},
    workDir,
    gateway,
    ...(opts.memory ? { memory } : {}),
    notify: (_t, _b, conversationId, kind, threadId) => void notes.push({ conversationId, kind, threadId })
  })
}

let clock = 1_000_000
function put(conversationId: string, author: Author, text: string, threadId?: string): Message {
  const m: Message = { id: `m${clock}`, conversationId, author, text, at: clock++, ...(threadId ? { threadId } : {}) }
  db.saveMessage(m)
  return m
}

const agentTurns = (): Turn[] => turns.filter((t) => t.system !== routerSystem() && t.system !== memorySystem())
const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'me')

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  notes = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia', { role: 'Engenharia' }))
  db.saveAgent(agent('a2', 'theo', { role: 'Dados' }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'lancamento', members: ['a1', 'a2'] })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('sending into a thread', () => {
  it('my message and the reply it sets off carry the thread; a reply to a reply goes in the same thread', async () => {
    const root = put('d1', { kind: 'me' }, 'Vamos lançar sexta?')
    const r = runner()
    await r.send('d1', 'e o texto do post?', [], root.id)
    await r.idle()
    expect(mine().at(-1)?.threadId).toBe(root.id)
    expect(replies().map((m) => m.threadId)).toEqual([root.id])
    expect(notes.at(-1)).toEqual({ conversationId: 'd1', kind: 'done', threadId: root.id })

    // Answering the agent's reply (itself in the thread) stays in the thread: one level only.
    await r.send('d1', 'manda outra versão', [], replies()[0]!.id)
    await r.idle()
    expect(mine().at(-1)?.threadId).toBe(root.id)
    expect(replies().every((m) => m.threadId === root.id)).toBe(true)
  })

  it('a message outside threads opens one, and the answer goes in it', async () => {
    const r = runner()
    await r.send('d1', 'quais as notícias de IA?')
    await r.idle()
    expect(mine().at(-1)?.threadId).toBeUndefined()
    expect(replies().map((m) => m.threadId)).toEqual([mine().at(-1)!.id])
  })

  it('a root from another conversation does not make a thread: the message opens its own', async () => {
    const elsewhere = put('c1', { kind: 'me' }, 'outro canal')
    const r = runner()
    await r.send('d1', 'oi', [], elsewhere.id)
    await r.idle()
    expect(mine().at(-1)?.threadId).toBeUndefined()
    expect(replies()[0]?.threadId).toBe(mine().at(-1)!.id)
  })
})

describe("what the agent sees", () => {
  it('in a thread: the summary, the recent conversation and the whole thread, however old', async () => {
    const root = put('c1', { kind: 'me' }, 'RAIZ: o plano de lançamento')
    put('c1', { kind: 'agent', id: 'a1' }, 'RESPOSTA ANTIGA na thread', root.id)
    db.setSummary('c1', 'RESUMO DO CANAL', root.at + 5) // the summary already covers the thread's start
    clock += 10
    put('c1', { kind: 'me' }, 'OUTRO ASSUNTO depois')
    const r = runner({ memory: true })
    await r.send('c1', '@lia e a data?', [], root.id)
    await r.idle()

    const prompt = agentTurns()[0]!.prompt
    expect(prompt).toContain('RESUMO DO CANAL')
    expect(prompt).toContain('Você está respondendo numa thread em #lancamento, aberta por Edu.')
    expect(prompt).toContain('RAIZ: o plano de lançamento')
    expect(prompt).toContain('RESPOSTA ANTIGA na thread')
    expect(prompt).toContain('OUTRO ASSUNTO depois')
    expect(prompt).toContain('@lia e a data?')
    expect(prompt.indexOf('RAIZ')).toBeLessThan(prompt.indexOf('RESPOSTA ANTIGA'))
  })

  it("a new message: the agent reads what was said in the earlier threads, so it doesn't start from zero", async () => {
    const root = put('d1', { kind: 'me' }, 'as 3 notícias de IA?')
    put('d1', { kind: 'agent', id: 'a1' }, 'NOTÍCIAS: IPO, buyouts, busca', root.id)
    for (const withMemory of [false, true]) {
      turns = []
      const r = runner({ memory: withMemory })
      await r.send('d1', 'e sobre a Apple?')
      await r.idle()
      const prompt = agentTurns()[0]!.prompt
      expect(prompt).toContain('NOTÍCIAS: IPO, buyouts, busca')
    }
  })
})

describe('who answers in a thread', () => {
  it('in a DM, the DM agent, with no mention', async () => {
    const root = put('d1', { kind: 'me' }, 'pergunta solta')
    const r = runner()
    await r.send('d1', 'e aí?', [], root.id)
    await r.idle()
    expect(replies().map((m) => [(m.author as { id: string }).id, m.threadId])).toEqual([['a1', root.id]])
  })

  it('in a channel, the router reads the conversation and the thread, and its note and the reply stay in it', async () => {
    put('c1', { kind: 'me' }, 'CANAL: bom dia pra todos')
    const root = put('c1', { kind: 'me' }, 'RAIZ: precisamos da métrica de retenção')
    const r = runner()
    await r.send('c1', 'qual a média da semana?', [], root.id)
    await r.idle()

    const routed = turns.find((t) => t.system === routerSystem())!.prompt
    expect(routed).toContain('Thread (a primeira mensagem abriu a thread')
    expect(routed).toContain('RAIZ: precisamos da métrica')
    expect(routed).toContain('qual a média da semana?')
    expect(replies().map((m) => [(m.author as { id: string }).id, m.threadId])).toEqual([['a2', root.id]])
    expect(db.messages().find((m) => m.author.kind === 'system')).toMatchObject({ threadId: root.id, text: expect.stringContaining('Chamei **Theo**') as string })
  })
})

describe('questions in threads', () => {
  it("a question waits in its thread: my next message there answers it; another thread or outside threads doesn't", async () => {
    const root = put('c1', { kind: 'me' }, 'RAIZ')
    const other = put('c1', { kind: 'me' }, 'OUTRA RAIZ')
    const r = runner()
    await r.send('c1', '@lia me pergunte o que faltar', [], root.id)
    await r.idle()
    const asked = replies()[0]!
    expect(asked).toMatchObject({ threadId: root.id, run: { status: 'waiting_input' } })
    expect(notes.at(-1)).toMatchObject({ kind: 'question', threadId: root.id })

    // A reply in another thread doesn't answer it.
    await r.send('c1', '@theo e aqui?', [], other.id)
    await r.idle()
    expect(db.message(asked.id)?.run?.status).toBe('waiting_input')

    // Nor does a new subject written outside threads: it stays outside, in a thread of its own.
    await r.send('c1', '@theo assunto novo: revisa o PR 50')
    await r.idle()
    const outside = mine().at(-1)!
    expect(outside.threadId).toBeUndefined()
    expect(db.message(asked.id)?.run?.status).toBe('waiting_input')
    expect(replies().at(-1)).toMatchObject({ threadId: outside.id, author: { id: 'a2' } })

    // My next message in its thread does, back to Lia.
    await r.send('c1', 'até sexta', [], root.id)
    await r.idle()
    expect(mine().at(-1)?.threadId).toBe(root.id)
    expect(db.message(asked.id)?.run?.status).toBe('done')
    expect(replies().at(-1)).toMatchObject({ threadId: root.id, author: { id: 'a1' } })
  })

  it('a question outside threads (from before them) is still answered outside', async () => {
    const r = runner()
    const asked = put('c1', { kind: 'agent', id: 'a1' }, 'Qual o prazo?')
    db.saveMessage({ ...asked, run: { status: 'waiting_input', depth: 1, steps: [] } })
    await r.send('c1', 'até sexta')
    await r.idle()
    expect(db.message(asked.id)?.run?.status).toBe('done')
    expect(replies().at(-1)).toMatchObject({ author: { id: 'a1' } })
  })
})

describe('what a thread message sets off stays in the thread', () => {
  it('chained mentions between agents, and the note that stops them', async () => {
    const root = put('c1', { kind: 'me' }, 'RAIZ')
    const r = runner({ reply: (t) => (t.system.startsWith('Você é Lia') ? '@theo, sua vez' : '@lia, sua vez') })
    await r.send('c1', '@lia começa', [], root.id)
    await r.idle()
    expect(replies().map((m) => [m.run?.depth, m.threadId])).toEqual([
      [1, root.id],
      [2, root.id],
      [3, root.id]
    ])
    expect(db.messages().at(-1)).toMatchObject({ author: { kind: 'system' }, threadId: root.id, text: expect.stringContaining('Parei a conversa entre agentes') as string })
  })

  it('the notes for an empty channel and for paused agents', async () => {
    db.createConversation({ id: 'c2', kind: 'channel', name: 'vazio', members: [] })
    const empty = put('c2', { kind: 'me' }, 'RAIZ')
    const r = runner()
    await r.send('c2', 'alguém?', [], empty.id)
    expect(db.messages().at(-1)).toMatchObject({ author: { kind: 'system' }, threadId: empty.id, text: expect.stringContaining('Ninguém está neste canal') as string })

    const root = put('d1', { kind: 'me' }, 'RAIZ')
    r.setPaused(true)
    await r.send('d1', 'oi', [], root.id)
    expect(db.messages().at(-1)).toMatchObject({ author: { kind: 'system' }, threadId: root.id, text: expect.stringContaining('pausados') as string })
  })

  it('trying again, continuing a paused reply and a handed-back browser', async () => {
    const root = put('d1', { kind: 'me' }, 'RAIZ')
    const run = (status: 'failed' | 'paused' | 'waiting_input'): Message['run'] => ({ status, depth: 1, steps: [] })
    const failed = put('d1', { kind: 'agent', id: 'a1' }, '', root.id)
    db.saveMessage({ ...failed, run: run('failed') })
    const paused = put('d1', { kind: 'agent', id: 'a1' }, 'metade', root.id)
    db.saveMessage({ ...paused, run: run('paused') })
    const r = runner()

    r.retry(failed.id)
    await r.idle()
    expect(db.message(failed.id)).toMatchObject({ threadId: root.id, run: { status: 'done' } })

    await r.continue(paused.id)
    await r.idle()
    expect(replies().at(-1)).toMatchObject({ threadId: root.id, run: { status: 'done' } })

    const asked = put('d1', { kind: 'agent', id: 'a1' }, 'entra pra mim?', root.id)
    db.saveMessage({ ...asked, run: run('waiting_input') })
    await r.handedBack('a1')
    await r.idle()
    expect(replies().at(-1)).toMatchObject({ threadId: root.id, run: { status: 'done' } })
    expect(replies()).toHaveLength(5) // retried in place, the paused one and its continuation, the question and the reply after it
  })
})

describe('the database', () => {
  it('an existing database gains thread_id, and messages round-trip it', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'old.db')
    // A database from before threads: the schema one migration back, with a message in it.
    new Db(file).close()
    const raw = new DatabaseSync(file)
    const { user_version } = raw.prepare('PRAGMA user_version').get() as { user_version: number }
    raw.exec(`DROP INDEX messages_by_thread; ALTER TABLE messages DROP COLUMN thread_id; PRAGMA user_version = ${user_version - 1};`)
    raw.exec("INSERT INTO conversations (id, kind, name, created_at) VALUES ('c1', 'channel', 'geral', 1)")
    raw.exec("INSERT INTO messages (id, conversation_id, author_kind, text, at) VALUES ('old', 'c1', 'me', 'antes das threads', 1)")
    raw.close()

    const reopened = new Db(file)
    expect(reopened.message('old')).toMatchObject({ text: 'antes das threads', threadId: undefined })
    reopened.saveMessage({ id: 'r1', conversationId: 'c1', author: { kind: 'me' }, text: 'na thread', at: 2, threadId: 'old' })
    expect(reopened.message('r1')?.threadId).toBe('old')
    expect(reopened.recentMessages('c1', 10, 'old').map((m) => m.id)).toEqual(['r1'])
    expect(reopened.recentMessages('c1', 10, null).map((m) => m.id)).toEqual(['old'])
    expect(reopened.recentMessages('c1', 10).map((m) => m.id)).toEqual(['old', 'r1'])
    reopened.close()
  })
})

describe('memory keeps what was said in threads', () => {
  it('consolidation folds thread replies into the summary, marked', async () => {
    const root = put('c1', { kind: 'me' }, 'RAIZ da thread')
    put('c1', { kind: 'me' }, 'ZEBRA é o cupom', root.id)
    for (let i = 1; i < MAX_AFTER + 10; i++) put('c1', i % 2 ? { kind: 'agent', id: 'a1' } : { kind: 'me' }, `mensagem ${i}`)
    runner({ memory: true })
    await memory.consolidate('c1')
    expect(db.conversation('c1')!.summary).toContain('ZEBRA')
    const prompt = turns.find((t) => t.system === memorySystem())!.prompt
    expect(prompt).toContain('[Edu · numa thread] ZEBRA é o cupom')
    expect(consolidationPrompt({ messages: [{ ...root, threadId: undefined }], me: 'Edu', agents: [], memories: [], forgotten: [] })).toContain('[Edu] RAIZ')
  })
})
