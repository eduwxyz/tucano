// The shape of each method's params, as the contract (rpc.ts) says it: what the core checks before
// a call reaches its handler, so a page (or anyone with a connection) sending the wrong shape gets
// an error instead of a handler working on garbage. Kept in step with rpc.ts by test/rpc-fuzz.test.ts.
// s string, n number, b boolean, o object, a array, S string[], [x,y] one of these strings;
// "|null" may also be null; "?" may be left out (or null).
import { L } from './lang'
import type { Method } from './rpc'

export const SHAPES: Record<Method, Record<string, string>> = {
  markRead: { conversationId: 's' },
  snapshot: {},
  artifactText: { id: 's' },
  sendMessage: { conversationId: 's', text: 's', images: 'a?', files: 'a?', threadId: 's?' },
  typing: { conversationId: 's', threadId: 's?', opened: 'b?' },
  olderMessages: { conversationId: 's', before: 'n', through: 's?' },
  threadMessages: { rootId: 's' },
  stopRun: { messageId: 's' },
  retryRun: { messageId: 's' },
  continueRun: { messageId: 's' },
  setAgentModels: { agentIds: 'S', modelId: 's' },
  saveAgent: { agent: 'o', channelIds: 'S' },
  createChannel: { name: 's', threads: 'b?' },
  renameChannel: { id: 's', name: 's' },
  archiveAgent: { id: 's', archived: 'b' },
  setTopic: { id: 's', topic: 's' },
  setChannelMembers: { id: 's', agentIds: 'S' },
  deleteConversation: { id: 's' },
  openDm: { agentId: 's' },
  ensureTuca: { modelId: 's?', fresh: 'b?' },
  createFromDraft: { messageId: 's' },
  applyProposal: { messageId: 's', index: 'n?' },
  dismissProposal: { messageId: 's', index: 'n?' },
  applyProposals: { messageId: 's', draft: 'b?' },
  dismissProposals: { messageId: 's', draft: 'b?' },
  settleDraft: { messageId: 's', agentId: 's?' },
  updateSettings: { patch: 'o' },
  refreshEngines: {},
  voiceStatus: {},
  transcribe: { id: 's', audio: 's' },
  cancelTranscribe: { id: 's' },
  voiceDownload: { model: 's' },
  voiceCancelDownload: {},
  voiceRemoveModel: { model: 's' },
  localPath: { messageId: 's', path: 's' },
  openLocal: { messageId: 's', path: 's', how: '[open,reveal]' },
  loginEngine: { engine: 's', screen: 'b?' },
  loginScreen: {},
  loginInput: { id: 's', text: 's?', key: '[enter,up,down,left,right,esc,tab,backspace,space]?', enter: 'b?' },
  stopLogin: { id: 's' },
  addAccount: { engine: 's', name: 's' },
  loginAccount: { id: 's', screen: 'b?' },
  removeAccount: { id: 's' },
  installEngine: { engine: 's' },
  setupEngine: { engine: 's' },
  engineSetupState: {},
  cancelEngineSetup: {},
  desktopStatus: {},
  installedApps: {},
  openApps: {},
  installDesktop: {},
  desktopPermissions: {},
  addConnector: { input: 'o' },
  removeConnector: { id: 's' },
  reconnectConnector: { id: 's' },
  setConnectorToken: { id: 's', token: 's' },
  connectorCatalog: {},
  addCatalogConnector: { id: 's', values: 'o?' },
  ownAppGuide: { provider: '[google,slack]' },
  ownApp: { provider: 's' },
  setOwnApp: { provider: 's', clientId: 's', clientSecret: 's' },
  authorizeConnector: { id: 's' },
  finishConnectorAuth: { url: 's' },
  harnessMcps: {},
  importHarnessMcp: { key: 's' },
  updateTool: { connectorId: 's', name: 's', patch: 'o' },
  decideApproval: { id: 's', decision: '[approved,refused]', reason: 's?', always: 'b?' },
  addMemory: { scope: 's', text: 's' },
  editMemory: { id: 's', text: 's' },
  confirmMemory: { id: 's' },
  decideMemory: { id: 's', accept: 'b' },
  forgetMemory: { id: 's', reason: 's?' },
  purgeMemory: { id: 's' },
  editSummary: { conversationId: 's', text: 's' },
  summarizeNow: { conversationId: 's' },
  editThreadSummary: { rootId: 's', text: 's' },
  summarizeThreadNow: { rootId: 's' },
  computerAction: { agentId: 's', action: '[start,restart,erase,open_folder,refresh]' },
  stopService: { agentId: 's', name: 's' },
  browserAction: { agentId: 's', action: '[show,hide,clear]' },
  browserInput: { agentId: 's', input: 'o' },
  lendFolder: { agentId: 's', path: 's' },
  folderAction: { agentId: 's', name: 's', action: '[read_only,read_write,return]' },
  openExternal: { url: 's' },
  saveRoutine: { routine: 'o' },
  setJevKey: { key: 's|null' },
  engineModels: { engine: 's' },
  testEngine: { model: 's' },
  saveSkill: { skill: 'o' },
  localSkills: {},
  skillFolders: {},
  linkSkill: { source: 's', agents: 'S' },
  decideSkill: { id: 's', approve: 'b' },
  restoreSkill: { skillId: 's', versionId: 'n' },
  archiveSkill: { id: 's', archived: 'b' },
  removeSkill: { id: 's' },
  skillVersions: { skillId: 's' },
  checkTrigger: { trigger: 'o' },
  setTelegramToken: { token: 's|null' },
  unpairTelegram: {},
  exportTeam: {},
  importTeam: { text: 's' },
  importAgents: { path: 's?', data: 's?' },
  backupNow: {},
  exportBackup: {},
  restoreCheck: { path: 's' },
  restoreApply: {},
  restoreCancel: {},
  restoreInfo: {},
  openBackups: {},
  report: { week: 'n?' },
  usage: {},
  removeRoutine: { id: 's' },
  runRoutine: { id: 's' },
  wiki: {},
  wikiPage: { title: 's' },
  wikiSearch: { q: 's' },
  wikiSave: { title: 's', body: 's', kind: 's?', expectedHash: 's?', rename: 's?' },
  wikiRemove: { title: 's' },
  wikiHistory: { title: 's' },
  wikiRelease: { title: 's' },
  heritageSeen: {},
  wikiRestore: { id: 'n' },
  wikiSchema: {},
  wikiSaveSchema: { text: 's' },
  openWikiFolder: {},
  wikiChanges: { state: 's?' },
  wikiChange: { id: 's' },
  wikiApplyChange: { id: 's' },
  wikiRefuseChange: { id: 's' },
  wikiApplyWaiting: {},
  wikiUndoChange: { id: 's' },
  wikiSources: {},
  wikiSource: { id: 's' },
  wikiRemoveSource: { id: 's' },
  wikiKeepMessage: { messageId: 's' },
  wikiRedoChange: { id: 's' },
  wikiAddFile: { name: 's', data: 's' },
  wikiAddLink: { url: 's' },
  wikiAddNote: { text: 's', title: 's?' },
  wikiOpenOriginal: { id: 's' },
  wikiIngestAgain: { id: 's' },
  wikiReview: {},
  wikiRunReview: {},
  wikiDismissFinding: { id: 's' },
  wikiImport: { dir: 's' },
  wikiImportZip: { path: 's' },
  setWikiCapture: { conversationId: 's', on: 'b' },
  setThreads: { conversationId: 's', on: 'b' },
  setWikiDir: { dir: 's|null' },
  wikiGitStatus: {},
  wikiGitSetup: { url: 's' },
  wikiGitTest: {},
  wikiGitConnect: { how: '[repo,merge]' },
  wikiGitSync: { write: 'b?' },
  wikiGitDisconnect: {},
  setMyName: { name: 's', about: 's?' },
  setDelegation: { to: 's|null', until: 'n?' },
  createInvite: { role: 's', about: 's?', restore: 's?' },
  revokeInvite: { id: 's' },
  listInvites: {},
  removedPeople: {},
  myDevices: {},
  setPush: { handle: 's|null', tag: 's?' },
  removeDevice: { id: 's' },
  removePerson: { id: 's' },
  setRole: { id: 's', role: 's' },
  purgePerson: { id: 's' },
  leave: {},
  activity: { personId: 's?', kind: 's?', before: 'n?' },
  inbox: {},
  answerQuestion: { id: 's', text: 's' },
  confirmQuestion: { id: 's', ok: 'b' },
  answerDecision: { messageId: 's', index: 'n', answer: 'o|null' },
  submitDecisions: { messageId: 's' },
  watchRoutine: { id: 's', on: 'b' },
}

