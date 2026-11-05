// Renderer state. Everything except the current view comes from the core and
// is kept in sync by its events; actions go to the core over RPC.
import { useRef, useSyncExternalStore } from 'react'
import { L, setLang } from '../../shared/lang'
import type { CoreEvent, Method, Params } from '../../shared/rpc'
import {
  type Account,
  type AccountEngine,
  MAX_AGENT_ROUTINES,
  MODELS,
  modelInfo,
  type EngineId,
  type BrowserInput,
  type Agent,
  type Approval,
  type Artifact,
  type BrowserView,
  type ComputerInfo,
  type Connector,
  type ConnectorInput,
  type ConnectorTool,
  type HarnessMcp,
  type Conversation,
  type GrantLevel,
  type LocalSkill,
  type Memory,
  type MemoryScope,
  type Message,
  type Model,
  type Routine,
  type RoutineInput,
  type Settings,
  type Skill,
  type SkillInput,
  type SkillVersion,
  type Report,
  type UsageReport,
  type Trigger,
  type ImageUpload,
  type Os,
  type LocalInfo,
  type VoiceModelId,
  type VoiceStatus
} from '../../shared/types'
import { call, connect, disconnect } from './rpc'

export * from '../../shared/types'

export type View =
  | { kind: 'conversation'; id: string; message?: string } // `message`: scroll to it and flash it
  | { kind: 'agent'; id: string }
  | { kind: 'new-agent'; draft?: Agent; fromMessage?: string } // a draft from a Tuca card, to edit before creating
  | { kind: 'tuca'; from?: View } // the builder screen: a new agent with the Tuca; closing goes back to `from`
  | { kind: 'approvals' }
  | { kind: 'usage' }
  | { kind: 'connectors' }
  | { kind: 'memory' }
  | { kind: 'wiki'; title?: string; edit?: boolean; tab?: 'pages' | 'pending' | 'sources' | 'review'; source?: string } // the wiki's home (a tab), a page (being edited), or a source
  | { kind: 'routines' }
  | { kind: 'skills' }
  | { kind: 'report' }
  | { kind: 'settings' }

export interface State {
  ready: boolean
  threadSeen: Record<string, number> // thread root id → when I last had it open (what came after is new)
  navOpen: boolean // on a phone, the sidebar slid in over the view
  view: View | null
  me: { name: string; initials: string }
  settings: Settings
  models: Model[]
  agents: Agent[]
  connectors: Connector[]
  lightbox: { items: { url: string; title: string; video?: boolean }[]; index: number } | null
  conversations: Conversation[]
  messages: Message[]
  approvals: Approval[]
  memories: Memory[]
  artifacts: Artifact[]
  computers: ComputerInfo[]
  browsers: BrowserView[]
  routines: Routine[]
  skills: Skill[]
  wikiRev: number // goes up when a wiki page changes: the wiki screens read again
  voiceRev: number // goes up when dictation's model changes (downloading, done, removed)
  platform: Os
  packaged: boolean
  panel: Panel | null // the side panel next to a conversation
  dialog: Dialog | null // a small window: a channel's members, name or topic; archived agents; new channel; search
  tabs: Record<string, string> // the open tab of each page with tabs, kept while the app is open
  demoServer?: { command: string; args: string[] }
  toasts: Toast[] // short notes at the bottom: an action that didn't go through
  coreDown: boolean // the core's process ended; a banner offers to reopen
}

export interface Toast {
  id: number
  text: string
  leaving?: boolean // fading out
}

export type Dialog = { kind: 'members' | 'rename' | 'topic'; id: string } | { kind: 'archived' | 'new-channel' | 'search' } | { kind: 'oauth'; id: string; url: string }

// `thread`: the replies to a message (its id), next to the conversation.
export type Panel = { kind: 'artifact'; id: string } | { kind: 'service'; agentId: string; name: string } | { kind: 'browser'; agentId: string } | { kind: 'thread'; id: string }

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'EU'

