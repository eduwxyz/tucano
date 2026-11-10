// Renderer state. Everything except the current view comes from the core and
// is kept in sync by its events; actions go to the core over RPC.
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { L, setLang } from '../../shared/lang'
import type { Answer } from '../../shared/questions'
import type { CoreEvent, Method, Params } from '../../shared/rpc'
import type { AppProvider } from '../../shared/connector-catalog'
import {
  asSaid,
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
  type Person,
  type Delegation,
  type Inbox,
  type Device,
  type Invite,
  type ActivityEntry,
  delegating,
  type Routine,
  type RoutineInput,
  type Settings,
  type SetupEngine,
  type SetupState,
  type LoginKey,
  type LoginScreen,
  type Skill,
  type SkillInput,
  type SkillVersion,
  type Report,
  type UsageReport,
  type Trigger,
  type ImageUpload,
  type FileUpload,
  type Os,
  type LocalInfo,
  type VoiceModelId,
  type VoiceStatus,
  type ProposalsResult,
  type BackupSummary
} from '../../shared/types'
import { call, connect, disconnect } from './rpc'
import { hashToView, viewToHash } from './address'

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
  | { kind: 'org' } // who answers to whom (src/shared/org.ts)
  | { kind: 'settings' }
  | { kind: 'missions' } // what to try next, each bringing a part of the sidebar on a new install

export interface State {
  webhookPort: number
  defaultWorkspace: boolean
  ready: boolean
  threadSeen: Record<string, number> // thread root id → when I last had it open (what came after is new)
  navOpen: boolean // on a phone, the sidebar slid in over the view
  view: View | null
  me: { name: string; initials: string }
  you: string // the person this window is (snapshot.you)
  people: Person[]
  former: Pick<Person, 'id' | 'name'>[] // those who left: their names, for what they wrote before
  inbox: Inbox // what waits on me: approvals I can decide, questions to me, (admins) cards members sent
  delegations: Delegation[] // work handed down the tree (src/shared/org.ts): open, or ended in the last day
  needsName: boolean // a server's first access: the owner says what the agents call them
  settings: Settings
  models: Model[]
  agents: Agent[]
  connectors: Connector[]
  lightbox: { items: { url: string; title: string; video?: boolean }[]; index: number } | null
  conversations: Conversation[]
  messages: Record<string, Message[]> // per conversation, oldest first; read through messagesIn and the indexes below
  history: Record<string, number> // per conversation with older messages still in the core: from when it's here whole
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
  isolatedComputers: boolean
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

export type Dialog = { kind: 'members' | 'settings'; id: string } | { kind: 'archived' | 'new-channel' | 'search' } | { kind: 'workspaces'; create?: boolean } | { kind: 'oauth'; id: string; url: string }

// `thread`: the replies to a message (its id), next to the conversation.
export type Panel = { kind: 'artifact'; id: string } | { kind: 'service'; agentId: string; name: string } | { kind: 'browser'; agentId: string } | { kind: 'thread'; id: string }

export const initials = (name: string): string =>
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
  webhookPort: 47717,
  defaultWorkspace: true,
  ready: false,
  threadSeen: loadSeen(),
  wikiRev: 0,
  voiceRev: 0,
  navOpen: false,
  view: null,
  me: { name: 'Eu', initials: 'EU' },
  you: '',
  people: [],
  former: [],
  inbox: { approvals: [], questions: [] },
  delegations: [],
  needsName: false,
  settings: {
    workspaceName: '',
    context: '',
    engines: { claude: { installed: false, loggedIn: false }, codex: { installed: false, loggedIn: false }, opencode: { installed: false, loggedIn: false }, pi: { installed: false, loggedIn: false }, antigravity: { installed: false, loggedIn: false }, cursor: { installed: false, loggedIn: false }, grok: { installed: false, loggedIn: false }, cline: { installed: false, loggedIn: false }, hermes: { installed: false, loggedIn: false } },
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
  messages: {},
  history: {},
  approvals: [],
  memories: [],
  artifacts: [],
  computers: [],
  browsers: [],
  routines: [],
  skills: [],
  platform: 'mac',
  packaged: false,
  isolatedComputers: true,
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

// ---------- messages ----------
// Kept per conversation, oldest first, so a change copies one conversation and not all of them.
// What the screens ask of them (a thread's replies, who's at work) is worked out once per change,
// in an index each list gets the first time something reads it.

const NO_MESSAGES: Message[] = []
export const messagesIn = (s: State, conversationId: string): Message[] => s.messages[conversationId] ?? NO_MESSAGES

const byConversation = (list: Message[]): Record<string, Message[]> => {
  const out: Record<string, Message[]> = {}
  for (const m of list) (out[m.conversationId] ??= []).push(m)
  return out
}

// A new message almost always goes last; one that changed stays where it was.
function upsertMessage(list: Message[], m: Message): Message[] {
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i]!.id === m.id) {
      const next = list.slice()
      next[i] = m
      return next
    }
  let i = list.length
  while (i > 0 && list[i - 1]!.at > m.at) i--
  return [...list.slice(0, i), m, ...list.slice(i)]
}

