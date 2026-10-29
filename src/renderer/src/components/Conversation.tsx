import { L } from '../../../shared/lang'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  agentById,
  conversationTitle,
  openDialog,
  decideApproval,
  decideMemory,
  describeSchedule,
  editSummary,
  ENGINES,
  forgetMemory,
  modelById,
  navigate,
  openDm,
  removeRoutine,
  retryRun,
  continueRun,
  ACCESS_REQUEST,
  countedTokens,
  sendMessage,
  stopRun,
  summarizeNow,
  useStore,
  SUMMARY_MAX_AFTER,
  SUMMARY_WINDOW,
  type Agent,
  type Approval,
  type Conversation,
  type ImageUpload,
  type Message,
  type Step,
  IMAGE_MIMES,
  MAX_IMAGES_PER_MESSAGE,
  isTeam
} from '../store'
import { AgentAvatar, Icon, MeAvatar, duration, time, tokens, usd } from './ui'
import { ArtifactCard, BrowserCard, ServiceCard, SidePanel } from './Panel'
import { when } from './Routines'
import { AgentProposal } from './Tuca'

export function ConversationView({ id }: { id: string }): ReactNode {
  const conv = useStore((s) => s.conversations.find((c) => c.id === id))
  const title = useStore((s) => (conv ? conversationTitle(s, conv) : ''))
  const members = useStore((s) => (conv ? conv.members.map((m) => agentById(s, m)).filter((a): a is Agent => !!a) : []))
  const messages = useStore((s) => s.messages.filter((m) => m.conversationId === id))
  const focus = useStore((s) => (s.view?.kind === 'conversation' && s.view.id === id ? s.view.message : undefined))
  const [showSummary, setShowSummary] = useState(false)

  if (!conv) return <div className="empty">{L('Conversa não encontrada.', 'Conversation not found.')}</div>
  const dmAgent = conv.kind === 'dm' ? members[0] : undefined

  return (
    <div className="split">
      <section className="conversation">
        <header className="topbar">
          <div className="topbar__title">
            {dmAgent ? <AgentAvatar agent={dmAgent} size={22} /> : <Icon name="hash" />}
            <h1>{title}</h1>
            {dmAgent && <span className="tag">{dmAgent.role}</span>}
            {conv.topic && <span className="topbar__topic">{conv.topic}</span>}
          </div>
          <div className="topbar__actions">
            {conv.kind === 'channel' && (
              <div className="stack" title={L('Agentes no canal', 'Agents in the channel')}>
                {members.map((a) => (
                  <button key={a.id} className="stack__item" onClick={() => navigate({ kind: 'agent', id: a.id })} title={a.name}>
                    <AgentAvatar agent={a} size={24} />
                  </button>
                ))}
                <span className="stack__count">{members.length} {L(`agente${members.length === 1 ? '' : 's'}`, `agent${members.length === 1 ? '' : 's'}`)}</span>
                <button className="icon-btn stack__add" title={L('Adicionar ou remover agentes', 'Add or remove agents')} onClick={() => openDialog({ kind: 'members', id })}>
                  <Icon name="plus" size={14} />
                </button>
              </div>
            )}
            <button className={`btn btn--ghost ${showSummary ? 'is-active' : ''}`} title={L('O que esta conversa já cobriu', 'What this conversation has covered')} onClick={() => setShowSummary(!showSummary)}>
              <Icon name="book" size={14} /> {L('Resumo', 'Summary')}
            </button>
            {dmAgent && (
              <button className="btn btn--ghost" onClick={() => navigate({ kind: 'agent', id: dmAgent.id })}>
                {L('Ver perfil', 'See profile')}
              </button>
            )}
          </div>
        </header>

        {showSummary && <SummaryPanel conv={conv} messages={messages} onClose={() => setShowSummary(false)} />}

        <MessageList messages={messages} conversationId={id} empty={conv.kind === 'channel' && members.length === 0} focus={focus} />
        <Composer conversationId={id} members={members} placeholder={dmAgent ? L(`Mensagem para ${dmAgent.name}`, `Message ${dmAgent.name}`) : L(`Mensagem em #${title}`, `Message #${title}`)} />
      </section>
      <SidePanel />
    </div>
  )
}

