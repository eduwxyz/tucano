import { L, lang, locale } from '../../../shared/lang'
import { CODE_SPANS } from '../../../shared/types'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Markdown, { defaultUrlTransform } from 'react-markdown'
import { LOCAL_LINK, remarkLocalPaths } from '../../../shared/path-text'
import { localLinkFor } from './LocalLink'
import remarkGfm from 'remark-gfm'
import { KeepInWiki, WikiChip, WikiLink, wikiLinks } from './Wiki'
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
  openTuca,
  removeRoutine,
  retryRun,
  continueRun,
  ACCESS_REQUEST,
  countedTokens,
  sendMessage,
  setTab,
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
  isTeam,
  cancelTranscribe,
  transcribe,
  voiceStatus
} from '../store'
import { AgentAvatar, Icon, MeAvatar, duration, time, tokens, usd, useJustEnded } from './ui'
import { canRecord, NoSound, record, type Recording } from '../voice'
import { useVoice, VoicePopover } from './VoiceSetup'
import { ArtifactCard, BrowserCard, ServiceCard, SidePanel } from './Panel'
import { when } from './Routines'
import { AgentProposal } from './Tuca'
import { FoldToggle } from './Fold'

// Something exact a person may want to check (the raw error, a tool's arguments), folded until asked.
export function Details({ label, initiallyOpen = false, children }: { label: string; initiallyOpen?: boolean; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(initiallyOpen)
  return (
    <div className="note">
      <FoldToggle open={open} onToggle={() => setOpen(!open)}>
        {label}
      </FoldToggle>
      {open && children}
    </div>
  )
}

// A tool's name as words: "create_issue" → "create issue", "getPullRequest" → "get pull request".
export const toolWords = (name: string): string =>
  name
    .replace(/^mcp__[^_]+__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .trim()
    .toLowerCase()

// An approval's arguments a person can read at a glance: the plain values, named in words.
// Nested ones stay in the exact details.
function argSummary(args: Record<string, unknown>): { shown: [string, string][]; more: boolean } {
  const plain = (v: unknown): string | undefined =>
    typeof v === 'string' ? (v.length > 160 ? `${v.slice(0, 160)}…` : v) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number') ? v.join(', ') : undefined
  const all = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '')
  const shown = all
    .map(([k, v]): [string, string | undefined] => [toolWords(k), plain(v)])
    .filter((e): e is [string, string] => !!e[1]?.trim())
    .slice(0, 5)
  // What the glance leaves out (a long text cut, a nested value, a sixth field) is said, not hidden.
  return { shown, more: shown.length < all.length || all.some(([, v]) => typeof v === 'string' && v.length > 160) }
}

// "Vale até as 14:30." / "Good until 2:30 PM.", with the day when it isn't today.
function until(at: number): string {
  const d = new Date(at)
  const hm = d.toLocaleTimeString(locale(), lang() === 'en' ? { hour: 'numeric', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return L(`Vale até as ${hm}.`, `Good until ${hm}.`)
  const day = d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }).replace('.', '')
  return L(`Vale até ${day}, às ${hm}.`, `Good until ${day}, ${hm}.`)
}

export function ConversationView({ id }: { id: string }): ReactNode {
  const conv = useStore((s) => s.conversations.find((c) => c.id === id))
  const title = useStore((s) => (conv ? conversationTitle(s, conv) : ''))
  // An archived agent stays in the channel for when it comes back, but it isn't in
  // the room: out of the stack, the count and the @ list. A DM still shows whose it is.
  const members = useStore((s) => {
    if (!conv) return []
    const all = conv.members.map((m) => agentById(s, m)).filter((a): a is Agent => !!a)
    return conv.kind === 'dm' ? all : all.filter(isTeam)
  })
  const messages = useStore((s) => s.messages.filter((m) => m.conversationId === id))
  const focus = useStore((s) => (s.view?.kind === 'conversation' && s.view.id === id ? s.view.message : undefined))
  const [showSummary, setShowSummary] = useState(false)
  const firstChannel = useStore((s) => s.conversations.find((c) => c.kind === 'channel'))

  if (!conv)
    return (
      <div className="empty">
        <p>{L('Essa conversa não existe mais: pode ter sido apagada.', 'This conversation no longer exists: it may have been deleted.')}</p>
        {firstChannel ? (
          <button className="btn btn--primary btn--sm" onClick={() => navigate({ kind: 'conversation', id: firstChannel.id })}>
            {L(`Voltar pra #${firstChannel.name}`, `Back to #${firstChannel.name}`)}
          </button>
        ) : (
          <button className="btn btn--primary btn--sm" onClick={openTuca}>
            {L('Falar com o Tuca', 'Talk to Tuca')}
          </button>
        )}
      </div>
    )
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
        <Composer conversationId={id} members={members} placeholder={dmAgent ? L(`Mensagem pra ${dmAgent.name}`, `Message ${dmAgent.name}`) : L(`Mensagem em #${title}`, `Message #${title}`)} />
      </section>
      <SidePanel />
    </div>
  )
}