// When each thread was last seen, in this window's storage: only a convenience, so it may be empty.
const SEEN_KEY = 'tucano.threadSeen'
const loadSeen = (): Record<string, number> => {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>
  } catch {
    return {}
  }
}

let state: State = {
  ready: false,
  threadSeen: loadSeen(),
  wikiRev: 0,
  voiceRev: 0,
  navOpen: false,
  view: null,
  me: { name: 'Eu', initials: 'EU' },
  settings: {
    workspaceName: '',
    context: '',
    engines: { claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false }, opencode: { installed: false, loggedIn: false }, pi: { installed: false, loggedIn: false }, gemini: { installed: false, loggedIn: false }, cursor: { installed: false, loggedIn: false } },
    routerModel: 'haiku',
    memoryModel: 'haiku',
    memoryLearning: 'approve',
    defaultLimit: 2_000_000,
    approvalTtlHours: 24,
    theme: 'system',
    language: 'pt'
  },
  models: MODELS,
  agents: [],
  connectors: [],
  lightbox: null,
  conversations: [],
  messages: [],
  approvals: [],
  memories: [],
  artifacts: [],
  computers: [],
  browsers: [],
  routines: [],
  skills: [],
  platform: 'mac',
  packaged: false,
  panel: null,
  dialog: null,
  tabs: {},
  toasts: [],
  coreDown: false
}

// ---------- store plumbing ----------

const listeners = new Set<() => void>()

function set(update: (s: State) => State): void {
  state = update(state)
  listeners.forEach((l) => l())
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}

// Selectors may build new arrays (filter/map); the snapshot is cached and kept
// referentially stable while the result is shallow-equal, so React doesn't loop.
export function useStore<T>(select: (s: State) => T): T {
  const cache = useRef<{ state: State; select: (s: State) => T; value: T } | null>(null)
  const getSnapshot = (): T => {
    const c = cache.current
    if (c && c.state === state && c.select === select) return c.value
    const next = select(state)
    const value = c && shallowEqual(c.value, next) ? c.value : next
    cache.current = { state, select, value }
    return value
  }
  return useSyncExternalStore(subscribe, getSnapshot)
}

export const getState = (): State => state

const upsert = <T extends { id: string }>(list: T[], item: T): T[] =>
  list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item]

// ---------- core sync ----------

function withSettings(s: State, settings: Settings): State {
  setLang(settings.language)
  const name = settings.workspaceName || L('Eu', 'Me')
  return { ...s, settings, me: { name, initials: initials(name) } }
}

