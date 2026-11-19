import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AUTH_CACHE_MS, Grants, invitePage, joinFields, notifyNote, personNotice, Signins, Streams, UNAUTHORIZED_TEXT, Viewers, type Stream, type Who } from '../src/server/people'
import type { Person } from '../src/shared/types'

const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }

describe("a person's key on the server", () => {
  it('asks the core once, keeps the answer for a while, and never keeps a refusal', async () => {
    let now = 0
    const asked: string[] = []
    const s = new Signins(async (key) => (asked.push(key), key === 'p_good' ? bia : undefined), () => now)
    expect(await s.person('p_good')).toEqual(bia)
    expect(await s.person('p_good')).toEqual(bia)
    expect(asked).toEqual(['p_good'])
    now += AUTH_CACHE_MS + 1
    await s.person('p_good')
    expect(asked).toEqual(['p_good', 'p_good'])
    expect(await s.person('p_bad')).toBeUndefined()
    expect(await s.person('p_bad')).toBeUndefined()
    expect(asked.filter((k) => k === 'p_bad')).toHaveLength(2)
  })

  it('forgets a removed person at once', async () => {
    let removed = false
    const s = new Signins(async () => (removed ? undefined : bia))
    expect(await s.person('p_key')).toEqual(bia)
    removed = true
    expect(await s.person('p_key')).toEqual(bia) // still remembered
    s.forget('bia')
    expect(await s.person('p_key')).toBeUndefined()
  })
})

describe("a person's role changed", () => {
  it('reaches the server at once: the next request carries the new role, and their pages stay', async () => {
    let role: Person['role'] = 'member'
    const signins = new Signins(async () => ({ ...bia, role }))
    const grants = new Grants(async () => role === 'admin')
    expect((await signins.person('p_key'))?.role).toBe('member')
    expect(await grants.may('bia', { port: 1 })).toBe(false)
    const streams = new Streams()
    const open = { who: { person: 'bia', role: 'member' } as Who, got: [] as unknown[], ended: false, send: () => {}, end: () => void (open.ended = true) }
    streams.add('s', open)
    role = 'admin'
    expect(personNotice({ type: 'person-changed', id: 'bia' }, { signins, grants, viewers: new Viewers(), streams })).toBe(true)
    expect((await signins.person('p_key'))?.role).toBe('admin')
    expect(await grants.may('bia', { port: 1 })).toBe(true)
    expect(open.ended).toBe(false)
  })

  it('a removal ends their pages too; anything else is not a notice about people', () => {
    const streams = new Streams()
    const open = { who: { person: 'bia', role: 'member' } as Who, send: () => {}, ended: false, end: () => void (open.ended = true) }
    streams.add('s', open)
    const parts = { signins: new Signins(async () => bia), grants: new Grants(async () => true), viewers: new Viewers(), streams }
    expect(personNotice({ type: 'notify', id: 'bia' }, parts)).toBe(false)
    expect(open.ended).toBe(false)
    expect(personNotice({ type: 'person-removed', id: 'bia' }, parts)).toBe(true)
    expect(open.ended).toBe(true)
  })

  it('the core says so on setRole, and the server listens', () => {
    const core = readFileSync(join(import.meta.dirname, '..', 'src', 'core', 'index.ts'), 'utf8')
    const setRole = core.slice(core.indexOf('  setRole: ('), core.indexOf('  purgePerson: ('))
    expect(setRole).toMatch(/toMain\(\{ type: 'person-changed', id \}\)/)
    const server = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'index.ts'), 'utf8')
    expect(server).toMatch(/personNotice\(msg/)
  })
})

