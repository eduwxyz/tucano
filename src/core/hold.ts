// A reply the person put on hold: the run keeps its session and waits here, between the work it has
// done and the next piece it would do (a tool call, another turn). Nothing of the model's is in
// flight when it waits, which is what makes a hold a hold and not a stop: a quota window passing
// costs nothing, and the reply goes on in the same session, on the same model, when it is let go.
// Aborting the turn is the way out of a hold nobody lets go of, so a stop is never left waiting.
export class Hold {
  private waiting = new Set<() => void>()
  private asked = false

  // Held, and not yet let go. A second request while one is waiting changes nothing.
  request(): void {
    this.asked = true
  }

  get held(): boolean {
    return this.asked
  }

  // Let go: all calls waiting here start again, and one that has not reached the hold yet never stops.
  release(): void {
    this.asked = false
    for (const finish of this.waiting) finish()
  }

  // Where the run waits, when it was asked to. Says whether it waited, for a caller that has work to
  // do before and after: nothing happens here unless the hold is on.
  async wait(signal: AbortSignal): Promise<boolean> {
    if (!this.asked || signal.aborted) return false
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        this.waiting.delete(finish)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      this.waiting.add(finish)
      signal.addEventListener('abort', finish, { once: true })
    })
    return true
  }
}
