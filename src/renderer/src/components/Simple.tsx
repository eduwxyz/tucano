// The simple view (Settings.uiMode 'simple'): the same Tucano for someone who doesn't want the whole app.
// They talk to the Tuca, who passes each request to whoever on the team does it, and see four things: where
// a request starts, what waits on them, the team, and their requests. Nothing is taken away: channels,
// the wiki, routines, connectors and settings keep running underneath, and each of their screens opens
// here, inside this frame, when something leads to it (a link in a reply, a row of the team). The whole
// app is one click away, at the top.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { questionsOf } from '../../../shared/questions'
import {
  agentById,
  ensureTuca,
  inboxCount,
  isTeam,
  messagesIn,
  navigate,
  removeTucaLeave,
  sendMessage,
  setUiMode,
  updateSettings,
  useStore,
  workingOn,
  type Agent,
  type Conversation,
  type State,
  type Message,
  type TucaLeave,
  type View
} from '../store'
import { dayOf, nudgeNow, tucaNudges } from '../tuca-nudges'
import { runStep } from '../board'
import { describeRoutine } from './Routines'
import { lastSaid, requestAgents, requestLine, requestState, stateLabel, tucaConversations, tucaOf, tucaTitle, type RequestState } from '../tuca-conversations'
import { ApprovalCard, Composer, ConversationView, MessageList, QuestionCard, setComposerDraft } from './Conversation'
import { AgentAvatar, ago, Icon, TucaMark, type IconName } from './ui'
import { draftAgent, ProposalCard, UseDraft } from './Tuca'

// ---------- the frame ----------

const RAIL: { view: View; label: () => string; icon: IconName; on: (v: View) => boolean }[] = [
  { view: { kind: 'approvals' }, label: () => L('Pra você', 'For you'), icon: 'bell', on: (v) => v.kind === 'approvals' },
  { view: { kind: 'team' }, label: () => L('Time', 'Team'), icon: 'users', on: (v) => v.kind === 'team' || v.kind === 'agent' },
  { view: { kind: 'requests' }, label: () => L('Conversas', 'Requests'), icon: 'thread', on: (v) => v.kind === 'requests' }
]

