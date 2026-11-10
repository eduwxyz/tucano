// The drawer above the message field: what is running in this conversation right now, and what I
// wrote that is still waiting its turn.
//
// Both were invisible. A channel where three agents answer at once is a wall of steps with no way to
// tell which reply is which prompt, and a queued prompt only said it was waiting in the line under
// the reply it followed. Here each one is a row with the prompt it belongs to: click it to go where
// that reply is now, or stop that one reply without touching the others.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { Message } from '../../../shared/types'
import { agentById, jumpToMessage, promptOf, queuedRuns, stopRun, useStore, workingRuns } from '../store'
import { AgentAvatar, Icon, duration } from './ui'

// A row has one line: Markdown's marks out, a link keeps its words, the whitespace collapsed.
export const oneLine = (text: string): string =>
  text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // an image, which a line can't show
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // a heading's hashes
    .replace(/[*_`~>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

// Whether the drawer shows its rows. A person's choice holds for what it was made about: when
// something new turns up (a prompt queued, another reply starting) the rule below opens it again.
export const drawerOpen = (hasContent: boolean, auto: boolean, choice: { key: string; open: boolean } | null, key: string): boolean =>
  !hasContent ? false : choice?.key === key ? choice.open : auto

// Counts up while something is running, so the durations don't need a redraw from elsewhere.
function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

function LiveRow({ run, now }: { run: Message; now: number }): ReactNode {
  const agent = useStore((s) => (run.author.kind === 'agent' ? agentById(s, run.author.id) : undefined))
  const prompt = useStore((s) => promptOf(s, run.conversationId, run))
  const said = useMemo(() => oneLine(prompt?.text ?? ''), [prompt?.text])
  return (
    <div className="drawer__row">
      <button className="drawer__go" onClick={() => jumpToMessage(run.id)} title={L('Ir para onde essa resposta está agora', 'Go to where this reply is now')}>
        <AgentAvatar agent={agent ?? { name: '?', color: 'graphite' }} size={18} busy />
        <span className="drawer__name">{agent?.name ?? L('Agente', 'Agent')}</span>
        <span className="drawer__prompt">{said || L('(sem texto)', '(no text)')}</span>
        <span className="drawer__meta">{duration(Math.max(0, now - run.at))}</span>
      </button>
      <button className="drawer__stop" onClick={() => stopRun(run.id)} title={L('Parar essa resposta, e só ela', 'Stop this reply, and only this one')} aria-label={L('Parar essa resposta', 'Stop this reply')}>
        <Icon name="stop" size={11} />
      </button>
    </div>
  )
}

function QueuedRow({ message }: { message: Message }): ReactNode {
  const said = useMemo(() => oneLine(message.text), [message.text])
  return (
    <button className="drawer__go drawer__go--queued" onClick={() => jumpToMessage(message.id)} title={L('Ir para o prompt que espera', 'Go to the prompt that is waiting')}>
      <Icon name="clock" size={13} />
      <span className="drawer__prompt">{said || L('(sem texto)', '(no text)')}</span>
      <span className="drawer__meta">{L('esperando a vez', 'waiting its turn')}</span>
    </button>
  )
}

// `threadId`: in a thread, that thread's runs and prompts, not the conversation's.
export function SessionDrawer({ conversationId, threadId }: { conversationId: string; threadId?: string }): ReactNode {
  const runs = useStore((s) => workingRuns(s, conversationId, threadId))
  const queued = useStore((s) => queuedRuns(s, conversationId, threadId))
  const now = useTick(runs.length > 0)
  // What the contents are, in one string: a person's open/closed choice is kept for it and dropped
  // when it changes, so a prompt joining the queue opens the drawer again.
  const [choice, setChoice] = useState<{ key: string; open: boolean } | null>(null)
  const key = `${runs.length}/${queued.length}`
  const hasContent = runs.length > 0 || queued.length > 0
  const auto = queued.length > 0 || runs.length > 1
  const open = drawerOpen(hasContent, auto, choice, key)
  if (!hasContent) return null

  const live = runs.length === 1 ? L('1 resposta ao vivo', '1 reply live') : L(`${runs.length} respostas ao vivo`, `${runs.length} replies live`)
  const waiting = queued.length === 1 ? L('1 na fila', '1 queued') : L(`${queued.length} na fila`, `${queued.length} queued`)

  return (
    <div className={`drawer ${open ? 'is-open' : 'is-closed'}`}>
      <button className="drawer__head" onClick={() => setChoice({ key, open: !open })} aria-expanded={open}>
        {runs.length > 0 ? <span className="steps__pulse" /> : <Icon name="clock" size={12} />}
        <span className="drawer__title">
          {runs.length > 0 ? live : ''}
          {runs.length > 0 && queued.length > 0 ? ' · ' : ''}
          {queued.length > 0 ? waiting : ''}
        </span>
        <span className="drawer__more">{open ? L('Fechar', 'Close') : L('Ver', 'Show')}</span>
        <span className={`drawer__caret ${open ? 'is-open' : ''}`}>
          <Icon name="caret" size={12} />
        </span>
      </button>
      {open && (
        <div className="drawer__body">
          {runs.map((run) => (
            <LiveRow key={run.id} run={run} now={now} />
          ))}
          {queued.length > 0 && (
            <div className="drawer__group">
              <span className="drawer__label">{L('Na fila', 'Queued')}</span>
              {queued.map((m) => (
                <QueuedRow key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
