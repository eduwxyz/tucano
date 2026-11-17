import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { sortWorkspaces, workspaceLabel, type WorkspaceList } from '../../../shared/workspaces'
import { amAdmin, navigate, openDialog, shortcut, updateSettings, useStore, type State } from '../store'
import { Icon } from './ui'
import { useServers } from './Servers'
import { useSidebarParts } from './Missions'

export function useWorkspaceList(): { list: WorkspaceList | null; error: string } {
  const [list, setList] = useState<WorkspaceList | null>(null)
  const [error, setError] = useState('')
  const api = window.tucano.workspaces
  useEffect(() => {
    if (!api) return
    let active = true
    const off = api.subscribe((next) => { if (active) setList(next) })
    void api.list().then((next) => { if (active) setList(next) }, (e: unknown) => { if (active) setError(String(e)) })
    return () => { active = false; off() }
  }, [api])
  return { list, error }
}

// What needs the person on the connectors' side: one line for the menu, empty when nothing does.
// A string, so the sidebar redraws only when it changes.
function connectorsHint(s: State): string {
  const auth = s.connectors.filter((c) => c.status === 'needs_auth')
  const broken = s.connectors.filter((c) => c.status === 'error')
  if (auth.length === 1) return L(`${auth[0]!.name} precisa autorizar`, `${auth[0]!.name} needs authorizing`)
  if (auth.length > 1) return L(`${auth.length} precisam autorizar`, `${auth.length} need authorizing`)
  if (broken.length === 1) return L(`${broken[0]!.name} com erro`, `${broken[0]!.name} has an error`)
  if (broken.length > 1) return L(`${broken.length} com erro`, `${broken.length} have errors`)
  return ''
}

