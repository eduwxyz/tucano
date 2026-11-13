// The people of a Tucano: who a connection is, what each one may see, and how someone new
// comes in (an invite, then a key). A desktop has one person, its owner; a server has
// whoever was invited. A DM is its person's alone: not even the owner reads it.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { MENTION } from '../shared/mention-text'
import type { CoreEvent, Snapshot, Wire } from '../shared/rpc'
import { CODE_SPANS, delegating, scopePerson, type Agent, type Approval, type Artifact, type BrowserView, type ComputerInfo, type Connector, type Conversation, type Delegation, type Inbox, type InboxProposal, type Memory, type Message, type Person, type Question, type Role, type Routine, type RoutineInput, type Settings, proposalsOf } from '../shared/types'
import type { Db } from './db'
import { can, isAdmin, isPersonalSetting, must } from './policy-people'
import { maskSecrets } from './step-text'

export { isAdmin }

export const INVITE_DAYS = 7

// What a purge took: whose, their DMs, the routines that lived there, and the files to delete.
export type Purged = { person: string } & ReturnType<Db['purgePerson']>
const purgedError = (): string => L('Os dados dessa pessoa já foram apagados: convide-a como alguém novo.', "That person's data was already purged: invite them as someone new.")
export const MAX_NAME = 60
export const KEEP_REMOVED_DAYS = 30 // a removed person's DMs and memories, kept for a re-invite

// A person's key is `p_` and 43 characters; only its hash is kept, and the same for an invite's code.
export const newKey = (): string => `p_${randomBytes(32).toString('base64url')}`
export const newInviteCode = (): string => randomBytes(24).toString('base64url')
export const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('base64url')

// A DM is its person's (one without an owner, from before people, is the Tucano owner's); a channel is everyone's.
export const dmOwner = (c: Pick<Conversation, 'kind' | 'owner'>, ownerId: string): string | undefined => (c.kind === 'dm' ? (c.owner ?? ownerId) : undefined)

// The person an agent belongs to (its approvals are theirs), while they have access.
export const agentOwner = (db: Db, agentId: string): Person | undefined => {
  const id = db.agent(agentId)?.owner
  return id ? db.person(id) : undefined
}

// Who may decide an agent's approvals: admins, the owner, the person the agent belongs to, and
// whoever covers for that person now.
export function deciders(db: Db, agentId: string, now = Date.now()): string[] {
  const owner = agentOwner(db, agentId)
  return db.people().filter((p) => isAdmin(p) || p.id === owner?.id || delegating(owner, p.id, now)).map((p) => p.id)
}

// A routine's person: whose own it is (a channel routine is the team's: none).
export const routinePerson = (db: Db, r: Pick<Routine, 'scope' | 'owner'> | undefined): Person | undefined =>
  r && r.scope !== 'channel' && r.owner ? db.person(r.owner) : undefined

// Whom a reply is for: a DM's person; in a channel, whoever wrote last in what it reads (a
// routine's person for a routine run; a channel routine, the Tucano's owner); otherwise the owner.
export function requesterOf(db: Db, conv: Pick<Conversation, 'kind' | 'owner'>, history: Message[]): Person {
  const owner = db.owner()
  const dm = dmOwner(conv, owner.id)
  if (dm) return db.person(dm) ?? owner
  const last = [...history].reverse().find((m) => m.author.kind === 'person' || m.author.kind === 'routine')
  if (last?.author.kind === 'routine') return routinePerson(db, db.routine(last.author.id)) ?? owner
  return (last?.author.kind === 'person' && db.person(last.author.id)) || owner
}

// The people whose memories ("about me") a reply gets: a DM's person; in a channel, the people who
// wrote in what it reads (a routine's person for its run), newest first; the requester otherwise.
export function presentPeople(db: Db, conv: Pick<Conversation, 'kind' | 'owner'>, history: Message[], requester: Person): string[] {
  const dm = dmOwner(conv, db.ownerId())
  if (dm) return [dm]
  const ids: string[] = []
  for (const m of [...history].reverse()) {
    const id = m.author.kind === 'person' ? m.author.id : m.author.kind === 'routine' ? routinePerson(db, db.routine(m.author.id))?.id : undefined
    if (id && !ids.includes(id) && db.person(id)) ids.push(id)
  }
  return ids.length ? ids : [requester.id]
}

// "Rotina da Ana", "rotina do #vendas": what an approval from a routine's run is for.
export function routineBehalf(db: Db, r: Routine, settings: Pick<Settings, 'workspaceName'>): string {
  const person = routinePerson(db, r)
  if (person) return L(`rotina de ${person.id === db.ownerId() ? settings.workspaceName || person.name : person.name}`, `${person.id === db.ownerId() ? settings.workspaceName || person.name : person.name}'s routine`)
  const c = db.conversation(r.conversationId)
  return c?.kind === 'channel' ? L(`rotina do #${c.name}`, `#${c.name} routine`) : L('rotina do time', "the team's routine")
}

// What the team's log keeps of a routine: its name, unless it lives in a DM (the name is the
// person's words there: "uma rotina pessoal" is all the log says).
export function routineDetail(db: Db, r: Pick<Routine, 'name' | 'conversationId' | 'scope'> | undefined): Record<string, unknown> {
  const c = r && db.conversationOwner(r.conversationId)
  const scope = r?.scope ?? 'me'
  return !r || !c || c.kind === 'dm' ? { name: L('uma rotina pessoal', 'a personal routine'), scope } : { name: r.name, scope }
}

// A channel's name, topic and agents: whoever made it and the admins; everyone else just talks there.
export function mayEditChannel(person: Person, c: Pick<Conversation, 'kind' | 'createdBy'> | undefined, ownerId: string): boolean {
  if (!c || c.kind !== 'channel') return false
  return isAdmin(person) || (c.createdBy ?? ownerId) === person.id
}
export const channelEditError = (): string => L('Só quem criou o canal ou um admin muda o nome, o tema, os agentes e as configurações dele.', "Only whoever created the channel or an admin changes its name, topic, agents and settings.")

