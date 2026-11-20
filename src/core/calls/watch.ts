import { dayStart } from '../../shared/whatsapp'

// How many times a finished call may wake its agent in a day, per key (a number). Kept in memory: a restart starts
// the count again, which is enough, since the cap only guards against a flood of runs in one day.
export class WakeCap {
  private days = new Map<string, { day: number; n: number }>()

  constructor(private max: number) {}

  // True when one more wake fits today (and counts it); false once the day's cap is reached.
  take(key: string, now: number): boolean {
    const day = dayStart(now)
    const cur = this.days.get(key)
    const n = cur && cur.day === day ? cur.n : 0
    if (n >= this.max) return false
    this.days.set(key, { day, n: n + 1 })
    return true
  }
}

// Follows the calls that are still going on: every so often each one is asked about, until its
// poll says it is over. One timer for all of them; a call whose poll is still running is skipped, so
// a slow answer never piles up. The timer doesn't keep the app alive and `stop` clears it.
export class Watcher {
  private ids = new Set<string>()
  private busy = new Set<string>()
  private timer?: NodeJS.Timeout

  // `poll` answers true when the call is over (or can't be followed any more).
  constructor(
    private every: number,
    private poll: (id: string) => Promise<boolean>
  ) {}

  add(id: string): void {
    this.ids.add(id)
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), this.every)
    this.timer.unref()
  }

  private tick(): void {
    for (const id of [...this.ids]) {
      if (this.busy.has(id)) continue
      this.busy.add(id)
      this.poll(id)
        .then((over) => {
          if (over) this.ids.delete(id)
        })
        .catch(() => undefined) // a failed look is tried again at the next tick
        .finally(() => {
          this.busy.delete(id)
          if (this.ids.size === 0) this.stop()
        })
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.ids.clear()
  }
}
