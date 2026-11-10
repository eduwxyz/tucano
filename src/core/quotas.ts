// Asking each provider what the person still has left, from the logins already on this computer:
// the CLIs Tucano runs (Claude Code, Codex, OpenCode), and the ones Pi and Hermes are signed in to.
//
// Read-only on purpose: Tucano never refreshes a token it borrowed, never writes to another
// tool's auth file, and never logs one. An expired login shows up as that one column saying so,
// and the others still answer.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { L } from '../shared/lang'
import type { ProviderQuota } from '../shared/types'
import { parseQuota, type QuotaRead } from './quota-parsers'

const TIMEOUT = 8_000
const MAX_BODY = 256 * 1024
const UA = 'Tucano/1.0 (+https://github.com/eduwxyz/tucano)'

// One provider's login, as found on disk.
export interface Source {
  provider: string
  label: string
  via: string // which tool's login this is
  secret: string
  accountId?: string // Codex's ChatGPT account, sent as a header
  plan?: string
}

export type HttpGet = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>

export const PROVIDER_LABELS: Record<string, string> = {
  'openai-codex': 'Codex',
  'anthropic-claude-code': 'Claude Code',
  'opencode-go': 'OpenCode Go',
  'xai-oauth': 'Grok',
  zai: 'Z.ai',
  'github-copilot': 'GitHub Copilot',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek'
}
// The order the panel draws them in: the ones a plan runs out on first, then the wallets.
const ORDER = Object.keys(PROVIDER_LABELS)
// What Pi, Hermes and OpenCode call a provider, and what Tucano calls it.
const ALIAS: Record<string, string> = {
  'openai-codex': 'openai-codex',
  codex: 'openai-codex',
  'opencode-go': 'opencode-go',
  zai: 'zai',
  'xai-oauth': 'xai-oauth',
  grok: 'xai-oauth',
  '/copilot': 'github-copilot',
  'github-copilot': 'github-copilot',
  copilot: 'github-copilot',
  openrouter: 'openrouter',
  deepseek: 'deepseek'
}

const json = (path: string): Record<string, unknown> | undefined => {
  try {
    if (!existsSync(path)) return undefined
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined // a file being written, or not ours: it just isn't a source
  }
}
const at = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined)

// Every login that can answer for a quota, the tool's own first. `root` puts every tool's folder
// under one home, which is how a fixture run stands in for a computer; without it the person's.
export function quotaSources(root?: string, env: NodeJS.ProcessEnv = process.env): Source[] {
  const home = root ?? homedir()
  const local = root ? join(root, 'AppData', 'Local') : text(env['LOCALAPPDATA']) ?? join(home, 'AppData', 'Local')
  const data = root ? join(root, '.local', 'share') : text(env['XDG_DATA_HOME']) ?? join(home, '.local', 'share')
  const found: Source[] = []
  const add = (provider: string, via: string, secret: string | undefined, accountId?: string, plan?: string): void => {
    if (!secret || found.some((s) => s.provider === provider)) return
    found.push({ provider, label: PROVIDER_LABELS[provider] ?? provider, via, secret, ...(accountId ? { accountId } : {}), ...(plan ? { plan } : {}) })
  }

  // Claude Code, on the subscription: the OAuth token its own CLI keeps.
  const claude = json(join(home, '.claude', '.credentials.json'))
  const oauth = at(claude?.['claudeAiOauth'] ?? claude)
  add('anthropic-claude-code', 'Claude Code', text(oauth['accessToken'] ?? oauth['access_token']), undefined, text(oauth['subscriptionType']))

  // Codex, on the ChatGPT plan: the account id goes with the token, in a header.
  const codex = at(json(join(home, '.codex', 'auth.json'))?.['tokens'])
  add('openai-codex', 'Codex', text(codex['access_token']), text(codex['account_id']))

  // OpenCode's own logins: the Go subscription is a key, Zen is a balance.
  const opencode = json(join(data, 'opencode', 'auth.json'))
  for (const [key, raw] of Object.entries(opencode ?? {})) {
    const provider = ALIAS[key]
    const entry = at(raw)
    if (provider) add(provider, 'OpenCode', text(entry['key'] ?? entry['apiKey'] ?? entry['access']))
  }

  // Pi, which keeps its providers in one auth.json of its own.
  const pi = json(join(home, '.pi', 'agent', 'auth.json'))
  for (const [key, raw] of Object.entries(pi ?? {})) {
    const provider = ALIAS[key]
    const entry = at(raw)
    if (provider) add(provider, 'Pi', text(entry['key'] ?? entry['apiKey'] ?? entry['access']), text(entry['accountId'] ?? entry['account_id']))
  }

  // Hermes: its providers, then its credential pool (which mostly keeps fingerprints, not secrets).
  const hermes = json(join(local, 'hermes', 'auth.json'))
  for (const [key, raw] of Object.entries(at(hermes?.['providers']))) {
    const provider = ALIAS[key]
    const tokens = at(at(raw)['tokens'])
    if (provider) add(provider, 'Hermes', text(tokens['access_token'] ?? tokens['accessToken']))
  }
  for (const [key, raw] of Object.entries(at(hermes?.['credential_pool']))) {
    const provider = ALIAS[key]
    const first = Array.isArray(raw) ? at(raw[0]) : {}
    if (provider) add(provider, 'Hermes', text(first['access_token'] ?? first['key'] ?? first['api_key'] ?? first['secret']), text(first['account_id']))
  }

  return found
}

