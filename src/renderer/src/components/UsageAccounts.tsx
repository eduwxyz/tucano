// Uso e limites, per account: every signed-in login of a harness with its own windows, and which
// one a reply goes to next when the accounts are balanced.
import { L, locale } from '../../../shared/lang'
import { useState, type ReactNode } from 'react'
import { checkKey, leftOf, loginsOf, PACE_MIN_USED, PACE_OVER, paceOf, pickLogin, usedOf, type Login } from '../../../shared/accounts'
import type { AccountEngine } from '../../../shared/types'
import type { EngineId } from '../store'
import { amAdmin, checkAccount, useStore } from '../store'
import { Ring, windowLabel } from './Usage'

// More than one login: the usual one is then listed in AccountsQuota, not in its own section.
export const useManyLogins = (engine: EngineId): boolean => useStore((s) => loginsOf(s.settings, engine).length > 1)

// A login with no windows yet: being checked, failed, or not checked; the button asks the core to read it.
function NoData({ id, engine, state }: { id: string; engine: EngineId; state?: 'checking' | 'failed' }): ReactNode {
  const admin = useStore(amAdmin)
  const [busy, setBusy] = useState(false)
  const run = (): void => {
    setBusy(true)
    checkAccount(id, engine as AccountEngine)
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  if (state === 'checking')
    return (
      <p className="usage-account__check muted small">
        <span className="spinner" />
        {L('Testando a conta…', 'Checking the account…')}
      </p>
    )
  return (
    <p className="usage-account__check muted small">
      {state === 'failed' ? L('Não deu pra ler o uso desta conta.', "Couldn't read this account's usage.") : L('Ainda sem dados.', 'No data yet.')}
      {admin && (
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={run}>
          {state === 'failed' ? L('Testar de novo', 'Check again') : L('Testar agora', 'Check now')}
        </button>
      )}
    </p>
  )
}

const shortWindow = (minutes: number): string => {
  if (minutes === 10080) return L('Semana', 'Week')
  if (minutes === 1440) return L('Dia', 'Day')
  if (minutes % 1440 === 0) return L(`${minutes / 1440} dias`, `${minutes / 1440} days`)
  if (minutes % 60 === 0) return L(`${minutes / 60} horas`, `${minutes / 60} hours`)
  return L(`${minutes} min`, `${minutes} min`)
}

// The accounts added up, next to the heading: one thin bar per window, with a tick where an even pace would be.
function Pace({ logins, now, total }: { logins: Login[]; now: number; total: number }): ReactNode {
  const paces = paceOf(logins, now)
  if (!paces.length) return null
  const meters = paces.map((p) => {
    const usedPct = Math.round(p.used * 100)
    const diff = Math.round(p.pace * 100) - usedPct
    const over = usedPct >= PACE_MIN_USED && -diff > PACE_OVER
    const note = diff > 0 ? L(`${diff}% de folga`, `${diff}% to spare`) : over ? L(`${-diff}% acima do ritmo`, `${-diff}% over the pace`) : L('no ritmo', 'on pace')
    const tip =
      p.counted === total
        ? L(`Soma das ${total} contas.`, `Sum of the ${total} accounts.`)
        : L(`Soma de ${p.counted} de ${total} contas.`, `Sum of ${p.counted} of ${total} accounts.`)
    return { p, usedPct, note, tip, over, label: shortWindow(p.minutes) }
  })
  const warn = meters.some((m) => m.over)
  const verdict = warn ? L('Acima do ritmo', 'Over the pace') : L('Dá até zerar', 'Lasts until reset')
  const aria = `${verdict}. ${meters.map((m) => `${m.label}: ${L(`${m.usedPct}% usado`, `${m.usedPct}% used`)}, ${m.note}.`).join(' ')}`
  return (
    <span className="usage-pace" role="img" aria-label={aria}>
      <span className={`usage-pace__verdict${warn ? ' is-warn' : ''}`}>{verdict}</span>
      {meters.map((m) => (
        <span
          key={m.p.minutes}
          className="usage-pace__meter"
          title={`${m.tip} ${L('A linha verde é o ritmo: onde o uso estaria se fosse gasto por igual até zerar.', 'The green line is the pace: where usage would be if it were spent evenly until the reset.')}`}
        >
          <span className="usage-pace__row">
            <span>
              <b>{m.label}</b> {L(`${m.usedPct}% usado`, `${m.usedPct}% used`)}
            </span>
            <span className="usage-pace__note">{m.note}</span>
          </span>
          <span className={`usage-pace__bar${m.over ? ' is-warn' : ''}`}>
            <i style={{ width: `${(m.p.used * 100).toFixed(1)}%` }} />
            <em style={{ left: `${(m.p.pace * 100).toFixed(1)}%` }} />
          </span>
        </span>
      ))}
    </span>
  )
}

export function AccountsQuota({ engine }: { engine: EngineId }): ReactNode {
  const settings = useStore((s) => s.settings)
  const logins = loginsOf(settings, engine)
  if (logins.length < 2) return null
  const balancing = settings.accountUse === 'balance'
  const now = Date.now()
  const picked = balancing ? pickLogin(logins, { now }) : undefined
  const next = picked?.windows?.length ? picked.id : undefined
  const claude = engine === 'claude'
  return (
    <section className="read-group">
      <h2 className="usage-accounts-head">
        {claude ? L('Contas do Claude', 'Claude accounts') : L('Contas do Codex', 'Codex accounts')}
        <span>{balancing ? L('equilibrando entre as contas', 'balancing between the accounts') : L('cada agente na conta dele', 'each agent on its own account')}</span>
        {balancing && <Pace logins={logins} now={now} total={logins.length} />}
      </h2>
      <div className="usage-accounts">
        {logins.map((l) => {
          const out = leftOf(l, now) <= 0
          const check = settings.accountChecks?.[checkKey(engine, l.id)]?.state
          const at = l.at ? new Date(l.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }) : ''
          return (
            <div key={l.id} className="usage-account" data-login={l.id || 'usual'}>
              <div className="usage-account__head">
                <strong className="usage-account__name">{l.account?.name ?? L('A de sempre', 'The usual one')}</strong>
                {out ? (
                  <span className="usage-account__chip is-out">{L('Acabou por agora', 'Used up for now')}</span>
                ) : (
                  next === l.id && <span className="usage-account__chip is-next">{L('Próxima a ser usada', 'Next in line')}</span>
                )}
                {balancing && !l.windows?.length && !check && <span className="usage-account__chip">{L('Aguardando o teste', 'Waiting for its check')}</span>}
                {at && <span className="muted small">{L(`às ${at}`, `at ${at}`)}</span>}
              </div>
              {l.windows?.length ? (
                <div className="usage-account__rings">
                  {l.windows.map((w) => (
                    <Ring key={w.minutes} label={windowLabel(w.minutes)} w={{ ...w, utilization: usedOf(w, now) }} />
                  ))}
                </div>
              ) : (
                <NoData id={l.id} engine={engine} state={check} />
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
