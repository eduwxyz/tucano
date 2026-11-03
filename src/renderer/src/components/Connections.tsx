import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { DEFAULT_PORT, formatPairLink, parsePairLink, parseServerUrl, parseSshTarget, type Reach } from '../../../shared/pairlink'
import type { RemoteState } from '../rpc'
import { useStore } from '../store'
import { Icon } from './ui'

const endpoint = (reach: Reach): string => reach.via === 'url' ? reach.url : `${reach.user}@${reach.host.includes(':') ? `[${reach.host}]` : reach.host}:${reach.port}`
type Profile = RemoteState['profiles'][number]
type View = 'select' | 'manage' | 'add'
type Operation = { kind: 'pair' | 'select' | 'rename' | 'forget' | 'load'; name?: string; id?: string | null }
type Failure = { message: string; operation?: Operation; paired?: boolean }

// Never echo a native exception: it may contain a pairing link, code or credentials.
function connectionError(error: unknown, fallback?: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (/Server paired and saved, but connection failed/i.test(message)) return L('O ambiente foi pareado e salvo, mas não conectou. Volte aos ambientes e use Conectar na conexão salva, sem gerar um novo código. O código anterior já foi usado.', 'The environment was paired and saved, but could not connect. Return to your environments and use Connect on the saved connection, without generating a new code. The previous code has already been used.')
  if (/Cannot keep unsent drafts/i.test(message)) return L('Não foi possível preservar o rascunho. Seu ambiente não mudou. Aguarde a confirmação do envio ou o preparo das imagens e tente novamente, ou salve o rascunho antes de alternar.', 'Could not preserve your draft. Your environment has not changed. Wait for the pending send or image preparation to finish and retry, or save the draft before switching.')
  if (/Cannot read saved servers|Saved servers are unreadable/i.test(message)) return L('Não foi possível ler as conexões salvas. Seus dados no servidor não foram alterados. Restaure o arquivo de conexões de um backup antes de tentar novamente.', 'Could not read saved connections. Your server data has not changed. Restore the connections file from a backup before trying again.')
  if (/server identity (?:changed|mismatch)|identity mismatch/i.test(message)) return L('A identidade deste servidor mudou. Confirme o endereço e a VPS antes de continuar. Se a mudança era esperada, gere um novo código e pareie novamente.', 'This server’s identity changed. Verify the address and VPS before continuing. If the change was expected, generate a new code and pair again.')
  if (/server identity|verify.*identity/i.test(message)) return L('Não foi possível verificar a identidade do servidor. Confira o endereço e atualize o Tucano na VPS antes de reconectar.', 'Could not verify the server’s identity. Check the address and update Tucano on the VPS before reconnecting.')
  if (/secure storage|keychain|system.*vault|unlock.*token|save.*token securely/i.test(message)) return L('O armazenamento seguro está indisponível ou bloqueado. Desbloqueie o cofre de senhas do sistema (Chaves no macOS) e tente novamente.', 'Secure storage is unavailable or locked. Unlock the system credential store (Keychain on macOS) and try again.')
  if (/plaintext HTTP|requires? HTTPS|HTTPS (?:is )?required|Configure HTTPS|insecure (?:server )?URL/i.test(message)) return L('Esta conexão salva precisa de HTTPS, inclusive no Tailscale. Configure HTTPS ou Tailscale Serve e pareie novamente com o endereço seguro, ou esqueça a conexão antiga.', 'This saved connection requires HTTPS, including on Tailscale. Configure HTTPS or Tailscale Serve and pair again with the secure address, or forget the old connection.')
  if (/code|expired|pair|401|403|unauthorized/i.test(message)) return L('Código expirado, inválido ou acesso revogado. Gere um novo código no servidor e tente parear novamente.', 'Code expired, invalid or access revoked. Generate a new code on the server and pair again.')
  if (/ssh|host key|permission denied/i.test(message)) return L('Verifique o usuário, endereço, chave SSH e host conhecido. Teste a conexão SSH no Terminal primeiro.', 'Check the user, address, SSH key and known host. Test the SSH connection in Terminal first.')
  return fallback ?? L('Não foi possível conectar. Verifique o serviço no servidor, endereço, porta e rede. Tente reconectar ou use o modo local.', 'Could not connect. Check the server service, address, port and network. Reconnect or use local mode.')
}

