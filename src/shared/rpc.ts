// The contract between the renderer and the core, carried over a MessagePort.
import type { Answer } from './questions'
import type { BackupSummary, WikiChange, WikiGitSetup, WikiGitStatus, WikiGitTest, WikiHit, WikiPage, WikiImport, WikiPageInfo, WikiReview, WikiSource, WikiVersion } from './types'
import type { AppProvider, CatalogCategory, CatalogView, OwnAppGuide } from './connector-catalog'
import type { Commitment, CommitmentInput, InitiativeConfig, InitiativeInput, InitiativeView } from './initiative'
import type { Os, Account, AccountEngine, ActivityEntry, Delegation, Device, Inbox, Agent, BrowserInput, Approval, Artifact, ImageUpload, FileUpload, BrowserView, ComputerInfo, Connector, ConnectorInput, ConnectorTool, HarnessMcp, Conversation, EngineId, Invite, Memory, Person, Role, MemoryScope, Message, Routine, RoutineInput, Report, Settings, SetupState, LoginKey, LoginScreen, LocalSkill, Skill, SkillInput, SkillVersion, Trigger, UsageReport, LocalInfo, VoiceModelId, VoiceStatus, ProposalsResult } from './types'

export interface Snapshot {
  webhookPort?: number
  defaultWorkspace?: boolean
  settings: Settings
  agents: Agent[]
  conversations: Conversation[]
  messages: Message[] // each conversation's latest, with their threads; older ones come with olderMessages
  since?: Record<string, number> // per conversation with older messages left: from when `messages` has it whole
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
  people: Person[] // everyone with access now (no keys)
  former?: Pick<Person, 'id' | 'name'>[] // those who left: their names, for what they wrote before
  you: string // the person this connection is
  needsName?: boolean // a server's first access: the owner hasn't said their name yet (setMyName)
  inbox: Inbox // what waits on this person: approvals they can decide, questions to them
  delegations?: Delegation[] // work handed down the tree (src/shared/org.ts) that is open, or ended in the last day, in channels this person sees
}