export function MessageList({ messages, conversationId, empty, focus }: { messages: Message[]; conversationId: string; empty?: boolean; focus?: string }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  // In a DM, whose it is (for the empty state).
  const dmName = useStore((s) => {
    const c = s.conversations.find((x) => x.id === conversationId)
    return c?.kind === 'dm' && c.members[0] ? agentById(s, c.members[0])?.name : undefined
  })

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
          <p className="muted">{dmName ? L(`Escreva o que precisa: ${dmName} sempre responde aqui.`, `Write what you need: ${dmName} always replies here.`) : L('Escreva e quem estiver no canal responde. Pra chamar alguém, use @.', 'Write and whoever is in the channel replies. To call on someone, use @.')}</p>
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

const AGENT_PLUGINS = [remarkGfm, remarkLocalPaths]
const keepLocalLinks = (url: string): string => (url.startsWith(LOCAL_LINK) ? url : defaultUrlTransform(url))

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

  // The same object between renders, or every link would start over.
  const agentMarkdown = useMemo(() => ({ pre: CodeBlock, a: localLinkFor(message.id) }), [message.id])

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
            {agent && message.run?.status !== 'working' ? (
              <Markdown remarkPlugins={AGENT_PLUGINS} urlTransform={keepLocalLinks} components={agentMarkdown}>{highlightMentions(message.text)}</Markdown>
            ) : (
              <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: (p) => <WikiLink href={p.href}>{p.children}</WikiLink> }}>{highlightMentions(message.text)}</Markdown>
            )}
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
        {message.run?.wikiChanges?.map((cid) => <WikiChip key={cid} id={cid} />)}
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
        {message.run?.errorDetail && (
          <Details label={L('Detalhes', 'Details')}>
            <div className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
              {message.run.errorDetail}
            </div>
          </Details>
        )}
        {message.run?.status === 'paused' && (
          <>
            <div className="note">{L(`Pausei: cheguei no teto desta resposta (${tokens(message.run.budget ?? 0)} tokens). Continuo de onde parei?`, `Paused: I hit this reply’s ceiling (${tokens(message.run.budget ?? 0)} tokens). Shall I pick up where I left off?`)}</div>
            <button className="btn btn--xs retry" onClick={() => continueRun(message.id)}>
              {L('Continuar', 'Continue')}
            </button>
          </>
        )}
        {/* At the limit, trying again only helps once the limit went up: until then, the way out is raising it. */}
        {message.run && (['failed', 'stopped', 'interrupted'].includes(message.run.status) || (message.run.status === 'limit_reached' && (!agent || agent.used < agent.limit))) && (
          <button className="btn btn--xs retry" onClick={() => retryRun(message.id)}>
            {L('Tentar de novo', 'Try again')}
          </button>
        )}
        {message.run?.status === 'limit_reached' && agent && agent.used >= agent.limit && (
          <button className="btn btn--xs retry" onClick={() => (setTab('agent', 'perfil'), navigate({ kind: 'agent', id: agent.id }))}>
            {L(`Aumentar o limite de ${agent.name}`, `Raise ${agent.name}’s limit`)}
          </button>
        )}
        {message.run?.status === 'done' && message.text.trim() && !message.run.wikiChanges?.length && <KeepInWiki messageId={message.id} />}
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
          <Markdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: (p) => <WikiLink href={p.href}>{p.children}</WikiLink> }}>{highlightMentions(message.text)}</Markdown>
        </div>
      </div>
    </article>
  )
}

