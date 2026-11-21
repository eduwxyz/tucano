import { describe, expect, it } from 'vitest'
import { windowNow } from '../src/shared/quota-window'

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
