// When no one on the team does what was asked, the Tuca asks leave to do it himself (fazer_eu_mesmo): a card
// with three answers. What the person allows is theirs, holds where they said, and gives him the web or a
// connector only for the replies he works for them.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Connector, EngineId, LeaveAsk, Message, Person, Settings, TucaLeave } from '../src/shared/types'
import { setLang } from '../src/shared/lang'
import { questionsOf } from '../src/shared/questions'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { People } from '../src/core/people'
import { Runner } from '../src/core/runs'
import { tucaAgent } from '../src/core/tuca'
import { covering, forRole, kindKey, leaveChoice, leaveDecision, leaveFrom, leaveSection, leavesFor, leaveTask, leaveTools, newLeave, shouldSuggest, SUGGEST_AT, timesDone, withLeaves } from '../src/core/tuca-leave'

const linear: Connector = { id: 'c-lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth', status: 'connected', tools: [] }
const ask: LeaveAsk = { kind: 'pesquisa de preços', what: 'Pesquisar o preço dos concorrentes.', web: true }
const leave = (extra: Partial<TucaLeave> = {}): TucaLeave => ({ id: 'l1', person: 'p1', kind: 'pesquisa de preços', what: 'Pesquisar.', web: true, uses: 1, at: 1, ...extra })

describe('what he asks leave for', () => {
  beforeEach(() => setLang('pt'))

  it('reads the call: what, the kind of thing, the web and the connectors', () => {
    expect(leaveFrom({ o_que: '  Pesquisar  o preço. ', tipo: 'Pesquisa de preços', web: true }, { connectors: [linear], admin: true }).ask).toEqual({ kind: 'Pesquisa de preços', what: 'Pesquisar o preço.', web: true })
    expect(leaveFrom({ o_que: 'Ver as issues', tipo: 'triagem', conectores: [{ conector: 'linear' }] }, { connectors: [linear], admin: true }).ask).toEqual({ kind: 'triagem', what: 'Ver as issues', grants: { 'c-lin': 'read' } })
    expect(leaveFrom({ o_que: 'Fechar issues', tipo: 'triagem', conectores: [{ conector: 'Linear', nivel: 'escrita' }, { conector: 'web' }] }, { connectors: [linear], admin: true }).ask).toEqual({ kind: 'triagem', what: 'Fechar issues', web: true, grants: { 'c-lin': 'read_write' } })
    // Nothing but writing is a leave too.
    expect(leaveFrom({ o_que: 'Escrever um poema', tipo: 'poema' }, { connectors: [], admin: true }).ask).toEqual({ kind: 'poema', what: 'Escrever um poema' })
  })

  it('says what to fix: something missing, a connector that is not there, a connector for a member', () => {
    expect(leaveFrom({ o_que: 'x' }, { connectors: [], admin: true }).error).toContain('tipo')
    expect(leaveFrom({ tipo: 'x' }, { connectors: [], admin: true }).error).toContain('o_que')
    expect(leaveFrom({ o_que: 'x', tipo: '!!!' }, { connectors: [], admin: true }).error).toContain('tipo') // a kind with nothing to tell it by
    expect(leaveFrom({ o_que: 'x', tipo: 'y', conectores: [{ conector: 'Jira' }] }, { connectors: [linear], admin: true }).error).toContain('"Jira"')
    expect(leaveFrom({ o_que: 'x', tipo: 'y', conectores: [{ conector: 'Linear' }] }, { connectors: [linear], admin: false }).error).toContain('só um admin libera um conector')
    expect(leaveFrom({ o_que: 'x', tipo: 'y', web: true }, { connectors: [linear], admin: false }).ask).toMatchObject({ web: true }) // the web, a member may give
  })

  it('becomes a card with three answers, the first recommended, in both languages', () => {
    const d = leaveDecision(ask, [linear])
    expect(d.kind).toBe('single')
    expect(d.question).toBe('Ninguém do time faz isso ainda. Posso fazer eu mesmo? Pesquisar o preço dos concorrentes.')
    expect(d.options!.map((o) => o.label)).toEqual(['Pode fazer', 'Pode, e não precisa perguntar de novo pra esse tipo de coisa', 'Prefiro um colega pra isso'])
    expect(d.options![0]).toMatchObject({ recommended: true, description: 'Só desta vez. Vou usar: a web.' })
    expect(d.options![1]!.description).toBe('Vale pra: pesquisa de preços.')
    expect(d.options!.every((o) => o.label.length <= 80 && (o.description ?? '').length <= 200)).toBe(true)
    expect(leaveDecision({ ...ask, what: 'x'.repeat(300) }, []).question.length).toBeLessThanOrEqual(200)
    expect(leaveTools({ grants: { 'c-lin': 'read_write', gone: 'read' } }, [linear])).toBe('Linear (leitura e escrita), um conector removido (leitura)')
    expect(leaveTools({}, [])).toBe('nada além de escrever')
    setLang('en')
    const en = leaveDecision(ask, [linear])
    expect(en.question).toContain('No one on the team does this yet. May I do it myself?')
    expect(en.options!.map((o) => o.label)).toEqual(['Go ahead', 'Go ahead, and no need to ask again for this kind of thing', "I'd rather have a colleague for this"])
    expect(en.options!.every((o) => o.label.length <= 80)).toBe(true)
  })

  it('reads the answer back: from the card, or from its words, and nothing else allows anything', () => {
    expect(leaveChoice([{ chosen: [0] }], '')).toBe('once')
    expect(leaveChoice([{ chosen: [1] }], '')).toBe('always')
    expect(leaveChoice([{ chosen: [2] }], '')).toBe('colleague')
    expect(leaveChoice(undefined, 'Pode fazer.')).toBe('once')
    expect(leaveChoice(undefined, 'pode, e não precisa perguntar de novo pra esse tipo de coisa')).toBe('always')
    expect(leaveChoice(undefined, "I'd rather have a colleague for this")).toBe('colleague')
    expect(leaveChoice(undefined, 'Go ahead')).toBe('once')
    // "Something else", or just a message: no leave.
    expect(leaveChoice([{ other: 'faz amanhã' }], '')).toBeUndefined()
    expect(leaveChoice([{ chosen: [0], other: 'mas só o iFood' }], '')).toBeUndefined()
    expect(leaveChoice(undefined, 'pode fazer mas sem gastar nada')).toBeUndefined()
    expect(leaveChoice(undefined, '')).toBeUndefined()
    expect(leaveChoice([{ chosen: [0, 1] }], '')).toBeUndefined()
    expect(leaveChoice([{ skipped: true }], '')).toBeUndefined()
    // A pick sent with something written beside it: what they wrote may narrow or take it back, so nothing is allowed.
    expect(leaveChoice([{ chosen: [1] }], 'pensando melhor, só desta vez e sem o Linear')).toBeUndefined()
    expect(leaveChoice([{ chosen: [1] }], 'Pode fazer')).toBe('once') // unless what they wrote is one of the answers: then that one
  })

  it('a connector is only an admin\'s to give, and a kind is a kind in any alphabet', () => {
    const asks: LeaveAsk[] = [{ kind: 'triagem', what: 'x', web: true, grants: { 'c-lin': 'read' } }]
    expect(forRole(asks, true)).toBe(asks)
    expect(forRole(asks, false)).toEqual([{ kind: 'triagem', what: 'x', web: true }])
    expect(kindKey('调研价格')).toBe('调研价格')
    expect(kindKey('pesquisa 价格')).not.toBe(kindKey('pesquisa 天气'))
    expect(leaveFrom({ o_que: 'x', tipo: '调研价格', web: true }, { connectors: [], admin: true }).ask).toMatchObject({ kind: '调研价格' })
  })
})

