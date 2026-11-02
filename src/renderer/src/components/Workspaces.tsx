import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { WorkspaceList } from '../../../shared/workspaces'
import { openDialog, useStore } from '../store'
import { Icon } from './ui'

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

export function WorkspaceSelector(): ReactNode {
  const name = useStore((s) => s.settings.workspaceName)
  const { list, error: loadError } = useWorkspaceList()
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
    root.current?.querySelector<HTMLButtonElement>('[role="menuitemradio"]')?.focus()
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const label = <><span className="workspace__logo">{name.slice(0, 1)}</span><span className="workspace__name">{name}</span></>
  if (!api) return <div className="workspace-picker__label" title={name}>{label}</div>
  return (
    <div className="workspace-picker" ref={root}>
      <button ref={button} className="workspace-picker__button" title={name} aria-label={L('Trocar workspace', 'Switch workspace')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="workspace-picker__menu" role="menu" aria-label="Workspaces" onKeyDown={(event) => {
        if (event.key === 'Escape') { setOpen(false); button.current?.focus() }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
          const index = items.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
          items[next]?.focus()
        }
      }}>
        <div className="workspace-picker__head">
          <span className="muted small">Workspaces</span>
          <div className="workspace-picker__actions">
            <button className="icon-btn icon-btn--sm" role="menuitem" disabled={busy} title={L('Criar workspace', 'Create Workspace')} aria-label={L('Criar workspace', 'Create Workspace')} onClick={() => void perform(() => api.create())}><Icon name="plus" size={14} /></button>
            <button className="icon-btn icon-btn--sm" role="menuitem" disabled={busy} title={L('Gerenciar workspaces', 'Manage workspaces')} aria-label={L('Gerenciar workspaces', 'Manage workspaces')} onClick={() => { setOpen(false); openDialog({ kind: 'workspaces' }) }}><Icon name="gear" size={14} /></button>
          </div>
        </div>
        {list?.workspaces.map((w) => <button key={w.id} className="menu__item" role="menuitemradio" aria-checked={w.id === list.selected} disabled={busy} onClick={() => void perform(() => api.switch(w.id))}>
          <span className="workspace-picker__check" aria-hidden="true">{w.id === list.selected && <Icon name="check" size={14} />}</span>
          <span className="grow">{w.name}</span>
          {w.status === 'failed' ? <span className="muted small">{L('Tentar de novo', 'Retry')}</span> : <>
            {!!w.approvals && <span className="badge" title={L('Aprovações', 'Approvals')}>{w.approvals}</span>}
            {!!w.unread && <span className="badge badge--soft" title={L('Não lidas', 'Unread')}>{w.unread}</span>}
          </>}
        </button>)}
        {(error || loadError) && <p className="field__error" role="alert">{error || loadError}</p>}
      </div>}
    </div>
  )
}
