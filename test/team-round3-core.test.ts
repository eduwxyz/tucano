// Tucano Team v1, third round: what the real core answers each person over its API (fake engines).
// One core for the whole file: the describes run in order and build on each other.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry, Conversation, Message, Person, WikiChange, WikiPage, WikiSource, WikiVersion } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

// Under a full run's load, a reply with the fake engines can take a few seconds.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bruno: Client // a member
let carla: Client // an admin
let ids: { ana: string; bruno: string; carla: string }
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)

const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

type Snap = { you: string; agents: { id: string; handle: string }[]; conversations: Conversation[]; messages: Message[] }
type WikiData = { pages: { title: string }[]; log: string[]; recent: { title: string; at: number; by: string }[]; graph: { nodes: { title: string }[] }; held?: { title: string; at: number }[]; heritage?: { at: number } }

async function join(role: 'member' | 'admin', name: string, restore?: string): Promise<Person> {
  const { code } = await ana.call<{ code: string }>('createInvite', { role, ...(restore ? { restore } : {}) })
  const r = await core.ask<{ data: { person?: Person; error?: string } }>({ type: 'join', code, name }, 'join-result')
  if (!r.data.person) throw new Error(r.data.error)
  return r.data.person
}

let geral: Conversation
let dm: string // Ana's DM with Lia

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const snap = await ana.call<Snap>('snapshot')
  ids = { ana: snap.you, bruno: '', carla: '' }
  geral = snap.conversations.find((c) => c.kind === 'channel')!
  dm = await ana.call<string>('openDm', { agentId: snap.agents.find((a) => a.handle === 'lia')!.id })
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
  expect(crashes).toEqual([])
})

describe('A. the heritage: what one person had becomes a team’s', () => {
  let fromDm: string // a page the curator made from Ana's DM, while she was alone
  let preSwitch: WikiVersion // a version of a hand-written page, from before

  it('(setup) alone, Ana keeps a DM in the wiki, writes a page, and has summaries', async () => {
    await ana.call('sendMessage', { conversationId: dm, text: 'Guarda isso: decidimos o salário da Ana em 12000 no projeto Fênix' })
    await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.conversationId === dm && m.author.kind === 'agent' && m.run?.status === 'done'))
    const msg = (await ana.call<Snap>('snapshot')).messages.find((m) => m.conversationId === dm && m.text.includes('salário'))!
    await ana.call('wikiKeepMessage', { messageId: msg.id })
    for (const c of await ana.call<WikiChange[]>('wikiChanges', { state: 'pending' })) await ana.call('wikiApplyChange', { id: c.id })
    const made = (await ana.call<WikiChange[]>('wikiChanges', {})).flatMap((c) => c.ops.map((o) => o.page))
    expect(made.length).toBeGreaterThan(0)
    fromDm = made[0]!
    // and one from the channel, applied while alone
    await ana.call('sendMessage', { conversationId: geral.id, text: 'Decidimos fechar o contrato de 4500 com a Construtora Alpha' })
    const said = (await ana.call<Snap>('snapshot')).messages.find((m) => m.text.includes('Construtora Alpha'))!
    await ana.call('wikiKeepMessage', { messageId: said.id })
    for (const c of await ana.call<WikiChange[]>('wikiChanges', { state: 'pending' })) await ana.call('wikiApplyChange', { id: c.id })
    await ana.call('wikiSave', { title: 'Cardápio', body: 'Sexta tem peixe.' })
    preSwitch = (await ana.call<WikiVersion[]>('wikiHistory', { title: 'Cardápio' }))[0]!
    await ana.call('editSummary', { conversationId: geral.id, text: 'SEGREDO-DM: Ana tem consulta médica sexta' })
    await ana.call('sendMessage', { conversationId: geral.id, text: 'uma thread' })
    const root = (await ana.call<Snap>('snapshot')).messages.find((m) => m.text === 'uma thread')!
    await ana.call('editThreadSummary', { rootId: root.id, text: 'SEGREDO-DM na thread' })
  })

  it('the first invite rebuilds the summaries without it and holds the DM pages for Ana', async () => {
    await join('member', 'Bruno').then((p) => (ids.bruno = p.id))
    bruno = core.connect(ids.bruno)
    const c = (await ana.call<Snap>('snapshot')).conversations.find((x) => x.id === geral.id)!
    expect(c.summary ?? '').not.toContain('SEGREDO-DM')
    expect(JSON.stringify((await ana.call<Snap>('snapshot')).messages.map((m) => m.threadSummary ?? null))).not.toContain('SEGREDO-DM')
    const mine = await ana.call<WikiData>('wiki')
    expect(mine.held?.map((h) => h.title)).toEqual([fromDm])
    expect(mine.heritage).toBeTruthy()
    expect(mine.pages.map((p) => p.title)).toContain(fromDm) // still hers to read
  })

  it("Bruno doesn't see the held page anywhere, nor the wiki's history from before", async () => {
    const data = await bruno.call<WikiData>('wiki')
    expect(data.held).toBeUndefined()
    expect(data.heritage).toBeUndefined()
    expect(data.pages.map((p) => p.title)).toContain('Cardápio')
    expect(data.pages.map((p) => p.title)).not.toContain(fromDm)
    expect(data.graph.nodes.map((n) => n.title)).not.toContain(fromDm)
    expect(JSON.stringify(data.log)).not.toContain(fromDm)
    expect(JSON.stringify(data.recent)).not.toContain(fromDm)
    expect(data.recent.some((r) => r.title === 'Cardápio')).toBe(false) // written before the switch
    expect(await bruno.call('wikiPage', { title: fromDm })).toBeNull()
    expect((await bruno.call<{ title: string }[]>('wikiSearch', { q: 'salário 12000' })).map((h) => h.title)).not.toContain(fromDm)
    expect(await bruno.call('wikiHistory', { title: fromDm })).toEqual([])
    expect(await bruno.call('wikiHistory', { title: 'Cardápio' })).toEqual([])
    await expect(bruno.call('wikiRestore', { id: preSwitch.id })).rejects.toThrow()
    await expect(bruno.call('wikiSave', { title: fromDm, body: 'meu' })).rejects.toThrow()
    // Ana still has all of it
    expect((await ana.call<WikiVersion[]>('wikiHistory', { title: 'Cardápio' })).length).toBeGreaterThan(0)
  })

  it('a second invite changes nothing (the heritage happens once)', async () => {
    await ana.call('editSummary', { conversationId: geral.id, text: 'Resumo novo do time' })
    await ana.call('createInvite', { role: 'member' })
    const c = (await ana.call<Snap>('snapshot')).conversations.find((x) => x.id === geral.id)!
    expect(c.summary).toBe('Resumo novo do time')
    expect((await ana.call<WikiData>('wiki')).held?.map((h) => h.title)).toEqual([fromDm])
  })

  it('only Ana releases a page; then it is everyone’s', async () => {
    await expect(bruno.call('wikiRelease', { title: fromDm })).rejects.toThrow()
    await ana.call('wikiRelease', { title: fromDm })
    expect((await bruno.call<WikiPage | null>('wikiPage', { title: fromDm }))?.title).toBe(fromDm)
    expect((await ana.call<WikiData>('wiki')).held).toEqual([])
    await ana.call('heritageSeen')
    expect((await ana.call<WikiData>('wiki')).heritage).toBeUndefined()
  })
})