// The request each provider's quota is asked for.
function ask(source: Source): { url: string; headers: Record<string, string> } {
  const auth = { authorization: `Bearer ${source.secret}`, accept: 'application/json', 'user-agent': UA }
  switch (source.provider) {
    case 'openai-codex':
      return {
        url: 'https://chatgpt.com/backend-api/wham/usage',
        headers: { ...auth, ...(source.accountId ? { 'chatgpt-account-id': source.accountId } : {}) }
      }
    case 'anthropic-claude-code':
      return {
        url: 'https://api.anthropic.com/api/oauth/usage',
        // The usage route takes the CLI's own identity: without the beta header it answers 404.
        headers: { ...auth, 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'claude-cli/2.1.75 (external, cli)' }
      }
    case 'opencode-go':
      return { url: 'https://opencode.ai/zen/go/v1/usage', headers: auth }
    case 'zai':
      return { url: 'https://api.z.ai/api/monitor/usage/quota/limit', headers: auth }
    case 'xai-oauth':
      return { url: 'https://cli-chat-proxy.grok.com/v1/billing?format=credits', headers: { ...auth, ...GROK_CLI } }
    case 'github-copilot':
      return { url: 'https://api.github.com/copilot_internal/user', headers: { ...auth, accept: 'application/json' } }
    case 'openrouter':
      return { url: 'https://openrouter.ai/api/v1/credits', headers: auth }
    case 'deepseek':
      return { url: 'https://api.deepseek.com/user/balance', headers: auth }
    default:
      throw new Error(`no route for ${source.provider}`)
  }
}
// The billing route lives on the Grok CLI's proxy and is only served to a client that looks like it.
const GROK_CLI: Record<string, string> = {
  'x-xai-token-auth': 'xai-grok-cli',
  'x-grok-client-version': '0.1.0',
  'x-grok-client-identifier': 'grok-shell',
  'x-grok-client-mode': 'cli'
}

const httpGet: HttpGet = async (url, headers) => {
  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) })
  const body = await res.text()
  return { status: res.status, body: body.length > MAX_BODY ? '' : body }
}

