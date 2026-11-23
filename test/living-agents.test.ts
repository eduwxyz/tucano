// Agents that work on their own until the work is done (src/core/jobs.ts and its use in src/core/runs.ts):
// the brakes that stop work that no longer moves, Continuar, someone called in when it's theirs, a failure
// that passes waiting to try again, where a request lands, and what teammates hear while they work.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { MAX_CHIMES } from '../src/core/jobs'
import { chimeSystem } from '../src/core/router'
import { Runner } from '../src/core/runs'
import { anyoneOf, askKind, MAX_CHAIN } from '../src/shared/org'
import { parseQuestions, recommendedAnswers } from '../src/shared/questions'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 10_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, ...extra })
const long = (seed: string): string => Array.from({ length: 70 }, (_, i) => `${seed}${i}`).join(' ') // a delivery: 300+ characters, its own words
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error('never happened')
    await sleep(5)
  }
}

let db: Db
let settings: Settings
let gateway: Gateway
let turns: Turn[] // the agents' own turns
let chimes: Turn[] // the router's turns that may call someone in
let notes: string[] // notification titles

// Each agent's replies, in order: a string is said as is; a function may call tools first; { error } fails the reply.
type Line = string | { error: string } | ((t: Turn) => Promise<string>)
function team(script: Record<string, (n: number) => Line>): Runner {
  const counts: Record<string, number> = {}
  const base = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = {
    id: 'claude',
    async *run(t) {
      if (t.system === chimeSystem()) chimes.push(t)
      const who = Object.keys(script).find((id) => t.system.includes(`Você é ${id[0]!.toUpperCase() + id.slice(1)} (@${id})`))
      if (!who) return yield* base.run(t) // the router, the title
      turns.push(t)
      const n = (counts[who] = (counts[who] ?? 0) + 1)
      const line = script[who]!(n)
      if (typeof line === 'object') return yield { type: 'error', message: line.error }
      const text = typeof line === 'string' ? line : await line(t)
      yield { type: 'text', delta: text }
      yield { type: 'done', text, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } }
    }
  }
  const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') } as Record<EngineId, Engine>
  const computers = { call: async (_a: Agent, _n: string, args: Record<string, unknown>): Promise<{ result: CallToolResult }> => ({ result: textResult(`ok: ${String(args['command'])}`) }) }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-living-')), gateway, computers, notify: (title) => void notes.push(title) })
}