export function MessageList({ messages, conversationId, empty, focus }: { messages: Message[]; conversationId: string; empty?: boolean; focus?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Opened on a message (a routine's run, say): scroll to it and flash it once.
  useEffect(() => {
    const i = focus ? messages.findIndex((m) => m.id === focus) : -1
    const el = i >= 0 ? (ref.current?.children[i] as HTMLElement | undefined) : undefined
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    el.classList.add('is-flash')
    const t = setTimeout(() => el.classList.remove('is-flash'), 1800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, conversationId])

  useEffect(() => {
    stick.current = true
  }, [conversationId])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  })

  if (messages.length === 0 && empty) {
    return (
      <div className="messages messages--empty">
        <div className="empty">
          <Icon name="users" size={22} />
          <p>{L('Nenhum agente neste canal ainda.', 'No agents in this channel yet.')}</p>
          <p className="muted">{L('Quem está no canal lê a conversa e pode responder.', 'Whoever is in the channel reads the conversation and can reply.')}</p>
          <button className="btn btn--primary btn--sm" onClick={() => openDialog({ kind: 'members', id: conversationId })}>
            <Icon name="plus" size={14} /> {L('Adicionar agentes', 'Add agents')}
          </button>
        </div>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="messages messages--empty">
        <div className="empty">
          <Icon name="spark" size={22} />
          <p>{L('Nada por aqui ainda.', 'Nothing here yet.')}</p>
          <p className="muted">{L('Mencione um agente com @ ou escreva e deixe o router decidir quem responde.', 'Mention an agent with @, or just write and let the router decide who replies.')}</p>
        </div>
      </div>
    )
  }

  return (
    <div
      className="messages"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      }}
    >
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const grouped =
          !!prev &&
          prev.author.kind === m.author.kind &&
          (m.author.kind !== 'agent' || (prev.author.kind === 'agent' && prev.author.id === m.author.id)) &&
          m.at - prev.at < 5 * 60_000 &&
          !m.run &&
          m.author.kind !== 'system' &&
          m.author.kind !== 'routine'
        return <MessageRow key={m.id} message={m} grouped={grouped} />
      })}
    </div>
  )
}

function MessageRow({ message, grouped }: { message: Message; grouped: boolean }): ReactNode {
  const me = useStore((s) => s.me)
  const agent = useStore((s) => (message.author.kind === 'agent' ? agentById(s, message.author.id) : undefined))
  const approval = useStore((s) => (message.run?.approvalId ? s.approvals.find((a) => a.id === message.run!.approvalId) : undefined))
  const attached = useStore((s) => (message.author.kind === 'me' ? s.artifacts.filter((a) => a.messageId === message.id && a.agentId === '') : []))
  // The browser shows live on the agent's latest message that used it, unless it's open on the side.
  const liveBrowser = useStore(
    (s) =>
      !!message.run?.browser &&
      !(s.panel?.kind === 'browser' && s.panel.agentId === agent?.id) &&
      s.messages.findLast((m) => m.conversationId === message.conversationId && m.run?.browser && m.author.kind === 'agent' && m.author.id === agent?.id)?.id === message.id
  )

  if (message.author.kind === 'system') {
    return (
      <div className={`system-line ${message.run?.status === 'working' ? 'is-pending' : ''}`}>
        <Icon name="spark" size={13} />
        <Markdown>{message.text}</Markdown>
        <span className="muted">{time(message.at)}</span>
      </div>
    )
  }

  if (message.author.kind === 'routine') return <RoutineMessage message={message} />

  const name = agent ? agent.name : me.name
  return (
    <article className={`msg ${agent ? 'msg--agent' : 'msg--me'} ${grouped ? 'msg--grouped' : ''}`}>
      <div className="msg__gutter">
        {!grouped && (agent ? <AgentAvatar agent={agent} size={34} busy={message.run?.status === 'working'} /> : <MeAvatar initials={me.initials} size={34} />)}
      </div>
      <div className="msg__body">
        {!grouped && (
          <div className="msg__head">
            {agent ? (
              <button className="msg__author link" onClick={() => navigate({ kind: 'agent', id: agent.id })}>
                {name}
              </button>
            ) : (
              <span className="msg__author">{name}</span>
            )}
            {agent?.computer && agent.computerKind === 'mac' && (
              <span className="tag tag--warn" title={L('Os comandos deste agente rodam direto no seu computador', 'This agent’s commands run right on your computer')}>
                {L('no seu computador', 'on your computer')}
              </span>
            )}
            <span className="msg__time">{time(message.at)}</span>
          </div>
        )}
        {message.run && <RunSteps message={message} />}
        {message.text ? (
          <div className="md">
            <Markdown remarkPlugins={[remarkGfm]}>{highlightMentions(message.text)}</Markdown>
          </div>
        ) : null}
        {attached.length > 0 && (
          <div className="artifacts artifacts--mine">
            {attached.map((a) => (
              <ArtifactCard key={a.id} id={a.id} />
            ))}
          </div>
        )}
        {message.run?.question && <QuestionCard question={message.run.question} answered={message.run.status !== 'waiting_input'} />}
        {approval && <ApprovalCard approval={approval} />}
        {message.run?.agentDraft && <AgentProposal message={message} />}
        {message.run?.memoryIds?.map((mid) => <MemoryChip key={mid} id={mid} />)}
        {message.run?.routineIds?.map((rid) => <RoutineChip key={rid} id={rid} />)}
        {message.run?.artifactIds && (
          <div className="artifacts">
            {message.run.artifactIds.map((aid) => (
              <ArtifactCard key={aid} id={aid} />
            ))}
          </div>
        )}
        {agent && message.run?.services?.map((name) => <ServiceCard key={name} agentId={agent.id} name={name} />)}
        {agent && message.run?.browser && <BrowserCard agentId={agent.id} big={liveBrowser} />}
        {message.run?.status === 'stopped' && <div className="note">{L('Interrompido por você.', 'Stopped by you.')}</div>}
        {message.run?.status === 'interrupted' && <div className="note">{L('Interrompido: o app fechou no meio da resposta.', 'Interrupted: the app closed in the middle of the reply.')}</div>}
        {message.run?.error && <div className="note note--error">{message.run.error}</div>}
        {message.run?.status === 'paused' && (
          <>
            <div className="note">{L(`Pausei: cheguei no teto desta resposta (${tokens(message.run.budget ?? 0)} tokens). Continuo de onde parei?`, `Paused: I hit this reply’s ceiling (${tokens(message.run.budget ?? 0)} tokens). Shall I pick up where I left off?`)}</div>
            <button className="btn btn--xs retry" onClick={() => continueRun(message.id)}>
              {L('Continuar', 'Continue')}
            </button>
          </>
        )}
        {message.run && ['failed', 'stopped', 'interrupted', 'limit_reached'].includes(message.run.status) && (
          <button className="btn btn--xs retry" onClick={() => retryRun(message.id)}>
            {L('Tentar de novo', 'Try again')}
          </button>
        )}
        {message.run?.receipt && <ReceiptLine receipt={message.run.receipt} />}
      </div>
    </article>
  )
}

