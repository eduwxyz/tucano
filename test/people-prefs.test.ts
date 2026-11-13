// Tucano Team: how the app looks (theme, sounds, sidebar, language…) is each person's own. On a
// server one member changing it doesn't change it for everyone; the owner's stay in the settings,
// so a desktop (one person) works as always.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Person, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { Hub, People, type PortLike } from '../src/core/people'
import { can } from '../src/core/policy-people'

const ready = { installed: true, loggedIn: true }
const base: Settings = {
  workspaceName: 'Ana',
  context: '',
  engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready },
  routerModel: 'haiku',
  memoryModel: 'haiku',
  memoryLearning: 'auto',
  defaultLimit: 1000,
  approvalTtlHours: 24,
  theme: 'dark',
  language: 'pt',
  sounds: false,
  folded: ['section:dms'],
  channelLayout: { loose: ['c1'], groups: [] },
  seenVersion: '0.2.10',
  onboarding: { done: true }
}

class FakePort implements PortLike {
  got: CoreEvent[] = []
  postMessage(msg: unknown): void {
    const m = msg as { event?: CoreEvent }
    if (m.event) this.got.push(m.event)
  }
  close(): void {}
}

function team(): { db: Db; people: People; ana: Person; bia: Person; dani: Person } {
  const db = new Db(':memory:')
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const ana = db.owner()
  const join1 = (name: string, role: 'member' | 'admin'): Person => {
    const r = people.join(people.createInvite(ana, { role }).code, name)
    if (!('person' in r)) throw new Error(r.error)
    return r.person
  }
  return { db, people, ana, bia: join1('Bia', 'member'), dani: join1('Dani', 'admin') }
}

