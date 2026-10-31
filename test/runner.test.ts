import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

// Wraps an engine to count how many turns were actually started.
function counted(engine: Engine): Engine & { turns: Turn[] } {
  const turns: Turn[] = []
  return { id: engine.id, turns, run: (t) => (turns.push(t), engine.run(t)) }
}

let db: Db
let events: CoreEvent[]
let claude: ReturnType<typeof counted>
let settings: Settings

function runner(engine: Engine = fakeEngine('claude', { delayMs: 1 }), dataDir?: string): Runner {
  claude = counted(engine)
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), dataDir })
}

const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia'))
  db.saveAgent(agent('a2', 'theo', { modelId: 'gpt-5.6-luna' }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
})

describe('Runner', () => {
  it('keeps only the selected excerpt in a reply and passes it to the responding agent', async () => {
    db.saveMessage({ id: 'quoted', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'An introduction.\n\n**Deploy** after review.\n\nA separate conclusion.', at: 100 })
    const r = runner()
    await r.send('c1', 'Explain this part.', [], { reply: { messageId: 'quoted', quote: 'Deploy after review.' } })
    await r.idle()
    const saved = db.messages().find((m) => m.reply)!
    expect(saved.reply).toMatchObject({ messageId: 'quoted', author: 'lia', text: 'Deploy after review.', excerpt: true })
    expect(saved.text).toBe('Explain this part.')
    expect(claude.turns[0]?.prompt).toContain('> Deploy after review.')
    expect(claude.turns).toHaveLength(1)
  })

  it('rejects empty or excessive excerpts and excerpts without an original message', async () => {
    db.saveMessage({ id: 'quoted', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'Original text.', at: 100 })
    const r = runner()
    for (const quote of ['', '   ', 'a'.repeat(32_001)]) {
      await expect(r.send('c1', 'A reply.', [], { reply: { messageId: 'quoted', quote } })).rejects.toThrow()
    }
    await expect(r.send('c1', 'A reply.', [], { reply: { messageId: '', quote: 'Text.' } })).rejects.toThrow()
    expect(db.messages().filter((m) => m.author.kind === 'me')).toEqual([])
  })

  it('quotes an older message and directs the reply to its author in the same channel', async () => {
    const source: Message = { id: 'quoted', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'The deployment needs a review.', at: 100, run: { status: 'done', steps: [] } }
    db.saveMessage(source)
    for (let i = 0; i < 50; i++) db.saveMessage({ id: `filler-${i}`, conversationId: 'c1', author: { kind: 'me' }, text: 'Later context.', at: 101 + i })
    const r = runner()
    await r.send('c1', 'Review it now.', [], { reply: { messageId: source.id } })
    await r.idle()
    const reply = db.messages().find((m) => m.reply)!
    expect(reply.reply).toEqual({ messageId: source.id, author: 'lia', agentId: 'a1', text: source.text, at: 100 })
    expect(claude.turns).toHaveLength(1)
    expect(claude.turns[0]?.prompt).toContain('[Em resposta a lia:]')
    expect(claude.turns[0]?.prompt).toContain(`> ${source.text}`)
    expect(db.message(source.id)).toMatchObject(source)
  })

  it('rejects replies to missing messages, other conversations, system messages or active runs', async () => {
    const r = runner()
    const source: Message = { id: 'quoted', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'Still thinking.', at: 100, run: { status: 'working', steps: [] } }
    db.saveMessage(source)
    await expect(r.send('d1', 'A reply.', [], { reply: { messageId: source.id } })).rejects.toThrow()
    await expect(r.send('c1', 'A reply.', [], { reply: { messageId: 'missing' } })).rejects.toThrow()
    await expect(r.send('c1', 'A reply.', [], { reply: { messageId: source.id } })).rejects.toThrow()
    db.saveMessage({ id: 'system', conversationId: 'c1', author: { kind: 'system' }, text: 'System notice.', at: 100 })
    await expect(r.send('c1', 'A reply.', [], { reply: { messageId: 'system' } })).rejects.toThrow()
    expect(db.messages().filter((m) => m.author.kind === 'me')).toEqual([])
  })

  it('keeps another agent’s pending question open when replying to a particular agent', async () => {
    db.saveMessage({ id: 'quoted', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'Ready.', at: 100 })
    db.saveMessage({ id: 'question', conversationId: 'c1', author: { kind: 'agent', id: 'a2' }, text: 'Which environment?', at: 101, run: { status: 'waiting_input', steps: [], question: 'Which environment?' } })
    const r = runner()
    r.setPaused(true)
    await r.send('c1', 'A reply for Lia.', [], { reply: { messageId: 'quoted' } })
    expect(db.message('question')?.run?.status).toBe('waiting_input')
  })

  it('forwards a channel message with its origin, without copying the agent run', async () => {
    const source: Message = { id: 'original', conversationId: 'c1', author: { kind: 'agent', id: 'a2' }, text: '**The deployment is ready.**', at: 123, run: { status: 'done', steps: [] } }
    db.saveMessage(source)
    db.createConversation({ id: 'c2', kind: 'channel', name: 'launch', members: ['a1'] })
    const r = runner()
    await r.forward(source.id, 'c2')
    await r.idle()

    const forwarded = db.messages().find((m) => m.conversationId === 'c2' && m.author.kind === 'me')!
    expect(forwarded).toMatchObject({ text: source.text, forwarded: { messageId: 'original', conversationId: 'c1', conversationName: 'engenharia', conversationKind: 'channel', author: 'theo', agentId: 'a2', at: 123 } })
    expect(forwarded.id).not.toBe(source.id)
    expect(forwarded.run).toBeUndefined()
    expect(db.message(source.id)).toMatchObject(source)
    expect(claude.turns[0]?.prompt).toContain('[Encaminhada de theo em #engenharia]')
    expect(claude.turns[0]?.prompt).toContain(source.text)

    // Forwarding again keeps the original attribution even after a rename.
    db.createConversation({ id: 'c3', kind: 'channel', name: 'release', members: [] })
    db.saveAgent(agent('a2', 'new-name'))
    await r.forward(forwarded.id, 'c3')
    expect(db.messages().find((m) => m.conversationId === 'c3' && m.author.kind === 'me')?.forwarded).toEqual(forwarded.forwarded)
  })

  it('rejects forwarding to the same conversation, missing conversations and unfinished or empty messages', async () => {
    const source: Message = { id: 'original', conversationId: 'c1', author: { kind: 'me' }, text: 'hello', at: 123 }
    db.saveMessage(source)
    const r = runner()
    for (const destination of ['c1', 'missing']) await expect(r.forward(source.id, destination)).rejects.toThrow()
    await expect(r.forward('missing', 'c1')).rejects.toThrow()
    db.createConversation({ id: 'c2', kind: 'channel', name: 'launch', members: [] })
    db.saveMessage({ ...source, text: '' })
    await expect(r.forward(source.id, 'c2')).rejects.toThrow()
    db.saveMessage({ ...source, run: { status: 'working', steps: [] } })
    await expect(r.forward(source.id, 'c2')).rejects.toThrow()
    expect(db.messages().filter((m) => m.conversationId === 'c2')).toEqual([])
  })

  it('forwards to an agent DM and forwards DM messages to channels or another DM', async () => {
    db.saveMessage({ id: 'original', conversationId: 'c1', author: { kind: 'me' }, text: 'Review this deployment.', at: 123 })
    const r = runner()
    await r.forward('original', 'd1')
    await r.idle()
    expect(db.messages().some((m) => m.conversationId === 'd1' && m.author.kind === 'agent')).toBe(true)
    const reply = db.messages().find((m) => m.conversationId === 'd1' && m.author.kind === 'agent')!
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a2', members: ['a2'] })
    await r.forward(reply.id, 'd2')
    await r.forward(reply.id, 'c1')
    await r.idle()
    for (const id of ['d2', 'c1']) {
      expect(db.messages().find((m) => m.conversationId === id && m.forwarded?.messageId === reply.id)?.forwarded).toMatchObject({ conversationName: 'lia', conversationKind: 'dm', author: 'lia', agentId: 'a1' })
    }
    await expect(r.forward(reply.id, 'd1')).rejects.toThrow()
    db.saveAgent({ ...db.agent('a2')!, archived: true })
    await expect(r.forward(reply.id, 'd2')).rejects.toThrow()
  })

  it('does not consume a pending question when forwarding a message', async () => {
    db.saveMessage({ id: 'original', conversationId: 'c1', author: { kind: 'me' }, text: 'A quote, not an answer.', at: 123 })
    db.saveMessage({ id: 'question', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'Which environment?', at: 124, run: { status: 'waiting_input', steps: [], question: 'Which environment?' } })
    const r = runner()
    r.setPaused(true)
    await r.forward('original', 'd1')
    expect(db.message('question')?.run?.status).toBe('waiting_input')
  })

  it('copies forwarded image attachments so deleting the source does not lose them', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ad-data-'))
    const r = runner(undefined, data)
    r.setPaused(true)
    await r.send('c1', '', [{ name: 'test.png', mime: 'image/png', data: Buffer.from('image-content').toString('base64') }])
    const source = db.messages().find((m) => m.author.kind === 'me')!
    db.createConversation({ id: 'c2', kind: 'channel', name: 'launch', members: [] })
    await r.forward(source.id, 'c2')
    const copy = db.artifacts().find((a) => a.conversationId === 'c2')!
    expect(copy.id).not.toBe(db.artifacts().find((a) => a.conversationId === 'c1')?.id)
    expect(copy).toMatchObject({ name: 'test.png', agentId: '', kind: 'image' })
    db.deleteConversation('c1')
    expect(readFileSync(join(data, 'artifacts', copy.id, copy.name), 'utf8')).toBe('image-content')
    expect(db.message(copy.messageId)?.forwarded?.conversationName).toBe('engenharia')
  })

  it('answers in a DM, streams deltas and records a receipt that matches the agent usage', async () => {
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()

    const [reply] = agentMessages()
    expect(reply?.run?.status).toBe('done')
    expect(reply?.text).toContain('Resposta de teste (claude · sonnet)')
    expect(events.some((e) => e.type === 'delta')).toBe(true)

    const receipt = reply!.run!.receipt!
    const tokens = receipt.inputTokens + receipt.outputTokens
    expect(db.receiptTotals(reply!.id).tokens).toBe(tokens)
    expect(db.agent('a1')!.used).toBe(tokens)
    expect(events.at(-1)).toMatchObject({ type: 'agent', agent: { id: 'a1', used: tokens } })
  })

  it('keeps the images I attach and shows them to the agent with my message', async () => {
    const data = mkdtempSync(join(tmpdir(), 'ad-data-'))
    const r = runner(undefined, data)
    const png = Buffer.from('fake-png').toString('base64')
    await r.send('d1', '', [{ name: 'Tela do checkout.png', mime: 'image/png', data: png }, { name: 'virus.exe', mime: 'application/x-msdownload', data: png }])
    await r.idle()

    const [kept] = db.artifacts()
    expect(db.artifacts()).toHaveLength(1)
    expect(kept).toMatchObject({ agentId: '', kind: 'image', name: 'Tela do checkout.png', messageId: db.messages()[0]!.id })
    expect(readFileSync(join(data, 'artifacts', kept!.id, kept!.name), 'utf8')).toBe('fake-png')
    const turn = claude.turns[0]!
    expect(turn.prompt).toContain('[imagem anexada: Tela do checkout.png]')
    expect(turn.images).toEqual([{ block: turn.blocks!.findIndex((b) => b.includes('imagem anexada')), path: join(data, 'artifacts', kept!.id, kept!.name), mime: 'image/png' }])
  })

  it('sends the workspace context, instructions and transcript to the engine', async () => {
    settings.context = 'Trabalho com evals.'
    const r = runner()
    await r.send('d1', 'qual o plano?')
    await r.idle()
    const turn = claude.turns[0]!
    expect(turn.system).toContain('Trabalho com evals.')
    expect(turn.prompt).toContain('qual o plano?')
    expect(turn.model).toBe('sonnet')
    expect(turn.effort).toBe('low')
  })

  it('in a channel, only mentioned agents answer, each on its own engine', async () => {
    const r = runner()
    await r.send('c1', '@theo e @lia, bom dia')
    await r.idle()
    const replies = agentMessages()
    expect(replies.map((m) => (m.author as { id: string }).id).sort()).toEqual(['a1', 'a2'])
    expect(replies.find((m) => (m.author as { id: string }).id === 'a2')?.text).toContain('codex · gpt-5.6-luna')
  })

  it('in a channel without a mention, the router picks who answers and leaves a receipt', async () => {
    db.saveAgent(agent('a1', 'lia', { role: 'Engenharia' }))
    db.saveAgent(agent('a2', 'theo', { role: 'Dados', modelId: 'gpt-5.6-luna' }))
    const r = runner()
    await r.send('c1', 'qual foi a receita da semana?')
    await r.idle()
    const replies = agentMessages()
    expect(replies.map((m) => (m.author as { id: string }).id)).toEqual(['a2'])
    const note = db.messages().find((m) => m.author.kind === 'system')!
    expect(note.text).toContain('Chamei **theo**')
    expect(note.run).toBeUndefined()
    expect(db.receiptTotals(note.id).tokens).toBeGreaterThan(0)
    expect(db.usedThisMonth('a1')).toBe(0) // the router's tokens are not charged to agents
  })

  it('the router can decide that nobody answers', async () => {
    const r = runner()
    await r.send('c1', 'bom dia')
    await r.idle()
    expect(agentMessages()).toHaveLength(0)
    expect(db.messages().at(-1)?.text).toContain('Ninguém precisa responder')
  })

  it('says so when a channel has nobody in it, instead of ignoring the message', async () => {
    db.createConversation({ id: 'c2', kind: 'channel', name: 'vazio', members: [] })
    const r = runner()
    await r.send('c2', 'alguém?')
    await r.idle()
    expect(db.messages().at(-1)).toMatchObject({ author: { kind: 'system' }, text: expect.stringContaining('Ninguém está neste canal') as string })
  })

  it('reports a router failure and asks for a mention', async () => {
    settings.routerModel = 'gpt-5.6-luna'
    settings.engines.codex = { installed: true, loggedIn: false }
    const r = runner()
    await r.send('c1', 'alguém?')
    await r.idle()
    expect(agentMessages()).toHaveLength(0)
    expect(db.messages().at(-1)?.text).toContain('Mencione um agente')
  })

  it('an agent mentioning another hands it the turn, and the chain stops at depth 3', async () => {
    // Every reply mentions the other agent: a ping-pong that must stop.
    const pingPong = fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? '@theo, sua vez' : '@lia, sua vez') })
    const r = runner(pingPong)
    settings.engines.codex = ready
    db.saveAgent(agent('a2', 'theo')) // same engine as lia, so both use the ping-pong fake
    await r.send('c1', '@lia começa')
    await r.idle()
    const replies = agentMessages()
    expect(replies.map((m) => [(m.author as { id: string }).id, m.run?.depth])).toEqual([
      ['a1', 1],
      ['a2', 2],
      ['a1', 3]
    ])
    expect(db.messages().at(-1)?.text).toContain('Parei a conversa entre agentes')
  })

  it('does not hand the turn for a handle quoted inside a code block', async () => {
    // The reply shows a prompt in a fenced block that mentions the other agent (the case that made an agent answer twice).
    const quoted = fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? 'O prompt é este:\n```\n@theo, pode ajudar aqui?\n```' : 'ok') })
    const r = runner(quoted)
    await r.send('c1', '@lia começa')
    await r.idle()
    expect(agentMessages().map((m) => (m.author as { id: string }).id)).toEqual(['a1'])
  })

  it('retries a failed reply in place', async () => {
    let fail = true
    const flaky: Engine = {
      id: 'claude',
      run: (t) => (fail ? (async function* () { yield { type: 'error' as const, message: 'caiu' } })() : fakeEngine('claude', { delayMs: 1 }).run(t))
    }
    const r = runner(flaky)
    await r.send('d1', 'oi')
    await r.idle()
    const failed = agentMessages()[0]!
    expect(failed.run?.status).toBe('failed')

    fail = false
    r.retry(failed.id)
    await r.idle()
    expect(agentMessages()).toHaveLength(1)
    const retried = db.message(failed.id)!
    expect(retried.run?.status).toBe('done')
    expect(retried.run?.error).toBeUndefined()
  })

  it('stops mid-turn when the usage limit is crossed, then refuses the next turn without starting the engine', async () => {
    db.saveAgent(agent('a1', 'lia', { limit: 10 })) // the fake reports more than 10 tokens up front
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    expect(agentMessages()[0]?.run?.status).toBe('limit_reached')
    expect(claude.turns).toHaveLength(1)
    expect(db.agent('a1')!.used).toBeGreaterThan(10) // the partial turn still counts

    await r.send('d1', 'de novo')
    await r.idle()
    expect(agentMessages()[1]?.run?.status).toBe('limit_reached')
    expect(claude.turns).toHaveLength(1) // no second turn was started
  })

  it('stops a run on request', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 30, reply: () => 'uma resposta bem longa que demora pra chegar inteira' }))
    await r.send('d1', 'oi')
    await new Promise((res) => setTimeout(res, 80))
    const working = agentMessages()[0]!
    expect(working.run?.status).toBe('working')
    r.stop(working.id)
    await r.idle()
    const stopped = db.message(working.id)!
    expect(stopped.run?.status).toBe('stopped')
    expect(stopped.text.length).toBeLessThan('uma resposta bem longa que demora pra chegar inteira'.length)
  })

  it('fails fast when the engine is not logged in, without starting it', async () => {
    settings.engines.claude = { installed: true, loggedIn: false }
    const r = runner()
    await r.send('d1', 'oi')
    await r.idle()
    const [reply] = agentMessages()
    expect(reply?.run?.status).toBe('failed')
    expect(reply?.run?.error).toContain('não está logado')
    expect(claude.turns).toHaveLength(0)
  })

  it('reports engine errors on the message', async () => {
    const broken: Engine = {
      id: 'claude',
      async *run() {
        yield { type: 'error', message: 'usage limit reached' }
      }
    }
    const r = runner(broken)
    await r.send('d1', 'oi')
    await r.idle()
    expect(agentMessages()[0]?.run).toMatchObject({ status: 'failed', error: 'usage limit reached' })
  })
})

