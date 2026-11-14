// The Connectors page's grid: what's added, then what's ready to add, by category. One click signs
// in through the browser (or needs no sign-in); a service that asks a few things first (its address,
// a token) asks them in a window; anything else goes in by hand, with "Adicionar personalizado".
// Google's and Slack's sign in with an app the person makes once, which the first Connect walks them through.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { catalogInput, CATEGORIES, entryOf, ownAppGuide, searchCatalog, type AppProvider, type CatalogEntry } from '../../../shared/connector-catalog'
import { LOGOS } from '../connector-logos'
import { iconFromFile, imageFromClipboard } from '../connector-icon'
import { addConnector, authorizeConnector, openExternal, ownApp, setConnectorIcon, setOwnApp, toast, useStore, type Connector } from '../store'
import { Modal } from './Modal'
import { Icon } from './ui'

// A light brand color takes a dark mark, so every tile reads in both themes.
const light = (hex: string): boolean => {
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.6
}

// Brands without a mark in Simple Icons, or with only a wordmark: their initial, on their color.
const OWN_COLOR: Record<string, string> = { jam: 'FF2D55', monday: '6161FF', granola: '3F6212', canva: '00C4CC', context7: '0F172A', exa: '1F40ED', keenable: '005CFF', aave: 'B6509E', coinbase: '0052FF', zapier: 'FF4F00', composio: '1A1A1A', 'azure-devops': '0078D4', cloudwatch: 'E7157B' }

export function CatalogLogo({ entry, size = 36 }: { entry: CatalogEntry; size?: number }): ReactNode {
  const logo = LOGOS[entry.id]
  const hex = logo?.hex ?? OWN_COLOR[entry.id] ?? '64748B'
  const ink = light(hex) ? '#111' : '#fff'
  return (
    <span className="catalog__logo" style={{ width: size, height: size, background: `#${hex}`, color: ink }} aria-hidden>
      {logo ? (
        <svg viewBox="0 0 24 24" width={size * 0.56} height={size * 0.56} fill="currentColor">
          <path d={logo.path} />
        </svg>
      ) : (
        <b style={{ fontSize: size * 0.44 }}>{entry.name[0]}</b>
      )}
    </span>
  )
}

// The tile a connector wears: the picture set on it, else the store's mark when it is a service the
// store knows, else the icon of its kind — a terminal for a server that runs here, a globe for one on
// the network. That last one is what a server added by hand wore before it could have a picture.
export function ConnectorTile({ c, size = 36 }: { c: Pick<Connector, 'kind' | 'url' | 'command' | 'args' | 'icon'>; size?: number }): ReactNode {
  if (c.icon) {
    return (
      <span className="catalog__logo catalog__logo--pic" style={{ width: size, height: size }} aria-hidden>
        <img src={c.icon} alt="" width={size} height={size} />
      </span>
    )
  }
  const entry = entryOf(c)
  if (entry) return <CatalogLogo entry={entry} size={size} />
  return (
    <span className="catalog__logo catalog__logo--own" style={{ width: size, height: size }} aria-hidden>
      <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} size={Math.round(size * 0.5)} />
    </span>
  )
}