export interface Api {
  markRead(p: { conversationId: string }): void
  snapshot(): Snapshot
  olderMessages(p: { conversationId: string; before: number; through?: string }): { messages: Message[]; since: number } // a page from before `before` (or back to `through`, a message to show), with their threads; since: from when it's whole now, 0 once all of it is
  threadMessages(p: { rootId: string }): Message[] // a thread whole: the message that started it and its replies
  artifactText(p: { id: string }): string | null // a text file an agent showed (Markdown, CSV, code), for the side panel
  sendMessage(p: { conversationId: string; text: string; images?: ImageUpload[]; files?: FileUpload[]; threadId?: string }): void // threadId: a reply in the thread that message started
  typing(p: { conversationId: string; threadId?: string; opened?: boolean }): void // the person is writing there (or just opened it): what will answer gets ready
  stopRun(p: { messageId: string }): void
  retryRun(p: { messageId: string }): void
  continueRun(p: { messageId: string }): void // a reply paused at its budget goes on
  setAgentModels(p: { agentIds: string[]; modelId: string }): number
  saveAgent(p: { agent: Agent; channelIds: string[] }): void
  createChannel(p: { name: string; threads?: boolean }): string
  renameChannel(p: { id: string; name: string }): void // throws a message when the name is taken
  archiveAgent(p: { id: string; archived: boolean }): void // out of the sidebar, its replies stopped and routines off; back with archived: false
  setTopic(p: { id: string; topic: string }): void
  setChannelMembers(p: { id: string; agentIds: string[] }): void
  deleteConversation(p: { id: string }): void // a channel or a DM, with its messages and routines
  openDm(p: { agentId: string }): string
  ensureTuca(p: { modelId?: string; fresh?: boolean }): { agentId: string; conversationId: string } // the agent behind the builder screen, with this person's conversation with him, as it was; fresh starts a new one ("Nova conversa")
  createFromDraft(p: { messageId: string }): { agentId: string; conversationId: string } // the agent a Tuca card proposed
  applyProposal(p: { messageId: string; index?: number }): { id: string } // what a Tuca card proposed changing: the agent, routine or channel it touched; index: which of the reply's cards (unset: the first)
  dismissProposal(p: { messageId: string; index?: number }): void
  applyProposals(p: { messageId: string; draft?: boolean }): ProposalsResult // every card of the reply still open, in an order that makes agents first; one failing doesn't stop the rest. draft: its new-agent card too
  dismissProposals(p: { messageId: string; draft?: boolean }): void
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
  // not opened: no terminal to open, the person runs the command. screen: the caller can show the
  // server's own terminal (a page or a phone on Tucano as a server); then the sign-in runs there, and comes back
  loginEngine(p: { engine: EngineId; screen?: boolean }): { opened: boolean; command: string; screen?: LoginScreen }
  loginScreen(): LoginScreen | null
  loginInput(p: { id: string; text?: string; key?: LoginKey; enter?: boolean }): Promise<LoginScreen | null>
  stopLogin(p: { id: string }): void
  addAccount(p: { engine: AccountEngine; name: string }): Account
  loginAccount(p: { id: string; screen?: boolean }): { opened: boolean; command: string; screen?: LoginScreen }
  removeAccount(p: { id: string }): void
  installEngine(p: { engine: EngineId }): { opened: boolean; command: string; needsNode?: boolean } // needsNode: an npm install with no npm here
  setupEngine(p: { engine: EngineId }): SetupState // Codex or Claude Code with no terminal: downloaded, then the CLI's own sign-in in the browser
  engineSetupState(): SetupState | null
  cancelEngineSetup(): void
  desktopStatus(): Promise<{ installed: boolean; version?: string; accessibility?: string; suggestion?: string; server?: boolean }> // agent-desktop, for the person's apps
  installedApps(): Promise<{ name: string; bundleId?: string; path?: string; icon?: string }[]> // the person's installed apps (a Mac's), kept on disk
  openApps(): Promise<{ name: string; bundleId?: string }[]> // the apps with windows right now
  installDesktop(): { opened: boolean; command: string; needsNode?: boolean }
  desktopPermissions(): void
  addConnector(p: { input: ConnectorInput }): Promise<string>
  removeConnector(p: { id: string }): void
  reconnectConnector(p: { id: string }): void
  setConnectorToken(p: { id: string; token: string }): Promise<void>
  connectorCatalog(): { categories: { id: CatalogCategory; name: string }[]; entries: CatalogView[]; added: string[] } // the store, as data (the phone); added: the entries already connected
  addCatalogConnector(p: { id: string; values?: Record<string, string> }): Promise<string> // a store entry, with what it asks, filled in by the core
  ownAppGuide(p: { provider: AppProvider }): Promise<{ guide: OwnAppGuide; clientId?: string }> // the steps to make one's own Google or Slack app (the phone)
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
  testEngine(p: { model: string }): Promise<{ ok: boolean; message: string; seconds?: number }> // one real reply through that model
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
  // Everything in one .zip, to take this Tucano to a server (desktop): where it went, and what's in it.
  exportBackup(): { path: string } & BackupSummary
  // On a server, the owner: a backup sent up (/upload) checked and set apart; nothing changes yet.
  restoreCheck(p: { path: string }): BackupSummary
  restoreApply(): void // the checked backup replaces everything: the server restarts with it
  restoreCancel(): void
  restoreInfo(): { at: number; routines: number } | null // the last restore, for what to redo after it
  openBackups(): void
  report(p: { week?: number }): Report // the calendar week starting at `week` (a Monday); this one by default
  usage(): UsageReport
  removeRoutine(p: { id: string }): void
  runRoutine(p: { id: string }): void
  // The wiki: pages in a folder of Markdown, linked, searched and kept with their history.
  wiki(): { dir: string; pages: WikiPageInfo[]; kinds: string[]; log: string[]; pending: number; findings: number; server: boolean; graph: { nodes: { title: string; kind: string; links: number; missing?: boolean }[]; edges: [string, string][] }; recent: Omit<WikiVersion, 'before' | 'after'>[]; sources: number; held?: { title: string; at: number }[]; heritage?: { at: number }; git?: { readOnly: boolean; state: WikiGitStatus['state']; lastSync?: number } } // pending: the curator's changes; the review's are in findings
  wikiPage(p: { title: string }): WikiPage | null
  wikiSearch(p: { q: string }): WikiHit[]
  wikiSave(p: { title: string; body: string; kind?: string; expectedHash?: string; rename?: string }): WikiPage // throws on a conflict or a taken title
  wikiRemove(p: { title: string }): void
  wikiHistory(p: { title: string }): WikiVersion[]
  wikiRelease(p: { title: string }): void // "Liberar pro time": a page held for me since the Tucano got its second person
  heritageSeen(): void // the owner read the notice about what changed when the Tucano got its second person
  wikiRestore(p: { id: number }): WikiPage
  wikiSchema(): string
  wikiSaveSchema(p: { text: string }): void
  openWikiFolder(): void
  wikiChanges(p: { state?: WikiChange['state'] }): WikiChange[]
  wikiChange(p: { id: string }): WikiChange | null
  wikiApplyChange(p: { id: string }): WikiChange // a pending one; a conflict comes back as such
  wikiRefuseChange(p: { id: string }): void
  wikiApplyWaiting(): { applied: number; left: number } // all that waits, at once
  wikiUndoChange(p: { id: string }): void
  wikiSources(): WikiSource[]
  wikiSource(p: { id: string }): (WikiSource & { text: string }) | null
  wikiRemoveSource(p: { id: string }): void // admins: a source gone for good (its text and file; the pages stay)
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
  // The wiki's folder kept in a git repository (owner and admins): a deploy key, a test, then the folder becomes the clone.
  wikiGitStatus(): WikiGitStatus
  wikiGitSetup(p: { url: string }): Promise<WikiGitSetup> // an SSH address (an https one is turned into it); makes the key once
  wikiGitTest(): Promise<WikiGitTest> // ls-remote with the key, then a clone apart; the wiki doesn't change yet
  wikiGitConnect(p: { how: 'repo' | 'merge' }): Promise<WikiGitStatus> // repo: the wiki becomes the clone, the old folder stays as it was; merge: the pages there are copied in too
  wikiGitSync(p: { write?: boolean }): Promise<WikiGitStatus> // now; write: try pushing again after read-only
  wikiGitDisconnect(): Promise<WikiGitStatus> // stops syncing and drops the key; the folder stays as it is
  // People: who I am, and (admins) who comes in. The link is the page's origin with ?invite=<code>.
  setMyName(p: { name: string; about?: string }): void // about: what I do, for the agents
  setDelegation(p: { to: string | null; until?: number }): void // someone answers and approves for me until then; null ends it
  createInvite(p: { role: Exclude<Role, 'owner'>; about?: string; restore?: string }): { code: string; expiresAt: number }
  revokeInvite(p: { id: string }): void
  listInvites(): Invite[]
  removedPeople(): (Person & { removedAt: number })[] // admins: who left in the last 30 days (still restorable)
  myDevices(): Device[] // my own keys: the browsers and phones signed in as me
  setPush(p: { handle: string | null; tag?: string }): { on: boolean } // this phone's push handle (the relay's), or none; on: this Tucano sends pushes
  removeDevice(p: { id: string }): void // one of mine signs out now (Device.id)
  removePerson(p: { id: string }): void // their access ends at once: keys gone, open connections closed; what they owned goes to the owner
  setRole(p: { id: string; role: Exclude<Role, 'owner'> }): void
  purgePerson(p: { id: string }): void // the owner, before the 30 days: a removed person's DMs and memories go now
  leave(): void // someone (not the owner) leaves on their own: access ends, and their DMs, memories and own routines go now
  activity(p: { personId?: string; kind?: string; before?: number }): ActivityEntry[] // admins: newest first, a page at a time (before: the last page's oldest `at`)
  inbox(): Inbox
  answerQuestion(p: { id: string; text: string }): void // a question an agent asked me (or someone I cover for)
  confirmQuestion(p: { id: string; ok: boolean }): void // in my DM: may the agent ask that person?
  answerDecision(p: { messageId: string; index: number; answer: Answer | null }): void // one of a question's decisions answered on the card (null clears it), kept until sent
  submitDecisions(p: { messageId: string }): void // sends the decisions answered on the card, as my message
  watchRoutine(p: { id: string; on: boolean }): void // "me avise": told of a channel routine's runs
  initiative(): InitiativeView // my own proactive coordinator and its responsibilities, and no one else's
  saveInitiative(p: { config: InitiativeInput; expectedRevision: number }): InitiativeConfig // expectedRevision: what the page read; 0 creates
  saveCommitment(p: { commitment: CommitmentInput }): Commitment // one responsibility: its provenance, scope and links
  checkInNow(): { started: boolean; why?: string; running: boolean } // "Conferir agora": my coordinator looking on the spot
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
  | { type: 'memory_removed'; id: string; for?: string } // for: whose it was, when it was someone's own (no one else hears of it)
  | { type: 'computer'; computer: ComputerInfo }
  | { type: 'browser'; view: BrowserView }
  | { type: 'browser_frame'; agentId: string; frame: string; conversationId?: string } // the browser's screen as it changes, without the rest of its view (conversationId: whom it works for, who may see it)
  | { type: 'artifact'; artifact: Artifact }
  | { type: 'routine'; routine: Routine }
  | { type: 'routine_removed'; id: string; for?: string } // for: a DM's person, the only one who saw it
  | { type: 'conversation_removed'; id: string; for?: string }
  | { type: 'skill'; skill: Skill }
  | { type: 'skill_removed'; id: string }
  | { type: 'wiki' } // a page changed: here, by an agent or in another app
  | { type: 'people'; people: Person[]; former?: Pick<Person, 'id' | 'name'>[] } // someone joined, left or changed their name
  | { type: 'inbox'; inbox?: Inbox } // what waits on this person changed (each gets their own)
  | { type: 'delegations'; delegations?: Delegation[] } // work handed down the tree changed (each gets what they may see)

// Every kind of event, so a test can go through them all (people.ts's eventFor decides each one's audience).
export const CORE_EVENT_TYPES = ['voice', 'message', 'delta', 'agent', 'conversation', 'settings', 'connector', 'connector_removed', 'approval', 'memory', 'memory_removed', 'computer', 'browser', 'browser_frame', 'artifact', 'routine', 'routine_removed', 'conversation_removed', 'skill', 'skill_removed', 'wiki', 'people', 'inbox', 'delegations'] as const satisfies readonly CoreEvent['type'][]
// …and none left out: a new kind of event fails to compile here until it's listed.
type _AllListed = Exclude<CoreEvent['type'], (typeof CORE_EVENT_TYPES)[number]> extends never ? true : never
export const _allEventsListed: _AllListed = true

export type Request = { id: number; method: Method; params: unknown }
export type Response = { id: number; result?: unknown; error?: string }
export type Wire = Response | { event: CoreEvent }