const said = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const system = (): Message[] => db.messages().filter((m) => m.author.kind === 'system')
const whoSaid = (): string[] => said().map((m) => (m.author as { id: string }).id)
const toolText = (r: unknown): string => ((r as CallToolResult).content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n')

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  chimes = []
  notes = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'off', theme: 'system', language: 'pt' } as unknown as Settings
  db.saveAgent(agent('dev', { computer: true }))
  db.saveAgent(agent('rev', { computer: true }))
  db.createConversation({ id: 'c', kind: 'channel', name: 'site', members: ['dev', 'rev'] })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('the brakes on a piece of work', () => {
  it('stops a back-and-forth that moves nothing with a note, and Continuar picks it up from the agent it stopped on', async () => {
    const r = team({ dev: (n) => `Rodada ${n}, @rev, sua vez`, rev: (n) => `Ainda não, giro ${n}. @dev` })
    await r.send('c', '@dev faz a landing')
    await r.idle()
    expect(whoSaid()).toEqual(['dev', 'rev', 'dev'])
    const note = system().at(-1)!
    const jobId = said()[0]!.run!.job!
    expect(note).toMatchObject({ stop: { job: jobId } })
    expect(note.text).toMatch(/^\*\*Parei este trabalho\*\*: foram 3 respostas seguidas sem nada novo/)
    expect(note.text).toContain('**Onde parou**: Dev disse por último: “Rodada 2, @rev, sua vez”')
    expect(db.job(jobId)).toMatchObject({ state: 'stopped', why: 'idle', stoppedAt: said().at(-1)!.id, noteId: note.id })
    expect(notes).toContain('Parei um trabalho')
    // Every reply was part of the same job, set off by my message.
    expect(said().every((m) => m.run?.job === jobId)).toBe(true)
    expect(jobId).toBe(db.messages().find((m) => m.author.kind === 'person')!.id)

    await r.continueJob(jobId, db.owner())
    await r.idle()
    // The note no longer carries Continuar and says who went on; Dev went on, told why it had stopped.
    expect(db.message(note.id)?.stop).toBeUndefined()
    expect(db.message(note.id)?.text).toMatch(/pediu pra continuar\.$/)
    expect(turns[3]!.prompt).toContain('pediu pra continuar este trabalho, que tinha parado porque as respostas seguidas não mudavam nada')
    // Its counts started over: three more that move nothing, and it stops again.
    expect(whoSaid()).toEqual(['dev', 'rev', 'dev', 'dev', 'rev', 'dev'])
    expect(system().filter((m) => m.stop)).toHaveLength(1)
    expect(db.job(jobId)?.state).toBe('stopped')
  })

  it('does nothing on Continuar for work that did not stop', async () => {
    const r = team({ dev: () => 'Pronto.' })
    await r.send('c', '@dev oi')
    await r.idle()
    const jobId = said()[0]!.run!.job!
    expect(db.job(jobId)?.state).toBe('done')
    await r.continueJob(jobId)
    await r.idle()
    expect(said()).toHaveLength(1)
  })

  it('keeps going past 3 replies while each one does something, until one passes the turn to no one', async () => {
    const work = (who: string, next: string) => (n: number) => async (t: Turn) => {
      await callTool(t.mcpUrl!, 'bash', { command: `sed -i s/a/b/ ${who}${n}.html` })
      return n >= 3 && who === 'rev' ? 'Aprovado.' : `Mexi em ${who}${n}. @${next}`
    }
    const r = team({ dev: work('dev', 'rev'), rev: work('rev', 'dev') })
    await r.send('c', '@dev faz a landing; o rev revisa até aprovar')
    await r.idle()
    expect(whoSaid()).toEqual(['dev', 'rev', 'dev', 'rev', 'dev', 'rev'])
    expect(system().some((m) => m.stop)).toBe(false)
    expect(db.job(said()[0]!.run!.job!)).toMatchObject({ state: 'done', idle: 0 })
    expect(notes.filter((n) => n.includes('terminou'))).toHaveLength(1) // told once, at the end
  })

  it('leaves no note on a reply that ends the work anyway, however many came before it moving nothing', async () => {
    db.saveAgent(agent('bia'))
    db.createConversation({ id: 'g', kind: 'channel', name: 'geral', members: ['dev', 'rev', 'bia'] })
    const r = team({ dev: () => 'Bom dia!', rev: () => 'Bom dia, Edu.', bia: () => 'Oi!' })
    await r.send('g', '@dev @rev @bia bom dia')
    await r.idle()
    expect(whoSaid()).toEqual(['dev', 'rev', 'bia'])
    expect(system().some((m) => m.stop)).toBe(false)
    expect(notes).not.toContain('Parei um trabalho')
  })
})

