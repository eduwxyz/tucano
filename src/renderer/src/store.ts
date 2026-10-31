// Renderer state. Everything except the current view comes from the core and
// is kept in sync by its events; actions go to the core over RPC.
import { useRef, useSyncExternalStore } from 'react'
import { L, setLang } from '../../shared/lang'
import type { CoreEvent } from '../../shared/rpc'
import {
  MODELS,
  modelInfo,
  type EngineId,
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
  type Os
} from '../../shared/types'
import { call, connect } from './rpc'

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
  | { kind: 'routines' }
  | { kind: 'skills' }
  | { kind: 'report' }
  | { kind: 'settings' }

export interface State {
  ready: boolean
  view: View | null
  me: { name: string; initials: string }
  settings: Settings
  models: Model[]
  agents: Agent[]
  connectors: Connector[]
  conversations: Conversation[]
  messages: Message[]
  approvals: Approval[]
  memories: Memory[]
  artifacts: Artifact[]
  computers: ComputerInfo[]
  browsers: BrowserView[]
  routines: Routine[]
  skills: Skill[]
  platform: Os
  packaged: boolean
  panel: Panel | null // the side panel next to a conversation
  dialog: Dialog | null // a small window: a channel's members, name or topic; archived agents; new channel; search
  tabs: Record<string, string> // the open tab of each page with tabs, kept while the app is open
  demoServer?: { command: string; args: string[] }
}

export type Dialog = { kind: 'members' | 'rename' | 'topic'; id: string } | { kind: 'archived' | 'new-channel' | 'search' }

export type Panel = { kind: 'artifact'; id: string } | { kind: 'service'; agentId: string; name: string } | { kind: 'browser'; agentId: string }

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || 'EU'

let state: State = {
  ready: false,
  view: null,
  me: { name: 'Eu', initials: 'EU' },
  settings: {
    workspaceName: '',
    context: '',
    engines: { claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false }, opencode: { installed: false, loggedIn: false }, pi: { installed: false, loggedIn: false }, gemini: { installed: false, loggedIn: false } },
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
  tabs: {}
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
        const conversations =
          !known && !viewing && (e.message.author.kind === 'agent' || e.message.author.kind === 'routine')
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
    }
  })
}

