// The clock behind initiative: every minute it asks each person's coordinator whether a check-in is
// due, admits one at a time, and records what came of it. Admission is a claim taken before any
// await, so a tick that finds work already under way cannot start a second one.
//
// It decides nothing about permissions: a check-in runs through the runner as any reply does, with
// the agent's own rules, the person's visibility and Autonomy's verdict on every tool call.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { dayStartIn, type Commitment, type InitiativeConfig, type InitiativeWake, type LinkSnapshot, type WakeWhy } from '../shared/initiative'
import { inQuietHours, type Person, type Settings } from '../shared/types'
import type { Db } from './db'
import type { Initiative } from './initiative'
import type { Runner } from './runs'
import { admit, attemptsOf, dueAt, heartbeatTask, quietStreakOf, TICK_MS, type Refusal } from './initiative-state'

// Where a reported check-in reaches the person: the same desktop notification and phone push every
// reply uses, with the first line of what it found.
export type WakeNotify = (title: string, body: string, conversationId?: string, to?: string[]) => void

// A report that repeats the one before it, word for word, is not news: it stays out of the
// conversation, and its record says why. A day is enough to tell a repeat from a new problem.
const REPEAT_WINDOW = 24 * 3_600_000
// A check-in that has been open longer than this is over, whatever happened: a reply's own stall limits
// are shorter than this, and nothing is left "checking now" past it.
const ORPHAN_MINUTES = 30

export class Heartbeat {
  private claims = new Set<string>() // people with a check-in under way
  private timer: ReturnType<typeof setInterval> | undefined
  private readonly now: () => number

  constructor(
    private readonly deps: {
      db: Db
      runner: Runner
      initiative: Initiative
      settings: () => Settings
      people: () => Person[]
      notify?: WakeNotify
      now?: () => number
    }
  ) {
    this.now = deps.now ?? Date.now
  }

  start(): void {
    if (this.timer) return
    this.recover()
    this.timer = setInterval(() => void this.tick().catch((e: unknown) => console.error('[initiative]', e)), TICK_MS)
    this.timer.unref?.()
  }