describe("asking leave in the place of a colleague who did not finish", () => {
  beforeEach(() => setLang('pt'))
  const part: LeaveAsk = { kind: 'contas', what: 'Calcular a mediana de 3, 9 e 4.', instead: 'Theo' }

  it('only in the place of one whose part did not get done, by the name the notice gave', () => {
    const ctx = { connectors: [], admin: true, unfinished: ['Theo'] }
    expect(leaveFrom({ o_que: 'Calcular a mediana', tipo: 'contas', no_lugar_de: 'Theo' }, ctx).ask).toEqual({ kind: 'contas', what: 'Calcular a mediana', instead: 'Theo' })
    expect(leaveFrom({ o_que: 'Calcular a mediana', tipo: 'contas', no_lugar_de: ' @theo ' }, ctx).ask).toMatchObject({ instead: 'Theo' }) // as he may write it
    expect(leaveFrom({ o_que: 'Calcular a mediana', tipo: 'contas' }, ctx).ask).toEqual({ kind: 'contas', what: 'Calcular a mediana' }) // not said: the usual card
    // Someone who finished, or was never asked: team work is handed over, never taken.
    const no = leaveFrom({ o_que: 'Escrever o aviso', tipo: 'avisos', no_lugar_de: 'Nina' }, ctx)
    expect(no.ask).toBeUndefined()
    expect(no.error).toContain('Nina não deixou parte nenhuma sem terminar nesta conversa')
    expect(no.error).toContain('você passa com pedir')
    expect(leaveFrom({ o_que: 'x', tipo: 'y', no_lugar_de: 'Theo' }, { connectors: [], admin: true }).error).toContain('Theo não deixou parte nenhuma')
  })

  it('becomes a card with two answers: this once, or wait for them', () => {
    const d = leaveDecision({ ...part, web: true }, [])
    expect(d.kind).toBe('single')
    expect(d.question).toBe('Theo não terminou. Posso fazer eu mesmo desta vez? Calcular a mediana de 3, 9 e 4.')
    expect(d.options!.map((o) => o.label)).toEqual(['Pode fazer', 'Prefiro esperar'])
    expect(d.options![0]).toMatchObject({ recommended: true, description: 'Só desta vez. Vou usar: a web.' })
    expect(d.options![1]!.description).toBe('Fica com Theo: é só me pedir de novo quando estiver resolvido.')
    expect(leaveDecision({ ...part, what: 'x'.repeat(300) }, []).question.length).toBeLessThanOrEqual(200)
    setLang('en')
    const en = leaveDecision(part, [])
    expect(en.question).toBe('Theo did not finish. May I do it myself this once? Calcular a mediana de 3, 9 e 4.')
    expect(en.options!.map((o) => o.label)).toEqual(['Go ahead', "I'd rather wait"])
  })

  it('reads only its two answers: nothing there is for good, and no colleague is made', () => {
    expect(leaveChoice([{ chosen: [0] }], '', true)).toBe('once')
    expect(leaveChoice([{ chosen: [1] }], '', true)).toBe('wait')
    expect(leaveChoice([{ chosen: [2] }], '', true)).toBeUndefined()
    expect(leaveChoice(undefined, 'Prefiro esperar.', true)).toBe('wait')
    expect(leaveChoice(undefined, "I'd rather wait", true)).toBe('wait')
    expect(leaveChoice(undefined, 'Pode fazer', true)).toBe('once')
    expect(leaveChoice(undefined, 'Pode, e não precisa perguntar de novo pra esse tipo de coisa', true)).toBeUndefined()
    expect(leaveChoice(undefined, 'Prefiro um colega pra isso', true)).toBeUndefined()
    expect(leaveChoice(undefined, 'Prefiro esperar')).toBeUndefined() // not an answer of the usual card
    expect(leaveChoice([{ chosen: [1], other: 'mas me avisa' }], '', true)).toBeUndefined()
  })

  it('what was given there is no kind of thing he may do himself afterwards', () => {
    const given = newLeave({ ...part, web: true }, 'p1', 'once', 'c1', 5)
    expect(given).toMatchObject({ conversationId: 'c1', kind: 'contas', web: true, instead: 'Theo', uses: 1 })
    // It still gives him, in that conversation, what he asked to use.
    expect(withLeaves(tucaAgent('sonnet', []), leavesFor([given], 'c1'))).toMatchObject({ web: true })
    // But the next time is asked again, it counts toward no suggestion, and his list of kinds doesn't have it.
    expect(covering([given], { kind: 'contas', what: 'x' })).toBeUndefined()
    expect(covering([given], { kind: 'contas', what: 'x', instead: 'Theo' })).toBeUndefined()
    expect(timesDone([{ ...given, uses: 5 }], 'contas')).toBe(0)
    expect(shouldSuggest([{ ...given, uses: 5 }], 'contas')).toBe(false)
    expect(leaveSection([given], { me: 'Edu', conversationId: 'c1', connectors: [] })).toContain('Nada ainda.')
    // A kind the person allowed for good holds in a colleague's place too.
    const standing = leave({ kind: 'contas', web: undefined })
    expect(covering([given, standing], { kind: 'contas', what: 'x', instead: 'Theo' })).toBe(standing)
  })

  it('tells him what the person answered', () => {
    expect(leaveTask(part, 'once', { me: 'Edu', connectors: [] })).toBe('Edu deixou você fazer isto você mesmo, desta vez, no lugar de Theo: "Calcular a mediana de 3, 9 e 4.". Você já tem o que pediu pra usar (nada além de escrever). Faça agora e entregue o resultado, sem perguntar de novo.')
    const wait = leaveTask(part, 'wait', { me: 'Edu', connectors: [] })
    expect(wait).toContain('Edu prefere esperar Theo. Não faça essa parte.')
    expect(wait).toContain('é só pedir de novo quando estiver resolvido')
    setLang('en')
    expect(leaveTask(part, 'once', { me: 'Edu', connectors: [] })).toContain("Edu let you do this yourself, this once, in Theo's place")
    expect(leaveTask(part, 'wait', { me: 'Edu', connectors: [] })).toContain('Edu would rather wait for Theo. Do not do that part.')
  })
})