export async function start(): Promise<void> {
  window.tucano.onNavigate((id) => navigate({ kind: 'conversation', id }))
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

// ---------- actions ----------

export const navigate = (view: View): void =>
  set((s) => ({
    ...s,
    view,
    panel: s.view?.kind === view.kind && JSON.stringify(s.view) === JSON.stringify(view) ? s.panel : null,
    conversations:
      view.kind === 'conversation' ? s.conversations.map((c) => (c.id === view.id ? { ...c, unread: 0 } : c)) : s.conversations
  }))

export function updateSettings(patch: Partial<Omit<Settings, 'engines'>>): void {
  set((s) => withSettings(s, { ...s.settings, ...patch })) // optimistic, so typing stays instant
  void call('updateSettings', { patch })
}

export const refreshEngines = (): void => void call('refreshEngines')
export const loginEngine = (engine: keyof Settings['engines']): Promise<{ opened: boolean; command: string }> => call('loginEngine', { engine })
export const installEngine = (engine: keyof Settings['engines']): Promise<{ opened: boolean; command: string; needsNode?: boolean }> => call('installEngine', { engine })

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
export const settleDraft = (messageId: string, agentId?: string): void => void call('settleDraft', { messageId, agentId })

export async function openDm(agentId: string): Promise<void> {
  const id = await call('openDm', { agentId })
  navigate({ kind: 'conversation', id })
}

export function setGrant(agentId: string, connectorId: string, level: GrantLevel): void {
  const agent = agentById(state, agentId)
  if (agent) patchAgent(agentId, { grants: { ...agent.grants, [connectorId]: level } })
}

export const updateTool = (connectorId: string, name: string, patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>>): void =>
  void call('updateTool', { connectorId, name, patch })

export const addConnector = (input: ConnectorInput): Promise<string> => call('addConnector', { input })
export const removeConnector = (id: string): void => void call('removeConnector', { id })
export const reconnectConnector = (id: string): void => void call('reconnectConnector', { id })
export const authorizeConnector = (id: string): void => void call('authorizeConnector', { id })
export const harnessMcps = (): Promise<HarnessMcp[]> => call('harnessMcps')
export const importHarnessMcp = (key: string): Promise<string> => call('importHarnessMcp', { key })

export const renameChannel = (id: string, name: string): Promise<void> => call('renameChannel', { id, name })
export const archiveAgent = (id: string, archived: boolean): Promise<void> => call('archiveAgent', { id, archived })
export const setTopic = (id: string, topic: string): Promise<void> => call('setTopic', { id, topic })
export const setChannelMembers = (id: string, agentIds: string[]): Promise<void> => call('setChannelMembers', { id, agentIds })
export const deleteConversation = (id: string): Promise<void> => call('deleteConversation', { id })
export const markRead = (id: string): void => set((s) => ({ ...s, conversations: s.conversations.map((c) => (c.id === id ? { ...c, unread: 0 } : c)) }))

export const sendMessage = (conversationId: string, text: string, images: ImageUpload[] = []): void => {
  if (text.trim() || images.length) void call('sendMessage', { conversationId, text, ...(images.length ? { images } : {}) })
}

export const stopRun = (messageId: string): void => void call('stopRun', { messageId })
export const retryRun = (messageId: string): void => void call('retryRun', { messageId })
export const continueRun = (messageId: string): void => void call('continueRun', { messageId })

export const decideApproval = (id: string, decision: 'approved' | 'refused', reason?: string, always?: boolean): void =>
  void call('decideApproval', { id, decision, reason, always })

export const addMemory = (scope: MemoryScope, text: string): void => void call('addMemory', { scope, text })
export const editMemory = (id: string, text: string): void => void call('editMemory', { id, text })
export const confirmMemory = (id: string): void => void call('confirmMemory', { id })
export const decideMemory = (id: string, accept: boolean): void => void call('decideMemory', { id, accept })
export const forgetMemory = (id: string, reason?: string): void => void call('forgetMemory', { id, reason })
export const purgeMemory = (id: string): void => void call('purgeMemory', { id })
export const editSummary = (conversationId: string, text: string): void => void call('editSummary', { conversationId, text })
export const summarizeNow = (conversationId: string): void => void call('summarizeNow', { conversationId })

// Saves one field of a stored agent without touching the rest of its page.
export function patchAgent(agentId: string, patch: Partial<Agent>): void {
  const agent = agentById(state, agentId)
  if (!agent) return
  const channelIds = state.conversations.filter((c) => c.kind === 'channel' && c.members.includes(agentId)).map((c) => c.id)
  void saveAgent({ ...agent, ...patch }, channelIds)
}

export const openPanel = (panel: Panel | null): void => set((s) => ({ ...s, panel }))
export const openDialog = (dialog: Dialog | null): void => set((s) => ({ ...s, dialog }))
export const setTab = (page: string, tab: string): void => set((s) => ({ ...s, tabs: { ...s.tabs, [page]: tab } }))
export const computerAction = (agentId: string, action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh'): void =>
  void call('computerAction', { agentId, action })
export const stopService = (agentId: string, name: string): void => void call('stopService', { agentId, name })
export const browserAction = (agentId: string, action: 'show' | 'hide' | 'clear'): void => void call('browserAction', { agentId, action })
export const openExternal = (url: string): void => void call('openExternal', { url })

export const saveRoutine = (routine: RoutineInput): Promise<Routine> => call('saveRoutine', { routine })
export const setJevKey = (key: string | null): Promise<void> => call('setJevKey', { key })
export const engineModels = (engine: EngineId): Promise<{ models: string[]; error?: string }> => call('engineModels', { engine })
export const testEngine = (model: string): Promise<{ ok: boolean; message: string }> => call('testEngine', { model })
export const saveSkill = (skill: SkillInput): Promise<Skill> => call('saveSkill', { skill })
export const localSkills = (): Promise<LocalSkill[]> => call('localSkills')
export const linkSkill = (source: string, agents: string[] = []): Promise<Skill> => call('linkSkill', { source, agents })
export const decideSkill = (id: string, approve: boolean): void => void call('decideSkill', { id, approve })
export const restoreSkill = (skillId: string, versionId: number): void => void call('restoreSkill', { skillId, versionId })
export const archiveSkill = (id: string, archived: boolean): void => void call('archiveSkill', { id, archived })
export const removeSkill = (id: string): void => void call('removeSkill', { id })
export const skillVersions = (skillId: string): Promise<SkillVersion[]> => call('skillVersions', { skillId })
export const checkTrigger = (trigger: Trigger): Promise<string> => call('checkTrigger', { trigger })
export const setTelegramToken = (token: string | null): Promise<void> => call('setTelegramToken', { token })
export const unpairTelegram = (): void => void call('unpairTelegram')
export const setGithubToken = (token: string | null): Promise<void> => call('setGithubToken', { token })
export const exportTeam = (): Promise<string> => call('exportTeam')
export const importTeam = (text: string): Promise<string> => call('importTeam', { text })
export const backupNow = (): Promise<string> => call('backupNow')
export const openBackups = (): void => void call('openBackups')
export const loadReport = (week?: number): Promise<Report> => call('report', { week })
export const loadUsage = (): Promise<UsageReport> => call('usage')
export const removeRoutine = (id: string): void => void call('removeRoutine', { id })
export const runRoutine = (id: string): void => void call('runRoutine', { id })
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

export const folderAction = (agentId: string, name: string, action: 'read_only' | 'read_write' | 'return'): void => void call('folderAction', { agentId, name, action })
