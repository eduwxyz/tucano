// The Connectors page's grid: what's added, then what's ready to add, by category. One click signs
// in through the browser (or needs no sign-in); a service that asks a few things first (its address,
// a token) asks them in a window; anything else goes in by hand, with "Adicionar personalizado".
// Google's and Slack's sign in with an app the person makes once, which the first Connect walks them through.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { catalogInput, CATEGORIES, entryOf, ownAppGuide, searchCatalog, type AppProvider, type CatalogEntry } from '../../../shared/connector-catalog'
import { LOGOS } from '../connector-logos'
import { addConnector, authorizeConnector, openExternal, ownApp, setOwnApp, useStore, type Connector } from '../store'
import { Modal } from './Modal'
import { Icon } from './ui'

// A light brand color takes a dark mark, so every tile reads in both themes.
const light = (hex: string): boolean => {
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.6
}

// Brands without a mark in Simple Icons, or with only a wordmark: their initial, on their color.
const OWN_COLOR: Record<string, string> = { jam: 'FF2D55', monday: '6161FF', granola: '3F6212', canva: '00C4CC', context7: '0F172A', exa: '1F40ED', aave: 'B6509E', coinbase: '0052FF', zapier: 'FF4F00', composio: '1A1A1A', 'azure-devops': '0078D4', cloudwatch: 'E7157B' }

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

// The tile a connector wears: the image the person gave it, else the catalog's mark for that server,
// else the terminal (a local server) or the globe (a remote one). A link that doesn't load shows the
// mark it would have had, so a broken image never leaves an empty square.
export function ConnectorIcon({ connector: c, size = 36 }: { connector: Connector; size?: number }): ReactNode {
  const [broken, setBroken] = useState(false)
  const fallback = (): ReactNode => {
    const entry = entryOf(c)
    return entry ? (
      <CatalogLogo entry={entry} size={size} />
    ) : (
      <span className="catalog__logo catalog__logo--own" style={{ width: size, height: size }} aria-hidden>
        <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} size={size * 0.5} />
      </span>
    )
  }
  if (!c.icon || broken) return fallback()
  return (
    <span className="catalog__logo catalog__logo--img" style={{ width: size, height: size }} aria-hidden>
      <img src={c.icon} alt="" width={size} height={size} onError={() => setBroken(true)} />
    </span>
  )
}

// A square of 128 px, the whole image with its own shape kept (a wide logo is not cut): the same size
// an agent's picture has, in the format browsers and the database both take whole.
async function iconFrom(file: File): Promise<string> {
  const image = await createImageBitmap(file)
  const scale = Math.min(128 / image.width, 128 / image.height, 1)
  const w = Math.max(1, Math.round(image.width * scale))
  const h = Math.max(1, Math.round(image.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  canvas.getContext('2d')!.drawImage(image, Math.round((128 - w) / 2), Math.round((128 - h) / 2), w, h)
  image.close()
  return canvas.toDataURL('image/webp', 0.9)
}

// The image a connector wears, given here in either shape: a file of the person's, scaled down to 128 px
// before it's saved so it rides small in every snapshot, or the https address of an image, kept as it is.
// Without one, the catalog's mark (or the terminal) stays.
export function IconPicker({ value, onChange, busy = false, error }: { value?: string; onChange: (icon?: string) => void; busy?: boolean; error?: string | null }): ReactNode {
  const [bad, setBad] = useState('')
  const [link, setLink] = useState(value && !value.startsWith('data:') ? value : '')
  const failed = (): void => setBad(L('Essa imagem não abriu. Tente outra, em PNG, JPG ou WebP.', "That image didn't open. Try another one, in PNG, JPG or WebP."))
  // The address is checked here so the person sees why, before it travels; the core checks it again.
  const useLink = (): void => {
    const url = link.trim()
    if (!/^https:\/\//i.test(url)) return setBad(L('O endereço da imagem precisa começar em https://.', 'The image address must start with https://.'))
    setBad('')
    onChange(url)
  }
  const isLink = !!value && !value.startsWith('data:')
  return (
    <div className="iconpick">
      <div className="row row--center">
        {value ? (
          <span className="catalog__logo catalog__logo--img iconpick__preview" aria-hidden>
            <img src={value} alt="" onError={() => setBad(L('Essa imagem não abriu. Confira o endereço, ou use um arquivo.', "That image didn't open. Check the address, or use a file."))} />
          </span>
        ) : (
          <span className="catalog__logo catalog__logo--own iconpick__preview" aria-hidden>
            <Icon name="image" size={18} />
          </span>
        )}
        <span className="small muted grow">{value ? L('É essa imagem que aparece no lugar do ícone.', 'This is the image shown in place of the icon.') : L('Sem imagem: fica a marca do serviço, ou o ícone de terminal.', "No image: the service's mark stays, or the terminal icon.")}</span>
        <label className={`btn btn--sm ${busy ? 'is-disabled' : ''}`}>
          {value ? L('Trocar imagem', 'Change image') : L('Escolher imagem', 'Choose image')}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            hidden
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (!file) return
              if (file.size > 8_000_000) return setBad(L('Essa imagem é grande demais (até 8 MB).', 'That image is too big (8 MB at most).'))
              setLink('')
              iconFrom(file).then((icon) => (setBad(''), onChange(icon)), failed)
            }}
          />
        </label>
        {value && (
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => (setBad(''), setLink(''), onChange(undefined))}>
            {L('Remover', 'Remove')}
          </button>
        )}
      </div>
      <div className="row row--center">
        <input
          className="grow mono"
          value={link}
          placeholder="https://exemplo.com/logo.png"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => (setBad(''), setLink(e.target.value))}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            useLink()
          }}
        />
        <button type="button" className="btn btn--sm" disabled={busy || !link.trim()} onClick={useLink}>
          {L('Usar endereço', 'Use address')}
        </button>
      </div>
      <span className="small muted">
        {isLink
          ? L('Um endereço: a imagem é buscada na rede toda vez que a grade abre.', 'An address: the image is fetched from the network each time the grid opens.')
          : L('Um arquivo vira uma cópia pequena guardada com o conector; um endereço https fica como está.', 'A file becomes a small copy kept with the connector; an https address stays as it is.')}
      </span>
      {(bad || error) && <span className="field__error">{bad || error}</span>}
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
              const entry = entryOf(c)
              const using = users.filter((a) => (a.grants[c.id] ?? 'none') !== 'none').length
              const fresh = c.tools.filter((t) => t.isNew).length
              return (
                <div key={c.id} className="catalog__card is-mine" role="button" tabIndex={0} onClick={() => onManage(c.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onManage(c.id))}>
                  <ConnectorIcon connector={c} />
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