// The four places, with their names under them: someone new to this reads where each one goes.
export function SimpleRail(): ReactNode {
  const view = useStore((s) => s.view)
  const waiting = useStore(inboxCount)
  const me = useStore((s) => s.me)
  const onHome = view?.kind === 'home'
  return (
    <nav className="simple-rail" aria-label={L('Principal', 'Main')}>
      <button className={`simple-rail__new ${onHome ? 'is-on' : ''}`} aria-label={L('Novo pedido', 'New request')} aria-current={onHome ? 'page' : undefined} onClick={() => navigate({ kind: 'home' })}>
        <Icon name="plus" size={18} />
      </button>
      <span className="simple-rail__label simple-rail__label--new">{L('Novo', 'New')}</span>
      {RAIL.map((r) => {
        const on = !!view && r.on(view)
        const dot = r.view.kind === 'approvals' && waiting > 0
        return (
          <button key={r.view.kind} className={`simple-rail__item ${on ? 'is-on' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => navigate(r.view)}>
            <span className="simple-rail__icon">
              <Icon name={r.icon} size={19} />
              {dot && <i className="simple-rail__dot" aria-label={L(`${waiting} esperando você`, `${waiting} waiting on you`)} />}
            </span>
            <span className="simple-rail__label">{r.label()}</span>
          </button>
        )
      })}
      <span className="simple-rail__gap" />
      <button className={`simple-rail__me ${view?.kind === 'simple-settings' ? 'is-on' : ''}`} title={L('Ajustes', 'Settings')} aria-label={L('Ajustes', 'Settings')} onClick={() => navigate({ kind: 'simple-settings' })}>
        {me.initials}
      </button>
    </nav>
  )
}

// Simple or the whole app: the same data, seen two ways, each person's own choice.
export function ModeSwitch(): ReactNode {
  const simple = useStore((s) => s.settings.uiMode === 'simple')
  return (
    <div className="mode-switch" role="group" aria-label={L('Quanto do app você vê', 'How much of the app you see')}>
      <button aria-pressed={simple} onClick={() => !simple && setUiMode('simple')}>
        {L('Simples', 'Simple')}
      </button>
      <button aria-pressed={!simple} onClick={() => simple && setUiMode('full')} title={L('O app inteiro: canais, organograma, quadro, wiki, rotinas e todas as configurações.', 'The whole app: channels, org chart, board, wiki, routines and every setting.')}>
        {L('Completo', 'Full')}
      </button>
    </div>
  )
}

function Header({ title, back }: { title: ReactNode; back?: () => void }): ReactNode {
  return (
    <header className="simple-head">
      {back && (
        <button className="simple-head__back" onClick={back} aria-label={L('Voltar', 'Back')}>
          <Icon name="back" size={16} />
        </button>
      )}
      <span className="simple-head__title">{title}</span>
      <span className="simple-head__gap" />
      <ModeSwitch />
    </header>
  )
}

const withTuca = (s: Pick<State, 'agents' | 'conversations'>, id: string): boolean => {
  const c = s.conversations.find((x) => x.id === id)
  return c?.kind === 'dm' && agentById(s as State, c.name)?.kind === 'tuca'
}

// Every screen of the simple view. `deep`: one of the whole app's own screens (an agent's page, the wiki,
// the connectors…), drawn by App.tsx and shown here inside the frame, with a way back.
export function SimpleMain({ deep }: { deep: (view: View) => ReactNode }): ReactNode {
  const view = useStore((s) => s.view)
  const tucaChat = useStore((s) => view?.kind === 'conversation' && withTuca(s, view.id))
  const title = useStore((s) => {
    if (view?.kind !== 'conversation') return ''
    const c = s.conversations.find((x) => x.id === view.id)
    return c && tucaChat ? tucaTitle(s, c) : ''
  })
  if (!view) return null
  // Where "back" goes from one of the whole app's screens: the place it most likely came from.
  const up = (): void => navigate(view.kind === 'agent' || view.kind === 'new-agent' ? { kind: 'team' } : view.kind === 'settings' ? { kind: 'simple-settings' } : view.kind === 'conversation' ? { kind: 'requests' } : { kind: 'team' })
  switch (view.kind) {
    case 'home':
    case 'tuca':
      return (
        <>
          <Header title={L('Novo pedido', 'New request')} />
          <Home draft={view.kind === 'home' ? view.draft : undefined} />
        </>
      )
    case 'approvals':
      return (
        <>
          <Header title={L('Pra você', 'For you')} />
          <ForYou />
        </>
      )
    case 'team':
      return (
        <>
          <Header title={L('Time', 'Team')} />
          <Team />
        </>
      )
    case 'requests':
      return (
        <>
          <Header title={L('Conversas', 'Requests')} />
          <Requests />
        </>
      )
    case 'simple-settings':
      return (
        <>
          <Header title={L('Ajustes', 'Settings')} />
          <SimpleSettings />
        </>
      )
    case 'agent':
      if (!view.full)
        return (
          <>
            <Header title={L('Colega', 'Colleague')} back={() => navigate({ kind: 'team' })} />
            <Colleague key={view.id} id={view.id} />
          </>
        )
      return (
        <>
          <Header title={L('Ajustes do colega', "The colleague's settings")} back={() => navigate({ kind: 'agent', id: view.id })} />
          <div className="simple-deep">{deep(view)}</div>
        </>
      )
    case 'conversation':
      if (tucaChat)
        return (
          <>
            <Header title={title} back={() => navigate({ kind: 'requests' })} />
            <Request key={view.id} id={view.id} />
          </>
        )
      return (
        <>
          <Header title={L('O trabalho de um colega', "A colleague's work")} back={up} />
          <div className="simple-deep">
            <ConversationView key={view.id} id={view.id} />
          </div>
        </>
      )
    default:
      return (
        <>
          <Header title={deepTitle(view)} back={up} />
          <div className="simple-deep">{deep(view)}</div>
        </>
      )
  }
}

const deepTitle = (v: View): string =>
  ({
    agent: L('Colega', 'Colleague'),
    'new-agent': L('Novo colega', 'New colleague'),
    connectors: L('Serviços ligados', 'Connected services'),
    vault: L('Cofre', 'Vault'),
    memory: L('O que o time sabe', 'What the team knows'),
    wiki: L('O que o time sabe', 'What the team knows'),
    skills: L('O que o time sabe', 'What the team knows'),
    routines: L('Rotinas', 'Routines'),
    report: L('Boletim', 'Report'),
    usage: L('Uso e limites', 'Usage and limits'),
    org: L('Organograma', 'Org chart'),
    board: L('Quadro', 'Board'),
    settings: L('Todas as configurações', 'All settings'),
    missions: L('Missões', 'Missions')
  })[v.kind as string] ?? ''

// ---------- where a request starts ----------

const hello = (name: string, now = new Date()): string => {
  const h = now.getHours()
  const first = name.trim().split(/\s+/)[0] ?? ''
  const greet = h < 5 ? L('Boa noite', 'Good evening') : h < 12 ? L('Bom dia', 'Good morning') : h < 18 ? L('Boa tarde', 'Good afternoon') : L('Boa noite', 'Good evening')
  return first ? `${greet}, ${first}.` : `${greet}.`
}

// What to ask first, when the team is still being put together and when it is there.
const ideas = (team: Agent[]): { label: string; say: string }[] =>
  team.length
    ? [
        { label: L('O que o time fez hoje?', 'What did the team do today?'), say: L('Me conta o que o time fez hoje, em poucas linhas.', 'Tell me what the team did today, in a few lines.') },
        { label: L('Criar uma rotina', 'Make a routine'), say: L('Quero que alguém do time faça uma coisa todo dia num horário.', 'I want someone on the team to do something every day at a set time.') },
        { label: L('Ligar um serviço', 'Connect a service'), say: L('Quero ligar um serviço que eu uso ao time.', 'I want to connect a service I use to the team.') },
        { label: L('Chamar um colega novo', 'Bring in a new colleague'), say: L('Quero um colega novo no time.', 'I want a new colleague on the team.') }
      ]
    : [
        { label: L('Responder meus clientes', 'Answer my customers'), say: L('Quero alguém pra responder meus clientes.', 'I want someone to answer my customers.') },
        { label: L('Cuidar das redes sociais', 'Look after social media'), say: L('Quero alguém pra cuidar das minhas redes sociais.', 'I want someone to look after my social media.') },
        { label: L('Resumir meu dia às 18h', 'Sum up my day at 6 pm'), say: L('Quero alguém pra resumir o meu dia todo dia às 18h.', 'I want someone to sum up my day every day at 6 pm.') },
        { label: L('Como o Tucano funciona?', 'How does Tucano work?'), say: L('Como o Tucano funciona?', 'How does Tucano work?') }
      ]

// One field, in the middle: what is written there becomes a request, in a conversation of its own, and the
// screen goes to it. Under it, the requests still open (what waits on the person first).
function Home({ draft }: { draft?: string }): ReactNode {
  const me = useStore((s) => s.me.name)
  const tuca = useStore(tucaOf)
  const team = useStore((s) => s.agents.filter(isTeam))
  const [conv, setConv] = useState<string>()
  const [error, setError] = useState('')
  useEffect(() => {
    let off = false
    // An empty conversation with him: the one there is, or a new one. It becomes a request when something is said.
    ensureTuca(undefined, true).then(
      (r) => {
        if (off) return
        if (draft) setComposerDraft(r.conversationId, draft)
        setConv(r.conversationId)
      },
      (e: unknown) => !off && setError(e instanceof Error ? e.message : String(e))
    )
    return () => void (off = true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft])
  const said = useStore((s) => !!conv && messagesIn(s, conv).some((m) => m.author.kind === 'person'))
  useEffect(() => {
    if (said && conv) navigate({ kind: 'conversation', id: conv })
  }, [said, conv])
  const open = useOpenRequests(conv)
  return (
    <div className="simple-page simple-home">
      <div className="simple-home__top">
        <TucaMark size={44} />
        <p className="simple-home__hello">{hello(me)}</p>
        <h1 className="simple-home__title">{L('O que você precisa hoje?', 'What do you need today?')}</h1>
      </div>
      <TucaSays conv={conv} />
      {conv && tuca ? (
        <div className="simple-home__field">
          <Composer key={`${conv}:${draft ?? ''}`} conversationId={conv} members={[tuca]} placeholder={L('Escreva o que você precisa. Eu passo pra quem do time faz.', 'Write what you need. I pass it to whoever on the team does it.')} />
        </div>
      ) : (
        <p className="simple-home__wait" role={error ? 'alert' : undefined}>
          {error || L('Chamando o Tuca…', 'Calling Tuca…')}
        </p>
      )}
      {conv && (
        <div className="simple-home__ideas" aria-label={L('Sugestões', 'Ideas')}>
          {ideas(team).map((i) => (
            <button key={i.label} className="simple-chip" onClick={() => sendMessage(conv, i.say)}>
              {i.label}
            </button>
          ))}
        </div>
      )}
      {open.length > 0 && (
        <section className="simple-section">
          <h2 className="simple-section__title">{L('Em andamento', 'Under way')}</h2>
          <div className="simple-rows">
            {open.map((c) => (
              <RequestRow key={c.id} conversation={c} compact />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// He speaks first: one line a day with something the person should know and what to do about it (tuca-nudges.ts).
// Kept as the day's once shown, so it is the same on every device and isn't followed by another.
function TucaSays({ conv }: { conv?: string }): ReactNode {
  const on = useStore((s) => s.settings.tucaSpeaksFirst !== false)
  const kept = useStore((s) => s.settings.tucaNudge)
  const busy = useStore((s) => tucaConversations(s).some((c) => requestState(s, c) === 'run'))
  const found = useStore((s) => JSON.stringify(tucaNudges(s)))
  const nudge = useMemo(() => nudgeNow(JSON.parse(found), { tucaSpeaksFirst: on, tucaNudge: kept }, { busy }), [found, on, kept, busy])
  const today = dayOf(Date.now())
  useEffect(() => {
    if (nudge && (kept?.day !== today || kept.key !== nudge.key)) updateSettings({ tucaNudge: { day: today, key: nudge.key } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nudge?.key])
  if (!nudge) return null
  const close = (): void => updateSettings({ tucaNudge: { day: today, key: nudge.key, closed: true } })
  const act = (): void => {
    close()
    if (nudge.view) navigate(nudge.view)
    else if (nudge.say && conv) sendMessage(conv, nudge.say)
  }
  return (
    <div className="simple-says" role="status">
      <p className="simple-says__text">{nudge.text}</p>
      <button className="simple-btn" onClick={act} disabled={!nudge.view && !conv}>
        {nudge.label}
      </button>
      <button className="simple-link simple-says__no" onClick={close}>
        {L('Agora não', 'Not now')}
      </button>
    </div>
  )
}

// The requests that aren't done: what waits on the person first, then what is still going.
function useOpenRequests(except?: string): Conversation[] {
  const key = useStore((s) =>
    tucaConversations(s)
      .filter((c) => c.id !== except)
      .map((c) => `${c.id}:${requestState(s, c)}`)
      .join(' ')
  )
  const all = useStore((s) => s.conversations)
  return useMemo(() => {
    const states = new Map(key.split(' ').filter(Boolean).map((x) => x.split(':') as [string, RequestState]))
    const rank = (c: Conversation): number => (states.get(c.id) === 'wait' ? 0 : 1)
    return all.filter((c) => states.get(c.id) === 'wait' || states.get(c.id) === 'run').sort((a, b) => rank(a) - rank(b)).slice(0, 4)
  }, [key, all])
}

// ---------- a request ----------

// One conversation with the Tuca: what was asked, whom he passed it to and how each stands (the line
// under the message), what came back, and the field to go on.
function Request({ id }: { id: string }): ReactNode {
  const tuca = useStore(tucaOf)
  const messages = useStore((s) => messagesIn(s, id))
  const there = useStore((s) => s.conversations.some((c) => c.id === id))
  // His hello opens every conversation with him; here the person already said what they want, so the
  // request starts at their own words.
  const shown = useMemo(() => {
    const first = messages.findIndex((m) => m.author.kind === 'person')
    return first > 0 ? messages.filter((m, i) => i >= first || m.author.kind !== 'agent' || !!m.run) : messages
  }, [messages])
  if (!there || !tuca) return <Empty title={L('Essa conversa não existe mais.', 'That conversation is gone.')} action={{ label: L('Ver as conversas', 'See the requests'), go: () => navigate({ kind: 'requests' }) }} />
  return (
    <div className="simple-request">
      {/* "Editar antes" on a card of his: the colleague's page, filled with what he proposed. */}
      <UseDraft.Provider value={(draft, fromMessage) => navigate({ kind: 'new-agent', draft: draftAgent(draft), fromMessage })}>
        <MessageList messages={shown} conversationId={id} />
        <Composer conversationId={id} members={[tuca]} placeholder={L('Responda ou peça outra coisa…', 'Reply or ask for something else…')} />
      </UseDraft.Provider>
    </div>
  )
}

// ---------- what waits on me ----------

// Everything that waits on the person, in one list: what a colleague wants to do and needs a yes for, and
// what someone asked them. Each is decided right here, on its own card, and says whose it is and since when.
function ForYou(): ReactNode {
  const inbox = useStore((s) => s.inbox)
  const approvals = useStore((s) => s.approvals)
  const agents = useStore((s) => s.agents)
  const people = useStore((s) => s.people)
  const conversations = useStore((s) => s.conversations)
  const proposals = inbox.proposals ?? []
  const count = inbox.approvals.length + inbox.questions.length + proposals.length
  const who = (id: string): Agent | undefined => agents.find((a) => a.id === id)
  const head = (agentId: string, what: string, at: number, conversationId?: string, messageId?: string): ReactNode => {
    const a = who(agentId)
    const reachable = !!conversationId && conversations.some((c) => c.id === conversationId)
    return (
      <div className="simple-wait__head">
        {a && <AgentAvatar agent={a} size={30} still />}
        <span className="simple-row__name">{a?.name ?? L('Alguém', 'Someone')}</span>
        <span className="simple-row__sub simple-row__sub--inline">{what}</span>
        <span className="simple-row__when">{ago(at)}</span>
        {reachable && (
          <button className="simple-link" onClick={() => navigate({ kind: 'conversation', id: conversationId!, ...(messageId ? { message: messageId } : {}) })}>
            {L('Ver o pedido', 'See the request')}
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="simple-page">
      <h1 className="simple-title">{count ? L(count === 1 ? 'Uma coisa espera você.' : `${count} coisas esperam você.`, count === 1 ? 'One thing is waiting on you.' : `${count} things are waiting on you.`) : L('Nada espera você.', 'Nothing is waiting on you.')}</h1>
      {!count && <Empty title={L('Tudo em dia.', 'All caught up.')} hint={L('Quando um colega precisar de um sim seu (pra enviar, publicar ou apagar algo) ou tiver uma pergunta, aparece aqui.', 'When a colleague needs a yes from you (to send, publish or delete something) or has a question, it shows up here.')} />}
      <div className="simple-waits">
        {inbox.approvals.map((a) => (
          <div key={a.id} className="simple-wait">
            {head(a.agentId, L('precisa do seu sim pra continuar', 'needs your yes to go on'), a.createdAt, a.conversationId, a.messageId)}
            <ApprovalCard approval={approvals.find((x) => x.id === a.id) ?? a} compact />
          </div>
        ))}
        {inbox.questions.map((q) => (
          <div key={q.id} className="simple-wait">
            {head(q.agentId, L('tem uma pergunta pra você', 'has a question for you'), q.createdAt, q.conversationId, q.id)}
            <QuestionCard id={q.id} agentName={who(q.agentId)?.name} askedTo={q.askedTo} question={q.text} {...(q.decisions ? { decisions: q.decisions, ...(q.answers ? { answers: q.answers } : {}) } : {})} answered={false} inbox />
          </div>
        ))}
        {proposals.map((p) => (
          <div key={`${p.id}:${p.index ?? 0}`} className="simple-wait">
            {head(p.agentId, L(`propôs isto a pedido de ${people.find((x) => x.id === p.by)?.name ?? 'alguém'}`, `proposed this at ${people.find((x) => x.id === p.by)?.name ?? 'someone'}'s request`), p.at)}
            <ProposalCard message={{ id: p.id, conversationId: '', author: { kind: 'agent', id: p.agentId }, text: '', at: p.at, run: { status: 'done' } } as Message} index={p.index ?? 0} proposal={p.proposal} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- my requests ----------

const DOT: Record<RequestState, string> = { wait: 'is-wait', run: 'is-run', done: 'is-done', new: 'is-new' }

function RequestRow({ conversation: c, compact }: { conversation: Conversation; compact?: boolean }): ReactNode {
  const title = useStore((s) => tucaTitle(s, c))
  const line = useStore((s) => requestLine(s, c))
  const st = useStore((s) => requestState(s, c))
  const at = useStore((s) => lastSaid(s, c))
  const who = useStore((s) => requestAgents(s, c))
  return (
    <button className="simple-row simple-row--request" onClick={() => navigate({ kind: 'conversation', id: c.id })}>
      <span className="simple-row__text">
        <span className="simple-row__title">{title}</span>
        {!compact && line && <span className="simple-row__sub">{line}</span>}
      </span>
      <span className="simple-row__faces" aria-label={who.length ? who.map((a) => a.name).join(', ') : undefined}>
        {who.slice(0, 4).map((a) => (
          <AgentAvatar key={a.id} agent={a} size={26} still />
        ))}
      </span>
      <span className={`simple-state ${DOT[st]}`}>
        <i />
        {stateLabel(st)}
      </span>
      <span className="simple-row__when">{ago(at)}</span>
      <span className="simple-row__go"><Icon name="caret" size={14} /></span>
    </button>
  )
}

function Requests(): ReactNode {
  const [query, setQuery] = useState('')
  const key = useStore((s) => tucaConversations(s).map((c) => `${c.id}:${requestState(s, c)}`).join(' '))
  const all = useStore((s) => s.conversations)
  const titles = useStore((s) => JSON.stringify(Object.fromEntries(tucaConversations(s).map((c) => [c.id, `${tucaTitle(s, c)} ${requestLine(s, c)} ${requestAgents(s, c).map((a) => a.name).join(' ')}`.toLowerCase()]))))
  const { going, before } = useMemo(() => {
    const order = key.split(' ').filter(Boolean).map((x) => x.split(':') as [string, RequestState])
    const text = JSON.parse(titles) as Record<string, string>
    const q = query.trim().toLowerCase()
    const list = order.flatMap(([id, st]) => {
      const c = all.find((x) => x.id === id)
      return c && st !== 'new' && (!q || text[id]?.includes(q)) ? [{ c, st }] : []
    })
    return { going: list.filter((x) => x.st !== 'done').map((x) => x.c), before: list.filter((x) => x.st === 'done').map((x) => x.c) }
  }, [key, all, titles, query])
  const none = !going.length && !before.length
  return (
    <div className="simple-page">
      <h1 className="simple-title">{L('Tudo o que você já pediu.', 'Everything you have asked for.')}</h1>
      <label className="simple-search">
        <Icon name="search" size={17} />
        <span className="sr-only">{L('Buscar nas conversas', 'Search the requests')}</span>
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L('Buscar um pedido, um colega ou uma entrega', 'Search a request, a colleague or a delivery')} />
      </label>
      {none && (query.trim() ? <p className="simple-none">{L('Nada com esse texto.', 'Nothing with that text.')}</p> : <Empty title={L('Você ainda não pediu nada.', "You haven't asked for anything yet.")} hint={L('O que você pedir ao Tuca fica aqui, um pedido por conversa.', 'What you ask Tuca stays here, one request per conversation.')} action={{ label: L('Fazer um pedido', 'Make a request'), go: () => navigate({ kind: 'home' }) }} />)}
      {going.length > 0 && (
        <section className="simple-section">
          <h2 className="simple-section__title">{L('Em andamento', 'Under way')}</h2>
          <div className="simple-rows">
            {going.map((c) => (
              <RequestRow key={c.id} conversation={c} />
            ))}
          </div>
        </section>
      )}
      {before.length > 0 && (
        <section className="simple-section">
          <h2 className="simple-section__title">{L('Prontos', 'Done')}</h2>
          <div className="simple-rows">
            {before.map((c) => (
              <RequestRow key={c.id} conversation={c} />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ---------- the team ----------

// A colleague's line: who they are, what they do (or are doing right now), and what waits on the person there.
function ColleagueRow({ agent }: { agent: Agent }): ReactNode {
  const doing = useStore((s) => {
    const m = workingOn(s).get(agent.id)
    return m ? (runStep(m.run) ?? L('trabalhando', 'working')) : undefined
  })
  const waits = useStore((s) => s.approvals.filter((a) => a.state === 'pending' && a.agentId === agent.id).length + Object.values(s.messages).flat().filter((m) => m.author.kind === 'agent' && m.author.id === agent.id && m.run?.status === 'waiting_input' && questionsOf(m.run).length > 0).length)
  const routines = useStore((s) => s.routines.filter((r) => r.agentId === agent.id && r.enabled).length)
  const st: RequestState = waits ? 'wait' : doing ? 'run' : 'new'
  return (
    <div className="simple-row simple-row--colleague">
      <button className="simple-row__open" onClick={() => navigate({ kind: 'agent', id: agent.id })} aria-label={L(`Abrir ${agent.name}`, `Open ${agent.name}`)}>
        <AgentAvatar agent={agent} size={34} busy={!!doing} />
        <span className="simple-row__name">{agent.name}</span>
        <span className="simple-row__sub simple-row__sub--inline">{doing ?? agent.role}</span>
      </button>
      {routines > 0 && <span className="simple-row__meta">{L(`${routines} ${routines === 1 ? 'rotina' : 'rotinas'}`, `${routines} ${routines === 1 ? 'routine' : 'routines'}`)}</span>}
      <span className={`simple-state ${st === 'new' ? 'is-idle' : DOT[st]}`}>
        <i />
        {st === 'wait' ? stateLabel('wait') : st === 'run' ? L('trabalhando', 'working') : L('livre', 'free')}
      </span>
      <button className="simple-row__ask" onClick={() => navigate({ kind: 'home', draft: L(`Pra ${agent.name}: `, `For ${agent.name}: `) })}>
        {L('Pedir algo', 'Ask for something')}
      </button>
    </div>
  )
}

// One colleague, as someone who works with them needs to know them: what they do, what they use, what
// they do on their own, and what was last asked of them. Their whole page (model, limits, permissions) is
// one click further, for whoever wants it.
function Colleague({ id }: { id: string }): ReactNode {
  const agent = useStore((s) => agentById(s, id))
  const connectors = useStore((s) => s.connectors)
  const routines = useStore((s) => s.routines.filter((r) => r.agentId === id))
  const asked = useStore((s) => s.delegations.filter((d) => d.to === id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 6))
  const doing = useStore((s) => {
    const m = workingOn(s).get(id)
    return m ? (runStep(m.run) ?? L('trabalhando', 'working')) : undefined
  })
  if (!agent || agent.kind === 'tuca') return <Empty title={L('Esse colega não está mais no time.', 'That colleague is no longer on the team.')} action={{ label: L('Ver o time', 'See the team'), go: () => navigate({ kind: 'team' }) }} />
  const uses = [...(agent.web !== false ? [L('a web', 'the web')] : []), ...connectors.filter((c) => (agent.grants[c.id] ?? 'none') !== 'none').map((c) => c.name), ...(agent.computer ? [L('um computador', 'a computer')] : []), ...(agent.browser ? [L('um navegador', 'a browser')] : [])]
  const does = agent.instructions.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4)
  const tone = (st: string): string => (st === 'open' ? 'is-run' : st === 'done' ? 'is-done' : 'is-idle')
  const word = (st: string): string => (st === 'open' ? L('andando', 'under way') : st === 'done' ? L('pronto', 'done') : st === 'cancelled' ? L('cancelado', 'cancelled') : L('não terminou', 'did not finish'))
  return (
    <div className="simple-page">
      <div className="simple-who">
        <AgentAvatar agent={agent} size={64} busy={!!doing} />
        <div className="simple-who__text">
          <h1 className="simple-title">{agent.name}</h1>
          <p className="simple-who__role">{doing ? L(`Agora: ${doing}`, `Now: ${doing}`) : agent.role || L('Colega do time', 'Team colleague')}</p>
        </div>
        <button className="simple-btn simple-btn--primary" onClick={() => navigate({ kind: 'home', draft: L(`Pra ${agent.name}: `, `For ${agent.name}: `) })}>
          {L('Pedir algo', 'Ask for something')}
        </button>
      </div>
      {does.length > 0 && (
        <section className="simple-section">
          <h2 className="simple-section__title">{L('O que faz', 'What they do')}</h2>
          <div className="simple-prose">
            {does.map((l, i) => (
              <p key={i}>{l}</p>
            ))}
          </div>
        </section>
      )}
      <section className="simple-section">
        <h2 className="simple-section__title">{L('O que usa', 'What they use')}</h2>
        <p className="simple-none">{uses.length ? uses.join(', ') : L('Só conversa: nenhum serviço, sem web.', 'Only talk: no service, no web.')}</p>
      </section>
      <section className="simple-section">
        <div className="simple-section__head">
          <h2 className="simple-section__title">{L('O que faz sozinho', 'What they do on their own')}</h2>
          <button className="simple-link" onClick={() => navigate({ kind: 'home', draft: L(`Quero que ${agent.name} faça isto num horário: `, `I want ${agent.name} to do this on a schedule: `) })}>
            {L('Criar uma rotina', 'Make a routine')}
          </button>
        </div>
        {routines.length ? (
          <div className="simple-rows">
            {routines.map((r) => (
              <button key={r.id} className="simple-row simple-row--link" onClick={() => navigate({ kind: 'routines' })}>
                <span className="simple-row__name">{r.name}</span>
                <span className="simple-row__sub simple-row__sub--inline">{describeRoutine(r, connectors.find((c) => r.trigger?.kind === 'poll' && c.id === r.trigger.connectorId)?.name)}</span>
                <span className={`simple-state ${r.enabled ? 'is-done' : 'is-idle'}`}>
                  <i />
                  {r.enabled ? L('ligada', 'on') : L('desligada', 'off')}
                </span>
                <span className="simple-row__go"><Icon name="caret" size={14} /></span>
              </button>
            ))}
          </div>
        ) : (
          <p className="simple-none">{L('Nada num horário ainda.', 'Nothing on a schedule yet.')}</p>
        )}
      </section>
      {asked.length > 0 && (
        <section className="simple-section">
          <h2 className="simple-section__title">{L('Últimos pedidos', 'Latest requests')}</h2>
          <div className="simple-rows">
            {asked.map((d) => (
              <button key={d.id} className="simple-row simple-row--link" onClick={() => navigate({ kind: 'conversation', id: d.conversationId, message: d.threadId ?? d.rootId })}>
                <span className="simple-row__sub simple-row__sub--inline simple-row__sub--ink">{d.text.replace(/\s+/g, ' ')}</span>
                <span className={`simple-state ${tone(d.state)}`}>
                  <i />
                  {word(d.state)}
                </span>
                <span className="simple-row__when">{ago(d.createdAt)}</span>
                <span className="simple-row__go"><Icon name="caret" size={14} /></span>
              </button>
            ))}
          </div>
        </section>
      )}
      <section className="simple-section">
        <div className="simple-rows">
          <button className="simple-row simple-row--link" onClick={() => navigate({ kind: 'agent', id, full: true })}>
            <span className="simple-row__name">{L('Ajustes do colega', "The colleague's settings")}</span>
            <span className="simple-row__sub simple-row__sub--inline">{L('Instruções, modelo, limite do mês e o que ele pode fazer', 'Instructions, model, monthly limit and what they may do')}</span>
            <span className="simple-row__go"><Icon name="caret" size={14} /></span>
          </button>
        </div>
      </section>
    </div>
  )
}

const STATUS = (): Record<string, { label: string; tone: string }> => ({
  connected: { label: L('ligado', 'connected'), tone: 'is-done' },
  connecting: { label: L('ligando', 'connecting'), tone: 'is-run' },
  needs_auth: { label: L('pede login', 'needs sign-in'), tone: 'is-wait' },
  error: { label: L('com erro', 'error'), tone: 'is-wait' },
  disconnected: { label: L('desligado', 'off'), tone: 'is-idle' }
})

function Team(): ReactNode {
  const team = useStore((s) => s.agents.filter(isTeam))
  const connectors = useStore((s) => s.connectors)
  const memories = useStore((s) => s.memories.filter((m) => m.state === 'active').length)
  const skills = useStore((s) => s.skills.length)
  const routines = useStore((s) => s.routines.filter((r) => r.enabled).length)
  const status = STATUS()
  const knows: { label: string; hint: string; view: View }[] = [
    { label: 'Wiki', hint: L('O que o time escreveu sobre clientes, projetos e decisões', 'What the team wrote about customers, projects and decisions'), view: { kind: 'wiki' } },
    { label: L('Memória', 'Memory'), hint: memories ? L(`${memories} ${memories === 1 ? 'coisa lembrada' : 'coisas lembradas'} sobre você e o trabalho`, `${memories} ${memories === 1 ? 'thing' : 'things'} remembered about you and the work`) : L('O que cada colega aprende sobre você e o trabalho', 'What each colleague learns about you and the work'), view: { kind: 'memory' } },
    { label: 'Skills', hint: skills ? L(`${skills} ${skills === 1 ? 'receita' : 'receitas'} de como fazer cada tipo de tarefa`, `${skills} ${skills === 1 ? 'recipe' : 'recipes'} for how to do each kind of task`) : L('Receitas de como fazer cada tipo de tarefa', 'Recipes for how to do each kind of task'), view: { kind: 'skills' } },
    { label: L('Rotinas', 'Routines'), hint: routines ? L(`${routines} ${routines === 1 ? 'coisa roda' : 'coisas rodam'} sozinha${routines === 1 ? '' : 's'} num horário`, `${routines} ${routines === 1 ? 'thing runs' : 'things run'} on a schedule`) : L('O que o time faz sozinho num horário', 'What the team does on its own on a schedule'), view: { kind: 'routines' } }
  ]
  return (
    <div className="simple-page">
      <div className="simple-title-row">
        <h1 className="simple-title">{team.length ? L('Quem trabalha com você.', 'Who works with you.') : L('Seu time começa aqui.', 'Your team starts here.')}</h1>
        <button className="simple-btn" onClick={() => navigate({ kind: 'home', draft: L('Quero um colega novo pra ', 'I want a new colleague to ') })}>
          <Icon name="plus" size={15} /> {L('Novo colega', 'New colleague')}
        </button>
      </div>
      {team.length ? (
        <div className="simple-rows">
          {team.map((a) => (
            <ColleagueRow key={a.id} agent={a} />
          ))}
        </div>
      ) : (
        <Empty title={L('Ainda não tem ninguém no time.', 'There is no one on the team yet.')} hint={L('Conte ao Tuca uma tarefa que você quer tirar do prato, e ele monta o colega certo pra ela.', 'Tell Tuca a task you want off your plate, and he builds the right colleague for it.')} action={{ label: L('Montar o primeiro colega', 'Build the first colleague'), go: () => navigate({ kind: 'home', draft: L('Quero um colega pra ', 'I want a colleague to ') }) }} />
      )}
      <section className="simple-section">
        <h2 className="simple-section__title">{L('O que o time sabe', 'What the team knows')}</h2>
        <div className="simple-rows">
          {knows.map((k) => (
            <button key={k.label} className="simple-row simple-row--link" onClick={() => navigate(k.view)}>
              <span className="simple-row__name">{k.label}</span>
              <span className="simple-row__sub simple-row__sub--inline">{k.hint}</span>
              <span className="simple-row__go"><Icon name="caret" size={14} /></span>
            </button>
          ))}
        </div>
      </section>
      <section className="simple-section">
        <div className="simple-section__head">
          <h2 className="simple-section__title">{L('Serviços ligados', 'Connected services')}</h2>
          <button className="simple-link" onClick={() => navigate({ kind: 'connectors' })}>
            {connectors.length ? L('Ver todos', 'See all') : L('Ligar um serviço', 'Connect a service')}
          </button>
        </div>
        {connectors.length ? (
          <div className="simple-rows">
            {connectors.map((c) => (
              <button key={c.id} className="simple-row simple-row--link" onClick={() => navigate({ kind: 'connectors' })}>
                <span className="simple-row__name">{c.name}</span>
                <span className="simple-row__sub simple-row__sub--inline">{c.error ?? ''}</span>
                <span className={`simple-state ${status[c.status]?.tone ?? 'is-idle'}`}>
                  <i />
                  {status[c.status]?.label ?? c.status}
                </span>
                <span className="simple-row__go"><Icon name="caret" size={14} /></span>
              </button>
            ))}
          </div>
        ) : (
          <p className="simple-none">{L('Nenhum ainda. Ligue o que você já usa (e-mail, agenda, planilhas) e os colegas passam a trabalhar com isso.', 'None yet. Connect what you already use (mail, calendar, spreadsheets) and the colleagues start working with it.')}</p>
        )}
      </section>
    </div>
  )
}

// ---------- settings ----------

const leaveUses = (l: TucaLeave, connectors: { id: string; name: string }[]): string =>
  [...(l.web ? [L('a web', 'the web')] : []), ...Object.entries(l.grants ?? {}).map(([id, g]) => `${connectors.find((c) => c.id === id)?.name ?? L('um serviço removido', 'a removed service')} (${g === 'read_write' ? L('leitura e escrita', 'read and write') : L('leitura', 'read')})`)].join(', ') || L('nada além de escrever', 'nothing but writing')

// What a person let the Tuca do himself, with a way to take each back. Shown in both views' settings.
export function TucaLeaves(): ReactNode {
  const leaves = useStore((s) => s.leaves)
  const connectors = useStore((s) => s.connectors)
  const conversations = useStore((s) => s.conversations)
  const titles = useStore((s) => JSON.stringify(Object.fromEntries(s.leaves.flatMap((l) => (l.conversationId ? [[l.conversationId, tucaTitle(s, s.conversations.find((c) => c.id === l.conversationId) ?? ({ id: l.conversationId } as Conversation))]] : [])))))
  const named = JSON.parse(titles) as Record<string, string>
  if (!leaves.length) return <p className="simple-none">{L('Nada ainda. Quando ninguém do time faz o que você pediu, o Tuca pergunta se pode fazer ele mesmo, e o que você deixar aparece aqui.', 'Nothing yet. When no one on the team does what you asked, Tuca asks whether he may do it himself, and what you allow shows up here.')}</p>
  return (
    <div className="simple-rows">
      {leaves.map((l) => (
        <div key={l.id} className="simple-row simple-row--leave">
          <span className="simple-row__text">
            <span className="simple-row__title">{l.kind}</span>
            <span className="simple-row__sub">
              {L(`Usando ${leaveUses(l, connectors)}`, `Using ${leaveUses(l, connectors)}`)}
              {' · '}
              {l.conversationId ? (conversations.some((c) => c.id === l.conversationId) ? L(`só em “${named[l.conversationId]}”`, `only in “${named[l.conversationId]}”`) : L('só numa conversa', 'in one conversation only')) : L('sempre, sem perguntar', 'always, without asking')}
            </span>
          </span>
          <button className="simple-link" onClick={() => void removeTucaLeave(l.id)}>
            {L('Retirar', 'Take back')}
          </button>
        </div>
      ))}
    </div>
  )
}

function SimpleSettings(): ReactNode {
  const theme = useStore((s) => s.settings.theme)
  const language = useStore((s) => s.settings.language)
  const speaks = useStore((s) => s.settings.tucaSpeaksFirst !== false)
  const pick = <T extends string>(value: T, options: [T, string][], on: (v: T) => void, label: string): ReactNode => (
    <div className="mode-switch" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} aria-pressed={value === v} onClick={() => on(v)}>
          {text}
        </button>
      ))}
    </div>
  )
  return (
    <div className="simple-page">
      <h1 className="simple-title">{L('Do seu jeito.', 'Your way.')}</h1>
      <section className="simple-section">
        <div className="simple-rows">
          <div className="simple-row simple-row--setting">
            <span className="simple-row__text">
              <span className="simple-row__title">{L('Aparência', 'Appearance')}</span>
            </span>
            {pick(theme, [['system', L('Do sistema', 'System')], ['light', L('Claro', 'Light')], ['dark', L('Escuro', 'Dark')]], (v) => updateSettings({ theme: v }), L('Aparência', 'Appearance'))}
          </div>
          <div className="simple-row simple-row--setting">
            <span className="simple-row__text">
              <span className="simple-row__title">{L('Idioma', 'Language')}</span>
              <span className="simple-row__sub">{L('O do app e o que o time usa pra responder.', "The app's, and the one the team answers in.")}</span>
            </span>
            {pick(language, [['pt', 'Português'], ['en', 'English']], (v) => updateSettings({ language: v }), L('Idioma', 'Language'))}
          </div>
        </div>
      </section>
      <section className="simple-section">
        <h2 className="simple-section__title">Tuca</h2>
        <div className="simple-rows">
          <div className="simple-row simple-row--setting">
            <span className="simple-row__text">
              <span className="simple-row__title">{L('O Tuca fala primeiro', 'Tuca speaks first')}</span>
              <span className="simple-row__sub">{L('Uma vez por dia, no máximo, ele avisa de algo que você deveria saber.', 'Once a day at most, he tells you something you should know.')}</span>
            </span>
            {pick(speaks ? 'on' : 'off', [['on', L('Ligado', 'On')], ['off', L('Desligado', 'Off')]], (v) => updateSettings({ tucaSpeaksFirst: v === 'on' }), L('O Tuca fala primeiro', 'Tuca speaks first'))}
          </div>
        </div>
      </section>
      <section className="simple-section">
        <h2 className="simple-section__title">{L('O que o Tuca pode fazer ele mesmo', 'What Tuca may do himself')}</h2>
        <TucaLeaves />
      </section>
      <section className="simple-section">
        <div className="simple-rows">
          <button className="simple-row simple-row--link" onClick={() => navigate({ kind: 'settings' })}>
            <span className="simple-row__name">{L('Todas as configurações', 'All settings')}</span>
            <span className="simple-row__sub simple-row__sub--inline">{L('Modelos, contas, aprovações, pessoas e o resto', 'Models, accounts, approvals, people and the rest')}</span>
            <span className="simple-row__go"><Icon name="caret" size={14} /></span>
          </button>
        </div>
      </section>
    </div>
  )
}

function Empty({ title, hint, action }: { title: string; hint?: string; action?: { label: string; go: () => void } }): ReactNode {
  return (
    <div className="simple-empty">
      <TucaMark size={40} />
      <p className="simple-empty__title">{title}</p>
      {hint && <p className="simple-empty__hint">{hint}</p>}
      {action && (
        <button className="simple-btn simple-btn--primary" onClick={action.go}>
          {action.label}
        </button>
      )}
    </div>
  )
}