function apply(e: CoreEvent): void {
  set((s) => {
    switch (e.type) {
      case 'message': {
        const known = s.messages.some((m) => m.id === e.message.id)
        const viewing = s.view?.kind === 'conversation' && s.view.id === e.message.conversationId
        const fromAgent = e.message.author.kind === 'agent' || e.message.author.kind === 'routine'
        // A reply that lands while you're elsewhere is new content too: the end of
        // the run, or it stopping for your turn (a question, an approval — the
        // states the core notifies). Counted once: if the badge already counts
        // this conversation, the run's start is already in it.
        const finished =
          known && fromAgent && !viewing && e.message.run !== undefined
          && ['done', 'failed', 'limit_reached', 'waiting_input', 'waiting_approval'].includes(e.message.run.status)
          && s.messages.find((m) => m.id === e.message.id)?.run?.status !== e.message.run.status
          && (s.conversations.find((c) => c.id === e.message.conversationId)?.unread ?? 0) === 0
        const conversations =
          fromAgent && !viewing && (!known || finished)
            ? s.conversations.map((c) => (c.id === e.message.conversationId ? { ...c, unread: (c.unread ?? 0) + 1 } : c))
            : s.conversations
        return { ...s, conversations, messages: upsert(s.messages, e.message) }
      }
      case 'delta':
        return { ...s, messages: s.messages.map((m) => (m.id === e.id ? { ...m, text: m.text + e.text } : m)) }
      case 'agent':
        return { ...s, agents: upsert(s.agents, e.agent) }
      case 'conversation': {
        const prev = s.conversations.find((c) => c.id === e.conversation.id)
        return { ...s, conversations: upsert(s.conversations, { ...e.conversation, unread: prev?.unread }) }
      }
      case 'settings':
        return withSettings(s, e.settings)
      case 'connector':
        return { ...s, connectors: upsert(s.connectors, e.connector) }
      case 'connector_removed':
        return { ...s, connectors: s.connectors.filter((c) => c.id !== e.id) }
      case 'approval':
        return { ...s, approvals: upsert(s.approvals, e.approval) }
      case 'memory':
        return { ...s, memories: upsert(s.memories, e.memory) }
      case 'memory_removed':
        return { ...s, memories: s.memories.filter((m) => m.id !== e.id) }
      case 'artifact':
        return { ...s, artifacts: upsert(s.artifacts, e.artifact) }
      case 'computer': {
        const others = s.computers.filter((c) => c.agentId !== e.computer.agentId)
        return { ...s, computers: [...others, e.computer] }
      }
      case 'browser': {
        const others = s.browsers.filter((b) => b.agentId !== e.view.agentId)
        return { ...s, browsers: [...others, e.view] }
      }
      case 'routine':
        return { ...s, routines: upsert(s.routines, e.routine) }
      case 'conversation_removed': {
        const left = s.conversations.filter((c) => c.id !== e.id)
        const here = s.view?.kind === 'conversation' && s.view.id === e.id
        const first = left.find((c) => c.kind === 'channel') ?? left[0]
        return {
          ...s,
          conversations: left,
          messages: s.messages.filter((m) => m.conversationId !== e.id),
          view: here ? (first ? { kind: 'conversation', id: first.id } : { kind: 'new-agent' }) : s.view,
          panel: here ? null : s.panel
        }
      }
      case 'routine_removed':
        return { ...s, routines: s.routines.filter((r) => r.id !== e.id) }
      case 'skill':
        return { ...s, skills: upsert(s.skills, e.skill).sort((a, b) => a.name.localeCompare(b.name)) }
      case 'skill_removed':
        return { ...s, skills: s.skills.filter((k) => k.id !== e.id) }
      case 'wiki':
        return { ...s, wikiRev: s.wikiRev + 1 }
      case 'voice':
        return { ...s, voiceRev: s.voiceRev + 1 }
    }
  })
}

export async function start(): Promise<void> {
  window.tucano.onNavigate((id, thread) => {
    navigate({ kind: 'conversation', id })
    if (thread) openThread(thread)
  })
  window.tucano.onNavigatePage?.((page) => navigate({ kind: page }))
  window.tucano.onCoreDown?.(() => {
    disconnect()
    set((s) => ({ ...s, coreDown: true }))
  })
  let viewing: string | null = null
  subscribe(() => {
    const id = state.view?.kind === 'conversation' ? state.view.id : null
    if (id !== viewing) window.tucano.viewing((viewing = id))
  })
  await connect(apply)
  const snap = await call('snapshot')
  set((s) => {
    const first = snap.conversations.find((c) => c.kind === 'channel') ?? snap.conversations[0]
    const view = s.view ?? (first ? { kind: 'conversation' as const, id: first.id } : { kind: 'new-agent' as const })
    return {
      ...withSettings(s, snap.settings),
      ready: true,
      view,
      agents: snap.agents,
      conversations: snap.conversations,
      messages: snap.messages,
      connectors: snap.connectors,
      approvals: snap.approvals,
      memories: snap.memories,
      artifacts: snap.artifacts,
      computers: snap.computers,
      browsers: snap.browsers,
      routines: snap.routines,
      skills: snap.skills,
      platform: snap.platform,
      packaged: snap.packaged,
      demoServer: snap.demoServer
    }
  })
}

// ---------- selectors ----------

