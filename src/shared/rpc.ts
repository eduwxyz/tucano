// The contract between the renderer and the core, carried over a MessagePort.
import type { WikiChange, WikiHit, WikiPage, WikiImport, WikiPageInfo, WikiReview, WikiSource, WikiVersion } from './types'
import type { AppProvider } from './connector-catalog'
import type { Os, Account, AccountEngine, Agent, BrowserInput, Approval, Artifact, ImageUpload, BrowserView, ComputerInfo, Connector, ConnectorInput, ConnectorTool, HarnessMcp, Conversation, EngineId, Memory, MemoryScope, Message, Routine, RoutineInput, Report, Settings, LocalSkill, Skill, SkillInput, SkillVersion, Trigger, UsageReport, LocalInfo, VoiceModelId, VoiceStatus } from './types'

export interface Snapshot {
  webhookPort?: number
  defaultWorkspace?: boolean
  settings: Settings
  agents: Agent[]
  conversations: Conversation[]
  messages: Message[]
  connectors: Connector[]
  approvals: Approval[]
  memories: Memory[]
  artifacts: Artifact[]
  computers: ComputerInfo[]
  browsers: BrowserView[]
  routines: Routine[]
  skills: Skill[]
  platform: Os
  packaged: boolean // installed app, not `npm run dev` (opening at login only works there)
  isolatedComputers: boolean // agents can have an isolated Linux computer: Docker is there (not inside a server's container)
  demoServer?: { command: string; args: string[] } // the bundled demo connector, when available
}

