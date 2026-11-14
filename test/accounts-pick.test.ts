import { describe, expect, it } from 'vitest'
import { leftOf, loginsOf, NEARLY_OUT, pickLogin, SPENT_MS, SWITCH_GAP, spentQuota, USUAL_LOGIN, type Login } from '../src/shared/accounts'
import type { Account, Settings } from '../src/shared/types'

const NOW = 1_000_000_000
const ready = { installed: true, loggedIn: true }
const win = (utilization: number, resetsAt = NOW + 3_600_000) => [{ minutes: 300, utilization, resetsAt }]
const login = (id: string, used?: number): Login => ({ id, ...(used === undefined ? {} : { windows: win(used) }) })

describe('leftOf', () => {
  it('counts a login that never reported as full (pickLogin still waits for its check)', () => {
    expect(leftOf({}, NOW)).toBe(1)
    expect(leftOf({ windows: [] }, NOW)).toBe(1)
  })

  it('goes by the tightest window', () => {
    const windows = [...win(0.2), { minutes: 10_080, utilization: 0.9, resetsAt: NOW + 86_400_000 }]
    expect(leftOf({ windows }, NOW)).toBeCloseTo(0.1)
  })

  it('counts a window past its reset as empty', () => {
    expect(leftOf({ windows: win(0.95, NOW - 1) }, NOW)).toBe(1)
    expect(leftOf({ windows: win(0.95, NOW + 1) }, NOW)).toBeCloseTo(0.05)
  })
})

describe('loginsOf', () => {
  const work: Account = { id: 'w1', engine: 'claude', name: 'Trabalho', loggedIn: true }
  const out: Account = { id: 'w2', engine: 'claude', name: 'Saiu', loggedIn: false }
  const other: Account = { id: 'c1', engine: 'codex', name: 'Codex', loggedIn: true }
  const base = { engines: { claude: ready, codex: ready }, accounts: [work, out, other] } as unknown as Settings

  it('puts the usual login first, then the signed-in accounts of that engine', () => {
    expect(loginsOf(base, 'claude').map((l) => l.id)).toEqual([USUAL_LOGIN, 'w1'])
    expect(loginsOf(base, 'codex').map((l) => l.id)).toEqual([USUAL_LOGIN, 'c1'])
  })

  it('leaves out the usual login when it is signed out, and engines without accounts', () => {
    const s = { ...base, engines: { ...base.engines, claude: { installed: true, loggedIn: false } } } as Settings
    expect(loginsOf(s, 'claude').map((l) => l.id)).toEqual(['w1'])
    expect(loginsOf(base, 'pi')).toEqual([])
  })

  it('carries each login’s windows', () => {
    const s = { ...base, quota: { fiveHour: { utilization: 0.4, resetsAt: NOW }, at: 5 }, accountQuota: { w1: { fiveHour: { utilization: 0.7, resetsAt: NOW }, at: 9 } } } as Settings
    const [usual, acct] = loginsOf(s, 'claude')
    expect(usual!.windows?.[0]?.utilization).toBe(0.4)
    expect(acct!.windows?.[0]?.utilization).toBe(0.7)
    expect(acct!.at).toBe(9)
  })
})

