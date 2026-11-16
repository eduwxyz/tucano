import { memo, useMemo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L, locale } from '../../../shared/lang'
import { saidAt, type Agent, type Delegation, type Message } from '../../../shared/types'
import { agentById, isMine, openThread, useStore, type State } from '../store'
import { safeUrl } from '../links'
import { AgentAvatar, Icon, MeAvatar, ago, time } from './ui'
import { localLinkFor } from './LocalLink'

// How a request stands, in the words people read ("under way", "done"): the line under a request and the chip on its row.
export function requestState(d: Delegation | undefined): { tone: string; text: string } | null {
  if (!d) return null
  if (d.state === 'open') return d.asking ? { tone: 'is-warn', text: L('esperando uma resposta', 'waiting on an answer') } : { tone: 'is-live', text: L('em andamento', 'under way') }
  if (d.state === 'done') return { tone: 'is-done', text: L('terminado', 'done') }
  if (d.state === 'cancelled') return { tone: '', text: L('cancelado', 'cancelled') }
  return { tone: 'is-warn', text: L('não terminou', 'did not finish') }
}

// In a DM, a request another agent made to this one reads as a folded line where it came in the conversation,
// not as that agent talking here. Anything else (an ordinary message, or any message outside a DM): false.
export function isRequestRow(s: State, message: Message): boolean {
  const at = message.run?.delegation
  if (!at || at.rootId !== message.id || message.author.kind !== 'agent') return false
  const conv = s.conversations.find((c) => c.id === message.conversationId)
  return conv?.kind === 'dm' && conv.members[0] !== message.author.id
}

const clock = (at: number): string => new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const DONE_WHEN = /\n\n\*\*(Pronto quando|Done when):\*\* [^\n]*/
const LEAD = /^@\S+?, (um pedido|a request):\s*/
const DUE = /\n\n\*\*(Prazo|By):\*\* [^\n]*\s*$/

const Face = ({ agent, size }: { agent: Agent | undefined; size: number }): ReactNode => (agent ? <AgentAvatar agent={agent} size={size} still /> : <MeAvatar initials="A" size={size} />)

// A request as one folded line: who asked whom, how it stands, the start of what was asked. Open, the whole of it
// and a way to the thread where it is answered. `replies`: that thread's messages.
export const RequestRow = memo(function RequestRow({ message, replies }: { message: Message; replies: Message[] }): ReactNode {
  const at = message.run?.delegation
  const d = useStore((s) => (at ? s.delegations.find((x) => x.id === at.id) : undefined))
  const asker = useStore((s) => (message.author.kind === 'agent' ? agentById(s, message.author.id) : undefined))
  const asked = useStore((s) => (at ? agentById(s, at.to) : undefined))
  const you = useStore((s) => s.you)
  const threadOpen = useStore((s) => s.panel?.kind === 'thread' && s.panel.id === message.id)
  const seen = useStore((s) => s.threadSeen[message.id] ?? 0)
  const [open, setOpen] = useState(false)
  const links = useMemo(() => ({ a: localLinkFor(message.id) }), [message.id])

  // The same count the thread link under a message makes: replies that ended, from others, after I last had the thread open.
  const done = replies.filter((m) => m.author.kind !== 'system' && m.run?.status !== 'working')
  const fresh = threadOpen ? 0 : done.filter((m) => !isMine({ you }, m.author) && saidAt(m) > seen).length

  const askerName = asker?.name ?? L('Agente', 'Agent')
  const askedName = asked?.name ?? L('Agente', 'Agent')
  const state = requestState(d)
  const due = d?.dueAt
  // The deadline has its own place on the row, so the line that repeats it leaves the text.
  const body = useMemo(() => {
    const clean = message.text.replace(LEAD, '').replace(DONE_WHEN, '')
    const text = (due ? clean.replace(DUE, '') : clean).trim()
    return text || message.text
  }, [message.text, due])
  const summary = body.replace(/^\s*[-*•]\s+/gm, '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()

  // A request still going shows its deadline; one that ended, how long ago.
  const when = d && d.state !== 'open' ? ago(d.endedAt ?? message.at) : due ? L(`prazo ${clock(due)}`, `due ${clock(due)}`) : ago(message.at)
  const label = done.length === 0 ? L('Abrir a thread', 'Open the thread') : done.length === 1 ? L('Ver a resposta', 'See the reply') : L(`Ver as ${done.length} respostas`, `See the ${done.length} replies`)
  const back = asker ? L(`A resposta volta pra ${askerName}`, `The answer goes back to ${askerName}`) : L('A resposta volta pra quem pediu', 'The answer goes back to whoever asked')

  return (
    <div className={`request-row ${open ? 'is-open' : ''}`} data-id={message.id}>
      <button className="request-row__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="request-row__faces" aria-hidden="true">
          <Face agent={asker} size={20} />
          <span className="request-row__arrow">
            <Icon name="chevron" size={11} />
          </span>
          <Face agent={asked} size={20} />
        </span>
        <span className="request-row__main">
          <span className="request-row__who">
            <b>{L(`${askerName} pediu a ${askedName}`, `${askerName} asked ${askedName}`)}</b>
            <span className="msg__time">{time(saidAt(message))}</span>
            {state && (
              <span className={`request-note__state ${state.tone}`}>
                <i />
                {state.text}
              </span>
            )}
          </span>
          <span className="request-row__sum">{summary}</span>
        </span>
        <span className="request-row__side">
          {fresh > 0 && <span className="request-row__new">{fresh === 1 ? L('1 nova', '1 new') : L(`${fresh} novas`, `${fresh} new`)}</span>}
          <span className="request-row__when">{when}</span>
          <span className="request-row__chev" aria-hidden="true">
            <Icon name="chevron" size={14} />
          </span>
        </span>
      </button>
      {open && (
        <div className="request-row__body">
          <div className="request-row__text md">
            <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={links}>
              {body}
            </Markdown>
          </div>
          <div className="request-row__acts">
            <button className="btn btn--primary btn--sm" onClick={() => openThread(at?.rootId ?? message.id)}>
              {label}
            </button>
            <span className="request-row__hint">{due ? `${back} · ${L(`prazo ${clock(due)}`, `due ${clock(due)}`)}` : back}</span>
          </div>
        </div>
      )}
    </div>
  )
})
