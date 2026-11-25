import { L } from '../../shared/lang'
import type { Settings } from '../../shared/types'

export interface SettingsAccess {
  admin: boolean
  owner: boolean
  team: boolean
  servers: boolean
}

type Scope = 'personal' | 'workspace' | 'computer' | 'mixed'
// The five groups at the top of the page. Their ids are the page's tab ids: `geral` is "You".
type PageId = 'geral' | 'agentes' | 'modelos' | 'conexoes' | 'workspace'
type Section = {
  id: string
  page: PageId
  label: string
  // The tile by the subject's name: an icon from ui.tsx on one of the app's agent colours.
  icon: string
  color: string
  keys: readonly (keyof Settings)[]
  scope: Scope
  visible: boolean
}

// Every subject of the page, once: the group it sits in, its name and tile, the settings keys it
// owns, its scope and who sees it. A card declares the subject it holds, so moving a control means
// moving its keys with it. Labels are read again after locale changes.
export function settingsStructure({ admin, owner, team, servers }: SettingsAccess) {
  return [
    { id: 'workspace-context', page: 'geral', label: L('Geral', 'General'), icon: 'gear', color: 'var(--c-graphite)', keys: ['workspaceLabel', 'workspaceName', 'context', 'onboarding'], scope: 'workspace', visible: admin },
    { id: 'app-appearance', page: 'geral', label: L('Aparência', 'Appearance'), icon: 'sun', color: 'var(--c-amber)', keys: ['theme', 'language'], scope: 'mixed', visible: true },
    { id: 'app-notifications', page: 'geral', label: L('Notificações', 'Notifications'), icon: 'bell', color: 'var(--c-rose)', keys: ['sounds'], scope: 'personal', visible: true },
    { id: 'app-dictation', page: 'geral', label: L('Ditado', 'Dictation'), icon: 'mic', color: 'var(--c-sky)', keys: ['voice'], scope: 'mixed', visible: admin },
    { id: 'app-conversation', page: 'geral', label: L('Conversas', 'Conversations'), icon: 'thread', color: 'var(--c-indigo)', keys: ['stepsOpen', 'showThinking'], scope: 'personal', visible: true },
    { id: 'agents-permissions', page: 'agentes', label: L('Autonomia', 'Autonomy'), icon: 'shield', color: 'var(--accent)', keys: ['autonomy', 'actionRules', 'outsideGuard'], scope: 'workspace', visible: admin },
    { id: 'agents-replies', page: 'agentes', label: L('Respostas', 'Replies'), icon: 'send', color: 'var(--c-sky)', keys: ['repliesAtOnce'], scope: 'workspace', visible: admin },
    { id: 'agents-limits', page: 'agentes', label: L('Limites', 'Limits'), icon: 'gauge', color: 'var(--c-amber)', keys: ['defaultLimit', 'runBudgetPct', 'runStallMinutes', 'approvalTtlHours', 'autoContinue'], scope: 'workspace', visible: admin },
    { id: 'agents-routines', page: 'agentes', label: L('Rotinas', 'Routines'), icon: 'clock', color: 'var(--c-violet)', keys: ['openAtLogin', 'quietHours'], scope: 'mixed', visible: admin },
    { id: 'agents-tuca', page: 'agentes', label: L('Tuca', 'Tuca'), icon: 'spark', color: 'var(--accent)', keys: ['tucaApplyNow'], scope: 'workspace', visible: admin },
    { id: 'agents-browser', page: 'agentes', label: L('Navegador', 'Browser'), icon: 'globe', color: 'var(--c-teal)', keys: ['browserJev'], scope: 'workspace', visible: admin },
    { id: 'models-agents', page: 'modelos', label: L('Modelos dos agentes', 'Agent models'), icon: 'layers', color: 'var(--c-indigo)', keys: [], scope: 'workspace', visible: admin },
    { id: 'models-runtimes', page: 'modelos', label: L('Harnesses', 'Harnesses'), icon: 'terminal', color: 'var(--c-graphite)', keys: ['harnesses', 'endpoint'], scope: 'mixed', visible: admin },
    { id: 'models-accounts', page: 'modelos', label: L('Contas', 'Accounts'), icon: 'key', color: 'var(--c-green)', keys: ['accounts'], scope: 'mixed', visible: admin },
    { id: 'models-classifiers', page: 'modelos', label: L('Classificadores', 'Classifiers'), icon: 'spark', color: 'var(--c-sky)', keys: ['classifiers', 'classifierJobs', 'classifierKeys', 'jevKey'], scope: 'workspace', visible: admin },
    { id: 'models-router', page: 'modelos', label: L('Roteador', 'Router'), icon: 'route', color: 'var(--c-teal)', keys: ['routerModel'], scope: 'workspace', visible: admin },
    { id: 'knowledge-memory', page: 'modelos', label: L('Memória', 'Memory'), icon: 'book', color: 'var(--c-violet)', keys: ['memoryModel', 'memoryLearning'], scope: 'workspace', visible: admin },
    { id: 'connections-phone', page: 'conexoes', label: L('Celular e Telegram', 'Phone and Telegram'), icon: 'phone', color: 'var(--c-green)', keys: ['telegram'], scope: 'mixed', visible: owner },
    { id: 'connections-servers', page: 'conexoes', label: L('Servidores', 'Servers'), icon: 'server', color: 'var(--c-graphite)', keys: ['paused', 'node'], scope: 'computer', visible: admin && servers },
    { id: 'connections-traces', page: 'conexoes', label: 'Traces', icon: 'report', color: 'var(--c-violet)', keys: [], scope: 'workspace', visible: admin },
    { id: 'harnesses-keys', page: 'conexoes', label: L('Acesso por MCP', 'MCP access'), icon: 'plug', color: 'var(--c-indigo)', keys: [], scope: 'workspace', visible: true },
    { id: 'workspace-people', page: 'workspace', label: L('Pessoas', 'People'), icon: 'users', color: 'var(--c-sky)', keys: [], scope: 'mixed', visible: team },
    { id: 'workspace-activity', page: 'workspace', label: L('Atividade', 'Activity'), icon: 'report', color: 'var(--c-graphite)', keys: [], scope: 'workspace', visible: team && admin },
    { id: 'workspace-team', page: 'workspace', label: L('Levar o time', 'Move the team'), icon: 'folder', color: 'var(--c-teal)', keys: [], scope: 'workspace', visible: admin },
    { id: 'workspace-backups', page: 'workspace', label: L('Backups', 'Backups'), icon: 'archive', color: 'var(--c-teal)', keys: [], scope: 'workspace', visible: owner },
    { id: 'app-updates', page: 'workspace', label: L('Atualizações', 'Updates'), icon: 'down', color: 'var(--c-green)', keys: [], scope: 'computer', visible: admin },
    { id: 'workspace-danger', page: 'workspace', label: L('Dados e exclusão', 'Data and deletion'), icon: 'trash', color: 'var(--danger)', keys: [], scope: 'workspace', visible: owner }
  ] as const satisfies readonly Section[]
}

