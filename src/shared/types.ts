// Domain types shared by the core (utility process) and the renderer.
import type { AvatarDefinition } from 'open-bot-avatar'
import type { ActionRules, Autonomy } from './actions'
import type { ChannelLayout } from './channel-layout'
import type { Answer, Decision } from './questions'
import { L, lang, locale, type Lang } from './lang'

export type AgentColor = 'sky' | 'indigo' | 'violet' | 'rose' | 'amber' | 'green' | 'teal' | 'graphite'
export type GrantLevel = 'none' | 'read' | 'read_write'
export type ToolClass = 'read' | 'write' | 'sensitive'
export type EngineId = 'claude' | 'codex' | 'opencode' | 'pi' | 'antigravity' | 'cursor' | 'grok' | 'cline'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type MemoryMode = 'auto' | 'approve' | 'read' // how an agent's `lembrar` calls land

export interface Model {
  id: string // the value passed to the CLI's --model
  engine: EngineId
  label: string
  hint: string
}

// The system the app runs on (src/core/platform.ts).
export type Os = 'mac' | 'linux' | 'windows'

// Shortcuts use ⌘ on a Mac and Ctrl elsewhere, shown the way each system writes them.
export const shortcut = (os: Os, key: string): string => (os === 'mac' ? `⌘${key}` : `Ctrl+${key}`)

// The app's own updates (src/main/updates.ts): off when run from the code.
export interface UpdateState {
  version: string // the one running
  status: 'off' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  next?: string // the newer version, while it downloads and once it's ready
  percent?: number
  checkedAt?: number
  error?: string // what went wrong, for people
  errorKind?: 'offline' | 'other' // 'other': the app can be downloaded by hand from the releases page
}

export interface EngineStatus {
  installed: boolean
  path?: string
  version?: string
  loggedIn: boolean
  account?: string // how the CLI is logged in, e.g. "Assinatura Claude"
  warning?: string // e.g. logged in with an API key instead of a subscription
  // Where it sends requests, read from its own config: the person's plan, a gateway
  // (a company's, or a provider like OpenCode Go), an API key, or the providers it has logins for.
  route?: 'plan' | 'gateway' | 'apikey' | 'providers'
  gateway?: string // the gateway's host
  off?: boolean // the person didn't pick this harness: no agent runs on it
  soon?: boolean // the app can't run agents on it yet
  checking?: boolean // not checked yet: the app has just opened for the first time
}

// The agents of the team: not archived, and not the Tuca, who belongs to the app.
export const isTeam = (a: Pick<Agent, 'archived' | 'kind'>): boolean => !a.archived && a.kind !== 'tuca'

export interface Agent {
  id: string
  name: string
  handle: string
  role: string
  color: AgentColor
  customColor?: string // a color of the person's own (#rrggbb), over `color`
  picture?: string // a small picture (data URL), over the face
  avatar?: AvatarDefinition // a drawn character (open-bot-avatar), over the face; a picture wins over it
  wiki?: WikiAccess // what it can do with the wiki; 'read' when unset
  instructions: string
  modelId: string
  // Where a reply goes when modelId's subscription is out (its 5-hour or weekly limit, a 429): tried
  // only when the main model failed before doing anything, and the next reply tries the main one again.
  fallbackModelId?: string
  // The login the reserve runs on: one of settings.accounts, of the reserve's harness; unset: that harness's usual login.
  // With it, the reserve can be the same model on another account, when the main account's limit is out.
  fallbackAccountId?: string
  accountId?: string // one of settings.accounts, for its harness; unset: the harness's own login
  effort: Effort
  limit: number // tokens per month
  maxRoutines?: number // routines on at once; unset: MAX_AGENT_ROUTINES
  used: number // tokens used this month, computed from receipts
  grants: Record<string, GrantLevel>
  memory: MemoryMode
  computer: boolean // has a computer (spec §13): see computerKind for which
  computerKind?: ComputerKind // 'linux' (default): an isolated container; 'mac': this Mac, as the user (spec §23)
  web?: boolean // searches the web and reads pages with the CLI's own tools (spec §16); on unless false
  browser?: boolean // drives a browser of its own: opens, clicks, types (spec §24); off unless true
  apps?: AgentApp[] // the person's own apps it may use (Notes, Mail…), each to read or to read and change
  autoApprove?: string[] // "connectorId:tool" sensitive tools approved for good ("sempre permitir"), never high-risk ones
  actionRules?: ActionRules // what it does about a commit, a push, a PR…: over settings.actionRules, kind by kind; unset kinds follow them
  autonomy?: Autonomy // how far it goes on its own (src/shared/actions.ts); unset: Settings' level
  outsideGuard?: boolean // false: what goes out (a send, a post, a payment) runs on its rules even after reading something from outside; unset: Settings'
  folders?: LentFolder[] // Mac folders lent to that computer (spec §13, M5.1); changed only through lendFolder/folderAction
  archived: boolean
  kind?: 'tuca' // the agent that builds the others: it proposes, the person creates
  owner?: string // the person who gets its approvals: whoever created it (the Tucano's owner for older agents)
}

// One of the person's apps given to an agent, by the name the system shows.
export interface AgentApp {
  name: string
  level: 'read' | 'read_write'
}

// A folder of the Mac mounted in an agent's computer at /projetos/<name>.
export interface LentFolder {
  name: string
  path: string // absolute, on the Mac
  readOnly: boolean
}

export const PROJECTS_DIR = '/projetos'

// Where an agent's computer runs: an isolated Linux container, or the user's own Mac (spec §23).
export type ComputerKind = 'linux' | 'mac'
export const isMac = (a: Pick<Agent, 'computer' | 'computerKind'>): boolean => a.computer && a.computerKind === 'mac'

export interface Conversation {
  id: string
  kind: 'channel' | 'dm'
  name: string // channel name, or agent id for a DM
  topic?: string
  members: string[] // agent ids
  summary?: string // what the conversation covered before its recent messages
  summaryUntil?: number // `at` of the last message the summary covers
  summaryAt?: number
  unread?: number
  wikiCapture?: boolean // false: the wiki's curator leaves this conversation out
  threads?: boolean // true: each message's answers go in its thread; unset: in the conversation, like a chat
  owner?: string // a DM's person: one DM per agent and person, and only they read it
  createdBy?: string // a channel's maker: they (and admins) rename it, change its topic and its agents
}

// "Lançamento do App" → "lancamento-do-app": lowercase, no accents, hyphens.
export const channelName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 60)

export type StepStatus = 'running' | 'done' | 'error'
export interface Step {
  id: string
  label: string
  detail?: string
  note?: string // what the agent said while working, before this step's tool call
  error?: string // why it failed, in the tool's own words
  input?: string // what the call asked, the argument that says it (the SQL, the path), as it was sent
  output?: string // what came back, in a few words ("120 rows")
  status: StepStatus
  ms?: number
}

export interface Receipt {
  model: string
  inputTokens: number // everything sent, including cache reads
  cacheReadTokens: number
  outputTokens: number
  ms: number
  apiCostUsd?: number // what the same usage would cost on the API, when the CLI reports it
}

export type RunStatus = 'working' | 'waiting_input' | 'waiting_approval' | 'done' | 'stopped' | 'limit_reached' | 'failed' | 'interrupted' | 'paused'