// What came from further back joins in time order; what's here already stays (events keep it current).
function mergeMessages(list: Message[], more: Message[]): Message[] {
  const have = indexOf(list).byId
  const fresh = more.filter((m) => !have.has(m.id))
  return fresh.length ? [...list, ...fresh].sort((a, b) => a.at - b.at) : list
}

interface ConversationIndex {
  byId: Map<string, Message>
  timeline: Message[] // what's outside threads
  replies: Map<string, Message[]> // a thread's first message → its replies
  working: Message[] // replies at work, and notes still pending
  waiting: Message[] // questions waiting on me
  browser: Map<string, string> // an agent → its latest message that used the browser
  receipts: Message[]
  agentDone: boolean // some agent finished a reply here
  shown?: { from: number; list: Message[] }
}

const indexes = new WeakMap<Message[], ConversationIndex>()
const lastIndex = new Map<string, ConversationIndex>() // per conversation: the replies that didn't change keep their array
const sameList = (a: Message[], b: Message[]): boolean => a.length === b.length && a.every((m, i) => m === b[i])

function indexOf(list: Message[]): ConversationIndex {
  const had = indexes.get(list)
  if (had) return had
  const ix: ConversationIndex = { byId: new Map(), timeline: [], replies: new Map(), working: [], waiting: [], browser: new Map(), receipts: [], agentDone: false }
  // In the order things were said (a reply when it ended), whoever is still working at the end.
  for (const m of asSaid(list)) {
    ix.byId.set(m.id, m)
    if (!m.threadId) ix.timeline.push(m)
    else {
      const r = ix.replies.get(m.threadId)
      if (r) r.push(m)
      else ix.replies.set(m.threadId, [m])
    }
    const status = m.run?.status
    if (status === 'working') ix.working.push(m)
    else if (status === 'waiting_input') ix.waiting.push(m)
    if (m.run?.receipt) ix.receipts.push(m)
    if (m.author.kind === 'agent') {
      if (m.run?.browser) ix.browser.set(m.author.id, m.id)
      if (status === 'done') ix.agentDone = true
    }
  }
  // The same array for a thread that didn't change, so its row doesn't draw again.
  const prev = list[0] && lastIndex.get(list[0].conversationId)
  if (prev)
    for (const [root, r] of ix.replies) {
      const old = prev.replies.get(root)
      if (old && sameList(old, r)) ix.replies.set(root, old)
    }
  indexes.set(list, ix)
  if (list[0]) lastIndex.set(list[0].conversationId, ix)
  return ix
}

export const conversationIndex = (s: State, conversationId: string): ConversationIndex => indexOf(messagesIn(s, conversationId))

// The timeline as it shows: what's outside threads, from where it's here whole (older messages
// kept for a routine's run or a thread wait until the scroll gets there).
export function timelineOf(s: State, conversationId: string): Message[] {
  const ix = conversationIndex(s, conversationId)
  const from = s.history[conversationId] ?? 0
  if (!from) return ix.timeline
  if (ix.shown?.from !== from) ix.shown = { from, list: ix.timeline.filter((m) => m.at >= from) }
  return ix.shown.list
}

export const repliesOf = (s: State, conversationId: string, rootId: string): Message[] => conversationIndex(s, conversationId).replies.get(rootId) ?? NO_MESSAGES

export function messageById(s: State, id: string, conversationId?: string): Message | undefined {
  if (conversationId) return conversationIndex(s, conversationId).byId.get(id)
  for (const list of Object.values(s.messages)) {
    const m = indexOf(list).byId.get(id)
    if (m) return m
  }
  return undefined
}

export const isWorking = (s: State, conversationId: string): boolean => conversationIndex(s, conversationId).working.length > 0
// The agents' replies at work in a place: in a thread, or outside threads.
export const workingIds = (s: State, conversationId: string, threadId?: string): string[] =>
  conversationIndex(s, conversationId)
    .working.filter((m) => m.threadId === threadId && m.author.kind === 'agent')
    .map((m) => m.id)
export const askerIn = (s: State, conversationId: string, threadId?: string): Message | undefined => conversationIndex(s, conversationId).waiting.findLast((m) => m.threadId === threadId)
export const lastBrowserIn = (s: State, conversationId: string, agentId: string): string | undefined => conversationIndex(s, conversationId).browser.get(agentId)