describe('display preferences per person', () => {
  it("the owner's are the settings, untouched: a desktop works as always", () => {
    const { people, ana } = team()
    expect(people.settingsFor(ana, base)).toBe(base)
    const rest = people.takePrefs(ana, { theme: 'light', sounds: true, context: 'x' })
    expect(rest).toEqual({ theme: 'light', sounds: true, context: 'x' }) // all saved in the settings, as before
  })

  it("someone else starts with the Tucano's theme and language, no sidebar or sounds of the owner's, and never the setup introduction", () => {
    const { people, bia } = team()
    // Someone who joins gets their own short welcome (who invited them), never the setup introduction.
    expect(people.settingsFor(bia, { ...base, onboarding: { done: false } }).onboarding).toEqual({ done: true, guest: { by: 'Ana' } })
    const s = people.settingsFor(bia, base)
    expect(s.theme).toBe('dark')
    expect(s.language).toBe('pt')
    expect(s.onboarding).toEqual({ done: true, guest: { by: 'Ana' } })
    // Once they're in, it's the plain done.
    people.takePrefs(bia, { onboarding: { done: true } })
    expect(people.settingsFor(bia, base).onboarding).toEqual({ done: true })
    expect(s.seenVersion).toBe('0.2.10')
    expect(s.sounds).toBeUndefined()
    expect(s.folded).toBeUndefined()
    expect(s.channelLayout).toBeUndefined()
    expect(s.workspaceName).toBe('Ana') // the rest is the Tucano's
  })

  it("a member's change is kept on them only; the shared part comes back for the settings", () => {
    const { db, people, ana, bia, dani } = team()
    const rest = people.takePrefs(bia, { theme: 'light', language: 'en', sounds: true, folded: ['section:agents'], channelLayout: { loose: [], groups: [] }, seenVersion: '0.3.0', onboarding: { done: true, checklistHidden: true } })
    expect(rest).toEqual({})
    const s = people.settingsFor(bia, base)
    expect(s).toMatchObject({ theme: 'light', language: 'en', sounds: true, folded: ['section:agents'], seenVersion: '0.3.0', onboarding: { done: true, checklistHidden: true } })
    // Nobody else's changed.
    expect(people.settingsFor(ana, base)).toBe(base)
    expect(people.settingsFor(dani, base).theme).toBe('dark')
    // An admin's mixed change: the theme is theirs, the context the Tucano's.
    expect(people.takePrefs(dani, { theme: 'light', context: 'novo' })).toEqual({ context: 'novo' })
    const { onboarding: _welcome, ...prefs } = db.prefs(dani.id)
    expect(prefs).toEqual({ theme: 'light' })
    // Kept across changes: one key at a time.
    people.takePrefs(bia, { theme: 'system' })
    expect(people.settingsFor(bia, base)).toMatchObject({ theme: 'system', language: 'en' })
  })

  it('members may change only their own display preferences', () => {
    const { bia } = team()
    for (const k of ['theme', 'sounds', 'replyShortcut', 'channelLayout', 'folded', 'language', 'seenVersion', 'onboarding']) expect(can(bia, { kind: 'settings', keys: [k] })).toBe(true)
    for (const k of ['workspaceName', 'context', 'paused', 'routerModel', 'approvalTtlHours']) expect(can(bia, { kind: 'settings', keys: [k] })).toBe(false)
  })

  it('keeps the reply shortcut personal, with its own default for each member', () => {
    const { db, people, ana, bia, dani } = team()
    const ownerSettings = { ...base, replyShortcut: false }
    expect(people.settingsFor(ana, ownerSettings).replyShortcut).toBe(false)
    expect(people.settingsFor(bia, ownerSettings).replyShortcut).toBeUndefined()
    expect(people.takePrefs(bia, { replyShortcut: false })).toEqual({})
    expect(db.prefs(bia.id).replyShortcut).toBe(false)
    expect(people.settingsFor(bia, base).replyShortcut).toBe(false)
    expect(people.settingsFor(dani, base).replyShortcut).toBeUndefined()
    expect(base.replyShortcut).toBeUndefined()
  })

  it("each one's settings event and snapshot carry their own preferences", () => {
    const { db, people, ana, bia } = team()
    const hub = new Hub<FakePort>(people, db)
    const pa = new FakePort()
    const pb = new FakePort()
    hub.add(pa, null)
    hub.add(pb, { person: bia.id })
    people.takePrefs(bia, { theme: 'light' })
    hub.emit({ type: 'settings', settings: base })
    const got = (p: FakePort): Settings => (p.got.find((e) => e.type === 'settings') as Extract<CoreEvent, { type: 'settings' }>).settings
    expect(got(pa).theme).toBe('dark')
    expect(got(pb).theme).toBe('light')
    const snap = (p: Person) => people.snapshotFor(p, { settings: base, agents: [], messages: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac', packaged: false, isolatedComputers: false })
    expect(snap(ana).settings.theme).toBe('dark')
    expect(snap(bia).settings.theme).toBe('light')
  })

  it('a database from before keeps working: the column starts empty, and the people list says when each was seen', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tucano-prefs-')), 'db.sqlite')
    const db = new Db(file)
    expect(db.prefs(db.ownerId())).toEqual({})
    const people = new People(db)
    const r = people.join(people.createInvite(db.owner(), { role: 'member' }).code, 'Bia')
    if (!('person' in r)) throw new Error(r.error)
    people.authenticate(r.key)
    const bia = db.people().find((p) => p.id === r.person.id)!
    expect(bia.devices).toBe(1)
    expect(bia.seenAt).toBeGreaterThan(0)
    db.close()
  })
})

describe("a member's card that only an admin applies", () => {
  it("waits in the admins' inbox (the card, not the member's DM) until applied or dismissed", () => {
    const { db, people, ana, bia, dani } = team()
    db.saveAgent({ id: 'tuca', name: 'Tuca', handle: 'tuca', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, kind: 'tuca' })
    db.createConversation({ id: 'dm-bia', kind: 'dm', name: 'tuca', members: ['tuca'], owner: bia.id })
    const card = { id: 'm1', conversationId: 'dm-bia', author: { kind: 'agent' as const, id: 'tuca' }, text: 'Montei a proposta', at: 1, run: { status: 'done' as const, proposal: { kind: 'team' as const, agents: [] } } }
    db.saveMessage(card as never)
    expect(people.forwarded(dani, 'm1')).toBe(false) // not sent yet: Bia's DM is hers
    db.addActivity({ personId: bia.id, kind: 'proposal.forwarded', target: 'm1', detail: { kind: 'team' } })
    expect(people.inbox(ana).proposals?.map((p) => [p.id, p.by])).toEqual([['m1', bia.id]])
    expect(people.inbox(dani).proposals?.length).toBe(1)
    expect(people.inbox(bia).proposals).toBeUndefined()
    expect(people.forwarded(dani, 'm1')).toBe(true)
    expect(people.forwarded(bia, 'm1')).toBe(false)
    db.saveMessage({ ...card, run: { ...card.run, proposal: { ...card.run.proposal, state: 'applied' } } } as never)
    expect(people.inbox(ana).proposals).toBeUndefined()
  })
})