// "@bia", "@biasouza": how a person is called in a message. The first name, when no one else has
// it, or the whole name run together; accents and spaces gone, like a handle.
export const personHandles = (p: Pick<Person, 'name'>): { first: string; full: string } => {
  const plain = p.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const words = plain.split(/\s+/).map((w) => w.replace(/[^a-z0-9_-]/g, '')).filter(Boolean)
  return { first: words[0] ?? '', full: words.join('') }
}

// The people as prompts name them: the owner by the workspace's name, so one person reads as always.
export function promptPeople(db: Db, settings: Pick<Settings, 'workspaceName'>, removed = false): Person[] {
  const owner = db.ownerId()
  return db.people({ removed }).map((p) => (p.id === owner && settings.workspaceName ? { ...p, name: settings.workspaceName } : p))
}

// The people a message calls with @name. An agent's handle is never a person: an agent named like
// someone keeps the @ (people are told apart by their full name then).
// A whole name typed out after the @ ("@Ana Teste") is that person, the longest name that fits
// winning: with "Ana" and "Ana Teste" both here, "@Ana Teste" is Ana Teste and "@Ana" is Ana.
export function mentionedPeople(text: string, people: Person[], agents: Pick<Agent, 'handle'>[]): Person[] {
  const agentHandles = new Set(agents.map((a) => a.handle.toLowerCase()))
  const handles = people.map((p) => ({ p, ...personHandles(p), words: plainWords(p.name) }))
  const found: Person[] = []
  const plain = text.replace(CODE_SPANS, ' ')
  for (const m of plain.matchAll(MENTION)) {
    const h = m[2]!.toLowerCase()
    if (agentHandles.has(h)) continue
    const start = m.index + m[1]!.length + 1
    const after = fold(plain.slice(start, start + 200)).replace(/[ \t]+/g, ' ')
    const spelled = handles
      .filter((x) => x.words.length > 1 && after.startsWith(x.words.join(' ')) && !/[a-z0-9_-]/.test(after[x.words.join(' ').length] ?? ''))
      .sort((a, b) => b.words.length - a.words.length)[0]
    // A handle two people share (names from before they had to differ) calls neither: no guessing.
    const fulls = handles.filter((x) => x.full === h)
    const firsts = handles.filter((x) => x.first === h)
    const hit = spelled ?? (fulls.length === 1 ? fulls[0] : !fulls.length && firsts.length === 1 ? firsts[0] : undefined)
    if (hit && !found.includes(hit.p)) found.push(hit.p)
  }
  return found
}
// Whether the message's @mentions name a person (anyone, even one who left, or a first name two
// people share) and no agent: it's written to people, whoever ends up told.
export function toPeopleOnly(text: string, everyone: Pick<Person, 'name'>[], agents: Pick<Agent, 'handle'>[]): boolean {
  const agentHandles = new Set(agents.map((a) => a.handle.toLowerCase()))
  const handles = everyone.map((p) => ({ ...personHandles(p), words: plainWords(p.name) }))
  const plain = text.replace(CODE_SPANS, ' ')
  let person = false
  for (const m of plain.matchAll(MENTION)) {
    const h = m[2]!.toLowerCase()
    if (agentHandles.has(h)) return false
    const start = m.index + m[1]!.length + 1
    const after = fold(plain.slice(start, start + 200)).replace(/[ \t]+/g, ' ')
    if (handles.some((x) => x.first === h || x.full === h || (x.words.length > 1 && after.startsWith(x.words.join(' '))))) person = true
  }
  return person
}
const fold = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
const plainWords = (s: string): string[] => fold(s).split(/\s+/).filter(Boolean)

