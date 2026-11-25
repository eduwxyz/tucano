// Execuções, in Uso e limites: the agents' finished replies, to find what was slow or failed, and why.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { L, locale } from '../../../shared/lang'
import { EXECUTION_DAYS, isTeam, type ExecutionFilter, type ExecutionPage, type ExecutionQuery, type ExecutionRow, type ExecutionStep, type RunStatus } from '../../../shared/types'
import { agentById, amAdmin, loadExecutions, loadExecutionSteps, modelInfo, navigate, useStore } from '../store'
import { Select } from './Select'
import { AgentAvatar, duration, durationOrDash, share, shortTime, tokens } from './ui'

const ALL = 'all'
const REFRESH_EVERY = 3000

export const toExecutions = (): void => document.getElementById('executions')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })

const periodLabel = (days: number): string => (days === 1 ? L('24 horas', '24 hours') : L(`${days} dias`, `${days} days`))

const FILTERS = (): { id: ExecutionFilter | undefined; label: string }[] => [
  { id: undefined, label: L('Todas', 'All') },
  { id: 'ok', label: 'OK' },
  { id: 'failed', label: L('Falhas', 'Failed') },
  { id: 'stopped', label: L('Paradas', 'Stopped') }
]

const statusOf = (s: RunStatus): { label: string; tone: 'ok' | 'danger' | 'warn' } => {
  if (s === 'failed') return { label: L('Falhou', 'Failed'), tone: 'danger' }
  if (s === 'stopped') return { label: L('Parada', 'Stopped'), tone: 'warn' }
  if (s === 'limit_reached') return { label: L('No limite', 'At the limit'), tone: 'warn' }
  if (s === 'paused') return { label: L('Pausada', 'Paused'), tone: 'warn' }
  if (s === 'interrupted') return { label: L('Interrompida', 'Interrupted'), tone: 'warn' }
  if (s === 'waiting_input') return { label: L('Perguntou', 'Asked'), tone: 'ok' }
  if (s === 'waiting_approval') return { label: L('Pediu aprovação', 'Asked to approve'), tone: 'ok' }
  return { label: 'OK', tone: 'ok' }
}

// Follows `value` at most once per `ms`: a burst of replies landing asks the core once.
function useAtMostEvery<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    latest.current = value
    if (value === shown || timer.current) return
    timer.current = setTimeout(() => {
      timer.current = undefined
      setShown(latest.current)
    }, ms)
  }, [value, shown, ms])
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
    },
    []
  )
  return shown
}

function Choice<T>({ label, options, value, onChange }: { label: string; options: { id: T; label: string }[]; value: T; onChange: (id: T) => void }): ReactNode {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.label} type="button" role="radio" aria-checked={value === o.id} className={value === o.id ? 'is-active' : ''} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Steps({ row }: { row: ExecutionRow }): ReactNode {
  const [steps, setSteps] = useState<ExecutionStep[] | null>(null)
  const [failed, setFailed] = useState(false)
  const admin = useStore(amAdmin)
  useEffect(() => {
    if (!admin) return
    let on = true
    loadExecutionSteps(row.id).then(
      (s) => on && setSteps(s),
      () => on && setFailed(true)
    )
    return () => void (on = false)
  }, [row.id, admin])
  const longest = Math.max(1, ...(steps ?? []).map((s) => s.ms ?? 0))
  return (
    <div className="exec-steps">
      {failed ? (
        <p className="read-empty">{L('Não deu pra abrir os passos.', "Couldn't open the steps.")}</p>
      ) : !steps ? (
        <p className="read-empty">{L('Abrindo…', 'Opening…')}</p>
      ) : steps.length === 0 ? (
        <p className="read-empty">{L('Nenhuma ferramenta usada.', 'No tools used.')}</p>
      ) : (
        steps.map((s) => (
          <div key={s.id} className={`exec-step ${s.status === 'error' ? 'is-error' : ''}`}>
            <span className="truncate" title={s.detail}>
              <strong>{s.tool ?? s.label}</strong> {s.detail}
            </span>
            <span className="exec-step__bar">{s.ms !== undefined && <i style={{ width: `${(s.ms / longest) * 100}%` }} />}</span>
            <span className="num">{durationOrDash(s.ms)}</span>
            {s.error && <p className="exec-step__error">{s.error}</p>}
          </div>
        ))
      )}
      <button className="btn btn--ghost btn--sm" onClick={() => navigate({ kind: 'conversation', id: row.conversationId, message: row.id })}>
        {L('Abrir na conversa', 'Open in conversation')}
      </button>
    </div>
  )
}