// Reading from files instead of the network: one JSON per provider, named after its route.
// Used to prove the panel in the built app without spending anyone's quota.
export function fixtureRequest(dir: string): HttpGet {
  const name = (url: string): string => url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').toLowerCase()
  return async (url) => {
    const path = join(dir, `${name(url)}.json`)
    try {
      const body = readFileSync(path, 'utf8')
      // A fixture may stand in for a provider refusing, as {"__status": 401}.
      const status = Number((JSON.parse(body) as Record<string, unknown>)['__status']) || 200
      return { status, body: status === 200 ? body : '' }
    } catch {
      return { status: 404, body: '' }
    }
  }
}

// What a status means for the column, in words.
const why = (provider: string, status: number): string => {
  if (status === 401) return L('O login expirou. Entre de novo por essa ferramenta.', 'The login expired. Sign in again through that tool.')
  if (status === 403) return provider === 'opencode-go' ? L('Esta chave não está na assinatura do OpenCode Go.', 'This key has no OpenCode Go subscription.') : L('O provedor recusou o acesso.', 'The provider refused access.')
  if (status === 404) return L('O provedor não tem essa rota para esta conta.', 'The provider has no such route for this account.')
  if (status === 429) return L('O provedor limitou as consultas. Tente de novo em um minuto.', 'The provider rate-limited the ask. Try again in a minute.')
  return L(`O provedor respondeu ${status}.`, `The provider answered ${status}.`)
}

async function readOne(source: Source, get: HttpGet): Promise<ProviderQuota> {
  const base: ProviderQuota = { id: source.provider, label: source.label, via: source.via, at: Date.now(), ...(source.plan ? { plan: source.plan } : {}) }
  let read: QuotaRead = {}
  try {
    if (source.provider === 'xai-oauth') {
      // The billing route wants the signed-in account's id, which the identity route answers.
      const me = await get('https://cli-chat-proxy.grok.com/v1/user', { authorization: `Bearer ${source.secret}`, accept: 'application/json', 'user-agent': UA, ...GROK_CLI })
      if (me.status !== 200) return { ...base, error: why(source.provider, me.status) }
      let userId: string | undefined
      try {
        const body = JSON.parse(me.body) as Record<string, unknown>
        userId = text(at(body['user'] ?? body)['userId'] ?? at(body['user'] ?? body)['user_id'])
      } catch {
        userId = undefined
      }
      if (!userId) return { ...base, error: L('O Grok não disse a conta.', 'Grok didn’t say which account it is.') }
      const billing = await get('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
        authorization: `Bearer ${source.secret}`,
        accept: 'application/json',
        'user-agent': UA,
        'x-userid': userId,
        ...GROK_CLI
      })
      if (billing.status !== 200) return { ...base, error: why(source.provider, billing.status) }
      read = parseQuota(source.provider, billing.body)
    } else {
      const { url, headers } = ask(source)
      const res = await get(url, headers)
      if (res.status !== 200) return { ...base, error: why(source.provider, res.status) }
      read = parseQuota(source.provider, res.body)
    }
  } catch (e) {
    const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
    return { ...base, error: timeout ? L('O provedor não respondeu a tempo.', 'The provider didn’t answer in time.') : L('Não consegui falar com o provedor.', 'Couldn’t reach the provider.') }
  }
  const { plan, ...windows } = read
  if (!windows.session && !windows.week && !windows.month) return { ...base, ...(plan ? { plan } : {}), error: L('Esta conta não informa cota.', 'This account reports no quota.') }
  return { ...base, ...(plan ? { plan } : {}), ...windows }
}

// Every provider that can answer, in the panel's order. One failing never hides the rest.
export async function readQuotas(opts: { home?: string; env?: NodeJS.ProcessEnv; get?: HttpGet } = {}): Promise<ProviderQuota[]> {
  const sources = quotaSources(opts.home, opts.env).sort((a, b) => ORDER.indexOf(a.provider) - ORDER.indexOf(b.provider))
  const get = opts.get ?? httpGet
  const reads = await Promise.all(sources.map((s) => readOne(s, get)))
  return reads
}