export const agentById = (s: State, id: string): Agent | undefined => s.agents.find((a) => a.id === id)
// Listed models, and the names a company gateway gives ("claude:lumen-claude-opus").
export const modelById = (s: State, id: string): Model | undefined => s.models.find((m) => m.id === id) ?? modelInfo(id)
export const pendingApprovals = (s: State): Approval[] => s.approvals.filter((a) => a.state === 'pending')
export const computerOf = (s: State, agentId: string): ComputerInfo | undefined => s.computers.find((c) => c.agentId === agentId)
export const browserOf = (s: State, agentId: string): BrowserView | undefined => s.browsers.find((b) => b.agentId === agentId)
export const pendingMemories = (s: State): Memory[] => s.memories.filter((m) => m.state === 'pending')

export function conversationTitle(s: State, c: Conversation): string {
  if (c.kind === 'channel') return c.name
  return agentById(s, c.name)?.name ?? L('Agente', 'Agent')
}

// ---------- toasts ----------

const TOAST_MS = 5_000
const TOAST_EXIT_MS = 160 // the fade out, in styles.css

let toastSeq = 0
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>()
let toastsHeld = false
const toastLater = (id: number): void => void toastTimers.set(id, setTimeout(() => dismissToast(id), TOAST_MS))
export function toast(text: string): void {
  const id = ++toastSeq
  set((s) => ({ ...s, toasts: [...s.toasts.slice(-2), { id, text }] })) // three at most
  if (!toastsHeld) toastLater(id)
}

// While the pointer or the focus is on them, the toasts wait: someone is reading, or about to close one.
export function holdToasts(hold: boolean): void {
  if (hold === toastsHeld) return
  toastsHeld = hold
  for (const t of toastTimers.values()) clearTimeout(t)
  toastTimers.clear()
  if (!hold) for (const t of state.toasts) if (!t.leaving) toastLater(t.id)
}

export function dismissToast(id: number): void {
  clearTimeout(toastTimers.get(id))
  toastTimers.delete(id)
  if (!state.toasts.some((t) => t.id === id && !t.leaving)) return
  set((s) => ({ ...s, toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) }))
  setTimeout(() => set((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) })), TOAST_EXIT_MS)
}

// An action nobody waits on: if the core says no, a toast says what didn't happen, and why.
// With the core down the banner already says it.
function fire<M extends Method>(failed: string, method: M, ...params: Params<M> extends undefined ? [] : [Params<M>]): Promise<void> {
  return call(method, ...params).then(
    () => {},
    (e: unknown) => {
      if (!state.coreDown) toast(`${failed} ${e instanceof Error && e.message ? e.message : L('Tente de novo.', 'Try again.')}`)
    }
  )
}

// ---------- actions ----------

export const setNav = (navOpen: boolean): void => set((s) => ({ ...s, navOpen }))

export const navigate = (view: View): void =>
  set((s) => ({
    ...s,
    view,
    navOpen: false,
    panel: s.view?.kind === view.kind && JSON.stringify(s.view) === JSON.stringify(view) ? s.panel : null,
    conversations:
      view.kind === 'conversation' ? s.conversations.map((c) => (c.id === view.id ? { ...c, unread: 0 } : c)) : s.conversations
  }))

export function updateSettings(patch: Partial<Omit<Settings, 'engines'>>): void {
  set((s) => withSettings(s, { ...s.settings, ...patch })) // optimistic, so typing stays instant
  void fire(L('Não consegui salvar a configuração.', "I couldn't save the setting."), 'updateSettings', { patch })
}

