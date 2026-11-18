import { L } from '../../shared/lang'
import type { Settings } from '../../shared/types'

export interface SettingsAccess {
  admin: boolean
  owner: boolean
  team: boolean
  servers: boolean
}

type Scope = 'personal' | 'workspace' | 'computer' | 'mixed'
type PageId = 'geral' | 'modelos' | 'agentes' | 'integracoes' | 'pessoas' | 'atividade' | 'servidores'
type Section = {
  id: string
  page: PageId
  label: string
  keys: readonly (keyof Settings)[]
  scope: Scope
  visible: boolean
}

// Order and ownership are deliberate, and a page is one of the settings tabs. A control is rendered
// inside the section declared here for it, so moving a card means moving its keys in this list too.
// Labels are read again after locale changes.
export function settingsStructure({ admin, owner, team, servers }: SettingsAccess) {
  return [
    { id: 'geral-appearance', page: 'geral', label: L('Aparência', 'Appearance'), keys: ['theme', 'language'], scope: 'mixed', visible: true },
    { id: 'geral-workspace', page: 'geral', label: L('Contexto do workspace', 'Workspace context'), keys: ['workspaceLabel', 'workspaceName', 'context', 'onboarding'], scope: 'workspace', visible: admin },
    { id: 'geral-voice', page: 'geral', label: L('Ditado', 'Dictation'), keys: ['voice'], scope: 'mixed', visible: admin },
    { id: 'geral-notifications', page: 'geral', label: L('Notificações', 'Notifications'), keys: ['sounds'], scope: 'personal', visible: true },
    { id: 'geral-conversation', page: 'geral', label: L('Conversas', 'Conversations'), keys: ['stepsOpen'], scope: 'personal', visible: true },
    { id: 'geral-feedback', page: 'geral', label: L('Falar com quem faz o Tucano', 'Feedback'), keys: ['surveys'], scope: 'workspace', visible: true },
    { id: 'geral-updates', page: 'geral', label: L('Atualizações', 'Updates'), keys: ['seenVersion'], scope: 'personal', visible: admin },
    { id: 'geral-team', page: 'geral', label: L('Equipe', 'Team'), keys: [], scope: 'workspace', visible: admin },
    { id: 'geral-backups', page: 'geral', label: L('Backups', 'Backups'), keys: [], scope: 'workspace', visible: true },
    { id: 'geral-danger', page: 'geral', label: L('Dados e exclusão', 'Data and deletion'), keys: [], scope: 'workspace', visible: owner },
    { id: 'modelos-agents', page: 'modelos', label: L('Modelos dos agentes', 'Agent models'), keys: [], scope: 'workspace', visible: admin },
    { id: 'modelos-runtimes', page: 'modelos', label: L('Runtimes', 'Runtimes'), keys: ['harnesses'], scope: 'mixed', visible: admin },
    { id: 'modelos-accounts', page: 'modelos', label: L('Contas', 'Accounts'), keys: [], scope: 'mixed', visible: admin },
    { id: 'modelos-router', page: 'modelos', label: L('Roteador', 'Router'), keys: ['routerModel', 'jevKey'], scope: 'workspace', visible: admin },
    { id: 'modelos-memory', page: 'modelos', label: L('Memória', 'Memory'), keys: ['memoryModel', 'memoryLearning'], scope: 'workspace', visible: admin },
    { id: 'agentes-autonomy', page: 'agentes', label: L('Autonomia', 'Autonomy'), keys: ['autonomy', 'actionRules', 'outsideGuard'], scope: 'workspace', visible: admin },
    { id: 'agentes-browser', page: 'agentes', label: L('Navegador dos agentes', 'Agents’ browser'), keys: ['browserJev'], scope: 'workspace', visible: admin },
    { id: 'agentes-routines', page: 'agentes', label: L('Rotinas', 'Routines'), keys: ['openAtLogin', 'quietHours'], scope: 'computer', visible: admin },
    { id: 'agentes-limits', page: 'agentes', label: L('Limites', 'Limits'), keys: ['defaultLimit', 'runBudgetPct', 'runStallMinutes', 'chainDepth', 'approvalTtlHours'], scope: 'workspace', visible: admin },
    { id: 'integracoes-phone', page: 'integracoes', label: L('Celular e Telegram', 'Phone and Telegram'), keys: ['telegram'], scope: 'mixed', visible: owner },
    { id: 'pessoas-people', page: 'pessoas', label: L('Pessoas', 'People'), keys: [], scope: 'mixed', visible: team },
    { id: 'atividade-activity', page: 'atividade', label: L('Atividade', 'Activity'), keys: [], scope: 'workspace', visible: team && admin },
    { id: 'servidores-cards', page: 'servidores', label: L('Servidores', 'Servers'), keys: ['paused'], scope: 'computer', visible: admin && servers }
  ] as const satisfies readonly Section[]
}

export type SettingsSection = ReturnType<typeof settingsStructure>[number]
export type SettingsSectionId = SettingsSection['id']
export type SettingsPageId = SettingsSection['page']

// The settings tabs in the order SETTINGS_TABS shows them. A pane with no visible section keeps its
// cards without a rail; the page stays here so a destination can still resolve to it.
export const settingsPages = (): readonly (readonly [SettingsPageId, string])[] => [
  ['geral', L('Geral', 'General')],
  ['modelos', L('Modelos', 'Models')],
  ['agentes', L('Agentes', 'Agents')],
  ['integracoes', L('Celular', 'Phone')],
  ['pessoas', L('Pessoas', 'People')],
  ['atividade', L('Atividade', 'Activity')],
  ['servidores', L('Servidores', 'Servers')]
]

// Names the app used before settings were grouped by task, and the section each one means.
const legacy: Readonly<Record<string, string>> = {
  app: 'geral-appearance', workspace: 'geral-workspace', agents: 'agentes-autonomy', models: 'modelos-agents',
  roteamento: 'modelos-router', integracoes: 'integracoes-phone', pessoas: 'pessoas-people',
  atividade: 'atividade-activity', servidores: 'servidores-cards'
}

export function settingsDestination(requested: string | undefined, sections: readonly SettingsSection[]) {
  const available = sections.filter(section => section.visible)
  const destination = legacy[requested ?? ''] ?? requested
  const relatedPage = sections.find(s => s.id === destination)?.page ?? settingsPages().find(([id]) => destination?.startsWith(id + '-'))?.[0]
  const section = available.find(s => s.id === destination) ?? available.find(s => s.page === destination || s.page === relatedPage) ?? available[0]!
  return { page: section.page, section: section.id, explicit: available.some(s => s.id === destination) }
}