describe('calling someone in', () => {
  beforeEach(() => {
    for (const id of ['qa', 'ops', 'doc']) db.saveAgent(agent(id))
    db.createConversation({ id: 't', kind: 'channel', name: 'time', members: ['dev', 'rev', 'qa', 'ops', 'doc'] })
  })

  it('calls in one other agent when the reply leaves something of theirs to do, with a line saying why', async () => {
    const r = team({ dev: () => `${long('fiz')} [entra rev]`, rev: () => 'Revisei: dois ajustes no título, feitos.' })
    await r.send('t', '@dev faz a landing')
    await r.idle()
    expect(whoSaid()).toEqual(['dev', 'rev'])
    expect(system().map((m) => m.text)).toContain('**Rev** entrou: é da área dele')
    expect(turns[1]!.prompt).toContain('Ninguém chamou você: você entrou porque há algo da sua área pra fazer agora (é da área dele), depois da resposta de Dev acima.')
    // The router was asked about the others in the channel, not about who replied nor whom I named.
    expect(chimes[0]!.prompt).toMatch(/Candidatos:\n- rev: [^\n]*\n- qa: [^\n]*\n- ops: [^\n]*\n- doc: /)
    expect(db.job(said()[0]!.run!.job!)?.chimed).toEqual(['rev'])
  })

  it(`calls in no one when the router sees nothing, and at most ${MAX_CHIMES} agents on one piece of work`, async () => {
    const r = team({ dev: () => `${long('dev')} [entra rev]`, rev: () => `${long('rev')} [entra qa]`, qa: () => `${long('qa')} [entra ops]`, ops: () => `${long('ops')} [entra doc]`, doc: () => 'doc' })
    await r.send('t', '@dev faz a landing')
    await r.idle()
    expect(whoSaid()).toEqual(['dev', 'rev', 'qa', 'ops'])
    expect(system().filter((m) => m.text.includes('entrou'))).toHaveLength(MAX_CHIMES)

    const r2 = team({ dev: () => long('sozinho') })
    await r2.send('t', '@dev mais uma coisa')
    await r2.idle()
    expect(whoSaid().slice(4)).toEqual(['dev'])
  })

  it('never calls in an agent turned off for it, and calls no one in a channel turned off', async () => {
    db.saveAgent(agent('rev', { computer: true, proactive: false }))
    expect(db.agent('rev')?.proactive).toBe(false)
    const r = team({ dev: () => `${long('fiz')} [entra rev]`, rev: () => 'eu' })
    await r.send('t', '@dev faz a landing')
    await r.idle()
    expect(whoSaid()).toEqual(['dev'])
    expect(chimes[0]!.prompt).not.toContain('- rev:')

    db.setProactive('t', false)
    expect(db.conversation('t')?.proactive).toBe(false)
    const before = chimes.length
    await r.send('t', '@dev e o rodapé? [entra qa]')
    await r.idle()
    expect(chimes).toHaveLength(before) // the router isn't even asked
    expect(whoSaid()).toEqual(['dev', 'dev'])
    db.setProactive('t', true)
    expect(db.conversation('t')?.proactive).toBeUndefined()
  })

  it('calls no one in a DM, nor after a reply that passed the turn on', async () => {
    db.createConversation({ id: 'd', kind: 'dm', name: 'dev', members: ['dev'] })
    const r = team({ dev: (n) => (n === 1 ? `${long('dm')} [entra rev]` : `${long('canal')} @rev [entra qa]`), rev: () => 'Revisei.' })
    await r.send('d', 'faz a landing')
    await r.idle()
    expect(chimes).toHaveLength(0)
    await r.send('t', '@dev agora aqui')
    await r.idle()
    // Dev passed the turn to Rev: no one else is called in after Dev; Rev's own reply is asked about.
    expect(whoSaid()).toEqual(['dev', 'dev', 'rev'])
    expect(chimes.every((t) => t.prompt.includes('Resposta de Rev'))).toBe(true)
  })
})

