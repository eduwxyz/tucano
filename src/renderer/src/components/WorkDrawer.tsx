import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { Message } from '../../../shared/types'
import { allWorkingIds, messagesIn, stopRun, useStore } from '../store'
import { Icon, duration } from './ui'

// What the drawer keeps about one conversation while the app is open: whether it is open, and the
// replies that ended here. Those stay as rows, marked with how they ended, until someone takes them
// off the list. Per conversation, so each DM and channel keeps its own and coming back to one finds
// it as it was left: none of it is shared across the rest of Tucano.
interface DrawerMemory {
  open?: boolean
  done: string[]
  working?: string // the replies at work when it was last drawn, so one that ends while you're elsewhere still counts
}
const drawerMemory = new Map<string, DrawerMemory>()
const drawerFor = (conversationId: string): DrawerMemory => {
  const had = drawerMemory.get(conversationId)
  if (had) return had
  const made: DrawerMemory = { done: [] }
  drawerMemory.set(conversationId, made)
  return made
}
// A reply that ended, as the drawer shows it: how it ended, in a glyph, a word and a tone.
const endedAs = (status: string): { icon: 'check' | 'x' | 'pause'; tone: 'ok' | 'bad' | 'off'; said: string } =>
  status === 'done'
    ? { icon: 'check', tone: 'ok', said: L('Concluída', 'Done') }
    : status === 'failed' || status === 'limit_reached'
      ? { icon: 'x', tone: 'bad', said: L('Falhou', 'Failed') }
      : { icon: 'pause', tone: 'off', said: L('Interrompida', 'Stopped') }
// What counts as ended: a reply waiting on a person (a question, an approval) is still in flight.
const ENDED = ['done', 'stopped', 'interrupted', 'failed', 'limit_reached', 'paused']