export interface Run {
  status: RunStatus
  steps: Step[]
  endedAt?: number // when this reply ended, however it ended: where the conversation shows it (saidAt)
  receipt?: Receipt
  approvalId?: string
  outside?: boolean // it read something from outside (a connector's answer, a page, an app, the web, a trigger's event): what goes out after asks first, with the guard on
  error?: string // what happened and what to do, for people (src/shared/errors.ts)
  errorDetail?: string // the raw text behind it (a CLI's stderr), shown folded
  depth?: number // 1 when a human message triggered it, +1 for each agent-to-agent hop
  replyTo?: string // the message (a person's) it answers, when one did
  answeredBy?: string // who answered its question (another person than the one asked, maybe)
  question?: string // asked with ask_user, as plain text (every decision, numbered); answered by the next human message here
  questions?: Decision[] // the same decisions, structured (one to four, with options): read them with questionsOf
  answers?: (Answer | null)[] // what was answered on the card so far, by decision, before sending
  answeredInText?: true // the reply had text of its own, beyond the decisions answered
  answerMessage?: string // the message that sent the decisions answered on the card (the agent reads it; the card shows it)
  answerTyped?: string // what that message had beyond them, written in the message box
  askedTo?: string // the person the question is for (unset with one person: whoever asked the agent)
  memoryIds?: string[] // memories saved or proposed with `lembrar` in this reply
  wikiChanges?: string[] // what the wiki's curator kept from this exchange (change packages)
  artifactIds?: string[] // files and screenshots shown in this reply
  services?: string[] // services started in this reply, by name, on the author's computer
  routineIds?: string[] // routines scheduled or changed with `agendar_rotina` in this reply
  browser?: boolean // used its browser in this reply (the message links to the live view)
  budget?: number // 'paused': the per-reply budget it reached, in counted tokens
  task?: string // what this reply was asked beyond the conversation; kept only while it can be tried again or go on
  work?: string // the piece of work it counts toward, e.g. the issue "OAB-65" (spec §20)
  agentDraft?: AgentDraft // an agent the Tuca proposed with propor_agente, shown as a card
  proposal?: Proposal // what an agent proposed, from before a reply could hold several (read both with proposalsOf)
  proposals?: Proposal[] // what an agent proposed in this reply (changes to agents, routines, channels, teams), shown as a group of cards
}

// An agent the Tuca proposes. Nothing exists until the person creates it.
export interface AgentDraft {
  name: string
  role: string
  color: AgentColor
  instructions: string
  modelId: string
  effort: Effort
  maxRoutines?: number // routines on at once; unset: MAX_AGENT_ROUTINES
  web: boolean
  grants: Record<string, GrantLevel> // connector id → level; least access by default
  task?: string // a first task to try it with
  reason?: string
  state?: 'created' | 'dismissed'
  agentId?: string // once created
}

// What the Tuca may propose to change in an agent that exists.
export type AgentChanges = Partial<Pick<Agent, 'name' | 'role' | 'instructions' | 'modelId' | 'effort' | 'web' | 'grants' | 'limit'>>

// A change an agent proposes to what exists, or a new routine, channel or team: a card under its message
// with Aplicar and Descartar. Nothing changes until the person applies it. `appliedId`: the agent,
// routine or channel it made or changed; `error`: why applying it didn't work.
// A reply may hold several (a group under it, each applied on its own or all at once). `needs`: agents
// proposed in the same reply (by name: propor_agente's card or a team's) that must exist first; a
// routine for one has no agentId until then, and a channel adds them to `members`.
export type Proposal = (
  | { kind: 'agent'; agentId: string; changes: AgentChanges; before?: AgentChanges } // before: those fields as they were
  | { kind: 'routine'; routine: RoutineInput }
  | { kind: 'channel'; name: string; topic?: string; members: string[]; threads?: boolean }
  | { kind: 'team'; agents: AgentDraft[]; channel?: { name: string; topic?: string; threads?: boolean }; agentIds?: string[] } // several agents at once, and a channel with them; agentIds: the ones it made, in order
) & { reason?: string; state?: 'applied' | 'dismissed'; appliedId?: string; error?: string; needs?: string[] }

// What "apply all" did, card by card: applied, failed (with why), sent to the admins (a member's
// agents and teams); `draft`: the reply's new-agent card, when it went too.
export interface ProposalsResult {
  applied: { index: number; id: string }[]
  failed: { index: number; error: string }[]
  forwarded: number[]
  draft?: { agentId?: string; error?: string }
}

// The most proposals one reply holds.
export const MAX_PROPOSALS = 20

// A reply's proposals: the list, or the one a reply from before had.
export const proposalsOf = (run: { proposal?: Proposal; proposals?: Proposal[] } | undefined): Proposal[] => run?.proposals ?? (run?.proposal ? [run.proposal] : [])

// What a proposal is about: a newer one about the same thing replaces it (in the reply, or a later one).
export function proposalKey(p: Proposal): string {
  if (p.kind === 'agent') return `agent:${p.agentId}`
  if (p.kind === 'routine') return `routine:${p.routine.agentId || p.needs?.[0] || ''}:${p.routine.name.toLowerCase()}`
  if (p.kind === 'channel') return `channel:${p.name}`
  return `team:${p.channel?.name ?? p.agents.map((a) => a.name.toLowerCase()).sort().join(',')}`
}

// The order "apply all" goes in: what makes agents first (a team), then changes to agents, then
// channels and routines, which may need an agent made just before. Same kind: as proposed.
const RANK: Record<Proposal['kind'], number> = { team: 0, agent: 1, channel: 2, routine: 3 }
export const applyOrder = (ps: Proposal[]): number[] => ps.map((_, i) => i).sort((a, b) => RANK[ps[a]!.kind] - RANK[ps[b]!.kind] || a - b)

export type Author = { kind: 'person'; id: string } | { kind: 'agent'; id: string } | { kind: 'system' } | { kind: 'routine'; id: string }

// ---------- people ----------

// Every Tucano has people: a desktop has one, its owner; a server, whoever was invited.
export type Role = 'owner' | 'admin' | 'member'

// What everyone may know of a person: never their keys.
export interface Person {
  id: string
  name: string
  role: Role
  about: string // what they do, for the agents ("cuida do financeiro")
  delegateTo?: string // someone answering and approving for them…
  delegateUntil?: number // …until then
  seenAt?: number // when they last opened the Tucano with a key of theirs
  devices?: number // how many keys (browsers, apps) they have
}

// One of my own keys (a browser, the phone, the desktop app), as Settings › Pessoas lists them.
// `id` is the key's hash, never the key. No `seenAt`: it never signed in (a link preview's, say).
export interface Device {
  id: string
  label: string
  createdAt: number
  seenAt?: number
  current?: boolean // the one this page is signed in with
}

// Whether `of` has `who` covering for them right now.
export const delegating = (of: Pick<Person, 'delegateTo' | 'delegateUntil'> | undefined, who: string, now = Date.now()): boolean =>
  !!of && of.delegateTo === who && (of.delegateUntil ?? 0) > now

