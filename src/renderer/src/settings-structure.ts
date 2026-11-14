import { L } from '../../shared/lang'
import type { Settings } from '../../shared/types'

export interface SettingsAccess {
  admin: boolean
  owner: boolean
  team: boolean
  servers: boolean
}

type Scope = 'personal' | 'workspace' | 'computer' | 'mixed'
type PageId = 'app' | 'workspace' | 'agents' | 'models' | 'knowledge' | 'connections'
type Section = {
  id: string
  page: PageId
  label: string
  keys: readonly (keyof Settings)[]
  scope: Scope
  visible: boolean
}

// Order and ownership are deliberate. New controls must extend this structure, not append
// another pane condition elsewhere in the renderer. Labels are read again after locale changes.
export function settingsStructure({ admin, owner, team, servers }: SettingsAccess) {
  return [
    { id: 'app-appearance', page: 'app', label: L('Aparência', 'Appearance'), keys: ['theme', 'language'], scope: 'mixed', visible: true },
    { id: 'app-conversation', page: 'app', label: L('Conversa', 'Conversation'), keys: ['stepsOpen'], scope: 'personal', visible: true },
    { id: 'app-notifications', page: 'app', label: L('Notificações', 'Notifications'), keys: ['sounds'], scope: 'personal', visible: true },
    { id: 'app-dictation', page: 'app', label: L('Ditado', 'Dictation'), keys: ['voice'], scope: 'mixed', visible: admin },
    { id: 'app-startup', page: 'app', label: L('Inicialização', 'Startup'), keys: ['openAtLogin'], scope: 'computer', visible: admin },
    { id: 'app-updates', page: 'app', label: L('Atualizações', 'Updates'), keys: [], scope: 'computer', visible: admin },
    { id: 'workspace-context', page: 'workspace', label: L('Contexto', 'Context'), keys: ['workspaceLabel', 'workspaceName', 'context', 'onboarding'], scope: 'workspace', visible: admin },
    { id: 'workspace-people', page: 'workspace', label: L('Pessoas', 'People'), keys: [], scope: 'mixed', visible: team },
    { id: 'workspace-activity', page: 'workspace', label: L('Atividade', 'Activity'), keys: [], scope: 'workspace', visible: team && admin },
    { id: 'workspace-transfer', page: 'workspace', label: L('Importar e exportar', 'Import and export'), keys: [], scope: 'workspace', visible: admin },
    { id: 'workspace-backups', page: 'workspace', label: L('Backups', 'Backups'), keys: [], scope: 'workspace', visible: owner },
    { id: 'workspace-danger', page: 'workspace', label: L('Dados e exclusão', 'Data and deletion'), keys: [], scope: 'workspace', visible: owner },
    { id: 'agents-replies', page: 'agents', label: L('Respostas', 'Replies'), keys: ['chainDepth'], scope: 'workspace', visible: admin },
    { id: 'agents-recovery', page: 'agents', label: L('Recuperação', 'Recovery'), keys: ['runStallMinutes'], scope: 'workspace', visible: admin },
    { id: 'agents-permissions', page: 'agents', label: L('Permissões', 'Permissions'), keys: ['autonomy', 'actionRules', 'outsideGuard', 'approvalTtlHours'], scope: 'workspace', visible: admin },
    { id: 'agents-limits', page: 'agents', label: L('Limites', 'Limits'), keys: ['defaultLimit', 'runBudgetPct'], scope: 'workspace', visible: admin },
    { id: 'agents-automation', page: 'agents', label: L('Automação', 'Automation'), keys: ['quietHours'], scope: 'workspace', visible: admin },
    { id: 'models-agents', page: 'models', label: L('Modelos dos agentes', 'Agent models'), keys: [], scope: 'workspace', visible: admin },
    { id: 'models-runtimes', page: 'models', label: L('Runtimes', 'Runtimes'), keys: ['harnesses'], scope: 'mixed', visible: admin },
    { id: 'models-accounts', page: 'models', label: L('Contas', 'Accounts'), keys: ['accounts'], scope: 'mixed', visible: admin },
    { id: 'models-classifiers', page: 'models', label: L('Classificadores', 'Classifiers'), keys: ['routerModel', 'jevKey', 'browserJev'], scope: 'workspace', visible: admin },
    { id: 'knowledge-memory', page: 'knowledge', label: L('Memória', 'Memory'), keys: ['memoryModel', 'memoryLearning'], scope: 'workspace', visible: admin },
    { id: 'knowledge-wiki-capture', page: 'knowledge', label: L('Captura da wiki', 'Wiki capture'), keys: ['wikiCapture', 'wikiEdits', 'wikiReview'], scope: 'workspace', visible: admin },
    { id: 'knowledge-wiki-storage', page: 'knowledge', label: L('Pasta e Git', 'Folder and Git'), keys: ['wikiDir'], scope: 'workspace', visible: admin },
    { id: 'knowledge-wiki-import', page: 'knowledge', label: L('Importar notas', 'Import notes'), keys: [], scope: 'workspace', visible: admin },
    { id: 'knowledge-wiki-rules', page: 'knowledge', label: L('Regras das páginas', 'Page rules'), keys: [], scope: 'workspace', visible: admin },
    { id: 'connections-phone', page: 'connections', label: L('Celular e Telegram', 'Phone and Telegram'), keys: ['telegram'], scope: 'mixed', visible: owner },
    { id: 'connections-servers', page: 'connections', label: L('Servidores', 'Servers'), keys: [], scope: 'computer', visible: admin && servers }
  ] as const satisfies readonly Section[]
}

export type SettingsSection = ReturnType<typeof settingsStructure>[number]
export type SettingsSectionId = SettingsSection['id']
export type SettingsPageId = SettingsSection['page']

export const settingsPages = (): readonly (readonly [SettingsPageId, string])[] => [
  ['app', L('App', 'App')],
  ['workspace', 'Workspace'],
  ['agents', L('Agentes', 'Agents')],
  ['models', L('Modelos', 'Models')],
  ['knowledge', L('Conhecimento', 'Knowledge')],
  ['connections', L('Conexões', 'Connections')]
]

const legacy: Readonly<Record<string, string>> = {
  geral: 'app', modelos: 'models', agentes: 'agents', roteamento: 'models-routing',
  integracoes: 'connections-phone', pessoas: 'workspace-people', atividade: 'workspace-activity', servidores: 'connections-servers'
}

export function settingsDestination(requested: string | undefined, sections: readonly SettingsSection[]) {
  const available = sections.filter(section => section.visible)
  const destination = legacy[requested ?? ''] ?? requested
  const relatedPage = sections.find(s => s.id === destination)?.page ?? settingsPages().find(([id]) => destination?.startsWith(id + '-'))?.[0]
  const section = available.find(s => s.id === destination) ?? available.find(s => s.page === destination || s.page === relatedPage) ?? available[0]!
  return { page: section.page, section: section.id, explicit: available.some(s => s.id === destination) }
}