export const refreshEngines = (): void => void fire(L('Não consegui conferir os modelos.', "I couldn't check the models."), 'refreshEngines')
export const voiceStatus = (): Promise<VoiceStatus> => call('voiceStatus')
export const voiceDownload = (model: VoiceModelId): Promise<void> => call('voiceDownload', { model })
export const voiceCancelDownload = (): Promise<void> => call('voiceCancelDownload')
export const voiceRemoveModel = (model: VoiceModelId): Promise<void> => call('voiceRemoveModel', { model })
export const transcribe = async (id: string, audio: string): Promise<string> => (await call('transcribe', { id, audio })).text
export const cancelTranscribe = (id: string): Promise<void> => call('cancelTranscribe', { id })
export const loginEngine = (engine: keyof Settings['engines']): Promise<{ opened: boolean; command: string }> => call('loginEngine', { engine })
// More logins of Claude Code and Codex, each signed into in a terminal.
export const addAccount = (engine: AccountEngine, name: string): Promise<Account> => call('addAccount', { engine, name })
export const loginAccount = (id: string): Promise<{ opened: boolean; command: string }> => call('loginAccount', { id })
export const removeAccount = (id: string): Promise<void> => call('removeAccount', { id })
export const installEngine = (engine: keyof Settings['engines']): Promise<{ opened: boolean; command: string; needsNode?: boolean }> => call('installEngine', { engine })
// The person's own apps, through agent-desktop.
export const desktopStatus = (): Promise<{ installed: boolean; version?: string; accessibility?: string; suggestion?: string; server?: boolean }> => call('desktopStatus')
export type InstalledApp = { name: string; bundleId?: string; path?: string; running?: boolean; icon?: string }
export const installedApps = (): Promise<InstalledApp[]> => call('installedApps')
export const openApps = (): Promise<{ name: string; bundleId?: string }[]> => call('openApps')
export const installDesktop = (): Promise<{ opened: boolean; command: string; needsNode?: boolean }> => call('installDesktop')
export const desktopPermissions = (): void => void fire(L('Não consegui abrir as permissões.', "I couldn't open the permissions."), 'desktopPermissions')

export function saveAgent(agent: Agent, channelIds: string[]): Promise<void> {
  return call('saveAgent', { agent, channelIds })
}

export function newAgentDraft(): Agent {
  return {
    id: crypto.randomUUID(),
    name: '',
    handle: '',
    role: '',
    color: 'teal',
    instructions: '',
    modelId: 'sonnet',
    effort: 'medium',
    limit: state.settings.defaultLimit,
    maxRoutines: MAX_AGENT_ROUTINES,
    used: 0,
    grants: {},
    memory: 'auto',
    computer: false,
    archived: false
  }
}

// Creates a channel and stays where it is (the caller decides where to go).
export const newChannel = (name: string): Promise<string> => call('createChannel', { name })

// A new channel opens with the window to pick who's in it.
export async function createChannel(name: string): Promise<void> {
  const id = await call('createChannel', { name })
  navigate({ kind: 'conversation', id })
  set((s) => ({ ...s, dialog: { kind: 'members', id } }))
}

// The Tuca and his DM, made if missing.
export const ensureTuca = (modelId?: string, fresh = false): Promise<{ agentId: string; conversationId: string }> => call('ensureTuca', { modelId, fresh })
// The agent a Tuca card proposed, created with a DM of its own.
export const createFromDraft = (messageId: string): Promise<{ agentId: string; conversationId: string }> => call('createFromDraft', { messageId })
// The builder screen, in place of the app; closing it comes back here.
export const openTuca = (): void => navigate({ kind: 'tuca', from: state.view?.kind === 'tuca' ? state.view.from : (state.view ?? undefined) })
export const settleDraft = (messageId: string, agentId?: string): void => void fire(L('Não consegui salvar o cartão.', "I couldn't save the card."), 'settleDraft', { messageId, agentId })

export async function openDm(agentId: string): Promise<void> {
  const id = await call('openDm', { agentId })
  navigate({ kind: 'conversation', id })
}

export function setGrant(agentId: string, connectorId: string, level: GrantLevel): void {
  const agent = agentById(state, agentId)
  if (agent) patchAgent(agentId, { grants: { ...agent.grants, [connectorId]: level } })
}

export const updateTool = (connectorId: string, name: string, patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>>): void =>
  void fire(L('Não consegui salvar a ferramenta.', "I couldn't save the tool."), 'updateTool', { connectorId, name, patch })

