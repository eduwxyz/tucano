// Two hubs keep the sidebar short: Conhecimento (Memória · Wiki · Skills) and Operação (Rotinas ·
// Boletim · Uso e limites). Each is one row in the sidebar; the hub draws a big title and the tabs,
// and the page below leaves out its own title (hub-context.ts). The view kinds stay what they were,
// so every link, shortcut and mission that opens one of these pages still lands on it.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { SidebarPart } from '../../../shared/onboarding'
import { amAdmin, navigate, pendingMemories, useStore, type View } from '../store'
import { HubTools, InHub } from './hub-context'
import { useSidebarParts } from './Missions'

export type HubId = 'knowledge' | 'operations'
export type HubTab = 'memory' | 'wiki' | 'skills' | 'routines' | 'report' | 'usage'

const TABS: Record<HubId, HubTab[]> = {
  knowledge: ['memory', 'wiki', 'skills'],
  operations: ['routines', 'report', 'usage']
}

// The hub a view is a tab of. The wiki's editor is a page of its own (its title says what is being
// edited), so it stays out.
export function hubTab(view: View | null | undefined): HubTab | undefined {
  if (!view || (view.kind === 'wiki' && view.edit)) return undefined
  return (Object.values(TABS).flat() as string[]).includes(view.kind) ? (view.kind as HubTab) : undefined
}
export const hubOf = (tab: HubTab | undefined): HubId | undefined => (tab ? (Object.keys(TABS) as HubId[]).find((h) => TABS[h].includes(tab)) : undefined)

export const hubTitle = (hub: HubId): string => (hub === 'knowledge' ? L('Conhecimento', 'Knowledge') : L('Operação', 'Operations'))
const hubLede = (hub: HubId): string =>
  hub === 'knowledge' ? L('O que o time sabe e consulta antes de trabalhar.', 'What the team knows and checks before working.') : L('O que roda sozinho e como o time está indo.', 'What runs on its own and how the team is doing.')

const tabLabel = (tab: HubTab): string =>
  ({ memory: L('Memória', 'Memory'), wiki: 'Wiki', skills: 'Skills', routines: L('Rotinas', 'Routines'), report: L('Boletim', 'Report'), usage: L('Uso e limites', 'Usage and limits') })[tab]

export interface Tab {
  tab: HubTab
  label: string
  badge: number
  fresh: boolean
}

// The tabs a hub shows. On a new install's short sidebar the hub appears once a mission unlocked one
// of its tabs (or one has something in it or waiting), and then with all its tabs: a hub with one tab
// looked like the others were gone. The admin-only ones only for admins.
export function useHubTabs(hub: HubId): Tab[] {
  const parts = useSidebarParts()
  const admin = useStore(amAdmin)
  const suggestions = useStore((s) => pendingMemories(s).length)
  const proposals = useStore((s) => s.skills.filter((k) => k.state === 'pending').length)
  const current = useStore((s) => hubTab(s.view))
  const shows: Record<HubTab, boolean> = {
    memory: parts.shows('memory') || suggestions > 0,
    wiki: parts.shows('wiki'),
    skills: parts.shows('skills') || proposals > 0,
    routines: parts.shows('routines'),
    report: admin && parts.shows('report'),
    usage: admin && parts.shows('usage')
  }
  const badges: Partial<Record<HubTab, number>> = { memory: suggestions, skills: proposals }
  const open = TABS[hub].some((t) => shows[t] || t === current)
  const allowed: Record<HubTab, boolean> = { memory: true, wiki: true, skills: true, routines: true, report: admin, usage: admin }
  return TABS[hub]
    .filter((t) => open && (allowed[t] || t === current))
    .map((t) => ({ tab: t, label: tabLabel(t), badge: badges[t] ?? 0, fresh: parts.fresh(t as SidebarPart) }))
}

// The tab each hub was last on, for this run of the app: the sidebar row goes back to it.
const lastTab: Partial<Record<HubId, HubTab>> = {}

// What a hub's sidebar row opens: what a mission just brought (it's what the "NOVO" is about), else
// the tab last used, else the first.
export function openHub(hub: HubId, tabs: Tab[]): void {
  const pick = tabs.find((t) => t.fresh) ?? tabs.find((t) => t.tab === lastTab[hub]) ?? tabs[0]
  if (pick) navigate({ kind: pick.tab })
}

export function Hub({ tab, children }: { tab: HubTab; children: ReactNode }): ReactNode {
  const hub = hubOf(tab)!
  const tabs = useHubTabs(hub)
  // The element on the right of the tab row. A page inside portals its controls into it once it is
  // mounted; until then the page's own head still draws them.
  const [tools, setTools] = useState<HTMLElement | null>(null)
  const parts = useSidebarParts()
  const fresh = parts.fresh(tab as SidebarPart)
  // Opened, a tab a mission brought stops being new.
  useEffect(() => {
    lastTab[hub] = tab
    if (fresh) parts.seen(tab as SidebarPart)
  }, [hub, tab, fresh])
  const title = hubTitle(hub)
  // Arrows walk the tabs, as in any tab list.
  const keys = (e: KeyboardEvent<HTMLElement>): void => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const at = tabs.findIndex((t) => t.tab === tab)
    const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]
    if (!next) return
    e.preventDefault()
    navigate({ kind: next.tab })
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.hub__tab[data-tab="${next.tab}"]`)?.focus())
  }
  return (
    <section className={`hub hub--${hub}`}>
      <div className="hub__drag" />
      <header className="hub__head">
        <h1 className="hub__title">{title}</h1>
        <p className="hub__lede">{hubLede(hub)}</p>
        <div className="hub__tabs-row">
          <nav className="hub__tabs" role="tablist" aria-label={title} onKeyDown={keys}>
          {tabs.map((t) => (
            <button
              key={t.tab}
              role="tab"
              data-tab={t.tab}
              aria-selected={t.tab === tab}
              tabIndex={t.tab === tab ? 0 : -1}
              className={`hub__tab ${t.tab === tab ? 'is-active' : ''}`}
              onClick={() => navigate({ kind: t.tab })}
            >
              {t.label}
              {t.badge > 0 ? (
                <span key={t.badge} className="badge">
                  {t.badge}
                </span>
              ) : t.fresh ? (
                <span className="nav-item__new">{L('NOVO', 'NEW')}</span>
              ) : null}
            </button>
          ))}
          </nav>
          <div className="hub__tools" ref={setTools} />
        </div>
      </header>
      <div className="hub__body" role="tabpanel" aria-label={tabLabel(tab)}>
        <HubTools.Provider value={tools}>
          <InHub.Provider value={true}>{children}</InHub.Provider>
        </HubTools.Provider>
      </div>
    </section>
  )
}

// The few glyphs the sidebar needs that the shared set doesn't have, drawn the same way (ui.tsx Icon).
const GLYPHS = {
  knowledge: 'M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2zM22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z',
  operations: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  org: 'M9 3h6v5H9zM4 16h6v5H4zM14 16h6v5h-6zM12 8v4M7 16v-4h10v4',
  sliders: 'M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4'
} as const

export function Glyph({ name, size = 16 }: { name: keyof typeof GLYPHS; size?: number }): ReactNode {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={GLYPHS[name]} />
    </svg>
  )
}