// Across conversations, once per change.
interface Everywhere {
  workingAgents: Set<string>
  workingOn: Map<string, Message> // an agent → the reply it is on (the latest, with several)
  receipts: Message[]
  agentDone: boolean
}
const everywhere = new WeakMap<Record<string, Message[]>, Everywhere>()
function across(s: State): Everywhere {
  const had = everywhere.get(s.messages)
  if (had) return had
  const all: Everywhere = { workingAgents: new Set(), workingOn: new Map(), receipts: [], agentDone: false }
  for (const list of Object.values(s.messages)) {
    const ix = indexOf(list)
    for (const m of ix.working)
      if (m.author.kind === 'agent') {
        all.workingAgents.add(m.author.id)
        if ((all.workingOn.get(m.author.id)?.at ?? 0) <= m.at) all.workingOn.set(m.author.id, m)
      }
    all.receipts.push(...ix.receipts)
    all.agentDone ||= ix.agentDone
  }
  everywhere.set(s.messages, all)
  return all
}
export const workingAgents = (s: State): Set<string> => across(s).workingAgents
export const workingOn = (s: State): Map<string, Message> => across(s).workingOn
export const receipts = (s: State): Message[] => across(s).receipts
export const anyReplyDone = (s: State): boolean => across(s).agentDone

// What I attached to my own messages, by message, once per change of the artifacts.
const NO_ARTIFACTS: Artifact[] = []
const attached = new WeakMap<Artifact[], Map<string, Artifact[]>>()
export function attachedTo(s: State, messageId: string): Artifact[] {
  let byMessage = attached.get(s.artifacts)
  if (!byMessage) {
    byMessage = new Map()
    for (const a of s.artifacts) {
      if (a.agentId !== '' || !a.messageId) continue
      const list = byMessage.get(a.messageId)
      if (list) list.push(a)
      else byMessage.set(a.messageId, [a])
    }
    attached.set(s.artifacts, byMessage)
  }
  return byMessage.get(messageId) ?? NO_ARTIFACTS
}

// Older messages, a page at a time as the scroll gets there, or back to `through` (a message to show).
const loadingOlder = new Map<string, Promise<void>>()
export function loadOlder(conversationId: string, through?: string): Promise<void> {
  const busy = loadingOlder.get(conversationId)
  if (busy) return through ? busy.then(() => loadOlder(conversationId, through)) : busy
  const before = state.history[conversationId]
  if (!before) return Promise.resolve()
  const p = call('olderMessages', { conversationId, before, ...(through ? { through } : {}) })
    .then(({ messages, since }) =>
      set((s) => {
        const { [conversationId]: _was, ...history } = s.history
        return { ...s, messages: { ...s.messages, [conversationId]: mergeMessages(messagesIn(s, conversationId), messages) }, history: since ? { ...history, [conversationId]: since } : history }
      })
    )
    .catch(() => {}) // the next scroll asks again
    .finally(() => loadingOlder.delete(conversationId))
  loadingOlder.set(conversationId, p)
  return p
}

// A thread from before what's here (a notification about it, say): the message that started it, and its replies.
export async function loadThread(rootId: string): Promise<void> {
  const list = await call('threadMessages', { rootId }).catch((): Message[] => [])
  const id = list[0]?.conversationId
  if (id) set((s) => ({ ...s, messages: { ...s.messages, [id]: mergeMessages(messagesIn(s, id), list) } }))
}

// ---------- streaming ----------
// A reply's words as they stream, kept out of the state: a delta wakes only the row that shows it.

const live = new Map<string, string>()
const liveListeners = new Map<string, Set<() => void>>()
const thoughtListeners = new Map<string, Set<() => void>>()

function listen(map: Map<string, Set<() => void>>, key: string, l: () => void): () => void {
  let ls = map.get(key)
  if (!ls) map.set(key, (ls = new Set()))
  ls.add(l)
  return () => {
    ls.delete(l)
    if (!ls.size) map.delete(key)
  }
}
const wake = (map: Map<string, Set<() => void>>, key: string): void => map.get(key)?.forEach((l) => l())

function stream(id: string, text: string): void {
  live.set(id, (live.get(id) ?? messageById(state, id)?.text ?? '') + text)
  wake(liveListeners, id)
}

export const liveText = (id: string): string | undefined => live.get(id)

// What the model is thinking, streamed apart from the reply: kept here, in memory, because it is
// something to watch as it goes and not part of what the agent said.
const thoughts = new Map<string, string>()
const THOUGHT_KEEP = 20_000 // a very long one is trimmed from the front, never allowed to grow forever

function streamThought(id: string, text: string): void {
  const all = (thoughts.get(id) ?? '') + text
  thoughts.set(id, all.length > THOUGHT_KEEP ? all.slice(all.length - THOUGHT_KEEP) : all)
  wake(thoughtListeners, id)
}

