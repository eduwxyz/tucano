// A person's proactive coordinator: the record of what their bot looks after between messages, and
// the checks that keep it theirs. This slice stores and validates; nothing runs a review yet (slice 2
// admits them through the runner), so this module is the only place a page writes either record.
//
// Authority is what the person can already reach and what their agent may already do. Initiative adds
// nothing: a responsibility narrows a scope, and Autonomy keeps deciding every tool call.
import { randomUUID } from 'node:crypto'
import {
  cleanCommitment,
  cleanInitiative,
  closedAtFor,
  commitmentError,
  dayStartIn,
  inReach,
  initiativeError,
  isClosed,
  MAX_COMMITMENTS,
  REMINDER_FLOOR_MINUTES,
  STALL_AFTER,
  within,
  type Commitment,
  type CommitmentInput,
  type InitiativeConfig,
  type InitiativeInput,
  type InitiativeView,
  type LinkSnapshot
} from '../shared/initiative'
import { L } from '../shared/lang'
import type { Person } from '../shared/types'
import { dependencyOf, movedLinks, narrowScope, noteFrom, stateFrom, waitsOnPerson } from './initiative-links'
import { attemptsOf, dueAt, quietStreakOf } from './initiative-state'
import type { Db } from './db'
import type { People } from './people'

const gone = (): string => L('Isso não existe mais.', 'That record no longer exists.')
const staleRevision = (): string =>
  L('Isso mudou enquanto a página estava aberta. Recarregue e tente de novo.', 'This changed while the page was open. Reload and try again.')

export class Initiative {
  constructor(
    private db: Db,
    private people: People
  ) {}

