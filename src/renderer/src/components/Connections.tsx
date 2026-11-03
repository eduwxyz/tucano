import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { DEFAULT_PORT, formatPairLink, parsePairLink, parseServerUrl, parseSshTarget, type Reach } from '../../../shared/pairlink'
import type { RemoteState } from '../rpc'
import { useStore } from '../store'

const endpoint = (reach: Reach): string => reach.via === 'url' ? reach.url : `${reach.user}@${reach.host.includes(':') ? `[${reach.host}]` : reach.host}:${reach.port}`

// Never echo a native exception: it may contain a pairing link, code or credentials.
function connectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/code|expired|pair|401|403|unauthorized/i.test(message)) return L('Código expirado, inválido ou acesso revogado. Gere um novo código no servidor e tente parear novamente.', 'Code expired, invalid or access revoked. Generate a new code on the server and pair again.')
  if (/ssh|host key|permission denied/i.test(message)) return L('Verifique o usuário, endereço, chave SSH e host conhecido. Teste a conexão SSH no Terminal primeiro.', 'Check the user, address, SSH key and known host. Test the SSH connection in Terminal first.')
  return L('Não foi possível conectar. Verifique o serviço no servidor, endereço, porta e rede. Tente reconectar ou use o modo local.', 'Could not connect. Check the server service, address, port and network. Reconnect or use local mode.')
}

// Native modal dialogs make the page inert, but Chromium can still move focus
// into browser chrome at a Tab boundary. Keep keyboard traversal in this dialog.
// Recompute each time: pairing disables controls and profile edits add/remove them.
function keepDialogFocus(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
  const dialog = event.currentTarget
  const controls = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
    .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
  const first = controls[0]
  const last = controls.at(-1)
  const active = document.activeElement
  if (!first || !last) {
    event.preventDefault()
    dialog.focus()
  } else if (!controls.some((element) => element === active)) {
    event.preventDefault()
    const target = event.shiftKey ? last : first
    target.focus()
  } else if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
  }
}