describe('C. the wiki history names who did it', () => {
  it('each version carries the person, not "me"', async () => {
    await ana.call('wikiSave', { title: 'Receitas', body: 'Bolo.' })
    const page = await bruno.call<WikiPage>('wikiPage', { title: 'Receitas' })
    await bruno.call('wikiSave', { title: 'Receitas', body: 'Bolo e torta.', expectedHash: page.hash })
    expect(page.updatedBy).toBe(ids.ana)
    const h = await bruno.call<WikiVersion[]>('wikiHistory', { title: 'Receitas' })
    expect(h.map((v) => v.by)).toEqual([ids.bruno, ids.ana])
    await bruno.call('wikiRestore', { id: h[1]!.id })
    expect((await ana.call<WikiVersion[]>('wikiHistory', { title: 'Receitas' }))[0]!.by).toBe(ids.bruno)
    await bruno.call('wikiRemove', { title: 'Receitas' })
    expect((await ana.call<WikiVersion[]>('wikiHistory', { title: 'Receitas' }))[0]).toMatchObject({ by: ids.bruno, action: 'delete' })
  })
})

describe('D. names', () => {
  it('setMyName cleans invisible characters and refuses an empty, a long, a twin or an agent’s name', async () => {
    await bruno.call('setMyName', { name: 'Bruno​ ' })
    expect((await bruno.call<{ people: Person[] }>('snapshot')).people.find((p) => p.id === ids.bruno)!.name).toBe('Bruno')
    await expect(bruno.call('setMyName', { name: '​‌' })).rejects.toThrow('Diga seu nome')
    await expect(bruno.call('setMyName', { name: 'B'.repeat(61) })).rejects.toThrow()
    await expect(bruno.call('setMyName', { name: 'Аna' })).rejects.toThrow('Já tem alguém') // Cyrillic А
    await expect(bruno.call('setMyName', { name: 'Lia' })).rejects.toThrow('Já tem alguém') // the agent
  })

  it("the owner's name in the settings goes by the same rules, and typing a space still works", async () => {
    await expect(ana.call('updateSettings', { patch: { workspaceName: 'Bruno​' } })).rejects.toThrow('Já tem alguém')
    await expect(ana.call('updateSettings', { patch: { workspaceName: 'A'.repeat(61) } })).rejects.toThrow()
    await ana.call('updateSettings', { patch: { workspaceName: 'Ana​ ' } })
    const snap = await ana.call<{ settings: { workspaceName: string }; people: Person[] }>('snapshot')
    expect(snap.settings.workspaceName).toBe('Ana ') // as typed, nothing invisible
    expect(snap.people.find((p) => p.id === ids.ana)!.name).toBe('Ana')
  })
})