// A person ask_user names ("Bia", "@bia", "Bia Souza"), among those with access.
// Names as people read them: case, accents and spacing aside. Two people never share one (the
// agents, @mentions and the log tell people apart by name).
// Two names that read the same are the same: other ways of writing a letter (full width, ligatures),
// characters that show nothing (zero width, soft hyphen, direction marks, variation selectors), accents,
// case, spacing, and lookalikes from other alphabets (a Cyrillic "а" for a Latin "a").
// Spacing aside entirely: "Bia TesteSilva" is "Bia Teste Silva" (both are @biatestesilva).
// Punctuation aside too ("Lia.", "@lia", "Bia-Teste" are Lia, lia and Bia Teste): what tells names
// apart is their letters.
export const nameKey = (n: string): string =>
  [...cleanName(n).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').replace(/rn/g, 'm')].map((c) => LOOKALIKE[c] ?? c).join('')
// A name as it's kept: the same letters written one way, nothing invisible, single spaces. Empty
// when nothing visible is left.
export const cleanName = (n: string): string => stripInvisible(n).replace(/\s+/g, ' ').trim()
// The same letters written one way, less what can't be seen; spacing as typed.
export const stripInvisible = (n: string): string => n.normalize('NFKC').replace(INVISIBLE, '')
// Format characters (zero width, soft hyphen, bidi controls), controls, variation selectors, the
// combining grapheme joiner, and the blank letters some scripts have.
const INVISIBLE = /[\p{Cf}\p{Cc}\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180f\u2800\u3164\uffa0\ufe00-\ufe0f]|\udb40[\udd00-\uddef]/gu
// Small skeleton (after NFKC, which already folds full width, mathematical and circled letters, and
// lowercasing): letters of other alphabets that look like a Latin one, the small capitals and
// phonetic letters that pass for one (U+1D00–1D7F, U+0250–02AF, U+A730–A7FF), and digits that pass for letters.
const LOOKALIKE: Record<string, string> = Object.fromEntries(
  [
    ['аa', 'вb', 'еe', 'ёe', 'һh', 'іi', 'їi', 'јj', 'кk', 'мm', 'нh', 'оo', 'рp', 'сc', 'тt', 'уy', 'үy', 'хx', 'ѕs', 'ԁd', 'ӏl', 'ԛq', 'ԝw', 'ьb'], // Cyrillic
    ['αa', 'βb', 'εe', 'ζz', 'ηh', 'ιi', 'κk', 'μm', 'νn', 'οo', 'ρp', 'τt', 'υy', 'χx', 'ϲc', 'ϳj'], // Greek
    ['ıi', 'ȷj', 'ɡg', '0o', '1l'], // Latin and digits
    ['ᴀa', 'ʙb', 'ᴃb', 'ᴄc', 'ᴅd', 'ᴆd', 'ᴇe', 'ꜰf', 'ɢg', 'ʜh', 'ɪi', 'ᴊj', 'ᴋk', 'ʟl', 'ᴍm', 'ɴn', 'ᴎn', 'ᴏo', 'ᴑo', 'ᴓo', 'ᴘp', 'ꞯq', 'ʀr', 'ʁr', 'ᴙr', 'ᴚr', 'ꜱs', 'ᴛt', 'ᴜu', 'ᴝu', 'ᴞu', 'ᴠv', 'ᴡw', 'ʏy', 'ᴢz', 'ᴣz'], // small capitals and phonetic letters
    ['ꞻa', 'ꞽi', 'ꞵb', 'ꞷo', 'ꭓx', 'ꭖx', 'ꭗx', 'ꭘx', 'ꭙx', 'ꭟe', 'ꬲe', 'ꬳe', 'ꬴe', 'ꬺm', 'ꬻn', 'ꬷl', 'ꬸl', 'ꬹl', 'ꬰa', 'ꬱa', 'ꬽo', 'ꬾo', 'ꬿo', 'ꭀo', 'ꭁo', 'ꭂo', 'ꭃo', 'ꭄo', 'ꭅp', 'ꭆr', 'ꭇr', 'ꭈr', 'ꭉr', 'ꭊr', 'ꭋr', 'ꭌr', 'ꭍs', 'ꭎu', 'ꭏu', 'ꭐu', 'ꭑu', 'ꭒu', 'ꭚy', 'ꭜu', 'ꭝl', 'ꭞu', 'ꭣu', 'ꭤa', 'ꭥo'] // Latin Extended-D/E lookalikes
  ].flat().map((pair) => {
    const [from, ...to] = [...pair] // by code point: a lookalike may be outside the BMP
    return [from!, to.join('')]
  })
)
export const nameLongError = (): string => L(`Use um nome de até ${MAX_NAME} letras.`, `Use a name of up to ${MAX_NAME} characters.`)
export const nameTakenError = (): string => L('Já tem alguém com esse nome aqui. Use outro (com o sobrenome, por exemplo).', 'Someone here already has that name. Use another (with a last name, say).')

// How long a question answered for someone stays in their "Pra você", said so (they may be typing).
export const ANSWERED_SHOWN_MS = 30 * 60_000

export function personNamed(name: string, people: Person[]): Person | undefined {
  const want = personHandles({ name: name.replace(/^@/, '') })
  if (!want.full) return undefined
  const handles = people.map((p) => ({ p, ...personHandles(p) }))
  const fulls = handles.filter((x) => x.full === want.full)
  const firsts = handles.filter((x) => x.first === want.full || x.first === want.first)
  return (fulls.length === 1 ? fulls[0] : !fulls.length && firsts.length === 1 ? firsts[0] : undefined)?.p
}

export class People {
  constructor(private db: Db) {}

  owner(): Person {
    return this.db.owner()
  }

  // Who a new connection is: the person it names, when they have access; nothing named (a desktop,
  // or a server's owner token), the owner. A removed or unknown person gets nobody: the port closes.
  resolve(data: unknown): Person | undefined {
    const id = (data as { person?: unknown } | null | undefined)?.person
    if (id === undefined || id === null) return this.db.owner()
    return typeof id === 'string' ? this.db.person(id) : undefined
  }

  // ---------- what each one sees ----------

  // The settings as this person gets them: the owner's are the settings; anyone else's display
  // preferences are their own (the Tucano's theme and language until they pick).
  settingsFor(person: Pick<Person, 'id' | 'role'>, s: Settings): Settings {
    if (person.role === 'owner') return s
    // The introduction sets the Tucano up (models, agents): theirs only if they ask to see it again.
    // The wiki's folder is a path on the owner's machine.
    const { sounds: _s, replyShortcut: _r, channelLayout: _c, folded: _f, onboarding: _o, wikiDir: _w, ...rest } = s
    return { ...rest, onboarding: { done: true }, ...this.db.prefs(person.id) }
  }

  // A settings change by this person: their display preferences are kept on them (the owner's are
  // the settings themselves); what's left is the Tucano's, for the caller to save.
  takePrefs<T extends Partial<Settings>>(person: Pick<Person, 'id' | 'role'>, patch: T): Partial<T> {
    if (person.role === 'owner') return patch
    const mine = Object.fromEntries(Object.entries(patch).filter(([k]) => isPersonalSetting(k))) as Partial<Settings>
    if (Object.keys(mine).length) this.db.setPrefs(person.id, mine)
    return Object.fromEntries(Object.entries(patch).filter(([k]) => !isPersonalSetting(k))) as Partial<T>
  }

  canSeeConversation(person: Person, c: Pick<Conversation, 'kind' | 'owner'> | undefined): boolean {
    if (!c) return false
    const dm = dmOwner(c, this.db.ownerId())
    return dm === undefined || dm === person.id
  }

  // Whether a message is this person's to read, by when it was said: what a channel held before
  // the Tucano had more people (the heritage) stays the owner's. Not deleted, not anyone else's.
  // Alone, or before the heritage, everything is. A DM is its person's whole.
  visibleAt(person: Pick<Person, 'id' | 'role'>, m: Pick<Message, 'conversationId' | 'at'>): boolean {
    if (person.role === 'owner') return true
    const since = this.heritageAt()
    if (!since || m.at >= since) return true
    return this.conversationOf(m.conversationId)?.kind !== 'channel'
  }
  // A file an agent showed goes with the message it was shown in.
  artifactVisible(person: Pick<Person, 'id' | 'role'>, a: Pick<Artifact, 'conversationId' | 'messageId' | 'createdAt'>): boolean {
    return this.visibleAt(person, this.db.message(a.messageId) ?? { conversationId: a.conversationId, at: a.createdAt })
  }
  heritageAt(): number {
    return Number(this.db.meta('heritageAt') ?? 0)
  }
  // Where a member's view of a channel starts: one line, in place of what came before.
  // A page of one conversation's messages (scrolling back, a thread) as this person reads it.
  pageFor(person: Pick<Person, 'id' | 'role'>, messages: Message[]): Message[] {
    const shown = messages.filter((m) => this.visibleAt(person, m))
    return shown.length < messages.length ? [this.boundaryLine(messages[0]!.conversationId), ...shown] : shown
  }

  private boundaryLine(conversationId: string): Message {
    return { id: `heritage:${conversationId}`, conversationId, author: { kind: 'system' }, text: L('Histórico anterior visível só pro dono', 'Earlier history visible to the owner only'), at: this.heritageAt() }
  }

  // Why this person can't reach a conversation, or nothing when they can. Someone else's DM says
  // only that (decision 1: that it exists is no secret, what's in it is).
  conversationError(person: Person, id: string | undefined): string | undefined {
    const c = id ? this.conversationOf(id) : undefined
    if (!c) return L('Essa conversa não existe mais.', 'That conversation no longer exists.')
    return this.canSeeConversation(person, c) ? undefined : L('Essa conversa é de outra pessoa.', 'That conversation belongs to someone else.')
  }

  private conversationOf(id: string): Pick<Conversation, 'kind' | 'owner'> | undefined {
    return this.db.conversationOwner(id)
  }

  // An approval reaches who may decide it and who asked; one in a channel, everyone who reads the
  // channel too. One from a DM never goes past its deciders and requester.
  canSeeApproval(person: Person, a: Approval): boolean {
    if (a.requestedBy === person.id || deciders(this.db, a.agentId).includes(person.id)) return true
    const c = this.conversationOf(a.conversationId)
    return !!c && c.kind !== 'dm' && this.canSeeConversation(person, c)
  }

  // A person's memories ("about me") are theirs; an agent's notes are everyone's, but one made in a
  // DM is that DM's person's alone.
  canSeeMemory(person: Person, m: Pick<Memory, 'scope' | 'privateTo'>): boolean {
    if (m.privateTo) return m.privateTo === person.id
    const of = scopePerson(m.scope)
    return of === undefined || of === person.id
  }

  // The event as this person gets it: undefined when it isn't theirs to see. A conversation
  // carries its unread count, which is each person's own.
  eventFor(event: CoreEvent, person: Person): CoreEvent | undefined {
    const conversation = (id: string): boolean => this.canSeeConversation(person, this.conversationOf(id))
    switch (event.type) {
      case 'message':
        return conversation(event.message.conversationId) && this.visibleAt(person, event.message) ? event : undefined
      case 'delta': {
        const c = this.db.messageConversation(event.id)
        return c && conversation(c) && this.visibleAt(person, this.db.message(event.id) ?? { conversationId: c, at: Infinity }) ? event : undefined
      }
      case 'conversation': {
        if (!this.canSeeConversation(person, event.conversation)) return undefined
        const mine = this.db.conversation(event.conversation.id, person.id)
        return { type: 'conversation', conversation: { ...event.conversation, unread: mine?.unread ?? 0 } }
      }
      case 'artifact':
        return conversation(event.artifact.conversationId) && this.artifactVisible(person, event.artifact) ? event : undefined
      case 'routine':
        return conversation(event.routine.conversationId) ? event : undefined
      case 'approval':
        return this.canSeeApproval(person, event.approval) ? event : undefined
      case 'memory':
        return this.canSeeMemory(person, event.memory) ? event : undefined
      case 'browser':
        return { type: 'browser', view: this.browserFor(person, event.view) }
      // The screen of a browser working for a conversation this person doesn't see: not theirs.
      case 'browser_frame':
        return !event.conversationId || this.canSeeConversation(person, this.conversationOf(event.conversationId)) ? event : undefined
      case 'computer':
        return { type: 'computer', computer: this.computerFor(person, event.computer) }
      case 'inbox':
        return { type: 'inbox', inbox: this.inbox(person) }
      case 'delegations':
        return { type: 'delegations', delegations: this.delegations(person) }
      case 'settings':
        return { type: 'settings', settings: this.settingsFor(person, event.settings) }
      // Gone from a DM (or someone's own memory): only its person hears of it (its id is no one else's to know).
      case 'conversation_removed':
      case 'routine_removed':
      case 'memory_removed': {
        if (event.for !== undefined && event.for !== person.id) return undefined
        const { for: _f, ...rest } = event
        return rest
      }
      // The team's own things, and signals that carry nothing: everyone (each reads the details over the API, checked there).
      case 'connector':
        return { type: 'connector', connector: this.connectorFor(person, event.connector) }
      case 'voice':
      case 'agent':
      case 'connector_removed':
      case 'skill':
      case 'skill_removed':
      case 'wiki':
      case 'people':
        return event
      default: {
        // A kind of event no one decided on yet doesn't compile, and reaches no one.
        const unknown: never = event
        void unknown
        return undefined
      }
    }
  }

  // An agent's browser working for a conversation this person doesn't see: that it exists, no more
  // (no page, no address, no log).
  browserFor(person: Person, v: BrowserView): BrowserView {
    if (!v.conversationId || this.canSeeConversation(person, this.conversationOf(v.conversationId))) return v
    return { agentId: v.agentId, url: '', title: '', shown: false, log: [], at: v.at }
  }

  // A computer's services started for a conversation this person doesn't see aren't theirs to see.
  // Where a computer's files are on the machine is the owner's to know (a data folder, a home).
  computerFor(person: Person, c: ComputerInfo): ComputerInfo {
    const hidden = c.services.filter((s) => s.conversationId && !this.canSeeConversation(person, this.conversationOf(s.conversationId)))
    const out = hidden.length ? { ...c, services: c.services.filter((s) => !hidden.includes(s)) } : c
    return person.role === 'owner' ? out : { ...out, folder: '' }
  }

  // A connector as this person reads it: the owner, as it is; an admin, its command and address
  // with what looks like a secret masked (a token after --token, a key in the query); anyone else,
  // its name, kind, status and tools and nothing of how it's reached (no command, args, address, env).
  connectorFor(person: Pick<Person, 'role'>, c: Connector): Connector {
    if (person.role === 'owner') return c
    if (!isAdmin(person)) return { id: c.id, name: c.name, kind: c.kind, auth: c.auth, status: c.status, tools: c.tools }
    return { ...c, ...(c.args ? { args: redactArgs(c.args) } : {}), ...(c.url ? { url: redactUrl(c.url) } : {}), ...(c.error ? { error: maskSecrets(c.error) } : {}), ...(c.errorDetail ? { errorDetail: maskSecrets(c.errorDetail) } : {}) }
  }

  // Whether this person may see a file or page that came from a conversation (none: everyone).
  canSeeFrom(person: Person, conversationId: string | undefined): boolean {
    return !conversationId || this.canSeeConversation(person, this.conversationOf(conversationId))
  }

  // Saving a routine: where it goes and, for one that exists, where it is now must both be this
  // person's to reach (no one moves a routine out of someone else's DM), with the rules of both.
  routineSave(person: Person, routine: Pick<RoutineInput, 'id' | 'conversationId' | 'scope' | 'trigger'>): Routine | undefined {
    const reach = (id: string | undefined): void => {
      const why = this.conversationError(person, id)
      if (why) throw new Error(why)
    }
    if (routine.conversationId) reach(routine.conversationId)
    const prev = routine.id ? this.db.routine(routine.id) : undefined
    if (prev) {
      reach(prev.conversationId)
      must(person, { kind: 'routine', routine: prev })
    }
    must(person, { kind: 'routine', routine: { scope: routine.scope ?? prev?.scope ?? 'me', owner: prev?.owner ?? person.id } })
    // A connector check (a trigger reading a connector) is the admins': connectors are.
    if (routine.trigger?.kind === 'poll' && JSON.stringify(routine.trigger) !== JSON.stringify(prev?.trigger)) must(person, { kind: 'admin' })
    return prev
  }

  // "Me avise": a channel routine, by someone who reads that channel (one's own routine always tells them).
  watch(person: Person, routineId: string): Routine {
    const r = this.db.routine(routineId)
    const why = this.conversationError(person, r?.conversationId)
    if (!r || why) throw new Error(why ?? L('Essa rotina não existe mais.', 'That routine no longer exists.'))
    if (r.scope !== 'channel') throw new Error(L('Só dá pra pedir aviso de uma rotina do canal.', 'Only a channel routine can be followed.'))
    return r
  }

  // Taking an invite back: an admin's invite (only the owner makes those) is the owner's to take back.
  revokeInvite(by: Person, id: string): void {
    must(by, { kind: 'admin' })
    const invite = this.db.invite(id)
    if (invite?.role === 'admin') must(by, { kind: 'owner' })
    this.db.removeInvite(id)
    this.db.addActivity({ personId: by.id, kind: 'invite.revoked', target: id })
  }

  // ---------- what waits on someone ----------

  canDecide(person: Person, a: Pick<Approval, 'agentId'>): boolean {
    return can(person, { kind: 'approval', agentOwner: agentOwner(this.db, a.agentId) })
  }

  canAnswer(person: Person, q: Question, now = Date.now()): boolean {
    return can(person, { kind: 'question', question: q, askedTo: this.db.person(q.askedTo), now })
  }

  // Approvals this person can decide, and the questions waiting on them: asked to them (or to
  // someone they cover for), a DM's question waiting on their yes, or one past its deadline that
  // they had asked for. A question from a DM that isn't theirs comes without where it was asked.
  // Work handed down the tree that is open, or ended in the last day, in channels this person sees.
  delegations(person: Person, now = Date.now()): Delegation[] {
    return this.db.liveDelegations(now - 86_400_000).filter((d) => this.canSeeConversation(person, this.conversationOf(d.conversationId)))
  }

  inbox(person: Person, now = Date.now()): Inbox {
    const approvals = this.db.approvals().filter((a) => a.state === 'pending' && this.canDecide(person, a) && this.canSeeApproval(person, a))
    // A question from a DM that isn't theirs comes without where it was asked.
    const shown = (q: Question): Inbox['questions'][number] => {
      if (this.canSeeConversation(person, this.conversationOf(q.conversationId))) return q
      const { conversationId: _c, threadId: _t, ...only } = q
      return only
    }
    const questions = this.db.openQuestions().flatMap((q) => {
      const waiting =
        q.confirm === 'pending'
          ? q.requestedBy === person.id
          : q.askedTo === person.id || delegating(this.db.person(q.askedTo), person.id, now) || (now >= q.deadlineAt && q.requestedBy === person.id)
      if (!waiting) return []
      // Its decisions, to answer them on the card from here too (the question only, as its text is).
      const run = this.db.message(q.id)?.run
      return [{ ...shown(q), ...(run?.questions?.length ? { decisions: run.questions, ...(run.answers ? { answers: run.answers } : {}) } : {}) }]
    })
    // Asked to them and answered a moment ago by someone else (an admin, whoever covers for them).
    const answered = this.db.answeredQuestions(now - ANSWERED_SHOWN_MS).filter((q) => q.askedTo === person.id && q.answeredBy !== person.id).map(shown)
    const proposals = isAdmin(person) ? this.forwardedProposals() : []
    return { approvals, questions, ...(answered.length ? { answered } : {}), ...(proposals.length ? { proposals } : {}) }
  }

  // The cards members sent to the admins that no one has applied or dismissed yet (a reply's cards
  // each on its own: `index`, which of them).
  forwardedProposals(): InboxProposal[] {
    const out: InboxProposal[] = []
    for (const e of this.db.activity({ kind: 'proposal.forwarded', limit: 200 })) {
      const m = e.target ? this.db.message(e.target) : undefined
      const index = typeof e.detail?.['index'] === 'number' ? e.detail['index'] : 0
      const p = proposalsOf(m?.run)[index]
      if (!m || !p || p.state || m.author.kind !== 'agent' || out.some((x) => x.id === m.id && (x.index ?? 0) === index)) continue
      out.push({ id: m.id, ...(index ? { index } : {}), agentId: m.author.id, proposal: p, by: e.personId ?? '', at: e.at })
    }
    return out
  }

  // An admin reaches a card a member sent them, even from that member's DM (the card, not the DM).
  forwarded(person: Person, messageId: string, index = 0): boolean {
    return isAdmin(person) && this.forwardedProposals().some((p) => p.id === messageId && (p.index ?? 0) === index)
  }

  // The snapshot as this person gets it: no one else's DMs, their messages or their memories.
  snapshotFor(person: Person, base: Omit<Snapshot, 'people' | 'former' | 'you' | 'needsName' | 'conversations' | 'inbox' | 'delegations'>, opts: { server?: boolean } = {}): Snapshot {
    const conversations = this.db.conversations(person.id).filter((c) => this.canSeeConversation(person, c))
    const seen = new Set(conversations.map((c) => c.id))
    const theirs = base.messages.filter((m) => seen.has(m.conversationId))
    const messages = theirs.filter((m) => this.visibleAt(person, m))
    // A channel with messages from before the heritage: a member reads one line where they were.
    const cut = new Set(theirs.filter((m) => !messages.includes(m)).map((m) => m.conversationId))
    // The demo connector is a path on the owner's machine: the owner's to add.
    const { demoServer, ...shared } = base
    return {
      ...shared,
      ...(person.role === 'owner' && demoServer ? { demoServer } : {}),
      settings: this.settingsFor(person, base.settings),
      conversations,
      ...(base.since ? { since: Object.fromEntries(Object.entries(base.since).filter(([id]) => seen.has(id) && !cut.has(id))) } : {}),
      messages: cut.size ? [...[...cut].map((id) => this.boundaryLine(id)), ...messages] : messages,
      connectors: base.connectors.map((c) => this.connectorFor(person, c)),
      artifacts: base.artifacts.filter((a) => seen.has(a.conversationId) && this.artifactVisible(person, a)),
      routines: base.routines.filter((r) => seen.has(r.conversationId)),
      approvals: base.approvals.filter((a) => this.canSeeApproval(person, a)),
      memories: base.memories.filter((m) => this.canSeeMemory(person, m)),
      browsers: base.browsers.map((v) => this.browserFor(person, v)),
      computers: base.computers.map((c) => this.computerFor(person, c)),
      people: this.db.people(),
      ...(this.db.formerPeople().length ? { former: this.db.formerPeople() } : {}),
      you: person.id,
      inbox: this.inbox(person),
      delegations: this.delegations(person),
      ...(opts.server && person.role === 'owner' && !this.db.ownerNamed() ? { needsName: true } : {})
    }
  }

  // ---------- coming in ----------

  // The person a key opens, while they have access.
  authenticate(key: unknown): Person | undefined {
    if (typeof key !== 'string' || !/^p_[\w-]{43}$/.test(key)) return undefined
    return this.db.personByKey(hashSecret(key))
  }

  // Whether a key was a person's who was removed since (their browser is signed out, not guessing).
  removedKey(key: unknown): boolean {
    return typeof key === 'string' && /^p_[\w-]{43}$/.test(key) && this.db.removedKey(hashSecret(key))
  }

  createInvite(by: Person, p: { role: Exclude<Role, 'owner'>; about?: string; restore?: string }, now = Date.now()): { code: string; expiresAt: number } {
    must(by, { kind: 'admin' })
    if (p.role !== 'admin' && p.role !== 'member') throw new Error(L('Escolha admin ou membro.', 'Pick admin or member.'))
    // Only the owner makes an admin.
    if (p.role === 'admin') must(by, { kind: 'owner' })
    const back = p.restore ? this.db.removedPerson(p.restore) : undefined
    if (p.restore && !back) throw new Error(L('Essa pessoa não foi removida.', "That person wasn't removed."))
    if (back?.purgedAt) throw new Error(purgedError())
    if (back) must(by, { kind: 'person', target: back, role: p.role })
    const code = newInviteCode()
    const expiresAt = now + INVITE_DAYS * 86_400_000
    this.db.saveInvite({ id: hashSecret(code), role: p.role, about: (p.about ?? '').trim().slice(0, 500), ...(p.restore ? { restore: p.restore } : {}), createdBy: by.id, createdAt: now, expiresAt })
    this.db.addActivity({ personId: by.id, kind: 'invite.created', target: hashSecret(code), detail: { role: p.role, ...(p.restore ? { restore: p.restore } : {}) }, at: now })
    return { code, expiresAt }
  }

  // Whom a good invite brings back (one that restores someone not purged), by their name.
  inviteName(code: unknown, now = Date.now()): string | undefined {
    const invite = typeof code === 'string' && code ? this.db.invite(hashSecret(code)) : undefined
    if (!invite?.restore || invite.usedAt || invite.expiresAt <= now) return undefined
    const back = this.db.removedPerson(invite.restore)
    return back && !back.purgedAt ? back.name : undefined
  }

  // An invite's code and a name: the person comes in (or back, when the invite restores them) with
  // a key of their own, shown once. A code that's wrong, used or past its week gets no one in.
  // `routines`: the ones of a person back that were on (the caller schedules them again).
  join(code: unknown, name: unknown, now = Date.now()): { person: Person; key: string; routines?: string[] } | { error: string } {
    const clean = typeof name === 'string' ? cleanName(name) : ''
    const invite = typeof code === 'string' && code ? this.db.invite(hashSecret(code)) : undefined
    if (!invite || invite.usedAt || invite.expiresAt <= now) return { error: L('Esse convite não vale mais. Peça um novo a quem te convidou.', 'That invite is no longer valid. Ask whoever invited you for a new one.') }
    if (!clean) return { error: L('Diga seu nome.', 'Tell us your name.') }
    if (clean.length > MAX_NAME) return { error: nameLongError() }
    return this.db.tx(() => {
      const back = invite.restore ? this.db.removedPerson(invite.restore) : undefined
      // Their data is gone (purged): they can't come back as themselves, and the code isn't spent.
      if (invite.restore && (!back || back.purgedAt)) return { error: purgedError() }
      // Someone else's name isn't theirs to take; the code stays good for another.
      if (this.nameTaken(clean, back?.id, true)) return { error: nameTakenError() }
      const id = back?.id ?? randomUUID()
      if (!this.db.useInvite(invite.id, id, now)) return { error: L('Esse convite não vale mais. Peça um novo a quem te convidou.', 'That invite is no longer valid. Ask whoever invited you for a new one.') }
      const routines = back ? this.db.restorePerson(id, { name: clean, role: invite.role, about: invite.about }) : undefined
      if (!back) this.db.addPerson({ id, name: clean, role: invite.role, about: invite.about })
      // Someone new gets their own short welcome first (who invited them, the team, the deal).
      if (!back) this.db.setPrefs(id, { onboarding: { done: true, guest: { by: this.db.person(invite.createdBy)?.name } } })
      const key = newKey()
      this.db.addPersonKey(hashSecret(key), id, 'convite')
      this.db.addActivity({ personId: id, kind: back ? 'person.restored' : 'person.joined', target: id, detail: { role: invite.role, invitedBy: invite.createdBy }, at: now })
      return { person: this.db.person(id)!, key, ...(routines?.length ? { routines } : {}) }
    })
  }

  // A one-time pairing code spent on a server (src/server/pair-codes.ts): a new key for that person
  // (unset: the owner), for one device. Someone removed, or no one, gets none.
  deviceKey(personId: unknown, label: unknown): { person: Person; key: string } | undefined {
    const person = personId === undefined || personId === null ? this.db.owner() : typeof personId === 'string' ? this.db.person(personId) : undefined
    if (!person) return undefined
    const key = newKey()
    this.db.addPersonKey(hashSecret(key), person.id, typeof label === 'string' && label ? label.slice(0, 120) : 'aparelho')
    return { person: this.db.person(person.id) ?? person, key }
  }

  // Whether this name would read as someone else's: a person here, one removed who may still come
  // back (until purged), or, once there are people to call, an agent (by its name or its handle: @lia
  // would call both). A Tucano of one calls no person: its owner may be a Nina next to the agent Nina.
  nameTaken(name: string, except?: string, team = this.db.people().length > 1): boolean {
    const k = nameKey(name)
    if (!k) return false
    const people = [...this.db.people(), ...this.db.removedPeople()]
    // One @handle is one person: "Bia.Teste" would be @biateste, as "Bia Teste" is.
    const h = personHandles({ name: cleanName(name) }).full
    return people.some((p) => p.id !== except && (nameKey(p.name) === k || (!!h && personHandles(p).full === h))) || (team && this.db.agents().some((a) => nameKey(a.name) === k || nameKey(a.handle) === k))
  }

  // Why an agent may not be called this, or nothing. Its @handle is one agent's: an archived agent
  // keeps its handle (its history is written under it; back from the archive, it's still @lia).
  // Once there are people to call (see nameTaken), neither its name nor its handle may read as a
  // person's here or one removed who may come back: @lia would call both, and the log couldn't tell them apart.
  agentNameError(a: { id?: string; name: string; handle: string }): string | undefined {
    const handle = a.handle.trim().toLowerCase()
    const other = this.db.agents().find((x) => x.id !== a.id && x.handle.toLowerCase() === handle)
    if (other) return L(`Já existe um agente com o @${handle}${other.archived ? ' (arquivado: ele guarda o @ dele)' : ''}. Escolha outro.`, `There's already an agent with @${handle}${other.archived ? ' (archived: it keeps its handle)' : ''}. Pick another.`)
    if (!this.db.teamMode()) return undefined
    const keys = new Set([nameKey(a.name), nameKey(handle)].filter(Boolean))
    const people = [...this.db.people(), ...this.db.removedPeople()]
    const clash = people.find((p) => keys.has(nameKey(p.name)) || (!!handle && (personHandles(p).full === handle || personHandles(p).first === handle)))
    return clash ? L(`Já tem uma pessoa chamada ${clash.name} aqui. Dê outro nome e outro @ ao agente.`, `There's already a person called ${clash.name} here. Give the agent another name and handle.`) : undefined
  }

  // Their access ends now: keys go (open connections are the caller's to close). Their agents and
  // routines go to the owner; their DMs and memories wait KEEP_REMOVED_DAYS for a re-invite.
  remove(by: Person, id: string, now = Date.now()): { person: Person; agents: string[]; routines: string[] } {
    const p = this.db.person(id)
    if (!p) throw new Error(L('Essa pessoa não está mais aqui.', 'That person is no longer here.'))
    if (p.role === 'owner') throw new Error(L('O dono do Tucano não pode ser removido.', "The Tucano's owner can't be removed."))
    if (!can(by, { kind: 'person', target: p })) {
      if (p.role === 'admin' && by.role === 'admin' && p.id !== by.id) throw new Error(L('Só o dono remove um admin.', 'Only the owner removes an admin.'))
      must(by, { kind: 'person', target: p })
    }
    return this.db.tx(() => {
      this.db.removePerson(id)
      const given = this.db.handOver(id)
      this.db.addActivity({ personId: by.id, kind: 'person.removed', target: id, detail: { name: p.name, agents: given.agents.length, routines: given.routines.length }, at: now })
      return { person: p, ...given }
    })
  }

  // Someone leaves on their own (the phone app's "Sair deste Tucano", the account deletion app
  // stores ask for): access ends now, and what was theirs alone goes now too, not in 30 days (their
  // DMs, memories, own routines). What they made for the team (agents, a channel's routines) goes
  // to the owner, as when someone is removed; what they said in channels stays the channel's. The
  // owner can't leave their own Tucano.
  leave(by: Person, now = Date.now()): { agents: string[]; routines: string[]; purged: Purged } {
    if (by.role === 'owner') throw new Error(L('O dono não sai do próprio Tucano. Pra apagar tudo, desligue o servidor e apague a pasta de dados dele.', "The owner can't leave their own Tucano. To delete everything, stop the server and delete its data folder."))
    const out = this.db.tx(() => {
      this.db.removePerson(by.id)
      const given = this.db.handOver(by.id)
      const purged = { person: by.id, ...this.db.purgePerson(by.id, now) }
      this.db.addActivity({ personId: by.id, kind: 'person.left', target: by.id, detail: { name: by.name, agents: given.agents.length, routines: given.routines.length }, at: now })
      return { ...given, purged }
    })
    this.db.scrub()
    return out
  }

  // Member ⇄ admin. Only the owner touches admins (or makes one); no one, the owner.
  setRole(by: Person, id: string, role: Exclude<Role, 'owner'>): Person {
    const p = this.db.person(id)
    if (!p) throw new Error(L('Essa pessoa não está mais aqui.', 'That person is no longer here.'))
    if (role !== 'admin' && role !== 'member') throw new Error(L('Escolha admin ou membro.', 'Pick admin or member.'))
    must(by, { kind: 'person', target: p, role })
    if (p.role === role) return p
    this.db.setRole(id, role)
    this.db.addActivity({ personId: by.id, kind: 'person.role', target: id, detail: { from: p.role, to: role } })
    return this.db.person(id)!
  }

  // Someone answering and approving for me until then (`to` null: no one).
  setDelegation(by: Person, to: string | null, until: number | undefined, now = Date.now()): void {
    if (to === null) {
      this.db.setDelegation(by.id)
      this.db.addActivity({ personId: by.id, kind: 'person.delegation', target: by.id, detail: { to: null }, at: now })
      return
    }
    if (to === by.id || !this.db.person(to)) throw new Error(L('Escolha outra pessoa do Tucano.', 'Pick someone else in this Tucano.'))
    if (typeof until !== 'number' || !Number.isFinite(until) || until <= now) throw new Error(L('Escolha até quando.', 'Pick until when.'))
    this.db.setDelegation(by.id, to, until)
    this.db.addActivity({ personId: by.id, kind: 'person.delegation', target: by.id, detail: { to, until }, at: now })
  }

  // A removed person's DMs and memories, gone for good (the owner, before the 30 days). What went
  // comes back: the caller stops what ran there and deletes the files.
  purge(by: Person, id: string, now = Date.now()): Purged {
    must(by, { kind: 'owner' })
    if (!this.db.removedPerson(id)) throw new Error(L('Só dá pra apagar os dados de quem foi removido.', 'Only a removed person’s data can be purged.'))
    const name = this.db.removedPerson(id)?.name
    const out = { person: id, ...this.db.purgePerson(id, now) }
    this.db.addActivity({ personId: by.id, kind: 'person.purged', target: id, ...(name ? { detail: { name } } : {}), at: now })
    this.db.scrub()
    return out
  }

  // Once a day: the people removed more than KEEP_REMOVED_DAYS ago lose what was kept for them.
  sweep(now = Date.now()): Purged[] {
    const out: Purged[] = []
    for (const id of this.db.purgeable(now - KEEP_REMOVED_DAYS * 86_400_000)) {
      const name = this.db.removedPerson(id)?.name
      out.push({ person: id, ...this.db.purgePerson(id, now) })
      this.db.addActivity({ kind: 'person.purged', target: id, ...(name ? { detail: { name } } : {}), at: now })
    }
    if (out.length) this.db.scrub()
    return out
  }
}

// A connector's arguments for an admin: the value after a flag that names a secret (--token x,
// --api-key=x, -p x), and any value shaped like one (long, random-looking), masked.
const SECRET_FLAG = /^-{1,2}(?:[\w-]*(?:token|secret|key|pass(?:word)?|auth|credential|bearer|apikey|api-key|session|cookie)[\w-]*|p)$/i
const SECRET_SHAPE = /^[A-Za-z0-9_\-.]{20,}$/ // a token, a hash: not a word, not a path
export function redactArgs(args: string[]): string[] {
  const out: string[] = []
  let hide = false
  for (const a of args) {
    const eq = /^(-{1,2}[\w-]+)=(.*)$/.exec(a)
    if (hide) (out.push('****'), (hide = false))
    else if (eq && SECRET_FLAG.test(eq[1]!)) out.push(`${eq[1]}=****`)
    else if (SECRET_FLAG.test(a)) (out.push(a), (hide = true))
    else out.push(!a.startsWith('-') && !a.includes('/') && SECRET_SHAPE.test(a) && /\d/.test(a) ? '****' : a)
  }
  return out
}
// A connector's address for an admin: the host and path stay; every query value and any user info go.
export function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.username || u.password) (u.username = '****'), (u.password = '')
    const keys = [...u.searchParams.keys()]
    for (const k of keys) u.searchParams.set(k, '****')
    return decodeURIComponent(u.toString())
  } catch {
    return url.replace(/\?.*$/, '?****')
  }
}