export const addConnector = (input: ConnectorInput): Promise<string> => call('addConnector', { input })
export const removeConnector = (id: string): void => void fire(L('Não consegui remover o conector.', "I couldn't remove the connector."), 'removeConnector', { id })
export const reconnectConnector = (id: string): void => void fire(L('Não consegui reconectar.', "I couldn't reconnect."), 'reconnectConnector', { id })
export const setConnectorToken = (id: string, token: string): Promise<void> => call('setConnectorToken', { id, token })
// On a server the authorization page comes back to be opened here, then pasted back.
export const authorizeConnector = (id: string): void =>
  void call('authorizeConnector', { id }).then(
    (r) => r.url && openDialog({ kind: 'oauth', id, url: r.url }),
    (e: unknown) => state.coreDown || toast(`${L('Não consegui abrir a autorização.', "I couldn't open the authorization.")} ${e instanceof Error ? e.message : ''}`.trim())
  )
export const finishConnectorAuth = (url: string): Promise<boolean> => call('finishConnectorAuth', { url })
export const harnessMcps = (): Promise<HarnessMcp[]> => call('harnessMcps')
export const importHarnessMcp = (key: string): Promise<string> => call('importHarnessMcp', { key })

export const renameChannel = (id: string, name: string): Promise<void> => call('renameChannel', { id, name })
export const archiveAgent = (id: string, archived: boolean): Promise<void> => call('archiveAgent', { id, archived })
export const setTopic = (id: string, topic: string): Promise<void> => call('setTopic', { id, topic })
export const setChannelMembers = (id: string, agentIds: string[]): Promise<void> => call('setChannelMembers', { id, agentIds })
export const deleteConversation = (id: string): Promise<void> => call('deleteConversation', { id })
export const markRead = (id: string): void => set((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? { ...c, unread: 0 } : c)) }))

// `threadId`: a reply in the thread that message started.
export const sendMessage = (conversationId: string, text: string, images: ImageUpload[] = [], threadId?: string): void => {
  if (text.trim() || images.length) void fire(L('Não consegui enviar a mensagem.', "I couldn't send the message."), 'sendMessage', { conversationId, text, ...(images.length ? { images } : {}), ...(threadId ? { threadId } : {}) })
}

export const stopRun = (messageId: string): void => void fire(L('Não consegui parar a resposta.', "I couldn't stop the reply."), 'stopRun', { messageId })
export const retryRun = (messageId: string): void => void fire(L('Não consegui tentar de novo.', "I couldn't try again."), 'retryRun', { messageId })
export const continueRun = (messageId: string): void => void fire(L('Não consegui continuar a resposta.', "I couldn't continue the reply."), 'continueRun', { messageId })

export const decideApproval = (id: string, decision: 'approved' | 'refused', reason?: string, always?: boolean): void =>
  void fire(decision === 'approved' ? L('Não consegui aprovar.', "I couldn't approve it.") : L('Não consegui recusar.', "I couldn't refuse it."), 'decideApproval', { id, decision, reason, always })

const memoryFailed = (): string => L('Não consegui salvar a memória.', "I couldn't save the memory.")
export const addMemory = (scope: MemoryScope, text: string): void => void fire(memoryFailed(), 'addMemory', { scope, text })
export const editMemory = (id: string, text: string): void => void fire(memoryFailed(), 'editMemory', { id, text })
export const confirmMemory = (id: string): void => void fire(memoryFailed(), 'confirmMemory', { id })
export const decideMemory = (id: string, accept: boolean): void => void fire(memoryFailed(), 'decideMemory', { id, accept })
export const forgetMemory = (id: string, reason?: string): void => void fire(L('Não consegui esquecer a memória.', "I couldn't forget the memory."), 'forgetMemory', { id, reason })
export const purgeMemory = (id: string): void => void fire(L('Não consegui apagar a memória.', "I couldn't delete the memory."), 'purgeMemory', { id })
export const editSummary = (conversationId: string, text: string): void => void fire(L('Não consegui salvar o resumo.', "I couldn't save the summary."), 'editSummary', { conversationId, text })
export const summarizeNow = (conversationId: string): void => void fire(L('Não consegui resumir a conversa.', "I couldn't summarize the conversation."), 'summarizeNow', { conversationId })
export const editThreadSummary = (rootId: string, text: string): void => void fire(L('Não consegui salvar o resumo.', "I couldn't save the summary."), 'editThreadSummary', { rootId, text })
export const summarizeThreadNow = (rootId: string): void => void fire(L('Não consegui resumir a thread.', "I couldn't summarize the thread."), 'summarizeThreadNow', { rootId })
// Where a conversation's answers go from now on: each in the thread of what it answers, or in the conversation.
export const setThreads = (conversationId: string, on: boolean): void => {
  void fire(L('Não consegui mudar onde as respostas vão.', "I couldn't change where the answers go."), 'setThreads', { conversationId, on }).then(() =>
    toast(on ? L('As respostas agora vão em threads.', 'Answers now go in threads.') : L('As respostas agora vão na conversa.', 'Answers now go in the conversation.'))
  )
}

