import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Author, EngineId, Message, Settings } from '../src/shared/types'
import { Db, MIGRATIONS } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { consolidationPrompt, MAX_AFTER, Memories, memorySystem } from '../src/core/memory'
import { handoffSystem, routerSystem } from '../src/core/router'
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

function runner(opts: { reply?: (t: Turn) => string; memory?: boolean; onTurn?: (t: Turn) => Promise<unknown> } = {}): Runner {
  const base = fakeEngine('claude', { delayMs: 1, reply: opts.reply })
  const claude: Engine = {
    id: 'claude',
    async *run(t) {
      turns.push(t)
      await opts.onTurn?.(t)
      yield* base.run(t)
    }
  }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
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

const agentTurns = (): Turn[] => turns.filter((t) => t.system !== routerSystem() && t.system !== handoffSystem() && t.system !== memorySystem())
const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'person')

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  notes = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia', { role: 'Engenharia' }))
  db.saveAgent(agent('a2', 'theo', { role: 'Dados' }))
  // Both answer in threads; a conversation that answers in it is made where it's tested.
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'], threads: true })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'lancamento', members: ['a1', 'a2'], threads: true })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('sending into a thread', () => {
  it('my message and the reply it sets off carry the thread; a reply to a reply goes in the same thread', async () => {
    const root = put('d1', { kind: 'person', id: db.ownerId() }, 'Vamos lançar sexta?')
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
    const elsewhere = put('c1', { kind: 'person', id: db.ownerId() }, 'outro canal')
    const r = runner()
    await r.send('d1', 'oi', [], elsewhere.id)
    await r.idle()
    expect(mine().at(-1)?.threadId).toBeUndefined()
    expect(replies()[0]?.threadId).toBe(mine().at(-1)!.id)
  })
})

describe('a conversation that answers in it', () => {
  beforeEach(() => {
    db.createConversation({ id: 'p1', kind: 'channel', name: 'papo', members: ['a1', 'a2'] }) // threads off, the default
  })

  it("my message, the router's note and the answers stay in the conversation, like a chat", async () => {
    const r = runner()
    await r.send('p1', 'qual a média de retenção da semana?')
    await r.idle()
    const here = db.messages().filter((m) => m.conversationId === 'p1')
    expect(here.map((m) => m.author.kind)).toEqual(['person', 'system', 'agent'])
    expect(here.every((m) => m.threadId === undefined)).toBe(true)
    expect(notes.at(-1)).toEqual({ conversationId: 'p1', kind: 'done', threadId: undefined })
  })

  it('a thread opened by hand still takes its answers; switched to threads, every message opens one', async () => {
    const root = put('p1', { kind: 'person', id: db.ownerId() }, 'um assunto à parte')
    const r = runner()
    await r.send('p1', '@lia e esse?', [], root.id)
    await r.idle()
    expect(mine().at(-1)?.threadId).toBe(root.id)
    expect(replies().at(-1)?.threadId).toBe(root.id)

    db.setThreads('p1', true)
    await r.send('p1', '@lia e agora?')
    await r.idle()
    expect(mine().at(-1)?.threadId).toBeUndefined()
    expect(replies().at(-1)?.threadId).toBe(mine().at(-1)!.id)
  })

  it('an answer there reads the conversation and the message that opened each thread, not what was said inside: that is looked up', async () => {
    put('p1', { kind: 'person', id: db.ownerId() }, 'CANAL: bom dia')
    const root = put('p1', { kind: 'person', id: db.ownerId() }, 'RAIZ: o plano do post')
    put('p1', { kind: 'agent', id: 'a2' }, 'DENTRO DA THREAD: o plano inteiro', root.id)
    const found: string[] = []
    const r = runner({
      onTurn: async (t) => {
        if (t.mcpUrl) found.push(JSON.stringify(await callTool(t.mcpUrl, 'buscar_threads', { busca: 'plano' })))
      }
    })
    await r.send('p1', '@lia e o plano?')
    await r.idle()

    const prompt = agentTurns()[0]!.prompt
    expect(prompt).toContain('CANAL: bom dia')
    expect(prompt).toContain('RAIZ: o plano do post')
    expect(prompt).not.toContain('DENTRO DA THREAD')
    expect(prompt).toContain('As threads ficam à parte')
    expect(found[0]).toContain('DENTRO DA THREAD: o plano inteiro')
    expect(replies().at(-1)?.threadId).toBeUndefined()
  })

  it('with no thread in it, an answer there is given no thread tools nor the note about them', async () => {
    put('p1', { kind: 'person', id: db.ownerId() }, 'CANAL: bom dia')
    const r = runner()
    await r.send('p1', '@lia tudo certo?')
    await r.idle()
    expect(agentTurns()[0]!.prompt).toContain('CANAL: bom dia')
    expect(agentTurns()[0]!.prompt).not.toContain('buscar_threads')
  })
})