// The connections to the core (a desktop window, a server's browser tabs), each one a person's.
// Every event goes through what that person may see.
export interface PortLike {
  postMessage(msg: unknown): void
  close(): void
}

export class Hub<P extends PortLike> {
  private ports = new Map<P, string>() // port → person id
  private devices = new Map<P, string>() // port → the hash of the key it signed in with (a server's browser)

  constructor(private people: People, private db: Db) {}

  // The person this port is, or undefined (the port was closed).
  add(port: P, data: unknown): Person | undefined {
    const person = this.people.resolve(data)
    if (!person) {
      port.close()
      return undefined
    }
    this.ports.set(port, person.id)
    const device = (data as { device?: unknown } | null | undefined)?.device
    if (typeof device === 'string') this.devices.set(port, device)
    return person
  }

  delete(port: P): void {
    this.ports.delete(port)
    this.devices.delete(port)
  }

  deviceOf(port: P): string | undefined {
    return this.devices.get(port)
  }

  // A device disconnected: the connections it opened end at once.
  closeDevice(hash: string): void {
    for (const [port, h] of [...this.devices]) {
      if (h !== hash) continue
      this.delete(port)
      port.close()
    }
  }

  personOf(port: P): Person | undefined {
    const id = this.ports.get(port)
    return id === undefined ? undefined : this.db.person(id)
  }

  emit(event: CoreEvent): void {
    const each = new Map<string, Person | undefined>() // read once per person, not per port
    for (const [port, id] of this.ports) {
      if (!each.has(id)) each.set(id, this.db.person(id))
      const person = each.get(id)
      const shown = person && this.people.eventFor(event, person)
      if (shown) port.postMessage({ event: shown } satisfies Wire)
    }
  }

  // A removed person's connections end at once.
  closeFor(personId: string): void {
    for (const [port, id] of [...this.ports]) {
      if (id !== personId) continue
      this.delete(port)
      port.close()
    }
  }
}
