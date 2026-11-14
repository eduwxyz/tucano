// Where the logins are found and what is asked of each provider: the part that decides which
// column exists, and what happens when one of them is expired, refused or silent.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { quotaSources, readQuotas, type HttpGet } from '../src/core/quotas'

// A home folder with the tools' own auth files in it, laid out as each tool writes them.
function home(files: Record<string, unknown>): { home: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), 'tucano-quota-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body))
  }
  return { home: root, env: { XDG_DATA_HOME: join(root, '.local', 'share'), LOCALAPPDATA: join(root, 'AppData', 'Local') } }
}

// The messages come back in the app's language: this file reads them in English.
setLang('en')

const PATHS = {
  claude: '.claude/.credentials.json',
  codex: '.codex/auth.json',
  opencode: 'opencode/auth.json',
  pi: '.pi/agent/auth.json',
  hermes: 'hermes/auth.json'
}

describe('finding the logins', () => {
  it('reads Claude Code, Codex and OpenCode from the files their own CLIs write', () => {
    const { home: root, env } = home({
      [PATHS.claude]: { claudeAiOauth: { accessToken: 'sk-ant-oauth', subscriptionType: 'max' } },
      [PATHS.codex]: { tokens: { access_token: 'codex-token', account_id: 'acct-1' } },
      // OpenCode's data dir, which is where XDG_DATA_HOME points
      '.local/share/opencode/auth.json': { 'opencode-go': { type: 'api', key: 'oc-key' } }
    })
    const sources = quotaSources(root, env)
    expect(sources.map((s) => `${s.provider}:${s.via}`)).toEqual(['anthropic-claude-code:Claude Code', 'openai-codex:Codex', 'opencode-go:OpenCode'])
    expect(sources[1]?.accountId).toBe('acct-1')
    expect(sources[0]?.plan).toBe('max')
  })

  it('reads what Pi and Hermes are signed in to', () => {
    const { home: root, env } = home({
      [PATHS.pi]: { zai: { type: 'api', key: 'zai-key' }, 'opencode-go': { type: 'api', key: 'oc-key' }, 'openai-codex': { access: 'pi-codex', accountId: 'acct-9' } },
      'AppData/Local/hermes/auth.json': {
        providers: { 'xai-oauth': { tokens: { access_token: 'hermes-grok' } } },
        credential_pool: { openrouter: [{ access_token: 'or-key' }], zai: [{ secret_fingerprint: 'sha256:abc' }] }
      }
    })
    const sources = quotaSources(root, env)
    const by = Object.fromEntries(sources.map((s) => [s.provider, s]))
    expect(by['zai']?.via).toBe('Pi') // the pool only had a fingerprint, so the key from Pi is the one used
    expect(by['xai-oauth']?.via).toBe('Hermes')
    expect(by['openrouter']?.via).toBe('Hermes')
    expect(sources.some((s) => s.secret.startsWith('sha256'))).toBe(false)
  })

  it('keeps one login per provider, the tool’s own first', () => {
    const { home: root, env } = home({
      [PATHS.codex]: { tokens: { access_token: 'from-codex', account_id: 'a' } },
      [PATHS.pi]: { 'openai-codex': { access: 'from-pi', accountId: 'b' } }
    })
    const sources = quotaSources(root, env)
    expect(sources).toHaveLength(1)
    expect(sources[0]?.via).toBe('Codex')
    expect(sources[0]?.secret).toBe('from-codex')
  })

  it('finds nothing rather than guessing when the files are missing or broken', () => {
    const { home: root, env } = home({ [PATHS.codex]: '{ not json', [PATHS.pi]: '[]' })
    expect(quotaSources(root, env)).toEqual([])
    expect(quotaSources(join(root, 'nowhere'), env)).toEqual([])
  })
})

// A request that answers per route, and remembers what was asked.
function request(routes: Record<string, { status?: number; body?: string }>): { get: HttpGet; asked: { url: string; headers: Record<string, string> }[] } {
  const asked: { url: string; headers: Record<string, string> }[] = []
  const get: HttpGet = async (url, headers) => {
    asked.push({ url, headers })
    const route = routes[url]
    return route ? { status: route.status ?? 200, body: route.body ?? '' } : { status: 404, body: '' }
  }
  return { get, asked }
}

const CODEX_BODY = JSON.stringify({ plan_type: 'plus', rate_limit: { primary_window: { limit_window_seconds: 18000, used_percent: 42 }, secondary_window: { limit_window_seconds: 604800, used_percent: 10 } } })
const OPencode_BODY = JSON.stringify({ usage: { rolling: { percent: 20, status: 'ok' }, weekly: { percent: 55, status: 'ok' }, monthly: { percent: 10, status: 'ok' } } })

