// The logins the person saves for an agent's browser: a site, a username and a password (or a
// 1Password reference), kept in the system's keychain. The agent types them with navegador_login
// only on that exact site and never sees the password; this list shows sites and usernames only.
import { L } from '../../../shared/lang'
import { useEffect, useState, type ReactNode } from 'react'
import { browserLogins, removeBrowserLogin, saveBrowserLogin, type SavedLogin } from '../store'
import { confirmDialog } from './Dialogs'
import { Icon } from './ui'

export function BrowserLogins({ agentId, agentName }: { agentId: string; agentName: string }): ReactNode {
  const [logins, setLogins] = useState<SavedLogin[] | null>(null)
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [site, setSite] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = (): void => void browserLogins(agentId).then(setLogins, () => setLogins([]))
  useEffect(load, [agentId])

  const save = (): void => {
    setBusy(true)
    setError('')
    saveBrowserLogin(agentId, site, username, password)
      .then(() => {
        setSite('')
        setUsername('')
        setPassword('')
        setAdding(false)
        load()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  const remove = (l: SavedLogin): void =>
    void confirmDialog({
      title: L(`Tirar o login de ${l.origin}?`, `Remove the login for ${l.origin}?`),
      body: L(`${agentName} deixa de entrar sozinho nesse site. O que já está logado no navegador dele continua até sair.`, `${agentName} stops signing in to that site on its own. What's already signed in in its browser stays until it signs out.`),
      confirm: L('Tirar', 'Remove'),
      danger: true
    }).then((ok) => {
      if (ok) void removeBrowserLogin(agentId, l.origin).then(load, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
    })

  const count = logins?.length ?? 0
  return (
    <details className="lrow-fold" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="lrow">
        <span className="lrow__label">
          <span className="lrow__name">{L('Logins salvos', 'Saved logins')}</span>
          <span className="lrow__sub">{L('Ele entra sozinho nesses sites, sem ver a senha.', 'It signs in to these sites on its own, without seeing the password.')}</span>
        </span>
        <span className="lrow__ctl lrow__value">
          {count ? count : L('nenhum', 'none')} <Icon name="chevron" size={13} />
        </span>
      </summary>
      <div className="lrow-fold__body saved-logins">
        {logins?.map((l) => (
          <div key={l.origin} className="saved-logins__row">
            <Icon name="lock" size={13} />
            <span className="grow saved-logins__site">
              {l.origin}
              <span className="muted"> · {l.username || L('(não abriu)', '(could not open)')}</span>
              {l.onePassword && <span className="muted"> · 1Password</span>}
            </span>
            <button className="always__x" title={L('Tirar este login', 'Remove this login')} aria-label={L(`Tirar o login de ${l.origin}`, `Remove the login for ${l.origin}`)} onClick={() => remove(l)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ))}
        {adding ? (
          <form
            className="saved-logins__form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!busy) save()
            }}
          >
            <input aria-label={L('Site', 'Site')} placeholder={L('Site, ex.: conta.exemplo.com.br', 'Site, e.g. account.example.com')} spellCheck={false} autoComplete="off" value={site} onChange={(e) => setSite(e.target.value)} />
            <input aria-label={L('Usuário ou email', 'Username or email')} placeholder={L('Usuário ou email', 'Username or email')} spellCheck={false} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
            <input aria-label={L('Senha', 'Password')} type="password" placeholder={L('Senha ou op://…', 'Password or op://…')} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <div className="row">
              <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !site.trim() || !username.trim() || !password}>
                {L('Salvar login', 'Save login')}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => (setAdding(false), setError(''))}>
                {L('Cancelar', 'Cancel')}
              </button>
            </div>
          </form>
        ) : (
          <button className="link link--quiet" onClick={() => setAdding(true)}>
            {L('Salvar um login…', 'Save a login…')}
          </button>
        )}
        {error && <span className="note note--error">{error}</span>}
        <p className="hint">{L('Fica no chaveiro do sistema. Ele só digita no endereço exato do site.', 'Kept in the system keychain. It only types it at the site’s exact address.')}</p>
      </div>
    </details>
  )
}
