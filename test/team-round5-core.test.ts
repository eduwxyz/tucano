// Tucano Team v1, fifth round: what the real core answers each person over its API (fake engines).
// One core for the whole file: the describes run in order and build on each other.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, WikiChange, WikiPage } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bia: Client // a member
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
type Snap = { you: string; agents: Agent[]; conversations: Conversation[]; messages: Message[] }
type WikiData = { pages: { title: string }[]; log: string[]; recent: { title: string }[] }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

let dm: string
let geral: string
let lia: Agent
async function fromDm(text: string): Promise<string> {
  const before = new Set((await ana.call<WikiData>('wiki')).pages.map((p) => p.title))
  await ana.call('sendMessage', { conversationId: dm, text })
  const msg = (await ana.call<Snap>('snapshot')).messages.find((m) => m.conversationId === dm && m.text === text)!
  await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.conversationId === dm && m.author.kind === 'agent' && m.run?.status === 'done' && m.at >= msg.at))
  await ana.call('wikiKeepMessage', { messageId: msg.id })
  return (await ana.call<WikiData>('wiki')).pages.map((p) => p.title).find((t) => !before.has(t))!
}

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const snap = await ana.call<Snap>('snapshot')
  lia = snap.agents.find((a) => a.handle === 'lia')!
  dm = await ana.call<string>('openDm', { agentId: lia.id })
  geral = snap.conversations.find((c) => c.kind === 'channel')!.id
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
  expect(crashes).toEqual([])
})

describe('A. the heritage: what the channel held before, and the wiki', () => {
  let gone: string
  let renamed: string
  it('(setup) alone, Ana talks in #geral and has pages from her DM; then Bia comes in', async () => {
    await ana.call('sendMessage', { conversationId: geral, text: 'ANTIGA: anotação solo da Ana, sem agente' })
    await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.conversationId === geral && m.text.startsWith('ANTIGA')))
    gone = await fromDm('Viagem 8888 Lisboa. Fica assim.')
    renamed = await fromDm('Rotak 3434 entrega. Fica assim.')
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
    const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
    bia = core.connect(r.data.person!.id)
  })

  it("Bia's snapshot has no channel message from before, one boundary line, and Ana's has them all", async () => {
    const theirs = (await bia.call<Snap>('snapshot')).messages.filter((m) => m.conversationId === geral)
    expect(theirs.map((m) => m.text).join('\n')).not.toMatch(/ANTIGA/)
    const lines = theirs.filter((m) => m.author.kind === 'system')
    expect(lines.length).toBe(1)
    expect(lines[0]!.text).toMatch(/Histórico anterior visível só pro dono/)
    const ours = (await ana.call<Snap>('snapshot')).messages.filter((m) => m.conversationId === geral)
    expect(ours.map((m) => m.text).join('\n')).toMatch(/ANTIGA/)
    expect(ours.some((m) => m.author.kind === 'system' && /Histórico anterior/.test(m.text))).toBe(false) // the router's own notes stay
  })

  it('a held page deleted or renamed by Ana leaves no title in the log Bia reads; applied changes from before are not hers', async () => {
    await ana.call('wikiRemove', { title: gone })
    const page = await ana.call<WikiPage>('wikiPage', { title: renamed })
    await ana.call('wikiSave', { title: 'Rota nova', body: page.body, rename: renamed, expectedHash: page.hash })
    const data = await bia.call<WikiData>('wiki')
    expect(data.log.join('\n')).not.toMatch(/Viagem|Rotak|Rota nova/)
    expect(JSON.stringify(data.recent)).not.toMatch(/Viagem|Rotak|Rota nova/)
    const applied = await bia.call<WikiChange[]>('wikiChanges', { state: 'applied' })
    expect(applied).toEqual([])
    expect((await ana.call<WikiChange[]>('wikiChanges', { state: 'applied' })).length).toBeGreaterThan(0)
    // the owner's own log still says it
    expect((await ana.call<WikiData>('wiki')).log.join('\n')).toMatch(/Viagem/)
  })

  it('restoring a deleted held page where Bia made her own holds it again and tells Ana', async () => {
    await bia.call('wikiSave', { title: gone, body: 'do time' })
    const versions = await ana.call<{ id: number; action: string }[]>('wikiHistory', { title: gone })
    const old = versions.find((v) => v.action === 'create' && versions.indexOf(v) === versions.map((x) => x.action).lastIndexOf('create'))!
    const before = core.toMain.length
    const restored = await ana.call<WikiPage>('wikiRestore', { id: old.id })
    expect(restored.body).toContain('Fica assim')
    expect(await bia.call('wikiPage', { title: gone })).toBeNull()
    expect(core.toMain.slice(before).some((m) => m['type'] === 'notify' && /guardada pra você/.test(String(m['title'])))).toBe(true)
  })
})

describe('B. names, titles and wordings over the API', () => {
  it('an agent may not take @lia again, nor be called like a person; the error is readable', async () => {
    const fresh = (over: Partial<Agent>): Agent => ({ ...lia, id: 'novo-agente', name: 'Novo', handle: 'novo', ...over })
    const dup = await err(ana.call('saveAgent', { agent: fresh({ handle: 'lia' }), channelIds: [] }))
    expect(dup).toMatch(/@lia/)
    expect(dup).not.toMatch(/Algo deu errado|UNIQUE/)
    expect(await err(ana.call('saveAgent', { agent: fresh({ name: 'Bia.' }), channelIds: [] }))).toMatch(/pessoa/)
    expect(await err(ana.call('saveAgent', { agent: fresh({ handle: 'bia' }), channelIds: [] }))).toMatch(/pessoa/)
    expect(await err(ana.call('saveAgent', { agent: fresh({}), channelIds: [] }))).toBe('ok')
  })
  it('a title of invisible characters is refused; one with them inside is the plain title', async () => {
    expect(await err(ana.call('wikiSave', { title: '​‎', body: 'x' }))).toMatch(/título/)
    expect((await ana.call<WikiPage>('wikiSave', { title: 'Pla​no\u0007 X', body: 'x' })).title).toBe('Plano X')
    expect((await ana.call<WikiPage>('wikiPage', { title: 'Plano X' }))?.title).toBe('Plano X')
  })
  it('an unknown setting is refused in plain words', async () => {
    expect(await err(ana.call('updateSettings', { patch: { quota: 1 } }))).toBe('Essa configuração não existe.')
  })
})
