import { describe, expect, it } from 'vitest'
import type { Account, Settings } from '../src/shared/types'
import { Spent, SPENT_MS, USUAL_LOGIN, loginsInOrder, nextLogin, noLoginLeft, primaryAccountOf } from '../src/shared/primary-login'
import { settingsPatchError } from '../src/core/settings-patch'

const ready = { installed: true, loggedIn: true }
const work: Account = { id: 'w1', engine: 'codex', name: 'Trabalho', loggedIn: true }
const personal: Account = { id: 'p1', engine: 'codex', name: 'Pessoal', loggedIn: true }
const base = (extra: Partial<Settings> = {}): Pick<Settings, 'engines' | 'accounts' | 'primaryAccounts'> => ({
  engines: { codex: ready } as Settings['engines'],
  accounts: [work, personal],
  ...extra
})
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0) // fixed: 22/11/2026 12:00 UTC

describe('the primary login of a harness', () => {
  it('is the usual login when none is picked', () => {
    expect(primaryAccountOf(base(), 'codex')).toBe(USUAL_LOGIN)
  })

  it('is the picked account while it exists for that harness', () => {
    expect(primaryAccountOf(base({ primaryAccounts: { codex: 'p1' } }), 'codex')).toBe('p1')
  })

  it('falls back to the usual login when the picked account was removed or belongs to another harness', () => {
    expect(primaryAccountOf(base({ primaryAccounts: { codex: 'gone' } }), 'codex')).toBe(USUAL_LOGIN)
    expect(primaryAccountOf(base({ primaryAccounts: { claude: 'w1' } }), 'claude')).toBe(USUAL_LOGIN)
  })
})

describe('the order of logins', () => {
  it('is the usual login, then the accounts in the order they were added, when no primary is set', () => {
    expect(loginsInOrder(base(), 'codex').map((l) => l.id)).toEqual([USUAL_LOGIN, 'w1', 'p1'])
  })

  it('puts the primary first, the rest in their order', () => {
    expect(loginsInOrder(base({ primaryAccounts: { codex: 'p1' } }), 'codex').map((l) => l.id)).toEqual(['p1', USUAL_LOGIN, 'w1'])
  })

  it('marks which logins are signed in', () => {
    const logins = loginsInOrder(base({ engines: { codex: { installed: true, loggedIn: false } } as Settings['engines'], accounts: [work, { ...personal, loggedIn: false }] }), 'codex')
    expect(logins.map((l) => l.ready)).toEqual([false, true, false])
  })
})

describe('which login takes the reply', () => {
  it('with no primary set, the usual login, as before', () => {
    const spent = new Spent()
    expect(nextLogin(loginsInOrder(base(), 'codex'), { engine: 'codex', spent, now: NOW })?.id).toBe(USUAL_LOGIN)
  })

  it('uses the primary when it can take the reply', () => {
    const spent = new Spent()
    expect(nextLogin(loginsInOrder(base({ primaryAccounts: { codex: 'p1' } }), 'codex'), { engine: 'codex', spent, now: NOW })?.id).toBe('p1')
  })

  it('moves to the next login in order when the primary is out, and back to it once it has reset', () => {
    const spent = new Spent()
    const logins = loginsInOrder(base({ primaryAccounts: { codex: 'p1' } }), 'codex')
    spent.mark('codex', 'p1', NOW)
    expect(nextLogin(logins, { engine: 'codex', spent, now: NOW })?.id).toBe(USUAL_LOGIN)
    expect(nextLogin(logins, { engine: 'codex', spent, now: NOW + SPENT_MS - 1 })?.id).toBe(USUAL_LOGIN)
    expect(nextLogin(logins, { engine: 'codex', spent, now: NOW + SPENT_MS })?.id).toBe('p1')
  })

  it('tries each login once per reply, so it never loops', () => {
    const spent = new Spent()
    const logins = loginsInOrder(base({ primaryAccounts: { codex: 'p1' } }), 'codex')
    const tried = new Set<string>()
    const order: string[] = []
    for (let next = nextLogin(logins, { engine: 'codex', spent, now: NOW, tried }); next; next = nextLogin(logins, { engine: 'codex', spent, now: NOW, tried })) {
      tried.add(next.id)
      order.push(next.id)
      spent.mark('codex', next.id, NOW) // every login runs out
    }
    expect(order).toEqual(['p1', USUAL_LOGIN, 'w1'])
  })

  it('skips logins that are not signed in', () => {
    const spent = new Spent()
    const settings = base({ primaryAccounts: { codex: 'p1' }, accounts: [work, { ...personal, loggedIn: false }] })
    expect(nextLogin(loginsInOrder(settings, 'codex'), { engine: 'codex', spent, now: NOW })?.id).toBe(USUAL_LOGIN)
  })

  it('says which logins are out and until when, when none is left', () => {
    const spent = new Spent()
    const settings = base({ primaryAccounts: { codex: 'p1' }, accounts: [{ ...work, loggedIn: false }, personal] })
    const logins = loginsInOrder(settings, 'codex')
    spent.mark('codex', 'p1', NOW)
    spent.mark('codex', USUAL_LOGIN, NOW)
    expect(nextLogin(logins, { engine: 'codex', spent, now: NOW })).toBeUndefined()
    const why = noLoginLeft(logins, { engine: 'codex', label: 'Codex', spent, now: NOW })
    expect(why).toContain('Pessoal até')
    expect(why).toContain('login padrão até')
    expect(why).toContain('Trabalho não está logada')
  })
})

describe('the picked primary is kept in the settings', () => {
  it('is accepted as a settings change, and cleared with null', () => {
    expect(settingsPatchError({ primaryAccounts: { codex: 'p1' } })).toBeUndefined()
    expect(settingsPatchError({ primaryAccounts: null })).toBeUndefined()
  })

  it('is refused when it is not an object', () => {
    expect(settingsPatchError({ primaryAccounts: 'p1' })).toBeDefined()
  })
})