describe('a failure that passes', () => {
  beforeEach(() => {
    db.saveAgent(agent('orion'))
    db.saveAgent(agent('clara', { reportsTo: 'orion' }))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'orion', members: ['orion'] })
  })
  const asking = (n: number): Line => (n === 1 ? async (t) => (await callTool(t.mcpUrl!, 'pedir', { para: 'clara', pedido: 'responda o Fulano' }), '') : 'Pronto: a Clara respondeu o Fulano.')

  it('waits and tries again by itself, with the request still open and no one told, then goes on', async () => {
    let down = true
    const r = team({ orion: asking, clara: () => (down ? { error: "You've hit your limit · resets 5pm" } : 'Respondi o Fulano.') })
    await r.send('dm', 'peça pra Clara responder o Fulano')
    await r.idle()
    const reply = said().find((m) => m.author.kind === 'agent' && m.author.id === 'clara')!
    expect(reply.run).toMatchObject({ status: 'failed', retries: 1 })
    expect(reply.run!.retryAt).toBeGreaterThan(Date.now() + 4 * 60_000)
    expect(reply.run!.steps.at(-1)).toMatchObject({ label: 'Esperando pra tentar de novo', status: 'done' })
    expect(reply.run!.steps.at(-1)!.detail).toMatch(/tenta de novo às \d\d:\d\d$/)
    // Nothing went back to Orion, and no one was told it stopped.
    expect(db.liveDelegations(0)[0]).toMatchObject({ state: 'open' })
    expect(notes.some((n) => n.includes('parou'))).toBe(false)
    expect(said().filter((m) => m.conversationId === 'dm')).toHaveLength(1) // only the reply that asked
    // Not yet: the time hasn't come.
    r.sweepRetries()
    await r.idle()
    expect(db.message(reply.id)?.run?.status).toBe('failed')

    down = false
    r.sweepRetries(Date.now() + 6 * 60_000)
    await r.idle()
    // The same reply, tried again in place: done, and the request went back.
    expect(db.message(reply.id)?.run?.status).toBe('done')
    expect(db.message(reply.id)?.run?.retryAt).toBeUndefined()
    expect(db.liveDelegations(0)[0]).toMatchObject({ state: 'done', told: true })
    expect(said().at(-1)?.text).toBe('Pronto: a Clara respondeu o Fulano.')
  })

  it('gives up after its waits run out: then it is a failure like any other, and whoever asked hears it', async () => {
    const r = team({ orion: (n) => (n === 1 ? asking(1) : 'Não deu: a Clara não conseguiu.'), clara: () => ({ error: "You've hit your limit · resets 5pm" }) })
    await r.send('dm', 'peça pra Clara responder o Fulano')
    await r.idle()
    const reply = said().find((m) => m.author.kind === 'agent' && m.author.id === 'clara')!
    for (let i = 1; i <= 6; i++) {
      expect(db.message(reply.id)?.run?.retries).toBe(i)
      r.sweepRetries(Date.now() + 31 * 60_000)
      await r.idle()
    }
    expect(db.message(reply.id)?.run).toMatchObject({ status: 'failed', retries: 6 })
    expect(db.message(reply.id)?.run?.retryAt).toBeUndefined()
    expect(db.liveDelegations(0)[0]).toMatchObject({ state: 'failed', told: true })
    expect(said().at(-1)?.text).toBe('Não deu: a Clara não conseguiu.')
  })

  it('finds the replies due every minute through an index, not by reading every message', () => {
    const raw = (db as unknown as { db: DatabaseSync }).db
    const plan = (raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM messages WHERE run IS NOT NULL AND json_extract(run, '$.status') = 'failed' AND json_extract(run, '$.retryAt') <= ? ORDER BY at").all(1) as { detail: string }[]).map((r) => r.detail).join(' | ')
    expect(plan).toContain('USING INDEX messages_retry')
    db.saveMessage({ id: 'due', conversationId: 'c', author: { kind: 'agent', id: 'dev' }, text: '', at: 1, run: { status: 'failed', depth: 1, steps: [], retryAt: 100 } })
    db.saveMessage({ id: 'later', conversationId: 'c', author: { kind: 'agent', id: 'dev' }, text: '', at: 2, run: { status: 'failed', depth: 1, steps: [], retryAt: 500 } })
    db.saveMessage({ id: 'gave-up', conversationId: 'c', author: { kind: 'agent', id: 'dev' }, text: '', at: 3, run: { status: 'failed', depth: 1, steps: [] } })
    expect(db.retriesDue(200).map((m) => m.id)).toEqual(['due'])
  })

  it('does not wait on a failure that does not pass by itself', async () => {
    const r = team({ dev: () => ({ error: 'quebrou' }) })
    await r.send('c', '@dev faz')
    await r.idle()
    expect(said()[0]!.run).toMatchObject({ status: 'failed' })
    expect(said()[0]!.run!.retryAt).toBeUndefined()
    expect(notes).toContain('Dev parou')
  })
})

