// The report (spec §20): how the week went, agent by agent, and straight to
// whatever needs a look. One calendar week at a time, like the routines.
import { L, locale } from '../../../shared/lang'
import { useEffect, useState, type ReactNode } from 'react'
import { agentById, amAdmin, loadReport, navigate, useStore, type AgentReport, type Problem, type Rate, type Report } from '../store'
import { Sheet } from './Pages'
import { AdminOnly } from './People'
import { when } from './Routines'
import { ago, AgentAvatar, Icon, shiftWeek, startOfWeek, tokens, weekRange } from './ui'

const ratio = (r: Rate): number | undefined => (r.replies ? r.ok / r.replies : undefined)
const pct = (r: Rate): string => (r.replies ? `${Math.round((r.ok / r.replies) * 100)}%` : '—')
const tone = (r: Rate): string => {
  const x = ratio(r)
  return x === undefined ? '' : x >= 0.9 ? 'is-ok' : x >= 0.75 ? 'is-warn' : 'is-danger'
}
const sum = (rates: Rate[]): Rate => rates.reduce((a, r) => ({ replies: a.replies + r.replies, ok: a.ok + r.ok }), { replies: 0, ok: 0 })
const minutes = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`)
const day = (at: number): string => new Date(at).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit' })

const PROBLEM = (): Record<Problem['kind'], string> => ({
  failed: L('Falhou', 'Failed'),
  cut: L('Foi cortada (loop ou travou)', 'Cut off (a loop, or it stalled)'),
  paused: L('Parou no limite por resposta', 'Stopped at the per-reply limit'),
  refused: L('Você recusou uma ação', 'You refused an action')
})

export function ReportPage(): ReactNode {
  const [week, setWeek] = useState(() => startOfWeek(Date.now()))
  const [report, setReport] = useState<Report | null>(null)
  const thisWeek = week === startOfWeek(Date.now())
  // The team's report is the admins' (a member can still land here from the search).
  const admin = useStore(amAdmin)

  useEffect(() => {
    if (!admin) return
    let on = true
    void loadReport(week).then((r) => on && setReport(r))
    return () => {
      on = false
    }
  }, [week, admin])

  // ← → change the week, T comes back to this one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') setWeek((w) => shiftWeek(w, -1))
      else if (e.key === 'ArrowRight') setWeek((w) => shiftWeek(w, 1))
      else if (e.key.toLowerCase() === 't') setWeek(startOfWeek(Date.now()))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = report?.agents.filter((a) => a.total.replies > 0).sort((a, b) => b.total.replies - a.total.replies) ?? []
  const quiet = report?.agents.filter((a) => a.total.replies === 0) ?? []

  if (!admin)
    return (
      <Sheet title={L('Boletim', 'Report')}>
        <AdminOnly>{L('Só um admin vê o boletim do Tucano.', 'Only an admin sees the Tucano’s report.')}</AdminOnly>
      </Sheet>
    )
  return (
    <Sheet
      title={L('Boletim', 'Report')}
      lede={
        <>
          {weekRange(week)}
          {!thisWeek && (
            <>
              {' · '}
              <button className="text-btn" onClick={() => setWeek(startOfWeek(Date.now()))}>
                {L('voltar pra esta semana', 'back to this week')}
              </button>
            </>
          )}
        </>
      }
      actions={
        <div className="cal-nav">
          <button title={L('Semana anterior (←)', 'Previous week (←)')} onClick={() => setWeek(shiftWeek(week, -1))}>
            <Icon name="back" size={14} />
          </button>
          <button title={L('Esta semana (T)', 'This week (T)')} disabled={thisWeek} onClick={() => setWeek(startOfWeek(Date.now()))}>
            {L('Hoje', 'Today')}
          </button>
          <button title={L('Próxima semana (→)', 'Next week (→)')} disabled={thisWeek} onClick={() => setWeek(shiftWeek(week, 1))}>
            <Icon name="back" size={14} />
          </button>
        </div>
      }
    >
      {!report ? (
        <p className="read-empty">{L('Fazendo as contas…', 'Doing the math…')}</p>
      ) : (
        <>
          <Headline report={report} thisWeek={thisWeek} />

          {active.length > 0 && (
            <section className="read-group">
              <h2>{L('Por agente', 'By agent')}</h2>
              {active.map((a) => (
                <AgentLine key={a.agentId} report={a} />
              ))}
              {quiet.length > 0 && <Quiet ids={quiet.map((a) => a.agentId)} />}
            </section>
          )}

          {report.work.length > 0 && (
            <section className="read-group">
              <h2>
                {L('Por tarefa', 'By task')}<span>{L('O custo de cada issue citada na semana, com o dos agentes que ela chamou.', 'What each issue mentioned this week cost, including the agents it pulled in.')}</span>
              </h2>
              {report.work.map((w) => (
                <div key={w.work} className="rep-task">
                  <strong className="mono">{w.work}</strong>
                  <span className="rep-task__who">
                    <Agents ids={w.agents} />
                  </span>
                  <span className="grow" />
                  <span className="muted small">{w.replies === 1 ? L('1 resposta', '1 reply') : L(`${w.replies} respostas`, `${w.replies} replies`)}</span>
                  <span className="rep-task__tokens">{tokens(w.tokens)}</span>
                  <span className="muted small rep-task__when">{ago(w.last)}</span>
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </Sheet>
  )
}

// The week in one sentence, with the six weeks behind it.
function Headline({ report, thisWeek }: { report: Report; thisWeek: boolean }): ReactNode {
  const weeks = Array.from({ length: report.agents[0]?.weeks.length ?? 0 }, (_, i) => ({
    start: report.agents[0]!.weeks[i]!.start,
    rate: sum(report.agents.map((a) => a.weeks[i]!.rate))
  }))
  const now = weeks.at(-1)?.rate ?? { replies: 0, ok: 0 }
  const before = weeks.at(-2)?.rate
  const x = ratio(now)
  const mood = x === undefined ? '' : x >= 0.9 ? L('Semana boa', 'Good week') : x >= 0.75 ? L('Semana razoável', 'Fair week') : L('Semana difícil', 'Rough week')
  const diff = before?.replies && x !== undefined ? Math.round((x - before.ok / before.replies) * 100) : undefined
  const top = Math.max(1, ...weeks.map((w) => w.rate.replies))

  return (
    <section className="rep-head">
      <div className="rep-head__text">
        {now.replies === 0 ? (
          <h2>{thisWeek ? L('Nenhuma resposta dos agentes ainda nesta semana.', 'No replies from the agents yet this week.') : L('Nenhuma resposta dos agentes nesta semana.', 'No replies from the agents this week.')}</h2>
        ) : (
          <>
            <h2>
              {mood}: <span className={tone(now)}>{pct(now)}</span> {L(`das ${now.replies} respostas terminaram bem.`, `of ${now.replies} replies ended well.`)}
            </h2>
            <p>
              {diff === undefined
                ? L('A primeira semana com respostas.', 'The first week with replies.')
                : diff === 0
                  ? L('Igual à semana anterior.', 'Same as the week before.')
                  : L(`${Math.abs(diff)} ${Math.abs(diff) === 1 ? 'ponto' : 'pontos'} ${diff > 0 ? 'acima' : 'abaixo'} da semana anterior.`, `${Math.abs(diff)} ${Math.abs(diff) === 1 ? 'point' : 'points'} ${diff > 0 ? 'above' : 'below'} the week before.`)}
              {thisWeek && L(' A semana ainda está rolando.', ' The week is still under way.')}
            </p>
          </>
        )}
      </div>
      <div className="rep-strip" title={L('Respostas por semana; a parte cheia terminou bem', 'Replies per week; the filled part ended well')}>
        {weeks.map((w, i) => (
          <div key={w.start} className={`rep-strip__col ${i === weeks.length - 1 ? 'is-this' : ''}`} title={L(`Semana de ${day(w.start)}: ${w.rate.ok} de ${w.rate.replies} terminaram bem`, `Week of ${day(w.start)}: ${w.rate.ok} of ${w.rate.replies} ended well`)}>
            <span className={`rep-strip__bar ${w.rate.replies ? '' : 'is-empty'}`} style={{ height: `${Math.max(4, (w.rate.replies / top) * 100)}%` }}>
              <i style={{ height: w.rate.replies ? `${(w.rate.ok / w.rate.replies) * 100}%` : 0 }} />
            </span>
            <span>{day(w.start)}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

function AgentLine({ report: r }: { report: AgentReport }): ReactNode {
  const agent = useStore((s) => agentById(s, r.agentId))
  if (!agent) return null
  const top = Math.max(1, ...r.weeks.map((w) => w.rate.replies))
  const more = r.failed + r.cut + r.paused + r.approvals.refused - r.problems.length
  return (
    <div className="rep-line">
      <div className="rep-line__main">
        <button className="rep-line__who" onClick={() => navigate({ kind: 'agent', id: agent.id })}>
          <AgentAvatar agent={agent} size={28} />
          <span className="rep-line__name">
            <strong>{agent.name}</strong>
            <span>
              {r.total.replies === 1 ? L('1 resposta', '1 reply') : L(`${r.total.replies} respostas`, `${r.total.replies} replies`)} · {L(`${tokens(r.avgTokens)} tokens e ${minutes(r.avgMs)} em média`, `${tokens(r.avgTokens)} tokens and ${minutes(r.avgMs)} on average`)}
            </span>
          </span>
        </button>
        <span className="rep-spark" title={L('As últimas 6 semanas', 'The last 6 weeks')}>
          {r.weeks.map((w) => (
            <span key={w.start} className={`rep-spark__bar ${w.rate.replies ? '' : 'is-empty'}`} style={{ height: `${Math.max(8, (w.rate.replies / top) * 100)}%` }}>
              <i style={{ height: w.rate.replies ? `${(w.rate.ok / w.rate.replies) * 100}%` : 0 }} />
            </span>
          ))}
        </span>
        <span className={`rep-line__rate ${tone(r.total)}`}>{pct(r.total)}</span>
      </div>
      {r.problems.length === 0 ? (
        <p className="rep-line__fine">
          <Icon name="check" size={12} /> {L('Nada falhou, travou ou foi recusado.', 'Nothing failed, stalled or was refused.')}
        </p>
      ) : (
        <ul className="rep-problems">
          {r.problems.map((p) => (
            <li key={`${p.kind}-${p.messageId}`}>
              <button onClick={() => navigate({ kind: 'conversation', id: p.conversationId, message: p.messageId })} title={p.detail}>
                <span className={`status-dot ${p.kind === 'failed' ? 'is-danger' : 'is-warn'}`} />
                <span className="rep-problems__what">{p.kind === 'refused' && p.detail ? L(`Você recusou ${p.detail}`, `You refused ${p.detail}`) : PROBLEM()[p.kind]}</span>
                <span className="rep-problems__when">{when(p.at)}</span>
                <span className="rep-problems__go">{L('ver a resposta →', 'see the reply →')}</span>
              </button>
            </li>
          ))}
          {more > 0 && <li className="rep-problems__more">{L(`e mais ${more}`, `and ${more} more`)}</li>}
        </ul>
      )}
    </div>
  )
}

function Quiet({ ids }: { ids: string[] }): ReactNode {
  const names = useStore((s) => ids.map((id) => agentById(s, id)?.name).filter(Boolean))
  if (names.length === 0) return null
  return <p className="rep-quiet">{L('Sem respostas nesta semana', 'No replies this week')}: {names.join(', ').replace(/, ([^,]+)$/, L(' e $1', ' and $1'))}.</p>
}

function Agents({ ids }: { ids: string[] }): ReactNode {
  const agents = useStore((s) => ids.map((id) => agentById(s, id)).filter((a) => !!a))
  return (
    <>
      {agents.map((a) => (
        <AgentAvatar key={a.id} agent={a} size={16} />
      ))}
    </>
  )
}
