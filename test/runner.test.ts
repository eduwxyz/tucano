import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { customModel, type Agent, type EngineId, type Message, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import type { Answer } from '../src/shared/questions'
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

function runner(engine: Engine = fakeEngine('claude', { delayMs: 1 })): Runner {
  claude = counted(engine)
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')) })
}

const agentMessages = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia'))
  db.saveAgent(agent('a2', 'theo', { modelId: 'gpt-5.6-luna' }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
})

describe('Runner', () => {
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
    claude = counted(fakeEngine('claude', { delayMs: 1 }))
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), dataDir: data })
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
    expect(db.messages().at(-1)?.text).toContain('foram 3 respostas seguidas')
  })

  it('the chain goes as far as the limit set in Settings', async () => {
    const pingPong = fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? '@theo, sua vez' : '@lia, sua vez') })
    const r = runner(pingPong)
    settings.engines.codex = ready
    settings.chainDepth = 5
    db.saveAgent(agent('a2', 'theo'))
    await r.send('c1', '@lia começa')
    await r.idle()
    expect(agentMessages().map((m) => m.run?.depth)).toEqual([1, 2, 3, 4, 5])
    expect(db.messages().at(-1)?.text).toContain('foram 5 respostas seguidas')
  })

  it('a limit below 1 is raised to 1', async () => {
    const pingPong = fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? '@theo, sua vez' : '@lia, sua vez') })
    const r = runner(pingPong)
    settings.engines.codex = ready
    settings.chainDepth = 0
    db.saveAgent(agent('a2', 'theo'))
    await r.send('c1', '@lia começa')
    await r.idle()
    expect(agentMessages().map((m) => m.run?.depth)).toEqual([1])
    expect(db.messages().at(-1)?.text).toContain('foi 1 resposta seguida')
  })

  it('a limit above 10 is brought down to 10', async () => {
    const pingPong = fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? '@theo, sua vez' : '@lia, sua vez') })
    const r = runner(pingPong)
    settings.engines.codex = ready
    settings.chainDepth = 50
    db.saveAgent(agent('a2', 'theo'))
    await r.send('c1', '@lia começa')
    await r.idle()
    expect(agentMessages().map((m) => m.run?.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(db.messages().at(-1)?.text).toContain('foram 10 respostas seguidas')
  })

  describe('screening a hand-off', () => {
    const lia = (text: string): Engine => fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? text : 'ok') })
    const steps = (): string[] => agentMessages().find((m) => (m.author as { id: string }).id === 'a1')!.run!.steps.map((x) => `${x.label} | ${x.detail ?? ''}`)

    it('does not wake an agent that is only thanked', async () => {
      const r = runner(lia('Valeu, @theo! Ficou ótimo.'))
      await r.send('c1', '@lia começa')
      await r.idle()
      expect(agentMessages().map((m) => (m.author as { id: string }).id)).toEqual(['a1'])
      expect(steps().some((x) => x.startsWith('Ninguém precisa responder'))).toBe(true)
      expect(db.messages().some((m) => m.text.includes('Parei a conversa'))).toBe(false)
    })

    it('hands the turn for a request and notes it on the reply', async () => {
      const r = runner(lia('@theo, revisa o PR #12?'))
      await r.send('c1', '@lia começa')
      await r.idle()
      expect(agentMessages().map((m) => [(m.author as { id: string }).id, m.run?.depth])).toEqual([
        ['a1', 1],
        ['a2', 2]
      ])
      expect(steps().some((x) => x.startsWith('Chamou') && x.includes('theo'))).toBe(true)
    })

    it('calls everyone mentioned when the router is not ready', async () => {
      settings.routerModel = 'gpt-5.6-luna'
      settings.engines.codex = { installed: true, loggedIn: false }
      db.saveAgent(agent('a2', 'theo')) // on Claude, so only the router's harness is down
      const r = runner(lia('Valeu, @theo! Ficou ótimo.'))
      await r.send('c1', '@lia começa')
      await r.idle()
      expect(agentMessages().map((m) => (m.author as { id: string }).id)).toEqual(['a1', 'a2'])
      expect(steps().some((x) => x.startsWith('Chamou') && x.includes('não consegui avaliar'))).toBe(true)
    })
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
    // In what to do, with the CLI's own words kept as the detail.
    expect(agentMessages()[0]?.run).toMatchObject({ status: 'failed', error: 'Seu plano do Claude Code chegou no limite. Tente de novo mais tarde.', errorDetail: 'usage limit reached' })
  })
})