function Row({ row, open, onToggle }: { row: ExecutionRow; open: boolean; onToggle: () => void }): ReactNode {
  const agent = useStore((s) => agentById(s, row.agentId))
  const conv = useStore((s) => s.conversations.find((c) => c.id === row.conversationId))
  const status = statusOf(row.status)
  return (
    <>
      <button className="usage-receipt" aria-expanded={open} onClick={onToggle}>
        <span>{agent && <AgentAvatar agent={agent} size={20} />}</span>
        <span className="truncate">
          <strong>{agent?.name ?? L('Agente excluído', 'Deleted agent')}</strong> <span className="muted">{row.preview}</span>
        </span>
        <span className="muted truncate">{conv?.kind === 'channel' ? `#${conv.name}` : 'DM'}</span>
        <span className="muted truncate">{row.model ? (modelInfo(row.model)?.label ?? row.model) : '—'}</span>
        <span className="muted num">{durationOrDash(row.ms)}</span>
        <span className="muted num">{row.tools || '—'}</span>
        <span className="mono num">{row.tokens === undefined ? '—' : tokens(row.tokens)}</span>
        <span className={`exec-status truncate is-${status.tone}`}>{status.label}</span>
        <span className="muted num">{shortTime(row.at)}</span>
      </button>
      {open && <Steps row={row} />}
    </>
  )
}

export function Executions({ filter, refresh }: { filter?: { agentId?: string; days?: number }; refresh?: unknown }): ReactNode {
  const [days, setDays] = useState(filter?.days ?? 1)
  const [agentId, setAgentId] = useState(filter?.agentId)
  const [status, setStatus] = useState<ExecutionFilter>()
  const [page, setPage] = useState<ExecutionPage | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<string>()
  const agents = useStore((s) => s.agents.filter((a) => isTeam(a)))
  const admin = useStore(amAdmin)
  const landed = useAtMostEvery(refresh, REFRESH_EVERY)
  const asked = useRef(0) // only the latest answer counts
  const paged = useRef(false) // past the first page, a new reply doesn't pull the list back to the top
  const query = useMemo<ExecutionQuery>(() => ({ days, ...(agentId ? { agentId } : {}), ...(status ? { status } : {}) }), [days, agentId, status])

  // A page that can't load leaves no numbers from another filter behind; one more that can't, keeps what's shown.
  const load = useCallback((q: ExecutionQuery, apply: (p: ExecutionPage) => void, first = true): void => {
    const n = ++asked.current
    loadExecutions(q).then(
      (p) => {
        if (n !== asked.current) return
        apply(p)
        setFailed(false)
      },
      () => {
        if (n !== asked.current) return
        setFailed(true)
        if (first) setPage(null)
      }
    )
  }, [])

  // Brought here by a link: straight to the list.
  useEffect(() => {
    if (filter) toExecutions()
  }, [filter])

  useEffect(() => {
    paged.current = false
    setOpen(undefined)
  }, [query])

  useEffect(() => {
    if (admin && !paged.current) load(query, setPage)
  }, [query, landed, admin, load])

  const more = (): void => {
    if (!page?.next) return
    paged.current = true
    load({ ...query, beforeAt: page.next.at, beforeId: page.next.id }, (p) => setPage((had) => ({ ...p, rows: [...(had?.rows ?? []), ...p.rows] })), false)
  }

  const stat = (label: string, value: string): ReactNode => (
    <span className="exec-stat">
      <strong>{value}</strong> {label}
    </span>
  )

  return (
    <section className="read-group" id="executions">
      <h2>
        {L('Execuções', 'Executions')}
        <span>{L('Abra uma linha pra ver onde foi o tempo.', 'Open a row to see where the time went.')}</span>
      </h2>
      <div className="exec-filters">
        <Choice label={L('Período', 'Period')} options={EXECUTION_DAYS.map((d) => ({ id: d, label: periodLabel(d) }))} value={days} onChange={setDays} />
        <Choice label="Status" options={FILTERS()} value={status} onChange={setStatus} />
        <Select
          className="exec-agent"
          aria-label={L('Agente', 'Agent')}
          value={agentId ?? ALL}
          onChange={(v) => setAgentId(!v || v === ALL ? undefined : v)}
          options={[{ value: ALL, label: L('Todos os agentes', 'All agents') }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
        />
      </div>
      {failed && <p className="read-empty">{L('Não deu pra carregar as execuções.', "Couldn't load the executions.")}</p>}
      {page && (
        <>
          <div className="exec-stats">
            {stat(L('execuções', 'executions'), page.count.toLocaleString(locale()))}
            {stat('p50', durationOrDash(page.p50))}
            {stat('p95', durationOrDash(page.p95))}
            {stat(L('taxa de erro', 'error rate'), page.errorRate === undefined ? '—' : share(page.errorRate))}
          </div>
          {page.rows.length === 0 ? (
            <p className="read-empty">{L('Nenhuma execução nesse período.', 'No executions in this period.')}</p>
          ) : (
            <div className="usage-receipts">
              <div className="usage-receipt usage-receipt--head">
                <span />
                <span>{L('Resposta', 'Reply')}</span>
                <span>{L('Onde', 'Where')}</span>
                <span>{L('Modelo', 'Model')}</span>
                <span className="num">{L('Tempo', 'Time')}</span>
                <span className="num">{L('Ferram.', 'Tools')}</span>
                <span className="num">Tokens</span>
                <span>Status</span>
                <span className="num">{L('Quando', 'When')}</span>
              </div>
              {page.rows.map((r) => (
                <Row key={r.id} row={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? undefined : r.id)} />
              ))}
            </div>
          )}
          {page.next && (
            <button className="btn btn--ghost btn--sm usage-more" onClick={more}>
              {L('Mostrar mais', 'Show more')}
            </button>
          )}
        </>
      )}
    </section>
  )
}
