// Connections to the MCP servers the user added. The app is the only MCP
// client of these servers: agents reach them through the gateway, never
// directly, so every call passes the grant and approval checks first.
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { L } from '../shared/lang'
import { causeText, friendly, netProblem, netText, type Friendly } from '../shared/errors'
import type { CoreEvent } from '../shared/rpc'
import { ownAppOf, type AppProvider, type CatalogEntry } from '../shared/connector-catalog'
import type { Connector, ConnectorInput, ConnectorStatus, ConnectorTool } from '../shared/types'
import type { Db } from './db'
import { classify, legacyClassify } from './policy'
import { unreadable, type Secrets } from './secrets'
import { OpError, resolveOp, resolveOpRefs } from './onepassword'

const CALL_TIMEOUT_MS = 120_000
// A server that doesn't answer the handshake shows an error instead of "conectando…" for a minute.
const CONNECT_TIMEOUT_MS = 20_000
const MAX_STDIO_FAILURES = 3
// A connection that dropped on its own (the server's process ended, the network went), or an attempt that
// failed for a passing reason, is tried again after these waits; then it waits for a call or the button.
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 300_000]
// How long a renewal's answer is kept for another request that renews with the same refresh token.
const RENEWAL_KEEP_MS = 60_000

// The authorization page sent the browser back without a code: why, and what to do.
export function notAuthorized(url: URL): string {
  const error = url.searchParams.get('error')
  if (error === 'access_denied') return L('Você recusou o acesso na página do serviço. Tente de novo e clique em Permitir.', 'You declined access on the service’s page. Try again and click Allow.')
  const why = url.searchParams.get('error_description') ?? error ?? L('o endereço não tem o código', 'the address has no code')
  return L(`Autorização não concluída: ${why}. Tente de novo pelo app.`, `Authorization not completed: ${why}. Try again from the app.`)
}

// Why a server didn't open, in words that say what to do; the SDK's own text otherwise. The network's
// reason is under Node's "fetch failed", in the error's causes: a certificate, a proxy, the DNS. What the
// error said, causes and all, is the detail ("Ver detalhes").
export function connectProblem(e: unknown, url?: string): Friendly {
  const raw = (e instanceof Error ? e.message : String(e)).trim()
  let host: string | undefined
  try {
    host = url ? new URL(url).host : undefined
  } catch {
    host = undefined
  }
  const net = netProblem(e)
  if (net) return { text: netText(net, host), detail: net.detail }
  const detail = causeText(e) || raw
  const f = friendly(raw, { host })
  if (f.detail === raw) return { text: f.text, detail } // a case it knows: no Node.js, a refused login…
  if (/ENOENT/.test(raw)) return { text: L('O comando do conector não foi encontrado. Se ele usa npx, instale o Node.js (nodejs.org).', "The connector's command wasn't found. If it uses npx, install Node.js (nodejs.org)."), detail }
  if (/connection closed/i.test(raw)) return { text: L('O servidor fechou logo ao abrir. Confira o comando e os argumentos do conector.', 'The server closed right after opening. Check the connector’s command and arguments.'), detail }
  return detail === raw ? { text: raw } : { text: raw, detail }
}

export const connectError = (e: unknown, url?: string): string => connectProblem(e, url).text