  // What this person's page shows: their own records, what their coordinator did, and what is left of
  // today. A page is where a person asks why the bot woke, so the work behind each responsibility is
  // read fresh here too: a state written by a tick that has not happened yet would be a stale answer.
  view(person: Person, agentId: string, now = Date.now(), paused = false): InitiativeView {
    const config = this.db.initiative(person.id, agentId) ?? null
    const commitments = this.mine(person, agentId)
    const wakes = this.db.wakes(person.id, { limit: 30, agentId })
    if (!config) return { config, commitments, wakes, status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused } }
    const fresh = this.refresh(person, now, agentId)
    const open = commitments.filter((c) => !isClosed(c.state))
    const today = dayStartIn(config.timezone, now)
    const ran = attemptsOf(wakes).filter((w) => w.at >= today)
    return {
      config,
      commitments: this.mine(person, agentId),
      wakes,
      status: {
        dueAt: dueAt(config, attemptsOf(wakes)[0]?.at, quietStreakOf(wakes), this.floorMinutes(config, fresh.waitingUser)),
        open: open.length,
        waitingOnPerson: open.filter((c) => c.state === 'waiting_user').length,
        today: { reviews: ran.length, tokens: ran.reduce((n, w) => n + w.tokens, 0) },
        paused
      }
    }
  }

  // Every bot this person has given something to look after, each with what it holds and what is left of
  // today. One page per bot reads its own entry; the settings of a workspace read all of them.
  views(person: Person, now = Date.now(), paused = false): InitiativeView[] {
    return this.db.initiatives(person.id).map((c) => this.view(person, c.agentId, now, paused))
  }

  // One bot's responsibilities, out of everything the person's bots hold between them: a bot never reads
  // what another took on, and none of them inherits another's plate.
  private mine(person: Person, agentId: string): Commitment[] {
    return this.db.commitments(person.id).filter((c) => c.agentId === agentId)
  }

  // A configuration edit, against the revision the page read. A save in between is refused instead
  // of overwriting what the other window wrote: a queued review must never apply an old brief.
  save(person: Person, input: InitiativeInput, expectedRevision: number, at = Date.now()): InitiativeConfig {
    const clean = cleanInitiative(input)
    const why = initiativeError(clean)
    if (why) throw new Error(why)
    // What it names comes first: a bot that is gone is not a page that went stale, and saying "reload"
    // would send the person looking for the wrong problem.
    this.targets(person, clean)
    const prev = this.db.initiative(person.id, clean.agentId)
    if ((prev?.revision ?? 0) !== expectedRevision) throw new Error(staleRevision())
    const now = at
    const saved: InitiativeConfig = {
      ...clean,
      personId: person.id,
      revision: (prev?.revision ?? 0) + 1,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now
    }
    this.db.saveInitiative(saved)
    return saved
  }

  // A responsibility: one bot's, on this person's word, inside what they authorized for it.
  saveCommitment(person: Person, input: CommitmentInput): Commitment {
    const clean = cleanCommitment(input)
    const prev = clean.id ? this.db.commitment(clean.id) : undefined
    // Someone else's record is not this person's to know exists, whatever else they have set up.
    if (prev && prev.personId !== person.id) throw new Error(gone())
    const target = prev?.agentId ?? clean.agentId
    const config = (target ? this.db.initiative(person.id, target) : undefined) ?? this.db.initiatives(person.id)[0]
    if (!config) throw new Error(L('Ligue a iniciativa de um bot primeiro.', 'Turn on initiative for a bot first.'))
    const why = commitmentError(clean)
    if (why) throw new Error(why)
    // A new one belongs to the coordinator; an old one stays with the bot that took it on, so a
    // replaced coordinator cannot inherit it or stop it being closed.
    const agentId = prev ? prev.agentId : config.agentId
    if (!prev && clean.agentId !== agentId) throw new Error(L('Só o bot responsável pode assumir isso.', 'Only the bot looking after this can take this on.'))
    // Where it came from is a conversation the coordinator may read, and its scope cannot pass what
    // the person authorized: on a new one, the brief's scope; on an old one, its own.
    if (!inReach(config.observe, config.conversationId, clean.conversationId)) throw new Error(L('Isso veio de uma conversa fora do que o bot pode ler.', 'That came from a conversation outside what the bot may read.'))
    if (prev ? !within(prev.scope, clean.scope) : !within(config.work, clean.scope)) {
      throw new Error(L('Isso passa do que você autorizou pro bot.', 'That goes beyond what you authorized for the bot.'))
    }
    this.pieces(person, clean)
    const now = Date.now()
    // A coordinator holds a plate, not a backlog.
    const others = this.mine(person, agentId).filter((c) => c.id !== prev?.id && !isClosed(c.state))
    if (!prev && others.length >= MAX_COMMITMENTS) throw new Error(L('Já são responsabilidades demais. Feche uma antes de abrir outra.', 'That is as many responsibilities as one bot can keep. Close one before adding another.'))
    // What the work behind it says now: a page shows the honest state from the first render, not only
    // after the next check-in. A person's own state wins, and a closed one stays closed on an edit.
    const links = (clean.links ?? []).map((l) => dependencyOf(this.db, l.kind, l.id)).filter((l): l is LinkSnapshot => l !== undefined)
    const base = clean.state ?? prev?.state ?? 'open'
    const state = clean.state ?? (isClosed(base) ? base : stateFrom(links, base))
    const closedAt = closedAtFor(state, now, prev?.closedAt)
    // What the person changed is progress: the count of check-ins that found it exactly where it was
    // starts again. Links they add are recorded as already seen, so a new one is not a wake.
    const edited =
      !prev ||
      prev.state !== state ||
      prev.description !== clean.description ||
      (prev.note ?? '') !== (clean.note ?? '') ||
      JSON.stringify(prev.links) !== JSON.stringify(clean.links ?? [])
    const saved: Commitment = {
      id: prev?.id ?? randomUUID(),
      personId: person.id,
      agentId,
      conversationId: clean.conversationId,
      ...(clean.messageId ? { messageId: clean.messageId } : {}),
      by: clean.by,
      description: clean.description,
      scope: clean.scope,
      state,
      ...(clean.note ? { note: clean.note } : {}),
      ...(clean.nextCheckAt ? { nextCheckAt: clean.nextCheckAt } : {}),
      evidence: clean.evidence ?? [],
      links: clean.links ?? [],
      unchangedFor: edited ? 0 : (prev?.unchangedFor ?? 0),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      ...(closedAt ? { closedAt } : {})
    }
    this.db.saveCommitment(saved)
    for (const l of saved.links) {
      const d = dependencyOf(this.db, l.kind, l.id)
      if (d) this.db.markResume(person.id, l.kind, l.id, d.version, now)
    }
    return saved
  }

  // What the work behind each responsibility says now, read fresh on every tick. A link whose version
  // moved is news for this person's coordinator, and reading it here writes nothing: the resume is
  // recorded only once a check-in has actually run, so a pause or a failure cannot swallow it.
  //
  // A scope that lost a conversation is narrowed to what the person can still reach, and a
  // responsibility nothing has moved in a long while is named as stalled, so a cycle with no progress
  // is bounded instead of repeated.
  refresh(
    person: Person,
    now = Date.now(),
    agentId?: string
  ): { due: LinkSnapshot[]; links: Map<string, LinkSnapshot[]>; waitingUser: boolean; stalled: Commitment[]; narrowed: Commitment[] } {
    const config = (agentId ? this.db.initiative(person.id, agentId) : undefined) ?? this.db.initiatives(person.id)[0]
    if (!config) return { due: [], links: new Map(), waitingUser: false, stalled: [], narrowed: [] }
    const reachable = new Set([config.conversationId, ...config.observe.conversations, ...config.work.conversations])
    const due: LinkSnapshot[] = []
    const linksOf = new Map<string, LinkSnapshot[]>()
    const stalled: Commitment[] = []
    const narrowed: Commitment[] = []
    let waitingUser = false
    for (const c of this.mine(person, config.agentId)) {
      if (isClosed(c.state)) continue
      const links = c.links.map((l) => dependencyOf(this.db, l.kind, l.id)).filter((l): l is LinkSnapshot => l !== undefined)
      linksOf.set(c.id, links)
      if (links.some(waitsOnPerson)) waitingUser = true
      const moved = movedLinks(links, (kind, id) => this.db.resumeSeen(person.id, kind, id))
      if (moved.length) due.push(...moved)
      const state = stateFrom(links, c.state)
      const note = noteFrom(links)
      const { scope, dropped } = narrowScope(c, reachable)
      if (dropped.length) narrowed.push(c)
      // Evidence that can no longer be read is no longer evidence: what the person cannot see is not
      // what the bot acts on. A file or message gone leaves the record without it.
      const evidence = c.evidence.filter((e) => {
        if (e.kind === 'message') return this.db.message(e.id) !== undefined
        const a = this.db.artifact(e.id)
        return a !== undefined && this.people.artifactVisible(person, a)
      })
      const lostEvidence = evidence.length !== c.evidence.length
      if (state === c.state && (note ?? '') === (c.note ?? '') && dropped.length === 0 && !lostEvidence) continue
      const next: Commitment = {
        ...c,
        state,
        ...(note ? { note } : {}),
        scope,
        evidence,
        // Where it moved is progress; a narrower scope did not move it.
        unchangedFor: state === c.state && dropped.length > 0 ? c.unchangedFor : 0,
        updatedAt: now
      }
      if (!note && c.note) delete next.note
      this.db.saveCommitment(next)
    }
    // Read from what is stored now, so a state this refresh wrote is the one that counts. Something
    // waiting on the person is not stalled: they are the one who has not moved.
    for (const c of this.mine(person, config.agentId)) {
      if (!isClosed(c.state) && c.state !== 'waiting_user' && c.unchangedFor >= STALL_AFTER) stalled.push(c)
    }
    return { due, links: linksOf, waitingUser, stalled, narrowed }
  }

  // After a check-in: the work it read is recorded as seen, so the same news never wakes it twice, and
  // each responsibility it found exactly where it was counts one more check-in without progress. A
  // change the check-in itself made (a new note, a closed one) starts that count again.
  settle(person: Person, since: number, links: LinkSnapshot[], now = Date.now(), agentId?: string): void {
    for (const l of links) this.db.markResume(person.id, l.kind, l.id, l.version, now)
    for (const c of agentId ? this.mine(person, agentId) : this.db.commitments(person.id)) {
      if (isClosed(c.state)) continue
      const unchangedFor = c.updatedAt > since ? 0 : Math.min(c.unchangedFor + 1, STALL_AFTER * 2)
      if (unchangedFor === c.unchangedFor) continue
      this.db.saveCommitment({ ...c, unchangedFor, updatedAt: c.updatedAt })
    }
  }

  // How long this person's coordinator must wait before another check-in, when that is longer than its
  // cadence: something of the bot's waits on the person, and asking again sooner helps no one.
  floorMinutes(config: InitiativeConfig, waitingUser: boolean): number | undefined {
    return waitingUser ? Math.max(config.cadenceMinutes, REMINDER_FLOOR_MINUTES) : undefined
  }

  // Who and where it works: a bot they can talk to, and their own DM with it, since a review resumes
  // that conversation. Anything named to look at or act in must be theirs to reach already.
  private targets(person: Person, c: InitiativeInput): void {
    const agent = this.db.agent(c.agentId)
    if (!agent || agent.archived) throw new Error(L('Esse bot não existe mais.', 'That bot no longer exists.'))
    const dm = this.db.conversation(c.conversationId)
    const owner = this.db.conversationOwner(c.conversationId)?.owner ?? this.db.ownerId()
    if (!dm || dm.kind !== 'dm' || !dm.members.includes(agent.id) || owner !== person.id) {
      throw new Error(L('Escolha a conversa direta com esse bot.', 'Choose your direct conversation with that bot.'))
    }
    for (const id of [...c.observe.conversations, ...c.work.conversations]) {
      const why = this.people.conversationError(person, id)
      if (why) throw new Error(why)
    }
  }

  // What a responsibility rests on, and what it links: each must be there, and be theirs to see.
  private pieces(person: Person, c: CommitmentInput): void {
    const message = (id: string, conversationId?: string): void => {
      const m = this.db.message(id)
      if (!m || (conversationId && m.conversationId !== conversationId) || !this.people.visibleAt(person, m)) throw new Error(L('Essa mensagem não existe mais.', 'That message no longer exists.'))
    }
    if (c.messageId) message(c.messageId, c.conversationId)
    for (const e of c.evidence ?? []) {
      if (e.kind === 'message') message(e.id)
      else {
        const a = this.db.artifact(e.id)
        if (!a || !this.people.artifactVisible(person, a)) throw new Error(L('Esse arquivo não existe mais.', 'That file no longer exists.'))
      }
    }
    for (const l of c.links ?? []) {
      const there =
        l.kind === 'run' ? this.db.message(l.id)?.run !== undefined
        : l.kind === 'delegation' ? this.db.delegation(l.id) !== undefined
        : l.kind === 'question' ? this.db.question(l.id) !== undefined
        : this.db.approval(l.id) !== undefined
      if (!there) throw new Error(L('O que isso acompanhava não existe mais.', 'What this was following no longer exists.'))
    }
  }
}