// What a routine asked, posted at its time; the agent's reply comes next.
function RoutineMessage({ message }: { message: Message }): ReactNode {
  const exists = useStore((s) => s.routines.some((r) => message.author.kind === 'routine' && r.id === message.author.id))
  const info = message.routine
  return (
    <article className="msg msg--routine">
      <div className="msg__gutter">
        <span className="avatar avatar--routine" style={{ width: 34, height: 34 }}>
          <Icon name="clock" size={17} />
        </span>
      </div>
      <div className="msg__body">
        <div className="msg__head">
          {exists ? (
            <button className="msg__author link" onClick={() => navigate({ kind: 'routines' })}>
              {info?.name ?? L('Rotina', 'Routine')}
            </button>
          ) : (
            <span className="msg__author">{info?.name ?? L('Rotina', 'Routine')}</span>
          )}
          <span className="tag">{L('rotina', 'routine')}</span>
          {info?.late && <span className="tag tag--warn">{L('atrasada · era', 'late · was due')} {time(info.scheduledAt)}</span>}
          <span className="msg__time">{time(message.at)}</span>
        </div>
        {info?.event && (
          <div className="note routine-event">
            <Icon name="zap" size={12} /> {info.event.source}: <strong>{info.event.title}</strong>
          </div>
        )}
        <div className="md">
          <Markdown remarkPlugins={[remarkGfm]}>{highlightMentions(message.text)}</Markdown>
        </div>
      </div>
    </article>
  )
}

