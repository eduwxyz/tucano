// Domain types shared by the core (utility process) and the renderer.
import { L, lang, type Lang } from './lang'

export type AgentColor = 'sky' | 'indigo' | 'violet' | 'rose' | 'amber' | 'green' | 'teal' | 'graphite'
export type GrantLevel = 'none' | 'read' | 'read_write'
export type ToolClass = 'read' | 'write' | 'sensitive'
export type EngineId = 'claude' | 'codex' | 'opencode' | 'pi'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'
export type MemoryMode = 'auto' | 'approve' | 'read' // how an agent's `lembrar` calls land

export interface Model {
  id: string // the value passed to the CLI's --model
  engine: EngineId
  label: string
  hint: string
}

// The app's own updates (src/main/updates.ts): off when run from the code.
export interface UpdateState {
  version: string // the one running
  status: 'off' | 'idle' | 'checking' | 'latest' | 'downloading' | 'ready' | 'error'
  next?: string // the newer version, while it downloads and once it's ready
  percent?: number
  checkedAt?: number
  error?: string
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
}

// The agents of the team: not archived, and not the Tuca, who belongs to the app.
export const isTeam = (a: Pick<Agent, 'archived' | 'kind'>): boolean => !a.archived && a.kind !== 'tuca'

export interface Agent {
  id: string
  name: string
  handle: string
  role: string
  color: AgentColor
  instructions: string
  modelId: string
  effort: Effort
  limit: number // tokens per month
  used: number // tokens used this month, computed from receipts
  grants: Record<string, GrantLevel>
  memory: MemoryMode
  computer: boolean // has a computer (spec §13): see computerKind for which
  computerKind?: ComputerKind // 'linux' (default): an isolated container; 'mac': this Mac, as the user (spec §23)
  web?: boolean // searches the web and reads pages with the CLI's own tools (spec §16); on unless false
  browser?: boolean // drives a browser of its own: opens, clicks, types (spec §24); off unless true
  autoApprove?: string[] // "connectorId:tool" sensitive tools approved for good ("sempre permitir"), never high-risk ones
  folders?: LentFolder[] // Mac folders lent to that computer (spec §13, M5.1); changed only through lendFolder/folderAction
  archived: boolean
  kind?: 'tuca' // the agent that builds the others: it proposes, the person creates
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
  receipt?: Receipt
  approvalId?: string
  error?: string
  depth?: number // 1 when a human message triggered it, +1 for each agent-to-agent hop
  question?: string // asked with ask_user; answered by the next human message here
  memoryIds?: string[] // memories saved or proposed with `lembrar` in this reply
  artifactIds?: string[] // files and screenshots shown in this reply
  services?: string[] // services started in this reply, by name, on the author's computer
  routineIds?: string[] // routines scheduled or changed with `agendar_rotina` in this reply
  browser?: boolean // used its browser in this reply (the message links to the live view)
  budget?: number // 'paused': the per-reply budget it reached, in counted tokens
  work?: string // the piece of work it counts toward, e.g. the issue "OAB-65" (spec §20)
  agentDraft?: AgentDraft // an agent the Tuca proposed with propor_agente, shown as a card
}

// An agent the Tuca proposes. Nothing exists until the person creates it.
export interface AgentDraft {
  name: string
  role: string
  color: AgentColor
  instructions: string
  modelId: string
  effort: Effort
  web: boolean
  grants: Record<string, GrantLevel> // connector id → level; least access by default
  task?: string // a first task to try it with
  reason?: string
  state?: 'created' | 'dismissed'
  agentId?: string // once created
}

export type Author = { kind: 'me' } | { kind: 'agent'; id: string } | { kind: 'system' } | { kind: 'routine'; id: string }

export interface Message {
  id: string
  conversationId: string
  author: Author
  text: string
  at: number
  run?: Run
  routine?: RoutineRun // set on the message a routine posts (author kind 'routine')
}

export interface Settings {
  workspaceName: string
  context: string
  engines: Record<EngineId, EngineStatus>
  routerModel: string // a model id, or 'jev' for TypeSafe's Jev (falls back to Haiku)
  jevKey?: boolean // a TypeSafe key is saved (the key itself never leaves the core)
  browserJev?: boolean // Jev finds what agents click in their browsers (each click sends the page to TypeSafe)
  memoryModel: string // summarizes conversations and extracts memories
  memoryLearning: 'approve' | 'auto' | 'off' // what extracted memories about me become
  defaultLimit: number
  approvalTtlHours: number
  theme: 'system' | 'light' | 'dark'
  language: Lang // the app's, and the language agents answer in
  openAtLogin?: boolean // so routines run without me opening the app
  runBudgetPct?: number // per reply, % of the agent's monthly limit before it pauses; default RUN_BUDGET_PCT
  runStallMinutes?: number // without any sign of life; default RUN_STALL_MINUTES
  telegram?: TelegramInfo // computed: the phone bot (spec §19)
  paused?: boolean // "Pausar tudo": no agent starts working, no routine runs
  quietHours?: { from: string; to: string } | null // "HH:MM": routines and triggers wait, and run late when it ends; null: off
  quota?: Quota // the Claude subscription's windows, from the last reply (spec §21)
  github?: { user?: string; error?: string } // computed: the GitHub account the app pushes and opens PRs with (spec §22)
  // The harnesses agents may run on, picked in the introduction. Unset: every one that's ready.
  harnesses?: EngineId[]
  // The first-run introduction: unset on an existing install (no intro), done:false to show it (a new install, or "Rever a introdução")
  onboarding?: { done: boolean; checklistHidden?: boolean }
}

