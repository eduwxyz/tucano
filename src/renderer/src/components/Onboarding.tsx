// A new agent, step by step: the Tuca's builder screen (from the sidebar), where he proposes one beside
// the chat and the person makes it at once or first sets what it can use and its first task; and the introduction's "Prefiro configurar do
// zero" (Intro.tsx), the same form from a template, which hands the agent back to the introduction.
import { L } from '../../../shared/lang'
import { instructionLengthNote } from '../../../shared/instructions'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ENGINES,
  MODELS,
  customModel,
  getState,
  createFromDraft,
  dmWith,
  modelInfo,
  usable,
  navigate,
  newAgentDraft,
  openDm,
  askAgent,
  amAdmin,
  undoProposal,
  saveAgent,
  sendMessage,
  slug,
  ensureTuca,
  removeTucaLeave,
  settleDraft,
  isTeam,
  messagesIn,
  proposalsOf,
  useStore,
  type Agent,
  type AgentColor,
  type AgentDraft,
  type GrantLevel,
  type Message,
  type State,
  type View
} from '../store'
import { ModelPicker, usableEngines } from './Harness'
import { ColorPicker, LookPicker, Toggle } from './Pages'
import { Composer, MessageList } from './Conversation'
import { draftAgent, EFFORT, UseDraft } from './Tuca'
import { describeRoutine } from './Routines'
import { AutonomyPick } from './AutonomyPick'
import { autonomyChosen, FIRST_AUTONOMY, storedAutonomy } from '../../../shared/onboarding'
import { AgentAvatar, ago, Icon, type IconName } from './ui'
import { ConnectorTile } from './ConnectorStore'
import { lastSaid, tucaConversations, tucaTitle } from '../tuca-conversations'
import { leaveRows, type LeaveRow } from '../tuca-leaves'
import { latestAsk, newestDraft, subjectOf, tucaStage, type Subject, type TucaStage, type Want } from '../tuca-screen'
import { TeamSide } from './TucaTeam'

type Computer = 'none' | 'linux' | 'mac'

interface Template {
  id: string
  title: string
  pitch: string
  icon: IconName
  name: string
  role: string
  color: AgentColor
  instructions: string
  tasks: string[]
}

const TEMPLATES = (): Template[] => [
  {
    id: 'pesquisa',
    title: L('Pesquisa', 'Research'),
    pitch: L('Pesquisa na web e responde com fontes.', 'Searches the web and answers with sources.'),
    icon: 'globe',
    name: 'Iris',
    role: L('Pesquisa', 'Research'),
    color: 'sky',
    instructions: L(
      'Pesquisa na web antes de responder e cita as fontes com links. Resume em tópicos curtos, separa o que é fato do que é opinião e diz quando não achou nada confiável.',
      'Searches the web before answering and cites sources with links. Sums up in short bullet points, separates fact from opinion and says when it found nothing reliable.'
    ),
    tasks: [
      L('Quais foram as 3 notícias mais importantes de IA nesta semana? Resume cada uma em duas linhas, com o link.', 'What were the 3 most important AI stories this week? Sum up each in two lines, with the link.'),
      L('Compara Notion, Obsidian e Logseq pra notas pessoais, numa tabela com preço, offline e sincronização.', 'Compare Notion, Obsidian and Logseq for personal notes, in a table with price, offline and sync.')
    ]
  },
  {
    id: 'dev',
    title: L('Engenharia', 'Engineering'),
    pitch: L('Ajuda com código, arquitetura e bugs.', 'Helps with code, architecture and bugs.'),
    icon: 'terminal',
    name: 'Leo',
    role: L('Engenharia', 'Engineering'),
    color: 'violet',
    instructions: L(
      'Ajuda com código, arquitetura e bugs. Explica o raciocínio em poucas linhas e mostra código quando ajuda. Antes de propor algo grande, descreve o plano e pergunta.',
      'Helps with code, architecture and bugs. Explains its reasoning in a few lines and shows code when it helps. Before proposing something big, it describes the plan and asks.'
    ),
    tasks: [
      L('Me explica a diferença entre processo e thread, com um exemplo curto em código.', 'Explain the difference between a process and a thread, with a short code example.'),
      L('Quais são as boas práticas pra organizar um projeto Node com TypeScript? Me dá uma estrutura de pastas.', 'What are good practices for organizing a Node project with TypeScript? Give me a folder structure.')
    ]
  },
  {
    id: 'conteudo',
    title: L('Conteúdo', 'Content'),
    pitch: L('Escreve posts e textos no seu tom.', 'Writes posts and copy in your voice.'),
    icon: 'edit',
    name: 'Nina',
    role: L('Conteúdo', 'Content'),
    color: 'rose',
    instructions: L(
      'Escreve posts, e-mails e textos no meu tom: leve, curto, sem jargão. Entrega o rascunho pronto pra usar e pergunta se ajusta alguma coisa.',
      'Writes posts, emails and copy in my voice: light, short, no jargon. Delivers a ready-to-use draft and asks if anything needs adjusting.'
    ),
    tasks: [
      L('Escreve 3 ideias de post pro LinkedIn sobre o que eu faço, cada uma com um gancho na primeira linha.', 'Write 3 LinkedIn post ideas about what I do, each with a hook in the first line.'),
      L('Escreve um e-mail educado recusando uma reunião e propondo resolver por mensagem.', 'Write a polite email declining a meeting and suggesting we sort it out over messages.')
    ]
  },
  {
    id: 'assistente',
    title: L('Assistente', 'Assistant'),
    pitch: L('Organiza tarefas, agenda e o dia a dia.', 'Organizes tasks, schedule and the day to day.'),
    icon: 'clock',
    name: 'Bia',
    role: L('Assistente', 'Assistant'),
    color: 'amber',
    instructions: L(
      'Ajuda a organizar o dia: tarefas, prioridades, lembretes e planos. Faz perguntas curtas quando falta informação e responde em listas fáceis de seguir.',
      'Helps organize the day: tasks, priorities, reminders and plans. Asks short questions when information is missing and answers in easy-to-follow lists.'
    ),
    tasks: [
      L('Me ajuda a planejar a semana: antes, me pergunta o que eu tenho pra fazer.', 'Help me plan the week: first, ask me what I have to do.'),
      L('Monta uma lista de compras pra 5 jantares saudáveis e rápidos.', 'Put together a shopping list for 5 quick, healthy dinners.')
    ]
  },
  {
    id: 'zero',
    title: L('Do zero', 'From scratch'),
    pitch: L('Você escreve o que ele faz.', 'You write what it does.'),
    icon: 'plus',
    name: '',
    role: '',
    color: 'teal',
    instructions: '',
    tasks: [L('Oi! Se apresenta e me diz como pode me ajudar.', 'Hi! Introduce yourself and tell me how you can help.')]
  }
]