function SummaryPanel({ conv, messages, onClose }: { conv: Conversation; messages: Message[]; onClose: () => void }): ReactNode {
  const [text, setText] = useState(conv.summary ?? '')
  const [asked, setAsked] = useState<number | null>(null)
  useEffect(() => setText(conv.summary ?? ''), [conv.summary, conv.summaryAt])
  useEffect(() => {
    if (asked === null) return
    const t = setTimeout(() => setAsked(null), 120_000) // give up waiting; the core logs failures
    return () => clearTimeout(t)
  }, [asked])
  const busy = asked !== null && (conv.summaryAt ?? 0) < asked
  const since = messages.filter((m) => m.author.kind !== 'system' && m.text.trim() && m.at > (conv.summaryUntil ?? 0)).length
  const changed = text.trim() !== (conv.summary ?? '').trim()

  return (
    <div className="summary">
      <div className="summary__head">
        <strong>{L('Resumo da conversa', 'Conversation summary')}</strong>
        <span className="muted small">{conv.summaryAt ? L(`atualizado ${time(conv.summaryAt)}`, `updated ${time(conv.summaryAt)}`) : L('ainda não há', 'none yet')}</span>
        <span className="grow" />
        <button
          className="btn btn--sm"
          disabled={busy || since <= SUMMARY_WINDOW}
          title={since <= SUMMARY_WINDOW ? L(`As últimas ${SUMMARY_WINDOW} mensagens sempre vão inteiras; ainda não há o que resumir.`, `The last ${SUMMARY_WINDOW} messages always go in full; nothing to summarize yet.`) : undefined}
          onClick={() => {
            setAsked(Date.now())
            summarizeNow(conv.id)
          }}
        >
          {busy ? L('Resumindo…', 'Summarizing…') : L('Resumir agora', 'Summarize now')}
        </button>
        <button className="icon-btn" title={L('Fechar', 'Close')} onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {conv.summary !== undefined || changed ? (
        <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="muted small">
          {L(`Quando passar de ${SUMMARY_MAX_AFTER} mensagens, o que sair da janela vira um resumo aqui, e os agentes recebem o resumo mais as mensagens recentes.`, `Past ${SUMMARY_MAX_AFTER} messages, what leaves the window becomes a summary here, and agents get the summary plus the recent messages.`)}
        </p>
      )}
      <div className="row row--between">
        <span className="hint">
          {L(`Os agentes recebem ${conv.summary ? 'este resumo e ' : ''}as ${since} mensagens ${conv.summary ? 'desde ele' : 'da conversa'}.`, `Agents get ${conv.summary ? 'this summary and ' : ''}the ${since} messages ${conv.summary ? 'since it' : 'of the conversation'}.`)}
        </span>
        {changed && (
          <button className="btn btn--sm btn--primary" onClick={() => editSummary(conv.id, text)}>
            {L('Salvar resumo', 'Save summary')}
          </button>
        )}
      </div>
    </div>
  )
}

// A memory saved or proposed in this reply, with what I can do about it.
function MemoryChip({ id }: { id: string }): ReactNode {
  const memory = useStore((s) => s.memories.find((m) => m.id === id))
  if (!memory) return null // discarded or deleted
  const label = { active: L('Guardou', 'Kept'), pending: L('Quer guardar', 'Wants to keep'), archived: L('Guardou (depois atualizada)', 'Kept (later updated)'), forgotten: L('Esquecida', 'Forgotten') }[memory.state]
  return (
    <div className={`memory-chip memory-chip--${memory.state}`}>
      <Icon name="book" size={13} />
      <span className="memory-chip__label">{label}:</span>
      <span className="memory-chip__text">{memory.text}</span>
      {memory.scope !== 'me' && <span className="tag">{L('nota dele', 'its own note')}</span>}
      {memory.state === 'active' && (
        <button className="link" onClick={() => forgetMemory(id)}>
          {L('Desfazer', 'Undo')}
        </button>
      )}
      {memory.state === 'pending' && (
        <>
          <button className="btn btn--xs btn--primary" onClick={() => decideMemory(id, true)}>
            {L('Guardar', 'Keep')}
          </button>
          <button className="btn btn--xs btn--ghost" onClick={() => decideMemory(id, false)}>
            {L('Descartar', 'Discard')}
          </button>
        </>
      )}
    </div>
  )
}

// A routine the agent scheduled in this reply.
function RoutineChip({ id }: { id: string }): ReactNode {
  const r = useStore((s) => s.routines.find((x) => x.id === id))
  if (!r) return null // deleted
  const state = r.enabled && r.nextAt ? L(`próxima ${when(r.nextAt)}`, `next ${when(r.nextAt)}`) : r.schedule.once && r.lastAt ? L('já rodou', 'already ran') : L('desligada', 'off')
  return (
    <div className="memory-chip routine-chip">
      <Icon name="clock" size={13} />
      <span className="memory-chip__label">{L('Agendou:', 'Scheduled:')}</span>
      <span className="memory-chip__text">{r.name}</span>
      <span className="muted small">
        {describeSchedule(r.schedule)} · {state}
      </span>
      <button className="link" onClick={() => navigate({ kind: 'routines' })}>
        {L('Ver', 'See')}
      </button>
      <button className="link" onClick={() => removeRoutine(id)}>
        {L('Desfazer', 'Undo')}
      </button>
    </div>
  )
}

function QuestionCard({ question, answered }: { question: string; answered: boolean }): ReactNode {
  return (
    <div className={`question ${answered ? 'is-answered' : ''}`}>
      <span className="question__label">{answered ? L('Perguntou', 'Asked') : L('Pergunta pra você', 'A question for you')}</span>
      <p>{question}</p>
      {!answered && <span className="hint">{L('Sua próxima mensagem aqui é a resposta.', 'Your next message here is the answer.')}</span>}
    </div>
  )
}

const highlightMentions = (text: string): string => text.replace(/(^|\s)@([a-z0-9_-]{2,32})/gi, '$1**@$2**')

// Now, every second while `on`: the clock of a reply at work.
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

