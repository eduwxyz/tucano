// The app's screens a link in a message can open: the Tuca writes [Open Connectors](#abrir/connectors)
// and the message shows a button that goes there (the settings ones on their tab).
//
// The ids are language-free on purpose: the Tuca is taught these in its prompt on every message, and
// a Portuguese id in an English workspace is Portuguese leaving the app through the back door. The
// Portuguese ids messages and memories already carry keep working, as aliases.
import { L } from './lang'

export interface Screen {
  label: () => string
  view: 'connectors' | 'routines' | 'skills' | 'memory' | 'wiki' | 'approvals' | 'usage' | 'report' | 'settings'
  tab?: string // a settings tab: geral, modelos, agentes, integracoes
}

export const SCREENS: Record<string, Screen> = {
  connectors: { label: () => L('Conectores', 'Connectors'), view: 'connectors' },
  routines: { label: () => L('Rotinas', 'Routines'), view: 'routines' },
  skills: { label: () => L('Skills', 'Skills'), view: 'skills' },
  memory: { label: () => L('Memória', 'Memory'), view: 'memory' },
  wiki: { label: () => L('Wiki', 'Wiki'), view: 'wiki' },
  approvals: { label: () => L('Aprovações', 'Approvals'), view: 'approvals' },
  usage: { label: () => L('Uso e limites', 'Usage and limits'), view: 'usage' },
  report: { label: () => L('Boletim', 'Report'), view: 'report' },
  settings: { label: () => L('Configurações', 'Settings'), view: 'settings', tab: 'geral' },
  'settings/models': { label: () => L('Configurações › Modelos', 'Settings › Models'), view: 'settings', tab: 'modelos' },
  'settings/agents': { label: () => L('Configurações › Agentes', 'Settings › Agents'), view: 'settings', tab: 'agentes' },
  'settings/phone': { label: () => L('Configurações › Celular e GitHub', 'Settings › Phone and GitHub'), view: 'settings', tab: 'integracoes' }
}

// The ids that came before the English ones, which messages, memories and the guide already carry.
export const SCREEN_ALIASES: Record<string, string> = {
  conectores: 'connectors',
  rotinas: 'routines',
  memoria: 'memory',
  aprovacoes: 'approvals',
  uso: 'usage',
  boletim: 'report',
  configuracoes: 'settings',
  'configuracoes/modelos': 'settings/models',
  'configuracoes/agentes': 'settings/agents',
  'configuracoes/integracoes': 'settings/phone'
}

// "#abrir/connectors" → the screen, or undefined. An agent's page is "#abrir/agente/<handle>".
export function screenOf(href: string | undefined): { screen?: Screen; agentHandle?: string } | undefined {
  if (!href?.startsWith('#abrir/')) return undefined
  const path = decodeURIComponent(href.slice('#abrir/'.length))
  // "agent/" and the older "agente/": a link already written in a message keeps resolving.
  const profile = ['agent/', 'agente/'].find((p) => path.startsWith(p))
  if (profile) return { agentHandle: path.slice(profile.length) }
  const screen = SCREENS[path] ?? SCREENS[SCREEN_ALIASES[path] ?? '']
  return screen ? { screen } : undefined
}
