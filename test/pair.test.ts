// Signing a phone in: one-time codes (src/server/pair-codes.ts) that become a key of a person's own
// (People.deviceKey), for the owner as for anyone invited.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { People } from '../src/core/people'
import { browserName, CODE_MINUTES, codeMinutes, deviceLabel, MAX_CODE_MINUTES, PairCodes } from '../src/server/pair-codes'
import { Doors, signIn } from '../src/server/guard'
import { pairingLink, parsePairing } from '../src/shared/servers'

const file = (): string => join(mkdtempSync(join(tmpdir(), 'tucano-pair-')), 'pair-codes.json')

describe('one-time pairing codes', () => {
  it('are good once, for whom they were made, and the file keeps only their hash', () => {
    const f = file()
    const codes = new PairCodes(f)
    const { code, expiresAt } = codes.make('bia')
    expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(expiresAt - Date.now()).toBeGreaterThan((CODE_MINUTES - 1) * 60_000)
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600) // Windows has no Unix modes
    expect(readFileSync(f, 'utf8')).not.toContain(code)
    expect(codes.spend(code)).toEqual({ person: 'bia' })
    expect(codes.spend(code)).toBeUndefined()
  })

  it("are the owner's when made with no one (the server's `pair`)", () => {
    const codes = new PairCodes(file())
    expect(codes.spend(codes.make(null).code)).toEqual({ person: null })
  })

  it('are spent even when late, and a wrong or odd one opens nothing', () => {
    let now = 1_000_000
    const codes = new PairCodes(file(), () => now)
    const { code } = codes.make(null, 1)
    now += 61_000
    expect(codes.spend(code)).toBeUndefined()
    now -= 61_000
    expect(codes.spend(code)).toBeUndefined() // gone, not just late
    for (const x of ['', 'short', 'x'.repeat(65), 'a b c d e f g h i j k', 42, null]) expect(codes.spend(x)).toBeUndefined()
  })

  it('made by another process (`server.js pair`) are seen by the running server', () => {
    const f = file()
    const server = new PairCodes(f)
    expect(server.spend('A'.repeat(24))).toBeUndefined() // read once, empty
    const { code } = new PairCodes(f).make(null)
    expect(server.spend(code)).toEqual({ person: null })
  })

  it('last whole minutes, one to a week', () => {
    expect(codeMinutes(undefined)).toBe(CODE_MINUTES)
    expect(codeMinutes('abc')).toBe(CODE_MINUTES)
    expect(codeMinutes('0')).toBe(CODE_MINUTES)
    expect(codeMinutes('-5')).toBe(1)
    expect(codeMinutes('30')).toBe(30)
    expect(codeMinutes(String(10 * MAX_CODE_MINUTES))).toBe(MAX_CODE_MINUTES)
  })

  it('name the device from what it says, never trusting it', () => {
    expect(deviceLabel('iPhone de Ana', 'iOS')).toBe('iPhone de Ana · ios')
    expect(deviceLabel('a\u0000b‮c', undefined)).toBe('a b c')
    expect(deviceLabel(undefined, undefined)).toBe('Aparelho')
    expect(deviceLabel('x'.repeat(500), 'p'.repeat(50)).length).toBeLessThanOrEqual(80 + 3 + 20)
    expect(browserName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone')
  })
})

describe('the link a code makes', () => {
  it('carries the code, not a token, and the token link still reads', () => {
    expect(pairingLink({ origin: 'https://ana.example.com', code: 'abcDEF123_-abcDEF123_-ab' })).toBe('tucano://connect?url=https%3A%2F%2Fana.example.com&code=abcDEF123_-abcDEF123_-ab')
    const p = { origin: 'https://ana.example.com', token: 'abcdefghijklmnopqrstuvwxyz' }
    expect(parsePairing(pairingLink(p))).toEqual(p)
  })
})

describe('a key of a device of its own', () => {
  const team = (): { db: Db; people: People } => {
    const db = new Db(':memory:')
    db.renamePerson(db.ownerId(), 'Ana')
    return { db, people: new People(db) }
  }

  it("signs the owner in as themselves, counted as one more device", () => {
    const { db, people } = team()
    const out = people.deviceKey(null, 'iPhone de Ana · ios')!
    expect(out.key).toMatch(/^p_[\w-]{43}$/)
    const who = people.authenticate(out.key)!
    expect(who.id).toBe(db.ownerId())
    expect(who.role).toBe('owner')
    expect(db.people().find((p) => p.id === db.ownerId())!.devices).toBe(1)
  })

  it('signs someone invited in as them, and stops when they are removed', () => {
    const { db, people } = team()
    const { code } = people.createInvite(db.owner(), { role: 'member' })
    const joined = people.join(code, 'Bia')
    if (!('person' in joined)) throw new Error(joined.error)
    const phone = people.deviceKey(joined.person.id, 'iPhone · ios')!
    expect(people.authenticate(phone.key)!.id).toBe(joined.person.id)
    expect(db.people().find((p) => p.id === joined.person.id)!.devices).toBe(2) // the invite's browser and the phone
    people.remove(db.owner(), joined.person.id)
    expect(people.authenticate(phone.key)).toBeUndefined()
    expect(people.removedKey(phone.key)).toBe(true)
    expect(people.deviceKey(joined.person.id, 'x')).toBeUndefined()
  })

  it('is no one for an unknown person', () => {
    expect(team().people.deviceKey('nobody', 'x')).toBeUndefined()
    expect(team().people.deviceKey(42, 'x')).toBeUndefined()
  })

  it("opens the server for the owner by a person's key, never by guessing", async () => {
    const { people } = team()
    const { key } = people.deviceKey(null, 'phone')!
    const lookup = async (k: string) => ({ person: people.authenticate(k) })
    const base = { ip: '1.2.3.4', doors: new Doors(), isOwnerToken: () => false, strongOwnerToken: true, lookup }
    const r = await signIn({ ...base, cookie: key })
    expect(r.status).toBe('person')
    expect(r.status === 'person' && r.person.role).toBe('owner')
    expect((await signIn({ ...base, cookie: `p_${'x'.repeat(43)}` })).status).toBe('unauthorized')
  })
})
