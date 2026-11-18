// Keeping the history only as long as its period says, and taking it away when the person asks: the
// daily sweep behind Settings › History, and the two wipe buttons (the whole workspace's, one bot's).
//
// The period itself is the contract's (src/shared/retention.ts): the Tucano's, and each bot's own under
// it. What a sweep takes is what the period no longer keeps; what a wipe takes is everything there is,
// whatever the period says. Both leave the receipts alone (what Usage and the monthly limit count) and
// both give back the conversations that lost something, so every screen can read them again.
import type { Db } from './db'
import { cleanRetentionDays, retentionCutoff, retentionOf } from '../shared/retention'
import type { Settings } from '../shared/types'

// The sweep runs once a day at most: this is the key its last run is kept under.
const LAST = 'retention:at'
const DAY = 86_400_000

export class Retention {
  constructor(
    private db: Db,
    // The settings as they are now, not as they were when the core started.
    private settings: () => Omit<Settings, 'engines'>,
    private hooks: {
      // Cancel active replies and invalidate queued replies for every removed message.
      deleted: (messageIds: string[]) => void
      // The harnesses keep a session per conversation and per agent: without this the model goes on from
      // words that are gone.
      forgetSessions: (of: { agentId?: string; conversationId?: string }) => void
      // The screens: which conversations to read again.
      cleared: (conversationIds: string[]) => void
    },
    private now: () => number = Date.now
  ) {}

  // The sweep is due when it hasn't run in the last day, or when it has never run.
  due(): boolean {
    const last = Number(this.db.meta(LAST) ?? 0)
    return !Number.isFinite(last) || last === 0 || this.now() - last >= DAY
  }

  // What the periods no longer keep goes: the Tucano's for every conversation, and each bot's own for what
  // it wrote and for its own DMs. A sweep with nothing to do still counts as today's. Answers how many
  // messages went.
  sweep(): number {
    const workspace = cleanRetentionDays(this.settings().retentionDays) ?? 0
    const own = this.db.agents().filter((a) => a.retentionDays !== undefined)
    // Everything the two passes take, by conversation, so each one hears once.
    const took = new Map<string, string>()
    const cutoff = retentionCutoff(workspace, this.now())
    if (cutoff !== undefined) for (const m of this.db.oldMessages(cutoff, own.map((a) => a.id))) took.set(m.id, m.conversationId)
    for (const agent of own) {
      const ownCutoff = retentionCutoff(retentionOf(agent, workspace), this.now())
      if (ownCutoff === undefined) continue
      for (const m of this.db.botMessagesBefore(agent.id, ownCutoff)) took.set(m.id, m.conversationId)
    }
    const gone = this.take([...took.keys()], false)
    this.db.setMeta(LAST, String(this.now()))
    return gone
  }

  // A person's own clearing, at any time: one bot's history — what it wrote and the words of its own DMs
  // — or the whole workspace's when there's no bot. Answers how many messages went.
  wipe(botId?: string): number {
    const rows = this.db.historyOf(botId)
    if (!rows.length) return 0
    const going = new Set(rows.map((r) => r.id))
    const gone = this.take([...going])
    if (botId) this.hooks.forgetSessions({ agentId: botId })
    return gone
  }

  private take(ids: string[], cascade = true): number {
    if (!ids.length) return 0
    const { conversations, gone, ids: removed } = this.db.forget(ids, cascade)
    this.hooks.deleted(removed)
    // The sessions that saw those words go with them, so the next reply doesn't go on from them.
    for (const id of conversations) this.hooks.forgetSessions({ conversationId: id })
    this.hooks.cleared(conversations)
    return gone
  }
}