// The text of a tool's result: its text blocks, the text of embedded resources, and the structured content
// when that's all there is (a server may put an error's reason only there).
export function contentText(r: Pick<CallToolResult, 'content' | 'structuredContent'>): string {
  const text = (r.content ?? [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' && 'text' in c.resource ? c.resource.text : `[${c.type}]`))
    .join('\n')
  if (text.trim() || !r.structuredContent) return text
  return JSON.stringify(r.structuredContent)
}

// Why a tool returned an error: what it said, or that it said nothing (an empty failure would show a bare ✗).
export function errorReason(r: Pick<CallToolResult, 'content' | 'structuredContent'>): string {
  return contentText(r).trim() || L('O servidor devolveu um erro sem mensagem.', 'The server returned an error with no message.')
}

// Google's MCP servers are in Developer Preview: until the person's Cloud project is enrolled, every tool
// answers "Access to this tool requires that your Google Cloud project (…) is enrolled in the Google
// Workspace Developer Preview Program". Said plainly, so the agent sends the person to that step instead
// of trying again or sending them to the Tuca, who can't do it either.
export const GOOGLE_PREVIEW_URL = 'https://developers.google.com/workspace/preview'
export function googlePreviewHint(url: string | undefined, text: string): string | undefined {
  let host = ''
  try {
    host = new URL(url ?? '').hostname
  } catch {
    return undefined
  }
  if (!/(^|\.)googleapis\.com$/i.test(host) || !/Developer Preview Program/i.test(text)) return undefined
  return L(
    `[Isto é um passo de configuração do Google, que só a pessoa pode fazer: os servidores MCP do Google estão em Developer Preview, e o projeto dela no Google Cloud precisa estar inscrito no Google Workspace Developer Preview Program, em ${GOOGLE_PREVIEW_URL} (o formulário pede o número do projeto). A aprovação costuma levar alguns dias, e até lá as ferramentas do Google falham. Nem você nem o Tuca conseguem resolver isso: explique o passo e não tente de novo. Enquanto isso, a Composio, na loja de conectores, conecta o Google sem esse passo, mas os dados passam pelos servidores dela.]`,
    `[This is a Google setup step only the person can do: Google's MCP servers are in Developer Preview, and their Google Cloud project must be enrolled in the Google Workspace Developer Preview Program, at ${GOOGLE_PREVIEW_URL} (the form asks for the project number). Approval usually takes a few days, and until then Google's tools fail. Neither you nor the Tuca can fix this: explain the step and don't retry. Meanwhile, Composio, in the connector store, connects Google without this step, but the data goes through its servers.]`
  )
}

// Google's other answers that a sign-in won't fix, or that only a new sign-in will, in words the agent can
// pass on. Its MCP servers answer a missing or bad token on each tool call (the handshake and the tool list
// need none), so these show up on a call, not when connecting.
export function googleHint(url: string | undefined, text: string): string | undefined {
  const preview = googlePreviewHint(url, text)
  if (preview) return preview
  let host = ''
  try {
    host = new URL(url ?? '').hostname
  } catch {
    return undefined
  }
  if (!/(^|\.)googleapis\.com$/i.test(host)) return undefined
  if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project|API has not been used|is disabled\b/i.test(text)) {
    const api = /\b([a-z][a-z0-9-]*\.googleapis\.com)\b/i.exec(text.replace(/https?:\/\/\S+/g, ''))?.[1]
    const project = /project[ =:]+(\d{4,})/i.exec(text)?.[1]
    const link =
      /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"'\\)]+/.exec(text)?.[0] ??
      `https://console.cloud.google.com/apis/library/${api ?? ''}${project ? `?project=${project}` : ''}`
    const which = api ? ` (${api})` : ''
    return L(
      `[Isto é um passo de configuração do Google, que só a pessoa pode fazer: uma API${which} não está ativada no projeto dela no Google Cloud${project ? ` (${project})` : ''}. Ela precisa ativá-la em ${link}, no mesmo projeto do cliente OAuth (cada serviço tem duas: a dele e a MCP), esperar uns minutos e tentar de novo. Não é falta de login: autorizar de novo não resolve.]`,
      `[This is a Google setup step only the person can do: an API${which} isn't turned on in their Google Cloud project${project ? ` (${project})` : ''}. They need to turn it on at ${link}, in the same project as the OAuth client (each service has two: its own and the MCP one), wait a few minutes and try again. It isn't the sign-in: authorizing again won't fix it.]`
    )
  }
  if (/insufficient.{0,30}scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) return GOOGLE_SCOPE_HINT()
  if (/invalid authentication credentials|missing required authentication credential|invalid_token/i.test(text)) return GOOGLE_SIGN_IN_HINT()
  return undefined
}

const GOOGLE_SCOPE_HINT = (): string =>
  L(
    '[O login do Google deste conector não tem todas as permissões: alguma caixa ficou desmarcada na tela de permissões do Google. Só a pessoa resolve: em Conectores, clicar em Autorizar no conector e marcar todas as caixas. Não tente de novo antes disso.]',
    "[This connector's Google sign-in lacks some permissions: a box was left unticked on Google's permission screen. Only the person can fix it: in Connectors, click Authorize on the connector and tick every box. Don't retry before that.]"
  )
const GOOGLE_SIGN_IN_HINT = (): string =>
  L(
    '[O Google recusou o login deste conector. Só a pessoa resolve: em Conectores, clicar em Autorizar no conector. Se o Google barrar o login, confira no Google Cloud (Google Auth Platform): o e-mail dela em Público-alvo › Usuários de teste, enquanto o app estiver em teste, e o cliente do tipo App para computador com “Usar este cliente para um agente com IA” marcado. Não tente de novo antes disso.]',
    "[Google refused this connector's sign-in. Only the person can fix it: in Connectors, click Authorize on the connector. If Google blocks the sign-in, check in Google Cloud (Google Auth Platform): their email under Audience › Test users, while the app is in testing, and a Desktop app client with “Use this client for an AI-powered agent” ticked. Don't retry before that.]"
  )

// A call the server turned away for the sign-in: none or one it refused to renew ('missing'), a token refused
// even right after renewing ('refused'), or one without the permissions the tool needs ('scope').
export type SignInRefusal = 'missing' | 'refused' | 'scope'
export function signInRefusal(e: unknown): SignInRefusal | undefined {
  if (e instanceof UnauthorizedError) return 'missing'
  if (e instanceof StreamableHTTPError && e.code === 403 && /upscoping|insufficient.{0,30}scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(e.message)) return 'scope'
  if (e instanceof StreamableHTTPError && e.code === 401) return 'refused'
  return undefined
}

// What the person reads on the connector (and in the step) when a call was turned away for the sign-in.
export function signInMessage(name: string, why: SignInRefusal, google: boolean): string {
  if (why === 'scope')
    return L(
      `Falta permissão no login do ${name}: alguma caixa ficou desmarcada na tela de permissões. Em Conectores, clique em Autorizar no ${name} e marque todas.`,
      `The ${name} sign-in is missing a permission: a box was left unticked on the permission screen. In Connectors, click Authorize on ${name} and tick them all.`
    )
  if (why === 'missing')
    return L(`Falta autorizar o ${name}: em Conectores, clique em Autorizar no ${name}.`, `${name} needs authorization: in Connectors, click Authorize on ${name}.`)
  const base = L(
    `O servidor recusou o login do ${name}, mesmo renovado. Em Conectores, clique em Autorizar no ${name} pra entrar de novo.`,
    `The server refused the ${name} sign-in, even renewed. In Connectors, click Authorize on ${name} to sign in again.`
  )
  return google
    ? `${base} ${L(
        'Se o Google barrar o login, confira no Google Cloud se o seu e-mail está em Usuários de teste e se o cliente tem “Usar este cliente para um agente com IA” marcado.',
        'If Google blocks the sign-in, check in Google Cloud that your email is under Test users and that the client has “Use this client for an AI-powered agent” ticked.'
      )}`
    : base
}

// Why a tool call threw, in words: a timeout says how long it waited, an MCP error keeps the code and the
// data the server sent with it (the SDK's message leaves the data out).
export function callError(e: unknown, timeoutMs = CALL_TIMEOUT_MS): string {
  if (e instanceof McpError) {
    if (e.code === ErrorCode.RequestTimeout) {
      const s = Math.round(timeoutMs / 1000)
      return L(`O servidor não respondeu em ${s} s e a chamada foi cancelada.`, `The server didn't answer in ${s} s, so the call was cancelled.`)
    }
    const message = e.message.replace(/^(MCP error -?\d+:\s*)+/, '') // a server's own McpError arrives wrapped twice
    const data = e.data === undefined || e.data === null ? '' : typeof e.data === 'string' ? e.data : JSON.stringify(e.data)
    return `${message} (${L('código', 'code')} ${e.code})${data ? `: ${data}` : ''}`
  }
  // The network's reason, said plainly, with what Node said after it for whoever reads further.
  const net = netProblem(e)
  if (net && e instanceof Error && e.cause !== undefined) return `${netText(net)} (${net.detail})`
  const message = (e instanceof Error ? e.message : String(e)).trim()
  return message || L('A chamada falhou sem mensagem.', 'The call failed with no message.')
}

// The image a connector wears in the grid, in one of two shapes, put in line: an image file is scaled down
// by the screen and kept as a data: URI with the connector; an address is kept as the https URL it is.
// (index.html allows img-src 'self' data: tucano: https:, so a link shows and an http one never would.)
// Anything else is refused here, with what's allowed, before it reaches the database.
export const MAX_ICON_CHARS = 96_000 // ~70 kB of image: an icon, not a wallpaper, since it rides in every snapshot
export const MAX_ICON_URL = 2_048 // an address long enough for any CDN, short enough to stay a line
const ICON_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/
export function connectorIcon(value: string | undefined | null): string | undefined {
  const icon = (value ?? '').trim()
  if (!icon) return undefined
  if (!icon.startsWith('data:')) return iconUrl(icon)
  if (icon.length > MAX_ICON_CHARS) throw new Error(L('A imagem é grande demais para um ícone (até 70 kB). Escolha uma menor.', 'That image is too big for an icon (70 kB at most). Pick a smaller one.'))
  if (!ICON_DATA.test(icon)) throw new Error(L('Escolha um arquivo de imagem: PNG, JPEG, WebP ou GIF.', 'Choose an image file: PNG, JPEG, WebP or GIF.'))
  return icon
}

// An image address: https only, since the app's policy has no room for an image fetched over http.
function iconUrl(icon: string): string {
  let url: URL
  try {
    url = new URL(icon)
  } catch {
    throw new Error(L('Cole um endereço de imagem que comece em https://, ou escolha um arquivo.', 'Paste an image address that starts with https://, or choose a file.'))
  }
  if (url.protocol !== 'https:') throw new Error(L('O endereço da imagem precisa começar em https://.', 'The image address must start with https://.'))
  if (icon.length > MAX_ICON_URL) throw new Error(L('Esse endereço é longo demais para um ícone.', 'That address is too long for an icon.'))
  return icon
}

export interface ConnectorDeps {
  db: Db
  secrets: Secrets
  emit: (e: CoreEvent) => void
  openUrl: (url: string) => void
  oauthCallbackUrl: () => string
  readOp?: (ref: string) => Promise<string> // a 1Password reference's value (the op CLI; tests fake it)
  callTimeoutMs?: number // how long a tool call may take; tests shorten it
  // Where a sign-in with the person's own app comes back: Slack takes only the address registered in the
  // app, port and all, which the gateway's (new on each launch) can't be.
  fixedCallbackUrl?: () => string
  ownAppOf?: (url: string | undefined) => CatalogEntry['app'] // which servers sign in with the person's app; tests point it at their own
}

interface Live {
  client?: Client
  transport?: Transport
  status: ConnectorStatus
  error?: string
  errorDetail?: string // what the error said, causes and all, under "Ver detalhes"
  failures: number
  connecting?: Promise<void>
  retry?: NodeJS.Timeout // the next try after a drop
  retries?: number // tries since it last worked
  passing?: boolean // the last attempt failed for a reason that may go away by itself (network, timeout)
}

// What happened to the renewals of one connection attempt.
interface Renewal {
  failed?: boolean // the token endpoint didn't answer, or answered with a server error: the sign-in may still be good
}

type Answer = { status: number; statusText: string; headers: [string, string][]; body: string }

// The OAuth error a token endpoint answered with (RFC 6749 §5.2), if it answered with one.
const oauthError = (a: Answer): string | undefined => {
  if (a.status < 400 || a.status >= 500 || a.status === 429) return undefined
  try {
    const error = (JSON.parse(a.body) as { error?: unknown }).error
    return typeof error === 'string' ? error : undefined
  } catch {
    return undefined
  }
}

// The saved sign-in couldn't be opened (the system's key): nothing was deleted, and it isn't the server's doing.
const unreadableMessage = (auth: Connector['auth']): string =>
  auth === 'oauth'
    ? L(
        'Não consegui abrir o login salvo deste conector: o sistema não liberou a chave do Tucano. Nada foi apagado. Reinicie o Tucano e, se o sistema pedir acesso às chaves, permita; se não resolver, autorize de novo.',
        "I couldn't open this connector's saved sign-in: the system didn't release Tucano's key. Nothing was deleted. Restart Tucano and, if the system asks for access to the keys, allow it; if that doesn't help, authorize again."
      )
    : L(
        'Não consegui abrir as credenciais salvas deste conector: o sistema não liberou a chave do Tucano. Nada foi apagado. Reinicie o Tucano e, se o sistema pedir acesso às chaves, permita; se não resolver, salve a credencial de novo.',
        "I couldn't open this connector's saved credentials: the system didn't release Tucano's key. Nothing was deleted. Restart Tucano and, if the system asks for access to the keys, allow it; if that doesn't help, save the credential again."
      )

// The call never ran, so it can go again on a new connection: the server forgot this session (it expired
// while idle), or the client had no connection to send it on. Not "Connection closed": the SDK gives that to
// every call already sent when the connection drops, which the server may have run (a write would go twice).
export const staleSession = (e: unknown): boolean =>
  (e instanceof StreamableHTTPError && e.code === 404) || (e instanceof Error && /session not found|no valid session|invalid session id|^not connected$/i.test(e.message))

const key = (id: string, what: string): string => `connector:${id}:${what}`
const appKey = (provider: AppProvider): string => `${provider}:app`
const PROVIDER = { google: 'Google', slack: 'Slack' } satisfies Record<AppProvider, string>

// The OAuth client the person made (in Google Cloud, in their Slack workspace): neither takes an app it hasn't met.
export interface OwnApp {
  clientId: string
  clientSecret: string
}

// The authorization page, asking only for the scopes the connector's tools need (Google's servers list
// the full ones too, which the SDK would ask for). Google's also asks for a refresh token: it gives one
// only offline, and only on consent, so a connector doesn't stop working an hour after signing in.
export function ownAuthorization(url: URL, app: NonNullable<CatalogEntry['app']>): URL {
  const u = new URL(url)
  u.searchParams.set('scope', app.scopes.join(' '))
  if (app.provider === 'google') {
    u.searchParams.set('access_type', 'offline')
    u.searchParams.set('prompt', 'consent')
  }
  return u
}

// What a client ID of each looks like: Google's end in .apps.googleusercontent.com, Slack's are two numbers.
const CLIENT_ID: Record<AppProvider, { re: RegExp; pt: string; en: string }> = {
  google: { re: /^[\w.-]+\.apps\.googleusercontent\.com$/, pt: 'ele termina em .apps.googleusercontent.com', en: 'it ends in .apps.googleusercontent.com' },
  slack: { re: /^\d+\.\d+$/, pt: 'são dois números com um ponto, como 1234567890.1234567890', en: 'it is two numbers with a dot, like 1234567890.1234567890' }
}

// The gateway's callback port changes on every launch, and RFC 8252 §7.3 has an
// authorization server treat a loopback redirect as port-agnostic. Comparing the
// redirect without the port keeps the registration — and the refresh token, which
// belongs to the client that got it — across restarts, instead of signing in again.
// Only an http loopback address loses its port; anything else must match whole.
export const sameLoopbackRedirect = (a: string, b: string): boolean => {
  const shape = (u: string): string => {
    try {
      const { protocol, hostname, pathname, search } = new URL(u)
      const loopback = protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]')
      return loopback ? `${protocol}//${hostname}${pathname}${search}` : u
    } catch {
      return u
    }
  }
  return shape(a) === shape(b)
}