// A question an agent asked someone (ask_user). `confirm`: in a DM, a question to someone else
// waits first for the DM's person to say yes ('pending'); 'no' ends it there.
export interface Question {
  id: string // the agent's message that asked it
  conversationId: string
  threadId?: string
  agentId: string
  text: string
  askedTo: string // the person it's for
  requestedBy: string // whose request the agent was working on
  confirm?: 'pending' | 'yes' | 'no'
  state: 'open' | 'answered' | 'closed'
  deadlineAt: number // past it, the requester is told and may answer instead
  toldAt?: number
  answeredBy?: string
  answeredAt?: number
  createdAt: number
}

// What's waiting on a person: approvals they can decide and questions to them.
// A question from someone else's DM comes without where it was asked (they see the question only).
export interface Inbox {
  approvals: Approval[]
  // With the decisions asked (ask_user's options) and what was answered on the card so far.
  questions: (Omit<Question, 'conversationId' | 'threadId'> & { conversationId?: string; threadId?: string; decisions?: Decision[]; answers?: (Answer | null)[] })[]
  answered?: (Omit<Question, 'conversationId' | 'threadId'> & { conversationId?: string; threadId?: string; decisions?: Decision[]; answers?: (Answer | null)[] })[] // to me, answered by someone else a moment ago (the page keeps what I was typing)
  proposals?: InboxProposal[] // admins: what a member asked to apply (agents and teams are theirs)
}

// A Tuca card a member couldn't apply, sent to the admins: the card alone, not the DM it came from.
export interface InboxProposal {
  id: string // the card's message
  index?: number // which of its proposals (unset: the first)
  agentId: string // who proposed it (the Tuca)
  proposal: Proposal
  by: string // the member who asked
  at: number
}

// The team's log, for owners and admins: who did what, never what a DM said.
export interface ActivityEntry {
  id: string
  at: number
  personId?: string // who did it (none: the app itself, a sweep)
  kind: string // 'person.joined', 'approval.decided', 'agent.created'…
  target?: string // what it was done to: an id
  detail?: Record<string, unknown>
}

// An invite as admins see it: never its code, which only its link carries.
export interface Invite {
  id: string // the code's hash
  role: Exclude<Role, 'owner'>
  about: string
  restore?: string // a removed person this brings back
  createdBy: string
  createdAt: number
  expiresAt: number
  usedAt?: number
  usedBy?: string
}

// A person's own memories ("about me") live in this scope.
export const personScope = (personId: string): string => `person:${personId}`
export const scopePerson = (scope: string): string | undefined => (scope.startsWith('person:') ? scope.slice('person:'.length) : undefined)

export interface Message {
  id: string
  conversationId: string
  author: Author
  text: string
  at: number
  run?: Run
  routine?: RoutineRun // set on the message a routine posts (author kind 'routine')
  threadId?: string // a reply in a thread: the id of the message that started it (threads are one level deep)
  threadSummary?: ThreadSummary // on the message that started a thread: what the thread has covered
}

// When a message was said: a reply when it ended, anything else when it was written. `at` stays when it
// started, since that's what decides what it had read: agents read each other in that order.
export const saidAt = (m: Message): number => m.run?.endedAt ?? m.at

// A conversation as people read it: in the order things were said, and whoever is still working at the end.
export function asSaid(messages: Message[]): Message[] {
  const working = (m: Message): boolean => m.run?.status === 'working'
  return [...messages.filter((m) => !working(m)).sort((a, b) => saidAt(a) - saidAt(b)), ...messages.filter(working).sort((a, b) => a.at - b.at)]
}

// A thread's own summary, kept on its first message. `until`: the `at` of the last message it covers.
export interface ThreadSummary {
  text: string
  until: number
  at: number
}

// Dictation with whisper-cli. Unset paths are looked for in the usual places.
export interface VoiceSettings {
  bin?: string
  model?: string
  detect?: boolean // I speak other languages: whisper finds out which, instead of using the app's
  hidden?: boolean // no microphone button in the message field
}

export type VoiceModelId = 'recommended' | 'light' // the models the app downloads by itself

export interface VoiceStatus {
  bin?: string
  model?: string
  ready: boolean
  ownModel?: VoiceModelId // the model in use is one the app downloaded
  downloaded?: VoiceModelId[]
  downloading?: { model: VoiceModelId; received: number; total: number }
  error?: string // the last download failed
}

export interface LocalInfo {
  kind: 'image' | 'video' | 'pdf' | 'folder' | 'file'
  url?: string // to see it here: images and videos
  download?: string // on a server, where the file isn't on this computer: to save it here
}

export interface Settings {
  workspaceName: string // the person's name: what the agents call them
  workspaceLabel?: string // the workspace's own name, in the switcher; unset: workspaceName
  context: string
  engines: Record<EngineId, EngineStatus>
  routerModel: string // a model id, or 'jev' for TypeSafe's Jev (falls back to Haiku)
  jevKey?: boolean // a TypeSafe key is saved (the key itself never leaves the core)
  voice?: VoiceSettings
  channelLayout?: ChannelLayout // the person's order and groups in the sidebar
  browserJev?: boolean // Jev finds what agents click in their browsers (each click sends the page to TypeSafe)
  memoryModel: string // summarizes conversations and extracts memories
  memoryLearning: 'approve' | 'auto' | 'off' // what extracted memories about me become
  wikiCapture?: boolean // the curator reads the conversations and keeps what lasts; on when unset
  wikiEdits?: 'approve' | 'auto' // changing a page that exists: waits for me (the default) or goes in
  wikiReview?: 'weekly' | 'off' // reviews the wiki on its own once a week; by hand only otherwise (the default)
  wikiDir?: string // where the wiki's folder is (an Obsidian vault, say); inside the app's data when unset
  defaultLimit: number
  approvalTtlHours: number
  questionDeadlineHours?: number // a question to someone else, unanswered this long: the requester is told (default 4)
  actionRules?: ActionRules // for every agent: which actions ask me first, which it does alone, which never (src/shared/actions.ts)
  autonomy?: Autonomy // every agent's level, unless its page sets its own (default normal)
  outsideGuard?: boolean // after reading something from outside, what goes out asks first even where rules let it run (default on)
  theme: 'system' | 'light' | 'dark'
  language: Lang // the app's, and the language agents answer in
  openAtLogin?: boolean // so routines run without me opening the app
  runBudgetPct?: number // per reply, % of the agent's monthly limit before it pauses; default RUN_BUDGET_PCT
  runStallMinutes?: number // without any sign of life; default RUN_STALL_MINUTES
  chainDepth?: number // agent replies in a row from one human message; default CHAIN_DEPTH
  telegram?: TelegramInfo // computed: the phone bot (spec §19)
  paused?: boolean // "Pausar tudo": no agent starts working, no routine runs
  quietHours?: { from: string; to: string } | null // "HH:MM": routines and triggers wait, and run late when it ends; null: off
  quota?: Quota // the Claude subscription's windows, from the last reply (spec §21)
  // The harnesses agents may run on, picked in the introduction. Unset: every one that's ready.
  harnesses?: EngineId[]
  // The first-run introduction: unset on an existing install (no intro), done:false to show it (a new install, or "Rever a introdução")
  onboarding?: {
    done: boolean
    checklistHidden?: boolean // the missions, hidden from the sidebar
    workspaceManagerSeen?: boolean
    carried?: boolean // the general settings came from another workspace
    fresh?: boolean // a new install: the sidebar starts short and grows with the missions
    showAll?: boolean // "Mostrar tudo de uma vez": the whole sidebar, missions or not
    seen?: string[] // the sidebar parts a mission brought that the person already opened (no "new" tag)
    channel?: string // the channel the introduction made, where the first message waits
    tour?: { done?: string[]; skipped?: boolean } // the marks over the real screens, once each
    guest?: { by?: string } // someone just invited: their own short welcome first (who invited them)
  }
  folded?: string[] // the ids of what I folded in the sidebar
  sounds?: boolean // the toucan's chirp on a notification; unset: on
  seenVersion?: string // the last version whose news I closed; an update past it shows what's new once
  accounts?: Account[] // more logins of Claude Code or Codex, beside the one each already has
}