// Recompute each time: pending operations disable controls and profile edits add them.
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
  const [view, setView] = useState<View>('select')
  const [operation, setOperation] = useState<Operation | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const locked = useRef(false)
  const visible = useRef(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [mode, setMode] = useState<'link' | 'ssh' | 'url'>('link')
  const [link, setLink] = useState('')
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [port, setPort] = useState(String(DEFAULT_PORT))
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [forgetting, setForgetting] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const received = useRef<string | number | undefined>(undefined)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const busy = operation !== null || !!state.switching || loading

  useEffect(() => {
    if (!api) return
    let alive = true
    let eventReceived = false
    const accept = (next: RemoteState): void => {
      if (!alive) return
      setState(next)
      setLoading(false)
      setLoadFailed(false)
      setFailure((previous) => previous?.operation?.kind === 'load' ? null : previous)
      const arrival = next.pairLinkId ?? next.pairLink
      if (next.pairLink && arrival !== received.current) {
        received.current = arrival
        setLink(next.pairLink)
        setCode(''); setAddress(''); setPort(String(DEFAULT_PORT)); setName('')
        setMode('link'); setTouched({}); setFailure(null)
        setForgetting(null); setRenaming(null); setView('add')
        visible.current = true
        setOpen(true)
      }
    }
    const unsubscribe = api.onState((next) => { eventReceived = true; accept(next) })
    void api.state().then((next) => { if (!eventReceived) accept(next) }).catch(() => {
      if (alive && !eventReceived) {
        setLoading(false); setLoadFailed(true)
        setFailure({ message: L('Não foi possível carregar as conexões. Tente carregar novamente.', 'Could not load connections. Try loading them again.'), operation: { kind: 'load' } })
      }
    })
    return () => { alive = false; unsubscribe() }
  }, [api])

  useEffect(() => {
    if (open) {
      if (!dialog.current?.open) dialog.current?.showModal()
    } else if (dialog.current?.open) {
      dialog.current.close()
      trigger.current?.focus()
    }
  }, [open])

  useEffect(() => {
    if (open) {
      scroll.current?.scrollTo(0, 0)
      heading.current?.focus()
    }
  }, [open, view])

  useEffect(() => {
    if (open && busy) closeButton.current?.focus()
  }, [open, busy])

  if (!api) return children

  const current = state.profiles.find((profile) => profile.id === state.active)
  const profilesUnavailable = /Cannot read saved servers|Saved servers are unreadable/i.test(state.error ?? '')
  const status = state.status === 'connected' ? L('Conectado', 'Connected') : state.status === 'connecting' ? L('Conectando…', 'Connecting…') : state.status === 'error' ? L('Sem conexão', 'Disconnected') : L('Local', 'Local')
  const resetDraft = (): void => {
    setLink(''); setCode(''); setAddress(''); setName(''); setPort(String(DEFAULT_PORT))
    setMode('link'); setTouched({})
  }
  const show = (): void => { visible.current = true; setOpen(true) }
  const dismiss = (): void => {
    visible.current = false; setOpen(false)
    // A pending native request continues. Reopening must show that same locked request.
    if (!locked.current && !state.switching) {
      resetDraft(); setView('select'); setRenaming(null); setForgetting(null)
    }
  }
  const navigate = (next: View): void => {
    if (busy) return
    setView(next); setRenaming(null); setForgetting(null)
    if (view === 'add') resetDraft()
  }
  const add = (profile?: Profile): void => {
    if (busy || loadFailed || profilesUnavailable) return
    resetDraft(); setFailure(null); setForgetting(null); setRenaming(null)
    if (profile) {
      setMode(profile.reach.via === 'ssh' ? 'ssh' : 'url')
      setAddress(endpoint(profile.reach)); setPort(String(profile.remotePort)); setName(profile.name)
    }
    setView('add')
  }
  const act = async (action: () => Promise<void>, next: Operation): Promise<boolean> => {
    if (locked.current || state.switching || loading) return false
    const arrival = received.current
    locked.current = true; setOperation(next); setFailure(null)
    let completed = false
    try {
      await action()
      completed = true
      setState(await api.state()); setLoadFailed(false)
      return true
    } catch (error) {
      // A failed refresh must not invite repeating an operation that already succeeded.
      if (completed) {
        setLoadFailed(true)
        if (received.current === arrival) setFailure({ operation: { kind: 'load' }, message: next.kind === 'load'
          ? L('Não foi possível carregar as conexões. Tente carregar novamente.', 'Could not load connections. Try loading them again.')
          : L('A operação terminou, mas não foi possível atualizar a lista. Carregue as conexões novamente antes de continuar.', 'The operation finished, but the list could not refresh. Load connections again before continuing.') })
        return next.kind !== 'load'
      }
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
      const paired = /Server paired and saved, but connection failed/i.test(message)
      const fallback = next.kind === 'rename' ? L('Não foi possível salvar o nome. Tente novamente.', 'Could not save the name. Try again.') : next.kind === 'forget' ? L('Não foi possível remover a conexão. Tente novamente.', 'Could not remove the connection. Try again.') : undefined
      if (received.current === arrival) setFailure({ message: connectionError(error, fallback), operation: next, paired })
      // Pairing can save the profile before connection fails. Recover from the saved entry.
      try { setState(await api.state()) } catch { /* Keep the last known state. */ }
      if (paired && received.current === arrival) { setLink(''); setCode('') }
      return false
    } finally {
      locked.current = false; setOperation(null)
      if (!visible.current) { setLink(''); setCode('') }
    }
  }
  const select = async (id: string | null): Promise<void> => {
    const target = state.profiles.find((profile) => profile.id === id)
    const arrival = received.current
    if (await act(() => api.select(id), { kind: 'select', id, name: target?.name ?? L('Este computador', 'This computer') })) {
      // A newer incoming pairing link is a separate request and must remain reviewable.
      if (received.current === arrival) dismiss()
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
    if (!parsed.ok) { setTouched({ link: true, address: true, port: true, code: true }); return }
    const arrival = received.current
    if (await act(() => api.pair(formatPairLink({ ...parsed.link, name: name.trim() || parsed.link.name })), { kind: 'pair', name: name.trim() || parsed.link.name })) {
      if (received.current === arrival) { resetDraft(); setView('select'); dismiss() }
    }
  }
  const validation = (() => {
    if (mode === 'link') return touched.link && link.trim() && !parsed.ok
      ? { field: 'link', message: L('Cole o link tucano://pair completo gerado pelo servidor. Links de navegador e códigos isolados não funcionam aqui.', 'Paste the complete tucano://pair link generated by the server. Browser links and codes alone do not work here.') } : undefined
    if (touched.address && address.trim() && !(mode === 'ssh' ? parseSshTarget(address.trim()) : parseServerUrl(address.trim()))) return { field: 'address', message: mode === 'ssh'
      ? L('Use usuário@host ou usuário@host:porta. A porta SSH deve estar entre 1 e 65535.', 'Use user@host or user@host:port. The SSH port must be between 1 and 65535.')
      : L('Use HTTPS, inclusive no Tailscale, sem caminho ou parâmetros. HTTP só é permitido em localhost.', 'Use HTTPS, including on Tailscale, without a path or parameters. HTTP is only allowed on localhost.') }
    if (mode === 'ssh' && touched.port && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return { field: 'port', message: L('A porta do serviço deve estar entre 1 e 65535.', 'The service port must be between 1 and 65535.') }
    if (touched.code && code.trim() && !/^[A-HJ-NP-Z2-9]{12}$/.test(code.toUpperCase().replace(/[^A-Z0-9]/g, ''))) return { field: 'code', message: L('Use o código de 12 caracteres gerado pelo servidor.', 'Use the 12-character code generated by the server.') }
    return undefined
  })()
  const touch = (field: string): void => setTouched((previous) => ({ ...previous, [field]: true }))
  const shownError = failure?.message || (view !== 'add' && (state.error || state.status === 'error') ? connectionError(state.error) : '')
  const pairedFailure = failure?.paired || /Server paired and saved, but connection failed/i.test(state.error ?? '')
  const connectionFailure = !failure || failure.operation?.kind === 'select'
  const recovery = state.profiles.find((profile) => profile.id === (failure?.operation?.kind === 'select' ? failure.operation.id : state.active))
  const errorTarget = failure?.operation?.name ?? (view !== 'add' && state.status === 'error' ? current?.name : undefined)
  const focusAction = (id: string, action: 'rename' | 'forget'): void => {
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLButtonElement>(`[data-connection-id="${CSS.escape(id)}"] [data-connection-action="${action}"]`)?.focus())
  }
  const title = view === 'add' ? L('Adicionar ambiente', 'Add environment') : view === 'manage' ? L('Gerenciar ambientes', 'Manage environments') : L('Ambientes', 'Environments')

  return (
    <div className="connection-shell">
      <header className="connection-bar">
        <button ref={trigger} className="connection-switch" onClick={show} aria-haspopup="dialog" aria-expanded={open} aria-controls="connection-dialog">
          <span aria-hidden="true" className={`connection-dot connection-dot--${state.status}`} />
          <strong>{loading ? L('Ambientes', 'Environments') : current?.name ?? (state.active ? L('Servidor salvo indisponível', 'Saved server unavailable') : L('Este computador', 'This computer'))}</strong>
          <span>{loading ? L('Carregando…', 'Loading…') : state.switching || operation?.kind === 'select' || operation?.kind === 'pair' ? L('Conectando…', 'Connecting…') : status}</span><span aria-hidden="true">▾</span>
        </button>
        {(state.status === 'error' || state.error || failure) && <button className="btn btn--ghost btn--xs" onClick={show}>{L('Gerenciar conexão', 'Manage connection')}</button>}
      </header>
      <div className="connection-content">{children}</div>
      <dialog id="connection-dialog" ref={dialog} tabIndex={-1} onKeyDown={keepDialogFocus} className="connection-dialog" data-view={view} aria-labelledby="connection-title" aria-describedby="connection-description" onCancel={(event) => { event.preventDefault(); dismiss() }}>
        <header className="connection-heading">
          <h2 ref={heading} tabIndex={-1} id="connection-title">{title}</h2>
          <button ref={closeButton} className="icon-btn" onClick={dismiss} aria-label={L('Fechar', 'Close')}><Icon name="x" size={16} /></button>
        </header>
        <div ref={scroll} className="connection-scroll">
          <p id="connection-description" className="muted small">{view === 'add'
            ? L('Conecte uma VPS com o Tucano já instalado. Revise o destino antes de autorizar este dispositivo.', 'Connect a VPS with Tucano already installed. Review the destination before authorizing this device.')
            : view === 'manage' ? L('Os nomes e acessos salvos pertencem a este computador. Seus dados continuam em cada ambiente.', 'Saved names and access belong to this computer. Your data stays in each environment.')
              : L('Escolha onde trabalhar. Cada ambiente tem seus próprios agentes, arquivos e ferramentas.', 'Choose where to work. Each environment has its own agents, files and tools.')}</p>
          {shownError && <div className="connection-error" role="alert">
            {errorTarget && <strong>{L(`Ambiente: ${errorTarget}`, `Environment: ${errorTarget}`)}</strong>}
            <p>{shownError}</p>
            <div className="connection-actions">
              {(loadFailed || profilesUnavailable) && <button className="btn btn--sm" disabled={busy} onClick={() => void act(async () => {}, { kind: 'load' })}>{L('Carregar novamente', 'Load again')}</button>}
              {failure?.paired && view === 'add' && <button className="btn btn--sm" disabled={busy} onClick={() => navigate('select')}>{L('Ver ambientes salvos', 'View saved environments')}</button>}
              {view !== 'add' && connectionFailure && recovery && !pairedFailure && <>
                {failure?.operation?.kind === 'select' && <button className="btn btn--sm" disabled={busy} onClick={() => void select(recovery.id)}>{L('Tentar novamente', 'Try again')}</button>}
                <button className="btn btn--sm" disabled={busy || loadFailed || profilesUnavailable} onClick={() => add(recovery)}>{L('Parear novamente', 'Pair again')}</button>
              </>}
            </div>
          </div>}
          {view !== 'add' ? <div className="connection-profiles" aria-busy={busy}>
            <div className={`connection-profile connection-profile--local ${state.status === 'local' ? 'is-selected' : ''}`} aria-current={state.status === 'local' ? 'true' : undefined} role="group" aria-label={L('Este computador', 'This computer')}>
              <span className="connection-symbol" aria-hidden="true"><Icon name="laptop" size={20} /></span>
              <div className="connection-profile-info"><span className="connection-kind">{L('LOCAL', 'LOCAL')}</span><strong>{L('Este computador', 'This computer')}</strong><small>{L('Agentes e arquivos neste dispositivo', 'Agents and files on this device')}</small></div>
              <button className="btn btn--sm" disabled={busy || loadFailed || state.status === 'local'} onClick={() => void select(null)}>{state.status === 'local' ? L('Em uso', 'In use') : L('Usar local', 'Use local')}</button>
            </div>
            <h3 className="connection-section">{L('Seus servidores', 'Your servers')} <span>{state.profiles.length}</span></h3>
            {state.profiles.length === 0 && !loading && !loadFailed && !profilesUnavailable && <div className="connection-empty"><strong>{L('Seu primeiro ambiente remoto', 'Your first remote environment')}</strong><p>{L('Adicione sua VPS pessoal ou de trabalho. O modo local continua disponível e nada é transferido automaticamente.', 'Add your personal or work VPS. Local mode stays available and nothing is transferred automatically.')}</p></div>}
            {state.profiles.map((profile) => {
              const selected = state.active === profile.id
              const connecting = selected && state.status === 'connecting' || operation?.kind === 'select' && operation.id === profile.id
              const inUse = selected && state.status === 'connected'
              return <div className={`connection-profile ${selected ? 'is-selected' : ''}`} key={profile.id} data-connection-id={profile.id} aria-current={selected ? 'true' : undefined} role="group" aria-label={profile.name}>
                <span className="connection-symbol" aria-hidden="true"><Icon name={profile.reach.via === 'ssh' ? 'terminal' : 'globe'} size={20} /></span>
                <div className="connection-profile-info">
                  <span className="connection-kind">{profile.reach.via === 'ssh' ? 'SSH' : profile.reach.url.startsWith('https:') ? 'HTTPS' : parseServerUrl(profile.reach.url) ? L('HTTP · LOCAL', 'HTTP · LOCAL') : L('HTTP · REQUER HTTPS', 'HTTP · NEEDS HTTPS')}</span>
                  <div className="connection-profile-title"><strong>{profile.name}</strong>{selected && <span className="connection-selected">{status}</span>}</div>
                  <small>{endpoint(profile.reach)}</small>
                </div>
                <div className="connection-actions">
                  {view === 'select' ? <button className="btn btn--sm" disabled={busy || loadFailed || inUse || connecting} onClick={() => void select(profile.id)}>{connecting ? L('Conectando…', 'Connecting…') : inUse ? L('Em uso', 'In use') : selected ? L('Reconectar', 'Reconnect') : L('Conectar', 'Connect')}</button> : <>
                    {api.rename && <button data-connection-action="rename" className="btn btn--ghost btn--sm" disabled={busy || loadFailed} onClick={() => { setRenaming(profile.id); setNewName(profile.name); setForgetting(null) }}>{L('Renomear', 'Rename')}</button>}
                    <button data-connection-action="forget" className="btn btn--ghost btn--sm" disabled={busy || loadFailed} onClick={() => { setForgetting(profile.id); setRenaming(null) }}>{L('Esquecer', 'Forget')}</button>
                  </>}
                </div>
                {renaming === profile.id && <form className="connection-rename" onSubmit={(event) => { event.preventDefault(); if (api.rename && newName.trim()) void act(() => api.rename!(profile.id, newName.trim()), { kind: 'rename', id: profile.id, name: profile.name }).then((ok) => { if (ok) { setRenaming(null); focusAction(profile.id, 'rename') } }) }}>
                  <label>{L('Nome do ambiente', 'Environment name')}<input autoFocus value={newName} maxLength={60} disabled={busy} placeholder={L('Ex.: Pessoal, Trabalho', 'e.g. Personal, Work')} onChange={(event) => setNewName(event.target.value)} /></label>
                  <div className="connection-actions"><button className="btn btn--primary btn--sm" type="submit" disabled={busy || !newName.trim() || newName.trim() === profile.name}>{L('Salvar nome', 'Save name')}</button><button className="btn btn--sm" type="button" disabled={busy} onClick={() => { setRenaming(null); focusAction(profile.id, 'rename') }}>{L('Cancelar', 'Cancel')}</button></div>
                </form>}
                {forgetting === profile.id && <div className="connection-forget"><strong>{L(`Esquecer “${profile.name}”?`, `Forget “${profile.name}”?`)}</strong><p>{L('Remove a conexão, seu token e os rascunhos não enviados deste ambiente neste computador. Os dados no servidor ficam intactos. Para revogar o acesso, remova o dispositivo no servidor.', 'Removes the connection, its token and this environment’s unsent drafts from this computer. Server data stays intact. To revoke access, remove the device on the server.')}</p>{selected && <p>{L('A tela voltará para o modo local. O trabalho no servidor continuará rodando.', 'Your view will return to local mode. Work on the server will keep running.')}</p>}<div className="connection-actions"><button className="btn btn--danger btn--sm" disabled={busy} onClick={() => void act(() => api.forget(profile.id), { kind: 'forget', id: profile.id, name: profile.name }).then((ok) => { if (ok) { setForgetting(null); heading.current?.focus() } })}>{L('Esquecer conexão', 'Forget connection')}</button><button className="btn btn--sm" disabled={busy} onClick={() => { setForgetting(null); focusAction(profile.id, 'forget') }}>{L('Cancelar', 'Cancel')}</button></div></div>}
              </div>
            })}
          </div> : <form id="connection-pair-form" className="connection-form" aria-busy={busy} onSubmit={(event) => { event.preventDefault(); void pair() }}>
            <label>{L('Como conectar', 'Connection method')}<select value={mode} disabled={busy || loadFailed} onChange={(event) => { setMode(event.target.value as typeof mode); setLink(''); setAddress(''); setCode(''); setPort(String(DEFAULT_PORT)); setTouched({}); setFailure(null) }}><option value="link">{L('Colar link de pareamento', 'Paste pairing link')}</option><option value="ssh">{L('SSH · endereço e código', 'SSH · address and code')}</option><option value="url">{L('HTTPS / Tailscale · endereço e código', 'HTTPS / Tailscale · address and code')}</option></select></label>
            <div className="connection-setup">
              <strong>{L('Na VPS, como o usuário do serviço', 'On the VPS, as the service user')}</strong>
              <code>{mode === 'url' ? 'tucano-server pair --url https://tucano.example.com' : 'tucano-server pair --ssh user@host'}</code>
              <p>{mode === 'link' ? L('Troque user@host pelo seu acesso SSH e cole o link tucano://pair abaixo. Para HTTPS, use --url https://seu-servidor no lugar de --ssh. O link vale por 5 minutos e só funciona uma vez.', 'Replace user@host with your SSH login and paste the tucano://pair link below. For HTTPS, use --url https://your-server instead of --ssh. The link is valid for 5 minutes and works once.') : L('Substitua o endereço pelo da sua VPS e cole o código abaixo. Ele é privado, vale por 5 minutos e só pode ser usado uma vez.', 'Replace the address with your VPS address and paste the code below. It is private, valid for 5 minutes and can only be used once.')}</p>
            </div>
            {mode === 'link' ? <label>{L('Link de pareamento (privado)', 'Pairing link (private)')}<input type="password" autoComplete="off" spellCheck={false} value={link} disabled={busy || loadFailed} onChange={(event) => setLink(event.target.value)} onBlur={() => touch('link')} aria-invalid={validation?.field === 'link'} aria-describedby={validation?.field === 'link' ? 'connection-validation' : undefined} placeholder="tucano://pair?…" /></label> : <>
              <label>{mode === 'ssh' ? L('Usuário e host SSH (porta SSH opcional)', 'SSH user and host (optional SSH port)') : L('Endereço do servidor', 'Server URL')}<input value={address} disabled={busy || loadFailed} onChange={(event) => setAddress(event.target.value)} onBlur={() => touch('address')} aria-invalid={validation?.field === 'address'} aria-describedby={validation?.field === 'address' ? 'connection-validation' : undefined} placeholder={mode === 'ssh' ? 'user@host:22' : 'https://tucano.example.com'} autoComplete="off" spellCheck={false} /></label>
              <div className={mode === 'ssh' ? 'connection-field-row' : undefined}>
                <label>{L('Código de pareamento', 'Pairing code')}<input type="password" autoComplete="off" spellCheck={false} value={code} disabled={busy || loadFailed} onChange={(event) => setCode(event.target.value)} onBlur={() => touch('code')} aria-invalid={validation?.field === 'code'} aria-describedby={validation?.field === 'code' ? 'connection-validation' : undefined} placeholder="XXXX-XXXX-XXXX" /></label>
                {mode === 'ssh' && <label>{L('Porta do serviço Tucano', 'Tucano service port')}<input type="number" aria-label={L('Porta do serviço Tucano', 'Tucano service port')} min="1" max="65535" value={port} disabled={busy || loadFailed} onChange={(event) => setPort(event.target.value)} onBlur={() => touch('port')} aria-invalid={validation?.field === 'port'} aria-describedby={validation?.field === 'port' ? 'connection-port-hint connection-validation' : 'connection-port-hint'} /><span id="connection-port-hint" className="connection-field-hint">{L('Na VPS, normalmente 7337', 'On the VPS, usually 7337')}</span></label>}
              </div>
              <p className="muted small">{mode === 'ssh' ? L('Use o host real e uma chave carregada no ssh-agent. Verifique a identidade da VPS no Terminal primeiro. Aliases do SSH não são usados.', 'Use the actual host and a key loaded in ssh-agent. Verify the VPS identity in Terminal first. SSH aliases are not used.') : L('Use HTTPS, inclusive no Tailscale. HTTP só é permitido em localhost. O endereço deve estar configurado antes de parear.', 'Use HTTPS, including on Tailscale. HTTP is only allowed on localhost. Configure the address before pairing.')}</p>
            </>}
            <label>{L('Nome do ambiente (opcional)', 'Environment name (optional)')}<input value={name} maxLength={60} disabled={busy || loadFailed} onChange={(event) => setName(event.target.value)} placeholder={L('Ex.: Pessoal, Trabalho', 'e.g. Personal, Work')} /></label>
            {validation && <p id="connection-validation" role="alert" className="connection-validation">{validation.message}</p>}
          </form>}
        </div>
        <footer className="connection-footer">
          {view === 'add' && parsed.ok && <div className="connection-preview" id="connection-preview" tabIndex={busy ? -1 : 0} role="region" aria-label={L('Destino do pareamento', 'Pairing destination')}>
            <span className="connection-kind">{L('CONFIRA O DESTINO', 'REVIEW DESTINATION')} · {parsed.link.reach.via === 'ssh' ? 'SSH' : parsed.link.reach.url.startsWith('https:') ? 'HTTPS' : 'HTTP LOCAL'}</span>
            <strong>{name.trim() || parsed.link.name}</strong>
            <span>{endpoint(parsed.link.reach)}</span>
            {parsed.link.reach.via === 'ssh' && <small>{L(`Serviço Tucano na VPS: localhost:${parsed.link.remotePort}`, `Tucano service on the VPS: localhost:${parsed.link.remotePort}`)}</small>}
          </div>}
          {busy ? <p className="connection-progress" role="status">{operation?.name ? L(`Processando: ${operation.name}.`, `Working on: ${operation.name}.`) : loading ? L('Carregando conexões…', 'Loading connections…') : L('Conectando ao ambiente…', 'Connecting to the environment…')} {!loading && L('Fechar esta janela não cancela a operação.', 'Closing this window does not cancel the operation.')}</p> : <p className="muted small connection-footnote">{view === 'add'
            ? L('Parear salva o acesso deste dispositivo e abre o ambiente. O link e o código ficam ocultos.', 'Pairing saves this device’s access and opens the environment. The link and code stay hidden.')
            : L('Alternar muda apenas a tela. Não move dados nem interrompe o trabalho dos agentes.', 'Switching only changes your view. It does not move data or stop agents’ work.')}</p>}
          <div className="connection-footer-actions">
            {view === 'add' ? <>
              <button className="btn" disabled={busy} onClick={() => navigate('select')}>{L('Voltar', 'Back')}</button>
              <button type="submit" form="connection-pair-form" className="btn btn--primary" aria-describedby={parsed.ok ? 'connection-preview' : undefined} disabled={busy || loadFailed || !parsed.ok || !!failure?.paired}>{operation?.kind === 'pair' ? L('Pareando…', 'Pairing…') : L('Parear e conectar', 'Pair and connect')}</button>
            </> : <>
              {view === 'manage' ? <button className="btn" disabled={busy} onClick={() => navigate('select')}>{L('Voltar', 'Back')}</button> : <button className="btn btn--ghost" disabled={busy || loadFailed || !state.profiles.length} onClick={() => navigate('manage')}>{L('Gerenciar ambientes', 'Manage environments')}</button>}
              <button className="btn btn--primary" disabled={busy || loadFailed || profilesUnavailable} onClick={() => add()}><Icon name="plus" size={14} />{L('Adicionar ambiente', 'Add environment')}</button>
            </>}
          </div>
        </footer>
      </dialog>
    </div>
  )
}