// The picture a connector wears, changed where the connector is: pick an image from this computer, see
// it on the tile, or take it away and go back to the store's mark. The image is shrunk to 128 px and
// kept in the database, so a backup carries it.
export function ConnectorIconPicker({ c }: { c: Connector }): ReactNode {
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  const save = async (value: Promise<string> | string): Promise<void> => {
    setBusy(true)
    try {
      await setConnectorIcon(c.id, await value)
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : L('Não consegui usar essa imagem.', "I couldn't use that image."))
    } finally {
      setBusy(false)
    }
  }
  // A picture copied anywhere else and pasted here: the same shrink-and-keep path as a picked file,
  // so the clipboard is only another way in, never another kind of icon.
  const paste = async (file: File | null): Promise<void> => {
    if (!file) return toast(L('Não há imagem na área de transferência.', 'There is no image on the clipboard.'))
    await save(iconFromFile(file))
  }
  return (
    <div
      className="row connector-modal__icon"
      onPaste={(e) => {
        const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
        const file = item?.getAsFile()
        if (file) {
          e.preventDefault()
          void paste(file)
        }
      }}
    >
      <ConnectorTile c={c} size={30} />
      <input
        ref={file}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        hidden
        onChange={(e) => {
          const picked = e.target.files?.[0]
          e.target.value = '' // the same file again still counts as a choice
          if (picked) void save(iconFromFile(picked))
        }}
      />
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => file.current?.click()}>
        {L('Escolher imagem', 'Choose image')}
      </button>
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void imageFromClipboard().then(paste)}>
        {L('Colar imagem', 'Paste image')}
      </button>
      {c.icon && (
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void save('')}>
          {L('Usar o padrão', 'Use the default')}
        </button>
      )}
      <span className="muted small grow">
        {L(
          'PNG, JPEG, WebP, GIF ou SVG, escolhido ou colado da área de transferência. O ícone aparece na lista de conectores.',
          'PNG, JPEG, WebP, GIF or SVG, picked or pasted from the clipboard. The icon shows in the connector list.'
        )}
      </span>
    </div>
  )
}

type Status = Record<Connector['status'], { label: string; tone: string }>

