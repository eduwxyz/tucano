import { mkdtempSync } from 'node:fs'
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
import { exportTeam, importTeam } from '../src/core/team'
import { People } from '../src/core/people'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

function counted(engine: Engine): Engine & { turns: Turn[] } {
  const turns: Turn[] = []
  return { id: engine.id, turns, run: (t) => (turns.push(t), engine.run(t)) }
}

let db: Db
let events: CoreEvent[]
let settings: Settings
let gateway: Gateway
let claude: ReturnType<typeof counted>
let codex: ReturnType<typeof counted>

function runner(): Runner {
  claude = counted(fakeEngine('claude', { delayMs: 1 }))
  codex = counted(fakeEngine('codex', { delayMs: 1 }))
  const engines: Record<EngineId, Engine> = { claude, codex, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway })
}

// What I wrote in a conversation, and the thread under it where whoever I asked closes the subject.
const mine = (conversationId: string): Message[] => db.messages().filter((m) => m.conversationId === conversationId && m.author.kind === 'person')
const under = (root: Message): Message[] => db.messages().filter((m) => m.threadId === root.id)
const by = (id: string, conversationId?: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id && (!conversationId || m.conversationId === conversationId))
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error('never happened')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// orion (on Codex) ← clara, bento; bento ← nico. Orion is in no channel: I talk to it in its DM.
beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
  db.saveAgent(agent('orion', { modelId: 'gpt-5.6-luna' }))
  db.saveAgent(agent('clara', { reportsTo: 'orion' }))
  db.saveAgent(agent('bento', { reportsTo: 'orion' }))
  db.saveAgent(agent('nico', { reportsTo: 'bento' }))
  db.saveAgent(agent('solo'))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'orion', members: ['orion'] })
  db.createConversation({ id: 'clientes', kind: 'channel', name: 'clientes', topic: 'Suporte e e-mails', members: ['clara'] })
  db.createConversation({ id: 'vendas', kind: 'channel', name: 'vendas', members: ['clara'] })
  db.createConversation({ id: 'eng', kind: 'channel', name: 'engenharia', members: ['bento', 'nico'] })
  gateway = new Gateway()
  await gateway.start()
  return () => gateway.stop()
})

