import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHROME, ChromeBrowsers } from '../src/core/chrome'

const alive = (pid?: number): boolean => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

type Inner = { procs: Map<string, { proc: { pid?: number }; headed: boolean }> }
const chromeOf = (b: ChromeBrowsers): Inner => b as unknown as Inner

// Only where Chrome exists: this drives the real browser (a window may flash while it runs).
const noChrome = !CHROME || (process.platform === 'linux' && !process.env.DISPLAY)
describe.skipIf(noChrome)('ChromeBrowsers', () => {
  it('taking one thread over keeps the window up while the other thread keeps working', { timeout: 60_000 }, async () => {
    const b = new ChromeBrowsers(mkdtempSync(join(tmpdir(), 'chrome-')), () => {})
    try {
      // Thread A is working: its tab born headless.
      await b.run('a1', 'convA', 'snapshot')
      const before = chromeOf(b).procs.get('a1')!
      expect(before.headed).toBe(false)

      // I take thread B over: the window opens.
      await b.run('a1', 'convB', 'show', { title: 'teste' })
      const headed = chromeOf(b).procs.get('a1')!
      expect(headed.headed).toBe(true)

      // The window stays: the other thread's tab rebuilt on the windowed Chrome
      // (used to relaunch headless and close the window right after opening).
      await wait(2500)
      const kept = chromeOf(b).procs.get('a1')!
      expect(kept.proc.pid).toBe(headed.proc.pid)
      expect(alive(kept.proc.pid)).toBe(true)

      // Thread A keeps working on it — without bringing the window down.
      await b.run('a1', 'convA', 'snapshot')
      await wait(500)
      const after = chromeOf(b).procs.get('a1')!
      expect(after.proc.pid).toBe(headed.proc.pid)
      expect(after.headed).toBe(true)
      expect(alive(after.proc.pid)).toBe(true)
    } finally {
      b.quit()
    }
  })
})