// Saves one field of a stored agent without touching the rest of its page.
export function patchAgent(agentId: string, patch: Partial<Agent>): void {
  const agent = agentById(state, agentId)
  if (!agent) return
  const channelIds = state.conversations.filter((c) => c.kind === 'channel' && c.members.includes(agentId)).map((c) => c.id)
  void fire(L('Não consegui salvar o agente.', "I couldn't save the agent."), 'saveAgent', { agent: { ...agent, ...patch }, channelIds })
}

export const localPath = (messageId: string, path: string): Promise<LocalInfo | null> => call('localPath', { messageId, path })
export const openLocal = (messageId: string, path: string, how: 'open' | 'reveal'): void => void call('openLocal', { messageId, path, how })
export const openPanel = (panel: Panel | null): void => set((s) => ({ ...s, panel }))
export const openThread = (messageId: string): void => openPanel({ kind: 'thread', id: messageId })
// I've seen this thread up to now (it's open, or was just closed).
export const seeThread = (rootId: string): void =>
  set((s) => {
    const threadSeen = { ...s.threadSeen, [rootId]: Date.now() }
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(threadSeen))
    } catch {}
    return { ...s, threadSeen }
  })
export const openLightbox = (items: { url: string; title: string; video?: boolean }[], index: number): void => set((s) => ({ ...s, lightbox: { items, index } }))
export const closeLightbox = (): void => set((s) => ({ ...s, lightbox: null }))
export const moveLightbox = (by: number): void =>
  set((s) => (s.lightbox ? { ...s, lightbox: { ...s.lightbox, index: (s.lightbox.index + by + s.lightbox.items.length) % s.lightbox.items.length } } : s))
