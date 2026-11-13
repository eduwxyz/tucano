// Uso e limites, per account: every signed-in login of a harness with its own windows, and which
// one a reply goes to next when the accounts are balanced.
import { L, locale } from '../../../shared/lang'
import type { ReactNode } from 'react'
import { leftOf, loginsOf, pickLogin, usedOf } from '../../../shared/accounts'
import type { EngineId } from '../store'
import { useStore } from '../store'
import { Ring, windowLabel } from './Usage'

// More than one login: the usual one is then listed in AccountsQuota, not in its own section.
export const useManyLogins = (engine: EngineId): boolean => useStore((s) => loginsOf(s.settings, engine).length > 1)

export function AccountsQuota({ engine }: { engine: EngineId }): ReactNode {
  const settings = useStore((s) => s.settings)
  const logins = loginsOf(settings, engine)
  if (logins.length < 2) return null
  const balancing = settings.accountUse === 'balance'
  const now = Date.now()
  const next = balancing ? pickLogin(logins, { now })?.id : undefined
  const claude = engine === 'claude'
  return (
    <section className="read-group">
      <h2>
        {claude ? L('Contas do Claude', 'Claude accounts') : L('Contas do Codex', 'Codex accounts')}
        <span>{balancing ? L('equilibrando entre as contas', 'balancing between the accounts') : L('cada agente na conta dele', 'each agent on its own account')}</span>
      </h2>
      <div className="usage-accounts">
        {logins.map((l) => {
          const out = leftOf(l, now) <= 0
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
                {at && <span className="muted small">{L(`às ${at}`, `at ${at}`)}</span>}
              </div>
              {l.windows?.length ? (
                <div className="usage-account__rings">
                  {l.windows.map((w) => (
                    <Ring key={w.minutes} label={windowLabel(w.minutes)} w={{ ...w, utilization: usedOf(w, now) }} />
                  ))}
                </div>
              ) : (
                <p className="muted small">{L('Ainda sem dados. Aparece depois da primeira resposta nesta conta.', 'No data yet. It shows after the first reply on this account.')}</p>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