describe('work handed down the tree', () => {
  it('keeps what counts as finished out of the conversation: only whoever does it reads it', async () => {
    const { askMessage, askTask, parseAsk } = await import('../src/core/delegations')
    const ask = parseAsk({ para: 'clara', pedido: 'responda o Gabriel', pronto: 'rascunho pronto pra revisar.' })
    if ('error' in ask) throw new Error(ask.error)
    const said = askMessage(agent('clara'), ask)
    expect(said).toBe('@clara, um pedido:\n\nresponda o Gabriel')
    expect(askTask(agent('orion'), 'Edu', ask.done)).toContain('Conta como terminado: rascunho pronto pra revisar.')
    expect(askTask(agent('orion'), 'Edu')).not.toContain('Conta como terminado')
  })

  it('keeps who an agent answers to', () => {
    expect(db.agent('clara')?.reportsTo).toBe('orion')
    expect(db.agent('orion')?.reportsTo).toBeUndefined()
    db.saveAgent({ ...db.agent('clara')!, reportsTo: undefined })
    expect(db.agent('clara')?.reportsTo).toBeUndefined()
  })

  it('takes who answers to whom along in a team file', () => {
    const other = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'other.db'))
    importTeam(other, exportTeam(db), 1000)
    const id = (handle: string): string | undefined => other.agents().find((a) => a.handle === handle)?.id
    const boss = (handle: string): string | undefined => other.agents().find((a) => a.handle === handle)?.reportsTo
    expect(boss('clara')).toBe(id('orion'))
    expect(boss('nico')).toBe(id('bento'))
    expect(boss('orion')).toBeUndefined()
    expect(boss('solo')).toBeUndefined()
  })

  it('opens a thread in the channel of whoever does it, and brings the answer back to where it was asked', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()

    // In #clientes: the request in Orion's name, and Clara's answer in its thread.
    const [root] = by('orion', 'clientes')
    expect(root?.text).toBe('@clara, um pedido:\n\nresponda o Fulano')
    const [answer] = by('clara', 'clientes')
    expect(answer).toMatchObject({ threadId: root!.id, run: { status: 'done' } })
    const [asked] = mine('dm')
    const d = db.delegationAt(root!.id)!
    // What it ends with goes back to the thread of what I asked.
    expect(d).toMatchObject({ from: 'orion', to: 'clara', state: 'done', told: true, originConversationId: 'dm', originThreadId: asked!.id, result: answer!.id })
    expect(root?.run?.delegation).toEqual({ id: d.id, to: 'clara', conversationId: 'clientes', rootId: root!.id })

    // In the DM: Orion's reply that asked, with no text (the line under my message says whom it asked and
    // how it stands), and Orion closing the subject, both in the thread of my message. Nothing in Clara's name.
    const dm = db.messages().filter((m) => m.conversationId === 'dm' && m.author.kind === 'agent')
    expect(dm.map((m) => (m.author as { id: string }).id)).toEqual(['orion', 'orion'])
    expect(dm[0]).toMatchObject({ text: '', run: { delegations: [root!.run!.delegation] } })
    // The reply that asked moved into the thread of my message: the subject lives there.
    expect(dm[0]?.threadId).toBe(asked!.id)
    expect(dm[0]?.run?.steps.map((s) => s.label)).toContain('Pediu a Clara')
    expect(dm[1]).toMatchObject({ threadId: asked!.id, text: 'Pronto: o time terminou o que pedi.' })
    expect(db.messages().some((m) => m.conversationId === 'dm' && m.author.kind === 'system')).toBe(false)
    // Clara was told whose request it is; Orion, what came back, by which code, with her answer itself.
    expect(claude.turns[0]?.prompt).toContain('é um pedido de Orion, a quem você responde')
    expect(codex.turns[1]?.prompt).toContain(`- [${d.id.slice(0, 8)}] Clara, #clientes: terminou. O que respondeu:\n  > ${answer!.text.split('\n')[0]}`)
    expect(codex.turns[0]?.prompt).toContain('Depois de pedir, encerre sem texto')
  })

  it('shows an agent its team, and no team to one with nobody below', async () => {
    const r = runner()
    await r.send('dm', 'oi')
    db.createConversation({ id: 'ds', kind: 'dm', name: 'solo', members: ['solo'] })
    await r.send('ds', 'oi')
    await r.idle()
    const orion = codex.turns[0]!.prompt
    expect(orion).toContain('## Seu time')
    expect(orion).toContain('- @clara · Clara')
    expect(orion).toContain('canais: #clientes (Suporte e e-mails), #vendas')
    expect(orion).toMatch(/- @nico · Nico.*abaixo de Bento/)
    expect(claude.turns[0]!.prompt).not.toContain('## Seu time')
  })

  it('tells whoever asked once, when everything asked from there has come back', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: responda o Fulano\ndelegue a bento: veja o checkout')
    await r.idle()
    expect(db.openDelegations()).toEqual([])
    expect(by('orion', 'dm')).toHaveLength(2)
    expect(by('orion', 'dm')[0]?.run?.delegations).toHaveLength(2)
    expect(by('orion', 'dm')[1]?.threadId).toBe(mine('dm')[0]!.id)
    expect(by('clara', 'dm')).toHaveLength(0)
    expect(by('bento', 'dm')).toHaveLength(0)
    expect(codex.turns.at(-1)?.prompt).toMatch(/Clara, #clientes: terminou[\s\S]*Bento, #engenharia: terminou/)
  })

  it('reaches anyone below, not only the next level, and the channel named', async () => {
    const r = runner()
    await r.send('dm', 'delegue a nico: arrume o leitor de QR\ndelegue a clara em #vendas: fale com o Gabriel')
    await r.idle()
    expect(by('orion', 'eng')[0]?.text).toContain('@nico, um pedido')
    expect(by('nico', 'eng')).toHaveLength(1)
    expect(by('orion', 'vendas')[0]?.text).toContain('fale com o Gabriel')
    expect(by('clara', 'vendas')).toHaveLength(1)
    expect(by('clara', 'clientes')).toHaveLength(0)
  })

  it('delivers in the DM of an agent that is in no channel, making it when there is none', async () => {
    db.saveAgent(agent('duda', { reportsTo: 'orion' }))
    const r = runner()
    await r.send('dm', 'delegue a duda: diga o que você pode fazer')
    await r.idle()
    const made = db.conversations().find((c) => c.kind === 'dm' && c.name === 'duda')!
    expect(made).toMatchObject({ members: ['duda'] })
    expect(events.some((e) => e.type === 'conversation' && e.conversation.id === made.id)).toBe(true)
    // The request is a thread there, in Orion's name, and Duda answers in it.
    const asked = by('orion', made.id)[0]!
    expect(asked.text).toContain('@duda, um pedido')
    expect(by('duda', made.id)[0]?.threadId).toBe(asked.id)
    // The answer comes back to whoever asked, saying where the work was done.
    expect(codex.turns.at(-1)?.prompt).toMatch(/Duda, DM: terminou/)
    expect(db.openDelegations()).toEqual([])
    // A second request goes to the same DM; a channel it isn't in still can't be named.
    await r.send('dm', 'delegue a duda: e mais isto')
    await r.idle()
    expect(db.conversations().filter((c) => c.kind === 'dm' && c.name === 'duda')).toHaveLength(1)
    await r.send('dm', 'delegue a duda em #vendas: qualquer coisa')
    await r.idle()
    expect(by('orion', 'dm').some((m) => m.text.includes('Duda não está em "vendas", nem em canal nenhum.'))).toBe(true)
  })

  it('does not hold the answers back for a request that waits on an approval of mine', async () => {
    const r = runner()
    // Nico takes 8 s, not 2: the wait for Clara below gives up at 5 s, so his work has to outlast that on
    // any runner. With 2 s of head start a loaded shard had him finished before Clara's answer landed, the
    // sweep found nothing open to wait on, and it reported him as done instead of held at an approval.
    await r.send('dm', 'delegue a clara: fale com o Gabriel\ndelegue a nico: demore 8 s')
    await until(() => db.liveDelegations(0).some((d) => d.to === 'clara' && d.state === 'done'))
    // Clara is done, Nico still at it: Orion waits to tell it all at once.
    expect(by('orion', 'dm')).toHaveLength(1)
    // The fixture, not the behaviour: if Nico has already finished there is nothing parked to tell apart.
    expect(db.openDelegations().some((d) => d.to === 'nico')).toBe(true)
    // Nico's reply stops at an approval. That is mine to give, whenever: Clara's answer shouldn't sit behind it.
    const nico = by('nico', 'eng').at(-1)!
    db.saveMessage({ ...nico, run: { ...nico.run!, status: 'waiting_approval' } })
    r.sweepDelegations()
    await until(() => by('orion', 'dm').length === 2)
    const told = codex.turns.at(-1)!.prompt
    expect(told).toMatch(/Clara, #clientes: terminou/)
    // Nico isn't told as something that came back: I see his approval under Orion's message.
    expect(told).toMatch(/Ainda em andamento: \[[0-9a-f]{8}\] Nico, #engenharia \(parado numa aprovação que espera Edu/)
    // When Nico's work does end, Orion hears of it, alone this time.
    await r.idle()
    expect(by('orion', 'dm')).toHaveLength(3)
    expect(codex.turns.at(-1)!.prompt).not.toMatch(/Clara, #clientes: terminou/)
    expect(db.openDelegations()).toEqual([])
    // Nico's own 8 s have to run out inside the test, so the default 5 s wouldn't hold the fixture.
  }, 30_000)

  it('calls no one when the answer names whoever asked, even in a channel they share', async () => {
    db.setAgentChannels('orion', ['clientes'])
    const r = runner()
    await r.send('dm', 'delegue a clara: peça pro orion')
    await r.idle()
    const thread = db.messages().filter((m) => m.conversationId === 'clientes' && m.author.kind === 'agent')
    expect(thread.map((m) => (m.author as { id: string }).id)).toEqual(['orion', 'clara'])
    expect(thread[1]?.text).toBe('@orion, pode ajudar aqui?')
    expect(by('orion', 'dm').at(-1)?.text).toBe('Pronto: o time terminou o que pedi.')
  })

  it('refuses someone who is not below, and a channel they are not in', async () => {
    const r = runner()
    await r.send('dm', 'delegue a solo: qualquer coisa')
    await r.idle()
    expect(by('orion', 'dm')[0]?.text).toContain('Você não alcança ninguém chamado "solo". Quem você alcança: @clara, @bento, @nico.')
    await r.send('dm', 'delegue a clara em #engenharia: qualquer coisa')
    await r.idle()
    expect(by('orion', 'dm')[1]?.text).toContain('Clara não está em "engenharia". Os canais dele: #clientes, #vendas.')
    expect(db.messages().filter((m) => m.conversationId !== 'dm')).toEqual([])
  })

  it('lets those who answer to the same agent ask each other, and brings the answer back', async () => {
    const r = runner()
    await r.send('clientes', 'delegue a bento: arrume o build')
    await r.idle()
    // Clara reads her colleagues, not a team; Bento reads whose request it is.
    const clara = claude.turns[0]!.prompt
    expect(clara).toContain('## Seus colegas')
    expect(clara).toContain('- @bento · Bento')
    expect(clara).not.toContain('## Seu time')
    expect(clara).not.toContain('- @nico')
    const asked = by('clara', 'eng')[0]!
    expect(asked.text).toContain('@bento, um pedido')
    expect(by('bento', 'eng')[0]?.threadId).toBe(asked.id)
    expect(claude.turns.some((t) => t.prompt.includes('um pedido de Clara, seu colega de time'))).toBe(true)
    expect(by('bento', 'clientes')).toHaveLength(0)
    expect(claude.turns.at(-1)?.prompt).toMatch(/Bento, #engenharia: terminou/)
    expect(db.openDelegations()).toEqual([])
  })

  it('never asks back whoever is waiting on the work, nor another branch', async () => {
    db.saveAgent(agent('duda', { reportsTo: 'bento' }))
    db.createConversation({ id: 'dn', kind: 'dm', name: 'nico', members: ['nico'] })
    const r = runner()
    await r.send('clientes', 'delegue a bento: delegue a clara: devolva isto')
    await r.idle()
    expect(by('bento', 'eng').some((m) => m.text.includes('Clara já está esperando por este pedido'))).toBe(true)
    expect(by('bento', 'clientes')).toHaveLength(0) // nothing was asked of Clara, and nothing is posted back
    // Nico answers to Bento: Duda is a colleague, Bento its boss and Orion its sector's head; Clara (Bento's own colleague) is out of reach.
    await r.send('dn', 'delegue a clara: qualquer coisa')
    await r.idle()
    expect(by('nico', 'dn')[0]?.text).toContain('Você não alcança ninguém chamado "clara". Quem você alcança: @duda, @bento, @orion.')
  })

  it('passes up to its own boss, and only heads ask another sector, through its head', async () => {
    // Two sectors: Orion's (named Técnico) and Mira's (Financeiro) with Lino below it.
    db.saveAgent(agent('orion', { modelId: 'gpt-5.6-luna', sectorName: 'Técnico', sectorDoes: 'Bugs e código' }))
    db.saveAgent(agent('mira', { sectorName: 'Financeiro', sectorDoes: 'Cobranças' }))
    db.saveAgent(agent('lino', { reportsTo: 'mira' }))
    db.createConversation({ id: 'dl', kind: 'dm', name: 'lino', members: ['lino'] })
    const r = runner()
    // Lino can't reach the other sector: only its boss.
    await r.send('dl', 'delegue a orion: veja o boleto')
    await r.idle()
    expect(by('lino', 'dl')[0]?.text).toContain('Você não alcança ninguém chamado "orion". Quem você alcança: @mira.')
    expect(claude.turns[0]!.prompt).toContain('## Seu chefe\n@mira · Mira')
    // Lino passes it up to Mira, told whose it is and what other sectors there are.
    await r.send('dl', 'delegue a mira: veja o boleto')
    await r.idle()
    const mira = claude.turns.find((t) => t.prompt.includes('de Lino, do seu time, que passou isto a você'))!.prompt
    expect(mira).toContain('## Seu setor\nSeu setor: Financeiro · resolve: Cobranças')
    expect(mira).toContain('- @orion · Técnico · resolve: Bugs e código')
    expect(by('lino', 'dl').at(-1)?.text).toBe('Pronto: o time terminou o que pedi.')
    // Mira, a head, takes it to the Técnico's head, who is told it comes from the Financeiro.
    db.createConversation({ id: 'dmira', kind: 'dm', name: 'mira', members: ['mira'] })
    await r.send('dmira', 'delegue a orion: veja o boleto')
    await r.idle()
    expect(codex.turns.some((t) => t.prompt.includes('um pedido do Financeiro, via Mira: decida quem do seu setor faz'))).toBe(true)
    expect(by('mira', 'dmira').at(-1)?.text).toBe('Pronto: o time terminou o que pedi.')
    expect(db.openDelegations()).toEqual([])
  })

  it('tells a chosen entry point about the sectors, and a head below it about its own', async () => {
    // Orion tops Clara and Bento, and Bento has Nico: chosen as the entry point, Bento heads a sector under it.
    db.saveAgent({ ...db.agent('orion')!, entry: true })
    db.saveAgent({ ...db.agent('bento')!, sectorName: 'Engenharia', sectorDoes: 'Bugs e código' })
    const r = runner()
    await r.send('dm', 'delegue a bento: arrume o build')
    await r.idle()
    const orion = codex.turns[0]!.prompt
    expect(orion).toContain('## Os setores\nVocê é a porta de entrada: Edu fala com você')
    expect(orion).toContain('- @bento · Engenharia · resolve: Bugs e código')
    const bento = claude.turns.find((t) => t.prompt.includes('um pedido de Orion, a quem você responde'))!.prompt
    expect(bento).toContain('## Seu setor\nSeu setor: Engenharia · resolve: Bugs e código')
    expect(bento).not.toContain('Você é a porta de entrada')
    expect(db.openDelegations()).toEqual([])
    // Nico, in Bento's sector, reaches its head and not the entry point past it.
    db.createConversation({ id: 'dn', kind: 'dm', name: 'nico', members: ['nico'] })
    await r.send('dn', 'delegue a orion: qualquer coisa')
    await r.idle()
    expect(by('nico', 'dn').at(-1)?.text).toContain('Você não alcança ninguém chamado "orion".')
  })

  it('goes straight to its sector\'s head from any depth, so crossing sectors always fits in three requests', async () => {
    // Mira's sector is three deep (Mira ← Lino ← Tito); Nico is two below Orion, the other head.
    db.saveAgent(agent('mira', { sectorName: 'Financeiro' }))
    db.saveAgent(agent('lino', { reportsTo: 'mira' }))
    db.saveAgent(agent('tito', { reportsTo: 'lino' }))
    db.createConversation({ id: 'dt', kind: 'dm', name: 'tito', members: ['tito'] })
    const r = runner()
    // Tito, at the bottom, passes it to Mira past Lino; Mira asks Orion; Orion hands it to Nico: three requests.
    await r.send('dt', 'delegue a mira: delegue a orion: delegue a nico: veja o boleto')
    await r.idle()
    const prompts = [...claude.turns, ...codex.turns].map((t) => t.prompt)
    expect(prompts.find((p) => p.includes('## Chefe do seu setor'))).toContain('## Seu chefe\n@lino · Lino. Passe a ele com pedir só o que você não consegue fazer')
    expect(prompts.some((p) => p.includes('## Chefe do seu setor\n@mira · Mira. O que não é do trabalho do seu setor vai direto a ele'))).toBe(true)
    expect(prompts.some((p) => p.includes('de Tito, do seu time, que passou isto a você: resolva, ou leve ao setor certo.'))).toBe(true)
    expect(prompts.some((p) => p.includes('um pedido do Financeiro, via Mira'))).toBe(true)
    expect(prompts.some((p) => p.includes('um pedido de Orion, a quem você responde'))).toBe(true)
    expect(db.messages().some((m) => m.text.includes('pedidos seguidos'))).toBe(false)
    expect(db.conversations().some((c) => c.kind === 'dm' && c.name === 'lino')).toBe(false) // Lino wasn't in the way
    expect(by('tito', 'dt').at(-1)?.text).toBe('Pronto: o time terminou o que pedi.')
    expect(db.openDelegations()).toEqual([])
    // What Tito can't do goes to its own boss, who isn't a head: it solves it or says what is left.
    await r.send('dt', 'delegue a lino: não consigo abrir o sistema')
    await r.idle()
    expect([...claude.turns, ...codex.turns].some((t) => t.prompt.includes('de Tito, do seu time, que passou isto a você: resolva, ou responda dizendo o que falta.'))).toBe(true)
    expect(db.openDelegations()).toEqual([])
  })

  it('stops a piece of work from stacking more than three requests', async () => {
    db.saveAgent(agent('duda', { reportsTo: 'orion' }))
    db.saveAgent(agent('eva', { reportsTo: 'orion' }))
    const r = runner()
    await r.send('dm', 'delegue a clara: delegue a bento: delegue a duda: delegue a eva: mais um')
    await r.idle()
    const duda = db.conversations().find((c) => c.kind === 'dm' && c.name === 'duda')!
    expect(by('duda', duda.id).some((m) => m.text.includes('já passou por 3 pedidos seguidos'))).toBe(true)
    expect(db.conversations().some((c) => c.kind === 'dm' && c.name === 'eva')).toBe(false)
    expect(db.openDelegations()).toEqual([])
  })

  it('delivers in the DM when the subject is of no channel, even to an agent that has channels', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara em #dm: me dê oi')
    await r.idle()
    const made = db.conversations().find((c) => c.kind === 'dm' && c.name === 'clara')!
    expect(by('orion', made.id)[0]?.text).toContain('@clara, um pedido')
    expect(by('clara', made.id)).toHaveLength(1)
    expect(by('clara', 'clientes')).toHaveLength(0)
    expect(codex.turns.at(-1)!.prompt).toMatch(/Clara, DM: terminou/)
    expect(codex.turns[0]!.prompt).toContain('peça com canal "dm"')
  })

  it('takes a question on the work up to whoever asked, who answers what it knows', async () => {
    const r = runner()
    await r.send('dm', 'responda a dúvida com `até sexta`. delegue a clara: pergunte o que faltar')
    await r.idle()

    const thread = db.messages().filter((m) => m.conversationId === 'clientes')
    // Orion's request, Clara's question, Orion's answer, Clara's end.
    expect(thread.map((m) => (m.author as { id: string }).id)).toEqual(['orion', 'clara', 'orion', 'clara'])
    expect(thread[1]?.run?.steps.map((s) => s.label)).toContain('Perguntou a Orion')
    expect(thread[1]?.run?.status).toBe('done') // answered
    expect(thread[2]?.text).toBe('até sexta')
    // No person was asked.
    expect(db.openQuestions()).toEqual([])
    expect(db.answeredQuestions(0)).toEqual([])
    // Nothing in Clara's name in the DM: what she wrote before asking and her question went up to Orion,
    // who answered it itself and said nothing to me about it; then it closed the subject in my thread.
    expect(by('clara', 'dm')).toHaveLength(0)
    const up = codex.turns.find((t) => /deixou uma pergunta e espera/.test(t.prompt))!.prompt
    expect(up).toMatch(/O que escreveu até agora:\n  > [^\n]*Te mandei uma pergunta/)
    expect(up).toMatch(/A pergunta:\n  > /)
    expect(by('orion', 'dm').map((m) => m.text)).toEqual(['', '', 'Pronto: o time terminou o que pedi.'])
    expect(by('orion', 'dm').slice(1).every((m) => m.threadId === mine('dm')[0]!.id)).toBe(true)
    expect(db.delegationAt(thread[0]!.id)).toMatchObject({ state: 'done' })
    expect(db.delegationAt(thread[0]!.id)?.asking).toBeUndefined()
  })

  it('takes to the person what it cannot answer, and passes their answer on', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: pergunte o que faltar')
    await r.idle()
    const asked = by('orion', 'dm').at(-1)!
    expect(asked.run).toMatchObject({ status: 'waiting_input', question: 'Pra quando você precisa disso?' })
    const [root] = by('orion', 'clientes')
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'open', askingTold: true })
    expect(by('clara', 'clientes')[0]?.run?.status).toBe('waiting_input')

    // Orion asked me in the thread of my message: I answer there.
    expect(asked.threadId).toBe(mine('dm')[0]!.id)
    await r.send('dm', 'repasse: até sexta', [], asked.threadId)
    await r.idle()
    const thread = db.messages().filter((m) => m.conversationId === 'clientes')
    expect(thread.map((m) => (m.author as { id: string }).id)).toEqual(['orion', 'clara', 'orion', 'clara'])
    expect(thread[2]?.text).toBe('até sexta')
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'done', told: true })
    expect(by('orion', 'dm').at(-1)?.text).toBe('Pronto: o time terminou o que pedi.')
  })

  it('lets a person answer the question right in its thread', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: pergunte o que faltar')
    await r.idle()
    const [root] = by('orion', 'clientes')
    await r.send('clientes', 'até sexta', [], root!.id)
    await r.idle()
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'done' })
    expect(db.delegationAt(root!.id)?.asking).toBeUndefined()
    expect(by('clara', 'clientes')).toHaveLength(2)
  })

  it('tells whoever asked when the work stops short', async () => {
    const r = runner()
    // Clara runs on Claude, whose usual login is out: her reply fails before doing anything.
    await r.send('dm', 'delegue a clara: acabou o limite')
    await r.idle()
    const [root] = by('orion', 'clientes')
    expect(by('clara', 'clientes')[0]?.run?.status).toBe('failed')
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'failed', told: true })
    expect(db.messages().some((m) => m.conversationId === 'dm' && m.author.kind === 'system')).toBe(false) // Orion says it
    expect(codex.turns.at(-1)?.prompt).toMatch(/Clara, #clientes: não terminou \(/)
    expect(by('orion', 'dm').at(-1)?.text).toBe('Não deu certo: o pedido não terminou.')
  })

  it('tells whoever asked right away when the one asked cannot even start', async () => {
    settings.engines.claude = { installed: true, loggedIn: false }
    const r = runner()
    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()
    const [root] = by('orion', 'clientes')
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'failed', told: true })
    expect(codex.turns.at(-1)?.prompt).toMatch(/Clara, #clientes: não terminou \(O Claude Code não está logado/)
    expect(by('orion', 'dm').at(-1)?.text).toBe('Não deu certo: o pedido não terminou.')
  })

  it('stops whoever is on it when the request is cancelled', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: demore 4 s')
    await until(() => by('clara', 'clientes')[0]?.run?.status === 'working' && by('orion', 'dm')[0]?.run?.status === 'done')
    await r.send('dm', 'cancele o pedido')
    await r.idle()
    const [root] = by('orion', 'clientes')
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'cancelled', told: true })
    expect(by('clara', 'clientes')[0]?.run?.status).toBe('stopped')
    expect(db.messages().some((m) => m.threadId === root!.id && m.text === '**Orion** cancelou este pedido: mudou o plano.')).toBe(true)
    // Orion did it itself: nothing comes back to tell.
    expect(by('orion', 'dm')).toHaveLength(2)
  }, 15_000)

  it('tells whoever asked when the deadline goes by, once', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: demore 2 s, prazo de 1 h')
    await until(() => by('clara', 'clientes')[0]?.run?.status === 'working')
    const [root] = by('orion', 'clientes')
    expect(db.delegationAt(root!.id)?.dueAt).toBeGreaterThan(Date.now() + 3_500_000)
    await until(() => by('orion', 'dm')[0]?.run?.status === 'done')
    r.sweepDelegations(Date.now() + 2 * 3_600_000)
    r.sweepDelegations(Date.now() + 2 * 3_600_000)
    await r.idle()
    expect(by('orion', 'dm').map((m) => m.text).slice(1)).toEqual(['Passou do prazo e ainda não terminou.', 'Pronto: o time terminou o que pedi.'])
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'done', lateTold: true })
  }, 15_000)

  it('closes a request whose reply was cut while the app was away', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()
    // As if the app had closed mid-reply: the request open again, Clara's reply interrupted long ago.
    const [root] = by('orion', 'clientes')
    const d = db.delegationAt(root!.id)!
    db.saveDelegation({ ...d, state: 'open', told: false, result: undefined, endedAt: undefined })
    const reply = by('clara', 'clientes')[0]!
    db.saveMessage({ ...reply, run: { ...reply.run!, status: 'interrupted', endedAt: Date.now() - 120_000 } })
    r.sweepDelegations()
    await r.idle()
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'failed', told: true })
    expect(by('orion', 'dm').at(-1)?.text).toBe('Não deu certo: o pedido não terminou.')
  })

  it('keeps the approval the work stopped on with the request, and wakes no one for it', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()
    const [root] = by('orion', 'clientes')
    const d = db.delegationAt(root!.id)!
    // As if the app had been closed right as Clara stopped at an approval: the request open again, her
    // reply waiting for my yes, and nobody having heard of it.
    db.saveDelegation({ ...d, state: 'open', told: false, result: undefined, endedAt: undefined })
    const reply = by('clara', 'clientes')[0]!
    db.saveMessage({ ...reply, run: { ...reply.run!, status: 'waiting_approval' } })
    const turns = codex.turns.length
    r.sweepDelegations()
    await r.idle()
    // I approve it under Orion's message (the line there shows it): Orion isn't called to tell me.
    expect(codex.turns).toHaveLength(turns)
    expect(by('clara', 'dm')).toHaveLength(0)
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'open' })
  })


  it('goes on in the same thread when I follow up on a request that came back', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()
    const [asked] = mine('dm')
    const [root] = by('orion', 'clientes')
    const first = db.delegationAt(root!.id)!
    // Orion is shown what came back there, by its code.
    await r.send('dm', 'continue com clara: mande também pro Beltrano', [], asked!.id)
    await r.idle()
    expect(codex.turns.at(-2)!.prompt).toContain(`## Pedidos que já voltaram aqui`)
    expect(codex.turns.at(-2)!.prompt).toContain(`- [${first.id.slice(0, 8)}] Clara, #clientes, terminou: responda o Fulano`)
    // The same request, opened again in its own thread: no new thread in #clientes.
    expect(by('orion', 'clientes').filter((m) => !m.threadId)).toHaveLength(1)
    const thread = under(root!)
    expect(thread.map((m) => (m.author as { id: string }).id)).toEqual(['clara', 'orion', 'clara'])
    expect(thread[1]?.text).toBe('@clara, um pedido:\n\nmande também pro Beltrano')
    expect(db.liveDelegations(0)).toHaveLength(1)
    expect(db.delegationAt(root!.id)).toMatchObject({ id: first.id, state: 'done', told: true, text: 'mande também pro Beltrano', originThreadId: asked!.id, result: thread[2]!.id })
    // Clara was told it continues the thread; Orion closed it in my thread again.
    expect(claude.turns.some((t) => t.prompt.includes('Isto continua esta thread'))).toBe(true)
    expect(under(asked!).filter((m) => m.author.kind === 'agent').map((m) => m.text).at(-1)).toBe('Pronto: o time terminou o que pedi.')
  })

  it('keeps a request asked in a DM in a DM when other people share the workspace, unless I name the channel', async () => {
    const people = new People(db)
    const joined = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    const r = runner()
    await r.send('dm', 'delegue a clara: veja quanto o cliente X deve')
    await r.idle()
    const dm = db.conversations().find((c) => c.kind === 'dm' && c.name === 'clara')!
    expect(by('orion', dm.id)[0]?.text).toContain('@clara, um pedido')
    expect(by('orion', 'clientes')).toHaveLength(0)
    // Naming the channel myself takes it there.
    await r.send('dm', 'delegue a clara em #clientes: responda o Fulano no #clientes')
    await r.idle()
    expect(by('orion', 'clientes')[0]?.text).toContain('responda o Fulano')
  })

  it('does not take a follow-up from a DM into the channel an older request is in, unless I name it', async () => {
    const r = runner()
    // Asked when I was alone in the workspace: it went to #clientes.
    await r.send('dm', 'delegue a clara: responda o Fulano')
    await r.idle()
    const [asked] = mine('dm')
    const [root] = by('orion', 'clientes')
    const people = new People(db)
    const joined = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    // Now someone else shares the workspace: what I say in my DM doesn't go to #clientes on a follow-up.
    await r.send('dm', 'continue com clara: o Fulano deve 300 reais', [], asked!.id)
    await r.idle()
    expect(under(root!).some((m) => m.text.includes('300 reais'))).toBe(false)
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'done', text: 'responda o Fulano' })
    // Naming the channel myself lets it go on there.
    await r.send('dm', 'continue com clara: mande pro Fulano no #clientes', [], asked!.id)
    await r.idle()
    expect(under(root!).some((m) => m.text.includes('mande pro Fulano no #clientes'))).toBe(true)
  })

  it('sends it to the agent channel when I am the only person, as before', async () => {
    const r = runner()
    await r.send('dm', 'delegue a clara: veja quanto o cliente X deve')
    await r.idle()
    expect(by('orion', 'clientes')[0]?.text).toContain('@clara, um pedido')
  })

  it('takes what I write in a request thread to whoever is doing it, and the answer still goes back', async () => {
    const r = runner()
    await r.send('dm', 'delegue a bento: demore 1 s e veja o checkout')
    await until(() => by('bento', 'eng').length > 0)
    const [root] = by('orion', 'eng')
    // #engenharia has Bento and Nico: what I write in the thread is for Bento, not for whoever the router picks.
    await r.send('eng', 'deixa a #459 de fora', [], root!.id)
    await r.idle()
    expect(by('nico', 'eng')).toHaveLength(0)
    expect(by('bento', 'eng').length).toBeGreaterThanOrEqual(2)
    // The request ends with Bento's reply to what I wrote, not with the one that was under way.
    expect(db.delegationAt(root!.id)).toMatchObject({ state: 'done', told: true, result: by('bento', 'eng').at(-1)!.id })
    expect(under(mine('dm')[0]!).filter((m) => m.author.kind === 'agent').map((m) => m.text)).toEqual(['', 'Pronto: o time terminou o que pedi.']) // the reply that asked, then the closing
  }, 15_000)

  it('keeps a request to someone in the same channel inside the thread, and closes the outer one only when it comes back', async () => {
    const r = runner()
    // Bento works in #engenharia, and so does Nico: Bento's request to Nico stays in Bento's thread.
    await r.send('dm', 'delegue a bento: delegue a nico: veja o build')
    await r.idle()
    const roots = by('orion', 'eng').filter((m) => !m.threadId)
    expect(roots).toHaveLength(1)
    expect(db.messages().filter((m) => m.conversationId === 'eng' && !m.threadId)).toHaveLength(1) // nothing loose in the channel
    const thread = under(roots[0]!)
    expect(thread.map((m) => (m.author as { id: string }).id)).toEqual(['bento', 'bento', 'nico', 'bento'])
    expect(thread[1]?.text).toBe('@nico, um pedido:\n\nveja o build')
    const outer = db.delegationAt(roots[0]!.id)!
    const inner = db.liveDelegations(0).find((d) => d.to === 'nico')!
    expect(inner).toMatchObject({ from: 'bento', threadId: roots[0]!.id, rootId: thread[1]!.id, state: 'done', told: true, result: thread[2]!.id })
    // Bento's first reply only asked Nico: the outer request stayed open until Nico's answer came back,
    // and it ends with Bento's reply after it.
    expect(thread[0]?.run?.handed).toBe(outer.id)
    expect(thread[2]?.run?.handed).toBe(inner.id)
    expect(outer).toMatchObject({ state: 'done', told: true, result: thread[3]!.id })
    // Orion heard once, with Bento's closing answer.
    expect(codex.turns.filter((t) => /Voltou do que você pediu/.test(t.prompt))).toHaveLength(1)
    expect(under(mine('dm')[0]!).filter((m) => m.author.kind === 'agent').map((m) => m.text)).toEqual(['', 'Pronto: o time terminou o que pedi.']) // the reply that asked, then the closing
  })

  // A request whose thread has nothing after it at all: the one asked never wrote a line, no error
  // either (the run never got going). Nobody used to hear of it, ever.
  const askedButSilent = (extra: { nudges?: number; createdAt?: number } = {}): string => {
    const root = { id: 'raiz-muda', conversationId: 'clientes', author: { kind: 'agent' as const, id: 'orion' }, text: '@clara, um pedido:\n\nresponda o Fulano', at: Date.now() }
    db.saveMessage(root)
    db.saveDelegation({ id: 'pedido-mudo', from: 'orion', to: 'clara', conversationId: 'clientes', rootId: root.id, originConversationId: 'dm', originMessageId: 'mudo-pedido', requestedBy: db.ownerId(), text: 'responda o Fulano', state: 'open', createdAt: extra.createdAt ?? Date.now(), ...(extra.nudges ? { nudges: extra.nudges } : {}) })
    return root.id
  }

  it('knocks once on a request whose thread has nothing, and what comes of it goes back', async () => {
    const r = runner()
    const rootId = askedButSilent()
    // A minute in: too soon to knock.
    r.sweepDelegations()
    expect(db.delegation('pedido-mudo')?.nudges).toBeUndefined()
    r.sweepDelegations(Date.now() + 5 * 60_000)
    await r.idle()
    expect(db.delegation('pedido-mudo')?.nudges).toBe(1)
    // This time it answers, and the answer comes back to where it was asked.
    expect(db.messages().some((m) => m.threadId === rootId && m.author.kind === 'agent')).toBe(true)
    expect(db.delegation('pedido-mudo')).toMatchObject({ state: 'done', told: true })
    expect(codex.turns.at(-1)!.prompt).toMatch(/Clara, #clientes: terminou/)
  })

  it('ends a request whose last reply ended well but stayed open, when the reply to what I wrote there never came', async () => {
    const r = runner()
    const rootId = askedButSilent({ createdAt: Date.now() - 10 * 60_000 })
    // Clara answered; I wrote in the thread meanwhile, and the app closed before her reply to that.
    const answer: Message = { id: 'resposta-clara', conversationId: 'clientes', threadId: rootId, author: { kind: 'agent', id: 'clara' }, text: 'Respondi o Fulano.', at: Date.now() - 9 * 60_000, run: { status: 'done', endedAt: Date.now() - 8 * 60_000 } } as Message
    db.saveMessage(answer)
    db.saveMessage({ id: 'eu-na-thread', conversationId: 'clientes', threadId: rootId, author: { kind: 'person', id: db.ownerId() }, text: 'e o Beltrano?', at: Date.now() - 8 * 60_000 } as Message)
    r.sweepDelegations()
    await r.idle()
    expect(db.delegation('pedido-mudo')).toMatchObject({ state: 'done', told: true, result: 'resposta-clara' })
    expect(codex.turns.at(-1)!.prompt).toMatch(/Clara, #clientes: terminou/)
  })

  it('leaves a request open while what its doer asked of others there is still out', async () => {
    const r = runner()
    const rootId = askedButSilent({ createdAt: Date.now() - 10 * 60_000 })
    // Clara's reply ended well, but it only asked Bento: the request waits for that, not for the sweep.
    db.saveMessage({ id: 'clara-pediu', conversationId: 'clientes', threadId: rootId, author: { kind: 'agent', id: 'clara' }, text: '', at: Date.now() - 9 * 60_000, run: { status: 'done', endedAt: Date.now() - 8 * 60_000, handed: 'pedido-mudo' } } as Message)
    db.saveDelegation({ id: 'pedido-dela', from: 'clara', to: 'bento', conversationId: 'eng', rootId: 'raiz-bento', originConversationId: 'clientes', originThreadId: rootId, originMessageId: 'clara-pediu', requestedBy: db.ownerId(), text: 'veja o build', state: 'open', createdAt: Date.now() - 9 * 60_000 })
    r.sweepDelegations()
    expect(db.delegation('pedido-mudo')?.state).toBe('open')
  })

  it('leaves a request open while its last good reply is under a minute old', async () => {
    const r = runner()
    const rootId = askedButSilent({ createdAt: Date.now() - 60_000 })
    db.saveMessage({ id: 'resposta-recente', conversationId: 'clientes', threadId: rootId, author: { kind: 'agent', id: 'clara' }, text: 'Respondi.', at: Date.now() - 30_000, run: { status: 'done', endedAt: Date.now() - 10_000 } } as Message)
    r.sweepDelegations()
    await r.idle()
    expect(db.delegation('pedido-mudo')?.state).toBe('open')
  })

  it('does not start an old silent request out of the blue: it ends, and whoever asked hears it', async () => {
    const r = runner()
    // Open and silent for two days (the app was closed, or it predates the knock): no turn now.
    const rootId = askedButSilent({ createdAt: Date.now() - 2 * 24 * 60 * 60_000 })
    r.sweepDelegations()
    await r.idle()
    expect(db.delegation('pedido-mudo')).toMatchObject({ state: 'failed', told: true })
    expect(db.delegation('pedido-mudo')?.nudges).toBeUndefined()
    expect(db.messages().some((m) => m.threadId === rootId && m.author.kind === 'agent')).toBe(false)
    expect(codex.turns.at(-1)!.prompt).toMatch(/Clara, #clientes: não terminou/)
  })

  it('gives up on a request nobody answered, and whoever asked hears it', async () => {
    const r = runner()
    const rootId = askedButSilent({ nudges: 1, createdAt: Date.now() - 11 * 60_000 })
    r.sweepDelegations()
    await r.idle()
    expect(db.delegation('pedido-mudo')).toMatchObject({ state: 'failed', told: true })
    expect(codex.turns.at(-1)!.prompt).toMatch(/Clara, #clientes: não terminou/)
    expect(db.messages().some((m) => m.threadId === rootId && m.author.kind === 'agent')).toBe(false)
  })
})

// Work handed on for someone who sees only part of the team stays within that part, however far it goes.
describe('work handed on for a restricted member', () => {
  // Orion is the entry point: Bento heads a sector (Nico), Clara another (Lia).
  async function ask(picked: boolean): Promise<{ bia: string; bento: string }> {
    db.saveAgent({ ...db.agent('orion')!, entry: true })
    db.saveAgent(agent('lia', { reportsTo: 'clara' }))
    const r = runner()
    const people = new People(db)
    const joined = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    const bia = joined.person.id
    if (picked) db.setPersonAccess(bia, { mode: 'picked', sectors: ['bento'], agents: [], channels: ['eng'] })
    await r.send('eng', '@nico delegue a bento: veja o build', [], undefined, bia)
    await r.idle()
    const turn = claude.turns.find((t) => t.system.includes('Você é Bento'))
    if (!turn) throw new Error('Bento never ran')
    return { bia, bento: `${turn.system}\n${turn.prompt}` }
  }

  it('runs the one asked for the member, not the owner, and brings the answer back as them', async () => {
    const { bia, bento } = await ask(true)
    const [d] = db.liveDelegations(0).filter((x) => x.from === 'nico')
    expect(d).toMatchObject({ to: 'bento', requestedBy: bia, state: 'done', told: true, originThreadId: mine('eng')[0]!.id })
    // Bento, asked in a thread with no person in it, still works for Bia: no other sector, no hidden agent.
    expect(bento).toContain('@nico')
    for (const hidden of ['@clara', '@lia', '@orion']) expect(bento).not.toContain(hidden)
    // Nico closes it in the thread of Bia's message.
    expect(by('nico', 'eng').some((m) => m.threadId === mine('eng')[0]!.id && m.text === 'Pronto: o time terminou o que pedi.')).toBe(true)
  })

  it('leaves a member who sees everything as before', async () => {
    const { bento } = await ask(false)
    expect(bento).toContain('@clara')
  })

  it('runs the answer back for the member who asked, even when someone else wrote there since', async () => {
    db.saveAgent({ ...db.agent('orion')!, entry: true })
    db.saveAgent(agent('lia', { reportsTo: 'clara' }))
    const r = runner()
    const people = new People(db)
    const joined = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    const bia = joined.person.id
    db.setPersonAccess(bia, { mode: 'picked', sectors: ['bento'], agents: [], channels: ['eng'] })
    const sent = r.send('eng', '@nico delegue a bento: demore 1s e veja o build', [], undefined, bia)
    await until(() => db.liveDelegations(0).some((d) => d.from === 'nico'))
    // The owner writes in the channel while Bento works: the last person there is no longer Bia.
    const hers = db.messages().find((m) => m.conversationId === 'eng' && m.author.kind === 'person')!
    db.saveMessage({ ...hers, id: 'edu-later', author: { kind: 'person', id: db.ownerId() }, text: 'bom dia', at: Date.now() })
    await sent
    await r.idle()
    await until(() => db.liveDelegations(0).find((d) => d.from === 'nico')?.told === true)
    await r.idle()
    const back = claude.turns.filter((t) => t.system.includes('Você é Nico')).at(-1)!
    expect(back.prompt).toMatch(/Voltou do que você pediu/)
    for (const hidden of ['@clara', '@lia', '@orion']) expect(`${back.system}\n${back.prompt}`).not.toContain(hidden)
  })
})

