// The Connectors page's grid: what's added, then what's ready to add, by category. One click signs
// in through the browser (or needs no sign-in); a service that asks a few things first (its address,
// a token) asks them in a window; anything else goes in by hand, with "Adicionar personalizado".
// Google's and Slack's sign in with an app the person makes once, which the first Connect walks them through.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { catalogInput, CATEGORIES, entryOf, GOOGLE_APIS, searchCatalog, slackAppLink, type AppProvider, type CatalogEntry } from '../../../shared/connector-catalog'
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
const OWN_COLOR: Record<string, string> = { jam: 'FF2D55', monday: '6161FF', granola: '3F6212', canva: '00C4CC', context7: '0F172A', exa: '1F40ED', aave: 'B6509E', coinbase: '0052FF', zapier: 'FF4F00', 'azure-devops': '0078D4', cloudwatch: 'E7157B', mofi: '5B47E0' }

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
              {cat.id === 'google' && google && (
                <button className="btn btn--ghost btn--sm catalog__google-app" onClick={() => setAppSetup({ provider: 'google' })}>
                  {L('Seu app do Google', 'Your Google app')}
                </button>
              )}
            </h3>
            {cat.id === 'google' && !google && <p className="muted small catalog__note">{L('O Google pede um app seu, criado uma vez no Google Cloud: o primeiro Conectar mostra como, em 5 passos. Depois, os cinco entram com um clique.', 'Google asks for an app of your own, made once in Google Cloud: the first Connect shows how, in 5 steps. After that, all five sign in with one click.')}</p>}
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

const cloud = (path: string): string => `https://console.cloud.google.com/${path}`

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
  return (
    <Modal title={google ? L('Seu app do Google', 'Your Google app') : L('Seu app do Slack', 'Your Slack app')} onClose={onClose} className="google-setup">
      <p className="muted small modal__lead">
        {google
          ? L(
              'O Google só deixa entrar apps cadastrados nele. Você cria o seu uma vez, em uns 10 minutos, e o Gmail, o Drive, o Calendar, o Docs e o Sheets entram com ele. Fica tudo na sua conta: os dados vão do Google direto pro seu computador.',
              'Google only lets in apps registered with it. You make yours once, in about 10 minutes, and Gmail, Drive, Calendar, Docs and Sheets sign in with it. It all stays in your account: the data goes from Google straight to your computer.'
            )
          : L(
              'O Slack só deixa usar o servidor MCP dele apps do diretório ou apps internos de um workspace. Você cria o seu, interno, em uns 2 minutos: o link já traz tudo preenchido. Os dados vão do Slack direto pro seu computador.',
              "Slack lets only directory apps or a workspace's internal apps use its MCP server. You make yours, internal, in about 2 minutes: the link brings it all filled in. The data goes from Slack straight to your computer."
            )}
      </p>
      {google ? (
        <ol className="google-setup__steps">
          <li>
            {link(cloud('projectcreate'), L('Crie um projeto no Google Cloud', 'Create a project in Google Cloud'))}
            {L(', com o nome que quiser (Tucano, por exemplo).', ', named as you like (Tucano, say).')}
          </li>
          <li>
            {link(cloud(`flows/enableapi?apiid=${GOOGLE_APIS.join(',')}`), L('Ative as APIs', 'Turn on the APIs'))}
            {L(': com o projeto escolhido no topo, clique em Próxima e em Ativar. São as do Gmail, Drive, Calendar, Docs e Sheets e a MCP de cada um.', ': with the project chosen at the top, click Next and Enable. They are Gmail, Drive, Calendar, Docs and Sheets, and the MCP one of each.')}
          </li>
          <li>
            {link(cloud('auth/overview'), L('Configure a tela de login', 'Set up the sign-in screen'))}
            {L(
              ' (Google Auth Platform › Começar): o nome do app e o seu e-mail; em Público-alvo, Externo (ou Interno, numa conta Google Workspace de empresa). Depois, em Público-alvo › Usuários de teste, adicione o seu e-mail.',
              ' (Google Auth Platform › Get started): the app name and your email; under Audience, External (or Internal, in a company Google Workspace account). Then, under Audience › Test users, add your email.'
            )}
          </li>
          <li>
            {link(cloud('auth/clients/create'), L('Crie o cliente', 'Create the client'))}
            {L(': em Tipo de aplicativo, App para computador; marque ', ': under Application type, Desktop app; tick ')}
            <b>{L('Usar este cliente para um agente com IA', 'Use this client for an AI-powered agent')}</b>
            {L(' (sem isso o Google recusa os conectores) e clique em Criar.', ' (without it Google turns the connectors away) and click Create.')}
          </li>
          <li>{L('Copie o ID do cliente e a chave secreta do cliente que aparecem e cole aqui:', 'Copy the client ID and the client secret it shows and paste them here:')}</li>
        </ol>
      ) : (
        <ol className="google-setup__steps">
          <li>
            {current ? link(slackAppLink(current.redirectUrl), L('Crie o app no Slack', 'Create the app in Slack')) : L('Crie o app no Slack', 'Create the app in Slack')}
            {L(': escolha o seu workspace, clique em Próximo e em Criar. O nome, as permissões, o endereço de volta e o MCP já vêm preenchidos.', ': choose your workspace, click Next and Create. The name, the permissions, the return address and MCP come filled in.')}
          </li>
          <li>{L('Em Basic Information › App Credentials, copie o Client ID e o Client Secret (Show) e cole aqui:', 'Under Basic Information › App Credentials, copy the Client ID and the Client Secret (Show) and paste them here:')}</li>
        </ol>
      )}
      <label className="field">
        <span className="field__label">{google ? L('ID do cliente', 'Client ID') : 'Client ID'}</span>
        <input autoFocus spellCheck={false} disabled={busy} value={clientId} placeholder={google ? '1234567890-abc….apps.googleusercontent.com' : '1234567890.1234567890123'} onChange={(e) => setClientId(e.target.value)} />
      </label>
      <label className="field">
        <span className="field__label">{google ? L('Chave secreta do cliente', 'Client secret') : 'Client Secret'}</span>
        <input type="password" spellCheck={false} disabled={busy} value={secret} placeholder={current?.clientId ? L('A mesma, ou uma nova', 'The same, or a new one') : google ? 'GOCSPX-…' : ''} onChange={(e) => setSecret(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && (e.preventDefault(), save())} />
      </label>
      <p className="muted small">
        {google
          ? L(
              'Com o app em teste, o Google pede pra entrar de novo a cada 7 dias. Pra não pedir, em Público-alvo clique em Publicar app: no login vai aparecer “O Google não verificou este app”. É o seu próprio app: clique em Avançado e continue.',
              'While the app is in testing, Google asks you to sign in again every 7 days. To stop that, click Publish app under Audience: the sign-in will say “Google hasn’t verified this app”. It’s your own app: click Advanced and go on.'
            )
          : L(
              'Num workspace de empresa, o admin pode precisar aprovar o app antes: o Slack avisa no login, e o pedido vai pra ele.',
              'In a company workspace, an admin may need to approve the app first: Slack says so at sign-in, and the request goes to them.'
            )}
      </p>
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
