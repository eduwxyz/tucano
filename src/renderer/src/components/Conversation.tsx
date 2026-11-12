import { L, lang, locale } from '../../../shared/lang'
import { actionLabel, innerActions, isRunner } from '../../../shared/composio'
import { runnerRules } from '../../../shared/classify'
import { kindLabel, actionVerb, COMPUTADOR, shellActions } from '../../../shared/actions'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import Markdown, { type ExtraProps } from 'react-markdown'
import { safeUrl } from '../links'
import { remarkLocalPaths } from '../../../shared/path-text'
import { remarkMentions, splitMentions } from '../../../shared/mention-text'
import { saidAt } from '../../../shared/types'
import { localLinkFor } from './LocalLink'
import remarkGfm from 'remark-gfm'
import { KeepInWiki, WikiChip, WikiLink, wikiLinks } from './Wiki'
import { canEditChannel,
  agentById,
  askerIn,
  messagesIn,
  attachedTo,
  conversationIndex,
  initials,
  isMine,
  personName,
  conversationTitle,
  lastBrowserIn,
  loadOlder,
  loadThread,
  messageById,
  repliesOf,
  timelineOf,
  useLiveText,
  workingIds,
  openDialog,
  decideApproval,
  decideMemory,
  describeSchedule,
  editSummary,
  editThreadSummary,
  ENGINES,
  forgetMemory,
  modelById,
  navigate,
  openDm,
  openPanel,
  openThread,
  seeThread,
  openTuca,
  proposalsOf,
  removeRoutine,
  retryRun,
  continueRun,
  ACCESS_REQUEST,
  countedTokens,
  sendMessage,
  typing,
  setTab,
  stopRun,
  summarizeNow,
  summarizeThreadNow,
  useStore,
  SUMMARY_MAX_AFTER,
  SUMMARY_WINDOW,
  type Agent,
  type Approval,
  type Artifact,
  type Conversation,
  type ImageUpload,
  type Author,
  type Message,
  type Step,
  IMAGE_MIMES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_FILE_BYTES,
  MAX_FILES_PER_MESSAGE,
  isTeam,
  cancelTranscribe,
  transcribe,
  voiceStatus,
  scopePerson,
  amAdmin,
  answerQuestion,
  canDecide,
  confirmQuestion,
  personById,
  teamMode,
  type Person
} from '../store'
import { AgentAvatar, Icon, MeAvatar, ago, ownColor, duration, time, tokens, usd, useJustEnded } from './ui'
import { PanelResize } from './SidebarResize'
import { canRecord, NoSound, record, type Recording } from '../voice'
import { useVoice, VoicePopover } from './VoiceSetup'
import { ArtifactCard, BrowserCard, ServiceCard, SidePanel } from './Panel'
import { when } from './Routines'
import { Proposals } from './Tuca'
import { FoldToggle } from './Fold'
import { AnswersSummary, AskCard, asShown, cardAnswers } from './Decisions'
import { questionsOf, type Answer, type Decision } from '../../../shared/questions'
import { AgentCardButton } from './AgentCard'

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
  const editsChannel = useStore((s) => !!conv && canEditChannel(s, conv))
  const title = useStore((s) => (conv ? conversationTitle(s, conv) : ''))
  // An archived agent stays in the channel for when it comes back, but it isn't in
  // the room: out of the stack, the count and the @ list. A DM still shows whose it is.
  const members = useStore((s) => {
    if (!conv) return []
    const all = conv.members.map((m) => agentById(s, m)).filter((a): a is Agent => !!a)
    return conv.kind === 'dm' ? all : all.filter(isTeam)
  })
  const timeline = useStore((s) => timelineOf(s, id))
  // The index, not its Map: useStore's shallow compare finds no keys in a Map and would keep the first one.
  const { replies } = useStore((s) => conversationIndex(s, id))
  const older = useStore((s) => !!s.history[id])
  const focus = useStore((s) => (s.view?.kind === 'conversation' && s.view.id === id ? s.view.message : undefined))
  // Opened on a message from before what's here (a routine's run, a report): it comes first.
  const focusHere = !!focus && timeline.some((m) => m.id === focus)
  useEffect(() => {
    if (focus && !focusHere) void loadOlder(id, focus)
  }, [id, focus, focusHere])
  const thread = useStore((s) => (s.panel?.kind === 'thread' ? s.panel.id : undefined))
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
            {/* A channel's name opens its settings; a DM's, like Slack, the agent's card (its settings: the gear on the right, or the card). */}
            {dmAgent ? (
              <AgentCardButton agentId={dmAgent.id} settingsOf={id} below className="topbar__name" title={L(`Perfil de ${dmAgent.name}`, `${dmAgent.name}’s profile`)}>
                <AgentAvatar agent={dmAgent} size={22} />
                <h1>{title}</h1>
              </AgentCardButton>
            ) : (
              <button className="topbar__name" title={L('Configurações do canal', 'Channel settings')} onClick={() => openDialog({ kind: 'settings', id })}>
                <Icon name="hash" />
                <h1>{title}</h1>
              </button>
            )}
            {dmAgent?.role && (
              <span className="tag topbar__role" title={dmAgent.role}>
                {dmAgent.role}
              </span>
            )}
            {conv.topic && <span className="topbar__topic">{conv.topic}</span>}
          </div>
          <div className="topbar__actions">
            {conv.kind === 'channel' && (
              <div className="stack" title={L('Agentes no canal', 'Agents in the channel')}>
                {members.map((a) => (
                  <AgentCardButton key={a.id} agentId={a.id} below className="stack__item" title={a.name}>
                    <AgentAvatar agent={a} size={24} />
                  </AgentCardButton>
                ))}
                <span className="stack__count">{members.length} {L(`agente${members.length === 1 ? '' : 's'}`, `agent${members.length === 1 ? '' : 's'}`)}</span>
                {editsChannel && (
                  <button className="icon-btn stack__add" title={L('Adicionar ou remover agentes', 'Add or remove agents')} onClick={() => openDialog({ kind: 'members', id })}>
                    <Icon name="plus" size={14} />
                  </button>
                )}
              </div>
            )}
            <button className={`btn btn--ghost ${showSummary ? 'is-active' : ''}`} title={L('O que esta conversa já cobriu', 'What this conversation has covered')} onClick={() => setShowSummary(!showSummary)}>
              <Icon name="book" size={14} /> {L('Resumo', 'Summary')}
            </button>
            {dmAgent && (
              <button className="icon-btn" title={L('Configurações da conversa', 'Conversation settings')} aria-label={L('Configurações da conversa', 'Conversation settings')} onClick={() => openDialog({ kind: 'settings', id })}>
                <Icon name="gear" size={16} />
              </button>
            )}
          </div>
        </header>

        {showSummary && <SummaryPanel conv={conv} messages={timeline} onClose={() => setShowSummary(false)} />}

        <MessageList messages={timeline} replies={replies} older={older} conversationId={id} empty={conv.kind === 'channel' && members.length === 0} focus={focus} />
        <Composer conversationId={id} members={members} placeholder={dmAgent ? L(`Mensagem pra ${dmAgent.name}`, `Message ${dmAgent.name}`) : L(`Mensagem em #${title}`, `Message #${title}`)} />
      </section>
      {thread ? <ThreadPanel rootId={thread} conv={conv} title={conv.kind === 'channel' ? `#${title}` : title} members={members} /> : <SidePanel />}
    </div>
  )
}

const NO_REPLIES: Message[] = []