describe('asking for the quota', () => {
  it('puts one column per provider, in the panel’s order, with what each answered', async () => {
    const { home: root, env } = home({
      [PATHS.codex]: { tokens: { access_token: 'codex-token', account_id: 'acct-1' } },
      '.local/share/opencode/auth.json': { 'opencode-go': { key: 'oc-key' } }
    })
    const { get, asked } = request({
      'https://chatgpt.com/backend-api/wham/usage': { body: CODEX_BODY },
      'https://opencode.ai/zen/go/v1/usage': { body: OPencode_BODY }
    })
    const quotas = await readQuotas({ home: root, env, get })
    expect(quotas.map((q) => q.id)).toEqual(['openai-codex', 'opencode-go'])
    expect(quotas[0]?.session?.used).toBeCloseTo(0.42)
    expect(quotas[0]?.plan).toBe('plus')
    expect(quotas[1]?.session?.used).toBeCloseTo(0.2)
    expect(quotas[0]?.error).toBeUndefined()
    // Codex's token goes with its account id, in the header the route expects.
    expect(asked[0]?.headers.authorization).toBe('Bearer codex-token')
    expect(asked[0]?.headers['chatgpt-account-id']).toBe('acct-1')
  })

  it('never puts a token in what the panel shows', async () => {
    const { home: root, env } = home({ [PATHS.codex]: { tokens: { access_token: 'sk-secret-value' } } })
    const { get } = request({ 'https://chatgpt.com/backend-api/wham/usage': { body: CODEX_BODY } })
    const quotas = await readQuotas({ home: root, env, get })
    expect(JSON.stringify(quotas)).not.toContain('sk-secret-value')
  })

  it('says why one column is empty and still shows the others', async () => {
    const { home: root, env } = home({
      [PATHS.codex]: { tokens: { access_token: 'expired' } },
      '.local/share/opencode/auth.json': { 'opencode-go': { key: 'oc-key' } }
    })
    const { get } = request({
      'https://chatgpt.com/backend-api/wham/usage': { status: 401 },
      'https://opencode.ai/zen/go/v1/usage': { body: OPencode_BODY }
    })
    const quotas = await readQuotas({ home: root, env, get })
    expect(quotas).toHaveLength(2)
    expect(quotas[0]?.error).toMatch(/expired|Sign in again/i)
    expect(quotas[0]?.session).toBeUndefined()
    expect(quotas[1]?.week?.used).toBeCloseTo(0.55)
  })

  it('marks a provider that answered but reports nothing', async () => {
    const { home: root, env } = home({ [PATHS.codex]: { tokens: { access_token: 't' } } })
    const { get } = request({ 'https://chatgpt.com/backend-api/wham/usage': { body: JSON.stringify({ rate_limit: {} }) } })
    const quotas = await readQuotas({ home: root, env, get })
    expect(quotas[0]?.error).toMatch(/no quota/i)
  })

  it('asks Grok for its account first, then for the billing of that account', async () => {
    const { home: root, env } = home({ 'AppData/Local/hermes/auth.json': { providers: { 'xai-oauth': { tokens: { access_token: 'grok-token' } } } } })
    const { get, asked } = request({
      'https://cli-chat-proxy.grok.com/v1/user': { body: JSON.stringify({ userId: 'user-7' }) },
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits': { body: JSON.stringify({ config: { creditUsagePercent: 62, currentPeriod: { type: 'WEEKLY', start: '2026-11-08T00:00:00Z', end: '2026-11-15T00:00:00Z' } } }) }
    })
    const quotas = await readQuotas({ home: root, env, get })
    expect(asked.map((a) => a.url)).toEqual(['https://cli-chat-proxy.grok.com/v1/user', 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'])
    expect(asked[1]?.headers['x-userid']).toBe('user-7')
    expect(asked[1]?.headers['x-xai-token-auth']).toBe('xai-grok-cli')
    expect(quotas[0]?.week?.used).toBeCloseTo(0.62)
  })

  it('reports a provider that did not answer at all without failing the whole read', async () => {
    const { home: root, env } = home({
      [PATHS.codex]: { tokens: { access_token: 't' } },
      '.local/share/opencode/auth.json': { 'opencode-go': { key: 'k' } }
    })
    const get: HttpGet = async (url) => {
      if (url.includes('chatgpt')) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' })
      return { status: 200, body: OPencode_BODY }
    }
    const quotas = await readQuotas({ home: root, env, get })
    expect(quotas[0]?.error).toMatch(/didn’t answer|didn't answer/i)
    expect(quotas[1]?.week?.used).toBeCloseTo(0.55)
  })

  it('answers an empty list when nothing is signed in', async () => {
    const { home: root, env } = home({})
    expect(await readQuotas({ home: root, env, get: request({}).get })).toEqual([])
  })
})