export type SettingsSection = ReturnType<typeof settingsStructure>[number]
export type SettingsSectionId = SettingsSection['id']
export type SettingsPageId = SettingsSection['page']

// The groups in the order they sit at the top of the page, with their subjects in reading order:
// what most people change first, what can't be undone last.
const tabSections: Readonly<Record<string, readonly SettingsSectionId[]>> = {
  geral: ['workspace-context', 'app-appearance', 'app-notifications', 'app-dictation', 'app-conversation'],
  agentes: ['agents-permissions', 'agents-replies', 'agents-limits', 'agents-routines', 'agents-tuca', 'agents-browser'],
  modelos: ['models-agents', 'models-runtimes', 'models-accounts', 'models-classifiers', 'models-router', 'knowledge-memory'],
  conexoes: ['connections-phone', 'connections-servers', 'connections-traces', 'harnesses-keys'],
  workspace: ['workspace-people', 'workspace-activity', 'workspace-team', 'workspace-backups', 'app-updates', 'workspace-danger']
}

export const settingsGroupLabel = (page: SettingsPageId): string =>
  ({ geral: L('Você', 'You'), agentes: L('Agentes', 'Agents'), modelos: L('Modelos', 'Models'), conexoes: L('Conexões', 'Connections'), workspace: 'Workspace' })[page]

// The groups this person has something in, in order: a member never sees an empty Agents group.
export function settingsGroups(sections: readonly SettingsSection[]): readonly SettingsPageId[] {
  return (Object.keys(tabSections) as SettingsPageId[]).filter((page) => settingsTabStructure(page, sections).some((section) => section.visible))
}

// The subjects of one group, in its reading order, each one still owned — label, keys and access —
// by the structure above.
export function settingsTabStructure(tab: string, sections: readonly SettingsSection[]): readonly SettingsSection[] {
  return (tabSections[tab] ?? [])
    .map(id => sections.find(section => section.id === id))
    .filter((section): section is SettingsSection => section !== undefined)
}

// Where the page's tabs used to be: a link written for one (Settings › Servers, from the sidebar or
// a hint) still lands on its subject, now inside its group.
export const settingsTabAliases: Readonly<Record<string, SettingsSectionId>> = {
  integracoes: 'connections-phone',
  servidores: 'connections-servers',
  harnesses: 'harnesses-keys',
  pessoas: 'workspace-people',
  atividade: 'workspace-activity'
}

