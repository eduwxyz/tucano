// The board's own tasks, apart from the agents' work: what an agent suggested, what I do myself, what a
// routine works on until it's done, and what's done. Board.tsx places them in the columns and moves them;
// the cards, the suggestion strip and the task panel live here.
import { useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { L, locale } from '../../../shared/lang'
import { MAX_TASK_NOTES, MAX_TASK_TITLE, type Routine, type Schedule, type Task } from '../../../shared/types'
import { liveStep, taskKind, type BoardTask, type TaskKind } from '../board'
import { call } from '../rpc'
import { loadTasks, navigate, openThread, toast, useStore, type Agent, type Conversation } from '../store'
import { firstLine, nextOf, nextWords, routineWords } from './routines-view'
import { ago, AgentAvatar, MeAvatar } from './ui'

type Save = (t: Partial<Task> & { title: string }) => Promise<Task | undefined>

// A call to the core that disables its button while it runs and says why when it fails.
function usePending(): [boolean, (job: () => Promise<unknown>, failed: string) => Promise<boolean>] {
  const [busy, setBusy] = useState(false)
  const go = async (job: () => Promise<unknown>, failed: string): Promise<boolean> => {
    setBusy(true)
    try {
      await job()
      return true
    } catch (e) {
      toast(e instanceof Error ? e.message : failed)
      // The call may fail because the task is already gone on the server: reload, so the board stops showing it.
      void loadTasks()
      return false
    } finally {
      setBusy(false)
    }
  }
  return [busy, go]
}

export const Face = ({ agent, size = 22, busy }: { agent: Agent | undefined; size?: number; busy?: boolean }): ReactNode => (agent ? <span className="bd-av"><AgentAvatar agent={agent} size={size} busy={busy} /></span> : <span className={`bd-none ${size > 24 ? 'md' : ''}`} />)
const MeFace = ({ size = 22 }: { size?: number }): ReactNode => {
  const initials = useStore((s) => s.me.initials)
  return <span className="bd-av"><MeAvatar initials={initials} size={size} /></span>
}
export const Check = (): ReactNode => <svg className="bd-ck" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8" /><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
const Repeat = (): ReactNode => <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 7V6a2 2 0 0 1 2-2h7m0 0L10 2m2 2l-2 2M13 9v1a2 2 0 0 1-2 2H4m0 0l2 2m-2-2l2-2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
const clock = (at: number): string => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })

// Enter or Space on the card itself opens it (the cards are focusable, not buttons, so a button inside keeps its own).
const openOnKey = (onOpen: () => void) => (e: ReactKeyboardEvent): void => {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault()
    onOpen()
  }
}
const stop = (e: ReactMouseEvent): void => e.stopPropagation()

const repeatTask = async (id: string, schedule: Schedule | null): Promise<void> => void (await call('repeatTask', { id, schedule }))

// ---------- what agents suggest ----------

function Suggestion({ t, agent }: { t: Task; agent: Agent | undefined }): ReactNode {
  const [busy, go] = usePending()
  const name = agent?.name ?? L('um agente', 'an agent')
  return (
    <div className="bd-sug">
      <div className="t">
        <span className="tag">{L(`Sugerida por ${name}`, `Suggested by ${name}`)}</span>
        <div className="ti">{t.title}</div>
        {t.fromRoutine && <small>{L(`veio da rotina “${t.fromRoutine}”`, `came from the routine “${t.fromRoutine}”`)}</small>}
      </div>
      <button className="bd-btn ink sm" disabled={busy} aria-label={L(`Aceitar “${t.title}”`, `Accept “${t.title}”`)} onClick={() => void go(async () => { await call('acceptTask', { id: t.id }); toast(L('Entrou em “A fazer”.', 'Added to “To do”.')) }, L('Não consegui aceitar a sugestão.', "I couldn't accept the suggestion."))}>{L('Aceitar', 'Accept')}</button>
      <button className="bd-btn quiet sm" disabled={busy} aria-label={L(`Dispensar “${t.title}”`, `Dismiss “${t.title}”`)} onClick={() => void go(() => call('removeTask', { id: t.id }), L('Não consegui dispensar a sugestão.', "I couldn't dismiss the suggestion."))}>{L('Dispensar', 'Dismiss')}</button>
    </div>
  )
}