// Counts up while something is running, so each row's duration moves without a redraw from elsewhere
// (the frame the drawer wore when it first shipped, in #282).
function useTick(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

// The work this conversation is carrying, attached above the field: the replies running right now,
// each with the prompt that started it, the thread it answers in and a way to stop it, and the replies
// that already ended here — kept, marked with how they ended, so they can still be jumped to until
// their row is taken off. A reply inside one of this conversation's threads counts as work here too:
// its thread button opens that thread on it, and a reply that starts one opens its own. It opens by
// itself when it gains something to show — a second reply running at once — and can be closed; with
// nothing in it, it isn't there at all. Each conversation has its own.
export function WorkDrawer({
  conversationId,
  onJump,
  onThread
}: {
  conversationId: string
  onJump?: (messageId: string, threadId?: string) => void
  onThread?: (rootId: string) => void
}): ReactNode {
  // Ids, not the messages: a step streaming into one reply shouldn't redraw the list around it.
  const ids = useStore((s) => allWorkingIds(s, conversationId))
  const messages = useStore((s) => messagesIn(s, conversationId))
  const remember = drawerFor(conversationId)
  const running = messages.filter((m) => ids.includes(m.id))
  const busy = running.length > 1
  const [open, setOpen] = useState<boolean>(remember.open ?? busy)
  const [ended, setEnded] = useState<string[]>(remember.done)
  const now = useTick(running.length > 0)
  const oneLine = (text: string, max: number): string => {
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > max ? `${flat.slice(0, max)}…` : flat
  }
  // Which thread a row belongs to: the message that started it, in its own words. Nothing outside
  // threads has one, and those rows open a thread of their own.
  const threadRoot = (m: Message): Message | undefined => (m.threadId ? messages.find((x) => x.id === m.threadId) : undefined)
  const threadOf = (m: Message): string => m.threadId ?? m.id
  // The thread button's tooltip says which thread it opens, in that thread's own words.
  const into = (m: Message): string => {
    const root = threadRoot(m)
    if (!root) return L('Abrir a thread desta resposta', 'Open this reply’s thread')
    return L(`Abrir a thread: ${oneLine(root.text, 60) || 'sem texto'}`, `Open the thread: ${oneLine(root.text, 60) || 'no text'}`)
  }
  // What it says about a reply: the prompt it answers, not its own words.
  const asked = (m: Message): string => {
    const from = m.run?.replyTo ?? m.run?.routineAsk
    const mine = from ? messages.find((x) => x.id === from) : undefined
    return oneLine(mine?.text ?? m.run?.work ?? '', 90) || L('Uma resposta', 'A reply')
  }
  const paint = (next: boolean): void => {
    remember.open = next
    setOpen(next)
  }
  const keep = (list: string[]): void => {
    remember.done = list
    setEnded(list)
  }
  const was = useRef(busy)
  useEffect(() => {
    if (busy && !was.current) paint(true) // it just got something to show
    was.current = busy
  }, [busy])
  // A reply that leaves the working list here has ended: it stays as a row of its own, so it can
  // still be jumped to, and only the trash glyph in that row takes it off.
  const working = ids.join(',')
  const watched = useRef(remember.working ?? working)
  useEffect(() => {
    const before = watched.current ? watched.current.split(',') : []
    const nowIds = working ? working.split(',') : []
    watched.current = working
    remember.working = working
    const over = before.filter((id) => !nowIds.includes(id) && !remember.done.includes(id))
    if (over.length) keep([...remember.done, ...over])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working])
  const finished = ended.map((id) => messages.find((m) => m.id === id)).filter((m): m is Message => !!m?.run && ENDED.includes(m.run.status))
  if (!running.length && !finished.length) return null
  const counts = [
    running.length > 0 ? L(`${running.length} respondendo`, `${running.length} replying`) : '',
    finished.length > 0 ? L(`${finished.length} terminada${finished.length === 1 ? '' : 's'}`, `${finished.length} finished`) : ''
  ]
    .filter((part) => part !== '')
    .join(' · ')
  return (
    <div className={`work-drawer ${open ? 'is-open' : ''}`}>
      <button className="work-drawer__head" onClick={() => paint(!open)} aria-expanded={open}>
        <Icon name="layers" size={13} />
        <span className="work-drawer__count">{counts}</span>
        <span className="work-drawer__more">{open ? L('Fechar', 'Close') : L('Ver', 'Show')}</span>
        <span className={`work-drawer__caret ${open ? 'is-open' : ''}`}>
          <Icon name="caret" size={12} />
        </span>
      </button>
      {open && (
        <div className="work-drawer__list">
          {running.map((m) => (
            <div className="work-row" key={m.id}>
              <button className="work-row__go" onClick={() => onJump?.(m.id, m.threadId)} title={L('Ir para esta resposta', 'Go to this reply')}>
                <span className="work-row__dot" aria-hidden />
                <span className="work-row__text">{asked(m)}</span>
              </button>
              <span className="work-row__meta">{duration(Math.max(0, now - m.at))}</span>
              <button
                className="icon-btn icon-btn--sm work-row__thread-btn"
                title={into(m)}
                aria-label={L('Abrir a thread desta resposta', 'Open this reply’s thread')}
                onClick={() => onThread?.(threadOf(m))}
              >
                <Icon name="thread" size={12} />
              </button>
              <button
                className="icon-btn icon-btn--sm work-row__stop"
                title={L('Parar esta resposta', 'Stop this reply')}
                aria-label={L('Parar esta resposta', 'Stop this reply')}
                onClick={() => stopRun(m.id)}
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          ))}
          {finished.length > 0 && (
            <>
              <div className="work-drawer__group">{L('Terminadas', 'Finished')}</div>
              {finished.map((m) => {
                const how = endedAs(m.run?.status ?? 'done')
                return (
                  <div className="work-row work-row--done" key={m.id}>
                    <button className="work-row__go" onClick={() => onJump?.(m.id, m.threadId)} title={L('Ir para esta resposta', 'Go to this reply')}>
                      <span className={`work-row__state work-row__state--${how.tone}`} title={how.said}>
                        <Icon name={how.icon} size={11} />
                      </span>
                      <span className="work-row__text">{asked(m)}</span>
                    </button>
                    <span className="work-row__meta">{how.said}</span>
                    <button
                      className="icon-btn icon-btn--sm work-row__thread-btn"
                      title={into(m)}
                      aria-label={L('Abrir a thread desta resposta', 'Open this reply’s thread')}
                      onClick={() => onThread?.(threadOf(m))}
                    >
                      <Icon name="thread" size={12} />
                    </button>
                    <button
                      className="icon-btn icon-btn--sm work-row__remove"
                      title={L('Tirar da lista', 'Remove from the list')}
                      aria-label={L('Tirar da lista', 'Remove from the list')}
                      onClick={() => keep(remember.done.filter((x) => x !== m.id))}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </div>
                )
              })}
            </>
          )}
        </div>
      )}
    </div>
  )
}