// The connectors added, on top (with their state; a click opens them), then the ones ready to add, by
// category, without those already added. The search looks through both.
// `query`: what the search starts with (the introduction opens it on the connector its agent could use).
export function ConnectorGrid({ status, onManage, query: initial = '' }: { status: Status; onManage: (id: string) => void; query?: string }): ReactNode {
  const connectors = useStore((s) => s.connectors)
  const users = useStore((s) => s.agents)
  const [query, setQuery] = useState(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const [setup, setSetup] = useState<CatalogEntry | null>(null)
  const [apps, setApps] = useState<Partial<Record<AppProvider, boolean>>>({}) // which own apps are saved
  const [appSetup, setAppSetup] = useState<{ provider: AppProvider; then?: CatalogEntry } | null>(null)
  useEffect(() => {
    for (const p of ['google', 'slack'] as const) void ownApp(p).then((a) => setApps((now) => ({ ...now, [p]: !!a.clientId })), () => {})
  }, [])
  const google = apps.google
  const words = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const mine = connectors.filter((c) => !words || `${c.name} ${entryOf(c)?.about() ?? ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(words))
  const found = searchCatalog(query).filter((e) => !connectors.some((c) => entryOf(c)?.id === e.id))

  const connect = (c: CatalogEntry): void => {
    if (c.app && !apps[c.app.provider]) return setAppSetup({ provider: c.app.provider, then: c })
    if (c.fields?.length || c.warning) return setSetup(c) // asks something, or says something, first
    setBusy(c.id)
    setError(null)
    addConnector(catalogInput(c))
      .catch((e: unknown) => setError({ id: c.id, text: e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e) }))
      .finally(() => setBusy(null))
  }

  return (
    <section className="catalog">
      <label className="catalog__search">
        <Icon name="search" size={14} />
        <input value={query} placeholder={L('Buscar conectores', 'Search connectors')} aria-label={L('Buscar conectores', 'Search connectors')} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {mine.length > 0 && (
        <div className="catalog__group">
          <h3>
            {L('Conectados', 'Connected')} <span className="muted">{mine.length}</span>
          </h3>
          <div className="catalog__grid">
            {mine.map((c) => {
              const using = users.filter((a) => (a.grants[c.id] ?? 'none') !== 'none').length
              const fresh = c.tools.filter((t) => t.isNew).length
              return (
                <div key={c.id} className="catalog__card is-mine" role="button" tabIndex={0} onClick={() => onManage(c.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onManage(c.id))}>
                  <ConnectorTile c={c} />
                  <span className="catalog__text">
                    <strong>{c.name}</strong>
                    <span className="small catalog__state">
                      <span className={`catalog__dot ${status[c.status].tone}`} />
                      {status[c.status].label}
                      <span className="muted catalog__more">
                        {'· '}
                        {fresh > 0
                          ? L(`${fresh} ferramenta${fresh === 1 ? '' : 's'} nova${fresh === 1 ? '' : 's'}`, `${fresh} new tool${fresh === 1 ? '' : 's'}`)
                          : using
                            ? L(`${using} agente${using === 1 ? '' : 's'}`, `${using} agent${using === 1 ? '' : 's'}`)
                            : L('nenhum agente ainda', 'no agent yet')}
                      </span>
                    </span>
                  </span>
                  {c.status === 'needs_auth' ? (
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        authorizeConnector(c.id)
                      }}
                    >
                      {L('Autorizar', 'Authorize')}
                    </button>
                  ) : (
                    <span className="icon-btn" aria-hidden>
                      <Icon name="chevron" size={14} />
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {found.length === 0 && mine.length === 0 && (
        <p className="muted small">{L(`Nada com “${query}” aqui. Se o serviço tem um servidor MCP, use Adicionar personalizado.`, `Nothing with “${query}” here. If the service has an MCP server, use Add custom.`)}</p>
      )}
      {CATEGORIES().map((cat) => {
        const entries = found.filter((c) => c.category === cat.id)
        if (!entries.length) return null
        return (
          <div key={cat.id} className="catalog__group">
            <h3>
              {cat.name} <span className="muted">{entries.length}</span>
              {cat.id === 'google' && google && (
                <button className="btn btn--ghost btn--sm catalog__google-app" onClick={() => setAppSetup({ provider: 'google' })}>
                  {L('Seu app do Google', 'Your Google app')}
                </button>
              )}
            </h3>
            {cat.id === 'google' && !google && <p className="muted small catalog__note">{L('O Google pede um app seu, criado uma vez no Google Cloud: o primeiro Conectar mostra como, em 6 passos. Depois, os cinco entram com um clique.', 'Google asks for an app of your own, made once in Google Cloud: the first Connect shows how, in 6 steps. After that, all five sign in with one click.')}</p>}
            <div className="catalog__grid">
              {entries.map((c) => (
                <div key={c.id} className="catalog__card">
                  <CatalogLogo entry={c} />
                  <span className="catalog__text">
                    <strong>{c.name}</strong>
                    <span className="muted small catalog__about">{error?.id === c.id ? <span className="catalog__error">{error.text}</span> : c.about()}</span>
                  </span>
                  <button className="btn btn--sm" disabled={busy !== null} onClick={() => connect(c)}>
                    {busy === c.id ? (
                      L('Conectando…', 'Connecting…')
                    ) : (
                      <>
                        <Icon name="plus" size={13} /> {L('Conectar', 'Connect')}
                      </>
                    )}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )
      })}
      {setup && <ConnectorSetup entry={setup} onClose={() => setSetup(null)} onAdded={(id) => (setSetup(null), onManage(id))} />}
      {appSetup && (
        <OwnAppSetup
          provider={appSetup.provider}
          connecting={!!appSetup.then}
          onClose={() => setAppSetup(null)}
          onSaved={() => {
            setApps((now) => ({ ...now, [appSetup.provider]: true }))
            const then = appSetup.then
            setAppSetup(null)
            if (then) {
              setBusy(then.id)
              addConnector(catalogInput(then))
                .catch((e: unknown) => setError({ id: then.id, text: e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e) }))
                .finally(() => setBusy(null))
            }
          }}
        />
      )}
    </section>
  )
}

// A service that puts its own servers between the agents and the person's accounts says so, in full,
// before connecting and on its page.
export function ThirdPartyWarning({ text }: { text: string }): ReactNode {
  return (
    <div className="warn-box warn-box--third-party" role="note">
      <Icon name="globe" size={16} />
      <span>
        <strong>{L('Seus dados passam por terceiros', 'Your data goes through a third party')}</strong>
        {text}
      </span>
    </div>
  )
}

// What a service asks before connecting: the address of your own instance, a token, an account. The
// values go into the connector as the custom form would put them; the secrets, into the system vault.
// A service with a warning opens here too, even with nothing to ask, so it's read before connecting.
function ConnectorSetup({ entry, onClose, onAdded }: { entry: CatalogEntry; onClose: () => void; onAdded: (id: string) => void }): ReactNode {
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const runs = entry.local && [entry.local.command, ...entry.local.args.filter((a) => !a.includes('{'))].join(' ')
  const submit = (): void => {
    setError(null)
    let input
    try {
      input = catalogInput(entry, values)
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(true)
    addConnector(input)
      .then(onAdded)
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '').replace(/^Error: /, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Modal title={entry.name} onClose={onClose} className="connector-setup">
      <form
        className="connector-setup__body"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <div className="row connector-setup__head">
          <CatalogLogo entry={entry} size={40} />
          <span className="muted small">{entry.about()}</span>
        </div>
        {entry.warning && <ThirdPartyWarning text={entry.warning()} />}
        {runs && (
          <p className="warn-box small">
            <Icon name="terminal" size={14} /> {L(`Roda o servidor oficial neste computador, com o seu usuário: ${runs}.`, `Runs the official server on this computer, as your user: ${runs}.`)}
          </p>
        )}
        {(entry.fields ?? []).map((f) => (
          <label key={f.id} className="field">
            <span className="field__label">{f.label()}</span>
            <input
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[f.id] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
            />
            {f.hint && <span className="hint">{f.hint()}</span>}
          </label>
        ))}
        {error && <p className="note note--error">{error}</p>}
        <div className="row connector__actions">
          <span className="small muted grow">
            {entry.fields?.some((f) => f.secret) && (
              <>
                <Icon name="shield" size={12} /> {L('Os segredos ficam cifrados no cofre do sistema.', 'Secrets are encrypted in the system vault.')}
              </>
            )}
          </span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? L('Conectando…', 'Connecting…') : entry.warning ? L('Entendi, conectar', 'I understand, connect') : L('Conectar', 'Connect')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// The person's own app, step by step: Google and Slack sign in only apps registered with them, and
// Tucano's own isn't (Google's verification, Slack's directory). Made once, it serves all of that
// provider's connectors. Also opened from a connector's page, to change it.
export function OwnAppSetup({ provider, connecting = false, onClose, onSaved }: { provider: AppProvider; connecting?: boolean; onClose: () => void; onSaved?: () => void }): ReactNode {
  const [current, setCurrent] = useState<{ clientId?: string; redirectUrl: string } | null>(null)
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void ownApp(provider).then((a) => (setCurrent(a), setClientId(a.clientId ?? '')), (e: unknown) => setError(String(e)))
  }, [provider])
  const link = (href: string, text: string): ReactNode => (
    <button type="button" className="link" onClick={() => openExternal(href)}>
      {text}
    </button>
  )
  const save = (): void => {
    setBusy(true)
    setError('')
    setOwnApp(provider, clientId, secret)
      .then(() => (onSaved ? onSaved() : onClose()))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
      .finally(() => setBusy(false))
  }
  const google = provider === 'google'
  const guide = ownAppGuide(provider, current?.redirectUrl ?? '')
  return (
    <Modal title={guide.title} onClose={onClose} className="google-setup">
      <p className="muted small modal__lead">{guide.lead}</p>
      <ol className="google-setup__steps">
        {guide.steps.map((st, i) => (
          <li key={i}>
            {st.link && st.linkText && (google || current ? link(st.link, st.linkText) : st.linkText)}
            {st.text}
          </li>
        ))}
      </ol>
      <label className="field">
        <span className="field__label">{guide.idLabel}</span>
        <input autoFocus spellCheck={false} disabled={busy} value={clientId} placeholder={guide.idPlaceholder} onChange={(e) => setClientId(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">{guide.secretLabel}</span>
        <input type="password" spellCheck={false} disabled={busy} value={secret} placeholder={current?.clientId ? L('A mesma, ou uma nova', 'The same, or a new one') : guide.secretPlaceholder} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && (e.preventDefault(), save())} />
      </label>
      {guide.notes.map((n, i) => (
        <p key={i} className="muted small">
          {n}
        </p>
      ))}
      {error && <p className="catalog__error small">{error}</p>}
      <div className="modal__foot">
        <button className="btn btn--ghost" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary" disabled={busy || !clientId.trim() || !secret.trim()} onClick={save}>
          {busy ? L('Salvando…', 'Saving…') : connecting ? L('Salvar e conectar', 'Save and connect') : L('Salvar', 'Save')}
        </button>
      </div>
    </Modal>
  )
}