export function Suggestions({ list, agents }: { list: Task[]; agents: Map<string, Agent> }): ReactNode {
  const [all, setAll] = useState(false)
  if (!list.length) return null
  const rest = list.length - 3
  return (
    <section className="bd-sugs" aria-label={L('Sugestões dos seus agentes', 'Suggestions from your agents')}>
      {(all ? list : list.slice(0, 3)).map((t) => <Suggestion key={t.id} t={t} agent={t.suggestedBy ? agents.get(t.suggestedBy) : undefined} />)}
      {rest > 0 && <button className="bd-btn quiet sm bd-sugs-more" aria-expanded={all} onClick={() => setAll(!all)}>{all ? L('Mostrar menos', 'Show fewer') : L(`+${rest} ${rest === 1 ? 'sugestão' : 'sugestões'}`, `+${rest} more`)}</button>}
    </section>
  )
}

// ---------- the cards ----------

interface CardProps {
  t: Task
  focus: boolean
  onOpen: () => void
}

// Something I do myself, in "Fazendo": one button to say it's done, and it can be dragged to "Feito".
export function OwnCard({ t, focus, onOpen, onDown, save }: CardProps & { onDown: (e: ReactPointerEvent) => void; save: Save }): ReactNode {
  const [busy, go] = usePending()
  return (
    <div data-card={`t:${t.id}`} tabIndex={0} className={`bd-card task ${focus ? 'focus' : ''}`} onPointerDown={onDown} onClick={onOpen} onKeyDown={openOnKey(onOpen)} aria-label={L(`${t.title}, você está fazendo`, `${t.title}, you're doing it`)}>
      <div className="bd-c-top"><MeFace /><span className="nm">{L('Você', 'You')}</span><span className="time">{ago(t.createdAt)}</span></div>
      <div className="bd-c-title">{t.title}</div>
      {t.dueAt && <div className="bd-c-foot"><span>{L('até', 'by')} {new Date(t.dueAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</span></div>}
      <div className="bd-acts" onClick={stop}>
        <button className="bd-btn soft sm" disabled={busy} aria-label={L(`Concluir “${t.title}”`, `Mark “${t.title}” done`)} onClick={() => void go(async () => void (await save({ id: t.id, title: t.title, state: 'done' })), L('Não consegui concluir.', "I couldn't finish it."))}>{L('Concluir', 'Mark done')}</button>
      </div>
    </div>
  )
}

// What a routine said last time it worked on a task, in a few words.
function lastRun(run: BoardTask | undefined, routine: Routine | undefined): { text: string; tone: '' | 'bad' | 'live' | 'wait' } {
  // The routine is not in the store (hidden or gone): its runs can't be told apart from another routine's.
  if (!routine) return { text: L('Rotina indisponível', 'Routine unavailable'), tone: '' }
  if (!run) return { text: routine.lastAt ? L(`Rodou ${ago(routine.lastAt)}`, `Ran ${ago(routine.lastAt)}`) : L('Ainda não rodou', "It hasn't run yet"), tone: '' }
  if (run.column === 'doing') return { text: liveStep(run) ?? L('Trabalhando', 'Working'), tone: 'live' }
  if (run.column === 'you') return { text: L('Esperando você', 'Waiting for you'), tone: 'wait' }
  if (run.column === 'stuck') return { text: L('A última vez falhou', 'The last time it failed'), tone: 'bad' }
  // A finished run says how long ago it was, then what it said.
  const ran = run.endedAt ? L(`Rodou ${ago(run.endedAt)}`, `Ran ${ago(run.endedAt)}`) : L('Rodou e terminou', 'Ran and finished')
  const said = firstLine(run.last?.text ?? '')
  return { text: said ? `${ran} · ${said}` : ran, tone: '' }
}
const RunLine = ({ run, routine }: { run: BoardTask | undefined; routine: Routine | undefined }): ReactNode => {
  const { text, tone } = lastRun(run, routine)
  return <div className={`bd-st ${tone}`}>{tone === 'live' && <span className="bd-typing" aria-hidden="true"><i /><i /><i /></span>}<span>{text}</span></div>
}

// A task a routine works on until it's done: it stays in "Fazendo" between runs.
export function StandingCard({ t, routine, run, agent, now, focus, onOpen }: CardProps & { routine: Routine | undefined; run: BoardTask | undefined; agent: Agent | undefined; now: number }): ReactNode {
  const live = run?.column === 'doing'
  const next = routine ? nextOf(routine, now) : undefined
  const when = routine ? routineWords(routine) : L('rotina indisponível', 'routine unavailable')
  return (
    <div data-card={`t:${t.id}`} tabIndex={0} className={`bd-card standing ${live ? 'live' : ''} ${focus ? 'focus' : ''}`} onClick={onOpen} onKeyDown={openOnKey(onOpen)} aria-label={L(`${t.title}, ${agent?.name ?? 'agente'}, ${when}`, `${t.title}, ${agent?.name ?? 'agent'}, ${when}`)}>
      <div className="bd-c-top"><Face agent={agent} busy={live} /><span className="nm">{agent?.name ?? L('Agente', 'Agent')}</span></div>
      <div className="bd-c-title">{t.title}</div>
      <RunLine run={run} routine={routine} />
      {routine && <div className="bd-rt"><Repeat /><span className="when">{when}</span><span className="next">{next ? nextWords(next, now) : L('rotina pausada', 'routine paused')}</span></div>}
    </div>
  )
}

// Done today: small, with what the agent said when it finished, if it said anything.
export function DoneTaskCard({ t, focus, onOpen }: CardProps): ReactNode {
  return (
    <div data-card={`t:${t.id}`} tabIndex={0} className={`bd-card done ${focus ? 'focus' : ''}`} onClick={onOpen} onKeyDown={openOnKey(onOpen)} aria-label={L(`${t.title}, feita`, `${t.title}, done`)}>
      <div className="bd-done-row"><Check /><div className="bd-c-title">{t.title}</div>{!!t.doneAt && <span className="time">{clock(t.doneAt)}</span>}</div>
      {t.result && <div className="bd-res"><span>{t.result}</span></div>}
    </div>
  )
}

// ---------- repeat until it's done ----------

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]
const WEEKDAYS = [1, 2, 3, 4, 5]
const sameDays = (a: number[], b: number[]): boolean => a.length === b.length && b.every((d) => a.includes(d))

// When the agent works on it: every day or Monday to Friday, at one time. A schedule that was made elsewhere
// (other days) shows no choice picked and keeps its days until one is chosen.
// A schedule made in Rotinas with more than days and one time (several times, once, a date, a day of the
// month) would come back flattened to days and one time, so it is only shown there, in words.
function WhenBox({ from, action, busy, onSubmit }: { from?: Schedule; action: string; busy: boolean; onSubmit: (s: Schedule) => void }): ReactNode {
  const [days, setDays] = useState(from?.days ?? WEEKDAYS)
  const [time, setTime] = useState(from?.time ?? '09:00')
  if (from && (from.times || from.once || from.date || from.monthDay)) {
    return (
      <>
        <span>{routineWords({ schedule: from })}</span>
        <small className="bd-rep-hint">{L('Esse horário foi feito em Rotinas. Mude por lá.', 'This schedule was made in Routines. Change it there.')}</small>
      </>
    )
  }
  return (
    <div className="bd-rep">
      <span className="bd-pick" role="group" aria-label={L('Em quais dias', 'On which days')}>
        <button type="button" aria-pressed={sameDays(days, EVERY_DAY)} onClick={() => setDays(EVERY_DAY)}>{L('Todo dia', 'Every day')}</button>
        <button type="button" aria-pressed={sameDays(days, WEEKDAYS)} onClick={() => setDays(WEEKDAYS)}>{L('Seg a sex', 'Mon to Fri')}</button>
      </span>
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label={L('Horário', 'Time')} />
      <button type="button" className="bd-btn soft sm" disabled={busy || !time} onClick={() => onSubmit({ days, time })}>{action}</button>
    </div>
  )
}

// ---------- a task, open at the side ----------

const PILL: Record<TaskKind, () => [string, string]> = {
  suggestion: () => ['todo', L('Sugerida', 'Suggested')],
  todo: () => ['todo', L('A fazer', 'To do')],
  own: () => ['doing', L('Fazendo', 'Doing')],
  repeated: () => ['doing', L('Fazendo', 'Doing')],
  done: () => ['done', L('Feito', 'Done')]
}

interface PanelProps {
  t: Task
  team: Agent[]
  conversations: Conversation[]
  routine: Routine | undefined
  run: BoardTask | undefined
  now: number
  onClose: () => void
  save: Save
  onStart: (t: Task) => Promise<void>
  onRemove: (t: Task) => void
}

export function TaskPanel({ t, team, conversations, routine, run, now, onClose, save, onStart, onRemove }: PanelProps): ReactNode {
  const [title, setTitle] = useState(t.title)
  const [notes, setNotes] = useState(t.notes ?? '')
  const [busy, go] = usePending()
  const kind = taskKind(t)
  const [pill, pillText] = PILL[kind]()
  const a = t.agentId ? team.find((x) => x.id === t.agentId) : undefined
  const mine = kind === 'own' || kind === 'done' || (kind === 'todo' && !a)
  const places = conversations.filter((c) => c.kind === 'channel' && (!t.agentId || c.members.includes(t.agentId)))
  const due = t.dueAt ? new Date(t.dueAt) : undefined
  const dueValue = due ? `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}` : ''
  const name = title.trim() || t.title
  const words = async (): Promise<Task | undefined> => {
    const tt = title.trim()
    if (!tt) return t
    if (tt === t.title && notes === (t.notes ?? '')) return t
    return save({ id: t.id, title: tt, notes })
  }
  // Pending edits go with the action, so nothing typed is lost when the panel changes with it.
  const withEdits = (job: () => Promise<unknown>, failed: string): void => void go(async () => (await words()) && (await job()), failed)
  const turnOn = (s: Schedule): void => withEdits(async () => { await repeatTask(t.id, s); toast(L('Rotina ligada. O agente trabalha nisso até ficar pronto.', 'Routine on. The agent works on it until it’s done.')) }, L('Não consegui ligar a rotina.', "I couldn't turn the routine on."))
  const resave = (s: Schedule): void => void go(async () => { await repeatTask(t.id, s); toast(L('Horário salvo.', 'Time saved.')) }, L('Não consegui salvar o horário.', "I couldn't save the time."))
  const stopRepeat = (): void => void go(async () => { await repeatTask(t.id, null); toast(L('Parou de repetir. A tarefa voltou pra “A fazer”.', 'Stopped repeating. The task is back in “To do”.')) }, L('Não consegui parar de repetir.', "I couldn't stop repeating."))
  const finish = (): void => void go(async () => {
    if (!(await save({ id: t.id, title: name, notes, state: 'done' }))) return
    // Finishing a repeated task ends its routine (the server does it), so say so.
    if (kind === 'repeated') toast(L('Tarefa concluída. A rotina dela foi encerrada.', 'Task done. Its routine was ended.'))
    onClose()
  }, L('Não consegui concluir.', "I couldn't finish it."))
  const reopen = (): void => void go(async () => void (await save({ id: t.id, title: name, notes, state: 'todo' })), L('Não consegui reabrir.', "I couldn't reopen it."))
  const talk = (): void => {
    if (!routine) return
    navigate({ kind: 'conversation', id: routine.conversationId, message: run?.threadId ?? run?.requestId ?? run?.last?.id })
    if (run?.threadId) openThread(run.threadId)
  }
  return (
    <aside className="bd-side" role="dialog" aria-label={t.title}>
      <div className="bd-side-body">
        <div className="bd-side-top">
          {kind === 'own' || (kind === 'done' && !a) ? <MeFace size={44} /> : <Face agent={a} size={44} />}
          <div><b>{kind === 'own' || (kind === 'done' && !a) ? L('Você', 'You') : (a?.name ?? L('Sem agente', 'No agent'))}</b><small>{kind === 'own' ? L('você está fazendo', "you're doing it") : (a?.role ?? (kind === 'todo' ? L('escolha quem faz', 'pick who does it') : ''))}</small></div>
          <span className="bd-grow" />
          <span className={`bd-pill ${pill}`}>{pillText}</span>
          <button className="bd-icon-btn" onClick={() => void words().then(onClose)} aria-label={L('Fechar', 'Close')}>✕</button>
        </div>
        <div className="bd-form">
          <input className="title-in" value={title} maxLength={MAX_TASK_TITLE} onChange={(e) => setTitle(e.target.value)} onBlur={() => void words()} aria-label={L('Título', 'Title')} />
          {kind === 'repeated' && <RunLine run={run} routine={routine} />}
          <label>
            {mine ? L('Anotações', 'Notes') : L('Detalhes pro agente', 'Details for the agent')}
            <textarea value={notes} maxLength={MAX_TASK_NOTES} onChange={(e) => setNotes(e.target.value)} onBlur={() => void words()} placeholder={mine ? L('O que você quer lembrar sobre isso.', 'What you want to remember about it.') : L('O que ele precisa saber: contexto, o que conta como pronto, onde estão as coisas.', 'What it needs to know: context, what counts as done, where things are.')} />
          </label>
          {(kind === 'todo' || kind === 'own') && (
            <>
              <label>
                {L('Quem faz', 'Who does it')}
                <span className="bd-pick">
                  {/* an agent for a task of my own hands it back to the list, ready to start */}
                  {team.map((x) => (
                    <button key={x.id} type="button" aria-pressed={t.agentId === x.id} onClick={() => void save({ id: t.id, title: name, agentId: x.id, ...(kind === 'own' ? { state: 'todo' as const } : {}), ...(t.conversationId && !conversations.find((c) => c.id === t.conversationId)?.members.includes(x.id) ? { conversationId: '' } : {}) })}>
                      <AgentAvatar agent={x} size={22} />{x.name}
                    </button>
                  ))}
                </span>
              </label>
              <div className="bd-row2">
                <label>
                  {L('Onde', 'Where')}
                  <select value={t.conversationId ?? ''} onChange={(e) => void save({ id: t.id, title: name, conversationId: e.target.value })}>
                    <option value="">{a ? L(`DM com ${a.name}`, `DM with ${a.name}`) : 'DM'}</option>
                    {places.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                  </select>
                </label>
                <label>
                  {L('Prazo', 'Due')}
                  <input type="date" value={dueValue} onChange={(e) => {
                    const [y, m, d] = e.target.value.split('-').map(Number)
                    void save({ id: t.id, title: name, dueAt: y && m && d ? new Date(y, m - 1, d, 12).getTime() : 0 })
                  }} />
                </label>
              </div>
            </>
          )}
          {kind === 'todo' && a && (
            <div className="bd-rep-box">
              <span className="bd-rep-h">{L('Repetir até ficar pronto', "Repeat until it's done")}</span>
              <WhenBox action={L('Ligar rotina', 'Turn on routine')} busy={busy} onSubmit={turnOn} />
              <small className="bd-rep-hint">{L(`${a.name} trabalha nisso nesse horário até a tarefa ficar pronta.`, `${a.name} works on it at that time until the task is done.`)}</small>
            </div>
          )}
          {kind === 'repeated' && routine && (
            <div className="bd-rep-box">
              <span className="bd-rep-h">{L('Repetir até ficar pronto', "Repeat until it's done")}</span>
              <WhenBox from={routine.schedule} action={L('Salvar horário', 'Save time')} busy={busy} onSubmit={resave} />
              <small className="bd-rep-hint">{L('Falhas e cada vez que rodou aparecem em Rotinas.', 'Failures and every time it ran show in Routines.')}</small>
            </div>
          )}
        </div>
        {kind === 'done' && t.result && (
          <>
            <div className="bd-sec">{L('Resultado', 'Result')}</div>
            <div className="bd-reply"><p>{t.result}</p></div>
          </>
        )}
      </div>
      <div className="bd-side-foot">
        <span className="cost">{kind === 'done' && t.doneAt ? L(`Feita ${ago(t.doneAt)}`, `Done ${ago(t.doneAt)}`) : L(`Criada ${ago(t.createdAt)}`, `Created ${ago(t.createdAt)}`)}</span>
        <button className="bd-btn quiet danger" disabled={busy} onClick={() => onRemove(t)}>{L('Apagar', 'Delete')}</button>
        {kind === 'repeated' && <button className="bd-btn quiet" disabled={busy} onClick={stopRepeat}>{L('Parar de repetir', 'Stop repeating')}</button>}
        {kind === 'repeated' && routine && <button className="bd-btn soft" onClick={talk}>{L('Abrir a conversa', 'Open the conversation')}</button>}
        {(kind === 'own' || kind === 'repeated') && <button className="bd-btn ink" disabled={busy} onClick={finish}>{L('Concluir', 'Mark done')}</button>}
        {kind === 'done' && <button className="bd-btn ink" disabled={busy} onClick={reopen}>{L('Reabrir', 'Reopen')}</button>}
        {kind === 'todo' && <button className="bd-btn ink" disabled={busy} onClick={() => void go(async () => { const x = await words(); if (x) await onStart(x) }, L('Não consegui começar.', "I couldn't start it."))}>{L('Começar', 'Start')}</button>}
      </div>
    </aside>
  )
}
