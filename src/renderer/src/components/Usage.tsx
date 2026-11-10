// Uso e limites: this month at a glance (by day, by agent, by model), the
// Claude and Codex subscriptions' windows, and where each agent will end the month.
import { L, locale } from '../../../shared/lang'
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { agentById, amAdmin, countedTokens, ENGINES, isTeam, loadQuotas, loadUsage, messageById, modelInfo, navigate, receipts, useStore, type Agent, type EngineId, type EngineStatus, type ProviderQuota, type Quota, type QuotaWindow, type UsageReport } from '../store'
import { Sheet } from './Pages'
import { AdminOnly } from './People'
import { AgentAvatar, duration, Icon, tokens, usd } from './ui'

const DAY = 86_400_000
const APP = 'app' // the chart's one color for the app's own turns: router, memory, the Tuca
const MODEL_COLORS = ['var(--accent)', 'var(--c-violet)', 'var(--c-teal)', 'var(--c-sky)', 'var(--text-3)']

export const until = (at: number): string => {
  const left = at - Date.now()
  if (left <= 0) return L('agora', 'now')
  const total = Math.round(left / 60_000) // in whole minutes, so it never says "1 h 60 min"
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h < 24) return L(`em ${h ? `${h} h ` : ''}${m} min`, `in ${h ? `${h} h ` : ''}${m} min`)
  const d = new Date(at)
  return `${d.toLocaleDateString(locale(), { weekday: 'short' }).replace('.', '')}, ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const shortTime = (at: number): string => {
  const d = new Date(at)
  const hm = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString() ? hm : `${d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })} ${hm}`
}

// The app's own turns go under one name; agents keep theirs.
function whoOf(id: string, agents: Agent[]): { key: string; name: string; color: string } {
  const a = agents.find((x) => x.id === id)
  if (a && isTeam(a)) return { key: a.id, name: a.name, color: a.customColor ?? `var(--c-${a.color})` }
  return { key: APP, name: L('Bastidores', 'Behind the scenes'), color: 'var(--text-3)' }
}

// How each harness in use pays: the person's plan, an API key, a gateway, or the providers' logins.
const PAYS = (): Record<NonNullable<EngineStatus['route']>, string> => ({
  plan: L('na assinatura', 'on the subscription'),
  apikey: L('cobrado por token, na chave de API', 'billed per token, on the API key'),
  gateway: L('pelo gateway', 'through the gateway'),
  providers: L('pelos provedores em que está logado', 'through the providers it’s signed in to')
})

function useBilling(u: UsageReport | null): { id: EngineId; label: string; status: EngineStatus }[] {
  const engines = useStore((s) => s.settings.engines)
  const used = new Set(u?.models.map((m) => m.engine))
  const ids = (Object.keys(engines) as EngineId[]).filter((id) => (used.size ? used.has(id) : engines[id].loggedIn && !engines[id].off && !engines[id].soon))
  return ids.map((id) => ({ id, label: ENGINES[id].label, status: engines[id] }))
}

export function UsagePage(): ReactNode {
  const [u, setU] = useState<UsageReport | null>(null)
  // Recomputed whenever a reply lands with its receipt.
  const count = useStore((s) => receipts(s).length)
  // What the team spends is the admins' (a member can still land here from the search).
  const admin = useStore(amAdmin)
  useEffect(() => void (admin && loadUsage().then(setU)), [count, admin])
  const billing = useBilling(u)
  const allPlan = billing.length > 0 && billing.every((b) => b.status.route === 'plan')

  const subtitle = (
    <>
      {allPlan ? L('Tudo roda nas suas assinaturas.', 'Everything runs on your subscriptions.') : L('Quanto os agentes gastam, e onde cada um vai fechar o mês.', 'What the agents spend, and where each one will end the month.')}
      {!allPlan && billing.length > 0 && (
        <span className="usage-billing">
          {billing.map((b) => (
            <span key={b.id} className={`tag ${b.status.route === 'apikey' ? 'tag--warn' : ''}`} title={b.status.account}>
              {b.label}: {b.status.route ? PAYS()[b.status.route] : (b.status.account ?? L('sem login', 'not signed in'))}
              {b.status.route === 'gateway' && b.status.gateway ? ` ${b.status.gateway}` : ''}
            </span>
          ))}
        </span>
      )}
    </>
  )

  if (!admin)
    return (
      <Sheet wide title={L('Uso e limites', 'Usage and limits')}>
        <AdminOnly>{L('Só um admin vê o uso e os limites do Tucano.', 'Only an admin sees the Tucano’s usage and limits.')}</AdminOnly>
      </Sheet>
    )
  return (
    <Sheet wide title={L('Uso e limites', 'Usage and limits')} lede={subtitle}>
      {!u ? (
        <p className="read-empty">{L('Fazendo as contas…', 'Doing the math…')}</p>
      ) : (
        <>
          <Quotas />
          <Month u={u} claude={billing.find((b) => b.id === 'claude')?.status} />
          {billing.find((b) => b.id === 'claude')?.status.route === 'plan' && <Quota />}
          {billing.find((b) => b.id === 'codex')?.status.route === 'plan' && <CodexQuota />}
          <Agents u={u} />
          <div className="usage-grid">
            <Models u={u} />
            <Backstage u={u} />
          </div>
          <Receipts />
        </>
      )}
    </Sheet>
  )
}

// ---------- the month ----------

function Month({ u, claude }: { u: UsageReport; claude?: EngineStatus }): ReactNode {
  const agents = useStore((s) => s.agents)
  const [hover, setHover] = useState<number | null>(null)
  const name = cap(new Date(u.monthStart).toLocaleDateString(locale(), { month: 'long', year: 'numeric' }))
  const lastName = new Date(new Date(u.monthStart).setMonth(new Date(u.monthStart).getMonth() - 1)).toLocaleDateString(locale(), { month: 'long' })

  // Each day, stacked by who (biggest spender at the bottom), in the order of the month's totals.
  const order = [...new Set(u.who.map((w) => whoOf(w.id, agents).key))]
  const days = u.days.map((d) => {
    const parts = new Map<string, number>()
    for (const [id, t] of Object.entries(d)) {
      const k = whoOf(id, agents).key
      parts.set(k, (parts.get(k) ?? 0) + t)
    }
    return { total: [...parts.values()].reduce((a, b) => a + b, 0), parts: order.flatMap((k) => (parts.get(k) ? [{ key: k, tokens: parts.get(k)! }] : [])) }
  })
  const peak = Math.max(1, ...days.map((d) => d.total))
  const legend = order.map((k) => (k === APP ? { key: k, name: L('Bastidores', 'Behind the scenes'), color: 'var(--text-3)' } : whoOf(k, agents)))
  const color = (k: string): string => legend.find((l) => l.key === k)?.color ?? 'var(--text-3)'

  const delta = u.lastMonth ? Math.round(((u.total - u.lastMonth) / u.lastMonth) * 100) : undefined
  const shown = hover !== null ? days[hover] : undefined

  return (
    <section className="usage-month">
      <div className="usage-month__head">
        <div>
          <span className="usage-eyebrow">{name}</span>
          <div className="usage-month__total">
            <strong>{tokens(u.total)}</strong>
            <span>tokens</span>
          </div>
          <span className="muted small">
            {delta === undefined ? (
              L('O primeiro mês com uso registrado.', 'The first month with recorded usage.')
            ) : (
              <>
                <span className={`usage-delta ${delta > 0 ? 'is-up' : 'is-down'}`}>
                  <Icon name={delta > 0 ? 'up' : 'down'} size={11} /> {Math.abs(delta)}%
                </span>{' '}
                {L(`que no mesmo ponto de ${lastName}`, `vs. the same point in ${lastName}`)}
              </>
            )}
          </span>
        </div>
        <dl className="usage-facts">
          <div>
            <dt>{L('Respostas', 'Replies')}</dt>
            <dd>{u.replies.toLocaleString(locale())}</dd>
          </div>
          <div>
            <dt>{L('Tempo médio', 'Average time')}</dt>
            <dd>{u.replies ? duration(u.avgMs) : '—'}</dd>
          </div>
          {claude && <ApiCost usd={u.apiUsd} claude={claude} />}
        </dl>
      </div>

      <div className="usage-chart" onMouseLeave={() => setHover(null)}>
        <span className="usage-chart__peak">{tokens(peak)}</span>
        <div className="usage-chart__bars">
          {Array.from({ length: u.daysInMonth }, (_, i) => {
            const d = days[i]
            const today = i === days.length - 1
            return (
              <div
                key={i}
                className={`usage-chart__day ${d ? '' : 'is-future'} ${today ? 'is-today' : ''} ${hover === i ? 'is-hover' : ''}`}
                onMouseEnter={() => setHover(d ? i : null)}
              >
                <div className="usage-chart__stack" style={{ height: d ? `${Math.max(d.total ? 2 : 0, (d.total / peak) * 100)}%` : undefined, '--i': i } as CSSProperties}>
                  {d?.parts.map((p) => <i key={p.key} style={{ flexGrow: p.tokens, background: color(p.key) }} />)}
                </div>
              </div>
            )
          })}
        </div>
        <div className="usage-chart__axis">
          {Array.from({ length: u.daysInMonth }, (_, i) => (
            <span key={i}>{i === days.length - 1 ? L('hoje', 'today') : i === 0 || (i + 1) % 7 === 1 ? i + 1 : ''}</span>
          ))}
        </div>
        {shown && hover !== null && (
          <div className={`usage-tip ${hover / u.daysInMonth > 0.6 ? 'is-left' : ''}`} style={{ '--x': `${((hover + 0.5) / u.daysInMonth) * 100}%` } as CSSProperties}>
            <strong>{cap(new Date(u.monthStart + hover * DAY + DAY / 2).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' }))}</strong>
            <span className="usage-tip__total">{shown.total ? `${tokens(shown.total)} tokens` : L('Sem uso', 'No usage')}</span>
            {[...shown.parts].reverse().map((p) => (
              <span key={p.key} className="usage-tip__row">
                <i style={{ background: color(p.key) }} />
                {legend.find((l) => l.key === p.key)?.name}
                <b>{tokens(p.tokens)}</b>
              </span>
            ))}
          </div>
        )}
      </div>

      {legend.length > 0 && (
        <div className="usage-legend">
          {legend.map((l) => (
            <span key={l.key}>
              <i style={{ background: l.color }} />
              {l.name}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

// Only Claude Code reports a price; what it means depends on how it's logged in.
function ApiCost({ usd: v, claude }: { usd: number; claude: EngineStatus }): ReactNode {
  const [label, hint] =
    claude.route === 'plan'
      ? [L('Valeria na API', 'Worth on the API'), L('Quanto o mesmo uso do Claude Code custaria pagando a API. Não é cobrado: roda na sua assinatura.', 'What the same Claude Code usage would cost paying for the API. You aren’t billed: it runs on your subscription.')]
      : claude.route === 'apikey'
        ? [L('Custo na API', 'API cost'), L('O que o Claude Code informou de custo. Logado com chave de API, isso é cobrado por token.', 'The cost Claude Code reported. Signed in with an API key, this is billed per token.')]
        : [L('Preço de tabela', 'List price'), L('O preço da API pro uso do Claude Code. Quanto é cobrado de fato depende do gateway.', 'The API price for the Claude Code usage. What you’re actually billed depends on the gateway.')]
  return (
    <div title={hint}>
      <dt>{label}</dt>
      <dd>{usd(v)}</dd>
      {claude.route === 'apikey' && <span className="usage-facts__note">{L('cobrado por token', 'billed per token')}</span>}
    </div>
  )
}

// ---------- the subscriptions, and what each provider has left ----------

// ---------- the Claude subscription ----------

// Its own windows, as the last reply reported them.
function Quota(): ReactNode {
  const q = useStore((s) => s.settings.quota)
  if (!q || (!q.fiveHour && !q.sevenDay)) return null
  const at = new Date(q.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  return (
    <section className="read-group">
      <h2>
        {L('Sua assinatura do Claude', 'Your Claude subscription')}<span>{L(`segundo o Claude Code às ${at}`, `per Claude Code at ${at}`)}</span>
      </h2>
      <div className="usage-quota">
        {q.fiveHour && <Ring label={L('Janela de 5 horas', '5-hour window')} w={q.fiveHour} />}
        {q.sevenDay && <Ring label={L('Semana', 'Week')} w={q.sevenDay} />}
      </div>
    </section>
  )
}

// ---------- the Codex subscription ----------

// Its windows, as Codex told when this page asked: how many and how long depends on the plan.
function CodexQuota(): ReactNode {
  const q = useStore((s) => s.settings.codexQuota)
  if (!q?.windows.length) return null
  const at = new Date(q.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
  const plan = q.plan ? ` ${cap(q.plan)}` : ''
  return (
    <section className="read-group">
      <h2>
        {L(`Sua assinatura do Codex${plan}`, `Your Codex${plan} subscription`)}<span>{L(`segundo o Codex às ${at}`, `per Codex at ${at}`)}</span>
      </h2>
      <div className="usage-quota">
        {q.windows.map((w) => (
          <Ring key={w.minutes} label={windowLabel(w.minutes)} w={w} />
        ))}
      </div>
    </section>
  )
}

const windowLabel = (minutes: number): string =>
  minutes === 10_080
    ? L('Semana', 'Week')
    : minutes === 1440
      ? L('Dia', 'Day')
      : minutes % 1440 === 0
      ? L(`Janela de ${minutes / 1440} dias`, `${minutes / 1440}-day window`)
      : minutes % 60 === 0
        ? L(`Janela de ${minutes / 60} horas`, `${minutes / 60}-hour window`)
        : L(`Janela de ${minutes} min`, `${minutes}-minute window`)

function Ring({ label, w }: { label: string; w: { utilization: number; resetsAt: number } }): ReactNode {
  const pct = Math.min(1, Math.max(0, w.utilization))
  const r = 22
  const c = 2 * Math.PI * r
  const tone = pct >= 0.9 ? 'is-danger' : pct >= 0.7 ? 'is-warn' : ''
  return (
    <div className={`usage-ring ${tone}`}>
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden>
        <circle cx="28" cy="28" r={r} className="usage-ring__track" />
        <circle cx="28" cy="28" r={r} className="usage-ring__fill" strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
      </svg>
      <div>
        <span className="muted small">{label}</span>
        <strong>{L(`${Math.round(pct * 100)}% usado`, `${Math.round(pct * 100)}% used`)}</strong>
        <span className="muted small">{L('zera', 'resets')} {until(w.resetsAt)}</span>
      </div>
    </div>
  )
}
// ---------- what each provider has left ----------

// The three rows of a provider's column, the short window first. Every column has all three, so
// they line up and a missing one reads as a dash instead of moving its neighbours.
const ROWS = [
  { key: 'session', label: () => L('Agora', 'Now'), hint: () => L('a janela curta: 5 horas, ou a hora', 'the short window: 5 hours, or the hour') },
  { key: 'week', label: () => L('Semana', 'Week'), hint: () => L('a janela semanal', 'the weekly window') },
  { key: 'month', label: () => L('Mês', 'Month'), hint: () => L('o mês de cobrança, ou o saldo', 'the billing month, or the balance') }
] as const
type Row = (typeof ROWS)[number]['key']

// What the provider says is left, in its own unit.
export function left(w: QuotaWindow): string {
  if (w.unit === '%') {
    const p = w.used !== undefined ? (w.limit ? 1 - w.used : (w.remaining ?? 0)) : (w.remaining ?? 0)
    return p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`
  }
  if (w.unit === 'usd') return usd(w.remaining ?? 0)
  return tokens(w.remaining ?? 0)
}
export const share = (w: QuotaWindow): number | undefined => (w.limit && w.limit > 0 && w.remaining !== undefined ? Math.min(1, Math.max(0, w.remaining / w.limit)) : undefined)

