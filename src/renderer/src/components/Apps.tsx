// The person's own apps an agent may use (Notes, Mail…), each to read or to read and
// change, through agent-desktop. Whether it's installed and allowed shows first; apps are
// picked from the ones on the computer, with their icons, the open ones first.
import { L } from '../../../shared/lang'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { desktopPermissions, desktopStatus, installDesktop, installedApps, openApps, openExternal, useStore, type AgentApp, type InstalledApp } from '../store'
import { Icon } from './ui'

type Status = Awaited<ReturnType<typeof desktopStatus>>

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function AppIcon({ app, size = 28 }: { app?: Pick<InstalledApp, 'icon' | 'name'>; size?: number }): ReactNode {
  return app?.icon ? <img className="app-ic" src={app.icon} width={size} height={size} alt="" draggable={false} /> : <span className="app-ic app-ic--blank" style={{ width: size, height: size }}>{(app?.name ?? '?').slice(0, 1)}</span>
}

export function AppsCard({ apps, onChange }: { apps: AgentApp[]; onChange: (apps: AgentApp[]) => void }): ReactNode {
  const [status, setStatus] = useState<Status | null>(null)
  const [shelf, setShelf] = useState<InstalledApp[] | null>(null)
  const [open, setOpen] = useState<{ name: string; bundleId?: string }[]>([])
  const [picking, setPicking] = useState(false)
  const [hint, setHint] = useState('')
  const os = useStore((s) => s.platform)
  const check = (): void => void desktopStatus().then(setStatus, () => setStatus({ installed: false }))
  useEffect(check, [])
  // The installed apps at once (kept by the core); the open ones a moment later, merged in.
  useEffect(() => {
    void installedApps().then(setShelf, () => setShelf([]))
    void openApps().then(setOpen, () => setOpen([]))
  }, [])
  const all = useMemo<InstalledApp[] | null>(() => {
    if (shelf === null) return null
    const same = (a: { name: string; bundleId?: string }, b: { name: string; bundleId?: string }): boolean => (!!a.bundleId && a.bundleId === b.bundleId) || fold(a.name) === fold(b.name)
    const list: InstalledApp[] = shelf.map((a) => ({ ...a, running: open.some((o) => same(o, a)) }))
    for (const o of open) if (!list.some((a) => same(o, a)) && o.name !== 'Electron') list.push({ ...o, running: true })
    return list
  }, [shelf, open])

  const byName = (n: string): InstalledApp | undefined => all?.find((a) => fold(a.name) === fold(n))
  const has = (n: string): boolean => apps.some((a) => fold(a.name) === fold(n))
  const add = (n: string): void => {
    const v = n.trim()
    if (v && !has(v)) onChange([...apps, { name: v, level: 'read' }])
  }
  const level = (n: string, l: AgentApp['level']): void => onChange(apps.map((a) => (a.name === n ? { ...a, level: l } : a)))
  const remove = (n: string): void => onChange(apps.filter((a) => a.name !== n))

  if (status?.server && !status.desktopReady) return <div className="apps-setup"><span className="grow">{L('Desktop da VPS indisponível. O navegador e os computadores Docker continuam separados.', 'VPS desktop unavailable. The browser and Docker computers remain separate.')}<small className="apps-setup__how">{status.suggestion}</small></span><button className="btn btn--sm btn--ghost" onClick={check}>{L('Verificar de novo', 'Check again')}</button></div>
  return (
    <div className="apps-card">
      {status?.server && <p className="hint">{L('Estes apps estão no desktop do servidor conectado. Cada agente só recebe os apps liberados abaixo.', 'These apps run on the connected server’s desktop. Each agent only gets the apps granted below.')}</p>}
      {status && !status.installed && (
        <div className="apps-setup">
          <Icon name="plug" size={16} />
          <span className="grow">{L('Precisa do agent-desktop, que lê e opera os apps pela acessibilidade do sistema.', 'Needs agent-desktop, which reads and operates apps through the system’s accessibility.')}</span>
          <button
            className="btn btn--sm btn--primary"
            onClick={() => void installDesktop().then((r) => setHint(r.needsNode ? L('Instale o Node.js primeiro.', 'Install Node.js first.') : r.opened ? L('Instalando no terminal que abriu…', 'Installing in the terminal that opened…') : r.command))}
          >
            {L('Instalar', 'Install')}
          </button>
          <button className="btn btn--sm btn--ghost" onClick={check}>
            {L('Verificar de novo', 'Check again')}
          </button>
        </div>
      )}
      {hint && (
        <p className="hint">
          {hint}
          {hint.includes('Node') && (
            <button className="btn btn--ghost btn--sm" onClick={() => openExternal('https://nodejs.org/')}>
              {L('Baixar o Node.js', 'Get Node.js')}
            </button>
          )}
        </p>
      )}
      {status?.installed && status.accessibility && !['granted', 'not_required'].includes(status.accessibility) && (
        <div className="apps-setup">
          <Icon name="lock" size={16} />
          <span className="grow">
            {os === 'mac'
              ? L('Falta a permissão de Acessibilidade: libere o Tucano em Ajustes → Privacidade e Segurança → Acessibilidade.', 'The Accessibility permission is missing: allow Tucano in Settings → Privacy & Security → Accessibility.')
              : os === 'linux'
                ? L('O serviço de acessibilidade do Linux (AT-SPI) não respondeu: sem ele não dá pra ler os apps.', "Linux's accessibility service (AT-SPI) didn't answer: without it the apps can't be read.")
                : L('O Windows não deixou ler os apps agora.', "Windows didn't let the apps be read just now.")}
            {os !== 'mac' && status.suggestion && <small className="apps-setup__how">{status.suggestion}</small>}
          </span>
          {os === 'mac' && (
            <button className="btn btn--sm btn--primary" onClick={desktopPermissions}>
              {L('Abrir Ajustes', 'Open Settings')}
            </button>
          )}
          <button className="btn btn--sm btn--ghost" onClick={check}>
            {L('Verificar de novo', 'Check again')}
          </button>
        </div>
      )}

      {apps.length > 0 && (
        <div className="apps-list">
          {apps.map((a) => {
            const info = byName(a.name)
            return (
              <div key={a.name} className="apps-row">
                <AppIcon app={info ?? { name: a.name }} />
                <span className="apps-row__name grow">
                  <strong>{a.name}</strong>
                  {info?.running && <span className="apps-open">{L('aberto', 'open')}</span>}
                </span>
                <div className="segmented" role="radiogroup" aria-label={a.name}>
                  {(['read', 'read_write'] as const).map((l) => (
                    <button key={l} role="radio" aria-checked={a.level === l} className={a.level === l ? 'is-active' : ''} onClick={() => level(a.name, l)}>
                      {l === 'read' ? L('Só ler', 'Read only') : L('Ler e mexer', 'Read and change')}
                    </button>
                  ))}
                </div>
                <button className="icon-btn icon-btn--sm" title={L('Tirar o acesso', 'Remove access')} onClick={() => remove(a.name)}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {picking ? (
        <AppPicker all={all} has={has} onPick={(n) => add(n)} onClose={() => setPicking(false)} />
      ) : (
        <button className="btn btn--sm apps-add" onClick={() => setPicking(true)}>
          <Icon name="plus" size={14} /> {apps.length ? L('Liberar outro app', 'Give another app') : L('Liberar um app', 'Give an app')}
        </button>
      )}
    </div>
  )
}

function AppPicker({ all, has, onPick, onClose }: { all: InstalledApp[] | null; has: (n: string) => boolean; onPick: (n: string) => void; onClose: () => void }): ReactNode {
  const [q, setQ] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  const shown = useMemo(() => (all ?? []).filter((a) => !q.trim() || fold(a.name).includes(fold(q.trim()))), [all, q])
  const open = shown.filter((a) => a.running)
  const rest = shown.filter((a) => !a.running)
  const tile = (a: InstalledApp): ReactNode => {
    const given = has(a.name)
    return (
      <button key={a.bundleId ?? a.name} className={`app-tile ${given ? 'is-given' : ''}`} disabled={given} onClick={() => onPick(a.name)} title={given ? L('Já liberado', 'Already given') : a.name}>
        <span className="app-tile__ic">
          <AppIcon app={a} size={40} />
          {given && (
            <span className="app-tile__check">
              <Icon name="check" size={11} />
            </span>
          )}
        </span>
        <span className="app-tile__name">{a.name}</span>
      </button>
    )
  }
  return (
    <div className="app-picker" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="app-picker__head">
        <Icon name="search" size={15} />
        <input ref={input} className="grow" placeholder={L('Buscar um app…', 'Search for an app…')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="icon-btn icon-btn--sm" title={L('Fechar', 'Close')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      <div className="app-picker__body">
        {all === null && <p className="hint">{L('Procurando os apps…', 'Looking for the apps…')}</p>}
        {open.length > 0 && (
          <>
            <span className="app-picker__label">{L('Abertos agora', 'Open now')}</span>
            <div className="app-grid">{open.map(tile)}</div>
          </>
        )}
        {rest.length > 0 && (
          <>
            <span className="app-picker__label">{L('Todos os apps', 'All apps')}</span>
            <div className="app-grid">{rest.map(tile)}</div>
          </>
        )}
        {all !== null && shown.length === 0 && (
          <p className="hint">
            {L('Nenhum app com esse nome.', 'No app with that name.')}{' '}
            {q.trim() && !has(q) && (
              <button className="btn btn--ghost btn--sm" onClick={() => onPick(q)}>
                {L(`Usar “${q.trim()}” mesmo assim`, `Use “${q.trim()}” anyway`)}
              </button>
            )}
          </p>
        )}
      </div>
    </div>
  )
}