// Fenced code block in a chat message, with a copy button on the top right.
function CodeBlock({ children }: { children?: ReactNode }): ReactNode {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  return (
    <div className="md-code">
      <pre ref={ref}>{children}</pre>
      <button
        className={`icon-btn icon-btn--sm md-code__copy ${copied ? 'is-copied' : ''}`}
        title={L(copied ? 'Copiado' : 'Copiar', copied ? 'Copied' : 'Copy')}
        aria-label={L(copied ? 'Copiado' : 'Copiar código', copied ? 'Copied' : 'Copy code')}
        onClick={() =>
          void navigator.clipboard.writeText(ref.current?.textContent ?? '').then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))
        }
      >
        <Icon name={copied ? 'check' : 'copy'} size={13} />
      </button>
    </div>
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

// A @handle in code is not bolded (CODE_SPANS, the core's rule too): the box shows and copies the real text.
const boldMentions = (t: string): string => t.replace(/(^|\s)@([a-z0-9_-]{2,32})/gi, '$1**@$2**')
const highlightMentions = (text: string): string => {
  text = wikiLinks(text)
  let out = ''
  let last = 0
  for (const m of text.matchAll(CODE_SPANS)) {
    out += boldMentions(text.slice(last, m.index)) + m[0]
    last = m.index! + m[0].length
  }
  return out + boldMentions(text.slice(last))
}

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
  // Just finished: the pulse turns into a green check for a moment, then the chevron is back.
  const justDone = useJustEnded(working, 1600) && run.status === 'done'

  if (run.steps.length === 0 && !working) return null
  const total = run.steps.reduce((acc, st) => acc + (st.ms ?? 0), 0)
  const failed = run.steps.filter((st) => st.status === 'error').length
  const current = [...run.steps].reverse().find((st) => st.status === 'running')

  return (
    <div className={`steps ${open ? 'is-open' : ''} ${working ? 'is-working' : ''}`}>
      <button className="steps__toggle" onClick={() => setOpen(!open)}>
        {working ? (
          <span className="steps__pulse" />
        ) : justDone ? (
          <span className="steps__done">
            <Icon name="check" size={12} />
          </span>
        ) : (
          <span className="steps__chev">
            <Icon name="chevron" size={12} />
          </span>
        )}
        {working ? (
          <span className="shimmer">
            {current
              ? `${current.label}…`
              : now - message.at > 60_000
                ? L('Ainda trabalhando: tarefas longas demoram mesmo', 'Still working: long tasks do take a while')
                : run.steps.length === 0
                  ? L('Lendo o pedido…', 'Reading the request…')
                  : L('Pensando…', 'Thinking…')}
          </span>
        ) : (
          <span className="steps__summary">
            {run.status === 'done' && failed === 0 && `${L('Pronto', 'Done')} · `}
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
  const summary = argSummary(approval.args)
  // Hold to approve: CSS fills the button in 1.5s (.is-holding); the approval goes when
  // that fill ends while still held. Letting go drains it back. Space or Enter hold too.
  const [holding, setHolding] = useState(false)
  const startHold = (): void => setHolding(true)
  const cancelHold = (): void => setHolding(false)
  const holdFilled = (e: React.TransitionEvent<HTMLButtonElement>): void => {
    if (holding && e.propertyName === 'transform' && e.pseudoElement === '::before') {
      setHolding(false)
      decideApproval(approval.id, 'approved')
    }
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
        ) : approval.connectorId === 'apps' ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')}{' '}
            {typeof approval.args['texto'] === 'string' ? (
              <>
                {L('quer confirmar', 'wants to confirm')} <strong>“{approval.args['texto']}”</strong>
              </>
            ) : typeof approval.args['tecla'] === 'string' ? (
              <>
                {L('quer apertar', 'wants to press')} <strong>{approval.args['tecla']}</strong>
              </>
            ) : (
              <>
                {L('quer clicar em', 'wants to click')} <strong>{String(approval.args['alvo'] ?? '')}</strong>
              </>
            )}{' '}
            {L('no', 'in')} {String(approval.args['app'] ?? '')}
          </>
        ) : approval.connectorId === 'navegador' ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('quer clicar em', 'wants to click')} <strong>{String(approval.args['alvo'] || L('um ponto da tela', 'a spot on the screen'))}</strong> {L('em', 'on')} {String(approval.args['url']).replace(/^https?:\/\//, '').slice(0, 60)}
          </>
        ) : (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('quer usar', 'wants to use')} <strong>{toolWords(approval.tool)}</strong> {L('no', 'in')} {approval.connectorName}
          </>
        )}
      </div>
      {approval.why && <p className="approval__why">{approval.why}</p>}
      {/* The title already says it all for an access request, an app or the browser. */}
      {approval.tool !== ACCESS_REQUEST && approval.connectorId !== 'apps' && approval.connectorId !== 'navegador' && summary.shown.length > 0 && (
        <div className="approval__args small">
          {summary.shown.map(([k, v], i) => (
            <p key={i}>
              <span className="muted">{k}:</span> {v}
            </p>
          ))}
          {summary.more && <p className="muted">{L('Tem mais nos detalhes exatos.', 'There’s more in the exact details.')}</p>}
        </div>
      )}
      {/* High risk: what is being approved shows in full, not behind a click. */}
      <Details label={L('Ver detalhes exatos', 'See exact details')} initiallyOpen={approval.highRisk && !decided}>
        <div className="approval__call">
          <code>
            {approval.connectorName} · {approval.tool}
          </code>
          <pre>{JSON.stringify(approval.args, null, 2)}</pre>
        </div>
      </Details>
      <p className="approval__bound">
        {L('A aprovação cobre só esta chamada, com estes valores. Se mudar qualquer coisa, o agente pede de novo.', 'The approval covers only this call, with these values. If anything changes, the agent asks again.')}
        {!decided && ` ${until(approval.expiresAt)}`}
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
              className={`btn btn--primary btn--hold ${holding ? 'is-holding' : ''}`}
              onPointerDown={startHold}
              onPointerUp={cancelHold}
              onPointerLeave={cancelHold}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && (e.preventDefault(), startHold())}
              onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && cancelHold()}
              onBlur={cancelHold}
              onTransitionEnd={holdFilled}
            >
              <span>{holding ? L('Segure…', 'Hold…') : L('Segure pra aprovar · ação de alto risco', 'Hold to approve · high-risk action')}</span>
            </button>
          ) : (
            <>
              <button className="btn btn--primary" onClick={() => decideApproval(approval.id, 'approved')}>
                {L('Aprovar', 'Approve')}
              </button>
              {approval.tool !== ACCESS_REQUEST && approval.tool !== 'abrir_pr' && approval.connectorId !== 'navegador' && approval.connectorId !== 'apps' && (
                <button className="btn" title={L(`Daqui pra frente ${agent?.name ?? 'o agente'} usa “${toolWords(approval.tool)}” no ${approval.connectorName} sem pedir. Dá pra tirar na página dele.`, `From now on ${agent?.name ?? 'the agent'} uses “${toolWords(approval.tool)}” in ${approval.connectorName} without asking. You can take it back on its page.`)} onClick={() => decideApproval(approval.id, 'approved', undefined, true)}>
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
    return L(`Não deu pra abrir ${file.name}. Tente salvar de novo ou mandar outra imagem.`, `${file.name} couldn't be opened. Try saving it again or send another image.`)
  }
}

// One draft per conversation, kept while the app runs: leaving a channel doesn't
// lose the message you were typing.
const drafts = new Map<string, { text: string; images: Attached[] }>()

type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'
type DictationControls = { press: () => void; release: () => void; stop: () => void; cancel: () => void; startedAt: () => number }

const NOT_READY = (): string => L('Para ditar, clique no microfone e ative o ditado.', 'To dictate, click the microphone and turn dictation on.')
const SHORT_MS = 300
const HOLD_MS = 400 // held at least this long, letting go ends it (push to talk); a click starts it, the next one ends it

// Click to record, click again to transcribe (or hold and let go). The text goes to the field to be reviewed, never sent:
// dictation gets names wrong, and a message sets an agent working.
function useDictation(insert: (text: string) => void, setNote: (note: string) => void, conversationId: string): [DictationState, DictationControls] {
  const [state, setState] = useState<DictationState>('idle')
  const rec = useRef<Recording | null>(null)
  const startedAt = useRef(0)
  const job = useRef<string | null>(null)
  const released = useRef(false)
  const attempt = useRef(0) // a microphone that opens after this one was given up on gets closed
  const platform = useStore((s) => s.platform)

  const cancel = (): void => {
    released.current = true
    rec.current?.cancel()
    rec.current = null
    if (job.current) void cancelTranscribe(job.current)
    job.current = null
    setState('idle')
  }

  const stop = (): void => {
    released.current = true
    const r = rec.current
    if (!r) return
    rec.current = null
    if (Date.now() - startedAt.current < SHORT_MS) {
      r.cancel()
      setState('idle')
      setNote(L('Curto demais: clique, fale e clique de novo.', 'Too short: click, speak, and click again.'))
      return
    }
    setState('transcribing')
    const id = crypto.randomUUID()
    job.current = id
    void r
      .stop()
      .then((audio) => transcribe(id, audio))
      .then(
        (said) => {
          if (job.current !== id) return
          if (said) insert(said)
          else setNote(L('Não ouvi nada nessa gravação.', "I didn't hear anything in that recording."))
        },
        (e: unknown) => {
          if (job.current !== id) return
          if (e instanceof NoSound)
            setNote(
              platform === 'mac'
                ? L('Não chegou som do microfone. Confira qual está em uso em Ajustes do Sistema › Som.', 'No sound came from the microphone. Check which one is in use in System Settings › Sound.')
                : L('Não chegou som do microfone. Confira qual está em uso nas configurações de som do sistema.', 'No sound came from the microphone. Check which one is in use in the system’s sound settings.')
            )
          else setNote(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))
        }
      )
      .finally(() => {
        if (job.current !== id) return
        job.current = null
        setState('idle')
      })
  }

  const start = (): void => {
    if (state !== 'idle') return
    released.current = false
    const mine = ++attempt.current
    setNote('')
    setState('starting')
    void voiceStatus()
      .then((status) => {
        if (!status.ready) throw new Error(NOT_READY())
        return record()
      })
      .then(
        (r) => {
          if (mine !== attempt.current) return r.cancel()
          // Let go while the microphone was still opening: nothing to record.
          if (released.current) {
            r.cancel()
            setState('idle')
            return
          }
          rec.current = r
          startedAt.current = Date.now()
          setState('recording')
        },
        (e: unknown) => {
          if (mine !== attempt.current) return
          setState('idle')
          const name = e instanceof Error ? e.name : ''
          setNote(
            name === 'NotAllowedError'
              ? platform === 'mac'
                ? L('O microfone está bloqueado. Libere o Tucano em Ajustes do Sistema › Privacidade e Segurança › Microfone.', 'The microphone is blocked. Allow Tucano in System Settings › Privacy & Security › Microphone.')
                : L('O microfone está bloqueado. Libere o Tucano nas configurações de privacidade do sistema.', 'The microphone is blocked. Allow Tucano in the system’s privacy settings.')
            : name === 'NotFoundError' ? L('Não encontrei um microfone.', "I couldn't find a microphone.")
            : e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)
          )
        }
      )
  }

  useEffect(() => cancel, [conversationId]) // leaving the conversation drops what's going on

  // The key can be let go anywhere, and no event reaches the field after the window loses focus.
  // A press starts it, or ends one going on. Let go after holding it a while ends it too.
  const pressedAt = useRef(0)
  const toggled = useRef(false) // this press ended a recording: its release does nothing
  const press = (): void => {
    if (state === 'recording' || state === 'starting') return (toggled.current = true), stop()
    if (state !== 'idle') return
    toggled.current = false
    pressedAt.current = Date.now()
    start()
  }
  const release = (): void => {
    if (toggled.current || !pressedAt.current) return
    const held = Date.now() - pressedAt.current
    pressedAt.current = 0
    if (held >= HOLD_MS) stop()
  }

  const listening = state === 'starting' || state === 'recording'
  useEffect(() => {
    if (!listening) return
    // the key can be let go anywhere; Esc drops it from anywhere
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') release()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    // held when the window lost focus: no release will come, so that's the end of it
    const blur = (): void => {
      if (pressedAt.current && Date.now() - pressedAt.current >= HOLD_MS) release()
    }
    document.addEventListener('keyup', up)
    document.addEventListener('keydown', esc)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('keyup', up)
      document.removeEventListener('keydown', esc)
      window.removeEventListener('blur', blur)
    }
  }, [listening])

  return [state, { press, release, stop, cancel, startedAt: () => startedAt.current }]
}

