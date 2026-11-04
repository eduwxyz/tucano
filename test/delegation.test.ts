import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { requestRunning, type Agent, type EngineId, type Message, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

let db: Db
let gateway: Gateway
let turns: Turn[]
let notes: { title: string; kind?: string }[]
let settings: Settings

function runner(): Runner {
  turns = []
  const fake = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), fake.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'dl-work-')), gateway, notify: (title, _body, _conv, kind) => notes.push({ title, kind }) })
}

const by = (m: Message): string => (m.author as { id: string }).id
// What the agents wrote in a conversation, oldest first.
const said = (conversationId: string): Message[] => db.messages().filter((m) => m.conversationId === conversationId && m.author.kind === 'agent')
// The DM between two agents, once one asked the other for something.
const pair = (a: string, b: string): string => db.conversations().find((c) => c.kind === 'agents' && c.members.includes(a) && c.members.includes(b))!.id
const turnsOf = (id: string): Turn[] => turns.filter((t) => t.system.startsWith(`Você é ${id} (@${id})`))

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'dl-db-')), 'test.db'))
  notes = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('chefe', { role: 'Manager', team: ['dev', 'ana'] }))
  db.saveAgent(agent('dev', { role: 'Engenharia' }))
  db.saveAgent(agent('ana', { role: 'Dados' }))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'chefe', members: ['chefe'] })
  gateway = new Gateway()
  await gateway.start()
  return () => gateway.stop()
})