describe("what the agent sees", () => {
  it("in a thread: only that thread, however old; not the channel's summary nor the other threads", async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ: o plano de lançamento')
    put('c1', { kind: 'agent', id: 'a1' }, 'RESPOSTA ANTIGA na thread', root.id)
    db.setSummary('c1', 'RESUMO DO CANAL', root.at + 5)
    clock += 10
    put('c1', { kind: 'person', id: db.ownerId() }, 'OUTRO ASSUNTO depois')
    const r = runner({ memory: true })
    await r.send('c1', '@lia e a data?', [], root.id)
    await r.idle()

    const prompt = agentTurns()[0]!.prompt
    expect(prompt).toContain('Você está respondendo numa thread em #lancamento, aberta por Edu.')
    expect(prompt).toContain('Ela é uma conversa à parte')
    expect(prompt).toContain('RAIZ: o plano de lançamento')
    expect(prompt).toContain('RESPOSTA ANTIGA na thread')
    expect(prompt).toContain('@lia e a data?')
    expect(prompt.indexOf('RAIZ')).toBeLessThan(prompt.indexOf('RESPOSTA ANTIGA'))
    expect(prompt).not.toContain('RESUMO DO CANAL')
    expect(prompt).not.toContain('OUTRO ASSUNTO')
  })

  it('two threads at once: a reply that goes on in its thread never sees the other, newer one', async () => {
    // The PR review goes on (after an approval, a pause) once I've asked something else meanwhile.
    const pr = put('c1', { kind: 'person', id: db.ownerId() }, 'THREAD A: revisa o ENG-105')
    const paused = put('c1', { kind: 'agent', id: 'a1' }, 'metade da revisão', pr.id)
    const other = put('c1', { kind: 'person', id: db.ownerId() }, 'THREAD B: implementa o ENG-200')
    put('c1', { kind: 'agent', id: 'a2' }, 'RESPOSTA DA B', other.id)
    for (const withMemory of [false, true]) {
      turns = []
      db.saveMessage({ ...paused, run: { status: 'paused', depth: 1, steps: [] } })
      const r = runner({ memory: withMemory })
      await r.continue(paused.id)
      await r.idle()

      const prompt = agentTurns()[0]!.prompt
      expect(prompt).toContain('THREAD A: revisa o ENG-105')
      expect(prompt).toContain('metade da revisão')
      expect(prompt).not.toContain('THREAD B')
      expect(prompt).not.toContain('RESPOSTA DA B')
      expect(replies().at(-1)).toMatchObject({ threadId: pr.id, run: { work: 'ENG-105' } })
    }
  })

  it("a new message is a conversation of its own: the earlier threads aren't given, they're looked up", async () => {
    const root = put('d1', { kind: 'person', id: db.ownerId() }, 'as 3 notícias de IA?')
    put('d1', { kind: 'agent', id: 'a1' }, 'NOTÍCIAS: IPO, buyouts, busca', root.id)
    for (const withMemory of [false, true]) {
      turns = []
      const r = runner({ memory: withMemory })
      await r.send('d1', 'e sobre a Apple?')
      await r.idle()
      const prompt = agentTurns()[0]!.prompt
      expect(prompt).not.toContain('NOTÍCIAS')
      expect(prompt).toContain('procure com buscar_threads')
    }
  })

  it("buscar_threads finds threads of the conversations the agent is in and ler_thread reads them; not where it isn't, nor its own", async () => {
    const other = put('c1', { kind: 'person', id: db.ownerId() }, 'THREAD B: o plano do post')
    put('c1', { kind: 'agent', id: 'a2' }, 'RESPOSTA COMPLETA DA B, com o plano inteiro', other.id)
    put('d1', { kind: 'person', id: db.ownerId() }, 'DM: o plano da viagem')
    db.createConversation({ id: 'c2', kind: 'channel', name: 'dados', members: ['a2'] }) // Lia isn't in it
    const theirs = put('c2', { kind: 'person', id: db.ownerId() }, 'PLANO de outro canal')
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'THREAD A: o plano?')
    const results: string[] = []
    const r = runner({
      onTurn: async (t) => {
        if (!t.mcpUrl) return
        results.push(JSON.stringify(await callTool(t.mcpUrl, 'buscar_threads', { busca: 'plano' })))
        for (const id of [other.id, theirs.id, root.id]) results.push(JSON.stringify(await callTool(t.mcpUrl, 'ler_thread', { id })))
      }
    })
    await r.send('c1', '@lia e o plano?', [], root.id)
    await r.idle()

    const [found, read, elsewhere, own] = results
    expect(found).toContain(`[${other.id}] #lancamento`)
    expect(found).toContain('RESPOSTA COMPLETA DA B')
    expect(found).toContain('DM: o plano da viagem') // her DM is one of her conversations
    expect(found).not.toContain('PLANO de outro canal')
    expect(found).not.toContain(`[${root.id}]`)
    expect(read).toContain('Thread em #lancamento')
    expect(read).toContain('RESPOSTA COMPLETA DA B, com o plano inteiro')
    expect(elsewhere).toContain('Não achei essa thread')
    expect(elsewhere).not.toContain('PLANO de outro canal')
    expect(own).toContain('Não achei essa thread')
    expect(replies().at(-1)?.run?.steps.map((s) => s.label)).toEqual(expect.arrayContaining(['Buscou nas threads', 'Leu uma thread']))
  })
})