describe('Db', () => {
  it('marks runs left working as interrupted on startup', () => {
    db.saveMessage({ id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'meio', at: 1, run: { status: 'working', steps: [{ id: 's', label: 'Pensando', status: 'running' }] } })
    expect(db.interruptStaleRuns()).toBe(1)
    expect(db.message('m1')?.run).toMatchObject({ status: 'interrupted', steps: [{ status: 'error' }] })
  })

  it('counts usage per calendar month only', () => {
    const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).getTime()
    db.addReceipt({ messageId: 'x', agentId: 'a1', engine: 'claude', model: 'sonnet', inputTokens: 500, cacheReadTokens: 0, outputTokens: 0, ms: 1, at: lastMonth })
    db.addReceipt({ messageId: 'y', agentId: 'a1', engine: 'claude', model: 'sonnet', inputTokens: 70, cacheReadTokens: 0, outputTokens: 30, ms: 1, at: Date.now() })
    expect(db.usedThisMonth('a1')).toBe(100)
  })
})

describe('ask_user through the gateway', () => {
  let gateway: Gateway

  beforeEach(async () => {
    gateway = new Gateway()
    await gateway.start()
    return () => gateway.stop()
  })

  it('leaves the run waiting for input, and the next human message goes back to the asker', async () => {
    claude = counted(fakeEngine('claude', { delayMs: 1 }))
    const r = new Runner({
      db,
      engines: { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') },
      settings: async () => settings,
      emit: (e) => events.push(e),
      workDir: mkdtempSync(join(tmpdir(), 'ad-work-')),
      gateway
    })
    await r.send('c1', '@lia me pergunta o que faltar')
    await r.idle()
    const [asked] = agentMessages()
    expect(asked?.run).toMatchObject({ status: 'waiting_input', question: 'Pra quando você precisa disso?' })
    expect(asked?.run?.steps.map((s) => s.label)).toEqual(['Pensou', 'Perguntou a você', 'Respondeu'])
    expect(claude.turns[0]?.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{48}$/)

    // No mention and two agents in the channel, but Lia asked: she answers, not the router.
    await r.send('c1', 'até sexta')
    await r.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('done')
    const replies = agentMessages()
    expect(replies).toHaveLength(2)
    expect((replies[1]!.author as { id: string }).id).toBe('a1')
    expect(claude.turns[1]?.prompt).toContain('pergunta enviada a Edu pela ferramenta ask_user: Pra quando você precisa disso?')
    expect(db.messages().some((m) => m.text.startsWith('Chamei'))).toBe(false)
  })
})

describe('browser handback', () => {
  let gateway: Gateway

  beforeEach(async () => {
    gateway = new Gateway()
    await gateway.start()
    return () => gateway.stop()
  })

  function runnerWithGateway(): Runner {
    claude = counted(fakeEngine('claude', { delayMs: 1 }))
    return new Runner({
      db,
      engines: { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') },
      settings: async () => settings,
      emit: (e) => events.push(e),
      workDir: mkdtempSync(join(tmpdir(), 'ad-work-')),
      gateway
    })
  }

  it('resumes the pending ask_user on its own when the browser is handed back', async () => {
    const r = runnerWithGateway()
    await r.send('c1', '@lia me pergunta o que faltar')
    await r.idle()
    const [asked] = agentMessages()
    expect(asked?.run?.status).toBe('waiting_input')

    // No new human message: the handback itself is the answer.
    await r.handedBack('a1')
    await r.idle()

    expect(db.message(asked!.id)?.run?.status).toBe('done')
    const replies = agentMessages()
    expect(replies).toHaveLength(2)
    expect((replies[1]!.author as { id: string }).id).toBe('a1')
    expect(claude.turns[1]?.prompt).toContain('devolveu o controle do seu navegador')
    expect(events.some((e) => e.type === 'message' && (e as { message?: Message }).message?.author.kind === 'agent')).toBe(true)
  })

  it('leaves the question pending while the agents are paused', async () => {
    const r = runnerWithGateway()
    await r.send('c1', '@lia me pergunta o que faltar')
    await r.idle()
    const [asked] = agentMessages()
    r.setPaused(true)
    await r.handedBack('a1')
    await r.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('waiting_input')
    expect(agentMessages()).toHaveLength(1)
  })

  it('does nothing when nothing is pending or the agent is gone', async () => {
    const r = runnerWithGateway()
    await r.handedBack('a1')
    await r.idle()
    expect(claude.turns).toHaveLength(0)
    await r.handedBack('ghost')
    await r.idle()
    expect(claude.turns).toHaveLength(0)
  })
})