function VoiceButton({ controls, state }: { controls: DictationControls; state: DictationState }): ReactNode {
  const platform = useStore((s) => s.platform)
  const hidden = useStore((s) => !!s.settings.voice?.hidden)
  const status = useVoice()
  const [open, setOpen] = useState(false)
  // Once it's turned on from the balloon, the balloon says how to use it, then gets out of the way.
  if (!canRecord() || hidden || !status) return null // no secure context, or the person hid it
  if (!status.ready)
    return (
      <span className="voice-wrap">
        <button
          className={`icon-btn voice-btn is-off ${status.downloading ? 'is-loading' : ''}`}
          aria-label={L('Ditar mensagens', 'Dictate messages')}
          aria-expanded={open}
          title={status.downloading ? L('Baixando o modelo de voz…', 'Downloading the voice model…') : L('Ditar mensagens: ativar', 'Dictate messages: turn on')}
          onClick={() => setOpen(!open)}
        >
          <Icon name="mic" size={15} />
        </button>
        {open && <VoicePopover status={status} onClose={() => setOpen(false)} />}
      </span>
    )
  if (open)
    return (
      <span className="voice-wrap">
        <button className="icon-btn voice-btn" aria-label={L('Ditar mensagens', 'Dictate messages')} onClick={() => setOpen(false)}>
          <Icon name="mic" size={15} />
        </button>
        <VoicePopover status={status} onClose={() => setOpen(false)} />
      </span>
    )
  if (state === 'transcribing')
    return (
      <button className="btn btn--xs" title={L('Cancelar', 'Cancel')} onClick={controls.cancel}>
        {L('Transcrevendo…', 'Transcribing…')} <Icon name="x" size={11} />
      </button>
    )
  const on = state === 'recording'
  return (
    <span className="voice-wrap">
      <button
        className={`icon-btn voice-btn ${on ? 'is-recording' : ''}`}
        aria-label={on ? L('Terminar e transcrever', 'Finish and transcribe') : L('Falar', 'Speak')}
        aria-pressed={on}
        title={on ? L('Clique para terminar (Esc cancela)', 'Click to finish (Esc cancels)') : L(`Clique para falar, e de novo para terminar (${platform === 'mac' ? '⌥' : 'Ctrl+'}Espaço)`, `Click to speak, and again to finish (${platform === 'mac' ? '⌥' : 'Ctrl+'}Space)`)}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          controls.press()
        }}
        onPointerUp={controls.release}
        onPointerCancel={controls.cancel}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon name="mic" size={15} />
      </button>
      {on && <RecordingClock since={controls.startedAt()} />}
    </span>
  )
}