// What the search finds besides a subject's name: the controls in it, as a person would call them.
function settingsTerms(): Readonly<Record<SettingsSectionId, readonly string[]>> {
  return {
    'workspace-context': [L('Nome do workspace', 'Workspace name'), L('Como os agentes te chamam', 'What the agents call you'), L('Idioma', 'Language'), L('Contexto', 'Context'), L('Rever a introdução', 'See the introduction again'), L('Mostrar as missões', 'Show the missions'), L('Mostrar a barra lateral inteira', 'Show the whole sidebar')],
    'app-appearance': [L('Tema claro ou escuro', 'Light or dark theme'), L('Idioma', 'Language')],
    'app-notifications': [L('Sons', 'Sounds'), L('Testar uma notificação', 'Test a notification')],
    'app-dictation': [L('Modelo do ditado', 'Dictation model'), L('Microfone', 'Microphone'), L('Detectar o idioma', 'Detect the language'), 'whisper'],
    'app-conversation': [L('Mostrar os passos do agente', 'Show the agent’s steps'), L('O que o modelo pensa', "Show reasoning"), L('Raciocínio', 'Reasoning'), L('Pesquisas', 'Surveys'), L('Enviar feedback', 'Send feedback')],
    'agents-permissions': [L('Aprovações', 'Approvals'), L('Cuidadoso, normal ou sem travas', 'Careful, normal or no locks'), L('Ajustar ação por ação', 'Adjust action by action'), L('Pedir antes depois de ler algo de fora', 'Ask first after reading something from outside')],
    'agents-replies': [L('Respostas ao mesmo tempo numa conversa', "Concurrent replies per conversation"), L('Em paralelo', 'Parallel'), L('Fila', 'Queue'), L('Uma por vez', 'One at a time'), L('Ao mesmo tempo', 'At once')],
    'agents-limits': [L('Limite por agente', 'Limit per agent'), L('Limite por resposta', 'Limit per reply'), L('Tokens por mês', 'Tokens per month'), L('Considerar travado', 'Treat as stuck'), L('Expiração das aprovações', 'Approvals expire'), L('Continuar sozinho', 'Keep going on its own')],
    'agents-routines': [L('Abrir ao ligar o computador', 'Open when the computer starts'), L('Horário de silêncio', 'Quiet hours')],
    'agents-tuca': [L('Aplicar mudanças do Tuca na hora', 'Apply Tuca’s changes right away'), L('Desfazer', 'Undo')],
    'agents-browser': [L('Navegador dos agentes', 'Agents’ browser'), 'Jev', 'TypeSafe'],
    'models-agents': [L('Modelo de cada agente', 'Each agent’s model'), L('Trocar o modelo de vários agentes', 'Change models for several agents')],
    'models-runtimes': ['Claude Code', 'Codex', 'OpenCode', 'Antigravity', L('Endpoint', 'Endpoint')],
    'models-accounts': [L('Login', 'Sign-in'), L('Conta do trabalho e pessoal', 'Work and personal account')],
    'models-classifiers': [L('Usos dos classificadores', 'Classifier Uses'), 'Jev', 'TypeSafe', 'OpenRouter', 'OpenAI', 'Luna', 'Google', 'Gemini', L('Chave do classificador', 'Classifier key')],
    'models-router': [L('Modelo do roteador', 'Router model'), L('Quem responde nos canais', 'Who replies in channels')],
    'knowledge-memory': [L('Modelo da memória', 'Memory model'), L('O que ele aprende sobre você', 'What it learns about you')],
    'connections-phone': ['Telegram', L('Celular', 'Phone'), 'iPhone'],
    'connections-servers': [L('Servidor', 'Server'), L('Emprestar este computador', 'Lend this computer'), L('Apps', 'Apps')],
    'connections-traces': ['OpenTelemetry', 'OTLP', 'Langfuse', 'Grafana', 'Honeycomb', 'Datadog', L('Observabilidade', 'Observability'), L('Latência', 'Latency')],
    'harnesses-keys': ['MCP', L('Chave de acesso', 'Access key'), 'Cursor', 'Claude Code', 'Codex'],
    'workspace-people': [L('Convidar', 'Invite'), L('Papéis', 'Roles'), L('Quem te cobre', 'Who covers for you')],
    'workspace-activity': [L('Registro', 'Log'), L('Quem mudou o quê', 'Who changed what')],
    'workspace-team': [L('Exportar o time', 'Export the team'), L('Importar time', 'Import a team'), 'Hermes', 'OpenBot', 'Grok Bot'],
    'workspace-backups': [L('Backup', 'Backup'), L('Restaurar', 'Restore')],
    'app-updates': [L('Versão', 'Version'), L('Notas da versão', 'Release notes'), L('Procurar atualizações', 'Check for updates')],
    'workspace-danger': [L('Apagar o workspace', 'Delete the workspace'), L('Área de perigo', 'Danger area')]
  }
}

export type SettingsHit = { section: SettingsSection; term: string }

// The search at the top of the page: a subject's name or any of its terms, ignoring accents and
// case, among the subjects this person sees. A subject's own name comes first; at most three terms
// of one subject, so one word doesn't fill the list with a single place.
export function searchSettings(sections: readonly SettingsSection[], query: string): readonly SettingsHit[] {
  const fold = (text: string): string => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  const q = fold(query.trim())
  if (!q) return []
  const terms = settingsTerms()
  const hits: SettingsHit[] = []
  for (const page of Object.keys(tabSections)) {
    for (const section of settingsTabStructure(page, sections)) {
      if (!section.visible) continue
      const own = fold(section.label).includes(q) ? [section.label] : []
      const more = terms[section.id].filter((term) => fold(term).includes(q))
      for (const term of [...own, ...more].slice(0, 3)) hits.push({ section, term })
    }
  }
  return hits
}