export function Connections({ children }: { children: ReactNode }): ReactNode {
  const api = window.tucano?.remote
  useStore((s) => s.settings.language)
  const [state, setState] = useState<RemoteState>({ active: null, profiles: [], status: 'local' })
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'link' | 'ssh' | 'url'>('link')
  const [link, setLink] = useState('')
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const received = useRef<string | undefined>(undefined)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (!api) return
    let alive = true
    let eventReceived = false
    const accept = (next: RemoteState): void => {
      if (!alive) return
      setState(next)
      if (next.pairLink && next.pairLink !== received.current) {
        received.current = next.pairLink
        setLink(next.pairLink)
        setName('')
        setMode('link')
        setError('')
        setOpen(true)
      }
    }
    const unsubscribe = api.onState((next) => { eventReceived = true; accept(next) })
    void api.state().then((next) => { if (!eventReceived) accept(next) }).catch(() => {
      if (alive && !eventReceived) setError(L('Não foi possível carregar as conexões. Feche e abra o aplicativo para tentar novamente.', 'Could not load connections. Restart the app to try again.'))
    })
    return () => { alive = false; unsubscribe() }
  }, [api])

  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])

  if (!api) return children

  const current = state.profiles.find((profile) => profile.id === state.active)
  const status = state.status === 'connected' ? L('Conectado', 'Connected') : state.status === 'connecting' ? L('Conectando…', 'Connecting…') : state.status === 'error' ? L('Sem conexão', 'Disconnected') : L('Local', 'Local')
  const act = async (action: () => Promise<void>): Promise<boolean> => {
    if (locked.current) return false
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await action()
      setState(await api.state())
      return true
    } catch (e) {
      setError(connectionError(e))
      return false
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const candidate = (): string => {
    if (mode === 'link') return link.trim()
    const reach: Reach | undefined = mode === 'ssh' ? parseSshTarget(address.trim()) : (() => {
      const url = parseServerUrl(address.trim())
      return url ? { via: 'url', url } : undefined
    })()
    if (!reach || (mode === 'ssh' && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))) return ''
    return formatPairLink({ reach, code: code.trim(), name: name.trim(), remotePort: Number(port) })
  }
  const parsed = parsePairLink(candidate())
  const pair = async (): Promise<void> => {
    if (!parsed.ok) { setError(L('Confira o link, endereço, portas e código de 12 caracteres.', 'Check the link, address, ports and 12-character code.')); return }
    if (await act(() => api.pair(formatPairLink({ ...parsed.link, name: name.trim() || parsed.link.name })))) {
      setCode(''); setLink(''); setOpen(false)
    }
  }

  return (
    <div className="connection-shell">
      <header className="connection-bar">
        <button className="connection-switch" onClick={() => setOpen(true)} aria-haspopup="dialog">
          <span className={`connection-dot connection-dot--${state.status}`} />
          <strong>{current?.name ?? L('Este computador', 'This computer')}</strong>
          <span>{status}</span><span aria-hidden="true">▾</span>
        </button>
        {(state.status === 'error' || error) && <button className="btn btn--ghost btn--xs" onClick={() => setOpen(true)}>{L('Gerenciar conexão', 'Manage connection')}</button>}
      </header>
      <div className="connection-content">{children}</div>
      <dialog ref={dialog} tabIndex={-1} onKeyDown={keepDialogFocus} className="connection-dialog" aria-labelledby="connection-title" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
        <header className="connection-heading"><h2 id="connection-title">{L('Ambientes', 'Environments')}</h2><button className="btn btn--ghost" onClick={() => setOpen(false)} aria-label={L('Fechar', 'Close')}>×</button></header>
        <p className="muted">{L('Alterne entre este computador e suas VPS. Cada ambiente tem seus próprios agentes, dados e ferramentas.', 'Switch between this computer and your VPS servers. Each environment has its own agents, data and tools.')}</p>
        <div className="connection-profiles">
          <div className={`connection-profile connection-profile--local ${state.status === 'local' ? 'is-selected' : ''}`}>
            <div><span className="connection-kind">{L('LOCAL', 'LOCAL')}</span><strong>{L('Este computador', 'This computer')}</strong><small>{L('Agentes e arquivos neste dispositivo', 'Agents and files on this device')}</small></div>
            <button className="btn btn--sm" disabled={busy || state.status === 'local'} onClick={() => void act(() => api.select(null))}>{state.status === 'local' ? L('Em uso', 'In use') : L('Usar local', 'Use local')}</button>
          </div>
          <h3 className="connection-section">{L('Seus servidores', 'Your servers')} <span>{state.profiles.length}</span></h3>
          {state.profiles.length === 0 && <p className="connection-empty">{L('Nenhuma VPS adicionada. Pareie seu primeiro servidor abaixo; você pode salvar vários ambientes e alternar entre eles quando quiser.', 'No VPS added yet. Pair your first server below; you can save multiple environments and switch whenever you need.')}</p>}
          {state.profiles.map((profile) => <div className={`connection-profile ${state.active === profile.id ? 'is-selected' : ''}`} key={profile.id} data-connection-id={profile.id}>
            <div><span className="connection-kind">{profile.reach.via === 'ssh' ? 'SSH' : profile.reach.url.startsWith('https:') ? 'HTTPS' : 'TAILSCALE / LOCAL'}</span><strong>{profile.name}</strong><small>{endpoint(profile.reach)}{profile.reach.via === 'ssh' ? ` → :${profile.remotePort}` : ''}</small><small className={state.active === profile.id ? 'connection-selected' : ''}>{state.active === profile.id ? `${L('Selecionado', 'Selected')} · ${status}` : L('Salvo neste computador', 'Saved on this computer')}</small></div>
            <div className="connection-actions">
              <button className="btn btn--sm" disabled={busy} onClick={() => void act(() => api.select(profile.id))}>{state.active === profile.id ? L('Reconectar', 'Reconnect') : L('Conectar', 'Connect')}</button>
              {api.rename && <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setRenaming(profile.id); setNewName(profile.name); setForgetting(null) }}>{L('Renomear', 'Rename')}</button>}
              <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => { setForgetting(profile.id); setRenaming(null) }}>{L('Esquecer', 'Forget')}</button>
            </div>
            {renaming === profile.id && <form className="connection-rename" onSubmit={(e) => { e.preventDefault(); if (api.rename && newName.trim()) void act(() => api.rename!(profile.id, newName.trim())).then((ok) => { if (ok) setRenaming(null) }) }}>
              <label>{L('Nome do ambiente', 'Environment name')}<input autoFocus value={newName} maxLength={60} disabled={busy} placeholder={L('Ex.: Produção, Desenvolvimento', 'e.g. Production, Development')} onChange={(e) => setNewName(e.target.value)} /></label>
              <div className="connection-actions"><button className="btn btn--primary btn--sm" type="submit" disabled={busy || !newName.trim()}>{L('Salvar nome', 'Save name')}</button><button className="btn btn--sm" type="button" disabled={busy} onClick={() => setRenaming(null)}>{L('Cancelar', 'Cancel')}</button></div>
            </form>}
            {forgetting === profile.id && <div className="connection-forget"><p>{L('Remover esta conexão e seu token deste computador? Os dados no servidor não serão apagados. Para revogar o acesso, remova o dispositivo no servidor.', 'Remove this connection and its token from this computer? Server data will not be deleted. To revoke access, remove the device on the server.')}</p><div className="connection-actions"><button className="btn btn--danger btn--sm" disabled={busy} onClick={() => void act(() => api.forget(profile.id)).then((ok) => { if (ok) setForgetting(null) })}>{L('Esquecer conexão', 'Forget connection')}</button><button className="btn btn--sm" disabled={busy} onClick={() => setForgetting(null)}>{L('Cancelar', 'Cancel')}</button></div></div>}
          </div>)}
        </div>
        {(error || state.error || state.status === 'error') && <p role="alert" className="connection-error">{error || connectionError(state.error)}</p>}
        {busy && <p role="status" className="muted">{L('Processando a solicitação. Fechar esta janela não cancela a operação em andamento.', 'Working on your request. Closing this window does not cancel the current operation.')}</p>}
        <form className="connection-form" onSubmit={(e) => { e.preventDefault(); void pair() }}>
          <h3>{L('Adicionar ambiente', 'Add environment')}</h3>
          <label>{L('Como conectar', 'Connection method')}<select value={mode} disabled={busy} onChange={(e) => { setMode(e.target.value as typeof mode); setAddress(''); setError('') }}><option value="link">{L('Colar link de pareamento', 'Paste pairing link')}</option><option value="ssh">SSH</option><option value="url">HTTPS / Tailscale</option></select></label>
          {mode === 'link' ? <label>{L('Link de pareamento (privado)', 'Pairing link (private)')}<input type="password" autoComplete="off" spellCheck={false} value={link} disabled={busy} onChange={(e) => setLink(e.target.value)} placeholder="tucano://pair?…" /></label> : <>
            <label>{mode === 'ssh' ? L('Usuário e host SSH (porta SSH opcional)', 'SSH user and host (optional SSH port)') : L('Endereço do servidor', 'Server URL')}<input value={address} disabled={busy} onChange={(e) => setAddress(e.target.value)} placeholder={mode === 'ssh' ? 'user@host:22' : 'https://tucano.example.com'} autoComplete="off" spellCheck={false} /></label>
            {mode === 'ssh' && <label>{L('Porta do serviço Tucano no servidor', 'Tucano service port on server')}<input type="number" min="1" max="65535" value={port} disabled={busy} onChange={(e) => setPort(e.target.value)} /></label>}
            <label>{L('Código de pareamento', 'Pairing code')}<input type="password" autoComplete="off" spellCheck={false} value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} placeholder="XXXX-XXXX-XXXX" /></label>
          </>}
          <label>{L('Nome do ambiente (opcional)', 'Environment name (optional)')}<input value={name} maxLength={60} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder={L('Ex.: Produção, Desenvolvimento', 'e.g. Production, Development')} /></label>
          <p className="muted small">{L('Gere um código com “tucano-server pair” no servidor. SSH usa sua chave e hosts conhecidos; conecte pelo Terminal primeiro. HTTP só é permitido em localhost ou Tailscale. Revise o destino antes de parear.', 'Generate a code with “tucano-server pair” on the server. SSH uses your key and known hosts; connect in Terminal first. HTTP is only allowed on localhost or Tailscale. Review the destination before pairing.')}</p>
          {!parsed.ok && (mode === 'link' ? link.trim() : address.trim() && code.trim()) && <p className="connection-error">{L('Confira o endereço, portas e código de 12 caracteres. Use o link completo gerado pelo servidor, ou HTTPS / HTTP no Tailscale.', 'Check the address, ports and 12-character code. Use the full server-generated link, or HTTPS / HTTP on Tailscale.')}</p>}
          {parsed.ok && <p className="connection-preview"><strong>{name.trim() || parsed.link.name}</strong><span>{endpoint(parsed.link.reach)}{parsed.link.reach.via === 'ssh' ? ` → localhost:${parsed.link.remotePort}` : ''}</span></p>}
          <button type="submit" className="btn btn--primary" disabled={busy || !parsed.ok}>{busy ? L('Aguarde…', 'Please wait…') : L('Parear e conectar', 'Pair and connect')}</button>
        </form>
      </dialog>
    </div>
  )
}