describe('where a request lands', () => {
  beforeEach(() => {
    db.saveAgent(agent('bento'))
    db.saveAgent(agent('nico', { reportsTo: 'bento' }))
    db.createConversation({ id: 'eng', kind: 'channel', name: 'engenharia', members: ['bento', 'nico'] })
  })

  it('stays right here, under my message, when the one asked is in this conversation', async () => {
    const r = team({ bento: (n) => (n === 1 ? async (t) => (await callTool(t.mcpUrl!, 'pedir', { para: 'nico', pedido: 'veja o build' }), '') : 'Pronto: o Nico viu o build.'), nico: () => 'O build passou.' })
    await r.send('eng', '@bento veja o build')
    await r.idle()
    const mine = db.messages().find((m) => m.author.kind === 'person')!
    const [d] = db.liveDelegations(0)
    expect(d).toMatchObject({ from: 'bento', to: 'nico', conversationId: 'eng', threadId: mine.id, state: 'done', told: true })
    expect(db.conversations().some((c) => c.kind === 'dm')).toBe(false)
    expect(db.message(d!.rootId)).toMatchObject({ conversationId: 'eng', threadId: mine.id, text: '@nico, um pedido:\n\nveja o build' })
    expect(said().find((m) => m.author.kind === 'agent' && m.author.id === 'nico')?.threadId).toBe(mine.id)
  })

  it('goes to their DM with me when they are not in it, wherever they are in the tree', async () => {
    const r = team({ dev: (n) => (n === 1 ? async (t) => (await callTool(t.mcpUrl!, 'pedir', { para: 'nico', pedido: 'veja o build' }), '') : 'Pronto.'), nico: () => 'O build passou.' })
    await r.send('c', '@dev peça pro nico ver o build')
    await r.idle()
    const dm = db.conversations().find((c) => c.kind === 'dm' && c.name === 'nico')!
    expect(dm).toMatchObject({ members: ['nico'], owner: db.ownerId() })
    expect(db.liveDelegations(0)[0]).toMatchObject({ from: 'dev', to: 'nico', conversationId: dm.id, state: 'done' })
    // Dev is in no tree and Nico in Bento's: a request from outside the team, said so.
    expect(turns.find((t) => t.system.includes('Você é Nico'))!.prompt).toContain('um pedido de Dev, de fora do seu time')
  })

  it('carries what I asked and how the work was split, and a teammate hears at its next step what another delivered', async () => {
    db.saveAgent(agent('orion'))
    db.saveAgent(agent('clara', { reportsTo: 'orion', computer: true }))
    db.saveAgent(agent('bia', { reportsTo: 'orion', computer: true }))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'orion', members: ['orion'] })
    let claraSaw = ''
    let biaSaw = ''
    const r = team({
      orion: (n) =>
        n === 1
          ? async (t) => {
              await callTool(t.mcpUrl!, 'pedir', { para: 'clara', pedido: 'escreva o texto da landing' })
              await callTool(t.mcpUrl!, 'pedir', { para: 'bia', pedido: 'monte a página com o texto' })
              return ''
            }
          : 'Pronto: texto e página.',
      // Clara is already at work when Bia's part is asked: she hears of it at her next step.
      clara: () => async (t) => {
        await until(() => db.liveDelegations(0).some((d) => d.to === 'bia'))
        claraSaw = toolText(await callTool(t.mcpUrl!, 'bash', { command: 'cat texto.md' }))
        return 'O texto: Tucano, seu time de agentes.'
      },
      // Bia waits on Clara's part: when it is delivered, her next step carries it.
      bia: () => async (t) => {
        await until(() => db.liveDelegations(0).some((d) => d.to === 'clara' && d.state === 'done'))
        biaSaw = toolText(await callTool(t.mcpUrl!, 'bash', { command: 'ls' }))
        return 'Página montada com o texto da Clara.'
      }
    })
    await r.send('dm', 'faça a landing: texto e página')
    await r.idle()
    expect(claraSaw).toContain('[A divisão do trabalho ganhou mais uma parte: Bia vai fazer monte a página com o texto. Não faça essa parte.]')
    expect(biaSaw).toContain('[Enquanto você trabalhava, Clara terminou a parte dele: O texto: Tucano, seu time de agentes.]')
    const bia = turns.find((t) => t.system.includes('Você é Bia'))!.prompt
    expect(bia).toContain('O que Edu pediu no começo:\n')
    expect(bia).toContain('faça a landing: texto e página')
    expect(bia).toMatch(/Como o trabalho foi dividido \(o resto, além do seu\):\n- Clara \[[0-9a-f]{8}\], em andamento: escreva o texto da landing/)
    expect(said().at(-1)?.text).toBe('Pronto: texto e página.')
  })
})