describe('what a leave holds for', () => {
  beforeEach(() => setLang('pt'))

  it('this once is the conversation; for good is everywhere, for that kind of thing', () => {
    const once = newLeave(ask, 'p1', 'once', 'c1', 5)
    const always = newLeave(ask, 'p1', 'always', 'c1', 6)
    expect(once).toMatchObject({ person: 'p1', conversationId: 'c1', kind: 'pesquisa de preços', web: true, uses: 1, at: 5 })
    expect(always.conversationId).toBeUndefined()
    expect(leavesFor([once, always], 'c1')).toHaveLength(2)
    expect(leavesFor([once, always], 'c2')).toEqual([always])
  })

  it('covers the same kind of thing using nothing more than was allowed', () => {
    expect(kindKey(' Pesquisa de Preços! ')).toBe('pesquisa de precos')
    const web = leave()
    expect(covering([web], { kind: 'Pesquisa de precos', what: 'x', web: true })).toBe(web)
    expect(covering([web], { kind: 'pesquisa de preços', what: 'x' })).toBe(web) // less than allowed
    expect(covering([web], { kind: 'resumo de site', what: 'x', web: true })).toBeUndefined() // another kind
    expect(covering([web], { kind: 'pesquisa de preços', what: 'x', web: true, grants: { 'c-lin': 'read' } })).toBeUndefined() // more than allowed
    const reads = leave({ id: 'l2', web: undefined, grants: { 'c-lin': 'read' } })
    expect(covering([reads], { kind: 'pesquisa de preços', what: 'x', grants: { 'c-lin': 'read' } })).toBe(reads)
    expect(covering([reads], { kind: 'pesquisa de preços', what: 'x', grants: { 'c-lin': 'read_write' } })).toBeUndefined()
    // For good comes before this conversation's.
    const here = leave({ id: 'l3', conversationId: 'c1' })
    expect(covering([here, web], { kind: 'pesquisa de preços', what: 'x', web: true })).toBe(web)
  })

  it('gives him the web and the connectors for the reply, and never less than he had', () => {
    const tuca = tucaAgent('sonnet', [])
    expect(withLeaves(tuca, [])).toBe(tuca)
    expect(withLeaves(tuca, [leave()])).toMatchObject({ web: true, grants: {} })
    expect(withLeaves(tuca, [leave({ web: undefined, grants: { 'c-lin': 'read' } })])).toMatchObject({ web: false, grants: { 'c-lin': 'read' } })
    expect(withLeaves(tuca, [leave({ grants: { 'c-lin': 'read_write' } }), leave({ id: 'l2', grants: { 'c-lin': 'read' } })]).grants).toEqual({ 'c-lin': 'read_write' })
    expect(tuca).toMatchObject({ web: false, grants: {} }) // he himself is as he was
  })

  it(`a kind of thing that came ${SUGGEST_AT} times is worth a colleague, said once`, () => {
    const two = [leave({ uses: 1 }), leave({ id: 'l2', conversationId: 'c1', uses: 1 })]
    expect(timesDone(two, 'Pesquisa de precos')).toBe(2)
    expect(shouldSuggest(two, 'pesquisa de preços')).toBe(false)
    const three = [leave({ uses: 2 }), leave({ id: 'l2', conversationId: 'c1', uses: 1 })]
    expect(shouldSuggest(three, 'pesquisa de preços')).toBe(true)
    expect(shouldSuggest([...three, leave({ id: 'l3', suggested: true })], 'pesquisa de preços')).toBe(false)
    expect(shouldSuggest([leave({ kind: 'outra coisa', uses: 9 })], 'pesquisa de preços')).toBe(false)
  })

  it('tells him what the person answered, and what he sees of his leaves', () => {
    expect(leaveTask(ask, 'once', { me: 'Edu', connectors: [] })).toBe('Edu deixou você fazer isto você mesmo, desta vez: "Pesquisar o preço dos concorrentes.". Você já tem o que pediu pra usar (a web). Faça agora e entregue o resultado, sem perguntar de novo.')
    expect(leaveTask(ask, 'always', { me: 'Edu', connectors: [] })).toContain('não precisa perguntar de novo pra esse tipo de coisa (pesquisa de preços)')
    expect(leaveTask(ask, 'colleague', { me: 'Edu', connectors: [] })).toContain('Edu prefere um colega pra isso. Proponha um com propor_agente')
    expect(leaveTask(ask, 'once', { me: 'Edu', connectors: [], suggest: 3 })).toContain('É a 3ª vez que Edu pede esse tipo de coisa (pesquisa de preços)')
    expect(leaveTask(ask, 'once', { me: 'Edu', connectors: [], suggest: 3 })).toContain('"Montar um colega pra pesquisa de preços"')
    const none = leaveSection([], { me: 'Edu', conversationId: 'c1', connectors: [] })
    expect(none).toContain('## O que você pode fazer você mesmo\nNada ainda.')
    const some = leaveSection([leave({ uses: 2 }), leave({ id: 'l2', kind: 'triagem', conversationId: 'c1', web: undefined, grants: { 'c-lin': 'read' } })], { me: 'Edu', conversationId: 'c1', connectors: [linear] })
    expect(some).toContain('- pesquisa de preços · usando: a web · feito 2 vezes')
    expect(some).toContain('Só nesta conversa:\n- triagem · usando: Linear (leitura)')
    setLang('en')
    expect(leaveSection([], { me: 'Edu', conversationId: 'c1', connectors: [] })).toContain('## What you may do yourself\nNothing yet.')
    expect(leaveTask(ask, 'once', { me: 'Edu', connectors: [] })).toContain('Edu let you do this yourself, this once')
  })
})

