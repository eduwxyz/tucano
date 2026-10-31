// The contract between the renderer and the core, carried over a MessagePort.
import type { Os, Agent, BrowserInput, Approval, Artifact, ImageUpload, BrowserView, ComputerInfo, Connector, ConnectorInput, ConnectorTool, HarnessMcp, Conversation, EngineId, Memory, MemoryScope, Message, Routine, RoutineInput, Report, Settings, LocalSkill, Skill, SkillInput, SkillVersion, Trigger, UsageReport } from './types'

export interface Snapshot {
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
  demoServer?: { command: string; args: string[] } // the bundled demo connector, when available
}

export interface Api {
  snapshot(): Snapshot
  artifactText(p: { id: string }): string | null // a text file an agent showed (Markdown, CSV, code), for the side panel
  sendMessage(p: { conversationId: string; text: string; images?: ImageUpload[] }): void
  stopRun(p: { messageId: string }): void
  retryRun(p: { messageId: string }): void
  continueRun(p: { messageId: string }): void // a reply paused at its budget goes on
  saveAgent(p: { agent: Agent; channelIds: string[] }): void
  createChannel(p: { name: string }): string
  renameChannel(p: { id: string; name: string }): void // throws a message when the name is taken
  archiveAgent(p: { id: string; archived: boolean }): void // out of the sidebar, its replies stopped and routines off; back with archived: false
  setTopic(p: { id: string; topic: string }): void
  setChannelMembers(p: { id: string; agentIds: string[] }): void
  deleteConversation(p: { id: string }): void // a channel or a DM, with its messages and routines
  openDm(p: { agentId: string }): string
  ensureTuca(p: { modelId?: string; fresh?: boolean }): { agentId: string; conversationId: string } // the agent behind the builder screen, with his conversation; fresh starts a new session
  createFromDraft(p: { messageId: string }): { agentId: string; conversationId: string } // the agent a Tuca card proposed
  settleDraft(p: { messageId: string; agentId?: string }): void // the card is done: created elsewhere (the introduction), or dismissed
  updateSettings(p: { patch: Partial<Omit<Settings, 'engines'>> }): void
  refreshEngines(): void
  loginEngine(p: { engine: EngineId }): { opened: boolean; command: string } // not opened: no terminal to open, the person runs the command
  installEngine(p: { engine: EngineId }): { opened: boolean; command: string; needsNode?: boolean } // needsNode: an npm install with no npm here
  addConnector(p: { input: ConnectorInput }): Promise<string>
  removeConnector(p: { id: string }): void
  reconnectConnector(p: { id: string }): void
  authorizeConnector(p: { id: string }): Promise<{ url?: string }> // url: on a server, the page to open in the person's browser
  finishConnectorAuth(p: { url: string }): Promise<boolean> // on a server: the address the authorization page ended on
  harnessMcps(): Promise<HarnessMcp[]> // the MCP servers set up in Claude Code, Codex, OpenCode and Hermes
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
  computerAction(p: { agentId: string; action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh' }): void
  stopService(p: { agentId: string; name: string }): void
  browserAction(p: { agentId: string; action: 'show' | 'hide' | 'clear' }): void
  browserInput(p: { agentId: string; input: BrowserInput }): Promise<void> // a server's taken-over browser, driven from the panel // show: I take over the agent's browser; clear: logins and history go
  lendFolder(p: { agentId: string; path: string }): void // throws why it can't, for the page
  folderAction(p: { agentId: string; name: string; action: 'read_only' | 'read_write' | 'return' }): void
  openExternal(p: { url: string }): void
  saveRoutine(p: { routine: RoutineInput }): Routine // throws a message for the form
  setJevKey(p: { key: string | null }): Promise<void> // checks the key with TypeSafe; throws why it's refused
  engineModels(p: { engine: EngineId }): Promise<{ models: string[]; error?: string }> // a harness's own list (OpenCode, Pi, Hermes, a gateway)
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
  backupNow(): string // where the copy went
  openBackups(): void
  report(p: { week?: number }): Report // the calendar week starting at `week` (a Monday); this one by default
  usage(): UsageReport
  setGithubToken(p: { token: string | null }): Promise<void> // checked with GitHub; throws why it's refused
  removeRoutine(p: { id: string }): void
  runRoutine(p: { id: string }): void
}

export type Method = keyof Api
export type Params<M extends Method> = Parameters<Api[M]>[0]
export type Result<M extends Method> = Awaited<ReturnType<Api[M]>>

export type CoreEvent =
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

export type Request = { id: number; method: Method; params: unknown }
export type Response = { id: number; result?: unknown; error?: string }
export type Wire = Response | { event: CoreEvent }