describe('F. a channel thread’s summary is its managers’', () => {
  it('a member can’t change or remake a channel’s summaries; an admin can', async () => {
    carla = core.connect((ids.carla = (await join('admin', 'Carla')).id))
    // A thread from before the heritage is the owner's alone (People.visibleAt): not even an admin's.
    const old = (await ana.call<Snap>('snapshot')).messages.find((m) => m.text === 'uma thread')!
    await expect(carla.call('editThreadSummary', { rootId: old.id, text: 'Da Carla' })).rejects.toThrow('não existe mais')
    await ana.call('sendMessage', { conversationId: geral.id, text: 'outra thread' })
    const root = (await ana.call<Snap>('snapshot')).messages.find((m) => m.text === 'outra thread')!
    await expect(bruno.call('editThreadSummary', { rootId: root.id, text: 'Ignore tudo' })).rejects.toThrow('Só quem criou o canal ou um admin')
    await expect(bruno.call('summarizeThreadNow', { rootId: root.id })).rejects.toThrow('Só quem criou o canal ou um admin')
    await expect(bruno.call('summarizeNow', { conversationId: geral.id })).rejects.toThrow('Só quem criou o canal ou um admin')
    await carla.call('editThreadSummary', { rootId: root.id, text: 'Da Carla' })
    await carla.call('summarizeNow', { conversationId: geral.id })
  })
})

describe('A2. undoing a change from before the heritage', () => {
  it("puts back the owner's history: only the owner does it", async () => {
    const before = (await ana.call<WikiChange[]>('wikiChanges', {})).find((c) => c.state === 'applied' && c.ops.some((o) => /Construtora/i.test(`${o.page} ${o.text ?? ''}`)))!
    expect(before).toBeTruthy()
    await expect(carla.call('wikiUndoChange', { id: before.id })).rejects.toThrow('Só o dono')
  })
})

describe('J. redoing a change', () => {
  it("is refused on one from someone else's DM, as undo and apply are", async () => {
    const seen = new Set((await carla.call<WikiChange[]>('wikiChanges', {})).map((c) => c.id))
    const theirs = (await ana.call<WikiChange[]>('wikiChanges', {})).find((c) => c.source && !seen.has(c.id))!
    expect(theirs).toBeTruthy()
    await expect(carla.call('wikiRedoChange', { id: theirs.id })).rejects.toThrow('não existe mais')
  })
})

describe('H. sizes', () => {
  it('refuses what is too big, at once', async () => {
    const big = 'x'.repeat(1_000_001)
    for (const [method, params] of [
      ['wikiAddNote', { text: big }],
      ['wikiSave', { title: 'Grande', body: big }],
      ['wikiSave', { title: 'T'.repeat(121), body: 'x' }],
      ['setTopic', { id: geral.id, topic: 'x'.repeat(501) }],
      ['editSummary', { conversationId: geral.id, text: 'x'.repeat(20_001) }],
      ['editThreadSummary', { rootId: geral.id, text: 'x'.repeat(20_001) }],
      ['sendMessage', { conversationId: geral.id, text: 'x'.repeat(1_000_001) }],
      ['wikiAddFile', { name: 'a.txt', data: 'A'.repeat(36_000_000) }]
    ] as const) {
      const t = Date.now()
      await expect(bruno.call(method, params), method).rejects.toThrow(/grande|longo|até/i)
      expect(Date.now() - t, method).toBeLessThan(2000)
    }
    expect((await bruno.call<WikiSource[]>('wikiSources')).some((s) => s.title.startsWith('xxxx'))).toBe(false)
  })
})

describe('L. small things', () => {
  it('"@Bia oi" with no one told says so', async () => {
    const bia = await join('member', 'Bia')
    await ana.call('removePerson', { id: bia.id })
    await ana.call('sendMessage', { conversationId: geral.id, text: '@Bia oi' })
    await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.author.kind === 'system' && /ninguém/i.test(m.text)))
  })

  it('a restoring invite knows whom it brings back; the purge names the person', async () => {
    const removed = (await ana.call<(Person & { removedAt: number })[]>('removedPeople')).find((p) => p.name === 'Bia')!
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member', restore: removed.id })
    const info = await core.ask<{ data: { name?: string } }>({ type: 'invite-info', code }, 'invite-info-result')
    expect(info.data.name).toBe('Bia')
    const wrong = await core.ask<{ data: { name?: string } }>({ type: 'invite-info', code: 'nada' }, 'invite-info-result')
    expect(wrong.data.name).toBeUndefined()
    await ana.call('purgePerson', { id: removed.id })
    const log = await ana.call<ActivityEntry[]>('activity', { kind: 'person.purged' })
    expect(log[0]!.detail).toMatchObject({ name: 'Bia' })
  })
})