// What the main process does in an agent's browser for the core, and what it answers (spec §24).
export type BrowserOp = 'open' | 'snapshot' | 'click' | 'type' | 'key' | 'scroll' | 'back' | 'text' | 'frame' | 'show' | 'hide' | 'close' | 'clear'

export interface BrowserElement {
  ref: number // its number in the last snapshot of the page
  role: string // botão, link, campo, lista, checkbox… or the ARIA role
  label: string
  value?: string // what a field or list holds now (passwords masked)
  checked?: boolean
  disabled?: boolean
  inView: boolean
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
export const RUN_BUDGET_PCT = 10 // past this share of the month, the reply pauses and asks to continue
export const RUN_STALL_MINUTES = 20 // no text, no tokens, no tool finishing: stuck
export const REPEAT_WARN = 3 // the same call with the same result: the agent is told to change course
export const REPEAT_STOP = 5 // ...and then the reply stops
export const ERRORS_STOP = 8 // tool calls failing in a row

// What a reply counts against limits: a token read from the cache costs about a
// tenth of a new one, so it counts a tenth.
export const CACHE_READ_WEIGHT = 0.1
export const countedTokens = (u: { inputTokens: number; cacheReadTokens: number; outputTokens: number }): number =>
  Math.round(u.inputTokens - u.cacheReadTokens * (1 - CACHE_READ_WEIGHT) + u.outputTokens)

export const ENGINES: Record<EngineId, { label: string; cli: string; login: string; install: string; site: string }> = {
  claude: { label: 'Claude Code', cli: 'claude', login: 'claude auth login', install: 'curl -fsSL https://claude.ai/install.sh | bash', site: 'https://code.claude.com' },
  codex: { label: 'Codex', cli: 'codex', login: 'codex login', install: 'npm install -g @openai/codex', site: 'https://github.com/openai/codex' },
  opencode: { label: 'OpenCode', cli: 'opencode', login: 'opencode auth login', install: 'curl -fsSL https://opencode.ai/install | bash', site: 'https://opencode.ai' },
  pi: { label: 'Pi', cli: 'pi', login: 'pi', install: 'npm install -g @earendil-works/pi-coding-agent', site: 'https://pi.dev' }
}
export const ENGINE_IDS = Object.keys(ENGINES) as EngineId[]

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

export const modelInfo = (id: string): Model | undefined => {
  const listed = MODELS.find((m) => m.id === id)
  if (listed) return listed
  const m = /^(claude|codex|opencode|pi):(.*)$/s.exec(id)
  return m ? { id: m[2]!.trim(), engine: m[1] as EngineId, label: m[2]!.trim(), hint: L('Nome próprio', 'Custom name') } : undefined
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
}

// 'me' memories go to every agent; otherwise the scope is the id of the one agent they belong to.
export type MemoryScope = 'me' | string
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
  createdAt: number
  confirmedAt: number // creation, edit, "still valid", or reinforced by a later conversation
}

export const SUMMARY_WINDOW = 30 // messages kept verbatim after a consolidation
export const SUMMARY_MAX_AFTER = 50 // more than this after the summary triggers one
export const STALE_DAYS = 60

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

export const artifactUrl = (a: Pick<Artifact, 'id' | 'name'>): string => `tucano://artifact/${a.id}/${encodeURIComponent(a.name)}`

// ---------- routines (spec §14) ----------

export interface Schedule {
  days: number[] // 0 = Sunday … 6 = Saturday
  time: string // "HH:MM", Mac local time
  once?: boolean // runs at the next matching time, then turns itself off
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
}

export type RoutineInput = Pick<Routine, 'name' | 'agentId' | 'conversationId' | 'prompt' | 'schedule' | 'enabled' | 'trigger'> & { id?: string; createdBy?: string }

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

// The first time after `after` that matches the schedule.
export function nextRun(s: Schedule, after: number): number | undefined {
  if (!validTime(s.time) || s.days.length === 0) return undefined
  const [h, m] = s.time.split(':').map(Number) as [number, number]
  const d = new Date(after)
  for (let i = 0; i <= 7; i++) {
    const at = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i, h, m).getTime()
    if (at > after && s.days.includes(new Date(at).getDay())) return at
  }
  return undefined
}

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