export class ConnectorManager {
  private live = new Map<string, Live>()
  private oauthStates = new Map<string, { connectorId: string; transport: StreamableHTTPClientTransport }>()
  private authUrls = new Map<string, string>() // a connector's last authorization page
  private doneStates = new Set<string>() // finished already (the callback got there first): not an expired one
  private closing = false // the app is quitting: nothing reconnects
  // Renewals under way or just done, by token endpoint and refresh token. A server that rotates refresh tokens
  // takes each one once: two requests renewing together would get one new sign-in and
  // one refusal, and the refusal made the SDK delete the sign-in the other had just saved.
  private renewals = new Map<string, Promise<Answer>>()
  private refused = new Set<string>() // refresh tokens a server refused
  // Connectors whose saved sign-in a server turned away even renewed, or that lacks a permission a tool needs:
  // renewing it again gets the same answer, so the next Authorize goes to the browser. The value says why.
  private freshSignIn = new Map<string, string>()

  constructor(private deps: ConnectorDeps) {}

  list(): Connector[] {
    return this.deps.db.connectors().map((c) => this.withStatus(c))
  }

  get(id: string): Connector | undefined {
    const c = this.deps.db.connector(id)
    return c && this.withStatus(c)
  }

  private withStatus(c: Omit<Connector, 'status' | 'error' | 'errorDetail'>): Connector {
    const l = this.live.get(c.id)
    return { ...c, status: l?.status ?? 'disconnected', error: l?.error, ...(l?.error && l.errorDetail ? { errorDetail: l.errorDetail } : {}) }
  }