export const liveThought = (id: string): string | undefined => thoughts.get(id)

// The thinking as it is now, woken as it arrives. `every`: wake at most that often (ms).
export function useLiveThought(id: string, every = 0): string | undefined {
  const subscribe = useCallback(
    (l: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const off = listen(thoughtListeners, id, () => {
        if (!every) return l()
        if (timer) return
        timer = setTimeout(() => {
          timer = undefined
          l()
        }, every)
      })
      return () => {
        if (timer) clearTimeout(timer)
        off()
      }
    },
    [id, every]
  )
  return useSyncExternalStore(subscribe, () => thoughts.get(id))
}

// The message's text as it is now. `every`: wake at most that often (ms), for what is costly to draw.
export function useLiveText(m: Message, every = 0): string {
  const subscribe = useCallback(
    (l: () => void) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let last = 0
      const off = listen(liveListeners, m.id, () => {
        if (!every) return l()
        if (timer) return
        timer = setTimeout(
          () => {
            timer = undefined
            last = Date.now()
            l()
          },
          Math.max(0, last + every - Date.now())
        )
      })
      return () => {
        clearTimeout(timer)
        off()
      }
    },
    [m.id, every]
  )
  return useSyncExternalStore(subscribe, () => live.get(m.id) ?? m.text)
}

// ---------- browser frames ----------
// An agent's browser sends its screen up to ten times a second: kept apart, like the streamed words.

const frames = new Map<string, string>()
const frameListeners = new Map<string, Set<() => void>>()

function showFrame(agentId: string, frame: string | undefined): void {
  if (frames.get(agentId) === frame) return
  if (frame) frames.set(agentId, frame)
  else frames.delete(agentId)
  wake(frameListeners, agentId)
}

export function useFrame(agentId: string): string | undefined {
  const subscribe = useCallback((l: () => void) => listen(frameListeners, agentId, l), [agentId])
  return useSyncExternalStore(subscribe, () => frames.get(agentId))
}

// ---------- core sync ----------

// My name: the owner's is the settings' (what the agents have always called them); anyone else's, theirs.
function withMe(s: State): State {
  const person = s.people.find((p) => p.id === s.you)
  const name = (person && person.role !== 'owner' ? person.name : s.settings.workspaceName) || L('Eu', 'Me')
  return s.me.name === name ? s : { ...s, me: { name, initials: initials(name) } }
}

function withSettings(s: State, settings: Settings): State {
  setLang(settings.language)
  return withMe({ ...s, settings })
}

