// The Connectors page's grid: what's added, then what's ready to add, by category. One click signs
// in through the browser (or needs no sign-in); a service that asks a few things first (its address,
// a token) asks them in a window; anything else goes in by hand, with "Adicionar personalizado".
import { useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { catalogInput, CATEGORIES, entryOf, searchCatalog, type CatalogEntry } from '../../../shared/connector-catalog'
import { LOGOS } from '../connector-logos'
import { addConnector, authorizeConnector, useStore, type Connector } from '../store'
import { Modal } from './Dialogs'
import { Icon } from './ui'

// A light brand color takes a dark mark, so every tile reads in both themes.
const light = (hex: string): boolean => {
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.6
}

// Brands without a mark in Simple Icons, or with only a wordmark: their initial, on their color.
const OWN_COLOR: Record<string, string> = { jam: 'FF2D55', monday: '6161FF', granola: '3F6212', canva: '00C4CC', context7: '0F172A', exa: '1F40ED', aave: 'B6509E', coinbase: '0052FF', zapier: 'FF4F00', 'azure-devops': '0078D4', cloudwatch: 'E7157B' }

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

type Status = Record<Connector['status'], { label: string; tone: string }>

// The connectors added, on top (with their state; a click opens them), then the ones ready to add, by
// category, without those already added. The search looks through both.
export function ConnectorGrid({ status, onManage }: { status: Status; onManage: (id: string) => void }): ReactNode {
  const connectors = useStore((s) => s.connectors)
  const users = useStore((s) => s.agents)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const [setup, setSetup] = useState<CatalogEntry | null>(null)
  const words = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  const mine = connectors.filter((c) => !words || `${c.name} ${entryOf(c)?.about() ?? ''}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(words))
  const found = searchCatalog(query).filter((e) => !connectors.some((c) => entryOf(c)?.id === e.id))

  const connect = (c: CatalogEntry): void => {
    if (c.fields?.length) return setSetup(c)
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
                  {entry ? (
                    <CatalogLogo entry={entry} />
                  ) : (
                    <span className="catalog__logo catalog__logo--own" aria-hidden>
                      <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} size={18} />
                    </span>
                  )}
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
            </h3>
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
    </section>
  )
}

// What a service asks before connecting: the address of your own instance, a token, an account. The
// values go into the connector as the custom form would put them; the secrets, into the system vault.
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
            <Icon name="shield" size={12} /> {L('Os segredos ficam cifrados no cofre do sistema.', 'Secrets are encrypted in the system vault.')}
          </span>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? L('Conectando…', 'Connecting…') : L('Conectar', 'Connect')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