// One quiet line: what the agent is doing now (and for how long), or how many
// steps it took. The steps themselves open on a click.
function RunSteps({ message }: { message: Message }): ReactNode {
  const run = message.run!
  const [open, setOpen] = useState(false)
  const working = run.status === 'working'
  const now = useNow(working)

  if (run.steps.length === 0 && !working) return null
  const total = run.steps.reduce((acc, st) => acc + (st.ms ?? 0), 0)
  const failed = run.steps.filter((st) => st.status === 'error').length
  const current = [...run.steps].reverse().find((st) => st.status === 'running')

  return (
    <div className={`steps ${open ? 'is-open' : ''} ${working ? 'is-working' : ''}`}>
      <button className="steps__toggle" onClick={() => setOpen(!open)}>
        {working ? (
          <span className="steps__pulse" />
        ) : (
          <span className="steps__chev">
            <Icon name="chevron" size={12} />
          </span>
        )}
        {working ? (
          <span className="shimmer">{current ? `${current.label}…` : L('Pensando…', 'Thinking…')}</span>
        ) : (
          <span>
            {run.steps.length} {L(`passo${run.steps.length === 1 ? '' : 's'}`, `step${run.steps.length === 1 ? '' : 's'}`)}
            {total > 0 && ` · ${duration(total)}`}
          </span>
        )}
        {failed > 0 && <span className="steps__failed">{failed} {L('com falha', 'failed')}</span>}
        {working && <span className="steps__elapsed">{duration(Math.max(0, now - message.at))}</span>}
        {working && (
          <span
            className="btn btn--xs btn--ghost steps__stop"
            role="button"
            onClick={(e) => {
              e.stopPropagation()
              stopRun(message.id)
            }}
          >
            <Icon name="stop" size={11} /> {L('Parar', 'Stop')}
          </span>
        )}
      </button>
      {open && (
        <ol className="steps__list">
          {run.steps.map((st) => (
            <StepRow key={st.id} step={st} />
          ))}
        </ol>
      )}
    </div>
  )
}

function StepRow({ step }: { step: Step }): ReactNode {
  return (
    <li className={`step step--${step.status}`}>
      <span className="step__icon">
        {step.status === 'running' ? <span className="spinner" /> : <Icon name={step.status === 'done' ? 'check' : 'x'} size={12} />}
      </span>
      <span className="step__label">{step.label}</span>
      {step.note ? <span className="step__note">{step.note}</span> : step.detail && <code className="step__detail">{step.detail}</code>}
      {step.ms !== undefined && <span className="step__ms">{duration(step.ms)}</span>}
    </li>
  )
}

function ReceiptLine({ receipt }: { receipt: NonNullable<NonNullable<Message['run']>['receipt']> }): ReactNode {
  const model = useStore((s) => modelById(s, receipt.model))
  const [open, setOpen] = useState(false)
  const total = countedTokens(receipt)
  return (
    <div className="receipt">
      <button className="receipt__line" onClick={() => setOpen(!open)} title={L('Ver recibo', 'See receipt')}>
        {model?.label ?? receipt.model} · {tokens(total)} tokens · {duration(receipt.ms)}
      </button>
      {open && (
        <dl className="receipt__table">
          <dt>{L('Entrada', 'Input')}</dt>
          <dd>{tokens(receipt.inputTokens - receipt.cacheReadTokens)}</dd>
          <dt title={L('Ler do cache custa cerca de um décimo: conta 10% no limite.', 'Reading from cache costs about a tenth: it counts 10% toward the limit.')}>{L('Do cache (conta 10%)', 'From cache (counts 10%)')}</dt>
          <dd>{tokens(receipt.cacheReadTokens)}</dd>
          <dt>{L('Saída', 'Output')}</dt>
          <dd>{tokens(receipt.outputTokens)}</dd>
          <dt>{L('Motor', 'Engine')}</dt>
          <dd>{model ? ENGINES[model.engine].label : '—'}</dd>
          {receipt.apiCostUsd !== undefined && (
            <>
              <dt title={L('O que esse uso custaria na API. Na assinatura, não é cobrado.', 'What this usage would cost on the API. On a subscription, you aren’t billed.')}>{L('Equivalente na API', 'API equivalent')}</dt>
              <dd>{usd(receipt.apiCostUsd)}</dd>
            </>
          )}
        </dl>
      )}
    </div>
  )
}