// While it records: for how long, and how to end it.
function RecordingClock({ since }: { since: number }): ReactNode {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000))
  return (
    <span className="voice-clock" aria-live="off">
      <i />
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}
      <span className="muted"> · {L('clique para terminar', 'click to finish')}</span>
    </span>
  )
}

export function Composer({ conversationId, members, placeholder }: { conversationId: string; members: Agent[]; placeholder: string }): ReactNode {
  // The field starts with the conversation's draft, not empty: StrictMode (in dev) unmounts
  // and mounts again at once, and saving an empty first render would wipe the draft.
  const [text, setText] = useState(() => drafts.get(conversationId)?.text ?? '')
  const [images, setImages] = useState<Attached[]>(() => drafts.get(conversationId)?.images ?? [])
  const [note, setNote] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const platform = useStore((s) => s.platform)
  const allAgents = useStore((s) => s.agents.filter(isTeam))
  const isDm = useStore((s) => s.conversations.find((c) => c.id === conversationId)?.kind === 'dm')
  const working = useStore((s) => s.messages.filter((m) => m.conversationId === conversationId && m.author.kind === 'agent' && m.run?.status === 'working'))
  const asker = useStore((s) => {
    const q = s.messages.findLast((m) => m.conversationId === conversationId && m.run?.status === 'waiting_input')
    return q?.author.kind === 'agent' ? agentById(s, q.author.id)?.name : undefined
  })

  // What's typed but not sent, per conversation, so leaving a channel and coming
  // back keeps it (like a draft). In memory: closing the app drops the drafts.
  const live = useRef({ text, images })
  live.current = { text, images }
  useEffect(() => {
    const draft = drafts.get(conversationId)
    setText(draft?.text ?? '')
    setImages(draft?.images ?? [])
    setNote('')
    ref.current?.focus()
    return () => {
      const { text, images } = live.current
      if (text.trim() || images.length) drafts.set(conversationId, { text, images })
      else drafts.delete(conversationId)
    }
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

  const insert = (said: string): void => {
    const el = ref.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? start
    setText((cur) => {
      const before = cur.slice(0, start)
      const glue = before && !/\s$/.test(before) ? ' ' : ''
      return `${before}${glue}${said}${cur.slice(end)}`
    })
    el?.focus()
  }
  const [voice, voiceControls] = useDictation(insert, setNote, conversationId)

  const submit = (): void => {
    if (!text.trim() && images.length === 0) return
    sendMessage(
      conversationId,
      text,
      images.map(({ name, mime, data }) => ({ name, mime, data }))
    )
    drafts.delete(conversationId)
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
            if (e.code === 'Space' && (platform === 'mac' ? e.altKey : e.ctrlKey) && canRecord()) {
              e.preventDefault()
              if (!e.repeat) voiceControls.press()
              return
            }
            if (e.key === 'Escape' && voice !== 'idle') return voiceControls.cancel()
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
          <VoiceButton controls={voiceControls} state={voice} />
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
            {note || (members[0]?.kind === 'tuca' ? L('Nada é criado sem você', 'Nothing is created without you') : isDm ? L(`${members[0]?.name ?? 'O agente'} sempre responde aqui`, `${members[0]?.name ?? 'The agent'} always replies here`) : L('Quem estiver no canal responde · pra chamar alguém, use @', 'Whoever is in the channel replies · to call on someone, use @'))}
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
