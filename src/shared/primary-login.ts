// Which login of a harness runs a reply when the agent has no login of its own. The person picks a
// primary one in Settings › Models › Accounts; the others follow in the order they were added. When the
// primary runs out, the reply goes on to the next login, each one tried once per reply. Pure: the core
// and the screen read it the same way.
import { L, locale } from './lang'
import type { Account, AccountEngine, EngineId, Settings } from './types'
import { ACCOUNT_ENGINES } from './types'

export const USUAL_LOGIN = '' // the harness's own login, the one it had before any account was added
export const SPENT_MS = 30 * 60_000 // how long a login that ran out sits out before it's tried again

export const isAccountEngine = (engine: EngineId): engine is AccountEngine => (ACCOUNT_ENGINES as readonly EngineId[]).includes(engine)

// The id of the harness's primary login: one of its accounts that still exists; otherwise the usual login.
export function primaryAccountOf(settings: Pick<Settings, 'primaryAccounts' | 'accounts'>, engine: EngineId): string {
  if (!isAccountEngine(engine)) return USUAL_LOGIN
  const id = settings.primaryAccounts?.[engine]
  return id && (settings.accounts ?? []).some((a) => a.id === id && a.engine === engine) ? id : USUAL_LOGIN
}

export interface Login {
  id: string
  account?: Account // undefined: the usual login
  ready: boolean // signed in
}

// Every login of a harness, the primary first (when one is set): the usual login, then its accounts in order.
export function loginsInOrder(settings: Pick<Settings, 'engines' | 'accounts' | 'primaryAccounts'>, engine: EngineId): Login[] {
  const usual: Login = { id: USUAL_LOGIN, ready: !!settings.engines[engine]?.loggedIn }
  const accounts: Login[] = (settings.accounts ?? []).filter((a) => a.engine === engine).map((account) => ({ id: account.id, account, ready: !!account.loggedIn }))
  const list = [usual, ...accounts]
  const primary = list.find((login) => login.id === primaryAccountOf(settings, engine))
  return primary ? [primary, ...list.filter((login) => login !== primary)] : list
}

// Logins that ran out, by harness and login id, until when each one sits out.
export class Spent {
  private until = new Map<string, number>()
  private key(engine: EngineId, id: string): string {
    return `${engine}|${id}`
  }
  mark(engine: EngineId, id: string, now: number, ms = SPENT_MS): void {
    this.until.set(this.key(engine, id), now + ms)
  }
  of(engine: EngineId, id: string): number {
    return this.until.get(this.key(engine, id)) ?? 0
  }
}

// The first login, in order, that can take the reply now: signed in, not out, not tried in this reply yet.
export function nextLogin(logins: Login[], opts: { engine: EngineId; spent: Spent; now: number; tried?: ReadonlySet<string> }): Login | undefined {
  return logins.find((login) => login.ready && !opts.tried?.has(login.id) && opts.spent.of(opts.engine, login.id) <= opts.now)
}

// Why no login of a harness can take a reply now, in one line: each one out and until when, or not signed in.
export function noLoginLeft(logins: Login[], opts: { engine: EngineId; label: string; spent: Spent; now: number }): string {
  const name = (login: Login): string => login.account?.name ?? L('login padrão', 'usual login')
  const parts = logins.map((login) => {
    const until = opts.spent.of(opts.engine, login.id)
    if (until > opts.now) return L(`${name(login)} até ${new Date(until).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`, `${name(login)} until ${new Date(until).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`)
    return login.ready ? '' : L(`${name(login)} não está logada`, `${name(login)} isn't signed in`)
  }).filter(Boolean)
  return L(`todas as contas do ${opts.label} estão esgotadas ou fora (${parts.join('; ')})`, `every ${opts.label} account is out or unavailable (${parts.join('; ')})`)
}