// Which chirp a notification plays: a knock when an agent needs me, two notes when the work
// is done, none when I turned the sounds off. The system's own notification is always silent,
// so this is the only sound the app makes.
export function chirpOf(kind: 'approval' | 'question' | 'done' | undefined, sounds: boolean | undefined): 'chama' | 'pronto' | null {
  if (sounds === false) return null
  return kind === 'approval' || kind === 'question' ? 'chama' : 'pronto'
}

// Another login of a harness (a work account beside a personal one), in a folder of its own
// in the app's data: Claude Code's CLAUDE_CONFIG_DIR (with its own Keychain entry), Codex's
// CODEX_HOME. The person signs in through the CLI itself; the app never sees the credentials.
export const ACCOUNT_ENGINES = ['claude', 'codex'] as const satisfies readonly EngineId[]
export type AccountEngine = (typeof ACCOUNT_ENGINES)[number]
export interface Account {
  id: string
  engine: AccountEngine
  name: string // what the person calls it ("Trabalho")
  loggedIn?: boolean // computed, from the CLI's own status
  detail?: string // computed: the plan it's on, as the CLI says
}

// What the main process does in an agent's browser for the core, and what it answers (spec §24).
export type BrowserOp = 'open' | 'snapshot' | 'click' | 'type' | 'key' | 'scroll' | 'back' | 'text' | 'frame' | 'show' | 'hide' | 'close' | 'clear' | 'input'

// What I do on the agent's browser from the panel, when it has no window of its own
// (Tucano as a server): x and y are fractions of the screen.
export type BrowserInput = { kind: 'click'; x: number; y: number } | { kind: 'text'; text: string } | { kind: 'key'; key: string } | { kind: 'scroll'; dy: number }

export interface BrowserElement {
  ref: number // its number in the last snapshot of the page
  role: string // botão, link, campo, lista, checkbox… or the ARIA role
  label: string
  value?: string // what a field or list holds now (passwords masked)
  checked?: boolean
  disabled?: boolean
  inView: boolean
  focused?: boolean // where a key goes now
  multiline?: boolean // a text area or an editable block: Enter there often sends (a comment, a message)
  submits?: string // a field in a form: the label of the button that sends it (what Enter does)
}

export interface BrowserReply {
  url: string
  title: string
  frame?: string // base64 JPEG of what's on screen
  w?: number // the viewport, in CSS pixels
  h?: number
  scrollY?: number
  scrollH?: number
  elements?: BrowserElement[]
  text?: string
  shown?: boolean // the window is open for me
  point?: { x: number; y: number } // where it just clicked or typed, as a fraction of the viewport
}

// An agent's browser as the side panel shows it (spec §24): the last frame and what it did.
export interface BrowserView {
  agentId: string
  url: string
  title: string
  frame?: string // data:image/jpeg URL of the page as it is now
  shown: boolean // the window is open for me ("Assumir"): I'm driving
  log: { label: string; detail: string; at: number }[] // the latest actions, oldest first
  doing?: { label: string; detail: string } // the action under way ("Clicando em", "Buscar")
  cursor?: { x: number; y: number; at: number } // where the agent last clicked or typed, as a fraction of the screen
  conversationId?: string // the conversation whose reply drives it now: only who sees that one sees the page
  at: number
}

export interface Quota {
  fiveHour?: { utilization: number; resetsAt: number } // 0..1, ms
  sevenDay?: { utilization: number; resetsAt: number }
  at: number
}

// Whether `now` falls in the quiet hours (which may cross midnight).
export function inQuietHours(q: Settings['quietHours'], now = new Date()): boolean {
  if (!q || !validTime(q.from) || !validTime(q.to) || q.from === q.to) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const [fh, fm] = q.from.split(':').map(Number) as [number, number]
  const [th, tm] = q.to.split(':').map(Number) as [number, number]
  const from = fh * 60 + fm
  const to = th * 60 + tm
  return from < to ? m >= from && m < to : m >= from || m < to
}

export interface TelegramInfo {
  bot?: string // @username, when a token is saved
  chat?: string // the paired chat's name
  code?: string // to pair: send "/start <code>" to the bot
  error?: string
}

// Guards per reply (spec §3), so nothing runs away unattended (a routine at 3 a.m.)
// without cutting long work that is going somewhere.
// Routines an agent can have on at once, so it can't schedule itself without end. Each agent can
// change it on its page (no upper bound: the monthly limit still holds); this is the default.
export const MAX_AGENT_ROUTINES = 10
// A whole number, at least 1: what the core enforces, whatever reached it.
export const routineCap = (n: number | undefined): number => (Number.isFinite(n) ? Math.max(1, Math.round(n as number)) : MAX_AGENT_ROUTINES)

export const RUN_BUDGET_PCT = 10 // past this share of the month, the reply pauses and asks to continue
export const RUN_STALL_MINUTES = 20 // no text, no tokens, no tool finishing: stuck
export const REPEAT_WARN = 3 // the same call with the same result: the agent is told to change course
export const REPEAT_STOP = 5 // ...and then the reply stops
export const ERRORS_STOP = 8 // tool calls failing in a row
export const SAME_TOOL_WARN = 15 // one connector tool called this many times in a reply (paging a whole history): told to narrow it
export const SAME_TOOL_STOP = 60 // ...and past it, that tool is refused for the rest of the reply
export const SLEEPS_FREE = 1 // commands that start by sleeping 20 s or more: the first runs, the next ones are refused
export const SLEEPS_STOP = 4 // refused sleeps in a reply before it stops
export const PENDING_WAIT_MINUTES = 5 // a connector result still running (a SQL statement) is awaited by the app this long
export const CHAIN_DEPTH = 3 // agent replies chained from one human message before Tucano stops them
export const MAX_CHAIN_DEPTH = 10
// Agents mentioning each other can't loop and burn tokens with nobody watching: a whole number from 1 to MAX_CHAIN_DEPTH, whatever reached the core.
export const chainDepthCap = (n: number | undefined): number => (Number.isFinite(n) ? Math.min(MAX_CHAIN_DEPTH, Math.max(1, Math.round(n as number))) : CHAIN_DEPTH)

