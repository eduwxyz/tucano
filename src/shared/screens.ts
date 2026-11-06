// The app's screens a link in a message can open: the Tuca writes [Abrir Conectores](#abrir/conectores)
// and the message shows a button that goes there (the settings ones on their tab).
import { L } from './lang'

export interface Screen {
  label: () => string
  view: 'connectors' | 'routines' | 'skills' | 'memory' | 'wiki' | 'approvals' | 'usage' | 'report' | 'settings'
  tab?: string // a settings tab: geral, modelos, agentes, integracoes
}

export const SCREENS: Record<string, Screen> = {
  conectores: { label: () => L('Conectores', 'Connectors'), view: 'connectors' },
  rotinas: { label: () => L('Rotinas', 'Routines'), view: 'routines' },
  skills: { label: () => L('Skills', 'Skills'), view: 'skills' },
  memoria: { label: () => L('Memória', 'Memory'), view: 'memory' },
  wiki: { label: () => L('Wiki', 'Wiki'), view: 'wiki' },
  aprovacoes: { label: () => L('Aprovações', 'Approvals'), view: 'approvals' },
  uso: { label: () => L('Uso e limites', 'Usage and limits'), view: 'usage' },
  boletim: { label: () => L('Boletim', 'Report'), view: 'report' },
  configuracoes: { label: () => L('Configurações', 'Settings'), view: 'settings', tab: 'geral' },
  'configuracoes/modelos': { label: () => L('Configurações › Modelos', 'Settings › Models'), view: 'settings', tab: 'modelos' },
  'configuracoes/agentes': { label: () => L('Configurações › Agentes', 'Settings › Agents'), view: 'settings', tab: 'agentes' },
  'configuracoes/integracoes': { label: () => L('Configurações › Celular e GitHub', 'Settings › Phone and GitHub'), view: 'settings', tab: 'integracoes' }
}

// "#abrir/conectores" → the screen, or undefined. An agent's page is "#abrir/agente/<handle>".
export function screenOf(href: string | undefined): { screen?: Screen; agentHandle?: string } | undefined {
  if (!href?.startsWith('#abrir/')) return undefined
  const path = decodeURIComponent(href.slice('#abrir/'.length))
  if (path.startsWith('agente/')) return { agentHandle: path.slice('agente/'.length) }
  const screen = SCREENS[path]
  return screen ? { screen } : undefined
}
