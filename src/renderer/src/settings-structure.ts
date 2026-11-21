import { L } from '../../shared/lang'
import type { Settings } from '../../shared/types'

export interface SettingsAccess {
  admin: boolean
  owner: boolean
  team: boolean
  servers: boolean
}

type Scope = 'personal' | 'workspace' | 'computer' | 'mixed'
type PageId = 'geral' | 'modelos' | 'agentes' | 'integracoes' | 'pessoas' | 'atividade' | 'servidores' | 'harnesses'
type Section = {
  id: string
  page: PageId
  label: string
  keys: readonly (keyof Settings)[]
  scope: Scope
  visible: boolean
}

// Order and ownership are deliberate, and a page is one of the settings tabs. A card declares the
// section it holds here, so moving a control means moving its keys with it. Labels are read again
// after locale changes.
export function settingsStructure({ admin, owner, team, servers }: SettingsAccess) {
  return [
    { id: 'app-appearance', page: 'geral', label: L('Aparência', 'Appearance'), keys: ['theme', 'language'], scope: 'mixed', visible: true },
    { id: 'workspace-context', page: 'geral', label: L('Contexto do workspace', 'Workspace context'), keys: ['workspaceLabel', 'workspaceName', 'context', 'onboarding'], scope: 'workspace', visible: admin },
    { id: 'app-dictation', page: 'geral', label: L('Ditado', 'Dictation'), keys: ['voice'], scope: 'mixed', visible: admin },
    { id: 'app-notifications', page: 'geral', label: L('Notificações', 'Notifications'), keys: ['sounds'], scope: 'personal', visible: true },
    { id: 'app-conversation', page: 'geral', label: L('Conversas', 'Conversations'), keys: ['stepsOpen'], scope: 'personal', visible: true },
    { id: 'app-updates', page: 'geral', label: L('Atualizações', 'Updates'), keys: [], scope: 'computer', visible: admin },
    { id: 'workspace-team', page: 'geral', label: L('Equipe', 'Team'), keys: [], scope: 'workspace', visible: admin },
    { id: 'workspace-backups', page: 'geral', label: L('Backups', 'Backups'), keys: [], scope: 'workspace', visible: true },
    { id: 'workspace-danger', page: 'geral', label: L('Dados e exclusão', 'Data and deletion'), keys: [], scope: 'workspace', visible: owner },
    { id: 'models-agents', page: 'modelos', label: L('Modelos dos agentes', 'Agent models'), keys: [], scope: 'workspace', visible: admin },
    { id: 'models-runtimes', page: 'modelos', label: L('Harnesses', 'Harnesses'), keys: ['harnesses', 'endpoint'], scope: 'mixed', visible: admin },
    { id: 'models-accounts', page: 'modelos', label: L('Contas', 'Accounts'), keys: ['accounts'], scope: 'mixed', visible: admin },
    { id: 'models-router', page: 'modelos', label: L('Roteador', 'Router'), keys: ['routerModel', 'jevKey'], scope: 'workspace', visible: admin },
    { id: 'knowledge-memory', page: 'modelos', label: L('Memória', 'Memory'), keys: ['memoryModel', 'memoryLearning'], scope: 'workspace', visible: admin },
    { id: 'agents-permissions', page: 'agentes', label: L('Permissões', 'Permissions'), keys: ['autonomy', 'actionRules', 'outsideGuard'], scope: 'workspace', visible: admin },
    { id: 'agents-tuca', page: 'agentes', label: L('Tuca', 'Tuca'), keys: ['tucaApplyNow'], scope: 'workspace', visible: admin },
    { id: 'agents-browser', page: 'agentes', label: L('Navegador dos agentes', 'Agents browser'), keys: ['browserJev'], scope: 'workspace', visible: admin },
    { id: 'agents-routines', page: 'agentes', label: L('Rotinas', 'Routines'), keys: ['openAtLogin', 'quietHours'], scope: 'mixed', visible: admin },
    { id: 'agents-limits', page: 'agentes', label: L('Limites', 'Limits'), keys: ['defaultLimit', 'runBudgetPct', 'runStallMinutes', 'approvalTtlHours', 'autoContinue'], scope: 'workspace', visible: admin },
    { id: 'connections-phone', page: 'integracoes', label: L('Celular e Telegram', 'Phone and Telegram'), keys: ['telegram'], scope: 'mixed', visible: owner },
    { id: 'workspace-people', page: 'pessoas', label: L('Pessoas', 'People'), keys: [], scope: 'mixed', visible: team },
    { id: 'workspace-activity', page: 'atividade', label: L('Atividade', 'Activity'), keys: [], scope: 'workspace', visible: team && admin },
    { id: 'connections-servers', page: 'servidores', label: L('Servidores', 'Servers'), keys: ['paused', 'node'], scope: 'computer', visible: admin && servers },
    { id: 'harnesses-keys', page: 'harnesses', label: L('Harnesses (MCP)', 'Harnesses (MCP)'), keys: [], scope: 'workspace', visible: true }
  ] as const satisfies readonly Section[]
}

export type SettingsSection = ReturnType<typeof settingsStructure>[number]
export type SettingsSectionId = SettingsSection['id']
export type SettingsPageId = SettingsSection['page']

// The tab bar is older than this structure, so each tab names the sections whose cards it shows, in
// the order they read on screen. The strip lists only the sections the pane really rendered, so a
// section that this person's role leaves out never becomes a dead link.
const tabSections: Readonly<Record<string, readonly SettingsSectionId[]>> = {
  geral: ['app-appearance', 'workspace-context', 'app-dictation', 'app-notifications', 'app-conversation', 'app-updates', 'workspace-team', 'workspace-backups', 'workspace-danger'],
  modelos: ['models-agents', 'models-runtimes', 'models-accounts', 'models-router', 'knowledge-memory'],
  agentes: ['agents-permissions', 'agents-tuca', 'agents-browser', 'agents-routines', 'agents-limits'],
  integracoes: ['connections-phone'],
  pessoas: ['workspace-people'],
  atividade: ['workspace-activity'],
  servidores: ['connections-servers'],
  harnesses: ['harnesses-keys']
}

// The sections of one tab, in its reading order, each one still owned — label, keys and access — by
// the structure above.
export function settingsTabStructure(tab: string, sections: readonly SettingsSection[]): readonly SettingsSection[] {
  return (tabSections[tab] ?? [])
    .map(id => sections.find(section => section.id === id))
    .filter((section): section is SettingsSection => section !== undefined)
}