const fits = (v: unknown, t: string): boolean => {
  if (t.endsWith('|null') && v === null) return true
  const k = t.replace(/\|null$/, '')
  if (k === 's') return typeof v === 'string'
  if (k === 'n') return typeof v === 'number' && Number.isFinite(v)
  if (k === 'b') return typeof v === 'boolean'
  if (k === 'S') return Array.isArray(v) && v.every((x) => typeof x === 'string')
  if (k === 'a') return Array.isArray(v)
  if (k === 'o') return typeof v === 'object' && v !== null && !Array.isArray(v)
  if (k.startsWith('[')) return typeof v === 'string' && k.slice(1, -1).split(',').includes(v)
  return false
}

// Why these params don't fit the method (undefined: they do). No params at all is `{}`.
export function paramsError(method: Method, params: unknown): string | undefined {
  const shape = SHAPES[method]
  if (!shape) return undefined
  const p = params ?? {}
  if (typeof p !== 'object' || Array.isArray(p)) return invalid('params')
  for (const [key, spec] of Object.entries(shape)) {
    const optional = spec.endsWith('?')
    const v = (p as Record<string, unknown>)[key]
    if (v === undefined || (optional && v === null)) {
      if (!optional) return invalid(key)
    } else if (!fits(v, optional ? spec.slice(0, -1) : spec)) return invalid(key)
  }
  return undefined
}