  private setStatus(id: string, status: ConnectorStatus, error?: string | Friendly): void {
    const l = this.live.get(id) ?? { status, failures: 0 }
    l.status = status
    l.error = typeof error === 'string' ? error : error?.text
    l.errorDetail = typeof error === 'string' ? undefined : error?.detail
    this.live.set(id, l)
    this.emitConnector(id)
  }

  private emitConnector(id: string): void {
    const c = this.get(id)
    if (c) this.deps.emit({ type: 'connector', connector: c })
  }

  // `interactive`: someone just added it, so an OAuth sign-in opens the browser now instead of waiting for Authorize.
  async add(input: ConnectorInput, interactive = false): Promise<string> {
    const name = input.name.trim()
    if (!name) throw new Error(L('Dê um nome ao conector.', 'Give the connector a name.'))
    const icon = connectorIcon(input.icon)
    const id = randomUUID()
    if (input.kind === 'remote') {
      const url = new URL(input.url ?? '') // throws on an invalid URL
      if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(L('Use uma URL https.', 'Use an https URL.'))
      this.deps.db.saveConnector({ id, name, kind: 'remote', url: url.toString(), auth: input.auth ?? 'none', icon })
      if (input.auth === 'token' && input.token) await this.deps.secrets.set(key(id, 'token'), input.token.trim())
    } else {
      const command = input.command?.trim()
      if (!command) throw new Error(L('Informe o comando.', 'Enter the command.'))
      const env = input.env ?? {}
      this.deps.db.saveConnector({ id, name, kind: 'stdio', command, args: input.args ?? [], envKeys: Object.keys(env), auth: 'none', icon })
      if (Object.keys(env).length) await this.deps.secrets.setJson(key(id, 'env'), env)
    }
    this.emitConnector(id)
    void this.connect(id, interactive)
    return id
  }

  // The tile's image: set, replaced or taken off. No reconnect: nothing of the connection changes.
  setIcon(id: string, icon: string | undefined | null): void {
    if (!this.deps.db.connector(id)) throw new Error(L('Esse conector não existe mais.', 'That connector no longer exists.'))
    this.deps.db.setConnectorIcon(id, connectorIcon(icon))
    this.emitConnector(id)
  }

  // The person's app for a provider, and the address its sign-in comes back to (Slack's app registers it).
  async ownApp(provider: AppProvider): Promise<{ clientId?: string; redirectUrl: string }> {
    const app = await this.deps.secrets.getJson<OwnApp>(appKey(provider))
    return { ...(app ? { clientId: app.clientId } : {}), redirectUrl: this.redirectFor(provider) }
  }