describe('who answers in a thread', () => {
  it('in a DM, the DM agent, with no mention', async () => {
    const root = put('d1', { kind: 'person', id: db.ownerId() }, 'pergunta solta')
    const r = runner()
    await r.send('d1', 'e aí?', [], root.id)
    await r.idle()
    expect(replies().map((m) => [(m.author as { id: string }).id, m.threadId])).toEqual([['a1', root.id]])
  })

  it('in a channel, the router reads the conversation and the thread, and its note and the reply stay in it', async () => {
    put('c1', { kind: 'person', id: db.ownerId() }, 'CANAL: bom dia pra todos')
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ: precisamos da métrica de retenção')
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

  it('the router reads the thread, and the other threads a line each with who answered them', async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ: precisamos da métrica de retenção')
    const other = put('c1', { kind: 'person', id: db.ownerId() }, 'OUTRA THREAD: e o post?')
    put('c1', { kind: 'agent', id: 'a1' }, 'RESPOSTA NA OUTRA', other.id)
    const r = runner()
    await r.send('c1', 'qual a média da semana?', [], root.id)
    await r.idle()

    const routed = turns.find((t) => t.system === routerSystem())!.prompt
    const thread = routed.slice(routed.indexOf('Thread (a primeira mensagem'))
    expect(routed).toContain('- [Edu] OUTRA THREAD: e o post? → Lia · por último [Lia] RESPOSTA NA OUTRA')
    expect(routed.indexOf('Antes, no canal')).toBeLessThan(routed.indexOf('Thread (a primeira mensagem'))
    expect(thread).not.toContain('OUTRA')
    expect(thread.split('\n').slice(1, 3)).toEqual(['[Edu] RAIZ: precisamos da métrica de retenção', '[Edu] qual a média da semana?'])
  })
})

// A routine's agent posts a long report in the channel that ends "posso disparar agora?", and
// the person answers by writing in the channel: their message opens a thread of its own. The
// router saw only the opening of the other messages and called someone else, who couldn't see
// the question either ("não achei nada pra disparar aqui").
describe('an answer written in the channel to a question at the end of an agent’s message', () => {
  const report = `Relatório da rotina de pré-render. ${'O build travou no passo do prerender e o lint não confirmou. '.repeat(30)}Posso disparar agora?`
  const said = (id: string, author: Author, text: string, at: number): Message => {
    const m: Message = { id, conversationId: 'c1', author, text, at }
    db.saveMessage(m)
    return m
  }

  it('goes to the agent that asked, which reads its question above the thread the answer opened', async () => {
    said('q0', { kind: 'agent', id: 'a1' }, 'Deploy da landing feito.', Date.now() - 120_000)
    said('q1', { kind: 'agent', id: 'a2' }, report, Date.now() - 60_000)
    const r = runner()
    await r.send('c1', 'pode disparar agora')
    await r.idle()

    const routed = turns.find((t) => t.system === routerSystem())!.prompt
    expect(routed).toContain('Posso disparar agora?')
    const answer = mine().at(-1)!
    expect(replies().filter((m) => !['q0', 'q1'].includes(m.id)).map((m) => [(m.author as { id: string }).id, m.threadId])).toEqual([['a2', answer.id]])
    const prompt = agentTurns().at(-1)!.prompt
    expect(prompt).toContain('Antes desta thread, as últimas mensagens de #lancamento fora de threads')
    expect(prompt).toContain('Deploy da landing feito.')
    expect(prompt.indexOf('Posso disparar agora?')).toBeLessThan(prompt.indexOf('pode disparar agora'))
  })

  it('reads the same blocks on its next reply in that thread, so a kept session goes on', async () => {
    said('q1', { kind: 'agent', id: 'a2' }, report, Date.now() - 60_000)
    const r = runner()
    await r.send('c1', '@theo pode disparar agora')
    await r.idle()
    const thread = mine().at(-1)!.id
    await r.send('c1', '@theo e aí, rodou?', [], thread)
    await r.idle()
    const [first, second] = agentTurns()
    const above = first!.blocks!.filter((b) => b.includes('Posso disparar agora?') || b.startsWith('Antes desta thread'))
    expect(above).toHaveLength(2)
    expect(second!.blocks).toEqual(expect.arrayContaining(above))
  })

  it('reads nothing from before a thread opened on another message, or from more than 12 hours before', async () => {
    const old = said('q1', { kind: 'agent', id: 'a2' }, `ANTIGA ${report}`, Date.now() - 13 * 60 * 60 * 1000)
    const r = runner()
    await r.send('c1', '@theo pode disparar agora')
    await r.idle()
    await r.send('c1', '@theo e essa?', [], old.id)
    await r.idle()
    const [fresh, onIt] = agentTurns()
    expect(fresh!.prompt).not.toContain('Antes desta thread')
    expect(fresh!.prompt).not.toContain('ANTIGA')
    expect(onIt!.prompt).not.toContain('Antes desta thread')
    expect(onIt!.prompt).toContain('ANTIGA') // it's the message that opened the thread
  })
})

describe('questions in threads', () => {
  it("a question waits in its thread: my next message there answers it; another thread or outside threads doesn't", async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ')
    const other = put('c1', { kind: 'person', id: db.ownerId() }, 'OUTRA RAIZ')
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
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ')
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
    const empty = put('c2', { kind: 'person', id: db.ownerId() }, 'RAIZ')
    const r = runner()
    await r.send('c2', 'alguém?', [], empty.id)
    expect(db.messages().at(-1)).toMatchObject({ author: { kind: 'system' }, threadId: empty.id, text: expect.stringContaining('Ninguém está neste canal') as string })

    const root = put('d1', { kind: 'person', id: db.ownerId() }, 'RAIZ')
    r.setPaused(true)
    await r.send('d1', 'oi', [], root.id)
    expect(db.messages().at(-1)).toMatchObject({ author: { kind: 'system' }, threadId: root.id, text: expect.stringContaining('pausados') as string })
  })

  it('trying again, continuing a paused reply and a handed-back browser', async () => {
    const root = put('d1', { kind: 'person', id: db.ownerId() }, 'RAIZ')
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
  it('an existing database gains thread_id, thread_summary and threads, and round-trips them', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'old.db')
    // A database from before threads: the schema six migrations back (unread, people and the indexes came after), with a message in it.
    const raw = new DatabaseSync(file)
    for (const m of MIGRATIONS.slice(0, MIGRATIONS.length - 6)) raw.exec(m)
    raw.exec(`PRAGMA user_version = ${MIGRATIONS.length - 6};`)
    raw.exec("INSERT INTO conversations (id, kind, name, created_at) VALUES ('c1', 'channel', 'geral', 1)")
    raw.exec("INSERT INTO messages (id, conversation_id, author_kind, text, at) VALUES ('old', 'c1', 'me', 'antes das threads', 1)")
    raw.close()

    const reopened = new Db(file)
    expect(reopened.message('old')).toMatchObject({ text: 'antes das threads', threadId: undefined })
    reopened.saveMessage({ id: 'r1', conversationId: 'c1', author: { kind: 'person', id: reopened.ownerId() }, text: 'na thread', at: 2, threadId: 'old' })
    expect(reopened.message('r1')?.threadId).toBe('old')
    expect(reopened.recentMessages('c1', 10, 'old').map((m) => m.id)).toEqual(['r1'])
    expect(reopened.recentMessages('c1', 10, null).map((m) => m.id)).toEqual(['old'])
    expect(reopened.recentMessages('c1', 10).map((m) => m.id)).toEqual(['old', 'r1'])
    reopened.setThreadSummary('old', 'o que a thread cobriu', 2)
    reopened.saveMessage({ ...reopened.message('old')!, text: 'antes das threads (editada)' }) // saving a message keeps its summary
    reopened.setThreadSummary('old', 'editado à mão') // a hand edit keeps what it covers
    expect(reopened.message('old')?.threadSummary).toMatchObject({ text: 'editado à mão', until: 2 })
    // A conversation answers in it until it's switched to threads, and back.
    expect(reopened.conversation('c1')?.threads).toBeUndefined()
    reopened.setThreads('c1', true)
    expect(reopened.conversation('c1')?.threads).toBe(true)
    reopened.setThreads('c1', false)
    expect(reopened.conversation('c1')?.threads).toBeUndefined()
    reopened.close()
  })
})

describe('memory keeps what was said in threads', () => {
  it('consolidation folds thread replies into the summary, marked', async () => {
    const root = put('c1', { kind: 'person', id: db.ownerId() }, 'RAIZ da thread')
    put('c1', { kind: 'person', id: db.ownerId() }, 'ZEBRA é o cupom', root.id)
    for (let i = 1; i < MAX_AFTER + 10; i++) put('c1', i % 2 ? { kind: 'agent', id: 'a1' } : { kind: 'person', id: db.ownerId() }, `mensagem ${i}`)
    runner({ memory: true })
    await memory.consolidate('c1')
    expect(db.conversation('c1')!.summary).toContain('ZEBRA')
    const prompt = turns.find((t) => t.system === memorySystem())!.prompt
    expect(prompt).toContain('[Edu · numa thread] ZEBRA é o cupom')
    expect(consolidationPrompt({ messages: [{ ...root, threadId: undefined }], me: 'Edu', agents: [], memories: [], forgotten: [] })).toContain('[Edu] RAIZ')
  })
})
