// Who may do what in a Tucano with people. Every RPC method says what it needs (NEEDS): anyone
// with access, an admin, or only the owner; 'target' methods are anyone's at the door and check
// the thing they touch with `can` (an approval, a question, a routine, a memory, a person).
// The desktop's one person is the owner, so on a desktop everything is allowed, as always.
import { L } from '../shared/lang'
import type { Method } from '../shared/rpc'
import { delegating, scopePerson, type Person, type Question, type Role, type Routine, type Settings } from '../shared/types'

export const isAdmin = (p: Pick<Person, 'role'>): boolean => p.role === 'owner' || p.role === 'admin'

export const adminError = (): string => L('Só um admin pode fazer isso.', 'Only an admin can do that.')
export const ownerError = (): string => L('Só o dono do Tucano pode fazer isso.', "Only the Tucano's owner can do that.")

// What a person may change of the settings without being an admin: how the app looks to them.
// Each person's own (kept on them, see People.settingsFor); the owner's are the settings themselves.
export const PERSONAL_SETTINGS: readonly (keyof Settings)[] = ['theme', 'sounds', 'channelLayout', 'folded', 'language', 'seenVersion', 'onboarding']
export const isPersonalSetting = (k: string): boolean => (PERSONAL_SETTINGS as readonly string[]).includes(k)

export type Action =
  | { kind: 'admin' }
  | { kind: 'owner' }
  | { kind: 'settings'; keys: string[] }
  | { kind: 'person'; target: Pick<Person, 'id' | 'role'>; role?: Exclude<Role, 'owner'> } // invite back, remove, change the role of
  | { kind: 'routine'; routine: Pick<Routine, 'scope' | 'owner'> } // create, change, remove, run
  | { kind: 'approval'; agentOwner?: Person } // decide: the agent's person (with whoever covers for them)
  | { kind: 'question'; question: Question; askedTo?: Person; now?: number } // answer
  | { kind: 'confirm'; question: Question } // say whether a DM's agent may ask someone else
  | { kind: 'memory'; scope: string; privateTo?: string } // change or decide

export function can(person: Person, action: Action): boolean {
  switch (action.kind) {
    case 'admin':
      return isAdmin(person)
    case 'owner':
      return person.role === 'owner'
    case 'settings':
      return isAdmin(person) || action.keys.every(isPersonalSetting)
    case 'person':
      // Admins manage members; only the owner manages admins (or makes one); no one touches the owner.
      if (!isAdmin(person) || action.target.role === 'owner' || action.target.id === person.id) return false
      return person.role === 'owner' || (action.target.role !== 'admin' && action.role !== 'admin')
    case 'routine':
      return action.routine.scope === 'channel' ? isAdmin(person) : isAdmin(person) || action.routine.owner === person.id
    case 'approval':
      return isAdmin(person) || action.agentOwner?.id === person.id || delegating(action.agentOwner, person.id)
    case 'question': {
      const q = action.question
      if (q.state !== 'open') return false
      // Waiting on the DM's person to say yes: no one else has seen it yet.
      if (q.confirm === 'pending') return person.id === q.requestedBy
      const late = (action.now ?? Date.now()) >= q.deadlineAt
      return person.id === q.askedTo || isAdmin(person) || delegating(action.askedTo, person.id, action.now) || (late && person.id === q.requestedBy)
    }
    case 'confirm':
      return action.question.state === 'open' && action.question.confirm === 'pending' && person.id === action.question.requestedBy
    case 'memory': {
      // A person's memories are theirs alone (not even an admin's); an agent's notes are the admins'.
      // An agent's note from someone's DM is theirs alone too.
      const of = action.privateTo ?? scopePerson(action.scope)
      return of ? of === person.id : isAdmin(person)
    }
  }
}

// `can`, or the reason why not, as the page shows it.
export function must(person: Person, action: Action): void {
  if (can(person, action)) return
  // An admin refused about a person: it's the owner's to do (or no one's), not "only an admin".
  if (action.kind === 'person' && isAdmin(person)) throw new Error(personError(person, action.target))
  throw new Error(action.kind === 'owner' ? ownerError() : action.kind === 'approval' ? L('Quem decide é a pessoa desse agente, quem a cobre agora ou um admin.', "It's for this agent's person, whoever covers for them now, or an admin to decide.") : action.kind === 'question' || action.kind === 'confirm' ? L('Essa pergunta não é pra você.', "That question isn't for you.") : action.kind === 'memory' && (action.privateTo || scopePerson(action.scope)) ? L('Essa memória não existe mais.', 'That memory no longer exists.') : adminError())
}