describe('pickLogin', () => {
  it('takes the one with the most left', () => {
    expect(pickLogin([login('a', 0.6), login('b', 0.1), login('c', 0.3)], { now: NOW })!.id).toBe('b')
  })

  it('gives a tie to the preferred one', () => {
    expect(pickLogin([login('a', 0.5), login('b', 0.5)], { now: NOW, prefer: 'b' })!.id).toBe('b')
    expect(pickLogin([login('a', 0.5), login('b', 0.5)], { now: NOW })!.id).toBe('a')
  })

  it('keeps the current one while the gap is under SWITCH_GAP', () => {
    const near = [login('a', 0.5), login('b', 0.5 - SWITCH_GAP + 0.05)]
    expect(pickLogin(near, { now: NOW, current: 'a' })!.id).toBe('a')
  })

  it('gives the current one up when another has SWITCH_GAP more, or it is nearly out', () => {
    expect(pickLogin([login('a', 0.5), login('b', 0.5 - SWITCH_GAP - 0.01)], { now: NOW, current: 'a' })!.id).toBe('b')
    expect(pickLogin([login('a', 1 - NEARLY_OUT + 0.01), login('b', 1 - NEARLY_OUT)], { now: NOW, current: 'a' })!.id).toBe('b')
  })

  it('does not pick a login without windows while another has reported, even a nearly full one', () => {
    expect(pickLogin([login('a'), login('b', 0.97)], { now: NOW })!.id).toBe('b')
    expect(pickLogin([login('a'), login('b', 0.97)], { now: NOW, prefer: 'a', current: 'a' })!.id).toBe('b')
  })

  it('picks one without windows when none has reported, the preferred one first', () => {
    expect(pickLogin([login('a'), login('b')], { now: NOW })!.id).toBe('a')
    expect(pickLogin([login('a'), login('b')], { now: NOW, prefer: 'b' })!.id).toBe('b')
  })

  it('picks one that never reported over a known one that is out', () => {
    expect(pickLogin([login('a', 1), login('b')], { now: NOW })!.id).toBe('b')
  })

  it('returns a spent known login when nothing else is left', () => {
    expect(pickLogin([login('a', 1)], { now: NOW })!.id).toBe('a')
  })

  it('falls back to a login without windows when every known one is skipped', () => {
    expect(pickLogin([login('a'), login('b', 0.2)], { now: NOW, skip: new Set(['b']) })!.id).toBe('a')
  })

  it('passes over the ones to skip, and is undefined when none is left', () => {
    expect(pickLogin([login('a', 0), login('b', 0.9)], { now: NOW, skip: new Set(['a']) })!.id).toBe('b')
    expect(pickLogin([login('a')], { now: NOW, skip: new Set(['a']) })).toBeUndefined()
    expect(pickLogin([], { now: NOW })).toBeUndefined()
  })
})

describe('spentQuota', () => {
  it('keeps a reset that is still ahead', () => {
    const q = spentQuota({ fiveHour: { utilization: 0.9, resetsAt: NOW + 60_000 }, at: 1 }, NOW)
    expect(q.fiveHour).toEqual({ utilization: 1, resetsAt: NOW + 60_000 })
    expect(q.at).toBe(NOW)
  })

  it('fills the window that is most used among the near ones', () => {
    const sevenDay = { utilization: 0.91, resetsAt: NOW + 86_400_000 }
    const q = spentQuota({ fiveHour: { utilization: 0.99, resetsAt: NOW + 60_000 }, sevenDay, at: 1 }, NOW)
    expect(q.fiveHour).toEqual({ utilization: 1, resetsAt: NOW + 60_000 })
    expect(q.sevenDay).toEqual(sevenDay)
  })

  it('falls back to SPENT_MS when the reset is unknown or past', () => {
    expect(spentQuota(undefined, NOW).fiveHour).toEqual({ utilization: 1, resetsAt: NOW + SPENT_MS })
    expect(spentQuota({ fiveHour: { utilization: 0.2, resetsAt: NOW - 1 }, at: 1 }, NOW).fiveHour!.resetsAt).toBe(NOW + SPENT_MS)
  })

  it('fills the week when that is the window near its end', () => {
    const q = spentQuota({ fiveHour: { utilization: 0.3, resetsAt: NOW + 60_000 }, sevenDay: { utilization: 0.97, resetsAt: NOW + 86_400_000 }, at: 1 }, NOW)
    expect(q.sevenDay).toEqual({ utilization: 1, resetsAt: NOW + 86_400_000 })
    expect(q.fiveHour).toEqual({ utilization: 0.3, resetsAt: NOW + 60_000 })
  })

  it('sits out SPENT_MS only when no window was near its end (a passing "too many requests")', () => {
    expect(spentQuota({ fiveHour: { utilization: 0.2, resetsAt: NOW + 4 * 3_600_000 }, at: 1 }, NOW).fiveHour).toEqual({ utilization: 1, resetsAt: NOW + SPENT_MS })
  })

  it('leaves the login out until its reset', () => {
    expect(leftOf({ windows: [{ minutes: 300, ...spentQuota(undefined, NOW).fiveHour! }] }, NOW)).toBe(0)
  })
})