function apply(e: CoreEvent): void {
  // Streamed words and the browser's screen come many times a second: they wake only what shows them.
  if (e.type === 'delta') return stream(e.id, e.text)
  // The model's reasoning is kept only when this person asked for it (Settings › General): off, the
  // text never lands in memory, so nothing of it can be drawn or read back later.
  if (e.type === 'thinking') return state.settings.showThinking === true ? streamThought(e.id, e.text) : undefined
  if (e.type === 'browser_frame') return showFrame(e.agentId, e.frame)
  set((s) => {
    switch (e.type) {
      case 'message': {
        const id = e.message.conversationId
        const messages = { ...s.messages, [id]: upsertMessage(messagesIn(s, id), e.message) }
        // What I just wrote in a conversation that answers in threads opens its thread, where the
        // answers go: it's what clicking the thread's link would do, without having to find it.
        const m = e.message
        const opens =
          openNext?.conversationId === id &&
          Date.now() < openNext.until &&
          !m.threadId &&
          isMine(s, m.author) &&
          !messagesIn(s, id).some((x) => x.id === m.id)
        if (!opens) return { ...s, messages }
        openNext = null
        const here = s.view?.kind === 'conversation' && s.view.id === id
        return { ...s, messages, ...(here ? { panel: { kind: 'thread' as const, id: m.id } } : {}) }
      }
      case 'agent':
        return { ...s, agents: upsert(s.agents, e.agent) }
      case 'conversation': {
        return { ...s, conversations: upsert(s.conversations, e.conversation) }
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
        const { [e.id]: _gone, ...messages } = s.messages
        const { [e.id]: _from, ...history } = s.history
        return {
          ...s,
          conversations: left,
          messages,
          history,
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
      case 'people':
        return withMe({ ...s, people: e.people, ...(e.former ? { former: e.former } : {}) })
      case 'inbox':
        return { ...s, inbox: e.inbox ?? s.inbox }
      case 'delegations':
        return { ...s, delegations: e.delegations ?? s.delegations }
    }
  })
  // A full message carries all its text so far: what streamed before it is in there.
  if (e.type === 'message' && live.delete(e.message.id)) wake(liveListeners, e.message.id)
  if (e.type === 'browser') showFrame(e.view.agentId, e.view.frame)
}

// A screen from the address, only if it's still there (a conversation that was removed, an agent gone).
const stillThere = (view: View | undefined, s: Pick<State, 'conversations' | 'agents'>): View | undefined =>
  !view || (view.kind === 'conversation' && !s.conversations.some((c) => c.id === view.id)) || (view.kind === 'agent' && !s.agents.some((a) => a.id === view.id)) ? undefined : view

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
    if (id !== viewing) {
      window.tucano.viewing((viewing = id))
      if (id && state.ready) void call('markRead', { conversationId: id })
    }
  })
  // In a browser the screen rides in the address, so a reload (a phone bringing the tab back)
  // opens where it was. The desktop keeps it in memory, as before.
  const web = windowless()
  if (web) {
    const write = (): void => {
      const hash = state.view && viewToHash(state.view)
      if (hash && location.hash !== hash) history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`)
    }
    let last: View | null = null
    subscribe(() => state.view !== last && ((last = state.view), write()))
    // An address typed or pasted while the page is open: there, or back to where it is.
    window.addEventListener('hashchange', () => {
      if (!state.ready) return
      const view = stillThere(hashToView(location.hash), state)
      if (view && viewToHash(view) !== (state.view && viewToHash(state.view))) navigate(view)
      else write()
    })
  }
  await connect(apply)
  const snap = await call('snapshot')
  for (const b of snap.browsers) showFrame(b.agentId, b.frame)
  set((s) => {
    const first = snap.conversations.find((c) => c.kind === 'channel') ?? snap.conversations[0]
    const there = web ? stillThere(hashToView(location.hash), snap) : undefined
    const view = s.view ?? there ?? (first ? { kind: 'conversation' as const, id: first.id } : { kind: 'new-agent' as const })
    return {
      ...withSettings({ ...s, you: snap.you, people: snap.people }, snap.settings),
      ready: true,
      needsName: !!snap.needsName,
      webhookPort: snap.webhookPort ?? 47717,
      defaultWorkspace: snap.defaultWorkspace ?? true,
      view,
      agents: snap.agents,
      conversations: snap.conversations,
      messages: byConversation(snap.messages),
      history: snap.since ?? {},
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
      isolatedComputers: snap.isolatedComputers,
      demoServer: snap.demoServer,
      you: snap.you,
      inbox: snap.inbox ?? { approvals: [], questions: [] },
      delegations: snap.delegations ?? [],
      people: snap.people,
      former: snap.former ?? []
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
// A message of this window's person (one from before people has no id to compare, and was the owner's: theirs too).
export const isMine = (s: Pick<State, 'you'>, a: Message['author']): boolean => a.kind === 'person' && (!s.you || a.id === s.you)
// Another person's name, as the conversation shows it.
// Someone who left keeps their name on what they wrote, marked as gone.
export const personName = (s: Pick<State, 'you' | 'people' | 'me'> & { former?: State['former'] }, id: string): string => {
  if (id === s.you) return s.me.name
  const here = s.people.find((p) => p.id === id)?.name
  if (here) return here
  const gone = s.former?.find((p) => p.id === id)?.name
  return gone ? L(`${gone} (saiu)`, `${gone} (left)`) : L('Alguém', 'Someone')
}
export const personById = (s: Pick<State, 'people'>, id: string | undefined): Person | undefined => (id ? s.people.find((p) => p.id === id) : undefined)
// Who this window is. Before the snapshot (or on an old core) there's no one: the owner, as always.
export const youPerson = (s: Pick<State, 'people' | 'you'>): Person | undefined => s.people.find((p) => p.id === s.you)
// The same rule the core enforces (policy-people.ts): owners and admins manage the team's things.
export const amAdmin = (s: Pick<State, 'people' | 'you'>): boolean => {
  const me = youPerson(s)
  return !me || me.role === 'owner' || me.role === 'admin'
}
export const amOwner = (s: Pick<State, 'people' | 'you'>): boolean => (youPerson(s)?.role ?? 'owner') === 'owner'
// A channel's name, topic and agents: whoever made it (the owner, for one from before) and the admins.
export const canEditChannel = (s: Pick<State, 'people' | 'you'>, c: Pick<Conversation, 'kind' | 'createdBy'>): boolean =>
  c.kind === 'channel' && (amAdmin(s) || (c.createdBy ?? s.people.find((p) => p.role === 'owner')?.id) === s.you)
// A Tucano with a team: more than one person, or a server (where people come in). A desktop alone
// shows nothing of people, as always.
export const teamMode = (s: Pick<State, 'people'>): boolean => s.people.length > 1 || windowless()
export const roleLabel = (r: Person['role']): string => (r === 'owner' ? L('Dono', 'Owner') : r === 'admin' ? 'Admin' : L('Membro', 'Member'))
// Who decides an agent's approvals: admins, the agent's person, and whoever covers for them now.
export const canDecide = (s: Pick<State, 'people' | 'you' | 'agents'>, a: Pick<Approval, 'agentId'>): boolean => {
  if (amAdmin(s)) return true
  const owner = personById(s, s.agents.find((x) => x.id === a.agentId)?.owner)
  return !!owner && (owner.id === s.you || delegating(owner, s.you))
}
// How many things wait on me (approvals I decide, questions, cards members sent).
export const inboxCount = (s: Pick<State, 'inbox'>): number => s.inbox.approvals.length + s.inbox.questions.length + (s.inbox.proposals?.length ?? 0)

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
  // optimistic, so typing stays instant; the owner's name given here (the introduction) is the name asked once
  set((s) => ({ ...withSettings(s, { ...s.settings, ...patch }), needsName: patch.workspaceName?.trim() ? false : s.needsName }))
  void fire(L('Não consegui salvar a configuração.', "I couldn't save the setting."), 'updateSettings', { patch })
}

export const refreshEngines = (): void => void fire(L('Não consegui conferir os modelos.', "I couldn't check the models."), 'refreshEngines')
export const voiceStatus = (): Promise<VoiceStatus> => call('voiceStatus')
export const voiceDownload = (model: VoiceModelId): Promise<void> => call('voiceDownload', { model })
export const voiceCancelDownload = (): Promise<void> => call('voiceCancelDownload')
export const voiceRemoveModel = (model: VoiceModelId): Promise<void> => call('voiceRemoveModel', { model })
export const transcribe = async (id: string, audio: string): Promise<string> => (await call('transcribe', { id, audio })).text
export const cancelTranscribe = (id: string): Promise<void> => call('cancelTranscribe', { id })
// On a server, the sign-in runs in its own terminal and shows here (LoginTerminal.tsx): screen comes
// back, and the window opens. Elsewhere, a terminal of the computer's opens, as before.
export const loginEngine = async (engine: keyof Settings['engines']): Promise<{ opened: boolean; command: string }> => {
  const r = await call('loginEngine', { engine, screen: true })
  if (r.screen) showLogin(r.screen)
  return r
}
// More logins of Claude Code and Codex, each signed into in a terminal.
export const addAccount = (engine: AccountEngine, name: string): Promise<Account> => call('addAccount', { engine, name })
export const loginAccount = async (id: string): Promise<{ opened: boolean; command: string }> => {
  const r = await call('loginAccount', { id, screen: true })
  if (r.screen) showLogin(r.screen)
  return r
}
// The sign-in on the server's terminal being shown, if any; the window asks the core how it goes.
let loginShown: LoginScreen | null = null
const loginListeners = new Set<() => void>()
export function showLogin(s: LoginScreen | null): void {
  loginShown = s
  loginListeners.forEach((l) => l())
}
export const useLoginShown = (): LoginScreen | null =>
  useSyncExternalStore(
    (l) => (loginListeners.add(l), () => void loginListeners.delete(l)),
    () => loginShown
  )
export const loginScreen = (): Promise<LoginScreen | null> => call('loginScreen')
export const loginInput = (id: string, input: { text?: string; key?: LoginKey; enter?: boolean }): Promise<LoginScreen | null> => call('loginInput', { id, ...input })
export const stopLogin = (id: string): void => void call('stopLogin', { id }).catch(() => {})
export const removeAccount = (id: string): Promise<void> => call('removeAccount', { id })
export const installEngine = (engine: keyof Settings['engines']): Promise<{ opened: boolean; command: string; needsNode?: boolean }> => call('installEngine', { engine })
// Codex or Claude Code with no terminal (the introduction): the CLI downloaded, then its own sign-in in the browser.
export const setupEngine = (engine: SetupEngine): Promise<SetupState> => call('setupEngine', { engine })
export const engineSetupState = (): Promise<SetupState | null> => call('engineSetupState')
export const cancelEngineSetup = (): void => void call('cancelEngineSetup').catch(() => {})
// The person's own apps, through agent-desktop.
export const desktopStatus = (): Promise<{ installed: boolean; version?: string; accessibility?: string; suggestion?: string; server?: boolean }> => call('desktopStatus')
export type InstalledApp = { name: string; bundleId?: string; path?: string; running?: boolean; icon?: string }
export const installedApps = (): Promise<InstalledApp[]> => call('installedApps')
export const openApps = (): Promise<{ name: string; bundleId?: string }[]> => call('openApps')
export const installDesktop = (): Promise<{ opened: boolean; command: string; needsNode?: boolean }> => call('installDesktop')
export const desktopPermissions = (): void => void fire(L('Não consegui abrir as permissões.', "I couldn't open the permissions."), 'desktopPermissions')

export const setAgentModels = (agentIds: string[], modelId: string): Promise<number> => call('setAgentModels', { agentIds, modelId })

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
export async function createChannel(name: string, threads?: boolean): Promise<void> {
  const id = await call('createChannel', { name, ...(threads ? { threads } : {}) })
  navigate({ kind: 'conversation', id })
  set((s) => ({ ...s, dialog: { kind: 'members', id } }))
}

// The Tuca and his DM, made if missing.
export const ensureTuca = (modelId?: string, fresh = false): Promise<{ agentId: string; conversationId: string }> => call('ensureTuca', { modelId, fresh })
// The agent a Tuca card proposed, created with a DM of its own.
export const createFromDraft = (messageId: string): Promise<{ agentId: string; conversationId: string }> => call('createFromDraft', { messageId })
// The builder screen, in place of the app; closing it comes back here.
export const openTuca = (): void => navigate({ kind: 'tuca', from: state.view?.kind === 'tuca' ? state.view.from : (state.view ?? undefined) })
// One card of a reply (index: which), or every one still open (draft: its new-agent card too).
export const applyProposal = (messageId: string, index = 0): Promise<{ id: string }> => call('applyProposal', { messageId, index })
export const dismissProposal = (messageId: string, index = 0): void => void call('dismissProposal', { messageId, index }).catch(() => {})
export const applyProposals = (messageId: string, draft: boolean): Promise<ProposalsResult> => call('applyProposals', { messageId, draft })
export const dismissProposals = (messageId: string, draft: boolean): void => void call('dismissProposals', { messageId, draft }).catch(() => {})
export const settleDraft = (messageId: string, agentId?: string): void => void fire(L('Não consegui salvar o cartão.', "I couldn't save the card."), 'settleDraft', { messageId, agentId })

export async function openDm(agentId: string): Promise<void> {
  const id = await call('openDm', { agentId })
  navigate({ kind: 'conversation', id })
}

// Asks an agent something from somewhere else (the organogram): it goes to its DM, and I stay where I am.
export async function askAgent(agentId: string, text: string): Promise<string> {
  const id = await call('openDm', { agentId })
  sendMessage(id, text)
  return id
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
export const ownApp = (provider: AppProvider): Promise<{ clientId?: string; redirectUrl: string }> => call('ownApp', { provider })
export const setOwnApp = (provider: AppProvider, clientId: string, clientSecret: string): Promise<void> => call('setOwnApp', { provider, clientId, clientSecret })
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
// Where a conversation's answers go: each in the thread of what it answers, or in the conversation.
export const setThreads = (conversationId: string, on: boolean): Promise<void> => call('setThreads', { conversationId, on })
export const setChannelMembers = (id: string, agentIds: string[]): Promise<void> => call('setChannelMembers', { id, agentIds })
export const deleteConversation = (id: string): Promise<void> => call('deleteConversation', { id })
export const markRead = (id: string): void => { void call('markRead', { conversationId: id }) }

// A message sent outside threads, in a conversation that answers in them: its thread opens when it
// comes back from the core (a while at most, so one that never does doesn't open a later one).
let openNext: { conversationId: string; until: number } | null = null
// `threadId`: a reply in the thread that message started.
export const sendMessage = (conversationId: string, text: string, images: ImageUpload[] = [], threadId?: string, files: FileUpload[] = []): void => {
  if (!(text.trim() || images.length || files.length)) return
  const threads = !threadId && state.conversations.find((c) => c.id === conversationId)?.threads
  openNext = threads ? { conversationId, until: Date.now() + 15_000 } : null
  void fire(L('Não consegui enviar a mensagem.', "I couldn't send the message."), 'sendMessage', { conversationId, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(threadId ? { threadId } : {}) })
}

export const answerDecision = (messageId: string, index: number, answer: Answer | null): void =>
  void fire(L('Não consegui guardar a resposta.', "I couldn't save the answer."), 'answerDecision', { messageId, index, answer })
export const submitDecisions = (messageId: string): Promise<void> => fire(L('Não consegui enviar as respostas.', "I couldn't send the answers."), 'submitDecisions', { messageId })

// The person is writing: the core gets what will answer ready. Once in a while per place, and
// nobody needs to hear if it didn't work. `opened`: they only opened it (the agent's kept session
// starts again, while they read; the router waits for them to type).
const typed = new Map<string, number>()
export const typing = (conversationId: string, threadId?: string, opened = false): void => {
  const where = `${conversationId}:${threadId ?? ''}:${opened ? 'o' : 't'}`
  if (Date.now() - (typed.get(where) ?? 0) < 20_000) return
  typed.set(where, Date.now())
  void call('typing', { conversationId, ...(threadId ? { threadId } : {}), ...(opened ? { opened } : {}) }).catch(() => {})
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
// A page an agent serves on the server's loopback, from here. Behind https it has an address of its
// own, reached through this server (src/server/preview.ts); on a private address, the same port there.
export const reachable = (url: string): string => {
  if (!windowless()) return url
  const m = /^http:\/\/127\.0\.0\.1:(\d+)(.*)$/.exec(url)
  if (!m) return url
  return location.protocol === 'https:' ? `${location.origin}/preview/${m[1]}${m[2] || '/'}` : `http://${location.hostname}:${m[1]}${m[2]}`
}
export const browserInput = (agentId: string, input: BrowserInput): void => void call('browserInput', { agentId, input }).catch(() => {})
// In a browser (Tucano as a server) the page opens it itself: the server has no screen.
export const openExternal = (url: string): void =>
  (window as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__ ? void window.open(url, '_blank', 'noopener') : void fire(L('Não consegui abrir o link.', "I couldn't open the link."), 'openExternal', { url })

export const saveRoutine = (routine: RoutineInput): Promise<Routine> => call('saveRoutine', { routine })
export const setJevKey = (key: string | null): Promise<void> => call('setJevKey', { key })
export const engineModels = (engine: EngineId): Promise<{ models: string[]; labels?: Record<string, { label: string; hint?: string }>; error?: string }> => call('engineModels', { engine })
export const testEngine = (model: string): Promise<{ ok: boolean; message: string; seconds?: number }> => call('testEngine', { model })
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
export const exportTeam = (): Promise<string> => call('exportTeam')
export const importTeam = (text: string): Promise<string> => call('importTeam', { text })
export const exportBackup = (): Promise<{ path: string } & BackupSummary> => call('exportBackup')
export const restoreCheck = (path: string): Promise<BackupSummary> => call('restoreCheck', { path })
export const restoreApply = (): Promise<void> => call('restoreApply')
export const restoreCancel = (): Promise<void> => call('restoreCancel')
export const restoreInfo = (): Promise<{ at: number; routines: number } | null> => call('restoreInfo')
export const importAgents = (p: { path?: string; data?: string }): Promise<string> => call('importAgents', p)
export const backupNow = (): Promise<string> => call('backupNow')
export const openBackups = (): void => void fire(L('Não consegui abrir a pasta de backups.', "I couldn't open the backups folder."), 'openBackups')
export const loadReport = (week?: number): Promise<Report> => call('report', { week })
export const loadUsage = (): Promise<UsageReport> => call('usage')
export const removeRoutine = (id: string): void => void fire(L('Não consegui remover a rotina.', "I couldn't remove the routine."), 'removeRoutine', { id })
// People: who I am, who comes in (admins), who covers for me.
export const setMyName = (name: string, about?: string): Promise<void> => call('setMyName', { name, ...(about !== undefined ? { about } : {}) })
export const doneNaming = (): void => set((s) => ({ ...s, needsName: false }))
export const setDelegation = (to: string | null, until?: number): Promise<void> => call('setDelegation', { to, ...(until ? { until } : {}) })
export const createInvite = (role: 'admin' | 'member', about: string, restore?: string): Promise<{ code: string; expiresAt: number }> => call('createInvite', { role, about, ...(restore ? { restore } : {}) })
export const revokeInvite = (id: string): Promise<void> => call('revokeInvite', { id })
export const listInvites = (): Promise<Invite[]> => call('listInvites')
export const removedPeople = (): Promise<(Person & { removedAt: number })[]> => call('removedPeople')
export const removePerson = (id: string): Promise<void> => call('removePerson', { id })
export const myDevices = (): Promise<Device[]> => call('myDevices')
export const removeDevice = (id: string): Promise<void> => call('removeDevice', { id })
export const setRole = (id: string, role: 'admin' | 'member'): Promise<void> => call('setRole', { id, role })
export const purgePerson = (id: string): Promise<void> => call('purgePerson', { id })
export const loadActivity = (f: { personId?: string; kind?: string; before?: number }): Promise<ActivityEntry[]> => call('activity', f)
export const answerQuestion = (id: string, text: string): Promise<void> => call('answerQuestion', { id, text })
export const confirmQuestion = (id: string, ok: boolean): void => void fire(L('Não consegui responder.', "I couldn't answer."), 'confirmQuestion', { id, ok })
export const watchRoutine = (id: string, on: boolean): void => void fire(L('Não consegui mudar o aviso.', "I couldn't change the notice."), 'watchRoutine', { id, on })
// The link an invite's code makes: this page's address (a server's) with ?invite=.
export const inviteLink = (code: string): string => `${window.location.origin}/?invite=${encodeURIComponent(code)}`
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