// `replies`: a timeline with threads, where each message can start one (its replies by its id).
// `older`: there's more before the first message, loaded as the scroll gets near the top.
export function MessageList({ messages: all, replies, older, conversationId, empty, focus, lead }: { messages: Message[]; replies?: Map<string, Message[]>; older?: boolean; conversationId: string; empty?: boolean; focus?: string; lead?: ReactNode }): ReactNode {
  // An answer sent from a decisions card shows on the card, not again as a message (Decisions.asShown).
  const everything = useStore((s) => messagesIn(s, conversationId)) // a list: the store compares a Map as always equal
  const messages = useMemo(() => asShown(all, cardAnswers(everything)), [all, everything])
  const editsChannel = useStore((s) => {
    const c = s.conversations.find((x) => x.id === conversationId)
    return !!c && canEditChannel(s, c)
  })
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [farFromBottom, setFarFromBottom] = useState(false)
  const [loading, setLoading] = useState(false)
  const before = useRef<{ height: number; top: number } | null>(null) // the list as it was, while older messages come
  // In a DM, whose it is (for the empty state).
  const dmName = useStore((s) => {
    const c = s.conversations.find((x) => x.id === conversationId)
    return c?.kind === 'dm' && c.members[0] ? agentById(s, c.members[0])?.name : undefined
  })

  // Opened on a message (a routine's run, say): scroll to it and flash it once. It may come a moment
  // later, from further back.
  const focusAt = focus ? messages.findIndex((m) => m.id === focus) : -1
  useEffect(() => {
    const el = focus && focusAt >= 0 ? ref.current?.querySelector<HTMLElement>(`:scope > [data-id="${CSS.escape(focus)}"]`) : null
    if (!el) return
    stick.current = false
    el.scrollIntoView({ block: 'center' })
    el.classList.add('is-flash')
    const t = setTimeout(() => el.classList.remove('is-flash'), 1800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, conversationId, focusAt >= 0])

  useEffect(() => {
    if (!lead) stick.current = true
    setFarFromBottom(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  // To the end when a message arrives or changes there; the rows growing on their own (a reply
  // streaming, an image loading) are watched below, so a word streamed doesn't lay the list out again.
  const last = messages.at(-1)
  useLayoutEffect(() => {
    const el = ref.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [last, messages.length])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const watch = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    for (const row of el.children) watch.observe(row)
    return () => watch.disconnect()
  })

  // Older messages came in above: what was on screen stays where it was (unless the browser kept it already).
  const first = messages[0]?.id
  useLayoutEffect(() => {
    const el = ref.current
    const was = before.current
    before.current = null
    if (!el || !was) return
    const grown = el.scrollHeight - was.height
    if (grown > 0 && Math.abs(el.scrollTop - was.top) < 2) el.scrollTop = was.top + grown
  }, [first])

  const more = (el: HTMLDivElement): void => {
    if (!older || loading || el.scrollTop > 800) return
    setLoading(true)
    before.current = { height: el.scrollHeight, top: el.scrollTop }
    void loadOlder(conversationId).finally(() => setLoading(false))
  }
  // Too little to scroll: the page before comes without waiting for a scroll (once per page, so a
  // failure doesn't ask again and again).
  const tried = useRef<string | undefined>(undefined)
  useEffect(() => {
    const el = ref.current
    if (!el || tried.current === first) return
    tried.current = first
    more(el)
  })

  // A thread opens at its latest message, like Slack: the message that started it is a scroll up.
  // Once more on the next frame, for what lays out a little late (code blocks, images).
  useLayoutEffect(() => {
    const el = ref.current
    if (!lead || !el) return
    stick.current = true
    el.scrollTop = el.scrollHeight
    const frame = requestAnimationFrame(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (messages.length === 0 && empty && !lead) {
    return (
      <div className="messages messages--empty">
        <div className="empty">
          <Icon name="users" size={22} />
          <p>{L('Nenhum agente neste canal ainda.', 'No agents in this channel yet.')}</p>
          <p className="muted">{L('Quem está no canal lê a conversa e pode responder.', 'Whoever is in the channel reads the conversation and can reply.')}</p>
          {editsChannel && (
            <button className="btn btn--primary btn--sm" onClick={() => openDialog({ kind: 'members', id: conversationId })}>
              <Icon name="plus" size={14} /> {L('Adicionar agentes', 'Add agents')}
            </button>
          )}
        </div>
      </div>
    )
  }

  if (messages.length === 0 && !lead) {
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
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
        stick.current = fromBottom < 60
        setFarFromBottom(fromBottom > el.clientHeight / 2)
        more(el)
      }}
    >
      {loading && <div className="messages__older muted small">{L('Carregando mensagens anteriores…', 'Loading earlier messages…')}</div>}
      {lead}
      {messages.map((m, i) => {
        const prev = messages[i - 1]
        const grouped =
          !!prev &&
          prev.author.kind === m.author.kind &&
          (m.author.kind !== 'agent' || (prev.author.kind === 'agent' && prev.author.id === m.author.id)) &&
          (m.author.kind !== 'person' || (prev.author.kind === 'person' && prev.author.id === m.author.id)) &&
          m.at - prev.at < 5 * 60_000 &&
          !m.run &&
          m.author.kind !== 'system' &&
          m.author.kind !== 'routine'
        return <MessageRow key={m.id} message={m} grouped={grouped} replies={replies && (replies.get(m.id) ?? NO_REPLIES)} />
      })}
      {farFromBottom && (
        <div className="messages__jump">
          <button className="messages__jump-btn" title={L('Ir para o fim', 'Go to the end')} aria-label={L('Ir para o fim da conversa', 'Go to the end of the conversation')} onClick={() => ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })}>
            <Icon name="down" size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

const AGENT_PLUGINS = [remarkGfm, remarkMentions, remarkLocalPaths]
const PLAIN_PLUGINS = [remarkGfm, remarkMentions]

// Parsing is by far the most expensive part of drawing a message, so it only runs when the text changes.
const MessageMarkdown = memo(Markdown)
const STREAM_MS = 140 // a streaming reply's Markdown, about 7 times a second
const NO_ATTACHED: Artifact[] = []

// `replies`: in a timeline with threads, the replies to this message (none yet: empty).
// Memoized because each word an agent streams redraws the list: only the row that changed should pay for it.
const MessageRow = memo(function MessageRow({ message, grouped, replies }: { message: Message; grouped: boolean; replies?: Message[] }): ReactNode {
  const me = useStore((s) => s.me)
  // In the timeline (not as the thread's own heading), lit while its thread is open on the side.
  const threadOpen = useStore((s) => !!replies && s.panel?.kind === 'thread' && s.panel.id === message.id)
  const agent = useStore((s) => (message.author.kind === 'agent' ? agentById(s, message.author.id) : undefined))
  const approval = useStore((s) => (message.run?.approvalId ? s.approvals.find((a) => a.id === message.run!.approvalId) : undefined))
  const team = useStore(teamMode)
  // Someone else's message reads with their name and initials; mine, as always.
  const other = useStore((s) => (message.author.kind === 'person' && !isMine(s, message.author) ? personName(s, message.author.id) : undefined))
  const attached = useStore((s) => (message.author.kind === 'person' ? attachedTo(s, message.id) : NO_ATTACHED))
  // The browser shows live on the agent's latest message that used it, unless it's open on the side.
  const liveBrowser = useStore(
    (s) =>
      !!message.run?.browser &&
      !(s.panel?.kind === 'browser' && s.panel.agentId === agent?.id) &&
      !!agent &&
      lastBrowserIn(s, message.conversationId, agent.id) === message.id
  )
  // Streamed words wake only this row; while they come, the Markdown is drawn a few times a second,
  // whole again once the reply ends.
  const text = useLiveText(message, message.run?.status === 'working' ? STREAM_MS : 0)

  // The same object between renders, or every link would start over.
  const agentMarkdown = useMemo(() => ({ pre: CodeBlock, a: localLinkFor(message.id), span: MentionSpan }), [message.id])

  if (message.author.kind === 'system') {
    return (
      <div className={`system-line ${message.run?.status === 'working' ? 'is-pending' : ''}`} data-id={message.id}>
        <Icon name="spark" size={13} />
        <SystemText text={message.text} />
        <span className="muted">{time(message.at)}</span>
      </div>
    )
  }

  if (message.author.kind === 'routine') return <RoutineMessage message={message} replies={replies} />

  const name = agent ? agent.name : (other ?? me.name)
  return (
    // Someone else's message reads like any other voice in the conversation: on the left, with their name.
    <article className={`msg ${agent ? 'msg--agent' : other ? 'msg--agent msg--person' : 'msg--me'} ${grouped ? 'msg--grouped' : ''} ${threadOpen ? 'is-thread-open' : ''}`} data-id={message.id}>
      <div className="msg__gutter">
        {!grouped &&
          (agent ? (
            <AgentCardButton agentId={agent.id} className="msg__face" tabIndex={-1} label={L(`Perfil de ${agent.name}`, `${agent.name}’s profile`)}>
              <AgentAvatar agent={agent} size={34} busy={message.run?.status === 'working'} />
            </AgentCardButton>
          ) : (
            <MeAvatar initials={other ? initials(other) : me.initials} size={34} />
          ))}
      </div>
      <div className="msg__body">
        {!grouped && (
          <div className="msg__head">
            {agent ? (
              <AgentCardButton agentId={agent.id} className="msg__author link">
                {name}
              </AgentCardButton>
            ) : (
              <span className="msg__author">{name}</span>
            )}
            {agent?.computer && agent.computerKind === 'mac' && (
              <span className="tag tag--warn" title={L('Os comandos deste agente rodam direto no seu computador', 'This agent’s commands run right on your computer')}>
                {L('no seu computador', 'on your computer')}
              </span>
            )}
            <span className="msg__time">{time(saidAt(message))}</span>
          </div>
        )}
        {message.run && <RunSteps message={message} />}
        {text ? (
          <div className="md">
            {agent && message.run?.status !== 'working' ? (
              <MessageMarkdown urlTransform={safeUrl} remarkPlugins={AGENT_PLUGINS} components={agentMarkdown}>{wikiLinks(text)}</MessageMarkdown>
            ) : (
              <MessageMarkdown urlTransform={safeUrl} remarkPlugins={PLAIN_PLUGINS} components={plainMarkdown}>{wikiLinks(text)}</MessageMarkdown>
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
        {/* The question, as a card under the reply: alone, mine to answer there; with a team, it says whom it's for, and who
            may answer it does it there. One from before decisions, with a team, is the question card it was. */}
        {questionsOf(message.run).length > 0 &&
          (team && message.run?.askedTo ? (
            <QuestionCard id={message.id} agentName={agent?.name} askedTo={message.run.askedTo} question={message.run.question ?? ''} {...(message.run.questions?.length ? { decisions: message.run.questions } : {})} answers={message.run.answers} answeredInText={message.run.answeredInText} answered={message.run.status !== 'waiting_input'} answeredBy={message.run.answeredBy} />
          ) : (
            <AnswersSummary message={message} />
          ))}
        {approval && <ApprovalCard approval={approval} />}
        {(message.run?.agentDraft || proposalsOf(message.run).length > 0) && <Proposals message={message} />}
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
        {(message.run?.receipt || (message.run?.status === 'done' && message.text.trim() && !message.run.wikiChanges?.length)) && (
          <div className="msg__meta">
            {message.run?.receipt && <ReceiptLine receipt={message.run.receipt} />}
            {message.run?.status === 'done' && message.text.trim() && !message.run.wikiChanges?.length && <KeepInWiki messageId={message.id} />}
          </div>
        )}
        {replies && <ThreadLink message={message} replies={replies} />}
      </div>
    </article>
  )
})

// What a routine asked, posted at its time; the agent's reply comes next.
function RoutineMessage({ message, replies }: { message: Message; replies?: Message[] }): ReactNode {
  const exists = useStore((s) => s.routines.some((r) => message.author.kind === 'routine' && r.id === message.author.id))
  const info = message.routine
  return (
    <article className="msg msg--routine" data-id={message.id}>
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
          <MessageMarkdown urlTransform={safeUrl} remarkPlugins={PLAIN_PLUGINS} components={plainMarkdown}>{wikiLinks(message.text)}</MessageMarkdown>
        </div>
        {replies && <ThreadLink message={message} replies={replies} />}
      </div>
    </article>
  )
}

// A system note says what happened first ("Chamei **Iris**"), then why, after " · ": the
// headline reads at a glance, the why stays quiet (and whole on hover).
function SystemText({ text }: { text: string }): ReactNode {
  const [head = '', ...why] = text.split(' · ')
  return (
    <>
      <Markdown urlTransform={safeUrl}>{head}</Markdown>
      {why.length > 0 && (
        <span className="system-line__why" title={why.join(' · ').replace(/\*\*/g, '')}>
          {why.join(' · ').replace(/\*\*/g, '')}
        </span>
      )}
    </>
  )
}

const repliesLabel = (n: number): string => L(`${n} resposta${n === 1 ? '' : 's'}`, `${n} repl${n === 1 ? 'y' : 'ies'}`)

// Who took part in a thread, as faces: agents with their eyes (reading while they work), me with my initials.
function Faces({ authors, busy }: { authors: Author[]; busy: Set<string> }): ReactNode {
  const agents = useStore((s) => s.agents)
  const me = useStore((s) => s.me)
  const you = useStore((s) => s.you)
  const people = useStore((s) => s.people)
  const former = useStore((s) => s.former)
  const nameOf = (id: string): string | undefined => (isMine({ you }, { kind: 'person', id }) ? undefined : personName({ you, people, me, former }, id))
  return (
    <span className="thread-link__faces" aria-hidden>
      {authors.slice(0, 3).map((a) => {
        if (a.kind === 'agent') {
          const agent = agents.find((x) => x.id === a.id)
          return agent ? <AgentAvatar key={a.id} agent={agent} size={18} busy={busy.has(a.id)} /> : null
        }
        const other = a.kind === 'person' ? nameOf(a.id) : undefined
        return <MeAvatar key={a.kind === 'person' ? a.id : 'me'} initials={other ? initials(other) : me.initials} size={18} />
      })}
    </span>
  )
}

// "Reply in thread" on hover and, under a message with replies, a small pill: who took part,
// how many replies and when the last came (or who's replying, or what waits on me). It opens
// the thread on the side. With no reply yet, the system's note says what happened.
function ThreadLink({ message, replies }: { message: Message; replies: Message[] }): ReactNode {
  const agents = useStore((s) => s.agents)
  const you = useStore((s) => s.you)
  const people = useStore((s) => s.people)
  const me = useStore((s) => s.me)
  const former = useStore((s) => s.former)
  const mine = (a: Author): boolean => isMine({ you }, a)
  const someone = (id: string): string => personName({ you, people, me, former }, id)
  const open = useStore((s) => s.panel?.kind === 'thread' && s.panel.id === message.id)
  const said = replies.filter((m) => m.author.kind !== 'system')
  const done = said.filter((m) => m.run?.status !== 'working')
  const nameOf = (m: Message): string => {
    const a = m.author
    return a.kind === 'agent' ? (agents.find((x) => x.id === a.id)?.name ?? L('agente', 'agent')) : a.kind === 'person' ? (mine(a) ? L('você', 'you') : someone(a.id)) : L('rotina', 'routine')
  }
  const key = (a: Author): string => (a.kind === 'agent' || a.kind === 'person' ? `${a.kind}:${a.id}` : a.kind)
  // The latest to speak first: their face leads.
  const authors = [...new Map([...said].reverse().map((m) => [key(m.author), m.author])).values()]
  const working = said.filter((m) => m.run?.status === 'working')
  const busy = [...new Set(working.map(nameOf))]
  // What's waiting on me in there, now that answers live in threads: a question or an approval.
  const asks = said.findLast((m) => m.run?.status === 'waiting_input' || m.run?.status === 'waiting_approval')
  const note = said.length === 0 ? replies.findLast((m) => m.author.kind === 'system') : undefined
  const last = done.at(-1)
  // New: what others said after I last had the thread open (while it's open, nothing is).
  const seen = useStore((s) => s.threadSeen[message.id] ?? 0)
  const fresh = open ? 0 : done.filter((m) => !mine(m.author) && saidAt(m) > seen).length
  const go = (): void => openThread(message.id)
  return (
    <>
      <button className="icon-btn icon-btn--sm msg__reply" title={L('Responder na thread', 'Reply in thread')} aria-label={L('Responder na thread', 'Reply in thread')} onClick={go}>
        <Icon name="thread" size={13} />
      </button>
      {note && (
        <button className={`thread-note ${note.run?.status === 'working' ? 'is-pending' : ''}`} onClick={go} title={note.text.replace(/\*\*/g, '')}>
          <Icon name="spark" size={12} />
          <span>{note.text.replace(/\*\*/g, '').split(' · ')[0]}</span>
        </button>
      )}
      {said.length > 0 && (
        <button className={`thread-link ${open ? 'is-open' : ''} ${asks ? 'is-asking' : ''}`} onClick={go} aria-label={L(`Abrir a thread: ${repliesLabel(done.length)}`, `Open the thread: ${repliesLabel(done.length)}`)}>
          {fresh > 0 && <span className="thread-link__dot" aria-label={L(`${fresh} nova${fresh === 1 ? '' : 's'}`, `${fresh} new`)} />}
          <Faces authors={authors} busy={new Set(working.flatMap((m) => (m.author.kind === 'agent' ? [m.author.id] : [])))} />
          {asks ? (
            <span className="thread-link__asks">
              {asks.run!.status === 'waiting_input' ? (asks.run!.askedTo && asks.run!.askedTo !== you ? L(`${nameOf(asks)} perguntou algo a ${someone(asks.run!.askedTo)}`, `${nameOf(asks)} asked ${someone(asks.run!.askedTo)} something`) : L(`${nameOf(asks)} te perguntou algo`, `${nameOf(asks)} asked you something`)) : L(`${nameOf(asks)} pede aprovação`, `${nameOf(asks)} asks for approval`)}
            </span>
          ) : busy.length > 0 ? (
            <span className="shimmer">{L(`${busy.join(' e ')} ${busy.length === 1 ? 'está' : 'estão'} respondendo…`, `${busy.join(' and ')} ${busy.length === 1 ? 'is' : 'are'} replying…`)}</span>
          ) : (
            <strong key={done.length} className="thread-link__count">
              {repliesLabel(done.length)}
              {fresh > 0 && <span className="thread-link__fresh">{L(` · ${fresh} nova${fresh === 1 ? '' : 's'}`, ` · ${fresh} new`)}</span>}
            </strong>
          )}
          {!busy.length && !asks && last && (
            <span className="thread-link__when">
              <span className="thread-link__ago">{ago(saidAt(last))}</span>
              <span className="thread-link__see">{L('Ver thread', 'View thread')}</span>
            </span>
          )}
          <Icon name="chevron" size={12} />
        </button>
      )}
    </>
  )
}

// A thread on the side: the message that started it, set apart, then its replies and a
// field that answers there.
function ThreadPanel({ rootId, conv, title, members }: { rootId: string; conv: Conversation; title: string; members: Agent[] }): ReactNode {
  const root = useStore((s) => messageById(s, rootId, conv.id))
  const replies = useStore((s) => repliesOf(s, conv.id, rootId))
  // A thread from before what's here comes from the core; only then is it gone if it isn't there.
  const [looked, setLooked] = useState<string | null>(null)
  useEffect(() => {
    if (!root) void loadThread(rootId).finally(() => setLooked(rootId))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootId, !root])
  const agents = useStore((s) => s.agents)
  const [showSummary, setShowSummary] = useState(false)
  const said = replies.filter((m) => m.author.kind !== 'system' && m.run?.status !== 'working').length
  const replying = [...new Set(replies.flatMap((m) => (m.run?.status === 'working' && m.author.kind === 'agent' ? [m.author.id] : [])))].map((id) => agents.find((a) => a.id === id)?.name ?? L('agente', 'agent'))
  // Open, the thread is seen as it goes; closed, up to when it closed.
  const latest = replies.at(-1)?.at
  useEffect(() => {
    seeThread(rootId)
    return () => seeThread(rootId)
  }, [rootId, latest])
  // Esc closes it, unless something on top (a menu, a window) takes the key first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal, .menu, .mention-menu, .lightbox')) return
      openPanel(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const lead = root && (
    <div className="thread__lead">
      <MessageRow message={root} grouped={false} />
      <div className="thread__divider">
        {replying.length > 0 ? (
          <span key="replying" className="shimmer">
            {L(`${replying.join(' e ')} ${replying.length === 1 ? 'está' : 'estão'} respondendo…`, `${replying.join(' and ')} ${replying.length === 1 ? 'is' : 'are'} replying…`)}
          </span>
        ) : (
          <span key={said}>{said > 0 ? repliesLabel(said) : L('Ainda sem respostas', 'No replies yet')}</span>
        )}
      </div>
    </div>
  )
  return (
    <aside className="side-panel side-panel--thread">
      <PanelResize />
      <header className="side-panel__head">
        <Icon name="thread" size={14} />
        <strong className="side-panel__title">{L('Thread', 'Thread')}</strong>
        <span className="side-panel__where">{L(`em ${title}`, `in ${title}`)}</span>
        <span className="grow" />
        {root && (
          <button
            className={`icon-btn ${showSummary ? 'is-active' : ''}`}
            title={L('O que esta thread já cobriu', 'What this thread has covered')}
            aria-label={L('Resumo da thread', 'Thread summary')}
            aria-pressed={showSummary}
            onClick={() => setShowSummary(!showSummary)}
          >
            <Icon name="book" size={14} />
          </button>
        )}
        <button className="icon-btn" title={L('Fechar', 'Close')} aria-label={L('Fechar a thread', 'Close the thread')} onClick={() => openPanel(null)}>
          <Icon name="x" size={14} />
        </button>
      </header>
      {root?.conversationId === conv.id ? (
        <>
          {showSummary && <ThreadSummaryPanel root={root} replies={replies} onClose={() => setShowSummary(false)} />}
          <MessageList key={rootId} messages={replies} conversationId={conv.id} lead={lead} />
          <Composer conversationId={conv.id} threadId={rootId} members={members} placeholder={L('Responder na thread…', 'Reply in thread…')} />
        </>
      ) : looked === rootId || root ? (
        <p className="empty">{L('Essa mensagem não está mais aqui.', 'That message is no longer here.')}</p>
      ) : null}
    </aside>
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
  // The agents read it as the conversation so far: a channel's is written by whoever manages it.
  const editable = useStore((s) => conv.kind !== 'channel' || canEditChannel(s, conv))
  const since = messages.filter((m) => m.author.kind !== 'system' && m.text.trim() && m.at > (conv.summaryUntil ?? 0)).length
  return (
    <SummaryBox
      title={L('Resumo da conversa', 'Conversation summary')}
      summary={conv.summary}
      at={conv.summaryAt}
      ready={since > SUMMARY_WINDOW}
      notYet={L(`As últimas ${SUMMARY_WINDOW} mensagens sempre vão inteiras; ainda não há o que resumir.`, `The last ${SUMMARY_WINDOW} messages always go in full; nothing to summarize yet.`)}
      empty={L(`Quando passar de ${SUMMARY_MAX_AFTER} mensagens, o que sair da janela vira um resumo aqui.`, `Past ${SUMMARY_MAX_AFTER} messages, what leaves the window becomes a summary here.`)}
      hint={L(
        `Numa thread, os agentes leem só a thread. Este resumo vai pras respostas fora de threads, como as das rotinas: elas recebem ${conv.summary ? 'este resumo e ' : ''}as ${since} mensagens ${conv.summary ? 'desde ele' : 'da conversa'}.`,
        `In a thread, agents read only the thread. This summary goes to replies outside threads, like routines': they get ${conv.summary ? 'this summary and ' : ''}the ${since} messages ${conv.summary ? 'since it' : 'of the conversation'}.`
      )}
      onSummarize={() => summarizeNow(conv.id)}
      {...(editable ? { onSave: (text: string) => editSummary(conv.id, text) } : {})}
      onClose={onClose}
    />
  )
}

// A thread's own summary: made once it's quiet for a while (or grows long), and where the
// memories about me in it come from.
function ThreadSummaryPanel({ root, replies, onClose }: { root: Message; replies: Message[]; onClose: () => void }): ReactNode {
  const s = root.threadSummary
  const since = [root, ...replies].filter((m) => m.author.kind !== 'system' && m.text.trim() && m.at > (s?.until ?? 0)).length
  return (
    <SummaryBox
      title={L('Resumo da thread', 'Thread summary')}
      summary={s?.text}
      at={s?.at}
      ready={since > 0}
      notYet={L('Nada novo desde o resumo.', 'Nothing new since the summary.')}
      empty={L('Quando a thread ficar parada por alguns minutos, o que foi dito vira um resumo aqui, e as memórias sobre você saem dele.', 'Once the thread is quiet for a few minutes, what was said becomes a summary here, and the memories about you come from it.')}
      hint={L(
        `Os agentes de outras threads acham esta por ele, quando procuram. Aqui, eles recebem a thread inteira até ${SUMMARY_MAX_AFTER} respostas; passando disso, este resumo e as mais recentes.`,
        `Agents in other threads find this one by it when they search. Here, they get the whole thread up to ${SUMMARY_MAX_AFTER} replies; past that, this summary and the newest ones.`
      )}
      onSummarize={() => summarizeThreadNow(root.id)}
      onSave={(text) => editThreadSummary(root.id, text)}
      onClose={onClose}
    />
  )
}

function SummaryBox(p: {
  title: string
  summary?: string
  at?: number
  ready: boolean // there's something new to summarize
  notYet: string // why not, when there isn't
  empty: string
  hint: string
  onSummarize: () => void
  onSave?: (text: string) => void // none: read only (a channel someone else manages)
  onClose: () => void
}): ReactNode {
  const [text, setText] = useState(p.summary ?? '')
  const [asked, setAsked] = useState<number | null>(null)
  useEffect(() => setText(p.summary ?? ''), [p.summary, p.at])
  useEffect(() => {
    if (asked === null) return
    const t = setTimeout(() => setAsked(null), 120_000) // give up waiting; the core logs failures
    return () => clearTimeout(t)
  }, [asked])
  const busy = asked !== null && (p.at ?? 0) < asked
  const changed = text.trim() !== (p.summary ?? '').trim()

  return (
    <div className="summary">
      <div className="summary__head">
        <strong>{p.title}</strong>
        <span className="muted small">{p.at ? L(`atualizado ${time(p.at)}`, `updated ${time(p.at)}`) : L('ainda não há', 'none yet')}</span>
        <span className="grow" />
        <button
          className="btn btn--sm"
          disabled={busy || !p.ready}
          title={p.ready ? undefined : p.notYet}
          onClick={() => {
            setAsked(Date.now())
            p.onSummarize()
          }}
        >
          {busy ? L('Resumindo…', 'Summarizing…') : L('Resumir agora', 'Summarize now')}
        </button>
        <button className="icon-btn" title={L('Fechar', 'Close')} onClick={p.onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {p.summary !== undefined || changed ? <textarea rows={6} value={text} readOnly={!p.onSave} onChange={(e) => setText(e.target.value)} /> : <p className="muted small">{p.empty}</p>}
      <div className="row row--between">
        <span className="hint">{p.hint}</span>
        {changed && p.onSave && (
          <button className="btn btn--sm btn--primary" onClick={() => p.onSave?.(text)}>
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
      {!scopePerson(memory.scope) && <span className="tag">{L('nota dele', 'its own note')}</span>}
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

// A question an agent asked (ask_user). Alone (a desktop), it's mine: my next message answers it.
// With a team it says whom it's for; who may answer it (the person, whoever covers for them, an
// admin, or past the deadline the requester) gets a field; in my DM, a question to someone else
// first asks me whether it may go. With decisions (ask_user's options), it's their card
// (TeamAsk): answered on it by whoever may answer the question.
// What someone was typing to answer a question, kept by question: if someone else answers first,
// or the card moves (Pra você drops it), it's still there, with who answered.
export const questionDrafts = new Map<string, string>()

export function QuestionCard(props: { id: string; agentName?: string; askedTo?: string; question: string; decisions?: Decision[]; answers?: (Answer | null)[]; answeredInText?: boolean; answered: boolean; answeredBy?: string; inbox?: boolean }): ReactNode {
  return props.decisions?.length ? <TeamAsk {...props} decisions={props.decisions} /> : <TextQuestion {...props} />
}

function TextQuestion({ id, agentName, askedTo, question, answered, answeredBy, inbox }: { id: string; agentName?: string; askedTo?: string; question: string; answered: boolean; answeredBy?: string; inbox?: boolean }): ReactNode {
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const admin = useStore(amAdmin)
  const waiting = useStore((s) => s.inbox.questions.find((q) => q.id === id))
  const target = useStore((s) => personById(s, askedTo ?? waiting?.askedTo))
  const answerer = useStore((s) => (answeredBy && answeredBy !== s.you ? personById(s, answeredBy) : undefined))
  const [text, setTextState] = useState(() => questionDrafts.get(id) ?? '')
  const setText = (t: string): void => {
    if (t) questionDrafts.set(id, t)
    else questionDrafts.delete(id)
    setTextState(t)
  }
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const who = agentName ?? L('O agente', 'The agent')
  if (!team || !target)
    return (
      <div className={`question ${answered ? 'is-answered' : ''}`}>
        <span className="question__label">{answered ? L('Perguntou', 'Asked') : L('Pergunta pra você', 'A question for you')}</span>
        <p>{question}</p>
        {!answered && <span className="hint">{L('Sua próxima mensagem aqui é a resposta.', 'Your next message here is the answer.')}</span>}
      </div>
    )
  const toMe = target.id === you
  if (answered)
    return (
      <div className="question is-answered">
        <span className="question__label">
          {toMe ? L('Perguntou', 'Asked') : L(`Perguntou a ${target.name}`, `Asked ${target.name}`)}
          {answerer && ` · ${L(`Respondida por ${answerer.name}`, `Answered by ${answerer.name}`)}`}
        </span>
        <p>{question}</p>
        {/* Answered by someone else while this person was typing: what they wrote stays, and says why it didn't go. */}
        {text.trim() && (
          <>
            <input className="grow" readOnly value={text} aria-label={L('Sua resposta (não enviada)', 'Your answer (not sent)')} />
            {!answerer && <span className="note note--error">{error || L('Essa pergunta já foi respondida.', 'That question was already answered.')}</span>}
          </>
        )}
      </div>
    )
  if (waiting?.confirm === 'pending')
    return (
      <div className="question">
        <span className="question__label">{L(`${who} quer perguntar a ${target.name}`, `${who} wants to ask ${target.name}`)}</span>
        <p>{question}</p>
        <span className="hint">{L(`${target.name} vê só a pergunta, nunca esta conversa.`, `${target.name} sees the question only, never this conversation.`)}</span>
        <div className="row question__actions">
          <button className="btn btn--primary btn--sm" onClick={() => confirmQuestion(id, true)}>
            {L(`Pode perguntar a ${target.name}`, `Go ahead and ask ${target.name}`)}
          </button>
          <button className="btn btn--sm" onClick={() => confirmQuestion(id, false)}>
            {L('Não pergunte', "Don't ask")}
          </button>
        </div>
      </div>
    )
  const mayAnswer = !!waiting || admin
  const send = (): void => {
    if (!text.trim()) return
    setSending(true)
    answerQuestion(id, text.trim()).then(
      () => setText(''),
      (e: unknown) => (setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)), setSending(false))
    )
  }
  return (
    <div className="question">
      <span className="question__label">{toMe ? L(`${who} pergunta a você`, `${who} asks you`) : L(`${who} pergunta a ${target.name}`, `${who} asks ${target.name}`)}</span>
      <p>{question}</p>
      {toMe && !inbox ? (
        <span className="hint">{L('Sua próxima mensagem aqui é a resposta.', 'Your next message here is the answer.')}</span>
      ) : mayAnswer ? (
        <form className="row question__answer" onSubmit={(e) => (e.preventDefault(), send())}>
          <input className="grow" value={text} placeholder={toMe ? L('Sua resposta', 'Your answer') : L(`Responder no lugar de ${target.name}`, `Answer for ${target.name}`)} onChange={(e) => (setText(e.target.value), setError(''))} />
          <button className="btn btn--primary btn--sm" disabled={sending || !text.trim()}>
            {L('Responder', 'Answer')}
          </button>
        </form>
      ) : (
        <span className="hint">{L(`Esperando ${target.name} responder.`, `Waiting for ${target.name} to answer.`)}</span>
      )}
      {error && <span className="note note--error">{error}</span>}
    </div>
  )
}


// A question with decisions, with a team: whom it's for and who asked; answered on the card by
// whoever may (the person, whoever covers for them or, past the deadline, the requester: those
// who have it in For you; an admin, after choosing to answer for them); for anyone else, to read.
function TeamAsk({ id, agentName, askedTo, decisions, answers, answeredInText, answered, answeredBy, inbox }: { id: string; agentName?: string; askedTo?: string; decisions: Decision[]; answers?: (Answer | null)[]; answeredInText?: boolean; answered: boolean; answeredBy?: string; inbox?: boolean }): ReactNode {
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const admin = useStore(amAdmin)
  const waiting = useStore((s) => s.inbox.questions.find((q) => q.id === id))
  const target = useStore((s) => personById(s, askedTo ?? waiting?.askedTo))
  const answerer = useStore((s) => (answeredBy && answeredBy !== s.you ? personById(s, answeredBy) : undefined))
  const [answering, setAnswering] = useState(false)
  const who = agentName ?? L('O agente', 'The agent')
  const card = { id, questions: decisions, saved: answers }
  if (!team || !target) return <AskCard {...card} mode={answered ? 'done' : 'answer'} badge={answered ? L('Respondida', 'Answered') : L('Esperando você', 'Waiting for you')} answeredInText={!!answeredInText} />
  const toMe = target.id === you
  const asked = toMe ? L(`${who} pergunta a você`, `${who} asks you`) : L(`${who} pergunta a ${target.name}`, `${who} asks ${target.name}`)
  if (answered)
    return <AskCard {...card} mode="done" badge={answerer ? L(`Respondida por ${answerer.name}`, `Answered by ${answerer.name}`) : L('Respondida', 'Answered')} byline={toMe ? L(`${who} perguntou a você`, `${who} asked you`) : L(`${who} perguntou a ${target.name}`, `${who} asked ${target.name}`)} answeredInText={!!answeredInText} />
  if (waiting?.confirm === 'pending')
    return (
      <AskCard {...card} mode="view" badge={L(`${who} quer perguntar a ${target.name}`, `${who} wants to ask ${target.name}`)}>
        <p className="ask__note">{L(`${target.name} vê só a pergunta, nunca esta conversa.`, `${target.name} sees the question only, never this conversation.`)}</p>
        <div className="ask__foot">
          <button className="btn btn--sm" onClick={() => confirmQuestion(id, false)}>
            {L('Não pergunte', "Don't ask")}
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => confirmQuestion(id, true)}>
            {L(`Pode perguntar a ${target.name}`, `Go ahead and ask ${target.name}`)}
          </button>
        </div>
      </AskCard>
    )
  if (waiting || (admin && answering)) return <AskCard {...card} mode="answer" badge={waiting ? L('Esperando você', 'Waiting for you') : L(`Respondendo no lugar de ${target.name}`, `Answering for ${target.name}`)} byline={asked} />
  return (
    <AskCard {...card} mode="view" badge={L(`Esperando ${target.name}`, `Waiting for ${target.name}`)} byline={asked}>
      {admin && !inbox && (
        <div className="ask__foot">
          <button className="btn btn--sm" onClick={() => setAnswering(true)}>
            {L(`Responder no lugar de ${target.name}`, `Answer for ${target.name}`)}
          </button>
        </div>
      )}
    </AskCard>
  )
}

// What remarkMentions marked: an agent's @handle becomes its chip, which opens its profile. A handle
// no agent has stays as it was written, in bold, as any @ always was.
function MentionSpan({ node: _, ...props }: ComponentProps<'span'> & ExtraProps): ReactNode {
  const handle = (props as Record<string, unknown>)['data-mention']
  if (typeof handle !== 'string') return <span {...props} />
  return <Mention handle={handle} />
}
function Mention({ handle }: { handle: string }): ReactNode {
  const agent = useStore((s) => s.agents.find((a) => a.handle.toLowerCase() === handle.toLowerCase()))
  if (!agent) return <strong>@{handle}</strong>
  return (
    <AgentCardButton agentId={agent.id} className={`mention c-${agent.color}`} style={ownColor(agent)} title={agent.role ? `${agent.name} · ${agent.role}` : agent.name}>
      <AgentAvatar agent={agent} size={16} />
      <span>@{agent.handle}</span>
    </AgentCardButton>
  )
}
const plainMarkdown = { pre: CodeBlock, a: (p: { href?: string; children?: ReactNode }) => <WikiLink href={p.href}>{p.children}</WikiLink>, span: MentionSpan }

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
  // Open while the agent works, so its steps read as they go, unless the person closes it; closed after.
  const [toggled, setOpen] = useState<boolean | null>(null)
  const working = run.status === 'working'
  const open = toggled ?? working
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
  const [whole, setWhole] = useState(false)
  const [allInput, setAllInput] = useState(false)
  return (
    <li className={`step step--${step.status}${step.error || step.input || step.output ? ' step--why' : ''}`}>
      <span className="step__icon">
        {step.status === 'running' ? <span className="spinner" /> : <Icon name={step.status === 'done' ? 'check' : 'x'} size={12} />}
      </span>
      <span className="step__label">{step.label}</span>
      {step.note ? <span className="step__note">{step.note}</span> : step.detail && <code className="step__detail">{step.detail}</code>}
      {step.ms !== undefined && <span className="step__ms">{duration(step.ms)}</span>}
      {step.input && (
        // What it asked (the SQL, the path): two lines, the whole of it on a click.
        <code className={`step__input${allInput ? ' is-whole' : ''}`} title={allInput ? undefined : L('Ver tudo', 'See all')} onClick={() => setAllInput(!allInput)}>
          <span className="step__clamp">{step.input}</span>
        </code>
      )}
      {step.output && <span className="step__output">→ {step.output}</span>}
      {step.error && (
        // Why it failed, in the tool's words: a few lines, the whole of it on a click.
        <span className={`step__error${whole ? ' is-whole' : ''}`} title={whole ? undefined : L('Ver tudo', 'See all')} onClick={() => setWhole(!whole)}>
          {step.error}
        </span>
      )}
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
  // With a team: who asked, whose decision it is, and who decided; only who may decide gets buttons.
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const mayDecide = useStore((s) => canDecide(s, approval))
  const decider = useStore((s) => personById(s, agent?.owner))
  const requester = useStore((s) => personById(s, approval.requestedBy))
  const decidedBy = useStore((s) => (approval.decidedBy ? personName(s, approval.decidedBy) : me.name))
  const [refusing, setRefusing] = useState(false)
  const [reason, setReason] = useState('')
  const summary = argSummary(approval.args)
  // A runner's call (Composio's): the actions it runs are what's being approved.
  const runner = isRunner(approval.tool)
  const actions = runner ? innerActions(approval.tool, approval.args) : undefined
  // What "always allow" covers there: each inner tool that asked, on its own (none for a raw request or code).
  const forGood = runner ? runnerRules(approval.connectorId, approval.tool, approval.args)?.map((r) => r.slice(r.indexOf(':') + 1)) : undefined
  // Hold to approve: CSS fills the button in 1.5s (.is-holding) and this timer approves, so the
  // approval no longer depends on a transitionend that a re-render or a throttled window can drop.
  // Letting go drains the fill back and clears the timer. Space or Enter hold too.
  const [holding, setHolding] = useState(false)
  const startHold = (): void => setHolding(true)
  const cancelHold = (): void => setHolding(false)
  useEffect(() => {
    if (!holding) return
    const t = setTimeout(() => {
      setHolding(false)
      decideApproval(approval.id, 'approved')
    }, 1500)
    return () => clearTimeout(t)
  }, [holding, approval.id])

  const decided = approval.state !== 'pending'
  // A command on the agent's computer: what it does, in words, and the command itself.
  const onComputer = approval.connectorId === COMPUTADOR
  const kinds = onComputer ? shellActions(String(approval.args['command'] ?? '')) : []
  // "Sempre permitir": a connector tool for good, or, for a command or a PR, that kind of action on the agent's page.
  const canAlways = approval.tool !== ACCESS_REQUEST && approval.tool !== 'abrir_pr' && approval.connectorId !== 'navegador' && approval.connectorId !== 'apps' && !runner && (!onComputer || kinds.length > 0)
  const alwaysTitle = onComputer
    ? L(`Daqui pra frente ${agent?.name ?? 'o agente'} faz sozinho: ${kinds.map((k) => kindLabel(k).toLowerCase()).join(', ')}. Dá pra mudar na página dele.`, `From now on ${agent?.name ?? 'the agent'} does it alone: ${kinds.map((k) => kindLabel(k).toLowerCase()).join(', ')}. You can change it on its page.`)
    : L(`Daqui pra frente ${agent?.name ?? 'o agente'} usa “${toolWords(approval.tool)}” no ${approval.connectorName} sem pedir. Dá pra tirar na página dele.`, `From now on ${agent?.name ?? 'the agent'} uses “${toolWords(approval.tool)}” in ${approval.connectorName} without asking. You can take it back on its page.`)

  return (
    <div className={`approval approval--${approval.state} ${compact ? 'approval--compact' : ''}`}>
      <div className="approval__head">
        <span className="approval__badge">
          <Icon name="shield" size={13} />
          {approval.state === 'pending' ? (mayDecide ? L('Esperando você', 'Waiting for you') : L('Esperando aprovação', 'Waiting for approval')) : approval.state === 'approved' ? L('Aprovado', 'Approved') : approval.state === 'refused' ? L('Recusado', 'Refused') : L('Expirado', 'Expired')}
        </span>
        {approval.highRisk && <span className="tag tag--danger">{L('alto risco', 'high risk')}</span>}
      </div>
      <div className="approval__title">
        {approval.tool === ACCESS_REQUEST ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('pede acesso ao', 'asks for access to')} <strong>{approval.connectorName}</strong>: {approval.args['nivel'] === 'read_write' ? L('ler e escrever', 'read and write') : L('ler', 'read')}
          </>
        ) : onComputer ? (
          <>
            {agent?.name ?? L('Agente', 'Agent')} {L('quer', 'wants to')} <strong>{kinds.length ? kinds.map(actionVerb).join(L(' e ', ' and ')) : L('rodar um comando', 'run a command')}</strong> {L('no computador dele', 'on its computer')}
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
      {runner && (
        <div className="approval__args small">
          {actions ? (
            <>
              <p className="muted">{L(`${actions.length === 1 ? 'Ação' : `${actions.length} ações`} que esta chamada roda:`, `${actions.length === 1 ? 'The action' : `${actions.length} actions`} this call runs:`)}</p>
              {actions.map((a, i) => (
                <p key={i}>
                  <code>{actionLabel(a)}</code>
                </p>
              ))}
            </>
          ) : (
            <p>{L('Chamada fora do formato documentado: confira os detalhes exatos antes de aprovar.', 'A call outside the documented shape: check the exact details before approving.')}</p>
          )}
        </div>
      )}
      {approval.why && <p className="approval__why">{approval.why}</p>}
      {team && <ApprovalRoute approval={approval} agent={agent} requester={requester} decider={decider} you={you} />}
      {/* The title already says it all for an access request, an app or the browser. */}
      {onComputer && <pre className="approval__command">{String(approval.args['command'] ?? '')}</pre>}
      {approval.tool !== ACCESS_REQUEST && approval.connectorId !== 'apps' && approval.connectorId !== 'navegador' && !runner && !onComputer && summary.shown.length > 0 && (
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
          {approval.state === 'expired' ? L('Expirou sem decisão', 'Expired without a decision') : L(`${approval.state === 'approved' ? 'Aprovado' : 'Recusado'} por ${decidedBy}`, `${approval.state === 'approved' ? 'Approved' : 'Refused'} by ${decidedBy}`)}
          {approval.decidedAt ? ` · ${time(approval.decidedAt)}` : ''}
          {approval.reason ? ` · “${approval.reason}”` : ''}
          {approval.outcome ? ` · ${approval.outcome}` : ''}
        </div>
      ) : !mayDecide ? (
        <div className="approval__decided">
          {approval.requestedBy === you
            ? L(`Você pediu. Esperando ${decider?.name ?? 'um admin'} decidir.`, `You asked. Waiting for ${decider?.name ?? 'an admin'} to decide.`)
            : L(`Esperando ${decider?.name ?? 'um admin'} decidir. Só ${decider ? `${decider.name} e os admins aprovam` : 'os admins aprovam'}.`, `Waiting for ${decider?.name ?? 'an admin'} to decide. Only ${decider ? `${decider.name} and the admins approve` : 'the admins approve'}.`)}
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
            // The hold can't depend on the pointer staying inside the button: taking capture makes
            // the browser fire pointerout/pointerleave on the button at once, and a cursor that drifts
            // off fires them too. Capture keeps the release, and pointercancel is the real interruption.
            <button
              className={`btn btn--primary btn--hold ${holding ? 'is-holding' : ''}`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                startHold()
              }}
              onPointerUp={cancelHold}
              onPointerCancel={cancelHold}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && (e.preventDefault(), startHold())}
              onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && cancelHold()}
              onBlur={cancelHold}
            >
              {/* One label for both states: swapping it to "Hold…" shrank the button under the
                  cursor, and the fill from ::before is the feedback anyway. */}
              <span>{L('Segure pra aprovar · ação de alto risco', 'Hold to approve · high-risk action')}</span>
            </button>
          ) : (
            <>
              <button className="btn btn--primary" onClick={() => decideApproval(approval.id, 'approved')}>
                {L('Aprovar', 'Approve')}
              </button>
              {canAlways && (
                <button className="btn" title={alwaysTitle} onClick={() => decideApproval(approval.id, 'approved', undefined, true)}>
                  {L('Aprovar e sempre permitir', 'Approve and always allow')}
                </button>
              )}
              {forGood && (
                <button
                  className="btn"
                  title={L(
                    `Daqui pra frente ${agent?.name ?? 'o agente'} roda ${forGood.join(', ')} pelo ${approval.connectorName} sem pedir, em qualquer chamada. As outras ações continuam pedindo. Dá pra tirar na página dele.`,
                    `From now on ${agent?.name ?? 'the agent'} runs ${forGood.join(', ')} through ${approval.connectorName} without asking, in any call. Other actions still ask. You can take it back on its page.`
                  )}
                  onClick={() => decideApproval(approval.id, 'approved', undefined, true)}
                >
                  {L(`Aprovar e sempre permitir ${forGood.join(', ')}`, `Approve and always allow ${forGood.join(', ')}`)}
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

// "Ana Souza" → "ana" (or "anasouza" when another Ana is here): how the core finds a person by @.
const fold = (t: string): string => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
function peopleHandles(people: Person[]): { person: Person; handle: string }[] {
  const words = people.map((p) => fold(p.name).split(/\s+/).map((w) => w.replace(/[^a-z0-9_-]/g, '')).filter(Boolean))
  return people.map((person, i) => {
    const first = words[i]![0] ?? ''
    const shared = words.filter((w) => w[0] === first).length > 1
    return { person, handle: shared ? words[i]!.join('') : first }
  })
}

// Whose request it is and whose decision: "Pedido do Bruno · Vai pro Edu, dono do Leo", or a routine's.
function ApprovalRoute({ approval, agent, requester, decider, you }: { approval: Approval; agent?: Agent; requester?: Person; decider?: Person; you: string }): ReactNode {
  const cap = (t: string): string => t.charAt(0).toUpperCase() + t.slice(1)
  const asked = approval.behalf ? cap(approval.behalf) : requester ? (requester.id === you ? L('Pedido seu', 'Your request') : L(`Pedido de ${requester.name}`, `Asked by ${requester.name}`)) : undefined
  const goes = decider ? (decider.id === you ? L(`Vai pra você, dono de ${agent?.name ?? 'o agente'}`, `Goes to you, ${agent?.name ?? 'the agent'}'s owner`) : L(`Vai pra ${decider.name}, dono de ${agent?.name ?? 'o agente'}`, `Goes to ${decider.name}, ${agent?.name ?? 'the agent'}'s owner`)) : L('Vai pros admins', 'Goes to the admins')
  return (
    <div className="approval__route">
      {asked && <span className="tag">{asked}</span>}
      <span className="tag">{goes}</span>
    </div>
  )
}

// Images go to the models as they are when small; big ones are scaled down
// (longest side MAX_SIDE) and re-encoded, so any screenshot or photo fits.
const MAX_SIDE = 2000
const MAX_RAW = 3_700_000 // base64 under the models' 5 MB

// An image (with what shows it) or, in the app, any other file: `url` empty, its text goes to the agents.
type Attached = ImageUpload & { url: string; size?: number }
const isFile = (a: Attached): boolean => !a.url

const dataUrlOf = (blob: Blob): Promise<string> =>
  new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(blob)
  })

async function prepareFile(file: File): Promise<Attached | string> {
  if (file.size === 0) return L(`${file.name} está vazio.`, `${file.name} is empty.`)
  if (file.size > MAX_FILE_BYTES) return L(`${file.name} passa de ${MAX_FILE_BYTES / 1024 / 1024} MB.`, `${file.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
  try {
    const url = await dataUrlOf(file)
    return { name: file.name || L('arquivo', 'file'), mime: file.type || 'application/octet-stream', data: url.slice(url.indexOf(',') + 1), url: '', size: file.size }
  } catch {
    return L(`Não deu pra abrir ${file.name}.`, `${file.name} couldn't be opened.`)
  }
}

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

// One draft per conversation (and per thread), kept while the app runs: leaving a
// channel doesn't lose the message you were typing.
const drafts = new Map<string, { text: string; images: Attached[] }>()
// On a server the page reloads to reconnect (src/server's bridge): the texts are kept in this
// tab for that moment, and come back once. Images aren't: attach them again.
const RELOAD_KEY = 'tucano-drafts'
try {
  const kept = JSON.parse(sessionStorage.getItem(RELOAD_KEY) ?? '{}') as Record<string, string>
  for (const [k, text] of Object.entries(kept)) if (typeof text === 'string' && text.trim()) drafts.set(k, { text, images: [] })
  sessionStorage.removeItem(RELOAD_KEY)
} catch {}
// What a conversation's field starts with next time it opens (the introduction leaves the first message there, unsent).
export const setComposerDraft = (key: string, text: string): void => void drafts.set(key, { text, images: [] })
export const composerDraft = (key: string): string => drafts.get(key)?.text ?? ''
const keepForReload = (current?: { key: string; text: string }): void => {
  const texts: Record<string, string> = {}
  for (const [k, d] of drafts) if (d.text.trim()) texts[k] = d.text
  if (current?.text.trim()) texts[current.key] = current.text
  try {
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify(texts))
  } catch {}
}

type DictationState = 'idle' | 'starting' | 'recording' | 'transcribing'
type DictationControls = { press: () => void; release: () => void; stop: () => void; cancel: () => void; startedAt: () => number }

const NOT_READY = (): string => L('Para ditar, clique no microfone e ative o ditado.', 'To dictate, click the microphone and turn dictation on.')
const SHORT_MS = 300
const HOLD_MS = 400 // held at least this long, letting go ends it (push to talk); a click starts it, the next one ends it

// Click to record, click again to transcribe (or hold and let go). The text goes to the field to be reviewed, never sent:
// dictation gets names wrong, and a message sets an agent working.
export function useDictation(insert: (text: string) => void, setNote: (note: string) => void, conversationId: string): [DictationState, DictationControls] {
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

export function VoiceButton({ controls, state }: { controls: DictationControls; state: DictationState }): ReactNode {
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

// The field sizes itself to its text where CSS can (styles.css: field-sizing).
const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')
const TYPE = ['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'word-spacing', 'tab-size', 'text-transform', 'text-indent', 'padding']

// What a paste attaches. Copying text from a spreadsheet, a page or a document often brings a
// picture of it too: that pastes as the text, not as an image the person never meant to send.
// A file copied in Finder or Explorer comes with its name as the text, and still attaches.
export function pastedFiles(files: File[], text: string, server: boolean): File[] {
  const usable = files.filter((f) => server || f.type.startsWith('image/'))
  const typed = text.trim()
  if (!usable.length || !typed) return usable
  const names = new Set(files.map((f) => f.name))
  return typed.split(/\r?\n/).every((line) => names.has(line.trim().split('/').pop() ?? '')) ? usable : []
}

// `threadId`: it answers in the thread that message started, not in the conversation.
export function Composer({ conversationId, threadId, members, placeholder }: { conversationId: string; threadId?: string; members: Agent[]; placeholder: string }): ReactNode {
  const key = threadId ?? conversationId // the draft's
  // The field starts with the conversation's draft, not empty: StrictMode (in dev) unmounts
  // and mounts again at once, and saving an empty first render would wipe the draft.
  const [text, setText] = useState(() => drafts.get(key)?.text ?? '')
  const [images, setImages] = useState<Attached[]>(() => drafts.get(key)?.images ?? [])
  const [note, setNote] = useState('')
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null)
  const [active, setActive] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const mirror = useRef<HTMLDivElement>(null)
  const platform = useStore((s) => s.platform)
  const agents = useStore((s) => s.agents)
  const allAgents = useStore((s) => s.agents.filter(isTeam))
  const isDm = useStore((s) => s.conversations.find((c) => c.id === conversationId)?.kind === 'dm')
  const team = useStore(teamMode)
  const people = useStore((s) => s.people)
  const you = useStore((s) => s.you)
  // Replies at work and questions asked here: in this thread, or outside threads. Ids, not the
  // messages, so a reply's steps don't redraw the field.
  const working = useStore((s) => workingIds(s, conversationId, threadId))
  // With a team, only a question my message would answer (mine, or one I may answer) asks me here.
  const asker = useStore((s) => {
    const q = askerIn(s, conversationId, threadId)
    if (q && teamMode(s) && q.run?.askedTo && !s.inbox.questions.some((x) => x.id === q.id && x.confirm !== 'pending')) return undefined
    return q?.author.kind === 'agent' ? agentById(s, q.author.id)?.name : undefined
  })

  // What's typed but not sent, per conversation, so leaving a channel and coming
  // back keeps it (like a draft). In memory: closing the app drops the drafts.
  const live = useRef({ text, images })
  live.current = { text, images }
  useEffect(() => {
    const save = (): void => keepForReload({ key, text: live.current.text })
    window.addEventListener('tucano:reloading', save)
    return () => window.removeEventListener('tucano:reloading', save)
  }, [key])
  // Opened: the agent that answers here gets its process up while the person reads.
  useEffect(() => typing(conversationId, threadId, true), [conversationId, threadId])
  useEffect(() => {
    const draft = drafts.get(key)
    setText(draft?.text ?? '')
    setImages(draft?.images ?? [])
    setNote('')
    ref.current?.focus()
    return () => {
      const { text, images } = live.current
      if (text.trim() || images.length) drafts.set(key, { text, images })
      else drafts.delete(key)
    }
  }, [key])

  const addFiles = async (all: File[]): Promise<void> => {
    if (!all.length) return
    // On a server, a file that isn't an image goes up to it (~/Enviados) and the message says where:
    // an agent on that computer opens it there, and the link brings it back down.
    const upload = window.tucano.upload
    const files = upload ? all.filter((f) => IMAGE_MIMES.includes(f.type)) : all
    const others = upload ? all.filter((f) => !IMAGE_MIMES.includes(f.type)) : []
    if (others.length && upload) {
      setNote(L(`Enviando ${others.length === 1 ? others[0]!.name : `${others.length} arquivos`}…`, `Sending ${others.length === 1 ? others[0]!.name : `${others.length} files`}…`))
      const sent = await Promise.allSettled(others.map((f) => upload(f, 'message')))
      const paths = sent.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      if (paths.length) setText((t) => `${t.trim() ? `${t.trimEnd()}\n` : ''}${paths.map((p) => L(`Arquivo enviado: \`${p}\``, `File sent: \`${p}\``)).join('\n')}`)
      const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      setNote(failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '')
      if (!files.length) return void ref.current?.focus()
    }
    if (!files.length) return
    // In the app, a file that isn't an image goes with the message, and its text to the agents.
    const done = await Promise.all(files.map((f) => (f.type.startsWith('image/') ? prepareImage(f) : prepareFile(f))))
    const ok = done.filter((d): d is Attached => typeof d !== 'string')
    const errors = done.filter((d): d is string => typeof d === 'string')
    let over = ''
    setImages((cur) => {
      const all = [...cur, ...ok]
      const pics = all.filter((a) => !isFile(a))
      const docs = all.filter(isFile)
      over = pics.length > MAX_IMAGES_PER_MESSAGE ? L(`Até ${MAX_IMAGES_PER_MESSAGE} imagens por mensagem.`, `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`) : docs.length > MAX_FILES_PER_MESSAGE ? L(`Até ${MAX_FILES_PER_MESSAGE} arquivos por mensagem.`, `Up to ${MAX_FILES_PER_MESSAGE} files per message.`) : ''
      return [...pics.slice(0, MAX_IMAGES_PER_MESSAGE), ...docs.slice(0, MAX_FILES_PER_MESSAGE)]
    })
    setNote([...errors, over].filter(Boolean).join(' '))
    ref.current?.focus()
  }

  // A file dropped anywhere in the window comes here (and never opens in place of the app).
  // With a thread open there are two fields: a drop on the thread goes to its own.
  const inThread = !!threadId
  useEffect(() => {
    let depth = 0
    const files = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const mine = (e: DragEvent): boolean => !!(e.target instanceof Element && e.target.closest('.side-panel--thread')) === inThread
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
      if (mine(e)) void addFiles([...(e.dataTransfer?.files ?? [])])
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
  }, [inThread])

  // The field grows with its text, up to a point. With CSS field-sizing (Electron has it) that takes no
  // measuring on each key; elsewhere (a browser, on a server) the height is set from the text.
  const fit = (): void => {
    const el = ref.current
    if (!el || FIELD_SIZING) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }
  useLayoutEffect(fit, [text])
  // The copy follows the field's size as it changes (a new line, a narrower window), and takes its
  // type again only when the width changes (a phone's breakpoint): not on every key.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let width = -1
    const watch = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth
        fit()
        copyType()
      }
      followField()
    })
    watch.observe(el)
    return () => watch.disconnect()
  }, [])

  // The text shows from a copy behind the field, where an agent's @handle wears its color; the field
  // on top keeps the caret and the selection. The copy takes the field's type as computed (a phone
  // gets 16 px, and a field doesn't inherit letter spacing), its width (a scrollbar takes some) and
  // its size and its scroll, so both break the lines in the same places and scroll as far.
  const copyType = (): void => {
    const el = ref.current
    const m = mirror.current
    if (!el || !m) return
    const field = getComputedStyle(el)
    for (const p of TYPE) m.style.setProperty(p, field.getPropertyValue(p))
  }
  const followField = (): void => {
    const el = ref.current
    const m = mirror.current
    if (!el || !m) return
    m.style.width = `${el.clientWidth}px`
    m.style.height = `${el.clientHeight}px`
    m.scrollTop = el.scrollTop
  }
  const painted = splitMentions(text).map((p, i) => {
    const a = 'handle' in p ? agents.find((x) => x.handle.toLowerCase() === p.handle.toLowerCase()) : undefined
    return a ? (
      <mark key={i} className={`c-${a.color}`} style={ownColor(a)}>
        {p.text}
      </mark>
    ) : (
      p.text
    )
  })

  const agentOptions = mention
    ? members.filter((a) => a.handle.startsWith(mention.query.toLowerCase()) || a.name.toLowerCase().startsWith(mention.query.toLowerCase()))
    : []
  // With a team, the people too (not in a DM: no one else reads it), by the handle the core knows them by.
  const personOptions = mention && !isDm && team ? peopleHandles(people).filter((x) => x.person.id !== you && x.handle.startsWith(fold(mention.query))) : []
  const options: { key: string; handle: string; agent?: Agent; person?: Person }[] = [...agentOptions.map((a) => ({ key: a.id, handle: a.handle, agent: a })), ...personOptions.map((x) => ({ key: x.person.id, handle: x.handle, person: x.person }))]
  const outsiders = mention ? allAgents.filter((a) => !members.includes(a) && a.handle.startsWith(mention.query.toLowerCase())) : []

  const updateMention = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const m = /(^|\s)@([a-z0-9_-]*)$/i.exec(before)
    if (m) {
      setMention({ query: m[2] ?? '', start: caret - (m[2]?.length ?? 0) - 1 })
      setActive(0)
    } else setMention(null)
  }

  const pick = (a: { handle: string }): void => {
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
  const [voice, voiceControls] = useDictation(insert, setNote, key)

  const submit = (): void => {
    if (!text.trim() && images.length === 0) return
    sendMessage(
      conversationId,
      text,
      images.filter((a) => !isFile(a)).map(({ name, mime, data }) => ({ name, mime, data })),
      threadId,
      images.filter(isFile).map(({ name, data }) => ({ name, data }))
    )
    drafts.delete(key)
    live.current = { text: '', images: [] } // gone with the message, even if the field goes before it draws again
    setText('')
    setImages([])
    setNote('')
    setMention(null)
  }

  return (
    <div className="composer-wrap">
      {dragging && !inThread && (
        <div className="drop-overlay">
          <div className="drop-overlay__card">
            <Icon name="image" size={28} />
            <strong>{L('Solte pra anexar', 'Drop to attach')}</strong>
            <span className="muted">{L('Os agentes veem o conteúdo junto com a mensagem.', 'Agents see the content along with the message.')}</span>
          </div>
        </div>
      )}
      {mention && (options.length > 0 || outsiders.length > 0) && (
        <div className="mention-menu" role="listbox">
          {options.map((o, i) => (
            <button
              key={o.key}
              className={`mention-menu__item ${i === active ? 'is-active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(o)
              }}
            >
              {o.agent ? <AgentAvatar agent={o.agent} size={20} /> : <MeAvatar initials={initials(o.person!.name)} size={20} />}
              <strong>{o.agent?.name ?? o.person!.name}</strong>
              <span className="muted">@{o.handle}</span>
              <span className="mention-menu__role">{o.agent ? o.agent.role : o.person!.about || L('pessoa', 'person')}</span>
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
            {images.map((img, i) =>
              isFile(img) ? (
                <div key={i} className="composer__file" title={img.name}>
                  <Icon name="clip" size={13} />
                  <span className="composer__file-name">{img.name}</span>
                  <button className="composer__file-x" title={L('Tirar', 'Remove')} onClick={() => setImages(images.filter((_, j) => j !== i))}>
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : (
              <div key={i} className="composer__image" title={img.name}>
                <img src={img.url} alt={img.name} />
                <button className="composer__image-x" title={L('Tirar', 'Remove')} onClick={() => setImages(images.filter((_, j) => j !== i))}>
                  <Icon name="x" size={11} />
                </button>
              </div>
              )
            )}
          </div>
        )}
        <div className="composer__field">
          <div ref={mirror} className="composer__mirror" aria-hidden>
            {painted}
            {'\n'}
          </div>
          <textarea
            ref={ref}
            rows={1}
            onScroll={followField}
            value={text}
            placeholder={asker ? L(`Responder a ${asker}`, `Reply to ${asker}`) : placeholder}
            onChange={(e) => {
              setText(e.target.value)
              updateMention(e.target.value, e.target.selectionStart)
              if (e.target.value.trim()) typing(conversationId, threadId)
            }}
            onPaste={(e) => {
              const files = pastedFiles([...e.clipboardData.files], e.clipboardData.getData('text/plain'), true)
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
        </div>
        <div className="composer__bar">
          <VoiceButton controls={voiceControls} state={voice} />
          <button className="icon-btn" title={L('Anexar arquivo ou imagem (ou arraste e solte, ou cole)', 'Attach a file or an image (or drag and drop, or paste)')} onClick={() => picker.current?.click()}>
            <Icon name="clip" size={15} />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = ''
            }}
          />
          <span className={`composer__hint ${note ? 'composer__hint--warn' : ''}`}>
            {note || (members[0]?.kind === 'tuca' ? L('Nada é criado sem você', 'Nothing is created without you') : threadId ? L('Fica nesta thread · @ chama alguém', 'Stays in this thread · @ calls someone') : isDm ? L(`${members[0]?.name ?? 'O agente'} sempre responde aqui`, `${members[0]?.name ?? 'The agent'} always replies here`) : L('Quem estiver no canal responde · pra chamar alguém, use @', 'Whoever is in the channel replies · to call on someone, use @'))}
          </span>
          {working.length > 0 ? (
            <button className="btn btn--sm" onClick={() => working.forEach((id) => stopRun(id))}>
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
