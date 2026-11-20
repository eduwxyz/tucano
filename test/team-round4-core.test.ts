// Tucano Team v1, fourth round: what the real core answers each person over its API (fake engines).
// One core for the whole file: the describes run in order and build on each other.
import { rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ActivityEntry, ComputerInfo, Conversation, Message, Person, Settings, WikiPage, WikiVersion } from '../src/shared/types'
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
type Snap = { you: string; agents: { id: string; handle: string }[]; conversations: Conversation[]; messages: Message[]; computers: ComputerInfo[]; settings: Settings & Record<string, unknown> }
type WikiData = { dir: string; pages: { title: string }[]; log: string[]; recent: { title: string }[] }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

let dm: string
// Ana, alone, has the curator keep a message of her DM: the page it makes, by its title.
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
  dm = await ana.call<string>('openDm', { agentId: snap.agents.find((a) => a.handle === 'lia')!.id })
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
  expect(crashes).toEqual([])
})

describe('A. the heritage by one key per page', () => {
  let slash: string // "Plano A/B ...": its file (and title) is "Plano A-B ..."
  let renamed: string
  let gone: string
  it('(setup) alone, Ana has pages from her DM and a page made and deleted by hand', async () => {
    slash = await fromDm('Plano A/B 3333 Zeta. Fica assim.')
    renamed = await fromDm('Rotak 3434 entrega. Fica assim.')
    gone = await fromDm('Viagem 8888 Lisboa. Fica assim.')
    expect(slash).toContain('A-B')
    await ana.call('wikiSave', { title: 'Rascunho solo', body: 'nada' })
    await ana.call('wikiRemove', { title: 'Rascunho solo' })
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
    const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
    bia = core.connect(r.data.person!.id)
    expect((await ana.call<{ held?: { title: string }[] }>('wiki')).held?.map((h) => h.title).sort()).toEqual([slash, renamed, gone].sort())
  })

  it("Bia reads no held page by another spelling, and can't save over one or tell it from a free name", async () => {
    for (const t of [` ${slash}`, `${slash}\n`, `\t${slash}`, slash.replace('A-B', 'A/B'), slash.replace('A-B', 'a:b'), slash.normalize('NFD')]) expect(await bia.call('wikiPage', { title: t })).toBeNull()
    const refused = await err(bia.call('wikiSave', { title: slash.replace('A-B', 'A/B'), body: 'da Bia' }))
    expect(refused).not.toBe('ok')
    expect(refused).not.toMatch(/Já existe|already/)
    expect((await ana.call<WikiPage>('wikiPage', { title: slash })).body).not.toContain('da Bia')
  })

  it('the log Bia reads starts at the switch; the wiki folder is not hers to know', async () => {
    const data = await bia.call<WikiData>('wiki')
    expect(data.log.join('\n')).not.toMatch(/Rascunho solo|Plano A|Rotak|Viagem/)
    expect(data.dir).toBe('')
    expect((await ana.call<WikiData>('wiki')).dir).not.toBe('')
  })

  it('renamed by Ana, a held page leaves nothing under its old title', async () => {
    const page = await ana.call<WikiPage>('wikiPage', { title: renamed })
    await ana.call('wikiSave', { title: 'Rota nova', body: page.body, rename: renamed, expectedHash: page.hash })
    expect(await bia.call('wikiHistory', { title: renamed })).toEqual([])
    const versions = await ana.call<WikiVersion[]>('wikiHistory', { title: 'Rota nova' })
    for (const v of versions) expect(await err(bia.call('wikiRestore', { id: v.id }))).not.toBe('ok')
    expect(JSON.stringify((await bia.call<WikiData>('wiki')).recent)).not.toMatch(/Rotak|Rota nova/)
    expect(await bia.call('wikiPage', { title: renamed })).toBeNull()
  })

  it('released by another spelling, the activity names the page as it is', async () => {
    await ana.call('wikiRelease', { title: ` ${slash.replace('A-B', 'a/b').toLowerCase()}` })
    const entry = (await ana.call<ActivityEntry[]>('activity', { kind: 'wiki.released' }))[0]!
    expect(entry.detail).toMatchObject({ title: slash })
    expect((await bia.call<WikiPage | null>('wikiPage', { title: slash }))?.title).toBe(slash)
  })

  it("deleted, a held page frees its name: a page made later under it is seen, and none of the old one's history", async () => {
    await ana.call('wikiRemove', { title: gone })
    await bia.call('wikiSave', { title: gone, body: 'do time' })
    expect((await bia.call<WikiPage | null>('wikiPage', { title: gone }))?.body).toContain('do time')
    const history = await bia.call<WikiVersion[]>('wikiHistory', { title: gone })
    expect(history.length).toBe(1)
    expect(JSON.stringify(history)).not.toContain('Fica assim')
  })
})

describe('B. settings take only what they are', () => {
  it('an unknown key, a wrong type or a huge value is refused; a real change goes through', async () => {
    expect(await err(ana.call('updateSettings', { patch: { bogus: 'x' } }))).not.toBe('ok')
    expect(await err(ana.call('updateSettings', { patch: { context: 'x'.repeat(2_000_000) } }))).not.toBe('ok')
    expect(await err(ana.call('updateSettings', { patch: { folded: Array.from({ length: 200_000 }, (_, i) => `id-${i}`) } }))).not.toBe('ok')
    expect(await err(ana.call('updateSettings', { patch: { paused: 'yes' } }))).not.toBe('ok')
    expect(await err(ana.call('updateSettings', { patch: { defaultLimit: 'muito' } }))).not.toBe('ok')
    expect(await err(ana.call('updateSettings', { patch: { theme: 'dark', folded: ['a'] } }))).toBe('ok')
    const s = (await ana.call<Snap>('snapshot')).settings
    expect(s.theme).toBe('dark')
    expect('bogus' in s).toBe(false)
    expect(await err(ana.call('updateSettings', { patch: { quietHours: null } }))).toBe('ok')
  })
})

describe('C. machine paths', () => {
  it("a computer's folder reaches the owner only", async () => {
    expect((await ana.call<Snap>('snapshot')).computers.some((c) => isAbsolute(c.folder))).toBe(true)
    expect((await bia.call<Snap>('snapshot')).computers.every((c) => c.folder === '')).toBe(true)
  })
})

describe('D. a NUL in a name', () => {
  it('is refused with words, not a crash', async () => {
    const note = await err(ana.call('wikiAddNote', { text: 'uma nota', title: 'a\u0000b' }))
    const file = await err(ana.call('wikiAddFile', { name: 'a\u0000.txt', data: Buffer.from('oi').toString('base64') }))
    for (const e of [note, file]) {
      expect(e).not.toBe('ok')
      expect(e).not.toMatch(/TypeError|ERR_INVALID_ARG|null bytes/i)
    }
  })
})