  // Saves the person's app. Another one leaves its connectors signed in to the old one without a way
  // to renew: they sign in again, with this one.
  async setOwnApp(provider: AppProvider, input: OwnApp): Promise<void> {
    const clientId = input.clientId.trim()
    const clientSecret = input.clientSecret.trim()
    const shape = CLIENT_ID[provider]
    if (!shape.re.test(clientId)) throw new Error(L(`Esse não parece um ID do cliente do ${PROVIDER[provider]}: ${shape.pt}.`, `That doesn't look like a ${PROVIDER[provider]} client ID: ${shape.en}.`))
    if (!clientSecret) throw new Error(L('Cole a chave secreta do cliente.', 'Paste the client secret.'))
    const before = await this.deps.secrets.getJson<OwnApp>(appKey(provider))
    await this.deps.secrets.setJson(appKey(provider), { clientId, clientSecret })
    if (before && before.clientId === clientId) return
    for (const c of this.deps.db.connectors()) {
      if (c.kind !== 'remote' || this.appOf(c.url)?.provider !== provider) continue
      await this.deps.secrets.set(key(c.id, 'oauth_tokens'), undefined)
      void this.connect(c.id)
    }
  }

  private appOf(url: string | undefined): CatalogEntry['app'] {
    return (this.deps.ownAppOf ?? ownAppOf)(url)
  }

  private redirectFor(provider: AppProvider): string {
    return provider === 'slack' && this.deps.fixedCallbackUrl ? this.deps.fixedCallbackUrl() : this.deps.oauthCallbackUrl()
  }

  // Sets or replaces the token of a connector that signs in with one, and connects with it.
  async setToken(id: string, token: string): Promise<void> {
    const c = this.deps.db.connector(id)
    if (!c || c.kind !== 'remote' || c.auth !== 'token') throw new Error(L('Esse conector não usa token.', "This connector doesn't use a token."))
    const value = token.trim()
    if (!value) throw new Error(L('Cole o token.', 'Paste the token.'))
    await this.deps.secrets.set(key(id, 'token'), value)
    await this.live.get(id)?.connecting // an attempt under way read the old token: this one comes after it
    await this.connect(id)
  }

  async remove(id: string): Promise<void> {
    clearTimeout(this.live.get(id)?.retry)
    await this.disconnect(id)
    this.live.delete(id)
    this.deps.db.removeConnector(id)
    this.deps.emit({ type: 'connector_removed', id })
  }

  updateTool(connectorId: string, name: string, patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>>): void {
    this.deps.db.updateTool(connectorId, name, patch)
    this.emitConnector(connectorId)
  }

  connectAll(): void {
    for (const c of this.deps.db.connectors()) void this.connect(c.id)
  }

  // Settles when every connection attempt under way has finished, whether it worked or not;
  // undefined when none is, so whoever waits on it can go on at once.
  settled(): Promise<void> | undefined {
    const pending = [...this.live.values()].flatMap((l) => (l.connecting ? [l.connecting] : []))
    return pending.length ? Promise.allSettled(pending).then(() => {}) : undefined
  }

