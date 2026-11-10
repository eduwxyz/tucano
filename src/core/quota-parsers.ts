// Reading what each provider answers when asked for its own quota. Pure functions over the
// response body: no network, no files, so every shape can be tested from a fixture.
//
// The contracts were checked against live accounts before this was written: percentages arrive as
// USED and are turned into what's left, zero is a real exhausted reading, and a missing number is
// unavailable rather than zero.
import type { QuotaWindow } from '../shared/types'

export interface QuotaRead {
  session?: QuotaWindow // the short window: 5 hours, or hourly
  week?: QuotaWindow
  month?: QuotaWindow
  plan?: string
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// A timestamp in seconds, milliseconds or ISO, as milliseconds.
export const ms = (v: unknown): number | undefined => {
  const n = num(v)
  if (n !== undefined && n > 0) return n > 10_000_000_000 ? n : n * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return t
  }
  return undefined
}

// `used` is 0..1 of what the window allows.
const fromUsed = (used: number, resetsAt?: number): QuotaWindow => ({
  used: clamp(used, 0, 1),
  remaining: clamp(1 - used, 0, 1),
  limit: 1,
  unit: '%',
  ...(resetsAt ? { resetsAt } : {})
})
// A count against a cap: requests, tokens.
const fromCount = (remaining: number, limit: number | undefined, unit: QuotaWindow['unit'], resetsAt?: number): QuotaWindow => ({
  remaining,
  ...(limit && limit > 0 ? { limit, used: clamp(1 - remaining / limit, 0, 1) } : {}),
  unit,
  ...(resetsAt ? { resetsAt } : {})
})

// Which row a reported window belongs in, by how long it lasts, in seconds.
export const slot = (seconds: number | undefined): 'session' | 'week' | 'month' => {
  if (!seconds || seconds <= 6 * 3600) return 'session'
  if (seconds <= 8 * 86_400) return 'week'
  return 'month'
}

// Codex, the ChatGPT plan: GET chatgpt.com/backend-api/wham/usage.
function codex(root: Json): QuotaRead {
  const rate = obj(root['rate_limit'] ?? root['rateLimit'] ?? root)
  const windows = [
    ...['primary_window', 'primaryWindow', 'secondary_window', 'secondaryWindow'].map((k) => obj(rate[k])).filter((w) => Object.keys(w).length > 0),
    ...arr(rate['windows']).map(obj)
  ]
  const out: QuotaRead = {}
  for (const w of windows) {
    const seconds = num(w['limit_window_seconds'] ?? w['limitWindowSeconds'])
    const left = num(w['percent_left'] ?? w['remaining_percent'])
    const used = num(w['used_percent'] ?? w['usedPercent'] ?? w['percent_used']) ?? (left !== undefined ? 100 - left : undefined)
    if (used === undefined) continue
    let reset = ms(w['reset_at'] ?? w['resetAt'])
    const after = num(w['reset_after_seconds'] ?? w['resetAfterSeconds'])
    if (!reset && after !== undefined && after >= 0) reset = Date.now() + after * 1000
    const where = slot(seconds && seconds > 0 ? seconds : undefined)
    if (!out[where]) out[where] = fromUsed(used / 100, reset)
  }
  const plan = str(obj(root['account'] ?? root['user'])['plan_type']) ?? str(root['plan_type'])
  if (plan) out.plan = plan
  return out
}

// Claude Code, on the subscription: GET api.anthropic.com/api/oauth/usage. Already used, 0..100.
function anthropic(root: Json): QuotaRead {
  const out: QuotaRead = {}
  const five = obj(root['five_hour'])
  const week = obj(root['seven_day'])
  if (num(five['utilization']) !== undefined) out.session = fromUsed(num(five['utilization'])! / 100, ms(five['resets_at']))
  if (num(week['utilization']) !== undefined) out.week = fromUsed(num(week['utilization'])! / 100, ms(week['resets_at']))
  return out
}

// OpenCode Go: GET opencode.ai/zen/go/v1/usage. Percent USED, with its own reset per window.
function opencodeGo(root: Json): QuotaRead {
  const usage = obj(root['usage'])
  const out: QuotaRead = {}
  for (const [key, where] of [['rolling', 'session'], ['weekly', 'week'], ['monthly', 'month']] as const) {
    const w = obj(usage[key])
    const status = str(w['status'])
    const used = num(w['percent'])
    if (used === undefined || (status && status !== 'ok' && status !== 'rate-limited')) continue
    out[where] = fromUsed(used / 100, ms(w['resetsAt'] ?? w['resets_at']))
  }
  const plan = str(obj(root['plan'])['name'])
  if (plan) out.plan = plan
  return out
}

