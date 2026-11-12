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
  const engines: Record<EngineId, Engine> = { claude, codex, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway })
}

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
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
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
    const d = db.delegationAt(root!.id)!
    expect(d).toMatchObject({ from: 'orion', to: 'clara', state: 'done', told: true, originConversationId: 'dm', result: answer!.id })
    expect(root?.run?.delegation).toEqual({ id: d.id, to: 'clara', conversationId: 'clientes', rootId: root!.id })

    // In the DM: what Orion said after asking, Clara's answer, and Orion closing the subject.
    const dm = db.messages().filter((m) => m.conversationId === 'dm' && m.author.kind === 'agent')
    expect(dm.map((m) => (m.author as { id: string }).id)).toEqual(['orion', 'clara', 'orion'])
    expect(dm[0]?.run?.delegations).toEqual([root!.run!.delegation])
    expect(dm[1]?.run?.delegation).toEqual({ ...root!.run!.delegation, back: 'result' }) // the answer back: shown folded there
    expect(dm[0]?.run?.steps.map((s) => s.label)).toContain('Pediu a Clara')
    expect(dm[1]?.text).toBe(`Sobre o pedido em #clientes:\n\n${answer!.text}`)
    expect(dm[2]?.text).toBe('Pronto: o time terminou o que pedi.')
    // Clara was told whose request it is; Orion, what came back and by which code.
    expect(claude.turns[0]?.prompt).toContain('é um pedido de Orion, a quem você responde')
    expect(codex.turns[1]?.prompt).toContain(`- [${d.id.slice(0, 8)}] Clara, #clientes: terminou.`)
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
    expect(by('clara', 'dm')).toHaveLength(1)
    expect(by('bento', 'dm')).toHaveLength(1)
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
    // The answer comes back to where it was asked, saying where the work was done.
    expect(by('duda', 'dm')[0]?.text).toContain('Sobre o pedido na DM dele')
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
    await r.send('dm', 'delegue a clara: fale com o Gabriel\ndelegue a nico: demore 2 s')
    await until(() => db.liveDelegations(0).some((d) => d.to === 'clara' && d.state === 'done'))
    // Clara is done, Nico still at it: Orion waits to tell it all at once.
    expect(by('orion', 'dm')).toHaveLength(1)
    // Nico's reply stops at an approval. That is mine to give, whenever: Clara's answer shouldn't sit behind it.
    const nico = by('nico', 'eng').at(-1)!
    db.saveMessage({ ...nico, run: { ...nico.run!, status: 'waiting_approval' } })
    r.sweepDelegations()
    await until(() => by('orion', 'dm').length === 2)
    const told = codex.turns.at(-1)!.prompt
    expect(told).toMatch(/Clara, #clientes: terminou/)
    expect(told).toMatch(/Ainda em andamento: \[\w{8}\] Nico, #engenharia \(parado numa aprovação que espera Edu\)/)
    expect(told).toContain('e o que espera uma aprovação dele')
    // When Nico's work does end, Orion hears of it, alone this time.
    await r.idle()
    expect(by('orion', 'dm')).toHaveLength(3)
    expect(codex.turns.at(-1)!.prompt).not.toContain('Clara, #clientes')
    expect(db.openDelegations()).toEqual([])
  })

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
    expect(by('bento', 'clientes')[0]?.text).toContain('Sobre o pedido em #engenharia')
    expect(db.openDelegations()).toEqual([])
  })

  it('never asks back whoever is waiting on the work, nor another branch', async () => {
    db.saveAgent(agent('duda', { reportsTo: 'bento' }))
    db.createConversation({ id: 'dn', kind: 'dm', name: 'nico', members: ['nico'] })
    const r = runner()
    await r.send('clientes', 'delegue a bento: delegue a clara: devolva isto')
    await r.idle()
    expect(by('bento', 'eng').some((m) => m.text.includes('Clara já está esperando por este pedido'))).toBe(true)
    expect(by('bento', 'clientes')).toHaveLength(1) // only what came back: nothing was asked of Clara
    // Nico answers to Bento: Duda is a colleague, Clara (Bento's own colleague) is out of reach.
    await r.send('dn', 'delegue a clara: qualquer coisa')
    await r.idle()
    expect(by('nico', 'dn')[0]?.text).toContain('Você não alcança ninguém chamado "clara". Quem você alcança: @duda.')
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
    expect(by('clara', 'dm')[0]?.text).toContain('Sobre o pedido na DM dele')
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
    // In the DM: the question showed up in Clara's name, then her answer.
    expect(by('clara', 'dm').map((m) => m.text.split(':')[0])).toEqual(['Uma pergunta sobre o pedido em #clientes', 'Sobre o pedido em #clientes'])
    expect(by('orion', 'dm').map((m) => m.text)).toEqual([expect.stringContaining('Pedido ['), 'Respondi a dúvida dele.', 'Pronto: o time terminou o que pedi.'])
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

    await r.send('dm', 'repasse: até sexta')
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
    expect(db.messages().some((m) => m.conversationId === 'dm' && m.author.kind === 'system' && m.text.startsWith('O pedido a **Clara** em #clientes não terminou'))).toBe(true)
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
})