  async closeAll(): Promise<void> {
    this.closing = true
    for (const l of this.live.values()) clearTimeout(l.retry)
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)))
  }

  private async disconnect(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l?.client) return
    const client = l.client
    l.client = undefined
    l.transport = undefined
    await client.close().catch(() => {})
  }

  // Connects (or reconnects) and refreshes the tool list. `interactive` lets an
  // OAuth connector open the browser; background connects never do.
  connect(id: string, interactive = false): Promise<void> {
    const existing = this.live.get(id)?.connecting
    if (existing) return existing
    const p = this.doConnect(id, interactive).finally(() => {
      const l = this.live.get(id)
      if (l) l.connecting = undefined
    })
    const l = this.live.get(id) ?? { status: 'connecting' as const, failures: 0 }
    l.connecting = p
    this.live.set(id, l)
    return p
  }

  private async doConnect(id: string, interactive: boolean): Promise<void> {
    const c = this.deps.db.connector(id)
    if (!c) return
    await this.disconnect(id)
    this.setStatus(id, 'connecting')

    const client = new Client(
      { name: 'tucano', version: '0.1.0' },
      { listChanged: { tools: { onChanged: () => void this.refreshTools(id).catch(() => {}) } } }
    )
    let transport: Transport
    const renewal: Renewal = {}
    const own = c.kind === 'remote' && c.auth === 'oauth' ? this.appOf(c.url) : undefined
    if (own && !(await this.deps.secrets.getJson<OwnApp>(appKey(own.provider)))) {
      const name = PROVIDER[own.provider]
      this.setStatus(id, 'error', L(`Falta o seu app do ${name}: em Conectores, clique em Conectar no ${own.provider === 'google' ? 'conector do Google' : 'Slack'} e siga os passos.`, `Your ${name} app is missing: in Connectors, click Connect on ${own.provider === 'google' ? 'a Google connector' : 'Slack'} and follow the steps.`))
      return
    }
    try {
      if (c.kind === 'remote') {
        const headers: Record<string, string> = {}
        if (c.auth === 'token') {
          const token = await this.deps.secrets.get(key(id, 'token'))
          if (token) headers['Authorization'] = `Bearer ${await resolveOp(token, this.deps.readOp)}`
        }
        const provider = c.auth === 'oauth' ? this.oauthProvider(id, () => http, interactive, own) : undefined
        const fetchFn = c.auth === 'oauth' ? this.renewingFetch(renewal) : undefined
        const http: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(new URL(c.url!), {
          requestInit: { headers },
          authProvider: provider,
          ...(fetchFn ? { fetch: fetchFn } : {})
        })
        transport = http
        // Google's servers open and list their tools for anyone, and ask for the sign-in only on a call: without
        // a saved one the connector would look connected while every call fails with "Unauthorized". So a
        // server that signs in with the person's app asks for the sign-in here, before connecting.
        if (own && provider && fetchFn && (await this.needsSignIn(id, interactive))) {
          if (!interactive) {
            this.setStatus(id, 'needs_auth', this.freshSignIn.get(id) ?? L('Precisa autorizar.', 'Needs authorization.'))
            return
          }
          if ((await auth(provider, { serverUrl: new URL(c.url!), fetchFn })) === 'AUTHORIZED') {
            this.freshSignIn.delete(id)
          } else {
            this.setStatus(id, 'needs_auth', L('Conclua a autorização no navegador.', 'Finish the authorization in the browser.'))
            return
          }
        }
      } else {
        const env = await resolveOpRefs((await this.deps.secrets.getJson<Record<string, string>>(key(id, 'env'))) ?? {}, this.deps.readOp)
        transport = new StdioClientTransport({ command: c.command!, args: c.args, env: { ...getDefaultEnvironment(), ...env }, stderr: 'ignore' })
      }
    } catch (e) {
      // A 1Password secret that wasn't read, or a saved one the system's key won't open: it needs you, so no retries.
      this.setStatus(id, 'error', unreadable(e) ? unreadableMessage(c.auth) : e instanceof OpError ? e.message : connectProblem(e, c.url))
      return
    }

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
    } catch (e) {
      // A 401 without a sign-in flow comes back as the server's own body ("invalid_token" on
      // Linear's), so its status says it, not its text.
      const refused =
        e instanceof UnauthorizedError || (e instanceof StreamableHTTPError && e.code === 401) || (e instanceof Error && /unauthorized|401/i.test(e.message))
      if (unreadable(e)) {
        // Not the server: the saved sign-in is there, encrypted, and stays. No retries, no browser.
        await client.close().catch(() => {})
        this.setStatus(id, c.auth === 'oauth' ? 'needs_auth' : 'error', unreadableMessage(c.auth))
      } else if (refused && renewal.failed && !interactive) {
        // The sign-in is still good: the server that renews it didn't answer. It tries again by itself.
        await client.close().catch(() => {})
        this.setStatus(id, 'error', L('Não consegui renovar o login agora: o servidor de autorização não respondeu. Tento de novo sozinho.', "I couldn't renew the sign-in just now: the authorization server didn't answer. I'll try again by myself."))
        this.live.get(id)!.passing = true
        this.reconnectLater(id)
      } else if (refused && c.auth === 'token') {
        // With a token there is no browser to go to: the server refused it, or there is none yet.
        await client.close().catch(() => {})
        this.setStatus(id, 'error', L('O servidor recusou o token. Salve um token válido neste conector.', 'The server refused the token. Save a valid token on this connector.'))
      } else if (refused && c.auth !== 'oauth') {
        // Added with no sign-in at all, and the server asks for one.
        await client.close().catch(() => {})
        this.setStatus(id, 'error', L('O servidor pede autorização. Adicione de novo com OAuth ou token.', 'The server asks for authorization. Add it again with OAuth or a token.'))
      } else if (c.auth === 'oauth' && !interactive && (signInRefusal(e) === 'refused' || signInRefusal(e) === 'scope')) {
        // Turned away right after renewing, or short of a permission: renewing again gets the same answer, so
        // Authorize goes to the browser for a new sign-in.
        await client.close().catch(() => {})
        const message = signInMessage(c.name, signInRefusal(e)!, this.appOf(c.url)?.provider === 'google')
        this.freshSignIn.set(id, message)
        this.setStatus(id, 'needs_auth', message)
      } else if (refused) {
        this.setStatus(id, 'needs_auth', interactive ? L('Conclua a autorização no navegador.', 'Finish the authorization in the browser.') : L('Precisa autorizar.', 'Needs authorization.'))
      } else if (e instanceof Error && /dynamic client registration/i.test(e.message)) {
        // GitHub's MCP server, for one: its OAuth only serves apps registered ahead of time, so a token is the way in.
        await client.close().catch(() => {})
        this.setStatus(
          id,
          'error',
          L(
            'Esse servidor não deixa apps se registrarem pelo navegador. Adicione de novo com autenticação por token (no GitHub: um token de acesso pessoal, em github.com/settings/personal-access-tokens).',
            "This server doesn't let apps register through the browser. Add it again with token authentication (on GitHub: a personal access token, from github.com/settings/personal-access-tokens)."
          )
        )
      } else if (e instanceof Error && /timed out/i.test(e.message)) {
        await client.close().catch(() => {})
        this.setStatus(id, 'error', L(`O servidor não respondeu em ${CONNECT_TIMEOUT_MS / 1000} s. Confira o endereço e a sua rede.`, `The server didn't answer in ${CONNECT_TIMEOUT_MS / 1000} s. Check the address and your network.`))
        this.live.get(id)!.passing = true
        this.reconnectLater(id)
      } else {
        this.setStatus(id, 'error', connectProblem(e, c.url))
        this.live.get(id)!.passing = true
        this.reconnectLater(id)
      }
      return
    }
    const l = this.live.get(id)!
    l.client = client
    l.transport = transport
    l.failures = 0
    l.retries = 0
    l.passing = false
    // Closed by us (disconnect clears the client first) it stays closed; closed on its own, it comes back.
    transport.onclose = () => {
      if (this.live.get(id)?.client === client) {
        l.client = undefined
        this.setStatus(id, 'disconnected')
        this.reconnectLater(id)
      }
    }
    try {
      await this.refreshTools(id)
      this.setStatus(id, 'connected')
    } catch (e) {
      this.setStatus(id, 'error', e instanceof Error ? e.message : String(e))
    }
  }

  // Connects again after a wait that grows with each try, while the connector exists and nothing else has
  // brought it back. A failure that won't pass by itself (a refused token, a sign-in to finish) stops it.
  private reconnectLater(id: string): void {
    const l = this.live.get(id)
    if (!l || l.retry || this.closing) return
    const attempt = l.retries ?? 0
    if (attempt >= RECONNECT_DELAYS_MS.length) return
    l.retry = setTimeout(() => {
      l.retry = undefined
      if (this.closing || !this.deps.db.connector(id) || this.live.get(id)?.client) return
      l.retries = attempt + 1
      void this.connect(id).then(() => {
        const now = this.live.get(id)
        if (now && !now.client && (now.status === 'disconnected' || now.passing)) this.reconnectLater(id)
      })
    }, RECONNECT_DELAYS_MS[attempt])
    l.retry.unref?.()
  }

  private async refreshTools(id: string): Promise<void> {
    const client = this.live.get(id)?.client
    if (!client) return
    const listed: Parameters<Db['syncTools']>[1] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined)
      for (const t of page.tools) {
        listed.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown>, cls: classify(t), legacyCls: legacyClassify(t) })
      }
      cursor = page.nextCursor
    } while (cursor)
    this.deps.db.syncTools(id, listed)
    this.emitConnector(id)
  }

  // Runs a tool on the real server, reconnecting on demand. Stdio servers that
  // keep failing are marked as having a problem. What it throws says why, in words.
  async call(id: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const timeout = this.deps.callTimeoutMs ?? CALL_TIMEOUT_MS
    let l = this.live.get(id)
    if (!l?.client) {
      await this.connect(id)
      l = this.live.get(id)
    }
    if (!l?.client) throw new Error(L(`O conector ${this.deps.db.connector(id)?.name ?? id} não está conectado`, `The connector ${this.deps.db.connector(id)?.name ?? id} isn't connected`) + (l?.error ? `: ${l.error}.` : '.'))
    try {
      const r = (await l.client.callTool({ name, arguments: args }, undefined, { timeout })) as CallToolResult
      l.failures = 0
      return this.explained(id, r)
    } catch (e) {
      let failure = e
      if (staleSession(e)) {
        await this.connect(id)
        const again = this.live.get(id)?.client
        if (again) {
          try {
            return this.explained(id, (await again.callTool({ name, arguments: args }, undefined, { timeout })) as CallToolResult)
          } catch (e2) {
            failure = e2
          }
        } else {
          const why = this.live.get(id)?.error
          throw new Error(L('A sessão com o servidor expirou e não deu pra conectar de novo', 'The session with the server expired and it could not connect again') + (why ? `: ${why}` : '.'), { cause: e })
        }
      }
      const c = this.deps.db.connector(id)
      if (c?.kind === 'stdio' && ++l.failures >= MAX_STDIO_FAILURES) this.setStatus(id, 'error', L(`Falhou ${l.failures} vezes seguidas.`, `Failed ${l.failures} times in a row.`))
      const refusal = c?.auth === 'oauth' ? signInRefusal(failure) : undefined
      if (c && refusal) throw new Error(await this.turnedAway(c, refusal), { cause: failure })
      const why = callError(failure, timeout)
      const hint = googleHint(c?.url, why)
      throw new Error(hint ? `${hint} ${why}` : why, { cause: failure })
    }
  }

  // A call turned away for the sign-in: the connector asks for it (Authorize shows up), and the step says what
  // to do. A renewal that failed for a passing reason (no network) keeps the sign-in: the next call renews it.
  private async turnedAway(c: Omit<Connector, 'status' | 'error'>, why: SignInRefusal): Promise<string> {
    const google = this.appOf(c.url)?.provider === 'google'
    if (why === 'missing' && !this.freshSignIn.has(c.id) && (await this.renewable(c.id)))
      return L(
        `Não consegui renovar o login do ${c.name} agora: o servidor de autorização não respondeu. Tente de novo daqui a pouco.`,
        `I couldn't renew the ${c.name} sign-in just now: the authorization server didn't answer. Try again in a moment.`
      )
    const message = signInMessage(c.name, why, google)
    if (why !== 'missing') this.freshSignIn.set(c.id, message)
    clearTimeout(this.live.get(c.id)?.retry)
    await this.disconnect(c.id)
    this.setStatus(c.id, 'needs_auth', message)
    const hint = google ? (why === 'scope' ? GOOGLE_SCOPE_HINT() : why === 'refused' ? GOOGLE_SIGN_IN_HINT() : undefined) : undefined
    return hint ? `${hint} ${message}` : message
  }

  // Whether a connector that signs in with the person's app has to sign in (in the browser) before connecting:
  // no sign-in saved, or one the server turned away. A saved one the system's key won't open is left to the
  // connection, which says so (and, from Authorize, signs in again in its place).
  private async needsSignIn(id: string, interactive: boolean): Promise<boolean> {
    if (this.freshSignIn.has(id)) return true
    try {
      return !(await this.deps.secrets.getJson<OAuthTokens>(key(id, 'oauth_tokens')))
    } catch (e) {
      return interactive && !!unreadable(e)
    }
  }

  // A failed result with a known cause gets that cause first, in words the agent can pass on.
  private explained(id: string, r: CallToolResult): CallToolResult {
    const hint = r.isError ? googleHint(this.deps.db.connector(id)?.url, errorReason(r)) : undefined
    return hint ? { ...r, content: [{ type: 'text', text: hint }, ...(r.content ?? [])] } : r
  }

  // ---------- OAuth ----------

  // The authorization page's address comes back too: on a server there's no
  // browser to open it in, so the page the person is using opens it.
  // A sign-in that can still be renewed (the server was away, the attempt hit a passing error) comes back
  // without the browser: signing in again would register another app and throw the saved one away.
  async authorize(id: string): Promise<string | undefined> {
    this.authUrls.delete(id)
    if (this.live.get(id)?.client) return undefined
    if (await this.renewable(id)) {
      await this.connect(id).catch(() => {})
      if (this.live.get(id)?.client) return undefined
    }
    await this.connect(id, true).catch(() => {})
    return this.authUrls.get(id)
  }

  private async renewable(id: string): Promise<boolean> {
    if (this.freshSignIn.has(id)) return false
    const tokens = await this.deps.secrets.getJson<OAuthTokens>(key(id, 'oauth_tokens')).catch(() => undefined)
    return !!tokens?.refresh_token && !this.refused.has(tokens.refresh_token)
  }

  // The fetch an OAuth connection uses. A renewal (grant_type=refresh_token) goes to the server once per refresh
  // token: a request that renews with the same one meanwhile gets the same answer. It also notes a renewal the
  // server refused, and one that failed without saying the sign-in is bad (no answer, a server error).
  private renewingFetch(renewal: Renewal): typeof fetch {
    return async (input, init) => {
      const form = init?.body instanceof URLSearchParams ? init.body : undefined
      const refreshToken = form?.get('grant_type') === 'refresh_token' ? form.get('refresh_token') : null
      if (!refreshToken) return fetch(input, init)
      const k = `${input instanceof Request ? input.url : String(input)} ${refreshToken}`
      let answer = this.renewals.get(k)
      if (!answer) {
        answer = fetch(input, init).then(async (r) => ({ status: r.status, statusText: r.statusText, headers: [...r.headers], body: await r.text() }))
        this.renewals.set(k, answer)
        // A new sign-in or a refusal holds for whoever asks next; a failure is tried again.
        answer.then(
          (a) => (a.status < 300 || oauthError(a) !== undefined ? setTimeout(() => this.renewals.delete(k), RENEWAL_KEEP_MS).unref?.() : this.renewals.delete(k)),
          () => this.renewals.delete(k)
        )
      }
      let a: Answer
      try {
        a = await answer
      } catch (e) {
        renewal.failed = true
        throw e
      }
      if (a.status >= 300) {
        const error = oauthError(a)
        if (error === 'invalid_grant') this.refused.add(refreshToken)
        // No word on the sign-in itself: a proxy's page, a server error, too many requests.
        else if (error === undefined || error === 'server_error' || error === 'temporarily_unavailable') renewal.failed = true
      }
      return new Response(a.body, { status: a.status, statusText: a.statusText, headers: a.headers })
    }
  }

  // On a server the authorization page sends the person's browser to the
  // callback on the server's own loopback, which it can't reach; the address
  // it was sent to carries the code, and the person pastes it here.
  async finishOAuthFromUrl(pasted: string): Promise<boolean> {
    let url: URL
    try {
      url = new URL(pasted.trim())
    } catch {
      throw new Error(L('Isso não parece um endereço. Copie o endereço inteiro da barra do navegador.', "That doesn't look like an address. Copy the whole address from the browser's bar."))
    }
    const code = url.searchParams.get('code')
    if (!code) throw new Error(notAuthorized(url))
    return this.finishOAuth(url.searchParams.get('state') ?? '', code)
  }

  // Called by the local HTTP server when the browser comes back from the authorization page.
  async finishOAuth(state: string, code: string): Promise<boolean> {
    const pending = this.oauthStates.get(state)
    if (!pending) return this.doneStates.has(state)
    this.oauthStates.delete(state)
    this.doneStates.add(state)
    await pending.transport.finishAuth(code)
    this.freshSignIn.delete(pending.connectorId)
    await this.connect(pending.connectorId)
    return true
  }

  // `own`: a server that signs in with the person's own app (Google's, Slack's) instead of registering one.
  private oauthProvider(id: string, transport: () => StreamableHTTPClientTransport, interactive: boolean, own?: CatalogEntry['app']): OAuthClientProvider {
    const { secrets } = this.deps
    const redirectUrl = own ? this.redirectFor(own.provider) : this.deps.oauthCallbackUrl()
    // Signing in again (someone clicked Authorize) goes on past a saved value the system's key won't open:
    // the new sign-in takes its place. In the background it stops the attempt, and the value stays.
    const read = async <T>(k: string): Promise<T | undefined> => {
      try {
        return await secrets.getJson<T>(k)
      } catch (e) {
        if (interactive && unreadable(e)) return undefined
        throw e
      }
    }
    let state = ''
    return {
      get redirectUrl() {
        return redirectUrl
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'Tucano',
          redirect_uris: [redirectUrl],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none'
        }
      },
      state: () => {
        state = randomBytes(16).toString('hex')
        return state
      },
      // The callback port changes between launches; the registration is still good,
      // so the refresh token that goes with it survives the restart (a refresh sends no
      // redirect). Signing in again, it must be the exact address: a server that
      // doesn't take any port on loopback would turn the new one away, so it registers again.
      clientInformation: async () => {
        if (own) {
          const app = await secrets.getJson<OwnApp>(appKey(own.provider))
          return app && { client_id: app.clientId, client_secret: app.clientSecret }
        }
        const info = await read<OAuthClientInformationMixed & { redirect_uris?: string[] }>(key(id, 'oauth_client'))
        const fits = (u: string): boolean => (interactive ? u === redirectUrl : sameLoopbackRedirect(u, redirectUrl))
        return info && (!info.redirect_uris || info.redirect_uris.some(fits)) ? info : undefined
      },
      saveClientInformation: (info) => (own ? undefined : secrets.setJson(key(id, 'oauth_client'), { ...info, redirect_uris: [redirectUrl] })),
      // A sign-in the server turned away even renewed isn't offered when signing in again: the SDK would renew it
      // once more instead of going to the browser.
      tokens: () => (interactive && this.freshSignIn.has(id) ? Promise.resolve(undefined) : read<OAuthTokens>(key(id, 'oauth_tokens'))),
      saveTokens: (t) => secrets.setJson(key(id, 'oauth_tokens'), t),
      saveCodeVerifier: (v) => secrets.set(key(id, 'oauth_verifier'), v),
      codeVerifier: async () => (await secrets.get(key(id, 'oauth_verifier'))) ?? '',
      redirectToAuthorization: (page) => {
        if (!interactive) return // never pop a browser on a background reconnect
        const url = own ? ownAuthorization(page, own) : page
        this.oauthStates.set(state || url.searchParams.get('state') || '', { connectorId: id, transport: transport() })
        this.authUrls.set(id, url.toString())
        this.deps.openUrl(url.toString())
      },
      invalidateCredentials: async (scope) => {
        if ((scope === 'all' || scope === 'client') && !own) await secrets.set(key(id, 'oauth_client'), undefined) // the app is the person's
        // Only a sign-in the server refused: one saved meanwhile (by a renewal that got there first) stays.
        if (scope === 'all' || scope === 'tokens') {
          const saved = await read<OAuthTokens>(key(id, 'oauth_tokens')).catch((e: unknown) => (unreadable(e) ? 'unreadable' : undefined))
          if (saved !== 'unreadable' && (scope === 'all' || !saved?.refresh_token || this.refused.has(saved.refresh_token))) await secrets.set(key(id, 'oauth_tokens'), undefined)
        }
        if (scope === 'all' || scope === 'verifier') await secrets.set(key(id, 'oauth_verifier'), undefined)
      }
    }
  }
}
