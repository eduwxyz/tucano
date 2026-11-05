// Connections to the MCP servers the user added. The app is the only MCP
// client of these servers: agents reach them through the gateway, never
// directly, so every call passes the grant and approval checks first.
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { ErrorCode, McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { L } from '../shared/lang'
import { friendly } from '../shared/errors'
import type { CoreEvent } from '../shared/rpc'
import type { Connector, ConnectorInput, ConnectorStatus, ConnectorTool } from '../shared/types'
import type { Db } from './db'
import { classify } from './policy'
import type { Secrets } from './secrets'

const CALL_TIMEOUT_MS = 120_000
// A server that doesn't answer the handshake shows an error instead of "conectando…" for a minute.
const CONNECT_TIMEOUT_MS = 20_000
const MAX_STDIO_FAILURES = 3
// A connection that dropped on its own (the server's process ended, the network went), or an attempt that
// failed for a passing reason, is tried again after these waits; then it waits for a call or the button.
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 60_000, 300_000]

// The authorization page sent the browser back without a code: why, and what to do.
export function notAuthorized(url: URL): string {
  const error = url.searchParams.get('error')
  if (error === 'access_denied') return L('Você recusou o acesso na página do serviço. Tente de novo e clique em Permitir.', 'You declined access on the service’s page. Try again and click Allow.')
  const why = url.searchParams.get('error_description') ?? error ?? L('o endereço não tem o código', 'the address has no code')
  return L(`Autorização não concluída: ${why}. Tente de novo pelo app.`, `Authorization not completed: ${why}. Try again from the app.`)
}

// Why a server didn't open, in words that say what to do; the SDK's own text otherwise.
export function connectError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).trim()
  const f = friendly(raw)
  if (f.detail === raw) return f.text // a case it knows: no Node.js, no internet, a refused login…
  if (/ENOENT/.test(raw)) return L('O comando do conector não foi encontrado. Se ele usa npx, instale o Node.js (nodejs.org).', "The connector's command wasn't found. If it uses npx, install Node.js (nodejs.org).")
  if (/connection closed/i.test(raw)) return L('O servidor fechou logo ao abrir. Confira o comando e os argumentos do conector.', 'The server closed right after opening. Check the connector’s command and arguments.')
  return raw
}

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
  const message = (e instanceof Error ? e.message : String(e)).trim()
  return message || L('A chamada falhou sem mensagem.', 'The call failed with no message.')
}

export interface ConnectorDeps {
  db: Db
  secrets: Secrets
  emit: (e: CoreEvent) => void
  openUrl: (url: string) => void
  oauthCallbackUrl: () => string
  callTimeoutMs?: number // how long a tool call may take; tests shorten it
}

interface Live {
  client?: Client
  transport?: Transport
  status: ConnectorStatus
  error?: string
  failures: number
  connecting?: Promise<void>
  retry?: NodeJS.Timeout // the next try after a drop
  retries?: number // tries since it last worked
  passing?: boolean // the last attempt failed for a reason that may go away by itself (network, timeout)
}

// The call never ran, so it can go again on a new connection: the server forgot this session (it expired
// while idle), or the client had no connection to send it on. Not "Connection closed": the SDK gives that to
// every call already sent when the connection drops, which the server may have run (a write would go twice).
export const staleSession = (e: unknown): boolean =>
  (e instanceof StreamableHTTPError && e.code === 404) || (e instanceof Error && /session not found|no valid session|invalid session id|^not connected$/i.test(e.message))

