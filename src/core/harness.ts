// The harnesses agents run on. Each one is
// used as the person set it up: their plan, their company's gateway or their
// providers. The app only reads that setup, to show it and to list models.
import type { Provider } from './engines/claude'
import type { CodexProvider } from './engines/codex'
import { L } from '../shared/lang'
import type { EngineId, EngineStatus } from '../shared/types'

// The harnesses the app can run agents on; one added later is listed as coming until then.
export const RUNNABLE: EngineId[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes', 'endpoint']

// Off for a harness pointed at a gateway: its own telemetry and error reports
// would go to Anthropic or OpenAI, around the gateway.
const QUIET_CLAUDE = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }
export const quietClaude = (p: Provider): Provider => (p.env['ANTHROPIC_BASE_URL'] ? { ...p, env: { ...p.env, ...QUIET_CLAUDE } } : p)
export const quietCodex = (p: CodexProvider): CodexProvider => (p.baseUrl ? { ...p, config: [...p.config, '-c', 'analytics.enabled=false'] } : p)

// What the person sees and what runs: a harness they didn't pick is off, one
// the app can't run yet is coming. Unpicked (undefined): every runnable one.
export function withChoice(engines: Record<EngineId, EngineStatus>, chosen: EngineId[] | undefined): Record<EngineId, EngineStatus> {
  const out = { ...engines }
  for (const e of Object.keys(engines) as EngineId[]) {
    const st = engines[e]
    if (!RUNNABLE.includes(e)) out[e] = { ...st, loggedIn: false, soon: true }
    else if (chosen && !chosen.includes(e)) out[e] = { ...st, loggedIn: false, off: true }
  }
  return out
}

// An endpoint's address as people paste it: with or without a trailing slash, or the whole
// …/chat/completions they copied from the docs. What stays is the base the paths go after.
export function cleanEndpoint(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|completions|models)$/i, '')
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error(L('Esse endereço não parece uma URL. Algo como https://openrouter.ai/api/v1.', "Enter a valid URL, such as https://openrouter.ai/api/v1."))
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(L('O endereço precisa começar com http:// ou https://.', 'The address must start with http:// or https://.'))
  if (u.username || u.password) throw new Error(L('Ponha a chave no campo dela, não no endereço.', 'Put the key in its own field, not in the address.'))
  return s
}

// The models a gateway lists (GET …/models, the same on both APIs).
// Anthropic-style addresses have no /v1; OpenAI-style ones usually end in it.
export async function listModels(engine: EngineId, baseUrl: string, key: string | undefined, f: typeof fetch = fetch): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, '')
  const url = engine === 'claude' ? `${base}/v1/models?limit=1000` : `${base}/models`
  const headers: Record<string, string> = engine === 'claude' ? { 'anthropic-version': '2023-06-01' } : {}
  if (key) {
    headers['authorization'] = `Bearer ${key}`
    if (engine === 'claude') headers['x-api-key'] = key
  }
  const res = await f(url, { headers, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(L(`O gateway respondeu ${res.status} ao pedir a lista de modelos.`, `The gateway answered ${res.status} when asked for the list of models.`))
  const body = (await res.json()) as { data?: { id?: unknown }[] }
  const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  return [...new Set(ids)].sort()
}