describe('anyone may ask anyone', () => {
  const tree = [agent('orion'), agent('clara', { reportsTo: 'orion' }), agent('nico', { reportsTo: 'clara' }), agent('mira', { sectorName: 'Financeiro' }), agent('lino', { reportsTo: 'mira' }), agent('solo'), agent('tuca', { kind: 'tuca' }), agent('velho', { archived: true })]

  it('reaches everyone, those on its way in the tree first, never the Tuca nor an archived agent', () => {
    const lino = anyoneOf(tree, 'lino').map((a) => a.id)
    expect(lino[0]).toBe('mira')
    expect(lino.sort()).toEqual(['clara', 'mira', 'nico', 'orion', 'solo'])
    expect(anyoneOf(tree, 'solo').map((a) => a.id).sort()).toEqual(['clara', 'lino', 'mira', 'nico', 'orion'])
    expect(anyoneOf(tree, 'nico').map((a) => a.id)).not.toContain('nico')
  })

  it("names a request from out of its way in the tree as 'other', and another head's as 'sector'", () => {
    expect(askKind(tree, 'lino', 'nico')).toBe('other')
    expect(askKind(tree, 'lino', 'orion')).toBe('sector')
    expect(askKind(tree, 'lino', 'mira')).toBe('up')
    expect(MAX_CHAIN).toBe(5)
  })
})

describe('a recommended option', () => {
  it('is kept on the option marked, one per decision', () => {
    const parsed = parseQuestions({ questions: [{ question: 'Qual cor?', kind: 'single', options: [{ label: 'Azul' }, { label: 'Verde', recommended: true }, { label: 'Roxo', recommended: true }] }] })
    if ('error' in parsed) throw new Error(parsed.error)
    expect(parsed.questions[0]!.options!.map((o) => o.recommended ?? false)).toEqual([false, true, false])
  })

  it('answers every decision with it, only when each one has one', () => {
    const one = { question: 'Qual cor?', kind: 'single' as const, options: [{ label: 'Azul' }, { label: 'Verde', recommended: true as const }] }
    const many = { question: 'Onde?', kind: 'multiple' as const, options: [{ label: 'Site', recommended: true as const }, { label: 'App' }] }
    expect(recommendedAnswers([one, many])).toEqual([{ chosen: [1] }, { chosen: [0] }])
    expect(recommendedAnswers([one, { question: 'Nome?', kind: 'text' as const }])).toBeUndefined()
    expect(recommendedAnswers([{ ...one, options: [{ label: 'Azul' }] }])).toBeUndefined()
    expect(recommendedAnswers([])).toBeUndefined()
  })
})