describe('delegation', () => {
  it('keeps the team on the agent', () => {
    expect(db.agent('chefe')!.team).toEqual(['dev', 'ana'])
    db.saveAgent({ ...db.agent('dev')!, team: ['dev', 'ana'] }) // never itself
    expect(db.agent('dev')!.team).toEqual(['ana'])
  })

  it('keeps a DM between two agents apart from channels and DMs', () => {
    db.createConversation({ id: 'p', kind: 'agents', name: 'dev-ana', members: ['dev', 'ana'] })
    expect(db.conversation('p')).toMatchObject({ kind: 'agents', members: ['dev', 'ana'] })
    db.setAgentChannels('dev', []) // saving an agent's channels doesn't take it out of its DMs with agents
    expect(db.conversation('p')!.members).toEqual(['dev', 'ana'])
  })

  it('hands tasks out in a DM between the agents, and brings the results back to the manager once', async () => {
    const r = runner()
    await r.send('dm', 'algo de antes, só entre nós')
    await r.idle()
    await r.send('dm', 'delegue a @dev: escrever o post; delegue a @ana: revisar os números')
    await r.idle()

    // The person's DM stays theirs: only the manager writes in it.
    const mine = said('dm')
    expect(mine.map(by)).toEqual(['chefe', 'chefe', 'chefe'])
    const [, head, back] = mine
    const withDev = pair('chefe', 'dev')
    expect(head!.run).toMatchObject({ status: 'done', delegated: [{ agentId: 'dev', task: 'escrever o post', conversationId: withDev }, { agentId: 'ana', task: 'revisar os números', conversationId: pair('chefe', 'ana') }] })
    expect(head!.run!.steps.map((s) => s.label)).toContain('Delegou a dev')

    // In their DM, the manager asks in its own words and the delegate answers there.
    const there = said(withDev)
    expect(there.map(by)).toEqual(['chefe', 'dev'])
    expect(there[0]!.text).toBe('escrever o post')
    expect(there[1]!.text).toBe('Feito: escrever o post')
    expect(there[1]!.run).toMatchObject({ status: 'done', delegation: { by: 'chefe', from: head!.id, task: 'escrever o post', chain: ['chefe'], reported: true } })

    // The delegate never sees the person's DM.
    expect(turnsOf('dev')[0]!.prompt).not.toContain('só entre nós')
    expect(turnsOf('dev')[0]!.prompt).toContain('<tarefa>\nescrever o post\n</tarefa>')
    expect(turnsOf('dev')[0]!.system).toContain('num pedido que chefe (@chefe) te passou')
    expect(turnsOf('chefe')[0]!.system).toContain('## Sua equipe')
    expect(turnsOf('dev')[0]!.system).not.toContain('Você coordena estes agentes')

    // Back to the manager, in the person's DM, with what each one wrote.
    expect(back!.run).toMatchObject({ status: 'done', round: 1 })
    const resumed = turnsOf('chefe').at(-1)!
    expect(resumed.prompt).toContain('Voltou o que você delegou')
    expect(resumed.prompt).toContain('dev (@dev) terminou')
    expect(resumed.prompt).toContain('<resposta>\nFeito: revisar os números\n</resposta>')
    // A report back: told to say who did what, what was decided and applied, and what's left.
    expect(resumed.prompt).toContain('dê a Edu o retorno do trabalho')
    expect(resumed.prompt).toContain('O que foi aplicado de fato e onde')
    expect(back!.run?.reportOf).toBe(head!.id)
    expect(back!.text).toContain('**Quem fez o quê**')
    expect(back!.text).toContain('- **dev** · escrever o post: Feito: escrever o post')
    expect(turnsOf('chefe')).toHaveLength(3)
    expect(notes.filter((n) => n.kind === 'done').map((n) => n.title)).toEqual(['chefe terminou', 'chefe terminou'])
  })

  it('opens one DM between the agents per request: a new request starts clean, and the old one can be deleted', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: escrever o post')
    await r.idle()
    const [head] = said('dm')
    const first = pair('chefe', 'dev')
    expect(db.conversation(first)).toMatchObject({ kind: 'agents', topic: 'escrever o post', request: head!.id })

    await r.send('dm', 'delegue a @dev: corrigir o bug')
    await r.idle()
    const pairs = db.conversations().filter((c) => c.kind === 'agents')
    expect(pairs).toHaveLength(2)
    const second = pairs.find((c) => c.id !== first)!
    expect(second.topic).toBe('corrigir o bug')
    expect(said(second.id).map((m) => m.text)).toEqual(['corrigir o bug', 'Feito: corrigir o bug'])
    // The second task never reads the first one's work.
    expect(turnsOf('dev')[1]!.prompt).toContain('corrigir o bug')
    expect(turnsOf('dev')[1]!.prompt).not.toContain('escrever o post')

    // Both requests are over: either DM can go, and the lead's report stays in the person's DM.
    expect(requestRunning(db.conversation(first)!, db.messages())).toBe(false)
    db.deleteConversation(first)
    expect(db.conversation(first)).toBeUndefined()
    expect(said('dm').filter((m) => m.run?.reportOf)).toHaveLength(2)
  })

  it('a DM between agents can’t be deleted while its request is still going, anywhere it reached', () => {
    const conv = { id: 'p', kind: 'agents' as const, name: 'chefe-dev', members: ['chefe', 'dev'], request: 'pedido' }
    const msg = (extra: Partial<Message>): Message => ({ id: 'm', conversationId: 'outra', author: { kind: 'agent', id: 'ana' }, text: '', at: 1, ...extra })
    expect(requestRunning(conv, [])).toBe(false)
    expect(requestRunning(conv, [msg({ conversationId: 'p', run: { status: 'waiting_input', steps: [] } })])).toBe(true)
    // Another agent of the same request, in another DM, still working: the lead still needs this one.
    expect(requestRunning(conv, [msg({ run: { status: 'working', steps: [], root: 'pedido' } })])).toBe(true)
    // The lead's own message that started it, waiting on an approval.
    expect(requestRunning(conv, [msg({ id: 'pedido', run: { status: 'waiting_approval', steps: [] } })])).toBe(true)
    // Another request, or this one done: nothing holds it.
    expect(requestRunning(conv, [msg({ run: { status: 'working', steps: [], root: 'outro' } }), msg({ conversationId: 'p', run: { status: 'done', steps: [] } })])).toBe(false)
  })

  it('in a channel, the team works in the open, there', async () => {
    db.createConversation({ id: 'c', kind: 'channel', name: 'geral', members: ['chefe'] })
    const r = runner()
    await r.send('c', 'delegue a @dev: escrever o post')
    await r.idle()
    expect(said('c').map(by)).toEqual(['chefe', 'dev', 'chefe'])
    expect(db.conversations().some((c) => c.kind === 'agents')).toBe(false)
  })

  it('refuses an agent that is archived, and nothing goes out', async () => {
    db.saveAgent(agent('ana', { archived: true }))
    const r = runner()
    await r.send('dm', 'delegue a @ana: revisar os números')
    await r.idle()
    expect(said('dm').map(by)).toEqual(['chefe'])
    expect(said('dm')[0]!.text).toContain('Não dá pra delegar a')
    expect(said('dm')[0]!.run?.delegated).toBeUndefined()
  })

  it('a delegate asks in its DM with the manager, gets the answer there, and the manager waits for it', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: pergunte o prazo')
    await r.idle()
    const withDev = pair('chefe', 'dev')
    expect(said(withDev)[1]!.run).toMatchObject({ status: 'waiting_input', delegation: { task: 'pergunte o prazo' } })
    expect(said('dm').map(by)).toEqual(['chefe'])
    expect(notes.at(-1)).toMatchObject({ title: 'dev te perguntou', kind: 'question' })

    await r.send(withDev, 'até sexta')
    await r.idle()
    expect(said(withDev).map(by)).toEqual(['chefe', 'dev', 'dev'])
    const answered = turnsOf('dev').at(-1)!
    expect(answered.prompt).toContain('<tarefa>\npergunte o prazo\n</tarefa>')
    expect(answered.prompt).toContain('até sexta')
    expect(said('dm').map(by)).toEqual(['chefe', 'chefe'])
    expect(said('dm')[1]!.run?.round).toBe(1)
  })

  it('a delegate may coordinate a team of its own, but never the ones above it', async () => {
    db.saveAgent(agent('chefe', { team: ['lead'] }))
    db.saveAgent(agent('lead', { team: ['dev'] }))
    db.saveAgent(agent('dev', { team: ['lead', 'chefe'] }))
    const r = runner()
    await r.send('dm', 'delegue a @lead: delegue a @dev: fazer X')
    await r.idle()

    // The top manager comes back only after its lead got its own results and finished.
    expect(said('dm').map(by)).toEqual(['chefe', 'chefe'])
    const withLead = said(pair('chefe', 'lead'))
    expect(withLead.map(by)).toEqual(['chefe', 'lead', 'lead'])
    expect(withLead[1]!.run?.delegated).toMatchObject([{ agentId: 'dev', task: 'fazer X', conversationId: pair('lead', 'dev') }])
    expect(withLead[2]!.run).toMatchObject({ round: 1, delegation: { by: 'chefe' } })
    expect(said(pair('lead', 'dev'))[1]!.run?.delegation).toMatchObject({ by: 'lead', chain: ['chefe', 'lead'] })
    expect(said('dm')[1]!.run?.round).toBe(1)
    expect(turnsOf('dev')[0]!.system).not.toMatch(/- (chefe|lead) \(@/) // never the ones above it
  })

  it('tells you when the work came back but nobody reports on it', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: escrever o post')
    await r.idle()
    // Stopped by hand, and nothing else out: the lead isn't called, and the DM says so.
    const dev = said(pair('chefe', 'dev'))[1]!
    const head = said('dm')[0]!
    db.saveMessage({ ...dev, run: { ...dev.run!, status: 'stopped', delegation: { ...dev.run!.delegation!, reported: false } } })
    db.saveMessage({ ...said('dm')[1]!, run: undefined, text: '' }) // forget the first report
    ;(r as unknown as { settle(from: string): void }).settle(head.id)
    await r.idle()
    expect(db.messages().filter((m) => m.conversationId === 'dm' && m.author.kind === 'system').at(-1)?.text).toContain('o trabalho foi parado')
    expect(db.message(head.id)!.run).toMatchObject({ released: true, delegated: [{ agentId: 'dev' }] })
  })

  it('one request shares a token budget: past it, nothing more goes out and the lead reports with what it has', async () => {
    settings.requestBudget = 100_000
    const r = runner()
    await r.send('dm', 'delegue a @dev: escrever o post')
    await r.idle()
    const head = said('dm')[0]!
    // Everything the request set off counts: here, a big reply from dev pushes it past the cap.
    const dev = said(pair('chefe', 'dev'))[1]!
    expect(dev.run?.root).toBe(head.id)
    db.addReceipt({ messageId: dev.id, agentId: 'dev', engine: 'claude', model: 'sonnet', inputTokens: 200_000, cacheReadTokens: 0, outputTokens: 0, ms: 1, at: Date.now() })
    expect(db.requestSpent(head.id)).toBeGreaterThan(200_000)

    // A retry brings the result back again: the lead is told the cap is spent, and can't delegate.
    db.saveMessage({ ...dev, run: { ...dev.run!, status: 'failed' } })
    r.retry(dev.id)
    await r.idle()
    const back = turnsOf('chefe').at(-1)!
    expect(back.prompt).toContain('Este pedido já gastou')
    expect(back.prompt).toContain('Não delegue mais')
    expect(back.system).toContain('## Sua equipe e seus colegas')

    // A new request from the lead's report turn would be refused too.
    await r.send('dm', 'delegue a @ana: revisar')
    await r.idle()
    expect(said('dm').findLast((m) => m.run?.delegated)!.run?.delegated).toMatchObject([{ agentId: 'ana' }]) // a new request has its own budget
  })

  it('hands nothing out while the agents are paused', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: escrever o post')
    r.setPaused(true)
    await r.idle()
    expect(said('dm').map(by)).toEqual(['chefe'])
    expect(said('dm')[0]!.run?.delegated).toBeUndefined()
    expect(db.messages().some((m) => m.author.kind === 'system' && m.text.includes('não foi entregue'))).toBe(true)
  })

  it("in the person's DM, a mention calls no one: it stays theirs", async () => {
    const r = runner()
    await r.send('dm', 'peça pro dev')
    await r.idle()
    expect(said('dm').map(by)).toEqual(['chefe'])
    expect(turnsOf('chefe')[0]!.system).toContain('Esta DM é só sua com Edu')
  })

  it('in a DM between two agents, a mention hands the turn to the other one', async () => {
    db.createConversation({ id: 'p', kind: 'agents', name: 'dev-ana', members: ['dev', 'ana'] })
    const r = runner()
    await r.send('p', '@dev peça pra ana')
    await r.idle()
    expect(said('p').map(by)).toEqual(['dev', 'ana'])
    expect(turnsOf('dev')[0]!.system).toContain('Você está numa DM com ana (@ana), outro agente')
  })

  it('any agent calls a colleague from a DM, and goes on with the answer there', async () => {
    db.saveAgent(agent('chefe', { team: [] }))
    const r = runner()
    await r.send('dm', 'chame @ana: quanto deu a receita da semana?')
    await r.idle()
    expect(said('dm').map(by)).toEqual(['chefe', 'chefe'])
    expect(said('dm')[0]!.run?.steps.map((s) => s.label)).toContain('Delegou a ana')
    const withAna = said(pair('chefe', 'ana'))
    expect(withAna[1]!.run?.delegation).toMatchObject({ by: 'chefe', task: 'quanto deu a receita da semana?' })
    expect(turnsOf('ana')[0]!.system).toContain('num pedido que chefe (@chefe) te passou')
    // Without a team, its colleagues are still there to delegate to.
    expect(turnsOf('chefe')[0]!.system).toContain('Colegas, pra quando precisar da resposta deles')
    expect(said('dm')[1]!.run?.round).toBe(1)
    expect(turnsOf('chefe').at(-1)!.prompt).toContain('ana (@ana) terminou. Tarefa: quanto deu a receita da semana?')
  })

  it('a delegate calls a teammate during its task, and the manager waits for both', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: chame @ana: conferir os números')
    await r.idle()
    expect(said('dm').map(by)).toEqual(['chefe', 'chefe'])
    expect(said(pair('chefe', 'dev')).map(by)).toEqual(['chefe', 'dev', 'dev'])
    const withAna = said(pair('dev', 'ana'))
    expect(withAna.map(by)).toEqual(['dev', 'ana'])
    expect(withAna[1]!.run?.delegation).toMatchObject({ by: 'dev', chain: ['chefe', 'dev'], root: said('dm')[0]!.id })
    expect(said(pair('chefe', 'dev'))[2]!.text).toBe('Feito, com a ajuda: chame @ana: conferir os números')
    // On a task, it may call colleagues but not whoever handed it the task.
    const devSystem = turnsOf('dev')[0]!.system
    expect(devSystem).toContain('- ana (@ana)')
    expect(devSystem).not.toContain('- chefe (@chefe)')
    expect(devSystem).toContain('chame os outros só com delegar')
  })

  it('a task tried again by hand stays the same task, and its result goes back again', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: escrever o post')
    await r.idle()
    const dev = said(pair('chefe', 'dev')).find((m) => by(m) === 'dev')!
    db.saveMessage({ ...dev, run: { ...dev.run!, status: 'failed' } })
    r.retry(dev.id)
    await r.idle()
    expect(db.message(dev.id)!.run).toMatchObject({ status: 'done', delegation: { task: 'escrever o post', reported: true } })
    expect(said('dm').map(by)).toEqual(['chefe', 'chefe', 'chefe'])
  })
})
