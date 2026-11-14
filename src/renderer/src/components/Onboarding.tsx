// A new agent, step by step: the Tuca's builder screen (from the sidebar), where he proposes one and
// the person sets what it can use and its first task; and the introduction's "Prefiro configurar do
// zero" (Intro.tsx), the same form from a template, which hands the agent back to the introduction.
import { L } from '../../../shared/lang'
import { instructionLengthNote } from '../../../shared/instructions'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ENGINES,
  MODELS,
  customModel,
  getState,
  dmWith,
  modelInfo,
  usable,
  navigate,
  newAgentDraft,
  saveAgent,
  sendMessage,
  slug,
  ensureTuca,
  settleDraft,
  messagesIn,
  proposalsOf,
  useStore,
  type Agent,
  type AgentColor,
  type AgentDraft,
  type GrantLevel,
  type State,
  type View
} from '../store'
import { ModelPicker, usableEngines } from './Harness'
import { ColorPicker, LookPicker, Toggle } from './Pages'
import { Composer, MessageList } from './Conversation'
import { draftAgent, UseDraft } from './Tuca'
import { AutonomyPick } from './AutonomyPick'
import { autonomyChosen, FIRST_AUTONOMY, storedAutonomy } from '../../../shared/onboarding'
import { AgentAvatar, Icon, type IconName } from './ui'
import { ConnectorTile } from './ConnectorStore'

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

