// Uso e limites, per account: every signed-in login of a harness with its own windows, and which
// one a reply goes to next when the accounts are balanced.
import { L, locale } from '../../../shared/lang'
import { useState, type ReactNode } from 'react'
import { checkKey, leftOf, loginsOf, pickLogin, usedOf } from '../../../shared/accounts'
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
      <h2>
        {claude ? L('Contas do Claude', 'Claude accounts') : L('Contas do Codex', 'Codex accounts')}
        <span>{balancing ? L('equilibrando entre as contas', 'balancing between the accounts') : L('cada agente na conta dele', 'each agent on its own account')}</span>
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