// The CLI's own reading of the subscription, when its credentials aren't on disk (or are expired):
// the last reply already told Tucano where those windows stand.
function withReported(list: ProviderQuota[], reported: Quota | undefined): ProviderQuota[] {
  if (!reported || (!reported.fiveHour && !reported.sevenDay)) return list
  const win = (w: { utilization: number; resetsAt: number }): QuotaWindow => {
    const used = Math.min(1, Math.max(0, w.utilization))
    return { used, remaining: 1 - used, limit: 1, unit: '%', resetsAt: w.resetsAt }
  }
  const from: Pick<ProviderQuota, 'session' | 'week'> = { ...(reported.fiveHour ? { session: win(reported.fiveHour) } : {}), ...(reported.sevenDay ? { week: win(reported.sevenDay) } : {}) }
  const i = list.findIndex((p) => p.id === 'anthropic-claude-code')
  if (i < 0) return [...list, { id: 'anthropic-claude-code', label: 'Claude Code', via: L('a última resposta', 'the last reply'), at: reported.at, ...from }]
  return list.map((p, n) => {
    if (n !== i) return p
    const merged = { ...p, session: p.session ?? from.session, week: p.week ?? from.week }
    return merged.session || merged.week ? { ...merged, error: undefined } : p
  })
}

export function Quotas(): ReactNode {
  const reported = useStore((s) => s.settings.quota)
  // Whose logins these are: an admin's, like the rest of the page. A member's app never asks.
  const admin = useStore(amAdmin)
  const [list, setList] = useState<ProviderQuota[] | null>(null)
  const [busy, setBusy] = useState(false)
  const load = (): void => {
    setBusy(true)
    loadQuotas()
      .then((l) => setList(withReported(l, reported)))
      .catch(() => setList(withReported([], reported)))
      .finally(() => setBusy(false))
  }
  // Read once when the page opens: a look, not a poll.
  useEffect(() => {
    if (admin) load()
  }, [admin])
  const cols = list ?? []
  return (
    <section className="read-group usage-card">
      <h2>
        {L('O que cada provedor ainda tem', 'What each provider has left')}
        <span>{L('Lido agora dos seus próprios logins neste computador: os CLIs, o Pi e o Hermes.', 'Read just now from your own logins on this computer: the CLIs, Pi and Hermes.')}</span>
      </h2>
      <div className="usage-quotas__bar">
        {cols.length > 0 && (
          <span className="muted small">
            {L(`${cols.length} ${cols.length === 1 ? 'provedor' : 'provedores'}`, `${cols.length} ${cols.length === 1 ? 'provider' : 'providers'}`)}
            {list && cols.length > 0 ? L(` · lido às ${shortTime(Date.now())}`, ` · read at ${shortTime(Date.now())}`) : ''}
          </span>
        )}
        <button className="btn btn--ghost btn--sm" onClick={load} disabled={busy}>
          {busy ? L('Lendo…', 'Reading…') : L('Ler de novo', 'Read again')}
        </button>
      </div>
      {cols.length === 0 ? (
        <p className="muted small">
          {L(
            'Nenhum login encontrado para pedir cota. Entre no Claude Code, no Codex ou no OpenCode, ou configure um provedor no Pi ou no Hermes, e ele aparece aqui.',
            'No login found to ask for a quota. Sign in to Claude Code, Codex or OpenCode, or set up a provider in Pi or Hermes, and it shows up here.'
          )}
        </p>
      ) : (
        <div className="usage-quotas">
          <div className="usage-quotas__grid" style={{ gridTemplateColumns: `84px repeat(${cols.length}, minmax(148px, 1fr))` }}>
            <span />
            {cols.map((p) => (
              <div key={p.id} className={`usage-quota__head ${p.error ? 'is-off' : ''}`} title={p.error ?? `${p.label} · ${p.via}`}>
                <strong className="truncate">{p.label}</strong>
                <span className="muted small truncate">{p.error ?? p.plan ?? p.via}</span>
              </div>
            ))}
            {ROWS.map((row) => (
              <Fragment key={row.key}>
                <div className="usage-quotas__row" title={row.hint()}>
                  {row.label()}
                </div>
                {cols.map((p) => (
                  <Cell key={`${p.id}:${row.key}`} id={p.id} row={row.key} w={p[row.key as Row]} error={p.error} />
                ))}
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function Cell({ id, row, w, error }: { id: string; row: Row; w?: QuotaWindow; error?: string }): ReactNode {
  if (!w) return <div className="usage-quota__cell is-empty" data-provider={id} data-row={row}>—</div>
  const s = share(w)
  const tone = s === undefined ? '' : s <= 0.1 ? 'is-danger' : s <= 0.3 ? 'is-warn' : ''
  return (
    <div className={`usage-quota__cell ${tone}`} data-provider={id} data-row={row} title={w.resetsAt ? L(`zera ${until(w.resetsAt)}`, `resets ${until(w.resetsAt)}`) : undefined}>
      <strong>{left(w)}</strong>
      {s !== undefined && (
        <span className="usage-quota__track">
          <i style={{ width: `${Math.round(s * 100)}%` }} />
        </span>
      )}
      <span className="muted small truncate">{w.resetsAt ? L(`zera ${until(w.resetsAt)}`, `resets ${until(w.resetsAt)}`) : w.unit === 'usd' ? L('saldo', 'balance') : ''}</span>
    </div>
  )
}
// ---------- agents and their limits ----------

function Agents({ u }: { u: UsageReport }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => isTeam(a)))
  if (agents.length === 0) return null
  const elapsed = Math.max(0, (Date.now() - u.monthStart) / DAY)
  const sorted = [...agents].sort((a, b) => b.used - a.used)
  return (
    <section className="read-group">
      <h2>
        {L('Por agente', 'By agent')}<span>{L('O limite do mês, conferido antes de cada resposta. A parte clara é onde o ritmo atual leva.', 'The monthly limit, checked before every reply. The light part is where the current pace leads.')}</span>
      </h2>
      <div className="usage-agents">
        {sorted.map((a) => (
          <AgentRow key={a.id} agent={a} stats={u.who.find((w) => w.id === a.id)} elapsed={elapsed} daysInMonth={u.daysInMonth} monthStart={u.monthStart} />
        ))}
      </div>
    </section>
  )
}

function AgentRow({ agent: a, stats, elapsed, daysInMonth, monthStart }: { agent: Agent; stats?: UsageReport['who'][number]; elapsed: number; daysInMonth: number; monthStart: number }): ReactNode {
  const model = modelInfo(a.modelId)
  const unlimited = !(a.limit > 0)
  const pct = unlimited ? 0 : a.used / a.limit
  // The pace only means something after a couple of days.
  const pace = elapsed >= 2 ? a.used / elapsed : undefined
  const projected = pace !== undefined ? pace * daysInMonth : undefined
  const projPct = projected !== undefined && a.limit > 0 ? projected / a.limit : undefined
  const hitsOn = !unlimited && pace && a.limit > a.used ? new Date(monthStart + (a.limit / pace) * DAY) : undefined

  let status: ReactNode
  let tone = ''
  if (!unlimited && a.used >= a.limit) {
    status = L('Bateu o limite: parado até o mês virar ou você subir o limite', 'Hit the limit: stopped until the month turns or you raise the limit')
    tone = 'is-danger'
  } else if (projPct !== undefined && projPct >= 1 && hitsOn) {
    status = L(`No ritmo, bate o limite dia ${hitsOn.getDate()}`, `At this pace, hits the limit on the ${ordinal(hitsOn.getDate())}`)
    tone = 'is-warn'
  } else if (projPct !== undefined && a.used > 0) {
    status = L(`No ritmo, fecha o mês em ${percent(projPct)}`, `At this pace, ends the month at ${percent(projPct)}`)
  } else {
    status = a.used > 0 ? L('Começou agora a usar', 'Just started using it') : L('Sem uso este mês', 'No usage this month')
  }

  return (
    <button className={`usage-agent ${tone}`} onClick={() => navigate({ kind: 'agent', id: a.id })}>
      <AgentAvatar agent={a} size={30} />
      <span className="usage-agent__who">
        <strong>{a.name}</strong>
        <span className="muted small truncate">
          {model ? `${ENGINES[model.engine].label} · ${model.label}` : a.modelId}
          {stats?.replies ? ` · ${stats.replies} ${stats.replies === 1 ? L('resposta', 'reply') : L('respostas', 'replies')}` : ''}
        </span>
      </span>
      <span className="usage-agent__meter">
        <span className="usage-meter">
          {projPct !== undefined && projPct > pct && <span className="usage-meter__proj" style={{ width: `${Math.min(100, projPct * 100)}%` }} />}
          <span className="usage-meter__fill" style={{ width: `${Math.min(100, pct * 100)}%` }} />
        </span>
        <span className={`usage-agent__status small ${tone}`}>{status}</span>
      </span>
      <span className="usage-agent__nums">
        <strong>{tokens(a.used)}</strong>
        <span className="muted small">
          {unlimited ? L('sem limite', 'no limit') : `${L('de', 'of')} ${tokens(a.limit)} · ${percent(pct)}`}
        </span>
      </span>
      <Icon name="chevron" size={14} />
    </button>
  )
}

const percent = (p: number): string => (p > 0 && p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`)
const ordinal = (n: number): string => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`

// ---------- models and the app's own turns ----------

function Models({ u }: { u: UsageReport }): ReactNode {
  const total = u.models.reduce((a, m) => a + m.tokens, 0)
  const top = u.models.slice(0, 4)
  const rest = u.models.slice(4).reduce((a, m) => a + m.tokens, 0)
  const rows = [
    ...top.map((m) => {
      const info = modelInfo(m.model)
      return { key: `${m.engine}:${m.model}`, name: info?.label ?? m.model, engine: ENGINES[m.engine]?.label ?? m.engine, tokens: m.tokens }
    }),
    ...(rest ? [{ key: 'rest', name: L('Outros', 'Others'), engine: '', tokens: rest }] : [])
  ]
  return (
    <section className="read-group usage-card">
      <h2>{L('Por modelo', 'By model')}</h2>
      {total === 0 ? (
        <p className="muted small">{L('Nenhum uso este mês.', 'No usage this month.')}</p>
      ) : (
        <>
          <div className="usage-split">
            {rows.map((r, i) => (
              <i key={r.key} style={{ flexGrow: r.tokens, background: MODEL_COLORS[i] }} />
            ))}
          </div>
          <div className="usage-list">
            {rows.map((r, i) => (
              <div key={r.key} className="usage-list__row">
                <i style={{ background: MODEL_COLORS[i] }} />
                <span className="grow truncate">
                  {r.name} {r.engine && <span className="muted small">{r.engine}</span>}
                </span>
                <span className="mono small">{tokens(r.tokens)}</span>
                <span className="muted small usage-list__pct">{percent(r.tokens / total)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

function Backstage({ u }: { u: UsageReport }): ReactNode {
  const tuca = useStore((s) => s.agents.find((a) => a.kind === 'tuca'))
  const of = (id?: string): number => (id ? (u.who.find((w) => w.id === id)?.tokens ?? 0) : 0)
  const rows = [
    { key: 'router', name: L('Roteador', 'Router'), what: L('escolhe quem responde nos canais', 'picks who replies in channels'), tokens: of('router') },
    { key: 'memory', name: L('Memória', 'Memory'), what: L('resume conversas e sugere memórias', 'summarizes conversations and suggests memories'), tokens: of('memory') },
    ...(tuca ? [{ key: 'tuca', name: 'Tuca', what: L('te ajuda com o Tucano e monta agentes', 'helps you with Tucano and builds agents'), tokens: of(tuca.id) }] : [])
  ]
  const total = rows.reduce((a, r) => a + r.tokens, 0)
  return (
    <section className="read-group usage-card">
      <h2>{L('Bastidores', 'Behind the scenes')}</h2>
      <p className="muted small usage-card__lead">
        {L('O que o próprio app gasta, fora das respostas dos agentes', 'What the app itself spends, outside the agents’ replies')}{u.total ? L(`: ${percent(total / u.total)} do mês`, `: ${percent(total / u.total)} of the month`) : ''}.
      </p>
      <div className="usage-list">
        {rows.map((r) => (
          <div key={r.key} className="usage-list__row">
            <span className="grow">
              {r.name} <span className="muted small">{r.what}</span>
            </span>
            <span className="mono small">{tokens(r.tokens)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---------- recent receipts ----------

function Receipts(): ReactNode {
  const [shown, setShown] = useState(10)
  const all = useStore(receipts)
  const recent = [...all].sort((a, b) => b.at - a.at)
  if (recent.length === 0) return null
  return (
    <section className="read-group">
      <h2>
        {L('Recibos recentes', 'Recent receipts')}<span>{L('Clique pra abrir a resposta na conversa.', 'Click to open the reply in its conversation.')}</span>
      </h2>
      <div className="usage-receipts">
        <div className="usage-receipt usage-receipt--head">
          <span />
          <span>{L('Resposta', 'Reply')}</span>
          <span>{L('Onde', 'Where')}</span>
          <span>{L('Modelo', 'Model')}</span>
          <span className="num">{L('Tempo', 'Time')}</span>
          <span className="num">Tokens</span>
          <span className="num">{L('Quando', 'When')}</span>
        </div>
        {recent.slice(0, shown).map((m) => (
          <ReceiptRow key={m.id} id={m.id} />
        ))}
      </div>
      {recent.length > shown && (
        <button className="btn btn--ghost btn--sm usage-more" onClick={() => setShown(shown + 20)}>
          {L('Mostrar mais', 'Show more')}
        </button>
      )}
    </section>
  )
}

function ReceiptRow({ id }: { id: string }): ReactNode {
  const m = useStore((s) => messageById(s, id)!)
  const agent = useStore((s) => (m.author.kind === 'agent' ? agentById(s, m.author.id) : undefined))
  const conv = useStore((s) => s.conversations.find((c) => c.id === m.conversationId))
  const r = m.run!.receipt!
  const model = modelInfo(r.model)
  return (
    <button className="usage-receipt" onClick={() => navigate({ kind: 'conversation', id: m.conversationId, message: m.id })}>
      <span>{agent && <AgentAvatar agent={agent} size={20} />}</span>
      <span className="truncate">{m.text.replace(/[*`_#>]/g, '').split('\n')[0] || '—'}</span>
      <span className="muted truncate">{conv?.kind === 'channel' ? `#${conv.name}` : 'DM'}</span>
      <span className="muted truncate">{model?.label ?? r.model}</span>
      <span className="muted num">{duration(r.ms)}</span>
      <span className="mono num">{tokens(countedTokens(r))}</span>
      <span className="muted num">{shortTime(m.at)}</span>
    </button>
  )
}