describe('one reply at a time per agent and thread', () => {
  const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((res) => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true }) })
  // Lia and Bia ask Theo for something; Theo takes `ms` and records how many of his turns overlap.
  const slowTheo = (ms: number): { engine: Engine; active: () => number; max: () => number } => {
    let active = 0
    let max = 0
    const base = fakeEngine('claude', { delayMs: 1, reply: (t) => (t.system.startsWith('Você é lia') ? '@theo, revisa o PR?' : t.system.startsWith('Você é bia') ? '@theo, e o deploy?' : 'feito') })
    const engine: Engine = {
      id: 'claude',
      run: (t) =>
        t.system.startsWith('Você é theo')
          ? (async function* () {
              max = Math.max(max, ++active)
              try {
                await sleep(ms, t.signal)
                yield* base.run(t)
              } finally {
                active--
              }
            })()
          : base.run(t)
    }
    return { engine, active: () => active, max: () => max }
  }
  const by = (id: string): Message[] => agentMessages().filter((m) => (m.author as { id: string }).id === id)

  beforeEach(() => {
    db.saveAgent(agent('a2', 'theo')) // on Claude, like the others
    db.saveAgent(agent('a3', 'bia'))
    db.createConversation({ id: 'c3', kind: 'channel', name: 'time', members: ['a1', 'a2', 'a3'] })
    db.createConversation({ id: 'c4', kind: 'channel', name: 'outro', members: ['a1', 'a2'] })
  })

  it('answers hand-offs that arrive while the agent replies once more, after, never at the same time', async () => {
    const t = slowTheo(800)
    const r = runner(t.engine)
    await r.send('c3', '@lia @bia começam')
    await r.idle()
    expect(by('a2').map((m) => [m.run?.status, m.run?.depth])).toEqual([['done', 2], ['done', 2]])
    expect(t.max()).toBe(1)
    // Whoever reached Theo while he was replying says so on their reply.
    const notes = [...by('a1'), ...by('a3')].flatMap((m) => m.run!.steps.map((x) => x.detail ?? ''))
    expect(notes.some((x) => x.includes('já está respondendo'))).toBe(true)
  })

  it('keeps conversations parallel: the same agent replies in two at once', async () => {
    const t = slowTheo(300)
    const r = runner(t.engine)
    await Promise.all([r.send('c1', '@lia começa'), r.send('c4', '@lia começa')])
    await r.idle()
    expect(by('a2')).toHaveLength(2)
    expect(t.max()).toBe(2)
  })

  // Theo is replying in #time: waits until his reply is running.
  const replying = async (): Promise<void> => {
    for (let i = 0; i < 200 && by('a2')[0]?.run?.status !== 'working'; i++) await new Promise((res) => setTimeout(res, 5))
  }

  it("a person's mention while the agent replies waits for it, and the ones that pile up are one reply", async () => {
    const t = slowTheo(400)
    const r = runner(t.engine)
    await r.send('c3', '@theo um')
    await replying()
    await r.send('c3', '@theo dois')
    await r.send('c3', '@theo três')
    await r.idle()
    expect(by('a2').map((m) => m.run?.status)).toEqual(['done', 'done'])
    expect(t.max()).toBe(1)
  })

  it('a routine in the same chat waits for the reply running there', async () => {
    const t = slowTheo(400)
    const r = runner(t.engine)
    await r.send('c3', '@theo um')
    await replying()
    const done = r.runRoutine({ id: 'rt', name: 'R', agentId: 'a2', conversationId: 'c3', prompt: 'rotina', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 }, { scheduledAt: 1, late: false })
    await r.idle()
    expect((await done)?.run?.status).toBe('done')
    expect(by('a2')).toHaveLength(2)
    expect(t.max()).toBe(1)
  })

  it('two routines that fire together in one chat run one after the other', async () => {
    const t = slowTheo(200)
    const r = runner(t.engine)
    const routine = (id: string) => ({ id, name: id, agentId: 'a2', conversationId: 'c3', prompt: 'rotina', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 })
    const runs = await Promise.all([r.runRoutine(routine('r1'), { scheduledAt: 1, late: false }), r.runRoutine(routine('r2'), { scheduledAt: 1, late: false })])
    expect(runs.map((m) => m?.run?.status)).toEqual(['done', 'done'])
    expect(t.max()).toBe(1)
  })

  it('drops the follow-up when the reply it waited for was stopped', async () => {
    const t = slowTheo(2000)
    const r = runner(t.engine)
    await r.send('c3', '@lia @bia começam')
    for (let i = 0; i < 100 && !(by('a2')[0]?.run?.status === 'working' && by('a1')[0]?.run?.steps.some((x) => x.label === 'Chamou') && by('a3')[0]?.run?.steps.some((x) => x.label === 'Chamou')); i++) await new Promise((res) => setTimeout(res, 10))
    r.stop(by('a2')[0]!.id)
    await r.idle()
    expect(by('a2').map((m) => m.run?.status)).toEqual(['stopped'])
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
      engines: { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
      settings: async () => settings,
      emit: (e) => events.push(e),
      workDir: mkdtempSync(join(tmpdir(), 'ad-work-')),
      gateway
    })
    await r.send('c1', '@lia me pergunta o que faltar')
    await r.idle()
    const [asked] = agentMessages()
    expect(asked?.run).toMatchObject({ status: 'waiting_input', questions: [{ question: 'Pra quando você precisa disso?', kind: 'text' }] })
    expect(asked?.run?.steps.map((s) => s.label)).toEqual(['Pensou', 'Perguntou a você', 'Respondeu'])
    expect(claude.turns[0]?.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\/[a-f0-9]{48}$/)

    // No mention and two agents in the channel, but Lia asked in this thread: she answers, not the router.
    await r.send('c1', 'até sexta', [], asked!.threadId)
    await r.idle()
    expect(db.message(asked!.id)?.run?.status).toBe('done')
    const replies = agentMessages()
    expect(replies).toHaveLength(2)
    expect((replies[1]!.author as { id: string }).id).toBe('a1')
    expect(claude.turns[1]?.prompt).toContain('pergunta enviada a Edu pela ferramenta ask_user: Pra quando você precisa disso?')
    expect(db.messages().some((m) => m.text.startsWith('Chamei'))).toBe(false)
  })
  const askingRunner = (): Runner =>
    new Runner({
      db,
      engines: { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
      settings: async () => settings,
      emit: (e) => events.push(e),
      workDir: mkdtempSync(join(tmpdir(), 'ad-work-')),
      gateway
    })

  it('asks a list of decisions', async () => {
    claude = counted(fakeEngine('claude', { delayMs: 1 }))
    const r = askingRunner()
    await r.send('c1', '@lia me ajuda a decidir')
    await r.idle()
    const [asked] = agentMessages()
    expect(asked?.run).toMatchObject({
      status: 'waiting_input',
      questions: [
        { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] },
        { question: 'Pra quando?', kind: 'text' }
      ]
    })
    // The same decisions as text, for what reads text only (a team's inbox, the phone, a notification).
    expect(asked?.run?.question).toBe('1. Paginação no menu? (Busca remota | Scroll infinito)\n2. Pra quando?')
    expect(asked?.run?.steps.find((s) => s.label === 'Perguntou a você')?.detail).toBe('Paginação no menu? (+1)')
  })

  it('gives the agent the error when the decisions are invalid', async () => {
    claude = counted(fakeEngine('claude', { delayMs: 1 }))
    const r = askingRunner()
    await r.send('c1', '@lia decisões demais')
    await r.idle()
    const [asked] = agentMessages()
    expect(asked?.run?.status).not.toBe('waiting_input')
    expect(asked?.run?.questions).toBeUndefined()
  })

  const askDecisions = async (): Promise<{ r: Runner; asked: Message }> => {
    claude = counted(fakeEngine('claude', { delayMs: 1 }))
    const r = askingRunner()
    await r.send('c1', '@lia me ajuda a decidir')
    await r.idle()
    return { r, asked: agentMessages()[0]! }
  }
  const mine = (): Message[] => db.messages().filter((m) => m.author.kind === 'person')

  it('sends the answers of a question older than the last 50 messages', async () => {
    const { r, asked } = await askDecisions()
    for (let i = 0; i < 60; i++) db.saveMessage({ id: `routine-${i}`, conversationId: asked.conversationId, author: { kind: 'system' }, text: `Rotina ${i}`, at: asked.at + 1000 + i, ...(asked.threadId ? { threadId: asked.threadId } : {}) })
    r.answerDecision(asked.id, 0, { chosen: [1] }, db.owner())
    r.answerDecision(asked.id, 1, { text: 'até sexta' }, db.owner())
    await r.submitDecisions(asked.id, db.owner())
    expect(db.message(asked.id)?.run?.status).toBe('done')
    expect(mine().at(-1)?.text).toContain('Scroll infinito')
  })

  it('answers the question on the card, not a newer one waiting in the same place', async () => {
    const { r, asked } = await askDecisions()
    const newer: Message = { ...asked, id: 'newer', author: { kind: 'agent', id: 'a2' }, at: asked.at + 1000, run: { status: 'waiting_input', steps: [], questions: [{ question: 'Outra?', kind: 'text' }] } }
    db.saveMessage(newer)
    r.answerDecision(asked.id, 0, { skipped: true }, db.owner())
    r.answerDecision(asked.id, 1, { text: 'até sexta' }, db.owner())
    await r.submitDecisions(asked.id, db.owner())
    expect(db.message(asked.id)?.run?.status).toBe('done')
    expect(db.message('newer')?.run?.status).toBe('waiting_input')
  })

  it('keeps partial answers on the question and sends them as my message', async () => {
    const { r, asked } = await askDecisions()
    r.answerDecision(asked.id, 0, { chosen: [1] }, db.owner())
    expect(db.message(asked.id)?.run?.answers).toEqual([{ chosen: [1] }, null])
    r.answerDecision(asked.id, 1, { text: 'sexta' }, db.owner())
    await r.submitDecisions(asked.id, db.owner())
    await r.idle()
    expect(mine().at(-1)?.text).toBe('- Paginação no menu? → Scroll infinito\n- Pra quando? → sexta')
    expect(db.message(asked.id)?.run?.status).toBe('done')
    expect(db.message(asked.id)?.run?.answeredInText).toBeUndefined()
    // The card knows which message carried its answers: the conversation shows them once, on the card.
    expect(db.message(asked.id)?.run).toMatchObject({ answerMessage: mine().at(-1)?.id })
    expect(db.message(asked.id)?.run?.answerTyped).toBeUndefined()
    expect(claude.turns[1]?.prompt).toContain('- Paginação no menu? → Scroll infinito\n- Pra quando? → sexta')
  })

  it('sends the partial answers along with a free reply', async () => {
    const { r, asked } = await askDecisions()
    r.answerDecision(asked.id, 0, { chosen: [0] }, db.owner())
    await r.send('c1', 'o resto eu explico: depois do deploy', [], asked.threadId)
    await r.idle()
    expect(mine().at(-1)?.text).toBe('- Paginação no menu? → Busca remota\n\no resto eu explico: depois do deploy')
    expect(db.message(asked.id)?.run).toMatchObject({ status: 'done', answeredInText: true, answerMessage: mine().at(-1)?.id, answerTyped: 'o resto eu explico: depois do deploy' })
  })

  it('an answer typed with nothing picked on the card is not linked to it: it shows as the message it is', async () => {
    const { r, asked } = await askDecisions()
    await r.send('c1', 'busca remota, até sexta', [], asked.threadId)
    await r.idle()
    expect(db.message(asked.id)?.run?.status).toBe('done')
    expect(db.message(asked.id)?.run?.answerMessage).toBeUndefined()
  })

  it('ignores answers to a question already sent, out of range, or to an unknown option', async () => {
    const { r, asked } = await askDecisions()
    r.answerDecision(asked.id, 9, { text: 'x' }, db.owner())
    r.answerDecision(asked.id, 0, { chosen: [7] }, db.owner())
    r.answerDecision(asked.id, 0, { chosen: [0, 1] }, db.owner()) // a single choice takes one
    r.answerDecision(asked.id, 1, { chosen: [0] }, db.owner()) // a text decision takes text
    r.answerDecision(asked.id, -1, { text: 'x' }, db.owner())
    expect(() => r.answerDecision('nope', 0, { chosen: [0] }, db.owner())).toThrow()
    expect(db.message(asked.id)?.run?.answers).toBeUndefined()
    r.answerDecision(asked.id, 0, { chosen: [0], text: 'ignored', extra: 1 } as Answer, db.owner())
    expect(db.message(asked.id)?.run?.answers).toEqual([{ chosen: [0] }, null])
    await r.submitDecisions(asked.id, db.owner())
    await r.idle()
    expect(() => r.answerDecision(asked.id, 0, { chosen: [1] }, db.owner())).toThrow()
    expect(db.message(asked.id)?.run?.answers).toEqual([{ chosen: [0] }, null])
  })

  it('sends only once', async () => {
    const { r, asked } = await askDecisions()
    r.answerDecision(asked.id, 0, { skipped: true }, db.owner())
    const sent = await Promise.allSettled([r.submitDecisions(asked.id, db.owner()), r.submitDecisions(asked.id, db.owner())])
    expect(sent.map((x) => x.status)).toEqual(['fulfilled', 'rejected'])
    await r.idle()
    expect(mine()).toHaveLength(2)
  })

  it('clears an answer with null', async () => {
    const { r, asked } = await askDecisions()
    r.answerDecision(asked.id, 0, { chosen: [0] }, db.owner())
    r.answerDecision(asked.id, 1, { text: 'sexta' }, db.owner())
    r.answerDecision(asked.id, 0, null, db.owner())
    expect(db.message(asked.id)?.run?.answers).toEqual([null, { text: 'sexta' }])
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
      engines: { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
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

describe('an agent on Antigravity', () => {
  it('runs on Antigravity, not on Claude', async () => {
    db.saveAgent(agent('a9', 'gi', { modelId: customModel('antigravity', 'antigravity/gemini-2.5-flash') }))
    db.createConversation({ id: 'd9', kind: 'dm', name: 'a9', members: ['a9'] })
    const antigravity = counted(fakeEngine('antigravity'))
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity, cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-gemini-')) })
    await r.send('d9', 'oi')
    await r.idle()
    expect(antigravity.turns.map((t) => t.model)).toEqual(['antigravity/gemini-2.5-flash'])
    expect(claude.turns).toHaveLength(0)
  })
})

describe('an agent on Cursor', () => {
  it('runs on Cursor, not on Claude', async () => {
    db.saveAgent(agent('a10', 'cu', { modelId: customModel('cursor', 'auto') }))
    db.createConversation({ id: 'd10', kind: 'dm', name: 'a10', members: ['a10'] })
    const cursor = counted(fakeEngine('cursor'))
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor, grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-cursor-')) })
    await r.send('d10', 'oi')
    await r.idle()
    expect(cursor.turns.map((t) => t.model)).toEqual(['auto'])
    expect(claude.turns).toHaveLength(0)
  })
})

describe('an agent on Grok', () => {
  it('runs on Grok, not on Claude', async () => {
    db.saveAgent(agent('a11', 'gk', { modelId: customModel('grok', 'grok-4.7') }))
    db.createConversation({ id: 'd11', kind: 'dm', name: 'a11', members: ['a11'] })
    const grok = counted(fakeEngine('grok'))
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok, cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-grok-')) })
    await r.send('d11', 'oi')
    await r.idle()
    expect(grok.turns.map((t) => t.model)).toEqual(['grok-4.7'])
    expect(claude.turns).toHaveLength(0)
  })
})

describe('an agent on Cline', () => {
  it('runs on Cline with the provider and model it was given, not on Claude', async () => {
    db.saveAgent(agent('a12', 'cl', { modelId: customModel('cline', 'cline/anthropic/claude-sonnet-4.5') }))
    db.createConversation({ id: 'd12', kind: 'dm', name: 'a12', members: ['a12'] })
    const cline = counted(fakeEngine('cline'))
    const r = new Runner({ db, engines: { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline, hermes: fakeEngine('hermes') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-cline-')) })
    await r.send('d12', 'oi')
    await r.idle()
    expect(cline.turns.map((t) => t.model)).toEqual(['cline/anthropic/claude-sonnet-4.5'])
    expect(claude.turns).toHaveLength(0)
  })
})
