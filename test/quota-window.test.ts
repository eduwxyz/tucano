import { describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { resetsIn, windowNow } from '../src/shared/quota-window'

// Claude Code reports its windows only when a reply runs. A report of 100% taken just before the window
// reset kept the Usage page at "100% used, resets now" for as long as nobody replied, while claude.ai
// already showed 0%.
describe('a subscription window as it stands now', () => {
  const now = new Date(2026, 10, 20, 16, 30).getTime()

  it('counts what was used while the window is still open', () => {
    expect(windowNow({ utilization: 0.45, resetsAt: now + 60_000 }, now)).toEqual({ used: 0.45, reset: false })
    expect(windowNow({ utilization: 1.2, resetsAt: now + 60_000 }, now)).toEqual({ used: 1, reset: false })
  })

  it('starts over once the reported reset time has passed', () => {
    expect(windowNow({ utilization: 1, resetsAt: now - 23 * 60_000 }, now)).toEqual({ used: 0, reset: true })
    expect(windowNow({ utilization: 1, resetsAt: now }, now)).toEqual({ used: 0, reset: true })
  })

  it('keeps the share when the reset time is unknown', () => {
    expect(windowNow({ utilization: 0.3, resetsAt: 0 }, now)).toEqual({ used: 0.3, reset: false })
  })
})

// The AI-included plan's monthly limit renews on the 1st; on Monday 23/11 the Usage page said
// "zera seg, 21:00" for Monday 30/11, and a customer took it for that same night.
describe('when a window starts over, in words', () => {
  const now = new Date(2026, 10, 23, 12, 0).getTime() // a Monday
  const at = (days: number, h: number, m = 0): number => new Date(2026, 10, 23 + days, h, m).getTime()
  const hm = (t: number): string => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

  it('counts minutes and hours under a day', () => {
    setLang('pt')
    expect(resetsIn(now + 42 * 60_000, now)).toBe('em 42 min')
    expect(resetsIn(now + (5 * 60 + 3) * 60_000, now)).toBe('em 5 h 3 min')
    expect(resetsIn(now - 1, now)).toBe('agora')
  })

  it('names the weekday within the six days ahead', () => {
    setLang('pt')
    expect(resetsIn(at(2, 21), now)).toBe(`qua, ${hm(at(2, 21))}`)
    expect(resetsIn(at(6, 9), now)).toBe(`dom, ${hm(at(6, 9))}`)
  })

  it('gives the date a week or more ahead, so it never reads as today', () => {
    setLang('pt')
    expect(resetsIn(at(7, 21), now)).toBe(`30/11, ${hm(at(7, 21))}`)
    expect(resetsIn(at(6, 13), now)).toBe(`29/11, ${hm(at(6, 13))}`)
    setLang('en')
    expect(resetsIn(at(7, 21), now)).toMatch(/^11\/30, /)
    setLang('pt')
  })
})