const STEPS = ['agent', 'powers', 'first'] as const
type Step = (typeof STEPS)[number]

function unique(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

// The app's own list, for the harnesses on a plan (a gateway names its own models).
const readyModels = (engines: State['settings']['engines']): typeof MODELS => MODELS.filter((m) => engines[m.engine].loggedIn && engines[m.engine].route !== 'gateway')

// A template fills in who the agent is; the model stays if it still works.
function fromTemplate(a: Agent, t: Template, models: typeof MODELS): Agent {
  const model = MODELS.some((m) => m.id === a.modelId) ? (models.find((m) => m.id === a.modelId) ?? models[0]) : modelInfo(a.modelId) ? { id: a.modelId } : models[0]
  return { ...a, name: t.name, role: t.role, color: t.color, customColor: undefined, instructions: t.instructions, modelId: model?.id ?? a.modelId, web: true }
}

// `manual`: the introduction's form, which gives the agent and its first message back to it.
export interface ManualIntro {
  onBack: () => void
  onCreate: (agent: Agent, task: string) => Promise<void>
}

// `making`: opened to make an agent (the + by Agentes), so the proposal is beside the chat from the start.
export function Onboarding({ build = false, from, manual, making = false }: { build?: boolean; from?: View; manual?: ManualIntro; making?: boolean } = {}): ReactNode {
  const settings = useStore((s) => s.settings)
  const handles = useStore((s) => s.agents.map((a) => a.handle))
  const connectors = useStore((s) => s.connectors)

  const steps = STEPS
  const [step, setStep] = useState<Step>('agent')
  const [template, setTemplate] = useState<Template>(() => TEMPLATES()[0]!)
  // From the introduction it starts on Normal, as the introduction's own agent does; the builder follows Settings.
  const [agent, setAgent] = useState<Agent>(() => ({ ...fromTemplate(newAgentDraft(), TEMPLATES()[0]!, readyModels(settings.engines)), ...(manual ? { autonomy: storedAutonomy(FIRST_AUTONOMY, settings.autonomy) } : {}) }))
  const [computer, setComputer] = useState<Computer>('none')
  const [task, setTask] = useState(() => TEMPLATES()[0]!.tasks[0]!)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('') // why the agent wasn't created (a person's name, a taken @)
  const [grants, setGrants] = useState<Record<string, GrantLevel>>({})
  // The agent comes from the Tuca's card, or from the form for who prefers it (always, from the introduction).
  const [hand, setManual] = useState(!!manual)
  const [fromTuca, setFromTuca] = useState<{ messageId: string; task?: string } | null>(null)
  // The person's conversation with the Tuca, where they left it: every way in (the sidebar, the + by
  // Agentes, a mission, the command menu) opens the same one, messages, cards and what was being
  // typed, and his session goes on. "Nova conversa" starts another on purpose.
  const [tucaConv, setTucaConv] = useState<{ id?: string; error?: string }>({})

  // The Tuca's screen (not the form). Beside his conversation sits what it is about: the team he passes
  // requests to, or the proposal of an agent while he builds one, and only then the named steps on top.
  const withTuca = build && !hand
  const tucaAt = useStore((s) => (tucaConv.id ? tucaStage(newestDraft(messagesIn(s, tucaConv.id))) : 'talk'))
  // What the person asked this screen for: to make an agent (until they go back to the team), and which
  // made agent's card they already closed.
  const [want, setWant] = useState<Want>(making ? { build: {} } : {})
  // "To make an agent" holds until something asked after that is passed on: here is what was asked last.
  const lastAsk = (): string => (tucaConv.id ? (latestAsk(messagesIn(getState(), tucaConv.id))?.id ?? '') : '')
  useEffect(() => {
    if (tucaConv.id && want.build && want.build.asked === undefined) setWant({ build: { asked: lastAsk() } })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tucaConv.id])
  const subject = useStore((s): Subject => {
    const tuca = s.agents.find((a) => a.kind === 'tuca')
    return tucaConv.id && tuca ? subjectOf(s, tuca.id, tucaConv.id, messagesIn(s, tucaConv.id), want) : 'build'
  })
  const newest = useStore((s) => (tucaConv.id ? newestDraft(messagesIn(s, tucaConv.id))?.id : undefined))

  const models = readyModels(settings.engines)
  const ready = usableEngines(settings)
  const at = steps.indexOf(step)
  // Which way the next step slides in: forward from the right, back from the left.
  const [dir, setDir] = useState<'next' | 'back'>('next')
  const go = (s: Step): void => {
    setDir(steps.indexOf(s) < at ? 'back' : 'next')
    setStep(s)
  }
  const next = (): void => go(steps[at + 1]!)
  const back = (): void => go(steps[at - 1]!)
  const patch = (p: Partial<Agent>): void => (setAgent((a) => ({ ...a, ...p })), setError(''))
  const leave = (): void => {
    const channel = getState().conversations.find((c) => c.kind === 'channel')
    navigate(from ?? (channel ? { kind: 'conversation', id: channel.id } : { kind: 'approvals' }))
  }
  const close = (): void => (manual ? manual.onBack() : leave())

  // On the builder screen the Tuca starts on his own model.
  useEffect(() => {
    if (!build || step !== 'agent' || tucaConv.id || tucaConv.error) return
    ensureTuca(agent.modelId)
      .then((r) => setTucaConv({ id: r.conversationId }))
      .catch((e: unknown) => setTucaConv({ error: e instanceof Error ? e.message : String(e) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // The first harness that works sets the model; a template keeps it. Off a plan
  // (a gateway, OpenCode, Pi) the person picks from what the harness lists.
  useEffect(() => {
    const m = modelInfo(agent.modelId)
    if (m && ready.includes(m.engine)) return
    if (models.length) patch({ modelId: models[0]!.id })
    else if (ready[0]) patch({ modelId: customModel(ready[0], '') })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.join()])

  const pick = (t: Template): void => {
    setTemplate(t)
    setAgent((a) => fromTemplate(a, t, models))
    setTask(t.tasks[0]!)
  }

  // A Tuca card: its agent becomes the new one (same id), with its access; powers and first task follow.
  const useDraft = (d: AgentDraft, messageId: string): void => {
    setAgent((a) => ({ ...draftAgent(d), id: a.id, limit: a.limit, autonomy: a.autonomy }))
    setGrants(Object.fromEntries(connectors.map((c) => [c.id, d.grants[c.id] ?? 'none'])))
    setFromTuca({ messageId, task: d.task })
    if (d.task) setTask(d.task)
    next()
  }

  const handle = unique(slug(agent.name).length >= 2 ? slug(agent.name) : L('agente', 'agent'), handles)
  const tasks = [
    ...(computer !== 'none' ? [L('Cria uma página com um relógio ao vivo e me mostra ela rodando.', 'Make a page with a live clock and show it to me running.')] : []),
    ...(agent.browser ? [L('Abre o g1.globo.com no seu navegador e me diz qual é a manchete principal agora.', 'Open apnews.com in your browser and tell me what the top headline is right now.')] : []),
    ...(fromTuca?.task ? [fromTuca.task] : []),
    ...(fromTuca ? [] : template.tasks)
  ]

  async function finish(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const a: Agent = { ...agent, name: agent.name.trim(), role: agent.role.trim(), handle, computer: computer !== 'none', computerKind: computer === 'mac' ? 'mac' : 'linux', grants: Object.fromEntries(connectors.map((c) => [c.id, grants[c.id] ?? 'read'])) }
      // From the introduction: it makes #geral and leaves the first message there, unsent.
      if (manual) return await manual.onCreate(a, task.trim())
      // From the builder screen: the agent, then a DM with it and its first task.
      await saveAgent(a, [])
      if (fromTuca) settleDraft(fromTuca.messageId, a.id)
      const dm = await dmWith(a.id)
      navigate({ kind: 'conversation', id: dm })
      sendMessage(dm, task.trim())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="onb">
      <div className="onb__drag" />
      <header className={`onb__top ${withTuca ? 'onb__top--steps' : ''}`}>
        {withTuca ? (
          <>
            <span />
            {step !== 'agent' || subject === 'build' ? <TucaSteps stage={step === 'agent' ? tucaAt : 'proposal'} detail={step === 'powers' ? L('acesso', 'access') : step === 'first' ? L('primeira tarefa', 'first task') : undefined} /> : <span />}
          </>
        ) : (
          <div className="onb__dots" aria-label={L(`Passo ${at + 1} de ${steps.length}`, `Step ${at + 1} of ${steps.length}`)}>
            {steps.map((s, i) => (
              <span key={s} className={i === at ? 'is-now' : i < at ? 'is-done' : ''} />
            ))}
          </div>
        )}
        <button className="btn btn--ghost btn--sm" onClick={close}>
          {manual ? L('Voltar', 'Back') : L('Fechar', 'Close')}
        </button>
      </header>

      <div className="onb__scroll">
        <div className={`onb__stage ${withTuca && step === 'agent' ? 'onb__stage--tuca' : ''}`} key={step} data-dir={dir}>
          {step === 'agent' &&
            (hand ? (
              <MakeAgent agent={agent} handle={handle} template={template} pick={pick} patch={patch} computer={computer} onBack={() => (manual ? manual.onBack() : setManual(false))} onNext={next} />
            ) : (
              <MeetTuca conv={tucaConv} setConv={(id) => setTucaConv({ id })} onUse={useDraft} onManual={() => setManual(true)} subject={subject} onBuild={() => setWant({ build: { asked: lastAsk() } })} onTeam={() => setWant({ closed: newest })} />
            ))}
          {step === 'powers' && <Powers agent={agent} handle={handle} patch={patch} computer={computer} setComputer={setComputer} grants={grants} setGrants={setGrants} onBack={back} onNext={next} />}
          {step === 'first' && <FirstTask agent={agent} handle={handle} computer={computer} manual={!!manual} tasks={tasks} task={task} setTask={setTask} busy={busy} error={error} onBack={back} onFinish={() => void finish()} />}
        </div>
      </div>
    </div>
  )
}

function Nav({ onBack, onNext, next = L('Continuar', 'Continue'), disabled }: { onBack?: () => void; onNext: () => void; next?: ReactNode; disabled?: boolean }): ReactNode {
  return (
    <div className="onb__nav">
      {onBack ? (
        <button className="btn btn--ghost" onClick={onBack}>
          <Icon name="back" size={14} /> {L('Voltar', 'Back')}
        </button>
      ) : (
        <span />
      )}
      <button className="btn btn--primary btn--lg" disabled={disabled} onClick={onNext}>
        {next}
      </button>
    </div>
  )
}

// ---------- 4. the agent ----------

// The top of the builder screen with the Tuca: where you are, by name. `detail`: which part of the
// proposal is being set (its access, its first task) once it left the chat.
function TucaSteps({ stage, detail }: { stage: TucaStage; detail?: string }): ReactNode {
  const steps = [L('Conversa', 'Conversation'), L('Proposta', 'Proposal'), L('Pronto', 'Done')]
  const now = stage === 'talk' ? 0 : stage === 'proposal' ? 1 : 2
  return (
    <ol className="onb-steps" aria-label={L(`Passo ${now + 1} de 3: ${steps[now]}`, `Step ${now + 1} of 3: ${steps[now]}`)}>
      {steps.map((s, i) => (
        <li key={s} className={i < now ? 'is-done' : i === now ? 'is-now' : ''} aria-current={i === now ? 'step' : undefined}>
          <span className="onb-steps__n">{i < now || stage === 'done' ? <Icon name="check" size={11} /> : i + 1}</span>
          {s}
          {i === now && detail && <span className="onb-steps__detail"> · {detail}</span>}
        </li>
      ))}
    </ol>
  )
}

// Ways to start. With a team: two requests he passes on, one for a new agent, one for what else he does
// (look into what broke). With no one yet: two to make an agent, two of what else he does.
// A click sends it, so the conversation starts at once; he asks for the rest.
const REQUESTS = (): { label: string; say: string }[] => [
  { label: L('Um aviso pros meus clientes', 'A notice to my customers'), say: L('Preciso de um aviso curto pros meus clientes sobre uma novidade.', 'I need a short notice to my customers about some news.') },
  { label: L('Pesquisar um assunto pra mim', 'Look into a subject for me'), say: L('Quero que alguém pesquise um assunto pra mim e me traga um resumo.', 'I want someone to look into a subject for me and bring me a summary.') },
  { label: L('Um agente novo no time', 'A new agent on the team'), say: L('Quero um agente novo no time.', 'I want a new agent on the team.') },
  { label: L('Por que uma rotina falhou?', 'Why did a routine fail?'), say: L('Por que uma rotina falhou?', 'Why did a routine fail?') }
]
const SUGGESTIONS = (): { label: string; say: string }[] => [
  { label: L('Triar os tickets de suporte toda manhã', 'Triage the support tickets every morning'), say: L('Quero alguém pra triar os tickets de suporte toda manhã.', 'I want someone to triage the support tickets every morning.') },
  { label: L('Resumir meu dia às 18h', 'Sum up my day at 6 pm'), say: L('Quero alguém pra resumir o meu dia todo dia às 18h.', 'I want someone to sum up my day every day at 6 pm.') },
  { label: L('Por que uma rotina falhou?', 'Why did a routine fail?'), say: L('Por que uma rotina falhou?', 'Why did a routine fail?') },
  { label: L('Como funcionam as aprovações?', 'How do approvals work?'), say: L('Como funcionam as aprovações?', 'How do approvals work?') }
]

const modelName = (id: string): string => {
  const m = modelInfo(id)
  if (!m) return id || '—'
  return m.id ? `${ENGINES[m.engine].label} · ${m.label}` : ENGINES[m.engine].label
}

// The Tuca's model as a chip in his field: it opens the same picker, above it.
function ModelChip({ value, onPick, note, applying }: { value: string; onPick: (v: string) => void; note: string; applying: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    // A pick in the picker's own menu (drawn outside, over the page) isn't a click outside.
    const down = (e: MouseEvent): void => {
      const t = e.target as Element | null
      if (box.current?.contains(t) || t?.closest?.('.select__menu')) return
      setOpen(false)
    }
    // Escape closes the picker's menu first, then this (caught before the menu closes).
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && !document.querySelector('.select__menu') && setOpen(false))
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])
  return (
    <span className="onb-tc__model" ref={box}>
      <button className={`onb-tc__chip ${open ? 'is-open' : ''}`} title={note} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        {applying && <span className="onb-tc__dot" aria-hidden />}
        {value ? modelName(value) : L('Escolher o modelo', 'Pick the model')}
        <Icon name="caret" size={12} />
      </button>
      {open && (
        <div className="onb-tc__pop" role="dialog" aria-label={L('Modelo do Tuca', 'Tuca’s model')}>
          <b>{L('Modelo do Tuca', 'Tuca’s model')}</b>
          <ModelPicker value={value} onChange={onPick} />
          <span className="hint">{applying ? L('Chamando o Tuca com esse modelo…', 'Calling Tuca with this model…') : note}</span>
        </div>
      )}
    </span>
  )
}

// The person's other conversations with the Tuca, to go back to one: each is kept, one per request.
function TucaConversations({ current, onPick }: { current?: string; onPick: (id: string) => void }): ReactNode {
  // As text: the rows are made new at every look, and a string is the same while nothing in them changed.
  const rows = useStore((s) => JSON.stringify(tucaConversations(s).map((c) => ({ id: c.id, title: tucaTitle(s, c), at: lastSaid(s, c) }))))
  const list = JSON.parse(rows) as { id: string; title: string; at: number }[]
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => void (!box.current?.contains(e.target as Element | null) && setOpen(false))
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && setOpen(false))
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  if (list.length < 2) return null
  return (
    <span className="onb-tc__convs" ref={box}>
      <button className="btn btn--ghost btn--sm" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        {L(`Conversas (${list.length})`, `Conversations (${list.length})`)} <Icon name="caret" size={12} />
      </button>
      {open && (
        <div className="onb-tc__convs-pop" role="menu" aria-label={L('Suas conversas com o Tuca', 'Your conversations with Tuca')}>
          {list.map((c) => (
            <button key={c.id} role="menuitemradio" aria-checked={c.id === current} className={`onb-tc__conv ${c.id === current ? 'is-on' : ''}`} onClick={() => (setOpen(false), onPick(c.id))}>
              <span className="onb-tc__conv-title">{c.title}</span>
              <span className="onb-tc__conv-when">{ago(c.at)}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

// What the person let the Tuca do himself, with a way to take each back: he asks again the next time.
// In sight only while there is something to take back.
function TucaLeavesMenu(): ReactNode {
  const rows = useStore((s) => JSON.stringify(leaveRows(s)))
  const list = JSON.parse(rows) as LeaveRow[]
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => void (!box.current?.contains(e.target as Element | null) && setOpen(false))
    const key = (e: KeyboardEvent): void => void (e.key === 'Escape' && setOpen(false))
    document.addEventListener('mousedown', down)
    window.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open])
  if (!list.length) return null
  return (
    <span className="onb-tc__convs" ref={box}>
      <button className="btn btn--ghost btn--sm" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title={L('O que você deixou o Tuca fazer ele mesmo. Dá pra retirar.', 'What you let Tuca do himself. You can take it back.')}>
        {L(`Liberado (${list.length})`, `Allowed (${list.length})`)} <Icon name="caret" size={12} />
      </button>
      {open && (
        <div className="onb-tc__convs-pop" role="dialog" aria-label={L('O que o Tuca pode fazer ele mesmo', 'What Tuca may do himself')}>
          <p className="onb-tc__leaves-note">{L('O que você deixou o Tuca fazer ele mesmo, quando ninguém do time faz. Retirando, ele volta a perguntar.', 'What you let Tuca do himself, when no one on the team does it. Take one back and he asks again.')}</p>
          {list.map((l) => (
            <div key={l.id} className="onb-tc__leave">
              <span className="onb-tc__leave-text">
                <span className="onb-tc__leave-kind">{l.kind}</span>
                <span className="onb-tc__leave-sub">
                  {L(`Usando ${l.uses}`, `Using ${l.uses}`)} · {l.where}
                </span>
              </span>
              <button className="link" onClick={() => void removeTucaLeave(l.id)}>
                {L('Retirar', 'Take back')}
              </button>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

// With the Tuca: he takes a request and passes it on, or asks and proposes an agent, and the card beside
// the chat fills in with what he proposes. He starts on his own model; changing it keeps the conversation
// (he goes on from it on the new one). "Nova conversa" starts another: this one stays in "Conversas".
function MeetTuca({ conv: session, setConv, onUse, onManual, subject, onBuild, onTeam }: { conv: { id?: string; error?: string }; setConv: (id: string) => void; onUse: (d: AgentDraft, messageId: string) => void; onManual: () => void; subject: Subject; onBuild: () => void; onTeam: () => void }): ReactNode {
  const conv = session.id
  const tuca = useStore((s) => s.agents.find((a) => a.kind === 'tuca'))
  // What he proposes inside the app is made when his reply ends (not in the introduction, nor when turned off).
  const applyNow = useStore((s) => s.settings.tucaApplyNow !== false && s.settings.onboarding?.done !== false && amAdmin(s))
  const [model, setModel] = useState(tuca?.modelId ?? '')
  const [applying, setApplying] = useState(false)
  const [modelError, setModelError] = useState('')
  const typed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    if (!model && tuca?.modelId) setModel(tuca.modelId)
  }, [model, tuca?.modelId])
  useEffect(() => () => clearTimeout(typed.current), [])
  const error = session.error ?? ''
  const messages = useStore((s) => (conv ? messagesIn(s, conv) : []))
  const said = messages.some((m) => m.author.kind === 'person')
  const [starting, setStarting] = useState(false)
  const hasTeam = useStore((s) => s.agents.some(isTeam))
  const building = subject === 'build'

  // Another conversation: this one is kept as it is, cards and all, and stays in "Conversas".
  async function startOver(): Promise<void> {
    setStarting(true)
    try {
      setConv((await ensureTuca(undefined, true)).conversationId)
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e))
    } finally {
      setStarting(false)
    }
  }

  async function start(value: string): Promise<void> {
    if (conv && value === tuca?.modelId) return
    setApplying(true)
    setModelError('')
    try {
      // He's made with the chosen model; once he exists, it's saved on him and he goes on in the same conversation.
      if (tuca) {
        const channels = getState().conversations.filter((c) => c.kind === 'channel' && c.members.includes(tuca.id)).map((c) => c.id)
        await saveAgent({ ...tuca, modelId: value }, channels)
      }
      setConv((await ensureTuca(value)).conversationId)
    } catch (e) {
      setModelError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  // A model from the list starts him right away; a name being typed waits for a pause.
  // A harness alone (no model yet) waits for the model.
  function pick(value: string): void {
    setModel(value)
    setModelError('')
    clearTimeout(typed.current)
    const m = modelInfo(value)
    if (!m?.id) return
    if (MODELS.some((x) => x.id === value)) return void start(value)
    typed.current = setTimeout(() => void start(value), 900)
  }

  const note = conv
    ? L('Trocar o modelo mantém a conversa: ele continua de onde parou.', 'Changing the model keeps the conversation: he goes on from where you left off.')
    : L('Escolha com qual modelo o Tuca conversa com você, passa os pedidos e monta os agentes.', 'Pick the model Tuca uses to talk with you, pass requests on and build the agents.')
  const chip = <ModelChip value={model} onPick={pick} note={note} applying={applying} />

  return (
    <div className="onb-tc">
      <section className="onb-tc__main">
        <header className="onb-tc__head">
          <AgentAvatar agent={tuca ?? { name: 'Tuca', color: 'amber', kind: 'tuca' }} size={36} />
          <div className="grow">
            <h1 className="onb-tc__title">Tuca</h1>
            <p className="onb-tc__lede">{L('Recebe seus pedidos, passa pra quem do time faz e cuida do Tucano.', 'Takes your requests, passes them to whoever on the team does it, and looks after Tucano.')}</p>
          </div>
          {conv && tuca && <TucaLeavesMenu />}
          {conv && tuca && <TucaConversations current={conv} onPick={setConv} />}
          {conv && tuca && (
            <button
              className="btn btn--ghost btn--sm"
              disabled={!said || starting}
              onClick={() => void startOver()}
              title={L('Começa outra conversa com o Tuca. Esta continua guardada, em Conversas.', 'Starts another conversation with Tuca. This one is kept, under Conversations.')}
            >
              <Icon name="plus" size={13} /> {L('Nova conversa', 'New conversation')}
            </button>
          )}
        </header>
        <div className={`onb-tc__chat ${said ? '' : 'is-fresh'}`}>
          {conv && tuca ? (
            <UseDraft.Provider value={onUse}>
              <MessageList messages={messages} conversationId={conv} />
              {!said && (
                <div className="onb-tc__ideas" aria-label={L('Sugestões pra começar', 'Ideas to start with')}>
                  {(building ? SUGGESTIONS() : REQUESTS()).map((s) => (
                    <button key={s.label} className="onb-tc__idea" onClick={() => sendMessage(conv, s.say)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
              <Composer conversationId={conv} members={[tuca]} tools={chip} placeholder={said ? L('Responda ou escreva outra coisa…', 'Reply or write something else…') : building ? L('Ex.: quero alguém pra triar os tickets de suporte toda manhã', 'E.g. I want someone to triage the support tickets every morning') : L('Ex.: preciso de um aviso curto pros meus clientes', 'E.g. I need a short notice to my customers')} />
            </UseDraft.Provider>
          ) : (
            <div className="onb-tc__wait">
              <p className="muted">{error || L('Chamando o Tuca…', 'Calling Tuca…')}</p>
              {chip}
            </div>
          )}
        </div>
        <div className="onb-tc__foot">
          <span>
            {!building && L('O Tuca passa pra quem do time faz. ', 'Tuca passes it to whoever on the team does it. ')}
            {applyNow ? L('O que ele cria entra na hora, e dá pra desfazer.', 'What Tuca creates takes effect immediately and can be undone.') : L('Nada é criado sem você.', 'Nothing is created without you.')}
          </span>
          {modelError && <span className="hint hint--warn">{modelError}</span>}
          {building && (
            <button className="onb-tc__manual" onClick={onManual}>
              {L('Prefiro montar eu mesmo', 'I’d rather build it myself')}
            </button>
          )}
        </div>
      </section>
      <aside className="onb-tc__aside">
        {building || !conv || !tuca ? <ProposalSide message={newestDraft(messages)} model={model} onUse={onUse} onTeam={hasTeam ? onTeam : undefined} /> : <TeamSide key={conv} conversationId={conv} tucaId={tuca.id} onBuild={onBuild} />}
      </aside>
    </div>
  )
}

// Beside the chat: the proposal filling in. Before the Tuca proposes, its rows wait ("—") and the
// model is his own (a proposal that names none gets his). With a proposal, "Criar agente" makes it as
// proposed (and tries its first task); "Editar antes" sets its access and first task first.
function ProposalSide({ message, model, onUse, onTeam }: { message?: Message; model: string; onUse: (d: AgentDraft, messageId: string) => void; onTeam?: () => void }): ReactNode {
  const stage = tucaStage(message)
  const d = stage === 'talk' ? undefined : message?.run?.agentDraft
  const connectors = useStore((s) => s.connectors)
  const created = useStore((s) => (d?.agentId ? s.agents.find((a) => a.id === d.agentId) : undefined))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [more, setMore] = useState(false)
  useEffect(() => (setError(''), setMore(false)), [message?.id])
  // Its schedule, when he proposed a routine for it in the same reply.
  const routines = d && message ? proposalsOf(message.run).flatMap((p) => (p.kind === 'routine' && (p.needs?.some((n) => n.toLowerCase() === d.name.toLowerCase()) || (!!d.agentId && p.routine.agentId === d.agentId)) ? [p.routine] : [])) : []
  const access = d ? Object.entries(d.grants).map(([id, level]) => `${connectors.find((c) => c.id === id)?.name ?? L('conector', 'connector')} (${level === 'read_write' ? L('leitura e escrita', 'read and write') : L('leitura', 'read')})`) : []
  const does = d?.instructions.split('\n').find((l) => l.trim())?.trim() ?? ''

  async function create(): Promise<void> {
    if (!message || !d || busy) return
    setBusy(true)
    setError('')
    try {
      const { conversationId } = await createFromDraft(message.id)
      // As "Criar e testar" does: the first task goes out, and the screen shows it made.
      if (d.task) sendMessage(conversationId, d.task)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  // Made by itself when his reply ended: taken back, the card is a conversation again.
  async function undo(): Promise<void> {
    if (!message || busy) return
    setBusy(true)
    setError('')
    try {
      await undoProposal(message.id, undefined, true)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  const rows: { label: string; value: ReactNode; quiet?: boolean; title?: string }[] = [
    { label: L('Nome', 'Name'), value: d ? (d.role ? `${d.name} · ${d.role}` : d.name) : '—' },
    {
      label: L('O que faz', 'What it does'),
      value: d ? (
        <span className={`onb-tc__does ${more ? 'is-open' : ''}`} onClick={() => setMore(!more)} title={more ? undefined : L('Ver tudo', 'Show all')}>
          {more ? d.instructions : does}
        </span>
      ) : (
        '—'
      )
    },
    { label: L('Quando', 'When'), value: d ? (routines.length ? routines.map((r) => describeRoutine(r)).join('; ') : L('Quando você pedir', 'When you ask')) : '—' },
    { label: L('Acesso', 'Access'), value: d ? [d.web ? L('Web', 'Web') : L('Sem web', 'No web'), access.length ? access.join(', ') : L('sem conectores', 'no connectors')].join(' · ') : '—' },
    {
      label: L('Modelo', 'Model'),
      value: d ? `${modelName(d.modelId)} · ${EFFORT()[d.effort]}` : model ? modelName(model) : '—',
      quiet: !d,
      title: d ? undefined : L('Se ele não escolher outro, o agente usa o modelo do Tuca.', 'Unless Tuca chooses another model, the agent uses Tuca’s model.')
    }
  ]

  return (
    <div className={`onb-tc__card is-${stage}`}>
      <div className="onb-tc__card-head" key={d ? `${message?.id}-${stage}` : 'empty'}>
        {d ? <AgentAvatar agent={created ?? { name: d.name, color: d.color }} size={36} /> : <span className="onb-tc__ghost" aria-hidden />}
        <div className="grow">
          <strong>{created?.name ?? d?.name ?? L('Proposta', 'Proposal')}</strong>
          <span className="muted small">
            {stage === 'done' ? L('Entrou no time', 'Joined the team') : d ? L('Proposta do Tuca, pronta pra criar', 'Tuca’s proposal, ready to create') : L('Vai se montando enquanto vocês conversam', 'Updates as you talk to Tuca')}
          </span>
        </div>
      </div>
      <dl className="onb-tc__rows">
        {rows.map((r) => (
          <div key={r.label} title={r.title}>
            <dt>{r.label}</dt>
            <dd className={r.value === '—' ? 'is-empty' : r.quiet ? 'is-quiet' : ''}>{r.value}</dd>
          </div>
        ))}
      </dl>
      {error && <p className="note note--error">{error}</p>}
      {stage === 'done' ? (
        <div className="onb-tc__actions">
          {created && (
            <>
              {/* Made by itself as he proposed it: its first test waits for this click, as "Criar agente" would send it. */}
              {d?.auto && d.task ? (
                <button className="btn btn--primary onb-tc__go" onClick={() => void askAgent(created.id, d.task!).then((id) => navigate({ kind: 'conversation', id }))}>
                  {L(`Testar ${created.name}`, `Try ${created.name}`)}
                </button>
              ) : (
                <button className="btn btn--primary onb-tc__go" onClick={() => void openDm(created.id)}>
                  {L(`Abrir conversa com ${created.name}`, `Open conversation with ${created.name}`)}
                </button>
              )}
              {d?.auto && d.task && <p className="hint">“{d.task}”</p>}
              <div className="onb-tc__more">
                <button className="link" onClick={() => navigate({ kind: 'agent', id: created.id })}>
                  {L('Ver perfil', 'See profile')}
                </button>
                {d?.undo && Date.now() < d.undo.until && message && (
                  <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void undo()}>
                    {L('Desfazer', 'Undo')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="onb-tc__actions">
          <button className="btn btn--primary onb-tc__go" disabled={!d || busy} onClick={() => void create()}>
            {busy ? L('Criando…', 'Creating…') : L('Criar agente', 'Create agent')}
          </button>
          {d && message && (
            <>
              {d.task && <p className="hint">{L(`Ao criar, ele já faz um teste: “${d.task}”`, `Once created, it tries a first task: “${d.task}”`)}</p>}
              <div className="onb-tc__more">
                <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => onUse(d, message.id)} title={L('Escolher o que ele pode usar e a primeira tarefa antes de criar', 'Pick what it can use and its first task before creating it')}>
                  {L('Editar antes', 'Edit first')}
                </button>
                <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => settleDraft(message.id)}>
                  {L('Descartar', 'Discard')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {onTeam && stage !== 'proposal' && (
        <button className="link onb-tc__back" onClick={onTeam}>
          {L('Ver o time', 'See the team')}
        </button>
      )}
    </div>
  )
}

function MakeAgent(p: {
  agent: Agent
  handle: string
  template: Template
  pick: (t: Template) => void
  patch: (a: Partial<Agent>) => void
  computer: Computer
  onBack: () => void
  onNext: () => void
}): ReactNode {
  const { agent, patch } = p
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{L('Novo agente', 'New agent')}</span>
        <h1>{L('Quem vai trabalhar com você?', 'Who’s going to work with you?')}</h1>
        <p className="onb__lead">{L('Comece por um dos exemplos e ajuste o que quiser. Depois você monta o resto do time.', 'Start from one of the examples and adjust anything. You build the rest of the team later.')}</p>
        <div className="onb-templates">
          {TEMPLATES().map((t) => (
            <button key={t.id} className={`onb-template ${p.template.id === t.id ? 'is-active' : ''}`} onClick={() => p.pick(t)}>
              <span className={`onb-template__icon c-${t.color}`}>
                <Icon name={t.icon} size={15} />
              </span>
              <strong>{t.title}</strong>
              <span>{t.pitch}</span>
            </button>
          ))}
        </div>
        <div className="onb__row">
          <label className="onb__field">
            <span>{L('Nome', 'Name')}</span>
            <input value={agent.name} placeholder={L('Ex.: Iris', 'E.g. Iris')} onChange={(e) => patch({ name: e.target.value })} />
          </label>
          <label className="onb__field">
            <span>{L('Papel', 'Role')}</span>
            <input value={agent.role} placeholder={L('Ex.: Pesquisa', 'E.g. Research')} onChange={(e) => patch({ role: e.target.value })} />
          </label>
        </div>
        <div className="onb__field">
          <span>{L('Cor', 'Color')}</span>
          <ColorPicker agent={agent} patch={patch} />
        </div>
        <div className="onb__field">
          <span>{L('Aparência', 'Look')}</span>
          <LookPicker agent={agent} patch={patch} />
        </div>
        <div className="onb__field">
          <span>{L('Modelo', 'Model')}</span>
          <ModelPicker value={agent.modelId} onChange={(modelId) => patch({ modelId })} />
        </div>
        <label className="onb__field">
          <span>{L(`O que ${agent.name.trim() || 'o agente'} faz`, `What ${agent.name.trim() || 'the agent'} does`)}</span>
          <textarea rows={4} value={agent.instructions} placeholder={L('Escreva como explicaria pra um colega novo: o que fazer, o que evitar, quando perguntar.', 'Write it as you’d explain it to a new colleague: what to do, what to avoid, when to ask.')} onChange={(e) => patch({ instructions: e.target.value })} />
          {instructionLengthNote(agent.instructions.length) && <p className="hint hint--warn">{instructionLengthNote(agent.instructions.length)}</p>}
        </label>
        <Nav onBack={p.onBack} onNext={p.onNext} disabled={!agent.name.trim() || !usable(modelInfo(agent.modelId))} />
      </section>
      <aside className="onb__aside">
        <AgentCard agent={agent} handle={p.handle} computer={p.computer} />
      </aside>
    </div>
  )
}

function AgentCard({ agent, handle, computer }: { agent: Agent; handle: string; computer: Computer }): ReactNode {
  const model = modelInfo(agent.modelId)
  const name = agent.name.trim() || L('Seu agente', 'Your agent')
  const first = agent.instructions.trim().split(/(?<=\.)\s/)[0]
  return (
    <div className="onb-card">
      <AgentAvatar agent={{ ...agent, name }} size={64} />
      <h2>{name}</h2>
      <span className="muted">
        @{handle}
        {agent.role.trim() ? ` · ${agent.role.trim()}` : ''}
      </span>
      {model && (
        <span className="onb-card__model">
          {ENGINES[model.engine].label} · {model.label}
        </span>
      )}
      <div className="onb-card__powers">
        <Power on={agent.web !== false} icon="globe" label="Web" />
        <Power on={computer !== 'none'} icon={computer === 'mac' ? 'laptop' : 'terminal'} label={computer === 'mac' ? L('Seu computador', 'Your computer') : L('Computador', 'Computer')} />
        <Power on={!!agent.browser} icon="pointer" label={L('Navegador', 'Browser')} />
      </div>
      <div className="onb-card__bubble">
        <AgentAvatar agent={{ ...agent, name }} size={22} />
        <p>
          {L(`Oi! Eu sou ${agent.name.trim() ? `${agent.name.trim()}` : 'o seu agente'}.`, `Hi! I’m ${agent.name.trim() ? `${agent.name.trim()}` : 'your agent'}.`)}{first ? ` ${first}` : L(' Me diz o que eu faço e eu começo.', ' Tell me what I do and I’ll get started.')}
        </p>
      </div>
    </div>
  )
}

function Power({ on, icon, label }: { on: boolean; icon: IconName; label: string }): ReactNode {
  return (
    <span className={`onb-power ${on ? 'is-on' : ''}`}>
      <Icon name={icon} size={12} /> {label}
    </span>
  )
}

// ---------- 5. powers ----------

function Powers(p: {
  agent: Agent
  handle: string
  patch: (a: Partial<Agent>) => void
  computer: Computer
  setComputer: (c: Computer) => void
  grants: Record<string, GrantLevel>
  setGrants: (g: Record<string, GrantLevel>) => void
  onBack: () => void
  onNext: () => void
}): ReactNode {
  const { agent, patch, computer } = p
  const name = agent.name.trim() || L('Ele', 'It')
  const connectors = useStore((s) => s.connectors)
  const isolated = useStore((s) => s.isolatedComputers)
  const settingsLevel = useStore((s) => s.settings.autonomy)
  const guard = useStore((s) => s.settings.outsideGuard ?? true)
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{L(`Novo agente · O que ${name} pode usar`, `New agent · What ${name} can use`)}</span>
        <h1>{L('Dê ferramentas, não chaves.', 'Give tools, not keys.')}</h1>
        <p className="onb__lead">{L('Ligue só o que a função pede. Tudo isso muda depois na página do agente, e cada ação aparece na conversa.', 'Turn on only what the role needs. All of this can change later on the agent’s page, and every action shows up in the conversation.')}</p>
        <div className="onb-powers">
          <div className="onb-power-row">
            <span className="onb-power-row__icon">
              <Icon name="globe" size={18} />
            </span>
            <div>
              <strong>{L('Pesquisa na web', 'Web search')}</strong>
              <p>{L('Busca e lê páginas pra responder com fontes atuais.', 'Searches and reads pages to answer with current sources.')}</p>
            </div>
            <Toggle on={agent.web !== false} onChange={(v) => patch({ web: v })} />
          </div>
          <div className="onb-power-row">
            <span className="onb-power-row__icon">
              <Icon name="pointer" size={18} />
            </span>
            <div>
              <strong>{L('Navegador próprio', 'Its own browser')}</strong>
              <p>{L('Um Chrome só dele: abre sites, clica e preenche. Você assiste ao vivo e assume quando precisar entrar numa conta.', 'A Chrome of its own: opens sites, clicks and fills in. You watch live and take over when it needs to sign in to an account.')}</p>
            </div>
            <Toggle on={!!agent.browser} onChange={(v) => patch({ browser: v })} />
          </div>
          <div className="onb-power-row onb-power-row--stack">
            <span className="onb-power-row__icon">
              <Icon name="terminal" size={18} />
            </span>
            <div>
              <strong>{L('Computador', 'Computer')}</strong>
              <p>{L('Onde ele roda comandos, cria arquivos e sobe sites e apps pra você ver.', 'Where it runs commands, creates files and starts sites and apps for you to see.')}</p>
              <div className="segmented segmented--wide">
                {(
                  [
                    ['none', L('Nenhum', 'None')],
                    ['linux', L('Linux isolado', 'Isolated Linux')],
                    ['mac', L('Este computador', 'This computer')]
                  ] as const
                )
                  .filter(([k]) => k !== 'linux' || isolated)
                  .map(([k, label]) => (
                  <button key={k} className={computer === k ? 'is-active' : ''} onClick={() => p.setComputer(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {computer === 'none' && <p className="hint">{L('Só conversa, web e navegador. Dá pra ligar depois.', 'Just chat, web and browser. You can turn it on later.')}</p>}
              {computer === 'linux' && <p className="hint">{L('Um computador só dele, separado do seu. Instala e roda o que precisar sem pedir. Precisa do Docker rodando.', 'A computer of its own, apart from yours. It installs and runs what it needs without asking. Needs Docker running.')}</p>}
              {computer === 'mac' && (
                <p className="hint hint--warn">
                  <Icon name="lock" size={13} /> {L(`${agent.name.trim() || 'O agente'} roda comandos no seu computador como se fosse você, com tudo o que você tem instalado. Escolha só se confia nesse papel.`, `${agent.name.trim() || 'The agent'} runs commands on your computer as if it were you, with everything you have installed. Only choose this if you trust that role.`)}
                </p>
              )}
            </div>
          </div>
        </div>
        {connectors.length > 0 && (
          <div className="onb-powers onb-powers--tools">
            {connectors.map((c) => {
              const level = p.grants[c.id] ?? 'read' // reading is safe to start with
              return (
                <div key={c.id} className="onb-power-row">
                  <span className="onb-power-row__icon onb-power-row__icon--tile">
                    <ConnectorTile c={c} size={22} />
                  </span>
                  <div>
                    <strong>{c.name}</strong>
                    <p>{c.tools.length ? L(`${c.tools.length} ferramentas`, `${c.tools.length} tools`) : L('conectando…', 'connecting…')}</p>
                  </div>
                  <div className="segmented">
                    {(
                      [
                        ['none', L('Sem acesso', 'No access')],
                        ['read', L('Ler', 'Read')],
                        ['read_write', L('Ler e escrever', 'Read and write')]
                      ] as const
                    ).map(([v, label]) => (
                      <button key={v} className={level === v ? 'is-active' : ''} onClick={() => p.setGrants({ ...p.grants, [c.id]: v })}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
        <AutonomyPick compact name={agent.name.trim() || L('o agente', 'the agent')} value={autonomyChosen(agent.autonomy, settingsLevel)} guard={guard} onPick={(level) => patch({ autonomy: storedAutonomy(level, settingsLevel) })} />
        <Nav onBack={p.onBack} onNext={p.onNext} />
      </section>
      <aside className="onb__aside">
        <AgentCard agent={agent} handle={p.handle} computer={computer} />
      </aside>
    </div>
  )
}

// ---------- 6. the first task ----------

function FirstTask(p: {
  agent: Agent
  handle: string
  computer: Computer
  manual: boolean // from the introduction: #geral, with the message waiting there
  tasks: string[]
  task: string
  setTask: (t: string) => void
  busy: boolean
  error?: string
  onBack: () => void
  onFinish: () => void
}): ReactNode {
  const name = p.agent.name.trim()
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{L('Novo agente · Mão na massa', 'New agent · Hands on')}</span>
        <h1>{L(`O que ${name} faz primeiro?`, `What does ${name} do first?`)}</h1>
        <p className="onb__lead">
          {p.manual
            ? L(`Vou chamar ${name} pro canal #geral e deixar este pedido escrito lá. Você confere e aperta enviar.`, `I’ll bring ${name} into #general and leave this request written there. You check it and press send.`)
            : L(`Vou abrir uma conversa com ${name} e mandar o pedido. Você acompanha cada passo enquanto ${name} trabalha.`, `I’ll open a conversation with ${name} and send the request. You follow every step while ${name} works.`)}
        </p>
        <div className="onb-tasks">
          {p.tasks.map((t) => (
            <button key={t} className={`onb-task ${p.task === t ? 'is-active' : ''}`} onClick={() => p.setTask(t)}>
              {t}
            </button>
          ))}
        </div>
        <div className="onb-composer">
          <span className="onb-composer__at">@{p.handle}</span>
          <textarea rows={3} value={p.task} onChange={(e) => p.setTask(e.target.value)} />
        </div>
        {p.error && (
          <p className="note note--error" role="alert">
            {p.error}
          </p>
        )}
        <Nav
          onBack={p.onBack}
          onNext={p.onFinish}
          disabled={!p.task.trim() || p.busy}
          next={
            <>
              {p.manual ? L(`Chamar ${name} pro time`, `Bring ${name} to the team`) : <><Icon name="send" size={14} /> {L(`Criar ${name} e enviar`, `Create ${name} and send`)}</>}
            </>
          }
        />
      </section>
      <aside className="onb__aside">
        <AgentCard agent={p.agent} handle={p.handle} computer={p.computer} />
      </aside>
    </div>
  )
}