  // Whatever the app did not survive: a check-in recorded as running with nothing to end it. It is closed
  // as interrupted, and the work behind each responsibility is read again before anything new is allowed,
  // so a stale run cannot leave a state nobody chose. Returns how many it closed.
  recover(now = this.now()): number {
    const stale = this.deps.db.staleWakes(now - ORPHAN_MINUTES * 60_000)
    if (!stale.length) return 0
    for (const w of stale) {
      // Kept as what it was: it started and never ended, and nothing it may have done is replayed.
      this.deps.db.saveWake({ ...w, endedAt: now, outcome: 'interrupted', why: 'error' })
      const person = this.deps.db.person(w.personId)
      if (person) this.deps.initiative.refresh(person, now)
    }
    return stale.length
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // Everyone whose check-in is due, one bot after another: two check-ins never run beside each other,
  // whoever they are for, and a tick that finds one under way leaves that bot alone.
  async tick(now = this.now()): Promise<InitiativeWake[]> {
    const settings = this.deps.settings()
    const quietHours = inQuietHours(settings.quietHours)
    const ran: InitiativeWake[] = []
    for (const person of this.deps.people()) {
      const configs = this.deps.db.initiatives(person.id)
      if (configs.length === 0) continue
      // Delivery retries alone: a report recorded before the app closed is shown now, without running the
      // check-in again. A run the app did not survive is closed for the same reason.
      this.deliverPending(person, now)
      for (const w of this.deps.db.staleWakes(now - ORPHAN_MINUTES * 60_000).filter((w) => w.personId === person.id)) {
        this.deps.db.saveWake({ ...w, endedAt: now, outcome: 'interrupted', why: 'error' })
        this.deps.initiative.refresh(person, now, w.agentId)
      }
      // Every bot of theirs in turn: one bot's check-in never blocks another's, and each has its own brief,
      // its own plate and what is left of its own allowance.
      for (const config of configs) await this.one(person, config, settings, quietHours, now, ran)
    }
    return ran
  }

  private async one(person: Person, config: InitiativeConfig, settings: Settings, quietHours: boolean, now: number, ran: InitiativeWake[]): Promise<void> {
      const wakes = this.deps.db.wakes(person.id, { limit: 60, agentId: config.agentId })
      const attempts = attemptsOf(wakes)
      const lastAt = attempts[0]?.at
      const quietStreak = quietStreakOf(wakes)
      const today = dayStartIn(config.timezone, now)
      const todayRuns = attempts.filter((w) => w.at >= today)
      // A DM where the person had the last word and has not been answered yet: their turn comes first.
      const last = this.deps.db.lastAuthor(config.conversationId)
      // What the work behind each responsibility says now: a link that moved is what a resume is for.
      const fresh = this.deps.initiative.refresh(person, now, config.agentId)
      const verdict = admit({
        config,
        now,
        ...(lastAt === undefined ? {} : { lastAt }),
        quietStreak,
        reviewsToday: todayRuns.length,
        tokensToday: todayRuns.reduce((n, w) => n + w.tokens, 0),
        busy: this.claims.has(this.key(person, config.agentId)),
        paused: this.deps.runner.isPaused(),
        quietHours,
        resume: fresh.due.length > 0,
        floorMinutes: this.deps.initiative.floorMinutes(config, fresh.waitingUser),
        personTalking: last?.kind === 'person'
      })
      if (!verdict.run) return
      // The claim is taken here, before the first await: a second tick cannot pass this line.
      this.claims.add(this.key(person, config.agentId))
      try {
        const wake = await this.run(person, config, settings, now, fresh)
        if (wake) ran.push(wake)
      } finally {
        this.claims.delete(this.key(person, config.agentId))
      }
  }

  // "Conferir agora": the person asking for one, on the spot. Their cadence and their quiet hours are
  // theirs to skip; the caps, the pause, the allowance and one-at-a-time are not. It returns as soon
  // as the check-in has started, so a page can watch the record fill in instead of freezing.
  startNow(person: Person, agentId: string): { started: boolean; why?: Refusal } {
    const config = this.deps.db.initiative(person.id, agentId)
    if (!config) return { started: false, why: 'off' }
    const now = this.now()
    const work = this.deps.initiative.refresh(person, now, agentId)
    const wakes = this.deps.db.wakes(person.id, { limit: 60, agentId })
    const attempts = attemptsOf(wakes)
    const today = dayStartIn(config.timezone, now)
    const todayRuns = attempts.filter((w) => w.at >= today)
    const verdict = admit({
      config,
      now,
      ...(attempts[0] ? { lastAt: attempts[0].at } : {}),
      quietStreak: quietStreakOf(wakes),
      reviewsToday: todayRuns.length,
      tokensToday: todayRuns.reduce((n, w) => n + w.tokens, 0),
      busy: this.claims.has(this.key(person, agentId)),
      paused: this.deps.runner.isPaused(),
      quietHours: false,
      manual: true
    })
    if (!verdict.run) return { started: false, why: verdict.why }
    this.claims.add(this.key(person, agentId))
    void this.run(person, config, this.deps.settings(), now, work)
      .catch((e: unknown) => console.error('[initiative]', e))
      .finally(() => this.claims.delete(this.key(person, agentId)))
    return { started: true }
  }

  // Whether one of this person's check-ins is under way, for a page that asks: one bot's, or any of them.
  running(personId: string, agentId?: string): boolean {
    return agentId ? this.claims.has(`${personId}:${agentId}`) : [...this.claims].some((k) => k.startsWith(`${personId}:`))
  }

  private key(person: Person, agentId: string): string {
    return `${person.id}:${agentId}`
  }

  // When this person's next check-in is due: what a page shows, and what a test reads. While something
  // of the bot's waits on the person, that is the longer wait, not the cadence.
  dueAtFor(person: Person, config: InitiativeConfig): number | undefined {
    if (!config.enabled) return undefined
    const wakes = this.deps.db.wakes(person.id, { limit: 60, agentId: config.agentId })
    const fresh = this.deps.initiative.refresh(person, this.now(), config.agentId)
    return dueAt(config, attemptsOf(wakes)[0]?.at, quietStreakOf(wakes), this.deps.initiative.floorMinutes(config, fresh.waitingUser))
  }

  private skip(person: Person, config: InitiativeConfig, why: WakeWhy, now: number, id: string = randomUUID()): InitiativeWake {
    const wake: InitiativeWake = { id, personId: person.id, agentId: config.agentId, revision: config.revision, at: now, outcome: 'skipped', why, tokens: 0 }
    this.deps.db.saveWake(wake)
    return wake
  }

  private async run(
    person: Person,
    config: InitiativeConfig,
    settings: Settings,
    now: number,
    work: { due: LinkSnapshot[]; links: Map<string, LinkSnapshot[]>; stalled: Commitment[] }
  ): Promise<InitiativeWake | undefined> {
    const { db, runner } = this.deps
    const agent = db.agent(config.agentId)
    if (!agent || agent.archived) return this.skip(person, config, 'agent', now)
    const conversation = db.conversation(config.conversationId)
    if (!conversation || conversation.kind !== 'dm') return this.skip(person, config, 'dm', now)
    // An edit since admission stops it: the check-in was admitted under the brief the person has
    // since changed, and a review of the old one is not what they asked for.
    const fresh = db.initiative(person.id, config.agentId)
    if (!fresh || !fresh.enabled || fresh.revision !== config.revision) return this.skip(person, config, fresh?.enabled ? 'revision' : 'off', now)

    const id = randomUUID()
    const me = person.role === 'owner' ? settings.workspaceName : person.name
    // Written before it starts, as interrupted: an app that dies mid-check-in leaves an honest record.
    this.deps.db.saveWake({ id, personId: person.id, agentId: agent.id, revision: config.revision, at: now, outcome: 'interrupted', tokens: 0 })
    const result = await runner.checkIn({
      personId: person.id,
      revision: config.revision,
      wake: id,
      agent,
      conversation,
      task: heartbeatTask(
        fresh,
        db.commitments(person.id).filter((c) => c.agentId === config.agentId),
        me,
        { links: work.links, moved: work.due, stalled: work.stalled.map((c) => c.description) }
      )
    })
    if (result.outcome === 'skipped') return this.skip(person, config, result.why ?? 'error', now, id)
    // The app may have closed this one while it was away (a restart, a kill): what came back is late, and
    // it changes nothing. A stale run never finishes a claim somebody else already closed.
    const closedByApp = this.deps.db.initiativeWake(id)
    if (closedByApp?.endedAt) return closedByApp
    // What this check-in read is now seen, and what it found exactly where it was counts one more time
    // without progress: news wakes the coordinator once, and a cycle with nothing in it is bounded. Only a
    // run that finished counts: one cut short has read nothing to the end, so the news it came for must
    // still be able to wake the coordinator again.
    if (result.outcome === 'quiet' || result.outcome === 'reported') this.deps.initiative.settle(person, now, [...work.links.values()].flat(), this.now(), config.agentId)
    const message = result.message
    const said = (message?.text.trim() || message?.run?.error?.trim() || '').trim()
    // Saying the same thing twice is not an intervention: the report stays in its record, out of the
    // conversation, and a page can say why it was not delivered.
    const deduped = result.outcome === 'reported' && this.repeats(person, config.agentId, said, now)
    const wake: InitiativeWake = {
      id,
      personId: person.id,
      agentId: agent.id,
      revision: config.revision,
      at: now,
      endedAt: this.now(),
      outcome: result.outcome,
      tokens: message ? db.tokensForMessage(message.id) : 0,
      ...(message ? { messageId: message.id } : {}),
      // What it said, kept for the person alone: a quiet one leaves only this, and a failed one keeps
      // the words it failed with.
      ...(said ? { text: said.slice(0, 4_000) } : {}),
      ...(deduped ? { deduped: true } : {}),
      ...(result.outcome === 'failed' ? { why: 'error' as const } : {})
    }
    db.saveWake(wake)
    // A month of records is enough; older ones go as this one lands, so the table never grows without end.
    db.pruneWakes(person.id, now - 30 * 24 * 3_600_000)
    // What it did is on the record before anything is shown: a failure from here is a delivery problem, and
    // the next tick delivers this one again without asking the engine anything.
    if (wake.outcome === 'reported' && !deduped) this.deliver(person, agent, conversation.id, wake)
    return wake
  }

  // A report the person has not seen yet is shown now. Nothing else happens: the check-in is not run
  // again, and a message that no longer exists is simply marked as nothing left to deliver.
  private deliverPending(person: Person, now: number): void {
    for (const w of this.deps.db.wakes(person.id, { since: now - REPEAT_WINDOW, limit: 20 })) {
      if (w.outcome !== 'reported' || w.deduped || w.delivered || !w.messageId) continue
      const message = this.deps.db.message(w.messageId)
      if (!message) {
        this.deps.db.saveWake({ ...w, delivered: true })
        continue
      }
      const agent = this.deps.db.agent(w.agentId)
      if (!agent) continue
      if (!message.hidden) {
        // It is in the conversation already (a restart between the two steps): only the flag was missing.
        this.deps.db.saveWake({ ...w, delivered: true })
        continue
      }
      this.deliver(person, agent, message.conversationId, w)
    }
  }

  // Showing it and telling the person: two steps that can fail on their own, and neither may take the
  // record of what the check-in did with it.
  private deliver(person: Person, agent: { name: string }, conversationId: string, w: InitiativeWake): void {
    const message = w.messageId ? this.deps.db.message(w.messageId) : undefined
    if (message) {
      try {
        this.deps.runner.reveal(message)
      } catch (e) {
        // Still hidden, still recorded, and the next tick tries the delivery again without re-running it.
        console.error('[initiative] reveal failed', e)
        return
      }
    }
    this.deps.db.saveWake({ ...w, delivered: true })
    try {
      this.deps.notify?.(L(`${agent.name} conferiu`, `${agent.name} checked in`), (w.text ?? '').replace(/[*_`#>]/g, '').slice(0, 240), conversationId, [person.id])
    } catch (e) {
      // It is in the conversation either way: a phone that did not ring is not a lost finding.
      console.error('[initiative] notify failed', e)
    }
  }

  // The last thing it said, word for word. Compared without the markdown that wraps it, since the same
  // finding is often bolded in one check-in and plain in the next.
  private repeats(person: Person, agentId: string, said: string, now: number): boolean {
    if (!said) return false
    const plain = (t: string): string => t.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
    const mine = plain(said)
    return this.deps.db
      .wakes(person.id, { limit: 20, agentId })
      .filter((w) => w.outcome === 'reported' && !w.deduped && w.text && now - w.at < REPEAT_WINDOW)
      .some((w) => plain(w.text!) === mine)
  }
}