const key = (id: string, what: string): string => `connector:${id}:${what}`

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

  constructor(private deps: ConnectorDeps) {}

  list(): Connector[] {
    return this.deps.db.connectors().map((c) => this.withStatus(c))
  }

  get(id: string): Connector | undefined {
    const c = this.deps.db.connector(id)
    return c && this.withStatus(c)
  }

  private withStatus(c: Omit<Connector, 'status' | 'error'>): Connector {
    const l = this.live.get(c.id)
    return { ...c, status: l?.status ?? 'disconnected', error: l?.error }
  }

  private setStatus(id: string, status: ConnectorStatus, error?: string): void {
    const l = this.live.get(id) ?? { status, failures: 0 }
    l.status = status
    l.error = error
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
    const id = randomUUID()
    if (input.kind === 'remote') {
      const url = new URL(input.url ?? '') // throws on an invalid URL
      if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') throw new Error(L('Use uma URL https.', 'Use an https URL.'))
      this.deps.db.saveConnector({ id, name, kind: 'remote', url: url.toString(), auth: input.auth ?? 'none' })
      if (input.auth === 'token' && input.token) await this.deps.secrets.set(key(id, 'token'), input.token.trim())
    } else {
      const command = input.command?.trim()
      if (!command) throw new Error(L('Informe o comando.', 'Enter the command.'))
      const env = input.env ?? {}
      this.deps.db.saveConnector({ id, name, kind: 'stdio', command, args: input.args ?? [], envKeys: Object.keys(env), auth: 'none' })
      if (Object.keys(env).length) await this.deps.secrets.setJson(key(id, 'env'), env)
    }
    this.emitConnector(id)
    void this.connect(id, interactive)
    return id
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
    if (c.kind === 'remote') {
      const headers: Record<string, string> = {}
      if (c.auth === 'token') {
        const token = await this.deps.secrets.get(key(id, 'token'))
        if (token) headers['Authorization'] = `Bearer ${token}`
      }
      const http: StreamableHTTPClientTransport = new StreamableHTTPClientTransport(new URL(c.url!), {
        requestInit: { headers },
        authProvider: c.auth === 'oauth' ? this.oauthProvider(id, () => http, interactive) : undefined
      })
      transport = http
    } else {
      const env = (await this.deps.secrets.getJson<Record<string, string>>(key(id, 'env'))) ?? {}
      transport = new StdioClientTransport({ command: c.command!, args: c.args, env: { ...getDefaultEnvironment(), ...env }, stderr: 'ignore' })
    }

    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS })
    } catch (e) {
      // A 401 without a sign-in flow comes back as the server's own body ("invalid_token" on
      // Linear's), so its status says it, not its text.
      const refused =
        e instanceof UnauthorizedError || (e instanceof StreamableHTTPError && e.code === 401) || (e instanceof Error && /unauthorized|401/i.test(e.message))
      if (refused && c.auth === 'token') {
        // With a token there is no browser to go to: the server refused it, or there is none yet.
        await client.close().catch(() => {})
        this.setStatus(id, 'error', L('O servidor recusou o token. Salve um token válido neste conector.', 'The server refused the token. Save a valid token on this connector.'))
      } else if (refused && c.auth !== 'oauth') {
        // Added with no sign-in at all, and the server asks for one.
        await client.close().catch(() => {})
        this.setStatus(id, 'error', L('O servidor pede autorização. Adicione de novo com OAuth ou token.', 'The server asks for authorization. Add it again with OAuth or a token.'))
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
        this.setStatus(id, 'error', connectError(e))
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
        listed.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema as Record<string, unknown>, cls: classify(t) })
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
      return r
    } catch (e) {
      let failure = e
      if (staleSession(e)) {
        await this.connect(id)
        const again = this.live.get(id)?.client
        if (again) {
          try {
            return (await again.callTool({ name, arguments: args }, undefined, { timeout })) as CallToolResult
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
      throw new Error(callError(failure, timeout), { cause: failure })
    }
  }

  // ---------- OAuth ----------

  // The authorization page's address comes back too: on a server there's no
  // browser to open it in, so the page the person is using opens it.
  async authorize(id: string): Promise<string | undefined> {
    this.authUrls.delete(id)
    await this.connect(id, true).catch(() => {})
    return this.authUrls.get(id)
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
    await this.connect(pending.connectorId)
    return true
  }

  private oauthProvider(id: string, transport: () => StreamableHTTPClientTransport, interactive: boolean): OAuthClientProvider {
    const { secrets } = this.deps
    const redirectUrl = this.deps.oauthCallbackUrl()
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
        const info = await secrets.getJson<OAuthClientInformationMixed & { redirect_uris?: string[] }>(key(id, 'oauth_client'))
        const fits = (u: string): boolean => (interactive ? u === redirectUrl : sameLoopbackRedirect(u, redirectUrl))
        return info && (!info.redirect_uris || info.redirect_uris.some(fits)) ? info : undefined
      },
      saveClientInformation: (info) => secrets.setJson(key(id, 'oauth_client'), { ...info, redirect_uris: [redirectUrl] }),
      tokens: () => secrets.getJson<OAuthTokens>(key(id, 'oauth_tokens')),
      saveTokens: (t) => secrets.setJson(key(id, 'oauth_tokens'), t),
      saveCodeVerifier: (v) => secrets.set(key(id, 'oauth_verifier'), v),
      codeVerifier: async () => (await secrets.get(key(id, 'oauth_verifier'))) ?? '',
      redirectToAuthorization: (url) => {
        if (!interactive) return // never pop a browser on a background reconnect
        this.oauthStates.set(state || url.searchParams.get('state') || '', { connectorId: id, transport: transport() })
        this.authUrls.set(id, url.toString())
        this.deps.openUrl(url.toString())
      },
      invalidateCredentials: async (scope) => {
        if (scope === 'all' || scope === 'client') await secrets.set(key(id, 'oauth_client'), undefined)
        if (scope === 'all' || scope === 'tokens') await secrets.set(key(id, 'oauth_tokens'), undefined)
        if (scope === 'all' || scope === 'verifier') await secrets.set(key(id, 'oauth_verifier'), undefined)
      }
    }
  }
}