export const openDialog = (dialog: Dialog | null): void => set((s) => ({ ...s, dialog, navOpen: dialog ? false : s.navOpen }))
export const setTab = (page: string, tab: string): void => set((s) => ({ ...s, tabs: { ...s.tabs, [page]: tab } }))
export const computerAction = (agentId: string, action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh'): void =>
  void fire(L('Não consegui mexer no computador do agente.', "I couldn't act on the agent's computer."), 'computerAction', { agentId, action })
export const stopService = (agentId: string, name: string): void => void fire(L('Não consegui parar o serviço.', "I couldn't stop the service."), 'stopService', { agentId, name })
export const browserAction = (agentId: string, action: 'show' | 'hide' | 'clear'): void => void fire(L('Não consegui mexer no navegador do agente.', "I couldn't act on the agent's browser."), 'browserAction', { agentId, action })
// Tucano as a server: the page is in a browser and the agent's has no window, so I
// drive it from its picture in the panel.
export const windowless = (): boolean => !!(window as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__
// A page an agent serves, as this browser reaches it: on a server, at the server's
// address (it passes running services through on a private network).
export const reachable = (url: string): string => (windowless() ? url.replace(/^http:\/\/127\.0\.0\.1:/, `http://${location.hostname}:`) : url)
export const browserInput = (agentId: string, input: BrowserInput): void => void call('browserInput', { agentId, input }).catch(() => {})
// In a browser (Tucano as a server) the page opens it itself: the server has no screen.
export const openExternal = (url: string): void =>
  (window as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__ ? void window.open(url, '_blank', 'noopener') : void fire(L('Não consegui abrir o link.', "I couldn't open the link."), 'openExternal', { url })

export const saveRoutine = (routine: RoutineInput): Promise<Routine> => call('saveRoutine', { routine })
export const setJevKey = (key: string | null): Promise<void> => call('setJevKey', { key })
export const engineModels = (engine: EngineId): Promise<{ models: string[]; labels?: Record<string, { label: string; hint?: string }>; error?: string }> => call('engineModels', { engine })
export const testEngine = (model: string): Promise<{ ok: boolean; message: string }> => call('testEngine', { model })
export const saveSkill = (skill: SkillInput): Promise<Skill> => call('saveSkill', { skill })
export const localSkills = (): Promise<LocalSkill[]> => call('localSkills')
export const linkSkill = (source: string, agents: string[] = []): Promise<Skill> => call('linkSkill', { source, agents })
export const decideSkill = (id: string, approve: boolean): void =>
  void fire(approve ? L('Não consegui aprovar a skill.', "I couldn't approve the skill.") : L('Não consegui recusar a skill.', "I couldn't refuse the skill."), 'decideSkill', { id, approve })
export const restoreSkill = (skillId: string, versionId: number): void => void fire(L('Não consegui restaurar a versão.', "I couldn't restore the version."), 'restoreSkill', { skillId, versionId })
export const archiveSkill = (id: string, archived: boolean): void =>
  void fire(archived ? L('Não consegui arquivar a skill.', "I couldn't archive the skill.") : L('Não consegui reativar a skill.', "I couldn't bring the skill back."), 'archiveSkill', { id, archived })
export const removeSkill = (id: string): void => void fire(L('Não consegui remover a skill.', "I couldn't remove the skill."), 'removeSkill', { id })
export const skillVersions = (skillId: string): Promise<SkillVersion[]> => call('skillVersions', { skillId })
export const checkTrigger = (trigger: Trigger): Promise<string> => call('checkTrigger', { trigger })
export const setTelegramToken = (token: string | null): Promise<void> => call('setTelegramToken', { token })
export const unpairTelegram = (): void => void fire(L('Não consegui desconectar o Telegram.', "I couldn't disconnect Telegram."), 'unpairTelegram')
export const setGithubToken = (token: string | null): Promise<void> => call('setGithubToken', { token })
export const exportTeam = (): Promise<string> => call('exportTeam')
export const importTeam = (text: string): Promise<string> => call('importTeam', { text })
export const importAgents = (p: { path?: string; data?: string }): Promise<string> => call('importAgents', p)
export const backupNow = (): Promise<string> => call('backupNow')
export const openBackups = (): void => void fire(L('Não consegui abrir a pasta de backups.', "I couldn't open the backups folder."), 'openBackups')
export const loadReport = (week?: number): Promise<Report> => call('report', { week })
export const loadUsage = (): Promise<UsageReport> => call('usage')
export const removeRoutine = (id: string): void => void fire(L('Não consegui remover a rotina.', "I couldn't remove the routine."), 'removeRoutine', { id })
export const runRoutine = (id: string): void => void fire(L('Não consegui rodar a rotina.', "I couldn't run the routine."), 'runRoutine', { id })
// A @handle from a name: "Lúcia M." → "luciam".
export const slug = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)

// The id of the DM with an agent, created if it doesn't exist yet, without opening it.
export const dmWith = (agentId: string): Promise<string> => call('openDm', { agentId })

// Opens the Mac's folder picker; resolves with why it couldn't be lent, if so.
export async function lendFolder(agentId: string): Promise<string | null> {
  const path = await window.tucano.pickFolder()
  if (!path) return null
  try {
    await call('lendFolder', { agentId, path })
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export const folderAction = (agentId: string, name: string, action: 'read_only' | 'read_write' | 'return'): void =>
  void fire(L('Não consegui mudar o acesso à pasta.', "I couldn't change the folder's access."), 'folderAction', { agentId, name, action })