export function ApprovalCard({ approval, compact }: { approval: Approval; compact?: boolean }): ReactNode {
  const agent = useStore((s) => agentById(s, approval.agentId))
  const me = useStore((s) => s.me)
  const [refusing, setRefusing] = useState(false)
  const [reason, setReason] = useState('')
  const [hold, setHold] = useState(0)
  const timer = useRef<number | null>(null)

  const startHold = (): void => {
    const started = performance.now()
    const tick = (): void => {
      const p = Math.min(1, (performance.now() - started) / 1500)
      setHold(p)
      if (p >= 1) {
        timer.current = null
        decideApproval(approval.id, 'approved')
        return
      }
      timer.current = requestAnimationFrame(tick)
    }
    timer.current = requestAnimationFrame(tick)
  }
  const cancelHold = (): void => {
    if (timer.current) cancelAnimationFrame(timer.current)
    timer.current = null
    setHold(0)
  }

  const decided = approval.state !== 'pending'

  return (
    <div className={`approval approval--${approval.state} ${compact ? 'approval--compact' : ''}`}>
      <div className="approval__head">
        <span className="approval__badge">
          <Icon name="shield" size={13} />
          {approval.state === 'pending' ? L('Esperando você', 'Waiting for you') : approval.state === 'approved' ? L('Aprovado', 'Approved') : approval.state === 'refused' ? L('Recusado', 'Refused') : L('Expirado', 'Expired')}
        </span>
        {approval.highRisk && <span className="tag tag--danger">{L('alto risco', 'high risk')}</span>}
      </div>
      <div className="approval__title">
        {approval.tool === ACCESS_REQUEST ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('pede acesso ao', 'asks for access to')} <strong>{approval.connectorName}</strong>: {approval.args['nivel'] === 'read_write' ? L('ler e escrever', 'read and write') : L('ler', 'read')}
          </>
        ) : approval.tool === 'abrir_pr' ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('quer abrir uma', 'wants to open a')} <strong>pull request</strong> {L('em', 'in')} {String(approval.args['repo'])}
          </>
        ) : approval.connectorId === 'navegador' ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('quer clicar em', 'wants to click')} <strong>{String(approval.args['alvo'] || L('um ponto da tela', 'a spot on the screen'))}</strong> {L('em', 'on')} {String(approval.args['url']).replace(/^https?:\/\//, '').slice(0, 60)}
          </>
        ) : (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('quer usar', 'wants to use')} <strong>{approval.tool.replace(/_/g, ' ')}</strong> {L('no', 'in')} {approval.connectorName}
          </>
        )}
      </div>
      {approval.why && <p className="approval__why">{approval.why}</p>}
      <div className="approval__call">
        <code>
          {approval.connectorName} · {approval.tool}
        </code>
        <pre>{JSON.stringify(approval.args, null, 2)}</pre>
      </div>
      <p className="approval__bound">
        {L('A aprovação cobre só esta chamada, com estes valores. Se mudar qualquer coisa, o agente pede de novo.', 'The approval covers only this call, with these values. If anything changes, the agent asks again.')}
        {!decided && L(` Expira ${time(approval.expiresAt)}.`, ` Expires ${time(approval.expiresAt)}.`)}
      </p>

      {decided ? (
        <div className="approval__decided">
          {approval.state === 'expired' ? L('Expirou sem decisão', 'Expired without a decision') : L(`${approval.state === 'approved' ? 'Aprovado' : 'Recusado'} por ${me.name}`, `${approval.state === 'approved' ? 'Approved' : 'Refused'} by ${me.name}`)}
          {approval.decidedAt ? ` · ${time(approval.decidedAt)}` : ''}
          {approval.reason ? ` · “${approval.reason}”` : ''}
          {approval.outcome ? ` · ${approval.outcome}` : ''}
        </div>
      ) : refusing ? (
        <form
          className="approval__refuse"
          onSubmit={(e) => {
            e.preventDefault()
            decideApproval(approval.id, 'refused', reason.trim() || undefined)
          }}
        >
          <textarea
            autoFocus
            rows={2}
            value={reason}
            placeholder={L(`Por que não? ${agent?.name ?? 'O agente'} lê e ajusta o plano.`, `Why not? ${agent?.name ?? 'The agent'} reads it and adjusts the plan.`)}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="row">
            <button type="button" className="btn btn--ghost" onClick={() => setRefusing(false)}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button type="submit" className="btn btn--danger">
              {L('Recusar', 'Refuse')}
            </button>
          </div>
        </form>
      ) : (
        <div className="row">
          {approval.highRisk ? (
            <button
              className="btn btn--primary btn--hold"
              onPointerDown={startHold}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              style={{ ['--hold' as string]: `${hold * 100}%` }}
            >
              <span>{hold > 0 ? L('Segure…', 'Hold…') : L('Segure para aprovar', 'Hold to approve')}</span>
            </button>
          ) : (
            <>
              <button className="btn btn--primary" onClick={() => decideApproval(approval.id, 'approved')}>
                {L('Aprovar', 'Approve')}
              </button>
              {approval.tool !== ACCESS_REQUEST && approval.tool !== 'abrir_pr' && approval.connectorId !== 'navegador' && (
                <button className="btn" title={L(`Daqui pra frente ${agent?.name ?? 'o agente'} usa ${approval.tool} no ${approval.connectorName} sem pedir. Dá pra tirar na página dele.`, `From now on ${agent?.name ?? 'the agent'} uses ${approval.tool} in ${approval.connectorName} without asking. You can take it back on its page.`)} onClick={() => decideApproval(approval.id, 'approved', undefined, true)}>
                  {L('Aprovar e sempre permitir', 'Approve and always allow')}
                </button>
              )}
            </>
          )}
          <button className="btn" onClick={() => setRefusing(true)}>
            {L('Recusar', 'Refuse')}
          </button>
        </div>
      )}
    </div>
  )
}

