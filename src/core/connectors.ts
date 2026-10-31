// Connections to the MCP servers the user added. The app is the only MCP
// client of these servers: agents reach them through the gateway, never
// directly, so every call passes the grant and approval checks first.
import { randomBytes, randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js'
import { L } from '../shared/lang'
import type { CoreEvent } from '../shared/rpc'
import type { Connector, ConnectorInput, ConnectorStatus, ConnectorTool } from '../shared/types'
import type { Db } from './db'
import { classify } from './policy'
import type { Secrets } from './secrets'

const CALL_TIMEOUT_MS = 120_000
// A server that doesn't answer the handshake shows an error instead of "conectando…" for a minute.
const CONNECT_TIMEOUT_MS = 20_000
const MAX_STDIO_FAILURES = 3

export interface ConnectorDeps {
  db: Db
  secrets: Secrets
  emit: (e: CoreEvent) => void
  openUrl: (url: string) => void
  oauthCallbackUrl: () => string
}

interface Live {
  client?: Client
  transport?: Transport
  status: ConnectorStatus
  error?: string
  failures: number
  connecting?: Promise<void>
}

const key = (id: string, what: string): string => `connector:${id}:${what}`

export class ConnectorManager {
  private live = new Map<string, Live>()
  private oauthStates = new Map<string, { connectorId: string; transport: StreamableHTTPClientTransport }>()
  private authUrls = new Map<string, string>() // a connector's last authorization page
  private doneStates = new Set<string>() // finished already (the callback got there first): not an expired one

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

  async add(input: ConnectorInput): Promise<string> {
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
    void this.connect(id)
    return id
  }

  async remove(id: string): Promise<void> {
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

  async closeAll(): Promise<void> {
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
      if (e instanceof UnauthorizedError || (e instanceof Error && /unauthorized|401/i.test(e.message))) {
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
      } else {
        this.setStatus(id, 'error', e instanceof Error ? e.message : String(e))
      }
      return
    }
    const l = this.live.get(id)!
    l.client = client
    l.transport = transport
    l.failures = 0
    transport.onclose = () => {
      if (this.live.get(id)?.client === client) {
        l.client = undefined
        this.setStatus(id, 'disconnected')
      }
    }
    try {
      await this.refreshTools(id)
      this.setStatus(id, 'connected')
    } catch (e) {
      this.setStatus(id, 'error', e instanceof Error ? e.message : String(e))
    }
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
  // keep failing are marked as having a problem.
  async call(id: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    let l = this.live.get(id)
    if (!l?.client) {
      await this.connect(id)
      l = this.live.get(id)
    }
    if (!l?.client) throw new Error(L(`O conector ${this.deps.db.connector(id)?.name ?? id} não está conectado`, `The connector ${this.deps.db.connector(id)?.name ?? id} isn't connected`) + (l?.error ? `: ${l.error}.` : '.'))
    try {
      const r = (await l.client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult
      l.failures = 0
      return r
    } catch (e) {
      const c = this.deps.db.connector(id)
      if (c?.kind === 'stdio' && ++l.failures >= MAX_STDIO_FAILURES) this.setStatus(id, 'error', L(`Falhou ${l.failures} vezes seguidas.`, `Failed ${l.failures} times in a row.`))
      throw e
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
    if (!code) throw new Error(L(`Autorização não concluída: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'o endereço não tem o código'}.`, `Authorization not completed: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'the address has no code'}.`))
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
      // The callback port changes between launches; a registration for another
      // redirect URL is useless, so register again.
      clientInformation: async () => {
        const info = await secrets.getJson<OAuthClientInformationMixed & { redirect_uris?: string[] }>(key(id, 'oauth_client'))
        return info && (!info.redirect_uris || info.redirect_uris.includes(redirectUrl)) ? info : undefined
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
