// The items at the top of the sidebar that a person may take out of it, from the item itself (a right
// click, or its "•••"), and bring back where they were (the "N escondidos" line under them, the toast's
// "Desfazer") or from the menu on the workspace's name ("Na barra"). It's only how the sidebar looks to
// that person: the page is still there, and so is what leads to it.
// Aprovações (Pra você) and Conhecimento may go too, but come back by themselves while something waits
// on the person in them (an approval; a memory suggested, a skill proposed).
// The channels, the agents and the foot (Conectores, Configurações) always stay.
import { L } from '../../../shared/lang'
import { getState, inboxCount, isTeam, pendingApprovals, teamMode, toast, updateSettings, useStore } from '../store'
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
  if (hide && !quiet) toast(L(`${topLabel(item, teamMode(s))} saiu da barra.`, `${topLabel(item, teamMode(s))} left the sidebar.`), { label: L('Desfazer', 'Undo'), run: () => setHidden(item, false) })
}

// What waits on the person in an item that may come back by itself: Aprovações' approvals (Pra você's
// whole inbox, with people), Conhecimento's suggested memories and proposed skills.
export function useWaitingIn(): Partial<Record<TopItem, number>> {
  const approvals = useStore((s) => (teamMode(s) ? inboxCount(s) : pendingApprovals(s).length))
  const knowledge = useHubTabs('knowledge').reduce((n, t) => n + t.badge, 0)
  return { approvals, knowledge }
}
