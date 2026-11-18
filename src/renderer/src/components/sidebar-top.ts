// The items at the top of the sidebar that a person may take out of it, from the item itself (a right
// click, or its "•••"), and bring back from the menu on the workspace's name ("Na barra"). It's only
// how the sidebar looks to that person: the page is still there, and so is what leads to it.
// Aprovações (Pra você) may go too, but comes back by itself while something waits on the person.
// The channels, the agents and the foot (Conectores, Configurações) always stay.
import { L } from '../../../shared/lang'
import { getState, isTeam, teamMode, toast, updateSettings, useStore } from '../store'
import { useHubTabs } from './Hubs'
import { useSidebarParts } from './Missions'

export type TopItem = 'tuca' | 'approvals' | 'board' | 'knowledge' | 'operations'
export const TOP_ITEMS: readonly TopItem[] = ['tuca', 'approvals', 'board', 'knowledge', 'operations']

export const topLabel = (item: TopItem, team: boolean): string =>
  ({
    tuca: 'Tuca',
    approvals: team ? L('Pra você', 'For you') : L('Aprovações', 'Approvals'),
    board: L('Quadro', 'Board'),
    knowledge: L('Conhecimento', 'Knowledge'),
    operations: L('Operação', 'Operations')
  })[item]

const isTop = (x: unknown): x is TopItem => (TOP_ITEMS as readonly unknown[]).includes(x)

// What the person took out, in the order of the sidebar. A string, so a list redraws only when it changes.
export function useHidden(): TopItem[] {
  const kept = useStore((s) => (s.settings.sidebarHidden ?? []).filter(isTop).join(' '))
  return kept ? (kept.split(' ') as TopItem[]) : []
}

// The items this sidebar has at all, hidden or not: the Quadro once there are agents (and a new
// install's missions brought it), a hub once one of its tabs shows.
export function useAvailable(): TopItem[] {
  const parts = useSidebarParts()
  const agents = useStore((s) => s.agents.filter(isTeam).length)
  const knowledge = useHubTabs('knowledge').length
  const operations = useHubTabs('operations').length
  return TOP_ITEMS.filter((i) => (i === 'board' ? agents > 0 && parts.shows('board') : i === 'knowledge' ? knowledge > 0 : i === 'operations' ? operations > 0 : true))
}

// Takes an item out of the sidebar, or brings it back. Taking it out from the item says where it comes
// back from (`quiet`: done from that very place, the menu's list).
export function setHidden(item: TopItem, hide: boolean, quiet = false): void {
  const s = getState()
  const now = (s.settings.sidebarHidden ?? []).filter(isTop)
  if (now.includes(item) === hide) return
  updateSettings({ sidebarHidden: hide ? [...now, item] : now.filter((i) => i !== item) })
  if (hide && !quiet) {
    const name = topLabel(item, teamMode(s))
    toast(L(`${name} saiu da barra. Pra trazer de volta: menu do nome do workspace › Na barra.`, `${name} left the sidebar. To bring it back: the menu on the workspace's name › In the sidebar.`))
  }
}
