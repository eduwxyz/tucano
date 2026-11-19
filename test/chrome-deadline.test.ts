import { describe, expect, it } from 'vitest'
import { commandDeadline } from '../src/core/chrome'

// A cold Chrome on a loaded machine answered its first command (Target.setDiscoverTargets) after the
// 30 s it used to be given, which failed chrome-close and chrome-windowless on GitHub's ubuntu-latest
// while the very next command on the same machine came back in milliseconds: the machine was busy,
// the browser wasn't broken. The handshake now gets the deadline the open itself already had, and
// everything after it keeps the short one, so a page that really is gone is still reported in 30 s.
describe('how long a Chrome command waits', () => {
  it('gives the handshake the same deadline as the open itself', () => {
    expect(commandDeadline(true)).toBe(90_000)
  })

  it('keeps the work of the day at 30 s, so a dead Chrome is still said soon', () => {
    expect(commandDeadline(false)).toBe(30_000)
  })
})