export interface Api {
  markRead(p: { conversationId: string }): void
  snapshot(): Snapshot
  artifactText(p: { id: string }): string | null // a text file an agent showed (Markdown, CSV, code), for the side panel
  sendMessage(p: { conversationId: string; text: string; images?: ImageUpload[]; threadId?: string }): void // threadId: a reply in the thread that message started
  typing(p: { conversationId: string; threadId?: string }): void // the person is writing there: what will answer gets ready
  stopRun(p: { messageId: string }): void
  retryRun(p: { messageId: string }): void
  continueRun(p: { messageId: string }): void // a reply paused at its budget goes on
  saveAgent(p: { agent: Agent; channelIds: string[] }): void
  createChannel(p: { name: string; threads?: boolean }): string
  renameChannel(p: { id: string; name: string }): void // throws a message when the name is taken
  archiveAgent(p: { id: string; archived: boolean }): void // out of the sidebar, its replies stopped and routines off; back with archived: false
  setTopic(p: { id: string; topic: string }): void
  setChannelMembers(p: { id: string; agentIds: string[] }): void
  deleteConversation(p: { id: string }): void // a channel or a DM, with its messages and routines
  openDm(p: { agentId: string }): string
  ensureTuca(p: { modelId?: string; fresh?: boolean }): { agentId: string; conversationId: string } // the agent behind the builder screen, with his conversation; fresh starts a new session
  createFromDraft(p: { messageId: string }): { agentId: string; conversationId: string } // the agent a Tuca card proposed
  applyProposal(p: { messageId: string }): { id: string } // what a Tuca card proposed changing: the agent, routine or channel it touched
  dismissProposal(p: { messageId: string }): void
  settleDraft(p: { messageId: string; agentId?: string }): void // the card is done: created elsewhere (the introduction), or dismissed
  updateSettings(p: { patch: Partial<Omit<Settings, 'engines'>> }): void
  refreshEngines(): void
  voiceStatus(): Promise<VoiceStatus>
  transcribe(p: { id: string; audio: string }): Promise<{ text: string }> // a WAV in base64; turned into text on this machine
  cancelTranscribe(p: { id: string }): void
  voiceDownload(p: { model: VoiceModelId }): void // in the background; 'voice' events say how it goes
  voiceCancelDownload(): void
  voiceRemoveModel(p: { model: VoiceModelId }): void
  localPath(p: { messageId: string; path: string }): LocalInfo | null // what a path this agent cited can do; null: it stays text
  openLocal(p: { messageId: string; path: string; how: 'open' | 'reveal' }): void
  loginEngine(p: { engine: EngineId }): { opened: boolean; command: string } // not opened: no terminal to open, the person runs the command
  addAccount(p: { engine: AccountEngine; name: string }): Account
  loginAccount(p: { id: string }): { opened: boolean; command: string }
  removeAccount(p: { id: string }): void
  installEngine(p: { engine: EngineId }): { opened: boolean; command: string; needsNode?: boolean } // needsNode: an npm install with no npm here
  desktopStatus(): Promise<{ installed: boolean; version?: string; accessibility?: string; suggestion?: string; server?: boolean }> // agent-desktop, for the person's apps
  installedApps(): Promise<{ name: string; bundleId?: string; path?: string; icon?: string }[]> // the person's installed apps (a Mac's), kept on disk
  openApps(): Promise<{ name: string; bundleId?: string }[]> // the apps with windows right now
  installDesktop(): { opened: boolean; command: string; needsNode?: boolean }
  desktopPermissions(): void
  addConnector(p: { input: ConnectorInput }): Promise<string>
  removeConnector(p: { id: string }): void
  reconnectConnector(p: { id: string }): void
  setConnectorToken(p: { id: string; token: string }): Promise<void>
  ownApp(p: { provider: AppProvider }): Promise<{ clientId?: string; redirectUrl: string }> // the person's app (Google's, Slack's) its connectors sign in with; its secret stays in the core
  setOwnApp(p: { provider: AppProvider; clientId: string; clientSecret: string }): Promise<void>
  authorizeConnector(p: { id: string }): Promise<{ url?: string }> // url: on a server, the page to open in the person's browser
  finishConnectorAuth(p: { url: string }): Promise<boolean> // on a server: the address the authorization page ended on
  harnessMcps(): Promise<HarnessMcp[]> // the MCP servers set up in Claude Code, Codex and OpenCode
  importHarnessMcp(p: { key: string }): Promise<string> // adds one as a connector; its secrets never pass through the screen
  updateTool(p: { connectorId: string; name: string; patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>> }): void
  decideApproval(p: { id: string; decision: 'approved' | 'refused'; reason?: string; always?: boolean }): void // always: the agent may use that tool without asking again
  addMemory(p: { scope: MemoryScope; text: string }): void
  editMemory(p: { id: string; text: string }): void
  confirmMemory(p: { id: string }): void // "still valid"
  decideMemory(p: { id: string; accept: boolean }): void // a pending one
  forgetMemory(p: { id: string; reason?: string }): void
  purgeMemory(p: { id: string }): void // removes even the record that it was forgotten
  editSummary(p: { conversationId: string; text: string }): void
  summarizeNow(p: { conversationId: string }): void
  editThreadSummary(p: { rootId: string; text: string }): void
  summarizeThreadNow(p: { rootId: string }): void
  computerAction(p: { agentId: string; action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh' }): void
  stopService(p: { agentId: string; name: string }): void
  browserAction(p: { agentId: string; action: 'show' | 'hide' | 'clear' }): void
  browserInput(p: { agentId: string; input: BrowserInput }): Promise<void> // a server's taken-over browser, driven from the panel // show: I take over the agent's browser; clear: logins and history go
  lendFolder(p: { agentId: string; path: string }): void // throws why it can't, for the page
  folderAction(p: { agentId: string; name: string; action: 'read_only' | 'read_write' | 'return' }): void
  openExternal(p: { url: string }): void
  saveRoutine(p: { routine: RoutineInput }): Routine // throws a message for the form
  setJevKey(p: { key: string | null }): Promise<void> // checks the key with TypeSafe; throws why it's refused
  engineModels(p: { engine: EngineId }): Promise<{ models: string[]; labels?: Record<string, { label: string; hint?: string }>; error?: string }> // a harness's own list (OpenCode, Pi, a gateway)
  testEngine(p: { model: string }): Promise<{ ok: boolean; message: string }> // one real reply through that model
  saveSkill(p: { skill: SkillInput }): Skill // throws a message for the form
  localSkills(): LocalSkill[] // the skills of the user's Claude Code, its plugins and Codex
  linkSkill(p: { source: string; agents: string[] }): Skill
  decideSkill(p: { id: string; approve: boolean }): void
  restoreSkill(p: { skillId: string; versionId: number }): void
  archiveSkill(p: { id: string; archived: boolean }): void
  removeSkill(p: { id: string }): void
  skillVersions(p: { skillId: string }): SkillVersion[]
  checkTrigger(p: { trigger: Trigger }): Promise<string> // what a connector check finds now, for the form
  setTelegramToken(p: { token: string | null }): Promise<void> // checks it with Telegram; throws why it's refused
  unpairTelegram(): void
  exportTeam(): string // the team as Markdown
  importTeam(p: { text: string }): string // what was added; throws if it isn't a team file
  importAgents(p: { path?: string; data?: string }): string // agents from another app's .zip (a path on this computer, or base64); what was added
  backupNow(): string // where the copy went
  openBackups(): void
  report(p: { week?: number }): Report // the calendar week starting at `week` (a Monday); this one by default
  usage(): UsageReport
  removeRoutine(p: { id: string }): void
  runRoutine(p: { id: string }): void
  // The wiki: pages in a folder of Markdown, linked, searched and kept with their history.
  wiki(): { dir: string; pages: WikiPageInfo[]; kinds: string[]; log: string[]; pending: number; findings: number; server: boolean; graph: { nodes: { title: string; kind: string; links: number; missing?: boolean }[]; edges: [string, string][] }; recent: Omit<WikiVersion, 'before' | 'after'>[]; sources: number } // pending: the curator's changes; the review's are in findings
  wikiPage(p: { title: string }): WikiPage | null
  wikiSearch(p: { q: string }): WikiHit[]
  wikiSave(p: { title: string; body: string; kind?: string; expectedHash?: string; rename?: string }): WikiPage // throws on a conflict or a taken title
  wikiRemove(p: { title: string }): void
  wikiHistory(p: { title: string }): WikiVersion[]
  wikiRestore(p: { id: number }): WikiPage
  wikiSchema(): string
  wikiSaveSchema(p: { text: string }): void
  openWikiFolder(): void
  wikiChanges(p: { state?: WikiChange['state'] }): WikiChange[]
  wikiChange(p: { id: string }): WikiChange | null
  wikiApplyChange(p: { id: string }): WikiChange // a pending one; a conflict comes back as such
  wikiRefuseChange(p: { id: string }): void
  wikiUndoChange(p: { id: string }): void
  wikiSources(): WikiSource[]
  wikiSource(p: { id: string }): (WikiSource & { text: string }) | null
  wikiKeepMessage(p: { messageId: string }): Promise<number> // how many changes it made; throws when no model is ready
  wikiRedoChange(p: { id: string }): Promise<number> // a conflict, made again on the newer page
  // Sources brought on purpose: the text is taken now, the curator reads it next (status on the source).
  wikiAddFile(p: { name: string; data: string }): Promise<WikiSource> // data: base64
  wikiAddLink(p: { url: string }): Promise<WikiSource>
  wikiAddNote(p: { text: string; title?: string }): WikiSource
  wikiOpenOriginal(p: { id: string }): { name: string; data: string } | null // on a server: the file itself (base64), to download
  wikiIngestAgain(p: { id: string }): void
  wikiReview(): WikiReview // the last review and what it found that's still open
  wikiRunReview(): void // reviews now, in the background; a 'wiki' event when done
  wikiDismissFinding(p: { id: string }): void // and refuses its fix
  wikiImport(p: { dir: string }): WikiImport // an Obsidian vault copied in, as it is
  wikiImportZip(p: { path: string }): WikiImport // the same, from a .zip sent to a server (src/server's /upload)
  setWikiCapture(p: { conversationId: string; on: boolean }): void
  setThreads(p: { conversationId: string; on: boolean }): void
  setWikiDir(p: { dir: string | null }): Promise<string> // null: back to the app's own folder; returns where it is now
}

export type Method = keyof Api
export type Params<M extends Method> = Parameters<Api[M]>[0]
export type Result<M extends Method> = Awaited<ReturnType<Api[M]>>

export type CoreEvent =
  | { type: 'voice' } // dictation's model: downloading, done, removed
  | { type: 'message'; message: Message }
  | { type: 'delta'; id: string; text: string } // appended to message text while streaming
  | { type: 'agent'; agent: Agent }
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'settings'; settings: Settings }
  | { type: 'connector'; connector: Connector }
  | { type: 'connector_removed'; id: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'memory'; memory: Memory }
  | { type: 'memory_removed'; id: string }
  | { type: 'computer'; computer: ComputerInfo }
  | { type: 'browser'; view: BrowserView }
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine_removed'; id: string }
  | { type: 'conversation_removed'; id: string }
  | { type: 'skill'; skill: Skill }
  | { type: 'skill_removed'; id: string }
  | { type: 'wiki' } // a page changed: here, by an agent or in another app

export type Request = { id: number; method: Method; params: unknown }
export type Response = { id: number; result?: unknown; error?: string }
export type Wire = Response | { event: CoreEvent }