describe('the leave, in his conversations', () => {
  const ready = { installed: true, loggedIn: true }
  let db: Db
  let settings: Settings
  let gateway: Gateway
  let turns: (Turn & { tools: string[] })[]
  let events: CoreEvent[]
  let called: string[] // what a tool answered when a message said "chame <tool> [id]"
  let slow = 0 // how long reading the settings takes (the app's start, while the harnesses are checked)
  let tuca: Agent
  let r: Runner
  const person = (id: string, name: string): Person => ({ id, name, role: 'member', about: '' }) as Person

  const listed = async (url: string | undefined): Promise<string[]> => {
    if (!url) return []
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    try {
      return (await client.listTools()).tools.map((t) => t.name)
    } finally {
      await client.close()
    }
  }
  const by = (conversationId: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === tuca.id && m.conversationId === conversationId)
  const asked = (conversationId: string): Message => by(conversationId).findLast((m) => !!m.run?.leave)!
  const pick = async (conversationId: string, option: number, person = db.owner()): Promise<void> => {
    r.answerDecision(asked(conversationId).id, 0, { chosen: [option] }, person)
    await r.submitDecisions(asked(conversationId).id, person)
    await r.idle()
  }

  beforeEach(async () => {
    setLang('pt')
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
    turns = []
    events = []
    called = []
    slow = 0
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
    tuca = tucaAgent('sonnet', [])
    db.saveAgent(tuca)
    db.createConversation({ id: 'c1', kind: 'dm', name: tuca.id, members: [tuca.id] })
    db.createConversation({ id: 'c2', kind: 'dm', name: tuca.id, members: [tuca.id] })
    db.saveConnector(linear)
    db.syncTools(linear.id, [{ name: 'list_issues', description: 'Lists issues', inputSchema: { type: 'object', properties: {} }, cls: 'read' }])
    gateway = new Gateway()
    await gateway.start()
    const fake = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      run: async function* (t) {
        const tools = await listed(t.mcpUrl)
        turns.push({ ...t, tools })
        // "chame list_issues" / "chame cancelar_pedido 7a51430a": the call is made for real, and what came back is kept.
        const ask = /chame ([\w-]+)(?: ([0-9a-f]{6,}))?\s*$/.exec(t.prompt.trim().split('\n').at(-1) ?? '')
        const name = ask && tools.find((x) => x === ask[1] || x.endsWith(`__${ask[1]}`) || x.includes(ask[1]!))
        if (ask && t.mcpUrl) {
          const client = new Client({ name: 'test', version: '0.0.0' })
          await client.connect(new StreamableHTTPClientTransport(new URL(t.mcpUrl)))
          const r = (await client.callTool({ name: name ?? ask[1]!, arguments: ask[2] ? { id: ask[2] } : {} })) as { content?: { text?: string }[] }
          called.push(r.content?.map((c) => c.text ?? '').join('') ?? '')
          await client.close()
          yield { type: 'done', text: 'ok', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
          return
        }
        // "quebre de vez": Theo's reply fails on something that doesn't pass by itself.
        if (t.system.includes('Você é Theo') && /quebre de vez/.test(t.prompt)) {
          yield { type: 'error', message: 'O Codex não está logado' }
          return
        }
        yield* fake.run(t)
      }
    }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }
    r = new Runner({ db, engines, settings: async () => (slow && (await new Promise((done) => setTimeout(done, slow))), settings), emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway, connectors: { list: () => [linear], call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) } })
    return () => gateway.stop()
  })

  it('asks on a card, and with "Pode fazer" works with the web in that conversation only', async () => {
    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    // He had no web and no connector, was told so, and has the tool to ask.
    expect(turns[0]!.web).toBe(false)
    expect(turns[0]!.tools).toContain('fazer_eu_mesmo')
    expect(turns[0]!.tools).not.toContain('pedir_acesso')
    expect(turns[0]!.tools.some((t) => t.includes('list_issues'))).toBe(false)
    expect(`${turns[0]!.system}\n${turns[0]!.prompt}`).toContain('## O que você pode fazer você mesmo\nNada ainda.')
    // The card: a question like any other, waiting on the person, in their inbox.
    const card = asked('c1')
    expect(card.run).toMatchObject({ status: 'waiting_input', leave: { kind: 'pesquisa de preços', what: 'Pesquisar o preço dos concorrentes.', web: true } })
    expect(questionsOf(card.run)[0]!.options!.map((o) => o.label)).toEqual(['Pode fazer', 'Pode, e não precisa perguntar de novo pra esse tipo de coisa', 'Prefiro um colega pra isso'])
    expect(card.run!.steps.map((x) => x.label)).toContain('Pediu licença pra fazer ele mesmo')
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0) // nothing is allowed by asking

    await pick('c1', 0)
    const leaves = db.tucaLeaves(db.ownerId())
    expect(leaves).toHaveLength(1)
    expect(leaves[0]).toMatchObject({ conversationId: 'c1', kind: 'pesquisa de preços', web: true, uses: 1 })
    expect(db.message(card.id)!.run).toMatchObject({ status: 'done', leave: { state: 'once' } })
    expect(events.some((e) => e.type === 'leaves')).toBe(true)
    // His next reply there: with the web, and told to do it.
    const next = turns.at(-1)!
    expect(next.web).toBe(true)
    expect(next.prompt).toContain('Edu deixou você fazer isto você mesmo, desta vez: "Pesquisar o preço dos concorrentes."')
    expect(by('c1').at(-1)!.text).toBe('Pronto, fiz eu mesmo: Pesquisar o preço dos concorrentes.')
    expect(db.agent(tuca.id)).toMatchObject({ web: false, grants: {} }) // nothing was saved on him

    // Another conversation of the same person: that leave doesn't hold there.
    await r.send('c2', 'oi')
    await r.idle()
    expect(turns.at(-1)!.web).toBe(false)
  })

  it('"não precisa perguntar de novo" holds everywhere for that kind of thing, and passes straight through', async () => {
    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    await pick('c1', 1)
    expect(db.tucaLeaves(db.ownerId())).toMatchObject([{ kind: 'pesquisa de preços', web: true, uses: 1 }])
    expect(db.tucaLeaves(db.ownerId())[0]!.conversationId).toBeUndefined()
    expect(db.message(asked('c1').id)!.run!.leave!.state).toBe('always')

    // In another conversation: he has the web, is told what was allowed, and the same kind of thing asks nothing.
    await r.send('c2', 'faça você (Pesquisa de Precos, web): Pesquisar o preço do pão.')
    await r.idle()
    const there = turns.at(-1)!
    expect(there.web).toBe(true)
    expect(`${there.system}\n${there.prompt}`).toContain('- pesquisa de preços · usando: a web')
    expect(by('c2').at(-1)!.run).toMatchObject({ status: 'done' })
    expect(by('c2').at(-1)!.run!.leave).toBeUndefined() // no card
    expect(by('c2').at(-1)!.text).toBe('Pronto, fiz eu mesmo: Pesquisar o preço do pão.')
    expect(db.tucaLeaves(db.ownerId())[0]).toMatchObject({ uses: 2 })
    expect(db.tucaLeaves(db.ownerId())[0]!.suggested).toBeUndefined()

    // The third time: he is told to suggest a colleague, once.
    await r.send('c2', 'faça você (pesquisa de preços, web): Pesquisar o preço da carne.')
    await r.idle()
    expect(db.tucaLeaves(db.ownerId())[0]).toMatchObject({ uses: 3, suggested: true })
    const third = by('c2').at(-1)!
    expect(third.run!.steps.map((x) => x.label)).toContain('Propôs os próximos passos')
    expect(questionsOf(third.run)[0]!.options![0]!.label).toBe('Montar um colega pra pesquisa de preços')
    await r.send('c2', 'faça você (pesquisa de preços, web): Pesquisar o preço do queijo.')
    await r.idle()
    expect(db.tucaLeaves(db.ownerId())[0]).toMatchObject({ uses: 4 })
    expect(by('c2').at(-1)!.run!.steps.map((x) => x.label)).not.toContain('Propôs os próximos passos')

    // Another kind of thing still asks.
    await r.send('c2', 'faça você (resumo de site, web): Resumir o site do fornecedor.')
    await r.idle()
    expect(by('c2').at(-1)!.run).toMatchObject({ status: 'waiting_input', leave: { kind: 'resumo de site' } })
  })

  it('"Prefiro um colega" allows nothing: he proposes one', async () => {
    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    await pick('c1', 2)
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    expect(db.message(asked('c1').id)!.run!.leave!.state).toBe('colleague')
    const next = turns.at(-1)!
    expect(next.web).toBe(false)
    expect(next.prompt).toContain('Edu prefere um colega pra isso. Proponha um com propor_agente')
    expect(by('c1').at(-1)!.run!.agentDraft).toMatchObject({ name: 'Caio' })
  })

  it('written in the field instead of picked: its words allow it, anything else is just a message', async () => {
    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    await r.send('c1', 'hoje não, deixa pra depois')
    await r.idle()
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    expect(db.message(asked('c1').id)!.run!.leave!.state).toBeUndefined()
    expect(turns.at(-1)!.web).toBe(false)

    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    await r.send('c1', 'Pode fazer')
    await r.idle()
    expect(db.tucaLeaves(db.ownerId())).toMatchObject([{ conversationId: 'c1', web: true }])
    expect(turns.at(-1)!.web).toBe(true)
  })

  it('a connector comes with the leave, for that person and no one else', async () => {
    await r.send('c1', 'faça você (triagem, +Linear): Ver as issues abertas.')
    await r.idle()
    expect(asked('c1').run!.leave).toMatchObject({ kind: 'triagem', grants: { 'c-lin': 'read' } })
    expect(questionsOf(asked('c1').run)[0]!.options![0]!.description).toBe('Só desta vez. Vou usar: Linear (leitura).')
    await pick('c1', 1)
    const mine = turns.at(-1)!
    expect(mine.tools.some((t) => t.includes('list_issues'))).toBe(true)
    expect(mine.web).toBe(false)

    // Someone else's Tuca has none of it.
    const ana = person('ana', 'Ana')
    db.addPerson(ana)
    db.createConversation({ id: 'c-ana', kind: 'dm', name: tuca.id, members: [tuca.id], owner: ana.id })
    await r.send('c-ana', 'oi', [], undefined, ana.id)
    await r.idle()
    const hers = turns.at(-1)!
    expect(hers.tools.some((t) => t.includes('list_issues'))).toBe(false)
    expect(`${hers.system}\n${hers.prompt}`).toContain('## O que você pode fazer você mesmo\nNada ainda.')

    // And a member can't give him a connector: he is told, and no card is made.
    await r.send('c-ana', 'faça você (triagem, +Linear): Ver as issues abertas.', [], undefined, ana.id)
    await r.idle()
    expect(by('c-ana').at(-1)!.run!.leave).toBeUndefined()
    expect(by('c-ana').at(-1)!.text).toContain('só um admin libera um conector')
    // The web she may give, and it is hers alone.
    await r.send('c-ana', 'faça você (pesquisa, web): Pesquisar o horário do banco.', [], undefined, ana.id)
    await r.idle()
    await pick('c-ana', 1, db.person(ana.id)!)
    expect(db.tucaLeaves(ana.id)).toMatchObject([{ person: ana.id, kind: 'pesquisa', web: true }])
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(1) // the owner's own, untouched
    expect(new People(db).eventFor({ type: 'leaves' }, db.person(ana.id)!)).toMatchObject({ type: 'leaves', leaves: [{ kind: 'pesquisa' }] })
    expect(new People(db).eventFor({ type: 'leaves' }, db.owner())).toMatchObject({ type: 'leaves', leaves: [{ kind: 'triagem' }] })
  })

  it('what a leave gives is really his to use, call by call, and stops the moment it is taken back', async () => {
    await r.send('c1', 'faça você (triagem, +Linear): Ver as issues abertas.')
    await r.idle()
    await pick('c1', 1)
    await r.send('c1', 'chame list_issues')
    await r.idle()
    expect(called.at(-1)).toBe('ok') // the connector answered: listed, and allowed when called
    // Taken back: gone from his next reply.
    expect(db.removeTucaLeave(db.tucaLeaves(db.ownerId())[0]!.id, db.ownerId())).toBe(true)
    await r.send('c1', 'chame list_issues')
    await r.idle()
    expect(turns.at(-1)!.tools.some((t) => t.includes('list_issues'))).toBe(false)
    expect(called.at(-1)).toMatch(/Ferramenta (?:desconhecida|não permitida)|Unknown tool|not allowed/) // refused: it is no longer his
  })

  it('a connector holds only while its person may give one: an admin demoted loses it, the web stays', async () => {
    const ana = { ...person('ana', 'Ana'), role: 'admin' } as Person
    db.addPerson(ana)
    db.createConversation({ id: 'c-ana', kind: 'dm', name: tuca.id, members: [tuca.id], owner: ana.id })
    await r.send('c-ana', 'faça você (triagem, web, +Linear): Ver as issues abertas.', [], undefined, ana.id)
    await r.idle()
    await pick('c-ana', 1, db.person(ana.id)!)
    expect(db.tucaLeaves(ana.id)[0]).toMatchObject({ web: true, grants: { 'c-lin': 'read' } })
    await r.send('c-ana', 'oi', [], undefined, ana.id)
    await r.idle()
    expect(turns.at(-1)!.tools.some((t) => t.includes('list_issues'))).toBe(true)
    db.setRole(ana.id, 'member')
    await r.send('c-ana', 'oi de novo', [], undefined, ana.id)
    await r.idle()
    expect(turns.at(-1)!.tools.some((t) => t.includes('list_issues'))).toBe(false)
    expect(turns.at(-1)!.web).toBe(true)
    // And a card asked while she was an admin, answered after: the connector doesn't come with it.
    db.setRole(ana.id, 'admin')
    await r.send('c-ana', 'faça você (relatório, +Linear): Contar as issues.', [], undefined, ana.id)
    await r.idle()
    db.setRole(ana.id, 'member')
    await pick('c-ana', 0, db.person(ana.id)!)
    const report = db.tucaLeaves(ana.id).find((l) => l.kind === 'relatório')!
    expect(report.grants).toBeUndefined()
  })

  it('a pick sent with something written beside it allows nothing', async () => {
    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    r.answerDecision(asked('c1').id, 0, { chosen: [1] }, db.owner())
    await r.send('c1', 'pensando melhor, só desta vez e sem web')
    await r.idle()
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    expect(turns.at(-1)!.web).toBe(false)
  })

  it('a card sent twice is answered once, even while the app is still starting', async () => {
    await r.send('c1', 'faça você (pesquisa de preços, web): Pesquisar o preço dos concorrentes.')
    await r.idle()
    const card = asked('c1').id
    r.answerDecision(card, 0, { chosen: [1] }, db.owner())
    slow = 40
    await Promise.allSettled([r.submitDecisions(card, db.owner()), r.submitDecisions(card, db.owner())])
    slow = 0
    await r.idle()
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(1)
    expect(db.messages().filter((m) => m.conversationId === 'c1' && m.author.kind === 'person')).toHaveLength(2) // the request and one answer
  })

  it('a copy of the workspace carries no leave and no conversation title from where it came', () => {
    db.saveTucaLeave(leave({ id: 'mine', person: db.ownerId() }))
    db.setConversationTitle('c1', 'Demitir o Carlos do financeiro')
    const file = join(mkdtempSync(join(tmpdir(), 'ad-copy-')), 'copy.db')
    db.duplicateTo(file, 'Copy')
    const copy = new Db(file)
    expect(copy.tucaLeaves(copy.ownerId())).toHaveLength(0)
    expect(copy.conversations().map((c) => c.title)).toEqual([undefined, undefined])
    copy.close()
  })

  it('is taken back by its own person, and goes with its conversation and with the person', () => {
    const ana = person('ana', 'Ana')
    db.addPerson(ana)
    db.saveTucaLeave(leave({ id: 'mine', person: db.ownerId() }))
    db.saveTucaLeave(leave({ id: 'here', person: db.ownerId(), conversationId: 'c2' }))
    db.saveTucaLeave(leave({ id: 'hers', person: ana.id }))
    expect(db.removeTucaLeave('hers', db.ownerId())).toBe(false) // not theirs to take back
    expect(db.removeTucaLeave('mine', db.ownerId())).toBe(true)
    expect(db.tucaLeaves(db.ownerId()).map((l) => l.id)).toEqual(['here'])
    db.deleteConversation('c2')
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    db.removePerson(ana.id)
    expect(db.tucaLeaves(ana.id)).toHaveLength(0)
  })

  it("a colleague's part that did not get done is not his to take: he says why and asks, right then, whether to do it this once", async () => {
    db.saveAgent({ ...tucaAgent('sonnet', ['tuca']), id: 'theo', name: 'Theo', handle: 'theo', role: 'Dados', instructions: 'Você é Theo. Cuida dos números.', kind: undefined })
    await r.send('c1', 'delegue a @theo: quebre de vez; se não sair, faça você (contas): Calcular a mediana de 3, 9 e 4')
    await r.idle()
    // Theo's reply failed, and what he is told of it: why, and that the part is not his to do on his own.
    const told = turns.findLast((t) => t.prompt.includes('Voltou do que você pediu ao seu time'))!
    expect(told.prompt).toMatch(/Theo, DM: não terminou \(/)
    expect(told.prompt).toContain('Não faça você a parte de Theo por conta própria, nem que seja simples.')
    expect(told.prompt).toContain('pergunte nesta mesma resposta com fazer_eu_mesmo, com no_lugar_de "Theo"')
    expect(told.prompt).toContain('Edu escolhe num card entre você fazer desta vez e esperar Theo')
    expect(told.prompt).not.toContain('Decida você o caminho')
    expect(told.tools).toContain('fazer_eu_mesmo')
    // So he asks in that same reply, where the request was made: a card of its own, with two answers.
    const card = asked('c1')
    expect(card.text).toBe('Theo não terminou: deu erro.')
    expect(card.run).toMatchObject({ status: 'waiting_input', leave: { kind: 'contas', what: 'Calcular a mediana de 3, 9 e 4', instead: 'Theo' } })
    expect(card.run!.questions).toMatchObject([{ question: 'Theo não terminou. Posso fazer eu mesmo desta vez? Calcular a mediana de 3, 9 e 4', options: [{ label: 'Pode fazer', recommended: true }, { label: 'Prefiro esperar' }] }])
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    // With "Pode fazer", he does it: this once, and it makes that no kind of thing he does himself.
    await pick('c1', 0)
    expect(asked('c1').run!.leave).toMatchObject({ state: 'once' })
    expect(db.tucaLeaves(db.ownerId())).toMatchObject([{ conversationId: 'c1', kind: 'contas', instead: 'Theo', uses: 1 }])
    expect(turns.at(-1)!.prompt).toContain('Edu deixou você fazer isto você mesmo, desta vez, no lugar de Theo: "Calcular a mediana de 3, 9 e 4"')
    expect(turns.at(-1)!.prompt).not.toContain('- contas · usando')
    expect(by('c1').at(-1)!.text).toBe('Pronto, fiz eu mesmo: Calcular a mediana de 3, 9 e 4')
  })

  it('or the person waits for the colleague: nothing is allowed, and the part stays theirs', async () => {
    db.saveAgent({ ...tucaAgent('sonnet', ['tuca']), id: 'theo', name: 'Theo', handle: 'theo', role: 'Dados', instructions: 'Você é Theo. Cuida dos números.', kind: undefined })
    await r.send('c1', 'delegue a @theo: quebre de vez; se não sair, faça você (contas): Calcular a mediana de 3, 9 e 4')
    await r.idle()
    await pick('c1', 1)
    expect(asked('c1').run!.leave).toMatchObject({ state: 'wait' })
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    expect(turns.at(-1)!.prompt).toContain('Edu prefere esperar Theo. Não faça essa parte.')
    expect(by('c1').at(-1)!.text).toBe('Combinado, fica com Theo. É só me pedir de novo quando estiver resolvido.')
  })

  it("in a colleague's place only when that colleague did not finish: any other team work is handed over", async () => {
    db.saveAgent({ ...tucaAgent('sonnet', ['tuca']), id: 'theo', name: 'Theo', handle: 'theo', role: 'Dados', instructions: 'Você é Theo. Cuida dos números.', kind: undefined })
    await r.send('c1', 'delegue a @theo: calcule a mediana de 3, 9 e 4')
    await r.idle()
    // Theo finished. Asked to take Theo's place, the tool refuses: no card, nothing allowed.
    await r.send('c1', 'faça você (contas, no lugar de Theo): Calcular a mediana de 3, 9 e 4')
    await r.idle()
    expect(by('c1').at(-1)!.text).toContain('Theo não deixou parte nenhuma sem terminar nesta conversa')
    expect(by('c1').some((m) => !!m.run?.leave)).toBe(false)
    expect(db.tucaLeaves(db.ownerId())).toHaveLength(0)
    // Once a part of Theo's does not get done there, it holds, even asked in a later message.
    await r.send('c1', 'delegue a @theo: quebre de vez')
    await r.idle()
    await r.send('c1', 'faça você (contas, no lugar de Theo): Calcular a mediana de 3, 9 e 4')
    await r.idle()
    expect(asked('c1').run).toMatchObject({ status: 'waiting_input', leave: { kind: 'contas', instead: 'Theo' } })
  })

  it('any other agent has no such tool', async () => {
    db.saveAgent({ ...tucaAgent('sonnet', ['tuca']), id: 'lia', name: 'Lia', handle: 'lia', kind: undefined })
    db.createConversation({ id: 'd-lia', kind: 'dm', name: 'lia', members: ['lia'] })
    await r.send('d-lia', 'oi')
    await r.idle()
    expect(turns.at(-1)!.tools).not.toContain('fazer_eu_mesmo')
    expect(turns.at(-1)!.tools).toContain('pedir_acesso')
  })
})