// What a reply counts against limits: a token read from the cache costs about a
// tenth of a new one, so it counts a tenth.
export const CACHE_READ_WEIGHT = 0.1
export const countedTokens = (u: { inputTokens: number; cacheReadTokens: number; outputTokens: number }): number =>
  Math.round(u.inputTokens - u.cacheReadTokens * (1 - CACHE_READ_WEIGHT) + u.outputTokens)

// `windows`: the install command for PowerShell, where the POSIX one doesn't run.
export const ENGINES: Record<EngineId, { label: string; cli: string; login: string; install: string; windows?: string; site: string }> = {
  claude: { label: 'Claude Code', cli: 'claude', login: 'claude auth login', install: 'curl -fsSL https://claude.ai/install.sh | bash', windows: 'irm https://claude.ai/install.ps1 | iex', site: 'https://code.claude.com' },
  codex: { label: 'Codex', cli: 'codex', login: 'codex login', install: 'npm install -g @openai/codex', site: 'https://github.com/openai/codex' },
  opencode: { label: 'OpenCode', cli: 'opencode', login: 'opencode auth login', install: 'curl -fsSL https://opencode.ai/install | bash', windows: 'npm install -g opencode-ai', site: 'https://opencode.ai' },
  pi: { label: 'Pi', cli: 'pi', login: 'pi', install: 'npm install -g @earendil-works/pi-coding-agent', site: 'https://pi.dev' },
  antigravity: { label: 'Antigravity CLI', cli: 'agy', login: 'agy', install: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', windows: 'irm https://antigravity.google/cli/install.ps1 | iex', site: 'https://antigravity.google/docs/cli/overview' },
  cursor: { label: 'Cursor CLI', cli: 'cursor-agent', login: 'cursor-agent login', install: 'curl https://cursor.com/install -fsS | bash', windows: "irm 'https://cursor.com/install?win32=true' | iex", site: 'https://cursor.com/cli' },
  grok: { label: 'Grok', cli: 'grok', login: 'grok login', install: 'curl -fsSL https://x.ai/cli/install.sh | bash', site: 'https://x.ai/cli' },
  cline: { label: 'Cline CLI', cli: 'cline', login: 'cline auth', install: 'npm install -g cline', site: 'https://docs.cline.bot/cli/cli-reference' }
}
export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[]

// Codex or Claude Code being set up from the introduction, with no terminal (src/core/engine-setup.ts):
// getting the CLI, then the CLI's own sign-in (the screen does the test reply after).
export type SetupEngine = 'claude' | 'codex'
export interface SetupState {
  engine: SetupEngine
  step: 'install' | 'login'
  state: 'running' | 'done' | 'error' | 'cancelled'
  progress?: number // 0..1, while downloading
  url?: string // the sign-in page, in case the browser didn't open
  error?: string
}

// A harness's sign-in in the server's own terminal (src/core/login-terminal.ts), shown on a page or a phone.
export interface LoginScreen {
  id: string
  engine: EngineId
  account?: string // another login's id (Settings › Accounts); unset: the harness's usual one
  lines: string[]
  url?: string // the page to open, as the CLI shows it
  code?: string // a code to type on that page
  hint?: string // what to do first, for a harness whose sign-in starts inside its own screen
  state: 'running' | 'done' | 'failed' | 'cancelled'
  error?: string
}
export const LOGIN_KEYS = ['enter', 'up', 'down', 'left', 'right', 'esc', 'tab', 'backspace', 'space'] as const
export type LoginKey = (typeof LOGIN_KEYS)[number]

// A harness starts picked only when it can actually run: one not installed or not
// signed in yet starts off.
export const startsPicked = (st: EngineStatus): boolean => !st.soon && st.loggedIn

// Hints and labels read the language when shown (getters), so a list made once still switches.
const model = (id: string, engine: EngineId, label: string, pt: string, en: string): Model => ({
  id,
  engine,
  label,
  get hint() {
    return L(pt, en)
  }
})

export const MODELS: Model[] = [
  model('sonnet', 'claude', 'Sonnet', 'Bom pra maioria', 'Good for most things'),
  model('opus', 'claude', 'Opus', 'Tarefas longas e difíceis', 'Long, hard tasks'),
  model('haiku', 'claude', 'Haiku', 'Rápido, gasta pouco do plano', 'Fast, uses little of the plan'),
  model('gpt-5.6-luna', 'codex', 'GPT-5.6 Luna', 'Bom pra maioria', 'Good for most things'),
  model('gpt-5.6-terra', 'codex', 'GPT-5.6 Terra', 'Problemas difíceis', 'Hard problems'),
  model('gpt-5.6-sol', 'codex', 'GPT-5.6 Sol', 'O mais capaz, mais lento', 'The most capable, slower')
]

const effort = (id: Effort, pt: string, en: string): { id: Effort; label: string } => ({
  id,
  get label() {
    return L(pt, en)
  }
})

export const EFFORTS: { id: Effort; label: string }[] = [effort('low', 'Baixo', 'Low'), effort('medium', 'Médio', 'Medium'), effort('high', 'Alto', 'High'), effort('xhigh', 'Máximo', 'Max')]

// A model the app doesn't list, by the name a company gateway gives it: kept as "<engine>:<name>".
export const customModel = (engine: EngineId, name: string): string => `${engine}:${name.trim()}`
// A model to run with: a custom one with no name yet falls back to the default.
export const usable = (m: Model | undefined): Model | undefined => (m?.id ? m : undefined)

// Models a harness lists on its own (Codex's catalog), known once it's read: their names
// show everywhere (an agent's page, Tuca's list), not just in the picker.
const found = new Map<string, Model>()
export const rememberModels = (list: Model[]): void => {
  for (const m of list) found.set(customModel(m.engine, m.id), m)
}
// A Codex model as an agent keeps it: the app's own ids stay as they were, the rest go by name.
export const codexValue = (slug: string): string => (MODELS.some((m) => m.id === slug) ? slug : customModel('codex', slug))

export const modelInfo = (id: string): Model | undefined => {
  const listed = MODELS.find((m) => m.id === id)
  if (listed) return listed
  const known = found.get(id)
  if (known) return known
  const engine = ENGINE_IDS.find((e) => id.startsWith(`${e}:`))
  if (!engine) return undefined
  const name = id.slice(engine.length + 1).trim()
  return { id: name, engine, label: name, hint: L('Nome próprio', 'Custom name') }
}

export interface ConnectorTool {
  name: string
  description: string
  cls: ToolClass
  enabled: boolean
  highRisk: boolean
  isNew: boolean // appeared after the first sync; starts disabled until reviewed
}

export type ConnectorAuth = 'none' | 'token' | 'oauth'
export type ConnectorStatus = 'connected' | 'connecting' | 'needs_auth' | 'error' | 'disconnected'

export interface Connector {
  id: string
  name: string
  kind: 'remote' | 'stdio'
  url?: string // remote
  command?: string // stdio
  args?: string[]
  envKeys?: string[] // names only; values are secrets
  auth: ConnectorAuth
  status: ConnectorStatus
  error?: string
  errorDetail?: string // the raw error and its causes (a certificate's code, the DNS's), under "Ver detalhes"
  tools: ConnectorTool[]
}

export interface ConnectorInput {
  name: string
  kind: 'remote' | 'stdio'
  url?: string
  auth?: ConnectorAuth
  token?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

// An MCP server found in a harness's own setup (Claude Code, Codex,
// OpenCode), to add as a connector. Names only: its secrets stay in the core.
export interface HarnessMcp {
  key: string // the same server in two harnesses has one key
  name: string
  kind: 'remote' | 'stdio'
  address: string // url, or command and args
  harnesses: EngineId[]
  envKeys?: string[]
  missing?: string[] // headers the app can't send (only a Bearer token)
  added?: boolean // already a connector
}

export type ApprovalState = 'pending' | 'approved' | 'refused' | 'expired'

// The approval an agent asks with pedir_acesso: a grant, not a tool call.
export const ACCESS_REQUEST = 'pedir_acesso'

export interface Approval {
  id: string
  hash: string // sha256 of connector, tool and canonical arguments
  agentId: string
  conversationId: string
  messageId: string
  connectorId: string
  connectorName: string
  tool: string
  args: Record<string, unknown>
  why: string
  highRisk: boolean
  state: ApprovalState
  reason?: string
  outcome?: string // short summary of what happened when it ran
  createdAt: number
  expiresAt: number
  decidedAt?: number
  requestedBy?: string // the person whose request the agent was working on
  decidedBy?: string // the person who decided it
  behalf?: string // what it's for, when not a person's message: "rotina da Ana", "rotina do #vendas"
}

// A person's memories are `person:<id>` (personScope); otherwise the scope is the id of the one agent they belong to.
export type MemoryScope = string
export type MemoryState = 'active' | 'pending' | 'archived' | 'forgotten'

export interface Memory {
  id: string
  scope: MemoryScope
  text: string
  state: MemoryState
  origin: 'agent' | 'extraction' | 'me'
  agentId?: string // the agent that saved it, when origin is 'agent'
  conversationId?: string
  messageIds: string[] // evidence
  replaces?: string // the memory this one supersedes; it becomes archived when this one is active
  reason?: string // why it was forgotten
  privateTo?: string // an agent's note made in a DM: that DM's person's alone
  createdAt: number
  confirmedAt: number // creation, edit, "still valid", or reinforced by a later conversation
}

export const SUMMARY_WINDOW = 30 // messages kept verbatim after a consolidation
export const SUMMARY_MAX_AFTER = 50 // more than this after the summary triggers one
export const STALE_DAYS = 60

// Code in a message, a fenced block or inline code, is quoted content: a @handle there neither
// calls the agent (mentioned() in the core) nor is bolded on screen (the message view). A fence
// closes on the same run of backticks or tildes it opened with, so a ```` block can show a ``` one.
export const CODE_SPANS = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)|`[^`\n]*`/g

// How much of each memory scope goes in every prompt, in characters. The most
// recently confirmed fill it; the older ones past it aren't lost: agents search
// them with buscar_memorias, offered only while some memory is past the budget.
export const MEMORY_PROMPT_BUDGET = 8_000
export function splitForPrompt(active: Memory[]): { prompt: Memory[]; searchable: Memory[] } {
  const sorted = [...active].sort((a, b) => b.confirmedAt - a.confirmedAt)
  let used = 0
  const cut = sorted.findIndex((m) => (used += m.text.length + 1) > MEMORY_PROMPT_BUDGET)
  return cut < 0 ? { prompt: sorted, searchable: [] } : { prompt: sorted.slice(0, cut), searchable: sorted.slice(cut) }
}
export const isStale = (m: Memory, now = Date.now()): boolean => m.state === 'active' && now - m.confirmedAt > STALE_DAYS * 86_400_000

// ---------- the agent's computer ----------

export type ComputerState = 'off' | 'starting' | 'running' | 'stopped' | 'no_docker' | 'error'

export interface Service {
  name: string
  command: string
  port: number // inside the computer (on a Mac computer: on the Mac)
  url?: string // on the Mac (127.0.0.1), while the computer runs
  running: boolean
  startedAt: number
  conversationId?: string // started by a reply there: only who sees that conversation sees it
}

export interface ComputerInfo {
  agentId: string
  state: ComputerState
  detail?: string // what is happening, or what went wrong
  folder: string // /work, on the Mac (on a Mac computer: its default working folder)
  services: Service[]
  kind?: ComputerKind
}

export type ArtifactKind = 'image' | 'video' | 'markdown' | 'html' | 'pdf' | 'csv' | 'text' | 'file'

export interface Artifact {
  id: string
  agentId: string
  conversationId: string
  messageId: string
  kind: ArtifactKind
  name: string // file name, also its path in the app's artifact store
  title: string
  source: string // where it came from: a path in the computer, or a URL for screenshots
  size: number
  createdAt: number
}

// An image I attach to a message (dropped, pasted or picked), on its way to the core.
export interface ImageUpload {
  name: string
  mime: string // image/png, image/jpeg, image/gif or image/webp
  data: string // base64
}
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // what the models take per image
export const MAX_IMAGES_PER_MESSAGE = 10

// A file I attach to a message that isn't an image (a PDF, a Word doc, a spreadsheet, text): kept with
// the message, and what it says goes to the agents as text (any engine, with a computer or not).
export interface FileUpload {
  name: string
  data: string // base64
}
export const MAX_FILE_BYTES = 20 * 1024 * 1024 // as the wiki takes
export const MAX_FILES_PER_MESSAGE = 5

// In a browser (Tucano as a server) the server itself serves them, under /artifact.
export const artifactUrl = (a: Pick<Artifact, 'id' | 'name'>): string =>
  `${(globalThis as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__ ? './artifact/' : 'tucano://artifact/'}${a.id}/${encodeURIComponent(a.name)}`

// ---------- routines (spec §14) ----------

export interface Schedule {
  days: number[] // 0 = Sunday … 6 = Saturday
  time: string // "HH:MM", Mac local time
  once?: boolean // runs at the next matching time, then turns itself off
  date?: string // "YYYY-MM-DD": that day only, at `time` (always once; `days` is its weekday)
  monthDay?: number // 1–31: every month on that day (a shorter month's last day), at `time`
}

// What starts a routine other than the clock (spec §17). The app is local, so
// nothing from the internet can call it: it checks a connector every few
// minutes, or listens on the Mac itself for a script, a git hook, Xcode…
export type Trigger =
  | {
      kind: 'poll'
      connectorId: string
      tool: string // a read tool of that connector, e.g. Linear's list_issues
      args: Record<string, unknown>
      everyMinutes: number
      seen?: string[] // ids of the items already handled (or there when it started)
      checkedAt?: number
      error?: string // why the last check failed
    }
  | { kind: 'webhook'; token: string } // POST http://127.0.0.1:WEBHOOK_PORT/gatilho/<token>

export const WEBHOOK_PORT = 47_717

// An issue key in a message ("OAB-65", "SIM-12"): replies about it count toward it.
export const workIn = (text: string): string | undefined => /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/.exec(text)?.[1]
export const POLL_MINUTES = [1, 5, 15, 60]

export interface Routine {
  id: string
  name: string
  agentId: string
  conversationId: string // the agent's DM or a channel it belongs to
  prompt: string
  schedule: Schedule // unused when there's a trigger
  trigger?: Trigger
  enabled: boolean
  nextAt?: number // undefined while off
  lastAt?: number
  lastMessageId?: string // the agent's reply in the last run
  createdBy?: string // the agent that scheduled it with `agendar_rotina`; undefined when I did
  createdAt: number
  scope?: 'me' | 'channel' // a person's own (unset), or the team's: admins make those, and they notify only who watches
  owner?: string // the person a 'me' routine belongs to, runs for and notifies
  watchers?: string[] // who asked to be told of a channel routine's runs ("me avise")
}

export type RoutineInput = Pick<Routine, 'name' | 'agentId' | 'conversationId' | 'prompt' | 'schedule' | 'enabled' | 'trigger'> & { id?: string; createdBy?: string; scope?: Routine['scope'] }

// What the routine's message in the conversation remembers about that run.
export interface RoutineRun {
  name: string
  scheduledAt: number
  late: boolean // ran after the app came back, not at the time
  event?: { source: string; title: string } // what triggered it, when not the clock
}

const DAY_LONG = (): string[] => (lang() === 'en' ? ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] : ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'])
const DAY_SHORT = (): string[] => (lang() === 'en' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'])
const EVERY_DAY = (): string[] =>
  lang() === 'en'
    ? ['Every Sunday', 'Every Monday', 'Every Tuesday', 'Every Wednesday', 'Every Thursday', 'Every Friday', 'Every Saturday']
    : ['Todo domingo', 'Toda segunda', 'Toda terça', 'Toda quarta', 'Toda quinta', 'Toda sexta', 'Todo sábado']

export const validTime = (t: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)

// "2026-11-17", a day that exists.
export const validDate = (d: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m) return false
  const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return at.getFullYear() === Number(m[1]) && at.getMonth() === Number(m[2]) - 1 && at.getDate() === Number(m[3])
}

// A date's local time on this computer ("2026-11-17", "09:00").
export const dateAt = (date: string, time: string): number => {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number]
  const [h, m] = time.split(':').map(Number) as [number, number]
  return new Date(y, mo - 1, d, h, m).getTime()
}

// "2026-11-17" of a local time.
export const isoDay = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// The first time after `after` that matches the schedule.
export function nextRun(s: Schedule, after: number): number | undefined {
  if (!validTime(s.time)) return undefined
  if (s.date !== undefined) {
    if (!validDate(s.date)) return undefined
    const at = dateAt(s.date, s.time)
    return at > after ? at : undefined
  }
  const [h, m] = s.time.split(':').map(Number) as [number, number]
  if (s.monthDay !== undefined) {
    if (!Number.isInteger(s.monthDay) || s.monthDay < 1 || s.monthDay > 31) return undefined
    const d = new Date(after)
    for (let i = 0; i <= 12; i++) {
      const last = new Date(d.getFullYear(), d.getMonth() + i + 1, 0).getDate()
      const at = new Date(d.getFullYear(), d.getMonth() + i, Math.min(s.monthDay, last), h, m).getTime()
      if (at > after) return at
    }
    return undefined
  }
  if (s.days.length === 0) return undefined
  const d = new Date(after)
  for (let i = 0; i <= 7; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m).getTime()
    if (at > after && s.days.includes(new Date(at).getDay())) return at
  }
  return undefined
}

const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

export function describeSchedule(s: Schedule): string {
  const days = [...new Set(s.days)].sort()
  const hour = L(s.time.replace(/^0(\d)/, '$1').replace(':00', 'h'), s.time.replace(/^0(\d)/, '$1'))
  const and = L(' e ', ' and ')
  const when =
    days.length === 7
      ? L('Todo dia', 'Every day')
      : days.join() === '1,2,3,4,5'
        ? L('Seg a sex', 'Weekdays')
        : days.join() === '0,6'
          ? L('Fim de semana', 'Weekends')
          : days.length === 1
            ? EVERY_DAY()[days[0]!]
            : days
                .map((d) => DAY_SHORT()[d])
                .join(', ')
                .replace(/, ([^,]+)$/, `${and}$1`)
                .replace(/^./, (c) => c.toUpperCase())
  if (s.date !== undefined && validDate(s.date)) {
    const day = new Date(dateAt(s.date, '12:00')).toLocaleDateString(locale(), { weekday: 'short', day: 'numeric', month: 'short', ...(Number(s.date.slice(0, 4)) !== new Date().getFullYear() ? { year: 'numeric' } : {}) }).replace(/\./g, '')
    return L(`Uma vez, ${day} às ${hour}`, `Once, ${day} at ${hour}`)
  }
  if (s.monthDay !== undefined) return L(`Todo dia ${s.monthDay} do mês às ${hour}`, `Every month on the ${ordinal(s.monthDay)} at ${hour}`)
  if (s.once) return days.length === 7 ? L(`Uma vez, às ${hour}`, `Once, at ${hour}`) : L(`Uma vez, ${days.map((d) => DAY_LONG()[d]).join(' ou ')} às ${hour}`, `Once, ${days.map((d) => DAY_LONG()[d]).join(' or ')} at ${hour}`)
  return L(`${when} às ${hour}`, `${when} at ${hour}`)
}

// ---------- skills (spec §18) ----------

// A recipe an agent follows for a kind of task ("how to run the Core tests").
// Every agent it applies to sees its name and when to use it; the body is read
// on demand. One an agent writes or changes waits for me, with a diff.
export interface Skill {
  id: string
  name: string // short and unique among active skills, e.g. "testes-do-core"
  description: string // when to use it, one line; goes in every prompt
  body: string // the recipe, in Markdown
  agents: string[] // the agents it applies to; empty: all
  state: 'active' | 'pending' | 'archived'
  replaces?: string // a pending change to this active skill
  proposedBy?: string // the agent that proposed it (pending)
  reason?: string // why, in the agent's words
  source?: string // linked to a SKILL.md of the user's Claude Code or Codex: read from there, not edited here
  createdAt: number
  updatedAt: number
}

// A skill already on this Mac (Claude Code, its plugins, Codex), that can be linked.
export interface LocalSkill {
  source: string // the SKILL.md
  name: string
  description: string
  bodyLength: number // recipe characters, excluding frontmatter
  origin: string // "Claude Code", "Plugin <name>", "Codex"
  files: string[] // its other text files, relative to its folder
  scripts: boolean // it has scripts: an agent needs a computer to run them
}

export interface SkillVersion {
  id: number
  skillId: string
  name: string
  description: string
  body: string
  by: string // 'me' or the agent whose proposal it was
  at: number
}

export type SkillInput = Pick<Skill, 'name' | 'description' | 'body' | 'agents'> & { id?: string; source?: string }

export const skillApplies = (s: Skill, agentId: string): boolean => s.state === 'active' && (s.agents.length === 0 || s.agents.includes(agentId))

// ---------- report (spec §20) ----------

// How each agent and skill is doing, from what is already recorded: whether
// replies end well, what they cost, loops cut, approvals refused.
export interface Rate {
  replies: number
  ok: number // ended answering, asking or waiting for approval (not failed, cut, paused or stopped)
}

export interface AgentReport {
  agentId: string
  total: Rate
  failed: number
  cut: number // stopped by a guard: a loop, failures in a row, stuck
  paused: number // reached the budget
  approvals: { asked: number; refused: number }
  avgTokens: number // counted, per reply
  avgMs: number
  problems: Problem[] // the week's latest, newest first
  weeks: { start: number; rate: Rate; avgTokens: number }[] // the six weeks up to this one, oldest first
}

// Something that went wrong, pointing at the reply (or the approval's message) it happened in.
export interface Problem {
  kind: 'failed' | 'cut' | 'paused' | 'refused'
  at: number
  conversationId: string
  messageId: string
  detail?: string
}

export interface SkillReport {
  skillId: string
  name: string
  reads: Rate // replies that read it
  changedAt?: number // its last change
  before?: Rate // replies that read it before that change
  since?: Rate // and after
}

// Uso e limites: this month's receipts by day, by who spent them and by model.
// Who is an agent id, or 'router' and 'memory' for the app's own turns.
export interface UsageReport {
  monthStart: number
  daysInMonth: number
  total: number // counted tokens
  replies: number // agent replies with a receipt
  apiUsd: number // what the same usage would cost on the API, where the CLI tells
  avgMs: number // per agent reply
  lastMonth?: number // counted tokens in the same stretch of last month; undefined before the first receipt then
  days: Record<string, number>[] // one per day so far, tokens by who
  who: { id: string; tokens: number; replies: number; avgMs: number }[] // biggest first
  models: { model: string; engine: EngineId; tokens: number }[] // biggest first
}

// One calendar week; skills are rated over the six weeks up to it.
export interface Report {
  since: number // Monday 00:00
  until: number // the next Monday
  agents: AgentReport[]
  skills: SkillReport[]
  work: { work: string; tokens: number; replies: number; agents: string[]; last: number }[]
}

// ---------- the wiki ----------
export type WikiAccess = 'none' | 'read'
export const wikiAccess = (a: Pick<Agent, 'wiki' | 'kind'>): WikiAccess => (a.kind === 'tuca' ? 'none' : (a.wiki ?? 'read'))
export interface WikiPageInfo {
  title: string
  kind: string // the page's tipo, from its frontmatter
  summary: string // its first line worth reading
  updatedAt: number
  updatedBy: string // 'me', an agent's id, or 'outside' (changed in another app)
}
export interface WikiPage extends WikiPageInfo {
  body: string // the Markdown, without the frontmatter
  meta: Record<string, string>
  hash: string // of the file as read: a save made on an older copy is refused
  links: string[] // the titles it links to
  missing: string[] // of those, the ones with no page yet
  backlinks: string[] // the pages that link to it
  file: string // where it is, inside the wiki's folder
}
export interface WikiHit {
  title: string
  kind: string
  snippet: string // the matching part, with **marks**
}
export interface WikiVersion {
  id: number
  title: string
  at: number
  by: string
  action: 'create' | 'edit' | 'delete'
  before: string | null
  after: string | null
  reason?: string
}
export interface WikiSource {
  id: string
  file: string // "fontes/<date> <title>", inside the wiki's folder (a [[link]] target)
  title: string
  kind: 'conversation' | 'message' | 'note' | 'file' | 'link'
  origin: { conversationId?: string; messageIds?: string[]; url?: string; original?: string } // original: the file as it came, inside the wiki's folder
  status?: 'reading' | 'done' | 'failed' // a file, a link or a note while the curator reads it
  error?: string
  changes?: number // how many change packages it became
  addedBy: string // 'me', 'auto' (the curator) or an agent's id
  addedAt: number
  private?: boolean // from someone else's DM, as an admin sees it: that it exists, nothing more (decision 1)
}
// One change in a package: write a new page, add under a section of one, or swap an exact passage.
export interface WikiOp {
  op: 'create' | 'append' | 'replace'
  page: string
  kind?: string // for a new page
  section?: string // for append: the ## heading it goes under (made if missing)
  text?: string // create, append
  old?: string // replace
  new?: string // replace
}
export interface WikiChange {
  id: string
  at: number
  by: string // 'auto' (the curator) or 'me'
  state: 'pending' | 'applied' | 'refused' | 'conflict' | 'undone'
  ops: WikiOp[]
  reason?: string // why the curator thought it worth keeping
  source?: { id: string; title: string; file: string }
  decidedAt?: number
}
// What a review of the wiki found: something broken, missing or that no longer adds up.
export interface WikiFinding {
  id: string
  at: number
  kind: 'broken' | 'missing' | 'orphan' | 'contradiction' | 'stale' | 'duplicate' | 'link' | 'log' | 'git' // log: a page that reads like a record of what was done; git: what the sync with the repository ran into (a conflict, a file too big, read-only)
  pages: string[] // the pages it is about
  text: string // what's wrong, in a sentence (Markdown, with [[links]])
  name?: string // broken, missing: the page it would take
  change?: WikiChange // the fix it suggests, waiting for approval
}
// What came in from an Obsidian vault.
export interface WikiImport {
  from: string // the vault's name
  pages: number
  attachments: number // images, PDFs and the like, copied along
  skipped: string[] // files already in the wiki, left as they were
  links: number // links between pages, in the whole wiki now
  missing: number // links to pages nobody wrote yet
  kinds: [string, number][] // the kinds the new pages got (their tipo, folder or first tag)
}
// The wiki's folder kept in a git repository (src/core/wiki-git.ts), as Wiki settings show it.
export type WikiGitHost = 'github' | 'gitlab' | 'bitbucket' | 'gitea'
export interface WikiGitSetup {
  sshUrl: string // what Tucano clones and pushes (git@host:owner/repo.git)
  converted?: boolean // an https address was given: this is its SSH one
  host: string
  provider?: WikiGitHost
  publicKey: string // the deploy key to add to the repository
  deployKeyUrl?: string // the page that adds it, when the host is known
}
export interface WikiGitTest {
  branch: string
  empty: boolean // a repository with nothing in it yet
  pages: number // Markdown notes in it
  pdfs: number
  docx: number
  currentPages: number // pages the wiki has now: with some, connecting asks how
}
export type WikiGitError = { kind: 'auth' | 'network' | 'notfound' | 'hostkey' | 'nogit' | 'other'; message: string }
export interface WikiGitStatus {
  state: 'off' | 'setup' | 'ok' | 'syncing' | 'error' // setup: a key made, not connected yet
  setup?: WikiGitSetup
  test?: WikiGitTest // the last test, until it's connected
  branch?: string
  readOnly: boolean // the key can't push: the wiki shows the repository and takes no writes
  lastSync?: number
  nextTry?: number // after a failure, when it tries again on its own
  error?: WikiGitError
  skipped: { path: string; mb: number }[] // files over 50 MB, kept out of the repository
  git: boolean // git was found on this computer
}
export interface WikiReview {
  at?: number // the last review
  running: boolean
  error?: string // the last review failed
  findings: WikiFinding[] // still open
}

// A whole Tucano in one .zip (Settings › General › Export everything), and what a server finds in
// one before restoring it (src/core/restore.ts).
export interface BackupSummary {
  version: 1
  madeAt: number
  app: string
  workspace: string
  schema: number
  agents: number
  channels: number
  messages: number
  memories: number
  wikiPages: number
  files: number
  filesLeftOut: number // the agents' files that didn't fit in one upload
}