function personError(by: Person, target: Pick<Person, 'id' | 'role'>): string {
  if (target.role === 'owner') return L('O acesso do dono do Tucano não muda.', "The Tucano owner's access doesn't change.")
  if (target.id === by.id) return L('Seu próprio acesso quem muda é o dono do Tucano.', 'Only the Tucano owner changes your own access.')
  return ownerError()
}

// What each RPC method needs at the door.
export type Need = 'anyone' | 'admin' | 'owner' | 'target'
export const NEEDS: Record<Method, Need> = {
  // reading, and the conversations one can see (each checks it can reach the conversation)
  markRead: 'anyone',
  snapshot: 'anyone',
  artifactText: 'anyone',
  sendMessage: 'anyone',
  typing: 'anyone',
  olderMessages: 'anyone',
  threadMessages: 'anyone',
  stopRun: 'anyone',
  retryRun: 'anyone',
  continueRun: 'anyone',
  createChannel: 'anyone',
  renameChannel: 'anyone',
  setTopic: 'anyone',
  setChannelMembers: 'anyone',
  deleteConversation: 'target', // one's DM; a channel, admins
  openDm: 'anyone',
  ensureTuca: 'anyone',
  settleDraft: 'anyone',
  dismissProposal: 'anyone',
  applyProposal: 'target', // agents and teams, admins (a member's card tells them); a routine, its rules; a channel, anyone
  applyProposals: 'target', // each card as applyProposal checks it
  dismissProposals: 'anyone',
  localPath: 'anyone',
  openLocal: 'anyone',
  openExternal: 'anyone',
  voiceStatus: 'anyone',
  transcribe: 'anyone',
  cancelTranscribe: 'anyone',
  editSummary: 'anyone',
  summarizeNow: 'anyone',
  editThreadSummary: 'anyone',
  summarizeThreadNow: 'anyone',
  setWikiCapture: 'anyone',
  setThreads: 'anyone',
  decideApproval: 'target',
  addMemory: 'target',
  editMemory: 'target',
  confirmMemory: 'target',
  decideMemory: 'target',
  forgetMemory: 'target',
  purgeMemory: 'target',
  saveRoutine: 'target',
  removeRoutine: 'target',
  runRoutine: 'target',
  watchRoutine: 'anyone',
  updateSettings: 'target', // personal preferences, anyone; the rest, admins
  browserAction: 'target', // a browser working for a conversation one sees; otherwise admins
  browserInput: 'target',
  // the team's knowledge: anyone reads and writes pages; the curator's decisions and the wiki's place are the admins'
  wiki: 'anyone',
  wikiPage: 'anyone',
  wikiSearch: 'anyone',
  wikiSave: 'anyone',
  wikiRemove: 'anyone',
  wikiHistory: 'anyone',
  wikiRelease: 'anyone', // the person a page is held for (checked in the core)
  heritageSeen: 'owner',
  wikiRestore: 'anyone',
  wikiSchema: 'anyone',
  wikiChanges: 'anyone',
  wikiChange: 'anyone',
  wikiSources: 'anyone',
  wikiSource: 'anyone',
  wikiKeepMessage: 'anyone',
  wikiAddFile: 'anyone',
  wikiAddLink: 'anyone',
  wikiAddNote: 'anyone',
  wikiOpenOriginal: 'anyone',
  wikiReview: 'anyone',
  wikiIngestAgain: 'anyone',
  wikiRemoveSource: 'anyone', // the admins', or a DM source's own person (checked in the core)
  wikiSaveSchema: 'admin',
  openWikiFolder: 'admin',
  wikiApplyChange: 'admin',
  wikiRefuseChange: 'admin',
  wikiApplyWaiting: 'admin',
  wikiUndoChange: 'admin',
  wikiRedoChange: 'admin',
  wikiRunReview: 'admin',
  wikiDismissFinding: 'admin',
  wikiImport: 'admin',
  wikiImportZip: 'admin',
  setWikiDir: 'admin',
  wikiGitStatus: 'admin', // the wiki's git sync: its key, its repository, its folder
  wikiGitSetup: 'admin',
  wikiGitTest: 'admin',
  wikiGitConnect: 'admin',
  wikiGitSync: 'admin',
  wikiGitDisconnect: 'admin',
  // one's own
  setMyName: 'anyone',
  setDelegation: 'anyone',
  inbox: 'anyone',
  answerQuestion: 'target',
  confirmQuestion: 'target',
  answerDecision: 'target', // who may answer the question (Runner.decidable)
  submitDecisions: 'target',
  // agents, skills and the team
  setAgentModels: 'admin',
  saveAgent: 'admin',
  archiveAgent: 'admin',
  createFromDraft: 'admin',
  computerAction: 'target', // looking again at its state, anyone who sees the agent; the rest, admins (admitComputer)
  stopService: 'admin',
  lendFolder: 'admin',
  folderAction: 'admin',
  saveSkill: 'admin',
  localSkills: 'admin',
  skillFolders: 'admin',
  linkSkill: 'admin',
  decideSkill: 'admin',
  restoreSkill: 'admin',
  archiveSkill: 'admin',
  removeSkill: 'admin',
  skillVersions: 'admin',
  exportTeam: 'admin',
  importTeam: 'admin',
  importAgents: 'admin',
  exportBackup: 'owner',
  restoreCheck: 'owner',
  restoreApply: 'owner',
  restoreCancel: 'owner',
  restoreInfo: 'owner',
  // connectors, harnesses and this computer
  addConnector: 'admin',
  removeConnector: 'admin',
  reconnectConnector: 'admin',
  setConnectorToken: 'admin',
  connectorCatalog: 'admin',
  addCatalogConnector: 'admin',
  ownAppGuide: 'admin',
  ownApp: 'admin',
  setOwnApp: 'admin',
  authorizeConnector: 'admin',
  finishConnectorAuth: 'admin',
  harnessMcps: 'admin',
  importHarnessMcp: 'admin',
  updateTool: 'admin',
  checkTrigger: 'admin',
  refreshEngines: 'admin',
  loginEngine: 'admin',
  loginScreen: 'admin',
  loginInput: 'admin',
  stopLogin: 'admin',
  addAccount: 'admin',
  loginAccount: 'admin',
  removeAccount: 'admin',
  installEngine: 'admin',
  setupEngine: 'admin',
  engineSetupState: 'admin',
  cancelEngineSetup: 'admin',
  engineModels: 'anyone', // the models a harness lists: an agent's page names its model with them
  testEngine: 'admin',
  setJevKey: 'admin',
  voiceDownload: 'admin',
  voiceCancelDownload: 'admin',
  voiceRemoveModel: 'admin',
  // what an agent's page shows about the apps, read-only (a server has none: it says so)
  desktopStatus: 'anyone',
  installedApps: 'anyone',
  openApps: 'anyone',
  installDesktop: 'admin',
  desktopPermissions: 'admin',
  backupNow: 'admin',
  openBackups: 'admin',
  report: 'admin',
  usage: 'admin',
  // people
  createInvite: 'admin',
  revokeInvite: 'admin',
  listInvites: 'admin',
  removedPeople: 'admin',
  myDevices: 'anyone', // one's own
  setPush: 'anyone', // one's own device's (ctx.device)
  removeDevice: 'anyone', // one's own (the core looks only among theirs)
  removePerson: 'target',
  setRole: 'target',
  activity: 'admin',
  purgePerson: 'owner',
  leave: 'anyone', // one's own access (the owner is refused in the core)
  setTelegramToken: 'owner', // the phone is the owner's
  unpairTelegram: 'owner'
}

// An agent's computer: anyone who sees the agent may look at it again (its page does, opening);
// starting, restarting, erasing or opening its folder is the admins'.
export function admitComputer(person: Person, action: 'start' | 'restart' | 'erase' | 'open_folder' | 'refresh'): void {
  if (action !== 'refresh') must(person, { kind: 'admin' })
}

// At the door: what the method needs, before it runs.
export function admit(person: Person, method: Method): void {
  const need = NEEDS[method]
  if (need === 'admin') must(person, { kind: 'admin' })
  else if (need === 'owner') must(person, { kind: 'owner' })
}