// Z.ai coding plan: GET api.z.ai/api/monitor/usage/quota/limit.
function zai(root: Json): QuotaRead {
  const data = obj(root['data'] ?? root)
  const out: QuotaRead = {}
  for (const raw of arr(data['limits'])) {
    const q = obj(raw)
    const kind = str(q['type']) ?? str(q['name']) ?? ''
    if (!['TOKENS_LIMIT', 'CREDIT_LIMIT', 'TIME_LIMIT'].includes(kind)) continue
    const reset = ms(q['nextResetTime'])
    const percent = num(q['percentage'])
    // The live monitor answers 1 for 1% used, so anything under 1 is a fraction, not a percent.
    const used = percent !== undefined ? (percent >= 1 ? percent : percent * 100) : undefined
    const where = kind === 'CREDIT_LIMIT' ? 'month' : num(q['unit']) === 6 ? 'week' : 'session'
    if (out[where]) continue // a second row of the same window adds nothing: the first is the one shown
    if (used !== undefined) out[where] = fromUsed(used / 100, reset)
    else {
      const cap = num(q['usage'] ?? q['limit'] ?? q['total'])
      const left = num(q['remaining'])
      if (cap && cap > 0 && left !== undefined) out[where] = fromCount(clamp(left, 0, cap), cap, 'req', reset)
    }
  }
  return out
}

// SuperGrok: GET cli-chat-proxy.grok.com/v1/billing?format=credits. One shared pool: weekly, or
// monthly on the older accounts, so it can only fill one of the two rows.
function grok(root: Json): QuotaRead {
  const config = Object.keys(obj(root['config'])).length ? obj(root['config']) : root
  const period = obj(config['currentPeriod'] ?? config['current_period'])
  const end = ms(period['end']) ?? ms(config['billingPeriodEnd'] ?? config['billing_period_end'])
  const start = ms(period['start']) ?? ms(config['billingPeriodStart'] ?? config['billing_period_start'])
  const type = (str(period['type']) ?? '').toUpperCase()
  const window = start && end && end > start ? (end - start) / 1000 : type.includes('MONTHLY') ? 30 * 24 * 3600 : 7 * 24 * 3600
  const used = num(config['creditUsagePercent'] ?? config['credit_usage_percent'])
  const out: QuotaRead = {}
  const where = slot(window)
  // A unified account with a live period reports no percentage at zero use: that default is 0% used.
  if (used !== undefined) out[where] = fromUsed(used / 100, end)
  else if ((config['isUnifiedBillingUser'] ?? config['is_unified_billing_user']) === true && end) out[where] = fromUsed(0, end)
  return out
}

// GitHub Copilot: GET api.github.com/copilot_internal/user. Premium interactions run out first,
// so that is the one a person watches; chat and completions are unlimited on most plans.
function copilot(root: Json): QuotaRead {
  const snapshots = obj(root['quota_snapshots'])
  const out: QuotaRead = {}
  for (const [key, where] of [['premium_interactions', 'month'], ['chat', 'week']] as const) {
    const q = obj(snapshots[key])
    if (q['unlimited'] === true) continue
    const left = num(q['percent_remaining'])
    const reset = ms(root['quota_reset_date'])
    if (left !== undefined) out[where] = fromUsed(1 - clamp(left, 0, 100) / 100, reset)
  }
  const plan = str(root['copilot_plan'])
  if (plan) out.plan = plan
  return out
}

// The ones that answer with money: no window, only what's left, and no cap to draw a bar against.
function wallet(root: Json): QuotaRead {
  const data = Object.keys(obj(root['data'])).length ? obj(root['data']) : root
  const out: QuotaRead = {}
  // OpenRouter: credits granted against what was spent.
  const total = num(data['total_credits'])
  const spend = num(data['total_usage'])
  if (total !== undefined && spend !== undefined) {
    out.month = fromCount(Math.max(0, total - spend), total > 0 ? total : undefined, 'usd')
    return out
  }
  // DeepSeek and Moonshot: a balance, in its own currency.
  const balances = arr(root['balance_infos'] ?? data['balance_infos'])
  const info = obj(balances[0])
  const balance = num(info['total_balance'] ?? data['available_balance'] ?? data['balance'] ?? data['total_available'])
  if (balance !== undefined) out.month = { remaining: balance, unit: 'usd' }
  return out
}

// Which parser reads which provider's answer.
export const PARSERS: Record<string, (root: Json) => QuotaRead> = {
  'openai-codex': codex,
  'anthropic-claude-code': anthropic,
  'opencode-go': opencodeGo,
  zai,
  'xai-oauth': grok,
  'github-copilot': copilot,
  openrouter: wallet,
  deepseek: wallet
}

// A provider's answer as the rows of the panel. Throws only when the body isn't JSON at all.
export function parseQuota(provider: string, body: string): QuotaRead {
  const parse = PARSERS[provider]
  if (!parse) return {}
  let root: unknown
  try {
    root = JSON.parse(body)
  } catch {
    return {}
  }
  return parse(obj(root))
}