export function Onboarding({ build = false, from, manual }: { build?: boolean; from?: View; manual?: ManualIntro } = {}): ReactNode {
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
      <header className="onb__top">
        <div className="onb__dots" aria-label={L(`Passo ${at + 1} de ${steps.length}`, `Step ${at + 1} of ${steps.length}`)}>
          {steps.map((s, i) => (
            <span key={s} className={i === at ? 'is-now' : i < at ? 'is-done' : ''} />
          ))}
        </div>
        <button className="btn btn--ghost btn--sm" onClick={close}>
          {manual ? L('Voltar', 'Back') : L('Fechar', 'Close')}
        </button>
      </header>

      <div className="onb__scroll">
        <div className="onb__stage" key={step} data-dir={dir}>
          {step === 'agent' &&
            (hand ? (
              <MakeAgent agent={agent} handle={handle} template={template} pick={pick} patch={patch} computer={computer} onBack={() => (manual ? manual.onBack() : setManual(false))} onNext={next} />
            ) : (
              <MeetTuca conv={tucaConv} onUse={useDraft} onManual={() => setManual(true)} />
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

// A new agent, made with the Tuca: he asks, proposes a card, "Usar esse agente" fills it in.
// He starts on his own model; changing it keeps the conversation (he goes on from it on the new one).
// "Nova conversa" starts over: asked first when cards there weren't applied yet.
function MeetTuca({ conv: session, onUse, onManual }: { conv: { id?: string; error?: string }; onUse: (d: AgentDraft, messageId: string) => void; onManual: () => void }): ReactNode {
  const [conv, setConv] = useState(session.id)
  const tuca = useStore((s) => s.agents.find((a) => a.kind === 'tuca'))
  const [model, setModel] = useState(tuca?.modelId ?? '')
  const [applying, setApplying] = useState(false)
  const [modelError, setModelError] = useState('')
  const typed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => setConv(session.id), [session.id])
  useEffect(() => {
    if (!model && tuca?.modelId) setModel(tuca.modelId)
  }, [model, tuca?.modelId])
  useEffect(() => () => clearTimeout(typed.current), [])
  const error = session.error ?? ''
  const messages = useStore((s) => (conv ? messagesIn(s, conv) : []))
  const latest = [...messages].reverse().find((m) => m.run?.agentDraft && !m.run.agentDraft.state)?.run?.agentDraft
  // Cards not applied or discarded yet: starting over drops them, so it asks first.
  const unsettled = messages.reduce((n, m) => n + (m.run?.agentDraft && !m.run.agentDraft.state ? 1 : 0) + proposalsOf(m.run).filter((p) => !p.state).length, 0)
  const said = messages.some((m) => m.author.kind === 'person')
  const [confirmNew, setConfirmNew] = useState(false)
  const [starting, setStarting] = useState(false)

  async function startOver(): Promise<void> {
    setStarting(true)
    try {
      setConv((await ensureTuca(undefined, true)).conversationId)
      setConfirmNew(false)
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

  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{L('Tuca · Novo agente', 'Tuca · New agent')}</span>
        <h1>{L('Conte pro Tuca o que você quer delegar', 'Tell Tuca what you want to delegate')}</h1>
        <p className="onb__lead">
          {L('Ele faz duas ou três perguntas e propõe um agente. Nada é criado sem você.', 'He asks two or three questions and proposes an agent. Nothing is created without you.')}
        </p>
        <div className="onb__field onb__field--tuca-model">
          <span>{L('Modelo do Tuca', 'Tuca’s model')}</span>
          <ModelPicker value={model} onChange={pick} />
          <span className="hint">
            {applying
              ? L('Chamando o Tuca com esse modelo…', 'Calling Tuca with this model…')
              : conv
                ? L('Trocar o modelo mantém a conversa: ele continua de onde parou.', 'Changing the model keeps the conversation: he goes on from where you left off.')
                : L('Escolha com qual modelo o Tuca conversa com você e monta os agentes.', 'Pick the model Tuca uses to talk with you and build the agents.')}
          </span>
          {modelError && <p className="hint hint--warn">{modelError}</p>}
        </div>
        {conv && tuca && (
          <div className="onb-tuca__bar">
            {confirmNew ? (
              <>
                <span className="small">
                  {unsettled
                    ? L(`${unsettled === 1 ? 'Tem 1 proposta que você não aplicou' : `Tem ${unsettled} propostas que você não aplicou`}. Começar uma conversa nova apaga esta, com ${unsettled === 1 ? 'ela' : 'elas'}.`, `There ${unsettled === 1 ? 'is 1 proposal you haven’t applied' : `are ${unsettled} proposals you haven’t applied`}. Starting a new conversation deletes this one, with ${unsettled === 1 ? 'it' : 'them'}.`)
                    : L('Começar uma conversa nova apaga esta.', 'Starting a new conversation deletes this one.')}
                </span>
                <button className="btn btn--sm btn--danger" disabled={starting} onClick={() => void startOver()}>
                  {L('Começar do zero', 'Start over')}
                </button>
                <button className="btn btn--ghost btn--sm" disabled={starting} onClick={() => setConfirmNew(false)}>
                  {L('Manter esta', 'Keep this one')}
                </button>
              </>
            ) : (
              <>
                <span className="muted small">{said ? L('A conversa fica aqui quando você sai e volta.', 'The conversation stays here when you leave and come back.') : ''}</span>
                <button className="btn btn--ghost btn--sm" disabled={!said || starting} onClick={() => (unsettled ? setConfirmNew(true) : void startOver())} title={L('Começa outra conversa com o Tuca, do zero', 'Starts another conversation with Tuca, from scratch')}>
                  <Icon name="plus" size={13} /> {L('Nova conversa', 'New conversation')}
                </button>
              </>
            )}
          </div>
        )}
        <div className="onb-tuca">
          {conv && tuca ? (
            <UseDraft.Provider value={onUse}>
              <MessageList messages={messages} conversationId={conv} />
              <Composer conversationId={conv} members={[tuca]} placeholder={L('Ex.: quero alguém pra triar os tickets de suporte toda manhã', 'E.g. I want someone to triage the support tickets every morning')} />
            </UseDraft.Provider>
          ) : (
            <p className="muted onb-tuca__wait">{error || L('Chamando o Tuca…', 'Calling Tuca…')}</p>
          )}
        </div>
        <div className="onb__nav">
          <span />
          <button className="btn btn--ghost" onClick={onManual}>
            {L('Prefiro montar eu mesmo', 'I’d rather build it myself')}
          </button>
        </div>
      </section>
      <aside className="onb__aside">
        {latest ? (
          <AgentCard agent={draftAgent(latest)} handle={slug(latest.name)} computer="none" />
        ) : (
          <div className="onb-card onb-card--empty">
            {tuca && <AgentAvatar agent={tuca} size={64} />}
            <h2>Tuca</h2>
            <span className="muted">{L('Monta agentes', 'Builds agents')}</span>
            <p className="muted small">{L('A proposta dele aparece aqui: nome, o que faz, modelo e o que pode acessar.', 'His proposal shows up here: name, what it does, model and what it can access.')}</p>
          </div>
        )}
      </aside>
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