const invalid = (field: string): string => L(`Pedido inválido (${field}).`, `Invalid request (${field}).`)

// How long a text each method takes, by field (characters). Beyond it, the call is refused at the
// door: nothing anyone sends keeps the core busy for long. A file comes as base64 (4 characters per 3 bytes).
const MB = 1_000_000
// The biggest file the wiki takes (bytes): the door below lets its base64 through, and says this number.
export const MAX_WIKI_FILE = 20 * 1024 * 1024
const MAX_WIKI_FILE_B64 = Math.ceil(MAX_WIKI_FILE / 3) * 4
export const LIMITS: Partial<Record<Method, Record<string, number>>> = {
  sendMessage: { text: MB },
  answerQuestion: { text: MB },
  setTopic: { topic: 500 },
  renameChannel: { name: 200 },
  createChannel: { name: 200 },
  setMyName: { name: 500, about: 5_000 },
  createInvite: { about: 5_000 },
  editSummary: { text: 20_000 },
  editThreadSummary: { text: 20_000 },
  addMemory: { text: 5_000 },
  editMemory: { text: 5_000 },
  wikiSave: { title: 200, body: MB, rename: 200 },
  wikiAddNote: { text: MB, title: 200 },
  wikiAddFile: { name: 300, data: MAX_WIKI_FILE_B64 },
  wikiAddLink: { url: 4_000 },
  wikiSaveSchema: { text: MB },
  wikiSearch: { q: 1_000 },
  wikiRelease: { title: 200 },
  wikiGitSetup: { url: 1_000 },
  loginInput: { text: 4_000 }, // a code or an API key, typed into a sign-in
  setPush: { handle: 2_000, tag: 200 }
}

export function limitError(method: Method, params: unknown): string | undefined {
  const limits = LIMITS[method]
  if (!limits || !params || typeof params !== 'object') return undefined
  for (const [key, max] of Object.entries(limits)) {
    const v = (params as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.length > max) return key === 'data' ? L(`Arquivo grande demais (até ${MAX_WIKI_FILE / 1024 / 1024} MB).`, `File too big (up to ${MAX_WIKI_FILE / 1024 / 1024} MB).`) : L(`Texto grande demais (${key}: até ${max.toLocaleString('pt-BR')} caracteres).`, `Text too big (${key}: up to ${max.toLocaleString('en-US')} characters).`)
  }
  return undefined
}
