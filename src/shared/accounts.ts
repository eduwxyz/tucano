// Which login of a harness a reply runs on, and how much each has left.
// A harness has its usual login and the accounts added in Settings. In 'order' each agent stays on
// its own and moves on only when it runs out. In 'balance' a reply goes to the login with the most
// left of its subscription, so no account runs dry while another sits idle.
// A session lives in its login's folder: changing login sends the whole conversation again. So the
// login in use is kept until another has clearly more left, or it is nearly out.
import type { Account, CodexQuota, EngineId, Quota, Settings } from './types'
import { ACCOUNT_ENGINES } from './types'

export interface QuotaWindow {
  minutes: number
  utilization: number // 0..1
  resetsAt: number // ms; 0 when the CLI didn't say
}

// One login: the usual one (id '') or an account. `windows` is unset until it has reported them.
export interface Login {
  id: string
  account?: Account
  windows?: QuotaWindow[]
  at?: number // when the windows were read
}

export const USUAL_LOGIN = ''
// The key of a login's check in settings.accountChecks: the usual logins of two harnesses share the id ''.
export const checkKey = (engine: EngineId, id: string): string => id || `usual:${engine}`
export const SWITCH_GAP = 0.15 // how much more another login must have left to take over
export const NEARLY_OUT = 0.05 // with this little left, the login in use is given up
export const SPENT_MS = 30 * 60_000 // how long a login that hit its limit sits out, when no window was near its end
export const NEARLY_FULL = 0.9 // a window this used is the one a limit error is about

export const quotaWindows = (q: Quota | CodexQuota | undefined): QuotaWindow[] | undefined => {
  if (!q) return undefined
  if ('windows' in q) return q.windows.length ? q.windows : undefined
  const windows = [...(q.fiveHour ? [{ minutes: 300, ...q.fiveHour }] : []), ...(q.sevenDay ? [{ minutes: 10_080, ...q.sevenDay }] : [])]
  return windows.length ? windows : undefined
}

// A window that already reset counts as empty: what it said was about the one before.
export const usedOf = (w: QuotaWindow, now: number): number => (w.resetsAt > 0 && w.resetsAt <= now ? 0 : Math.min(1, Math.max(0, w.utilization)))

// How much of its tightest window a login has left, 0..1. A login that never reported counts as
// full here, but isn't picked while another has reported (see pickLogin): the app checks it first.
export const leftOf = (login: Pick<Login, 'windows'>, now: number): number => (login.windows?.length ? 1 - Math.max(...login.windows.map((w) => usedOf(w, now))) : 1)

// The signed-in logins of a harness: the usual one first, then the accounts in the order they were added.
export function loginsOf(settings: Pick<Settings, 'engines' | 'accounts' | 'quota' | 'codexQuota' | 'accountQuota'>, engine: EngineId): Login[] {
  if (!(ACCOUNT_ENGINES as readonly EngineId[]).includes(engine)) return []
  const usualQuota = engine === 'claude' ? settings.quota : settings.codexQuota
  const usual = { windows: quotaWindows(usualQuota), at: usualQuota?.at }
  return [
    ...(settings.engines[engine]?.loggedIn ? [{ id: USUAL_LOGIN, ...usual }] : []),
    ...(settings.accounts ?? [])
      .filter((a) => a.engine === engine && a.loggedIn)
      .map((a) => ({ id: a.id, account: a, windows: quotaWindows(settings.accountQuota?.[a.id]), at: settings.accountQuota?.[a.id]?.at }))
  ]
}

// The login a reply should run on, balancing. `current`: the one this agent used last, kept unless
// another has SWITCH_GAP more left or it is nearly out. `prefer`: the agent's own, which wins a tie.
// `skip`: the ones that already failed in this reply. Undefined when none is left to try.
// Only a login whose windows are known is weighed: one that never reported waits for its check. It is
// used when every known one is out, and a spent one only when there is nothing else.
export function pickLogin(logins: Login[], opts: { now: number; current?: string; prefer?: string; skip?: ReadonlySet<string> }): Login | undefined {
  const left0 = logins.filter((l) => !opts.skip?.has(l.id))
  const live = left0.filter((l) => l.windows?.length && leftOf(l, opts.now) > 0)
  const unknown = left0.filter((l) => !l.windows?.length)
  const open = live.length ? live : unknown.length ? unknown : left0
  if (!open.length) return undefined
  const left = (l: Login): number => leftOf(l, opts.now)
  const rank = (l: Login): number => (l.id === opts.prefer ? 0 : l.id === opts.current ? 1 : 2)
  const best = open.reduce((a, b) => (left(b) > left(a) || (left(b) === left(a) && rank(b) < rank(a)) ? b : a))
  const current = open.find((l) => l.id === opts.current)
  if (current && left(current) > NEARLY_OUT && left(best) - left(current) < SWITCH_GAP) return current
  return best
}

// A Claude login that just said it hit its limit: the window that was nearly full is full until it
// resets, so the login is passed over and shows as out. When no window was near its end (a passing
// "too many requests", or nothing known yet), it sits out SPENT_MS only.
export function spentQuota(prev: Quota | undefined, now: number): Quota {
  const near = (['fiveHour', 'sevenDay'] as const).filter((k) => !!prev?.[k] && prev[k]!.utilization >= NEARLY_FULL && prev[k]!.resetsAt > now)
  const full = near.sort((a, b) => prev![b]!.utilization - prev![a]!.utilization)[0]
  if (full) return { ...prev, [full]: { utilization: 1, resetsAt: prev![full]!.resetsAt }, at: now }
  return { ...prev, fiveHour: { utilization: 1, resetsAt: now + SPENT_MS }, at: now }
}