// Images go to the models as they are when small; big ones are scaled down
// (longest side MAX_SIDE) and re-encoded, so any screenshot or photo fits.
const MAX_SIDE = 2000
const MAX_RAW = 3_700_000 // base64 under the models' 5 MB

type Attached = ImageUpload & { url: string }

const dataUrlOf = (blob: Blob): Promise<string> =>
  new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(blob)
  })

async function prepareImage(file: File): Promise<Attached | string> {
  if (!file.type.startsWith('image/')) return L(`${file.name} não é imagem.`, `${file.name} isn't an image.`)
  try {
    const src = await dataUrlOf(file) // the page's CSP takes data: images, not blob:
    const img = new Image()
    img.src = src
    await img.decode()
    const side = Math.max(img.naturalWidth, img.naturalHeight)
    let blob: Blob = file
    if (!IMAGE_MIMES.includes(file.type) || side > MAX_SIDE || file.size > MAX_RAW) {
      const k = Math.min(1, MAX_SIDE / side)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * k)
      canvas.height = Math.round(img.naturalHeight * k)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      const encode = (type: string, q?: number): Promise<Blob | null> => new Promise((ok) => canvas.toBlob(ok, type, q))
      blob = (file.type === 'image/png' && (await encode('image/png'))) || file
      if (blob === file || blob.size > MAX_RAW) blob = (await encode('image/jpeg', 0.88)) ?? file
    }
    if (blob.size > MAX_RAW) return L(`${file.name} é grande demais.`, `${file.name} is too big.`)
    const url = blob === file ? src : await dataUrlOf(blob)
    return { name: file.name || L('imagem', 'image'), mime: blob.type, data: url.slice(url.indexOf(',') + 1), url }
  } catch {
    return L(`Não consegui abrir ${file.name}.`, `Couldn't open ${file.name}.`)
  }
}