describe('the event streams', () => {
  const stream = (who: Who): Stream & { got: unknown[]; ended: boolean } => {
    const s = { who, got: [] as unknown[], ended: false, send: (m: unknown) => void s.got.push(m), end: () => void (s.ended = true) }
    return s
  }

  it('deliver a notification only to the people it is for; the owner token is the owner', () => {
    const streams = new Streams()
    const owner = stream({ owner: true, role: 'owner' })
    const b1 = stream({ person: 'bia', role: 'member' })
    const b2 = stream({ person: 'bia', role: 'member' })
    const carl = stream({ person: 'carl', role: 'admin' })
    streams.add('o', owner)
    streams.add('b1', b1)
    streams.add('b2', b2)
    streams.add('c', carl)
    streams.deliver('for bia', ['bia'], 'ana')
    streams.deliver('for ana', ['ana'], 'ana')
    streams.deliver('for all', undefined, 'ana')
    expect(owner.got).toEqual(['for ana', 'for all'])
    expect(b1.got).toEqual(['for bia', 'for all'])
    expect(b2.got).toEqual(['for bia', 'for all'])
    expect(carl.got).toEqual(['for all'])
  })

  it("turn the core's notification into what a page shows, and where a click goes", () => {
    const msg = { type: 'notify', title: 'Lia · Lembrete', body: 'Oi!', conversationId: 'c1', threadId: 't1', kind: 'done', sound: true, to: ['bia'] }
    expect(notifyNote(msg)).toEqual({ notify: { title: 'Lia · Lembrete', body: 'Oi!', conversationId: 'c1', threadId: 't1', page: undefined, kind: 'done', sound: true } })
    // Who it's for stays on the server: the page never learns the others.
    expect(JSON.stringify(notifyNote(msg))).not.toContain('bia')
    expect(notifyNote({ title: 'Skill', body: 'nova', page: 'skills', kind: 'evil' })).toEqual({ notify: { title: 'Skill', body: 'nova', conversationId: undefined, page: 'skills' } })
    // A routine's reply for its person (to: [them]) reaches only that person's pages.
    const streams = new Streams()
    const owner = stream({ owner: true, role: 'owner' })
    const bia = stream({ person: 'bia', role: 'member' })
    streams.add('o', owner)
    streams.add('b', bia)
    streams.deliver(notifyNote(msg), msg.to, 'ana')
    expect(bia.got).toHaveLength(1)
    expect(owner.got).toEqual([])
  })

  it("end a removed person's streams, and only theirs", () => {
    const streams = new Streams()
    const b = stream({ person: 'bia', role: 'member' })
    const c = stream({ person: 'carl', role: 'member' })
    streams.add('b', b)
    streams.add('c', c)
    streams.endFor('bia')
    expect([b.ended, c.ended]).toEqual([true, false])
    expect(streams.get('b')).toBeUndefined()
    streams.deliver('after', undefined, undefined)
    expect(b.got).toEqual([])
    expect(c.got).toEqual(['after'])
  })
})

describe('the invite page', () => {
  it("names whose Tucano it is and carries the code, escaped", () => {
    const html = invitePage({ owner: 'Ana <script>', code: 'abc"><x', error: 'Esse convite não vale mais.' })
    expect(html).toContain('Você foi convidado pro Tucano de Ana &lt;script&gt;')
    expect(html).toContain('value="abc&quot;&gt;&lt;x"')
    expect(html).toContain('Esse convite não vale mais.')
    expect(html).not.toContain('<script>')
    expect(html).toContain('action="./join"')
  })

  it('reads the form and JSON alike', () => {
    expect(joinFields('code=a%2Bb&name=Bia+Souza', 'application/x-www-form-urlencoded')).toEqual({ code: 'a+b', name: 'Bia Souza' })
    expect(joinFields('{"code":"c1","name":"Bia"}', 'application/json')).toEqual({ code: 'c1', name: 'Bia' })
    expect(joinFields('not json', 'application/json')).toEqual({ code: '', name: '' })
  })

  it('a browser that is not signed in is told about invites', () => {
    expect(UNAUTHORIZED_TEXT).toMatch(/invite/)
    expect(UNAUTHORIZED_TEXT).toMatch(/convite/)
  })
})