// The workspace's name at the top of the sidebar opens this menu: the workspaces (switch, create,
// manage), and what used to sit at the sidebar's foot and top corner: Conectores, Configurações,
// pausing the agents and the theme. A dot by the name says a connector needs the person.
export function WorkspaceMenu(): ReactNode {
  const name = useStore((s) => workspaceLabel(s.settings))
  const platform = useStore((s) => s.platform)
  const paused = useStore((s) => !!s.settings.paused)
  const theme = useStore((s) => s.settings.theme)
  const admin = useStore(amAdmin)
  const hint = useStore(connectorsHint)
  const parts = useSidebarParts()
  const freshConnectors = parts.fresh('connectors')
  const { list, error: loadError } = useWorkspaceList()
  const selectedId = list?.selected
  const workspaces = sortWorkspaces(list?.workspaces)
  const servers = useServers()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const api = window.tucano.workspaces
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', outside)
    const menu = root.current
    ;(menu?.querySelector<HTMLButtonElement>('[role="menuitemradio"][aria-checked="true"]') ?? menu?.querySelector<HTMLButtonElement>('[role^="menuitem"]'))?.focus()
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  // Picking something closes the menu first, so the page it opens isn't under it.
  const pick = (action: () => void) => (): void => {
    setOpen(false)
    action()
  }
  const isDark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  const dot = hint ? <span className="ws-dot" title={hint} aria-label={hint} /> : freshConnectors ? <span className="ws-dot is-fresh" title={L('Conectores: novo', 'Connectors: new')} aria-label={L('Conectores: novo', 'Connectors: new')} /> : null
  return (
    <div className="workspace-picker ws-menu" ref={root}>
      <button ref={button} className="workspace-picker__button" title={name} aria-label={L(`${name}: workspaces e ajustes`, `${name}: workspaces and settings`)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="workspace__logo">{name.slice(0, 1)}</span>
        <span className="workspace__name">{name}</span>
        {dot}
        <span className="ws-menu__caret">
          <Icon name="caret" size={12} />
        </span>
      </button>
      {open && <div className="workspace-picker__menu ws-menu__list" role="menu" aria-label={name} onKeyDown={(event) => {
        if (event.key === 'Escape') { setOpen(false); button.current?.focus() }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        }
      }}>
        {/* The workspaces, where this window can switch them (not in a browser on a server). */}
        {api && <>
          <div className="workspace-picker__head">
            <span className="ws-menu__label">Workspaces</span>
            <div className="workspace-picker__actions">
              <button className="icon-btn icon-btn--sm" role="menuitem" disabled={busy} title={L('Criar workspace', 'Create Workspace')} aria-label={L('Criar workspace', 'Create Workspace')} onClick={pick(() => openDialog({ kind: 'workspaces', create: true }))}><Icon name="plus" size={14} /></button>
            </div>
          </div>
          {workspaces.map((w) => <button key={w.id} className="menu__item" role="menuitemradio" aria-checked={w.id === selectedId} disabled={busy} onClick={() => void perform(() => api.switch(w.id))}>
            <span className="ws-menu__logo" aria-hidden="true">{w.name.slice(0, 1)}</span>
            <span className="grow">{w.name}</span>
            {w.status === 'failed' ? <span className="muted small">{L('Tentar de novo', 'Retry')}</span> : <>
              {!!w.approvals && <span className="badge" title={L('Aprovações', 'Approvals')}>{w.approvals}</span>}
              {!!w.unread && <span className="badge badge--soft" title={L('Não lidas', 'Unread')}>{w.unread}</span>}
            </>}
            <span className="workspace-picker__check" aria-hidden="true">{w.id === selectedId && <Icon name="check" size={14} />}</span>
          </button>)}
          {servers.length > 0 && <>
            <div className="workspace-picker__head workspace-picker__head--servers"><span className="ws-menu__label">{L('Servidores', 'Servers')}</span></div>
            {servers.map((s) => <button key={s.id} className="menu__item" role="menuitemradio" aria-checked={s.open} disabled={busy} onClick={pick(() => window.tucano.servers!.open(s.id))}>
              <span className="ws-menu__logo is-server" aria-hidden="true"><Icon name="globe" size={12} /></span>
              <span className="grow">{s.name}</span>
            </button>)}
          </>}
          <button className="menu__item ws-menu__quiet" role="menuitem" disabled={busy} onClick={pick(() => openDialog({ kind: 'workspaces' }))}>
            {L('Gerenciar workspaces…', 'Manage workspaces…')}
          </button>
          <div className="menu__sep" role="separator" />
        </>}
        <button className="menu__item" role="menuitem" onClick={pick(() => (freshConnectors && parts.seen('connectors'), navigate({ kind: 'connectors' })))}>
          <Icon name="plug" size={15} />
          <span className="grow">{L('Conectores', 'Connectors')}</span>
          {hint ? <span className="ws-menu__hint is-warn">{hint}</span> : freshConnectors ? <span className="nav-item__new">{L('NOVO', 'NEW')}</span> : null}
        </button>
        <button className="menu__item" role="menuitem" onClick={pick(() => navigate({ kind: 'settings' }))}>
          <Icon name="gear" size={15} />
          <span className="grow">{L('Configurações', 'Settings')}</span>
          <span className="ws-menu__hint">{shortcut(platform, ',')}</span>
        </button>
        {admin && (
          <button
            className="menu__item"
            role="menuitem"
            title={paused ? L('Retomar os agentes deste workspace', 'Resume agents in this workspace') : L('Pausar este workspace: nenhum agente começa a trabalhar e nenhuma rotina roda', 'Pause this workspace: no agent starts working and no routine runs')}
            onClick={pick(() => updateSettings({ paused: !paused }))}
          >
            <Icon name={paused ? 'play' : 'pause'} size={15} />
            <span className="grow">{paused ? L('Retomar o time', 'Resume the team') : L('Pausar o time', 'Pause the team')}</span>
          </button>
        )}
        <button className="menu__item" role="menuitem" onClick={pick(() => updateSettings({ theme: isDark ? 'light' : 'dark' }))}>
          <Icon name={isDark ? 'sun' : 'moon'} size={15} />
          <span className="grow">{isDark ? L('Tema claro', 'Light theme') : L('Tema escuro', 'Dark theme')}</span>
        </button>
        {(error || loadError) && <p className="field__error" role="alert">{error || loadError}</p>}
      </div>}
    </div>
  )
}
