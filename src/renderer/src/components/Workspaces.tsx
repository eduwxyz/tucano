import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { sortWorkspaces, workspaceLabel, type WorkspaceList } from '../../../shared/workspaces'
import type { DesktopPlaces } from '../../../shared/servers'
import { amAdmin, amOwner, getState, navigate, openDialog, shortcut, teamMode, updateSettings, useStore, windowless, type State } from '../store'
import { Icon } from './ui'
import { useServers } from './Servers'
import { useSidebarParts } from './Missions'
import { openFeedback } from './Feedback'
import { topLabel, setHidden, useAvailable, useHidden } from './sidebar-top'

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

// On a server's page in the desktop app: this computer's workspaces and the servers, for the menu.
// Elsewhere (the app's own page, a browser) none: null.
function useDesktopPlaces(): DesktopPlaces | null {
  const api = window.tucano?.places
  const [places, setPlaces] = useState<DesktopPlaces | null>(null)
  useEffect(() => {
    if (!api) return
    let alive = true
    const load = (): void => void api.list().then((p) => alive && setPlaces(p), () => {})
    load()
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api])
  return places
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
// manage), pausing the agents, the theme, and the missions when they were hidden. Conectores and
// Configurações sit at the sidebar's foot (SidebarFoot), where people look for them.
export function WorkspaceMenu(): ReactNode {
  const name = useStore((s) => workspaceLabel(s.settings))
  const platform = useStore((s) => s.platform)
  const paused = useStore((s) => !!s.settings.paused)
  const theme = useStore((s) => s.settings.theme)
  const admin = useStore(amAdmin)
  const missionsHidden = useStore((s) => amOwner(s) && !!s.settings.onboarding?.done && !!s.settings.onboarding.checklistHidden)
  // What the top of the sidebar has, each with whether it's in it: unticking takes it out, ticking brings it back.
  const available = useAvailable()
  const hidden = useHidden()
  const team = useStore(teamMode)
  const { list, error: loadError } = useWorkspaceList()
  const selectedId = list?.selected
  const workspaces = sortWorkspaces(list?.workspaces)
  const servers = useServers()
  // A server's page in the desktop app lists the app's workspaces and servers here, as the app's own
  // menu does, and once it does, the app takes away its bar over the page (src/main/servers.ts).
  const desktop = window.tucano?.places
  const places = useDesktopPlaces()
  const onServer = windowless()
  useEffect(() => {
    if (!desktop || !places) return
    desktop.own(true)
    return () => desktop.own(false)
  }, [desktop, !!places])
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
  return (
    <div className="workspace-picker ws-menu" ref={root}>
      <button ref={button} className="workspace-picker__button" title={name} aria-label={L(`${name}: workspaces e ajustes`, `${name}: workspaces and settings`)} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="workspace__logo">{name.slice(0, 1)}</span>
        {onServer ? (
          <span className="workspace__text">
            <span className="workspace__name">{name}</span>
            <span className="workspace__where"><Icon name="globe" size={11} /> {L('no servidor', 'on the server')}</span>
          </span>
        ) : (
          <span className="workspace__name">{name}</span>
        )}
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
            <span className="ws-menu__label">{servers.length ? L('Neste computador', 'On this computer') : 'Workspaces'}</span>
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
        {/* A server's page in the desktop app: the way back, the app's workspaces and the other servers. */}
        {!api && desktop && places && <>
          <div className="workspace-picker__head"><span className="ws-menu__label">{L('Neste computador', 'On this computer')}</span></div>
          {places.workspaces.map((w) => <button key={w.id} className="menu__item" role="menuitem" onClick={pick(() => desktop.go({ kind: 'workspace', id: w.id }))}>
            <span className="ws-menu__logo" aria-hidden="true">{w.name.slice(0, 1)}</span>
            <span className="grow">{w.name}</span>
          </button>)}
          <div className="workspace-picker__head workspace-picker__head--servers"><span className="ws-menu__label">{L('Servidores', 'Servers')}</span></div>
          {places.servers.map((s) => <button key={s.id} className="menu__item" role="menuitemradio" aria-checked={s.open} onClick={pick(() => { if (!s.open) desktop.go({ kind: 'server', id: s.id }) })}>
            <span className="ws-menu__logo is-server" aria-hidden="true"><Icon name="globe" size={12} /></span>
            {s.open ? <span className="grow">{name} <span className="muted small">{s.name}</span></span> : <span className="grow">{s.name}</span>}
            <span className="workspace-picker__check" aria-hidden="true">{s.open && <Icon name="check" size={14} />}</span>
          </button>)}
          <div className="menu__sep" role="separator" />
        </>}
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
        {missionsHidden && (
          <button className="menu__item" role="menuitem" onClick={pick(() => updateSettings({ onboarding: { ...getState().settings.onboarding, done: true, checklistHidden: false } }))}>
            <Icon name="spark" size={15} />
            <span className="grow">{L('Mostrar as missões', 'Show the missions')}</span>
          </button>
        )}
        <div className="menu__sep" role="separator" />
        <div className="workspace-picker__head"><span className="ws-menu__label">{L('Na barra', 'In the sidebar')}</span></div>
        {available.map((item) => {
          const on = !hidden.includes(item)
          return (
            <button key={item} className="menu__item ws-menu__part" role="menuitemcheckbox" aria-checked={on} onClick={() => setHidden(item, on, true)}>
              <span className={`ws-menu__box ${on ? 'is-on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={11} />}</span>
              <span className="grow ws-menu__part-text">
                <span>{topLabel(item, team)}</span>
                {item === 'approvals' && <span className="ws-menu__sub">{L('Volta quando algo espera por você', 'Comes back when something waits on you')}</span>}
              </span>
            </button>
          )
        })}
        {(error || loadError) && <p className="field__error" role="alert">{error || loadError}</p>}
      </div>}
    </div>
  )
}

// The sidebar's foot: Conectores by name (it's what a new person needs to find) with what needs them
// there, the Cofre under it (what the agents may reach outside, both), and Configurações as the gear
// everyone looks for in this corner.
export function SidebarFoot(): ReactNode {
  const platform = useStore((s) => s.platform)
  const hint = useStore(connectorsHint)
  const onConnectors = useStore((s) => s.view?.kind === 'connectors')
  const onVault = useStore((s) => s.view?.kind === 'vault')
  const onSettings = useStore((s) => s.view?.kind === 'settings')
  const parts = useSidebarParts()
  const fresh = parts.fresh('connectors')
  const onFeedback = useStore((s) => s.dialog?.kind === 'feedback')
  return (
    <div className="sidebar__foot-rows">
      {/* Always in sight, for everyone: the way to tell us something. */}
      <button className={`sidebar__tool ${onFeedback ? 'is-active' : ''}`} onClick={() => void openFeedback()}>
        <Icon name="ask" size={15} />
        <span className="grow">{L('Enviar feedback', 'Send feedback')}</span>
      </button>
      <button className={`sidebar__tool sidebar__tool--connectors ${onConnectors ? 'is-active' : ''}`} title={hint || undefined} onClick={() => (fresh && parts.seen('connectors'), navigate({ kind: 'connectors' }))}>
        <Icon name="plug" size={15} />
        <span className="grow">{L('Conectores', 'Connectors')}</span>
        {hint ? <span className="ws-dot" aria-label={hint} /> : fresh ? <span className="nav-item__new">{L('NOVO', 'NEW')}</span> : null}
      </button>
    <div className="sidebar__tools">
      <button className={`sidebar__tool ${onVault ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'vault' })}>
        <Icon name="key" size={15} />
        <span className="grow">{L('Cofre', 'Vault')}</span>
      </button>
      <button className={`icon-btn sidebar__gear ${onSettings ? 'is-active' : ''}`} title={L(`Configurações (${shortcut(platform, ',')})`, `Settings (${shortcut(platform, ',')})`)} aria-label={L('Configurações', 'Settings')} onClick={() => navigate({ kind: 'settings' })}>
        <Icon name="gear" size={16} />
      </button>
    </div>
    </div>
  )
}