export function Composer({ conversationId, members, placeholder }: { conversationId: string; members: Agent[]; placeholder: string }): ReactNode {
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attached[]>([])
  const [note, setNote] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const allAgents = useStore((s) => s.agents.filter(isTeam))
  const isDm = useStore((s) => s.conversations.find((c) => c.id === conversationId)?.kind === 'dm')
  const working = useStore((s) => s.messages.filter((m) => m.conversationId === conversationId && m.author.kind === 'agent' && m.run?.status === 'working'))
  const asker = useStore((s) => {
    const q = s.messages.findLast((m) => m.conversationId === conversationId && m.run?.status === 'waiting_input')
    return q?.author.kind === 'agent' ? agentById(s, q.author.id)?.name : undefined
  })

  useEffect(() => {
    setText('')
    setImages([])
    setNote('')
    ref.current?.focus()
  }, [conversationId])

  const addFiles = async (files: File[]): Promise<void> => {
    if (!files.length) return
    const done = await Promise.all(files.map(prepareImage))
    const ok = done.filter((d): d is Attached => typeof d !== 'string')
    const errors = done.filter((d): d is string => typeof d === 'string')
    let over = false
    setImages((cur) => {
      over = cur.length + ok.length > MAX_IMAGES_PER_MESSAGE
      return [...cur, ...ok].slice(0, MAX_IMAGES_PER_MESSAGE)
    })
    setNote([...errors, over ? L(`Até ${MAX_IMAGES_PER_MESSAGE} imagens por mensagem.`, `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`) : ''].filter(Boolean).join(' '))
    ref.current?.focus()
  }

  // A file dropped anywhere in the window comes here (and never opens in place of the app).
  useEffect(() => {
    let depth = 0
    const files = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent): void => {
      if (!files(e)) return
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      if (files(e)) e.preventDefault()
    }
    const leave = (e: DragEvent): void => {
      if (files(e) && --depth <= 0) (depth = 0), setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      if (!files(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void addFiles([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  const options = mention
    ? members.filter((a) => a.handle.startsWith(mention.query.toLowerCase()) || a.name.toLowerCase().startsWith(mention.query.toLowerCase()))
    : []
  const outsiders = mention ? allAgents.filter((a) => !members.includes(a) && a.handle.startsWith(mention.query.toLowerCase())) : []

  const updateMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([a-z0-9_-]*)$/i.exec(before)
    if (m) {
      setMention({ query: m[2] ?? '', start: caret - (m[2]?.length ?? 0) - 1 })
      setActive(0)
    } else setMention(null)
  }

  const pick = (a: Agent): void => {
    if (!mention) return
    const caret = ref.current?.selectionStart ?? text.length
    const next = `${text.slice(0, mention.start)}@${a.handle} ${text.slice(caret)}`
    setText(next)
    setMention(null)
    requestAnimationFrame(() => {
      const pos = mention.start + a.handle.length + 2
      ref.current?.setSelectionRange(pos, pos)
      ref.current?.focus()
    })
  }

  const submit = (): void => {
    if (!text.trim() && images.length === 0) return
    sendMessage(
      conversationId,
      text,
      images.map(({ name, mime, data }) => ({ name, mime, data }))
    )
    setText('')
    setImages([])
    setNote('')
    setMention(null)
  }

  return (
    <div className="composer-wrap">
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay__card">
            <Icon name="image" size={28} />
            <strong>{L('Solte pra anexar', 'Drop to attach')}</strong>
            <span className="muted">{L('Os agentes veem a imagem junto com a mensagem.', 'Agents see the image along with the message.')}</span>
          </div>
        </div>
      )}
      {mention && (options.length > 0 || outsiders.length > 0) && (
        <div className="mention-menu" role="listbox">
          {options.map((a, i) => (
            <button
              key={a.id}
              className={`mention-menu__item ${i === active ? 'is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(a)
              }}
            >
              <AgentAvatar agent={a} size={20} />
              <strong>{a.name}</strong>
              <span className="muted">@{a.handle}</span>
              <span className="mention-menu__role">{a.role}</span>
            </button>
          ))}
          {outsiders.length > 0 && (
            <div className="mention-menu__hint">
              {outsiders.map((a) => a.name).join(', ')} {L(`não ${outsiders.length === 1 ? 'está' : 'estão'} neste canal.`, `${outsiders.length === 1 ? 'isn’t' : 'aren’t'} in this channel.`)}{' '}
              <button className="link" onMouseDown={(e) => (e.preventDefault(), openDm(outsiders[0]!.id))}>
                {L('Abrir DM', 'Open DM')}
              </button>
            </div>
          )}
        </div>
      )}
      <div className="composer">
        {images.length > 0 && (
          <div className="composer__images">
            {images.map((img, i) => (
              <div key={i} className="composer__image" title={img.name}>
                <img src={img.url} alt={img.name} />
                <button className="composer__image-x" title={L('Tirar', 'Remove')} onClick={() => setImages(images.filter((_, j) => j !== i))}>
                  <Icon name="x" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={asker ? L(`Responder a ${asker}`, `Reply to ${asker}`) : placeholder}
          onChange={(e) => {
            setText(e.target.value)
            updateMention(e.target.value, e.target.selectionStart)
          }}
          onPaste={(e) => {
            const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (!files.length) return
            e.preventDefault()
            void addFiles(files)
          }}
          onKeyDown={(e) => {
            if (mention && options.length > 0) {
              if (e.key === 'ArrowDown') return (e.preventDefault(), setActive((active + 1) % options.length))
              if (e.key === 'ArrowUp') return (e.preventDefault(), setActive((active - 1 + options.length) % options.length))
              if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), pick(options[active]!))
              if (e.key === 'Escape') return setMention(null)
            }
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer__bar">
          <button className="icon-btn" title={L('Anexar imagem (ou arraste e solte, ou cole)', 'Attach an image (or drag and drop, or paste)')} onClick={() => picker.current?.click()}>
            <Icon name="image" size={15} />
          </button>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <span className={`composer__hint ${note ? 'composer__hint--warn' : ''}`}>
            {note || (members[0]?.kind === 'tuca' ? L('Nada é criado sem você', 'Nothing is created without you') : isDm ? L('O agente sempre responde na DM', 'The agent always replies in a DM') : L('@ chama um agente · sem menção, o router decide', '@ calls an agent · without a mention, the router decides'))}
          </span>
          {working.length > 0 ? (
            <button className="btn btn--sm" onClick={() => working.forEach((m) => stopRun(m.id))}>
              <Icon name="stop" size={12} /> {L('Parar', 'Stop')}
            </button>
          ) : null}
          <button className="btn btn--primary btn--sm btn--icon" disabled={!text.trim() && images.length === 0} onClick={submit} title={L('Enviar (Enter)', 'Send (Enter)')}>
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
