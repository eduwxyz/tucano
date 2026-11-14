// One reply at a time per agent and thread. Two replies of the same agent in the same conversation would
// each run on a context the other is about to change, so a hand-off that reaches an agent already replying
// there is noted instead, and the agent answers it once, after the reply it's in. Other conversations and
// other threads stay parallel: the key is agent + conversation + thread. The one exception is a person
// asking for it outright (send mode 'parallel'): that reply goes beside the running one, and the pair
// simply counts on the same slot until both end.

// Also the key of an agent's kept session: same agent, same conversation, same thread.
export const replyKey = (agentId: string, convId: string, threadId?: string): string => `${agentId}:${convId}:${threadId ?? ''}`

export type Followup = { depth: number; work?: string }

type Slot = { running: number; reserved: number; pending?: Followup }

export class Followups {
  private slots = new Map<string, Slot>()

  private slot(key: string): Slot {
    let s = this.slots.get(key)
    if (!s) this.slots.set(key, (s = { running: 0, reserved: 0 }))
    return s
  }

  private tidy(key: string): void {
    const s = this.slots.get(key)
    if (s && !s.running && !s.reserved && !s.pending) this.slots.delete(key)
  }

  // A reply starts; `reserved` when it was queued with reserve() and now takes that place.
  start(key: string, reserved = false): void {
    const s = this.slot(key)
    s.running++
    if (reserved && s.reserved > 0) s.reserved--
  }

  end(key: string): void {
    const s = this.slots.get(key)
    if (!s) return
    s.running = Math.max(0, s.running - 1)
    this.tidy(key)
  }

  // A reply is queued but hasn't started: the place is taken so a second hand-off doesn't queue another.
  reserve(key: string): void {
    this.slot(key).reserved++
  }

  busy(key: string): boolean {
    const s = this.slots.get(key)
    return !!s && (s.running > 0 || s.reserved > 0)
  }

  // Several hand-offs while it replies become one follow-up: the deepest chain, the latest work.
  add(key: string, f: Followup): void {
    const s = this.slot(key)
    s.pending = { depth: Math.max(s.pending?.depth ?? 0, f.depth), work: f.work ?? s.pending?.work }
  }

  // Only once the agent is free: whoever finishes last in a crowded key is the one that gets it.
  take(key: string): Followup | undefined {
    const s = this.slots.get(key)
    if (!s || s.running > 0 || s.reserved > 0) return undefined
    const f = s.pending
    s.pending = undefined
    this.tidy(key)
    return f
  }
}
