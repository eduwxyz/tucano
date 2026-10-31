// The first-run introduction, which is also the setup: how agents reach the
// models (the person's subscription, a provider they pay for, or the company's
// gateway) tested with a real reply, the models for routing and memory
// (required: a provider or gateway names its own), who you are, the tools (MCP) and skills to bring in (optional),
// the first agent and what it can use, and its first task, sent from here so
// the person lands in a channel watching it work. Then "Primeiros passos" in the sidebar
// walks through the rest, checking itself off as each feature gets used.
import { L, lang } from '../../../shared/lang'
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ENGINES,
  MODELS,
  addConnector,
  authorizeConnector,
  customModel,
  getState,
  dmWith,
  linkSkill,
  localSkills,
  modelInfo,
  usable,
  navigate,
  newChannel,
  refreshEngines,
  newAgentDraft,
  saveAgent,
  sendMessage,
  slug,
  ensureTuca,
  settleDraft,
  updateSettings,
  useStore,
  wslDistributions,
  type Agent,
  type AgentColor,
  type AgentDraft,
  type EngineId,
  type GrantLevel,
  type LocalSkill,
  type State,
  type WslDistribution,
  type View,
  isTeam
} from '../store'
import { HarnessList, ModelPicker, usableEngines } from './Harness'
import { JevKey, LanguagePicker, ModelSelect, Toggle } from './Pages'
import { Splash } from './Splash'
import { Composer, MessageList } from './Conversation'
import { draftAgent, UseDraft } from './Tuca'
import { AgentAvatar, Icon, MeAvatar, type IconName } from './ui'

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

// The introduction draws again when the language changes: the opening plays only once.
let opened = false

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']

const STEPS = ['welcome', 'engine', 'models', 'you', 'tools', 'skills', 'agent', 'powers', 'first'] as const
type Step = (typeof STEPS)[number]
// The builder screen (the Tuca, from the sidebar) is the introduction's last three steps.
const BUILD_STEPS: readonly Step[] = ['agent', 'powers', 'first']
const BuildMode = createContext(false)

function unique(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

// The app's own list, for the harnesses on a plan (a gateway names its own models).
const readyModels = (engines: State['settings']['engines']): typeof MODELS => MODELS.filter((m) => engines[m.engine].loggedIn && engines[m.engine].route !== 'gateway')

// A template fills in who the agent is; the model stays if it still works.
function fromTemplate(a: Agent, t: Template, models: typeof MODELS): Agent {
  const model = MODELS.some((m) => m.id === a.modelId) ? (models.find((m) => m.id === a.modelId) ?? models[0]) : modelInfo(a.modelId) ? { id: a.modelId } : models[0]
  return { ...a, name: t.name, role: t.role, color: t.color, instructions: t.instructions, modelId: model?.id ?? a.modelId, web: true }
}

export function Onboarding({ build = false, from }: { build?: boolean; from?: View } = {}): ReactNode {
  const settings = useStore((s) => s.settings)
  const handles = useStore((s) => s.agents.map((a) => a.handle))
  const channels = useStore((s) => s.conversations.filter((c) => c.kind === 'channel').map((c) => c.name))
  const hasAgents = useStore((s) => s.agents.some(isTeam))
  const connectors = useStore((s) => s.connectors)

  const steps = build ? BUILD_STEPS : STEPS
  const [step, setStep] = useState<Step>(build ? 'agent' : 'welcome')
  const [name, setName] = useState(settings.workspaceName)
  const [context, setContext] = useState(settings.context)
  const [template, setTemplate] = useState<Template>(() => TEMPLATES()[0]!)
  const [agent, setAgent] = useState<Agent>(() => fromTemplate(newAgentDraft(), TEMPLATES()[0]!, readyModels(settings.engines)))
  const [computer, setComputer] = useState<Computer>('none')
  const [task, setTask] = useState(() => TEMPLATES()[0]!.tasks[0]!)
  const [busy, setBusy] = useState(false)
  // A new install picks both models; seeing the introduction again starts from what's set.
  const [routerModel, setRouterModel] = useState(hasAgents ? settings.routerModel : '')
  const [memoryModel, setMemoryModel] = useState(hasAgents ? settings.memoryModel : '')
  const [skills, setSkills] = useState<string[]>([])
  const [grants, setGrants] = useState<Record<string, GrantLevel>>({})
  // The first agent comes from the Tuca's card, or from the form for who prefers it.
  const [manual, setManual] = useState(false)
  const [fromTuca, setFromTuca] = useState<{ messageId: string; task?: string } | null>(null)
  const [opening, setOpening] = useState(!build && !opened)
  // A new session with the Tuca each time this screen opens (made when his step first shows).
  const [tucaConv, setTucaConv] = useState<{ id?: string; error?: string }>({})
  const onOpened = useCallback(() => ((opened = true), setOpening(false)), [])

  const models = readyModels(settings.engines)
  const ready = usableEngines(settings)
  const at = steps.indexOf(step)
  const go = (s: Step): void => setStep(s)
  const next = (): void => go(steps[at + 1]!)
  const back = (): void => go(steps[at - 1]!)
  const patch = (p: Partial<Agent>): void => setAgent((a) => ({ ...a, ...p }))
  const leave = (): void => {
    const channel = getState().conversations.find((c) => c.kind === 'channel')
    navigate(from ?? (channel ? { kind: 'conversation', id: channel.id } : { kind: 'approvals' }))
  }
  const close = (): void => {
    if (build) leave()
    else void updateSettings({ onboarding: { done: true } })
  }

  // On the builder screen the Tuca starts on his own model; in the introduction he waits
  // for the person to pick one (MeetTuca).
  useEffect(() => {
    if (!build || step !== 'agent' || tucaConv.id || tucaConv.error) return
    ensureTuca(agent.modelId, true)
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

  // A Tuca card: its agent becomes the first one (same id), with its access; powers and first task follow.
  const useDraft = (d: AgentDraft, messageId: string): void => {
    setAgent((a) => ({ ...draftAgent(d), id: a.id, limit: a.limit }))
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
    try {
      const a: Agent = { ...agent, name: agent.name.trim(), role: agent.role.trim(), handle, computer: computer !== 'none', computerKind: computer === 'mac' ? 'mac' : 'linux', grants: Object.fromEntries(connectors.map((c) => [c.id, grants[c.id] ?? 'read'])) }
      if (build) {
        // From the builder screen: the agent, then a DM with it and its first task.
        await saveAgent(a, [])
        if (fromTuca) settleDraft(fromTuca.messageId, a.id)
        const dm = await dmWith(a.id)
        navigate({ kind: 'conversation', id: dm })
        sendMessage(dm, task.trim())
        return
      }
      const channelId = await newChannel(unique(L('geral', 'general'), channels))
      await saveAgent(a, [channelId])
      if (fromTuca) settleDraft(fromTuca.messageId, a.id) // his card shows it was created
      await Promise.all(skills.map((source) => linkSkill(source).catch(() => undefined))) // for every agent; who uses each changes in Skills
      updateSettings({ workspaceName: name.trim() || settings.workspaceName, context: context.trim(), routerModel, memoryModel, onboarding: { done: true } })
      navigate({ kind: 'conversation', id: channelId })
      sendMessage(channelId, `@${a.handle} ${task.trim()}`)
    } finally {
      setBusy(false)
    }
  }

  if (opening) return <Splash onDone={onOpened} />

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
          {build || hasAgents ? L('Fechar', 'Close') : L('Pular introdução', 'Skip the introduction')}
        </button>
      </header>

      <div className="onb__scroll">
        <BuildMode.Provider value={build}>
        <div className="onb__stage" key={step}>
          {step === 'welcome' && <Welcome name={name} setName={setName} onNext={next} />}
          {step === 'engine' && <Harnesses ready={ready.length > 0} onBack={back} onNext={next} />}
          {step === 'models' && <Models ready={ready} router={routerModel} setRouter={setRouterModel} memory={memoryModel} setMemory={setMemoryModel} onBack={back} onNext={next} />}
          {step === 'you' && <You name={name} context={context} setContext={setContext} onBack={back} onNext={next} />}
          {step === 'tools' && <Tools onBack={back} onNext={next} />}
          {step === 'skills' && <SkillsStep picked={skills} setPicked={setSkills} onBack={back} onNext={next} />}
          {step === 'agent' &&
            (manual ? (
              <MakeAgent agent={agent} handle={handle} template={template} pick={pick} patch={patch} computer={computer} onBack={() => setManual(false)} onNext={next} />
            ) : (
              <MeetTuca conv={tucaConv} onUse={useDraft} onManual={() => setManual(true)} onBack={build ? undefined : back} />
            ))}
          {step === 'powers' && <Powers agent={agent} handle={handle} patch={patch} computer={computer} setComputer={setComputer} grants={grants} setGrants={setGrants} onBack={back} onNext={next} />}
          {step === 'first' && <FirstTask agent={agent} handle={handle} computer={computer} channel={unique(L('geral', 'general'), channels)} tasks={tasks} task={task} setTask={setTask} busy={busy} onBack={back} onFinish={() => void finish()} />}
        </div>
        </BuildMode.Provider>
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

// ---------- 1. welcome ----------

function Welcome({ name, setName, onNext }: { name: string; setName: (v: string) => void; onNext: () => void }): ReactNode {
  return (
    <div className="onb__split">
      <section className="onb__main">
        <LanguagePicker className="onb__lang" />
        <span className="onb__kicker">{L('Bem-vindo ao Tucano', 'Welcome to Tucano')}</span>
        <h1>{L('Um time de agentes de IA, trabalhando no seu computador.', 'A team of AI agents, working on your computer.')}</h1>
        <p className="onb__lead">{L('Você conversa com eles em canais, como num chat do trabalho. Eles pesquisam, escrevem, programam e usam as suas ferramentas, e você decide até onde cada um vai.', 'You talk to them in channels, like a work chat. They research, write, code and use your tools, and you decide how far each one goes.')}</p>
        <ul className="onb__points">
          <Point icon="zap" title={L('No harness que você já usa', 'On the harness you already use')}>
            {L('Claude Code, Codex, Gemini CLI, OpenCode ou Pi, como você configurou: no seu plano, no gateway da empresa ou nos seus provedores.', 'Claude Code, Codex, Gemini CLI, OpenCode or Pi, the way you set them up: on your plan, your company’s gateway or your providers.')}
          </Point>
          <Point icon="shield" title={L('Você no controle', 'You’re in control')}>
            {L('Cada agente só usa o que você liberar. Comprar, publicar, enviar e apagar sempre esperam o seu ok.', 'Each agent only uses what you allow. Buying, publishing, sending and deleting always wait for your OK.')}
          </Point>
          <Point icon="lock" title={L('Tudo fica aqui', 'Everything stays here')}>
            {L('Conversas, memória e logins ficam no seu computador. Nada passa por servidor nosso.', 'Conversations, memory and logins stay on your computer. Nothing goes through a server of ours.')}
          </Point>
        </ul>
        <label className="onb__field">
          <span>{L('Como os agentes devem te chamar?', 'What should the agents call you?')}</span>
          <input autoFocus value={name} placeholder={L('Seu nome', 'Your name')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onNext()} />
        </label>
        <Nav onNext={onNext} next={L('Começar', 'Get started')} disabled={!name.trim()} />
      </section>
      <aside className="onb__aside">
        <ChatPreview me={name} />
      </aside>
    </div>
  )
}

function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }): ReactNode {
  return (
    <li>
      <span className="onb__point-icon">
        <Icon name={icon} size={16} />
      </span>
      <span>
        <strong>{title}</strong>
        <span>{children}</span>
      </span>
    </li>
  )
}

// A still of what the app is: a channel where agents work and ask before acting.
function ChatPreview({ me }: { me: string }): ReactNode {
  const initials = (me.trim()[0] ?? 'V').toUpperCase()
  return (
    <div className="onb-chat" aria-hidden>
      <div className="onb-chat__head">
        <Icon name="hash" size={14} /> {L('lancamento', 'launch')}
      </div>
      <div className="onb-chat__msg">
        <MeAvatar initials={initials} size={26} />
        <div>
          <b>{me.trim() || L('Você', 'You')}</b>
          <p>{L('@iris acha os 3 concorrentes que mais cresceram este ano. @nina, depois escreve o post.', '@iris find the 3 competitors that grew the most this year. @nina, then write the post.')}</p>
        </div>
      </div>
      <div className="onb-chat__msg">
        <AgentAvatar agent={{ name: 'Iris', color: 'sky' }} size={26} />
        <div>
          <b>Iris</b>
          <span className="onb-chat__step">
            <Icon name="globe" size={12} /> {L('Pesquisou na web · 6 fontes', 'Searched the web · 6 sources')}
          </span>
          <p>{L('Achei os três, com números e links. @nina, o resumo está acima.', 'Found all three, with numbers and links. @nina, the summary is above.')}</p>
        </div>
      </div>
      <div className="onb-chat__msg">
        <AgentAvatar agent={{ name: 'Nina', color: 'rose' }} size={26} />
        <div>
          <b>Nina</b>
          <p>{L('Post pronto. Quer que eu publique no LinkedIn?', 'Post ready. Want me to publish it on LinkedIn?')}</p>
          <div className="onb-chat__approval">
            <Icon name="shield" size={13} />
            <span>{L('Publicar post no LinkedIn', 'Publish post on LinkedIn')}</span>
            <span className="onb-chat__btn">{L('Aprovar', 'Approve')}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- 2. engine ----------

function Harnesses({ ready, onBack, onNext }: { ready: boolean; onBack: () => void; onNext: () => void }): ReactNode {
  // Logging in happens in the Terminal; keep checking until one is ready.
  const platform = useStore((s) => s.platform)
  const settings = useStore((s) => s.settings)
  const [distros, setDistros] = useState<WslDistribution[]>([])
  const [wslError, setWslError] = useState('')
  const [checkingTarget, setCheckingTarget] = useState(false)
  const target = settings.executionTarget ?? { kind: 'windows' as const }
  const selectedDistro = target.kind === 'wsl' ? target.distro : ''
  const changeTarget = (executionTarget: NonNullable<typeof settings.executionTarget>): void => {
    setCheckingTarget(true)
    setWslError('')
    void updateSettings({ executionTarget })
      .catch((error: unknown) => setWslError(error instanceof Error ? error.message : String(error)))
      .finally(() => setCheckingTarget(false))
  }

  useEffect(() => {
    if (platform !== 'windows') return
    let current = true
    void wslDistributions().then(
      (found) => current && setDistros(found),
      (error: unknown) => current && setWslError(error instanceof Error ? error.message : String(error))
    )
    return () => {
      current = false
    }
  }, [platform])

  useEffect(() => {
    refreshEngines()
    if (ready) return
    const t = setInterval(refreshEngines, 4000)
    return () => clearInterval(t)
  }, [ready])

  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{L('Passo 1 · Os harnesses', 'Step 1 · The harnesses')}</span>
        <h1>{L('Quais harnesses seus agentes vão usar?', 'Which harnesses will your agents use?')}</h1>
        <p className="onb__lead">{L('Os agentes rodam nos programas que já estão no seu computador, do jeito que você configurou cada um. O Tucano só lê essa configuração: nunca vê nem guarda as suas senhas e chaves.', 'The agents run on the programs already on your computer, the way you set up each one. Tucano only reads that setup: it never sees or stores your passwords and keys.')}</p>
        {platform === 'windows' && (
          <>
            <label className="onb__field">
              <span>{L('Onde os agentes rodam', 'Agent execution')}</span>
              <select
                value={target.kind}
                onChange={(e) => {
                  if (e.target.value === 'windows') return changeTarget({ kind: 'windows' })
                  const currentDistro = selectedDistro || undefined
                  const distro = distros.find((d) => d.version === 2 && d.name === currentDistro) ?? distros.find((d) => d.version === 2 && d.isDefault) ?? distros.find((d) => d.version === 2)
                  if (distro) changeTarget({ kind: 'wsl', distro: distro.name })
                }}
              >
                <option value="windows">Windows</option>
                <option value="wsl" disabled={!distros.some((d) => d.version === 2) && target.kind !== 'wsl'}>WSL 2</option>
              </select>
              <span className="hint">{target.kind === 'wsl' ? L('Instale e faça login nos harnesses dentro dessa distribuição.', 'Install and sign in to the harnesses inside this distribution.') : L('Windows é o padrão. Você também pode usar uma distribuição WSL 2.', 'Windows is the default. You can also use a WSL 2 distribution.')}</span>
            </label>
            {target.kind === 'wsl' && (
              <label className="onb__field">
                <span>{L('Distribuição WSL 2', 'WSL 2 distribution')}</span>
                <select
                  value={distros.some((d) => d.version === 2 && d.name === selectedDistro) ? selectedDistro : ''}
                  onChange={(e) => e.target.value && changeTarget({ kind: 'wsl', distro: e.target.value })}
                >
                  <option value="">{L('Escolha uma distribuição', 'Choose a distribution')}</option>
                  {distros.filter((d) => d.version === 2).map((d) => <option key={d.name} value={d.name}>{d.name}{d.isDefault ? L(' · padrão', ' · default') : ''}</option>)}
                </select>
              </label>
            )}
            {wslError && <p className="hint hint--warn">{wslError}</p>}
            {checkingTarget && <p className="hint">{L('Verificando os harnesses nessa distribuição…', 'Checking for harnesses in this distribution…')}</p>}
            {!wslError && !distros.some((d) => d.version === 2) && target.kind !== 'wsl' && <p className="hint">{L('Não encontrei uma distribuição WSL 2 instalada.', 'No installed WSL 2 distribution was found.')}</p>}
          </>
        )}
        <HarnessList />
        {!ready && (
          <p className="onb__wait">
            <span className="pulse" /> {L('Esperando um deles ficar pronto…', 'Waiting for one of them to be ready…')}
          </p>
        )}
        <Nav onBack={onBack} onNext={onNext} disabled={!ready} />
      </section>
      <aside className="onb__aside">
        <div className="onb-guard">
          <Icon name="zap" size={16} />
          <div>
            <p>
              <strong>{L('O que eu leio de cada um', 'What I read from each one')}</strong>
            </p>
            <ul className="harness__guide">
              <li>
                <b>{L('Plano:', 'Plan:')}</b> {L('o login do Claude ou do ChatGPT. Sem chave e sem cobrança por uso.', 'your Claude or ChatGPT login. No key and no pay-per-use.')}
              </li>
              <li>
                <b>Gateway:</b> {L('o proxy da empresa (ou um provedor) que está no settings.json do Claude Code ou no config.toml do Codex. Os agentes usam o mesmo, e a telemetria fica desligada.', 'your company’s proxy (or a provider) in Claude Code’s settings.json or Codex’s config.toml. The agents use the same one, and telemetry stays off.')}
              </li>
              <li>
                <b>{L('Provedores:', 'Providers:')}</b> {L('os logins do OpenCode e do Pi, com os modelos de cada um.', 'your OpenCode and Pi logins, with each one’s models.')}
              </li>
            </ul>
          </div>
        </div>
      </aside>
    </div>
  )
}

// ---------- 2. the models ----------

function Models(p: { ready: EngineId[]; router: string; setRouter: (v: string) => void; memory: string; setMemory: (v: string) => void; onBack: () => void; onNext: () => void }): ReactNode {
  const jevKey = useStore((s) => !!s.settings.jevKey)
  const ok = (v: string): boolean => (v === 'jev' ? jevKey : !!usable(modelInfo(v)))
  return (
    <section className="onb__main onb__main--wide">
      <span className="onb__kicker">{L('Passo 2 · Os modelos', 'Step 2 · The models')}</span>
      <h1>{L('Quem decide e quem lembra.', 'Who decides and who remembers.')}</h1>
      <p className="onb__lead">{L('Dois trabalhos pequenos rodam o tempo todo, fora dos agentes. Escolha um modelo rápido pra cada um; dá pra trocar depois em Configurações.', 'Two small jobs run all the time, outside the agents. Pick a fast model for each; you can change them later in Settings.')}</p>
      <p className="onb-note">
        <Icon name="zap" size={14} /> {L('Primeiro o harness, depois o modelo da lista dele. Se o seu não aparece, escolha', 'First the harness, then a model from its list. If yours isn’t there, pick')} <b>{L('Outro modelo…', 'Other model…')}</b> {L('e digite o nome.', 'and type its name.')}
      </p>
      <div className="onb-pair">
        <div className="onb-pick">
          <span className="onb-pick__icon">
            <Icon name="spark" size={18} />
          </span>
          <strong>{L('Quem responde', 'Who replies')}</strong>
          <p>{L('Lê a mensagem num canal sem @menção e escolhe o agente. Roda antes de cada resposta: prefira o mais rápido.', 'Reads a channel message with no @mention and picks the agent. It runs before every reply: go for the fastest.')}</p>
          <ModelSelect value={p.router} onChange={p.setRouter} engines={p.ready} jev />
          {p.router === 'jev' && <JevKey saved={jevKey} />}
        </div>
        <div className="onb-pick">
          <span className="onb-pick__icon">
            <Icon name="book" size={18} />
          </span>
          <strong>{L('Memória', 'Memory')}</strong>
          <p>{L('Resume o que sai da janela das conversas longas e sugere o que vale lembrar sobre você.', 'Summarizes what leaves the window of long conversations and suggests what’s worth remembering about you.')}</p>
          <ModelSelect value={p.memory} onChange={p.setMemory} engines={p.ready} />
        </div>
      </div>
      <Nav onBack={p.onBack} onNext={p.onNext} disabled={!ok(p.router) || !ok(p.memory)} />
    </section>
  )
}

// ---------- 4. the tools ----------

const SUGGESTED: { name: string; url: string; auth: 'oauth' | 'token' }[] = [
  { name: 'Linear', url: 'https://mcp.linear.app/mcp', auth: 'oauth' },
  { name: 'Notion', url: 'https://mcp.notion.com/mcp', auth: 'oauth' },
  { name: 'Sentry', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth' },
  { name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/', auth: 'token' },
  { name: 'GitLab', url: 'https://gitlab.com/api/v4/mcp', auth: 'oauth' }
]

const STATUS = (): Record<string, { label: string; tone: string }> => ({
  connected: { label: L('conectado', 'connected'), tone: 'tag--ok' },
  connecting: { label: L('conectando…', 'connecting…'), tone: '' },
  needs_auth: { label: L('precisa autorizar', 'needs authorization'), tone: 'tag--warn' },
  error: { label: L('erro', 'error'), tone: 'tag--danger' },
  disconnected: { label: L('desconectado', 'disconnected'), tone: 'tag--warn' }
})

function Tools({ onBack, onNext }: { onBack: () => void; onNext: () => void }): ReactNode {
  const connectors = useStore((s) => s.connectors)
  const [form, setForm] = useState({ name: '', url: '', auth: 'oauth' as 'oauth' | 'token' | 'none', token: '' })
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const add = (): void => {
    setError(null)
    setAdding(true)
    addConnector({ name: form.name.trim(), kind: 'remote', url: form.url.trim(), auth: form.auth, token: form.auth === 'token' ? form.token.trim() : undefined })
      .then(() => setForm({ name: '', url: '', auth: 'oauth', token: '' }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
      .finally(() => setAdding(false))
  }
  return (
    <section className="onb__main onb__main--wide">
      <span className="onb__kicker">{L('Passo 4 · Ferramentas · opcional', 'Step 4 · Tools · optional')}</span>
      <h1>{L('As ferramentas do seu trabalho.', 'The tools of your work.')}</h1>
      <p className="onb__lead">{L('Jira, GitLab, Slack, Linear… qualquer servidor MCP, inclusive os internos da sua empresa. Mais adiante você escolhe o que cada agente pode usar.', 'Jira, GitLab, Slack, Linear… any MCP server, including your company’s internal ones. Later on you pick what each agent can use.')}</p>

      {connectors.length > 0 && (
        <div className="onb-conns">
          {connectors.map((c) => {
            const st = STATUS()[c.status] ?? { label: c.status, tone: '' }
            return (
              <div key={c.id} className="onb-conn">
                <Icon name={c.kind === 'stdio' ? 'terminal' : 'plug'} size={16} />
                <strong>{c.name}</strong>
                <span className={`tag ${st.tone}`}>{st.label}</span>
                <span className="muted small grow">{c.tools.length ? L(`${c.tools.length} ferramentas`, `${c.tools.length} tools`) : c.error ?? ''}</span>
                {c.status === 'needs_auth' && (
                  <button className="btn btn--primary btn--sm" onClick={() => authorizeConnector(c.id)}>
                    {L('Autorizar no navegador', 'Authorize in the browser')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="onb-add">
        <div className="onb__chips">
          {SUGGESTED.filter((x) => !connectors.some((c) => c.url === x.url)).map((x) => (
            <button key={x.name} className="onb-chip" onClick={() => setForm({ name: x.name, url: x.url, auth: x.auth, token: '' })}>
              <Icon name="plus" size={12} /> {x.name}
            </button>
          ))}
        </div>
        <div className="onb__row">
          <label className="onb__field onb__field--narrow">
            <span>{L('Nome', 'Name')}</span>
            <input value={form.name} placeholder={L('Ex.: Jira', 'E.g. Jira')} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="onb__field">
            <span>{L('Endereço do servidor MCP', 'MCP server address')}</span>
            <input value={form.url} placeholder={L('https://mcp.suaempresa.com/jira', 'https://mcp.yourcompany.com/jira')} spellCheck={false} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </label>
        </div>
        <div className="onb__row onb__row--center">
          <div className="segmented">
            {(
              [
                ['oauth', L('Login no navegador', 'Browser login')],
                ['token', 'Token'],
                ['none', L('Sem login', 'No login')]
              ] as const
            ).map(([v, label]) => (
              <button key={v} className={form.auth === v ? 'is-active' : ''} onClick={() => setForm({ ...form, auth: v })}>
                {label}
              </button>
            ))}
          </div>
          {form.auth === 'token' && <input className="grow" type="password" value={form.token} placeholder={L('O token (vai como Authorization: Bearer)', 'The token (sent as Authorization: Bearer)')} onChange={(e) => setForm({ ...form, token: e.target.value })} />}
          <button className="btn btn--primary" disabled={adding || !form.name.trim() || !/^https?:\/\//.test(form.url.trim()) || (form.auth === 'token' && !form.token.trim())} onClick={add}>
            {L('Conectar', 'Connect')}
          </button>
        </div>
        {error && <p className="field__error">{error}</p>}
        {/gitlab\.com/.test(form.url) && <p className="hint">{L('GitLab da empresa, num endereço próprio? Troque gitlab.com pelo endereço dela.', 'Your company’s GitLab, at its own address? Replace gitlab.com with it.')}</p>}
        <p className="hint">{L('O token fica cifrado no cofre do sistema. Os agentes nunca veem nem o token nem a sua senha.', 'The token is encrypted in the system’s vault. Agents never see the token or your password.')}</p>
      </div>
      <Nav onBack={onBack} onNext={onNext} next={connectors.length ? L('Continuar', 'Continue') : L('Conectar depois', 'Connect later')} />
    </section>
  )
}

// ---------- 5. the skills ----------

function SkillsStep({ picked, setPicked, onBack, onNext }: { picked: string[]; setPicked: (v: string[]) => void; onBack: () => void; onNext: () => void }): ReactNode {
  const [found, setFound] = useState<LocalSkill[] | null>(null)
  useEffect(() => {
    void localSkills().then(setFound, () => setFound([]))
  }, [])
  const toggle = (src: string): void => setPicked(picked.includes(src) ? picked.filter((x) => x !== src) : [...picked, src])
  return (
    <section className="onb__main onb__main--wide">
      <span className="onb__kicker">{L('Passo 5 · Skills · opcional', 'Step 5 · Skills · optional')}</span>
      <h1>{L('Traga as suas skills.', 'Bring your skills.')}</h1>
      <p className="onb__lead">{L('As receitas que você já usa no Claude Code e no Codex. Os agentes leem direto do arquivo: o que você mudar lá vale aqui. O resto da sua configuração (hooks, plugins, permissões) continua de fora.', 'The recipes you already use in Claude Code and Codex. Agents read them straight from the file: what you change there applies here. The rest of your setup (hooks, plugins, permissions) stays out.')}</p>
      {found === null ? (
        <p className="onb__wait">
          <span className="pulse" /> {L('Procurando…', 'Looking…')}
        </p>
      ) : found.length === 0 ? (
        <p className="onb-note">{L('Não achei skills no seu Claude Code nem no Codex. Dá pra escrever as suas depois, em Skills.', 'I didn’t find skills in your Claude Code or Codex. You can write your own later, in Skills.')}</p>
      ) : (
        <div className="onb-skills">
          {found.map((k) => (
            <button key={k.source} className={`onb-skill ${picked.includes(k.source) ? 'is-active' : ''}`} onClick={() => toggle(k.source)}>
              <span className="onb-skill__check">{picked.includes(k.source) && <Icon name="check" size={12} />}</span>
              <span className="grow">
                <strong>{k.name}</strong> <span className="tag">{k.origin}</span>
                <span className="onb-skill__desc">{k.description}</span>
                {k.scripts && <span className="small warn-text">{L('Tem scripts: precisa de um agente com computador.', 'It has scripts: needs an agent with a computer.')}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
      <Nav onBack={onBack} onNext={onNext} next={picked.length ? L(`Trazer ${picked.length} ${picked.length === 1 ? 'skill' : 'skills'}`, `Bring ${picked.length} ${picked.length === 1 ? 'skill' : 'skills'}`) : L('Pular', 'Skip')} />
    </section>
  )
}

// ---------- 3. you ----------

const ABOUT_EXAMPLES = (): string[] => (lang() === 'en' ? ['I’m a developer working on…', 'I run an online store that sells…', 'I’m studying for…', 'I prefer short, direct answers.'] : ['Sou dev e trabalho com…', 'Tenho uma loja online de…', 'Estudo para…', 'Prefiro respostas curtas e diretas.'])

function You({ name, context, setContext, onBack, onNext }: { name: string; context: string; setContext: (v: string) => void; onBack: () => void; onNext: () => void }): ReactNode {
  return (
    <section className="onb__main">
      <span className="onb__kicker">{L('Passo 3 · Você', 'Step 3 · You')}</span>
      <h1>{name.trim() ? L(`${name.trim().split(' ')[0]}, conta um pouco sobre você.`, `${name.trim().split(' ')[0]}, tell us a bit about yourself.`) : L('Conta um pouco sobre você.', 'Tell us a bit about yourself.')}</h1>
      <p className="onb__lead">{L('Todo agente lê isso antes de cada resposta, então ninguém precisa te perguntar de novo. Seu trabalho, seus projetos, como você gosta das respostas.', 'Every agent reads this before each reply, so nobody has to ask you again. Your work, your projects, how you like your answers.')}</p>
      <textarea
        className="onb__textarea"
        autoFocus
        rows={6}
        value={context}
        placeholder={L('Ex.: Sou designer numa agência pequena em Curitiba. Cuido de três clientes de e-commerce. Gosto de respostas curtas, em português, com exemplos.', 'E.g. I’m a designer at a small agency in Austin. I look after three e-commerce clients. I like short answers, with examples.')}
        onChange={(e) => setContext(e.target.value)}
      />
      <div className="onb__chips">
        {ABOUT_EXAMPLES().map((x) => (
          <button key={x} className="onb-chip" onClick={() => setContext(context.trim() ? `${context.trim()} ${x}` : x)}>
            <Icon name="plus" size={12} /> {x}
          </button>
        ))}
      </div>
      <p className="hint">{L('Dá pra mudar quando quiser, em Configurações. Os agentes também aprendem com o tempo, e você aprova o que eles guardam.', 'You can change it any time in Settings. The agents also learn over time, and you approve what they keep.')}</p>
      <Nav onBack={onBack} onNext={onNext} next={context.trim() ? L('Continuar', 'Continue') : L('Pular por enquanto', 'Skip for now')} />
    </section>
  )
}

// ---------- 4. the agent ----------

// The first agent, made with the Tuca: he asks, proposes a card, "Usar esse agente" fills it in.
// His model is the person's choice: in the introduction nothing is picked for them, and
// he only starts once they pick; on the builder screen it's the one picked before.
// Changing it starts a new session with him on that model.
function MeetTuca({ conv: session, onUse, onManual, onBack }: { conv: { id?: string; error?: string }; onUse: (d: AgentDraft, messageId: string) => void; onManual: () => void; onBack?: () => void }): ReactNode {
  const build = useContext(BuildMode)
  const [conv, setConv] = useState(session.id)
  const tuca = useStore((s) => s.agents.find((a) => a.kind === 'tuca'))
  const [model, setModel] = useState(build ? (tuca?.modelId ?? '') : '')
  const [applying, setApplying] = useState(false)
  const [modelError, setModelError] = useState('')
  const typed = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => setConv(session.id), [session.id])
  useEffect(() => {
    if (build && !model && tuca?.modelId) setModel(tuca.modelId)
  }, [build, model, tuca?.modelId])
  useEffect(() => () => clearTimeout(typed.current), [])
  const error = session.error ?? ''
  const messages = useStore((s) => (conv ? s.messages.filter((m) => m.conversationId === conv) : []))
  const latest = [...messages].reverse().find((m) => m.run?.agentDraft && !m.run.agentDraft.state)?.run?.agentDraft

  async function start(value: string): Promise<void> {
    if (conv && value === tuca?.modelId) return
    setApplying(true)
    setModelError('')
    try {
      // He's made with the chosen model; once he exists, it's saved on him and a new session starts.
      if (tuca) {
        const channels = getState().conversations.filter((c) => c.kind === 'channel' && c.members.includes(tuca.id)).map((c) => c.id)
        await saveAgent({ ...tuca, modelId: value }, channels)
      }
      setConv((await ensureTuca(value, true)).conversationId)
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
        <span className="onb__kicker">{build ? L('Tuca · Novo agente', 'Tuca · New agent') : L('Passo 6 · Seu primeiro agente', 'Step 6 · Your first agent')}</span>
        <h1>{L('Conte pro Tuca o que você quer delegar', 'Tell Tuca what you want to delegate')}</h1>
        <p className="onb__lead">
          {build
            ? L('Ele faz duas ou três perguntas e propõe um agente. Nada é criado sem você.', 'It asks two or three questions and proposes an agent. Nothing is created without you.')
            : L('O Tuca monta os agentes do seu time. Ele faz duas ou três perguntas e propõe um; nada é criado sem você. Depois ele fica na barra lateral pra montar os próximos.', 'Tuca builds your team’s agents. It asks two or three questions and proposes one; nothing is created without you. Then it stays in the sidebar to build the next ones.')}
        </p>
        <div className="onb__field onb__field--tuca-model">
          <span>{L('Modelo do Tuca', 'Tuca’s model')}</span>
          <ModelPicker value={model} onChange={pick} />
          <span className="hint">
            {applying
              ? L('Chamando o Tuca com esse modelo…', 'Calling Tuca with this model…')
              : conv
                ? L('Trocar o modelo começa uma conversa nova com ele.', 'Changing the model starts a new conversation with him.')
                : L('Escolha com qual modelo o Tuca conversa com você e monta os agentes.', 'Pick the model Tuca uses to talk with you and build the agents.')}
          </span>
          {modelError && <p className="hint hint--warn">{modelError}</p>}
        </div>
        <div className="onb-tuca">
          {conv && tuca ? (
            <UseDraft.Provider value={onUse}>
              <MessageList messages={messages} conversationId={conv} />
              <Composer conversationId={conv} members={[tuca]} placeholder={L('Ex.: quero alguém pra triar os tickets de suporte toda manhã', 'E.g. I want someone to triage the support tickets every morning')} />
            </UseDraft.Provider>
          ) : (
            <p className="muted onb-tuca__wait">{error || (applying || build ? L('Chamando o Tuca…', 'Calling Tuca…') : L('Escolha o modelo do Tuca acima pra começar.', 'Pick Tuca’s model above to start.'))}</p>
          )}
        </div>
        <div className="onb__nav">
          {onBack ? (
            <button className="btn btn--ghost" onClick={onBack}>
              <Icon name="back" size={14} /> {L('Voltar', 'Back')}
            </button>
          ) : (
            <span />
          )}
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
            <p className="muted small">{L('A proposta dele aparece aqui: nome, o que faz, modelo e o que pode acessar.', 'Its proposal shows up here: name, what it does, model and what it can access.')}</p>
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
        <span className="onb__kicker">{useContext(BuildMode) ? L('Novo agente', 'New agent') : L('Passo 6 · Seu primeiro agente', 'Step 6 · Your first agent')}</span>
        <h1>{L('Quem vai trabalhar com você?', 'Who’s going to work with you?')}</h1>
        <p className="onb__lead">{L('Comece por um modelo e ajuste o que quiser. Depois você monta o resto do time.', 'Start from a template and adjust anything. You build the rest of the team later.')}</p>
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
            <span>{L('Função', 'Role')}</span>
            <input value={agent.role} placeholder={L('Ex.: Pesquisa', 'E.g. Research')} onChange={(e) => patch({ role: e.target.value })} />
          </label>
        </div>
        <div className="onb__field">
          <span>{L('Cor', 'Color')}</span>
          <div className="swatches">
            {COLORS.map((c) => (
              <button key={c} className={`swatch c-${c} ${agent.color === c ? 'is-active' : ''}`} onClick={() => patch({ color: c })} aria-label={c} />
            ))}
          </div>
        </div>
        <div className="onb__field">
          <span>{L('Modelo', 'Model')}</span>
          <ModelPicker value={agent.modelId} onChange={(modelId) => patch({ modelId })} />
        </div>
        <label className="onb__field">
          <span>{L(`O que ${agent.name.trim() || 'o agente'} faz`, `What ${agent.name.trim() || 'the agent'} does`)}</span>
          <textarea rows={4} value={agent.instructions} placeholder={L('Escreva como explicaria pra um colega novo: o que fazer, o que evitar, quando perguntar.', 'Write it as you’d explain it to a new colleague: what to do, what to avoid, when to ask.')} onChange={(e) => patch({ instructions: e.target.value })} />
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
      <AgentAvatar agent={{ name, color: agent.color }} size={64} />
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
        <AgentAvatar agent={{ name, color: agent.color }} size={22} />
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
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{useContext(BuildMode) ? L(`Novo agente · O que ${name} pode usar`, `New agent · What ${name} can use`) : L(`Passo 7 · O que ${name} pode usar`, `Step 7 · What ${name} can use`)}</span>
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
                ).map(([k, label]) => (
                  <button key={k} className={computer === k ? 'is-active' : ''} onClick={() => p.setComputer(k)}>
                    {label}
                  </button>
                ))}
              </div>
              {computer === 'none' && <p className="hint">{L('Só conversa, web e navegador. Dá pra ligar depois.', 'Just chat, web and browser. You can turn it on later.')}</p>}
              {computer === 'linux' && <p className="hint">{L('Um computador só dele, separado do seu. Instala e roda o que precisar sem pedir. Precisa do Docker rodando.', 'A computer of its own, apart from yours. It installs and runs what it needs without asking. Needs Docker running.')}</p>}
              {computer === 'mac' && (
                <p className="hint hint--warn">
                  <Icon name="lock" size={13} /> {L(`${agent.name.trim() || 'O agente'} roda comandos no seu computador como se fosse você, com tudo o que você tem instalado. Escolha só se confia nessa função.`, `${agent.name.trim() || 'The agent'} runs commands on your computer as if it were you, with everything you have installed. Only choose this if you trust that role.`)}
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
                  <span className="onb-power-row__icon">
                    <Icon name={c.kind === 'stdio' ? 'terminal' : 'plug'} size={18} />
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
        <div className="onb-guard">
          <Icon name="shield" size={16} />
          <p>
            <strong>{L('Seja qual for a escolha,', 'Whatever you choose,')}</strong> {L('comprar, publicar, enviar e apagar viram um pedido de aprovação, com a ação exata. Nada disso acontece sem o seu ok.', 'buying, publishing, sending and deleting become an approval request, with the exact action. None of it happens without your OK.')}
          </p>
        </div>
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
  channel: string
  tasks: string[]
  task: string
  setTask: (t: string) => void
  busy: boolean
  onBack: () => void
  onFinish: () => void
}): ReactNode {
  const name = p.agent.name.trim()
  const build = useContext(BuildMode)
  return (
    <div className="onb__split">
      <section className="onb__main">
        <span className="onb__kicker">{build ? L('Novo agente · Mão na massa', 'New agent · Hands on') : L('Passo 8 · Mão na massa', 'Step 8 · Hands on')}</span>
        <h1>{L(`O que ${name} faz primeiro?`, `What does ${name} do first?`)}</h1>
        <p className="onb__lead">
          {build ? (
            <>{L(`Vou abrir uma conversa com ${name} e mandar o pedido.`, `I’ll open a conversation with ${name} and send the request.`)}</>
          ) : (
            <>
              {L('Vou criar o canal', 'I’ll create the channel')} <b>#{p.channel}</b> {L(`com ${name} e mandar o pedido.`, `with ${name} and send the request.`)}
            </>
          )}{' '}
          {L(`Você acompanha cada passo enquanto ${name} trabalha.`, `You follow every step while ${name} works.`)}
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
        <Nav
          onBack={p.onBack}
          onNext={p.onFinish}
          disabled={!p.task.trim() || p.busy}
          next={
            <>
              <Icon name="send" size={14} /> {L(`Criar ${name} e enviar`, `Create ${name} and send`)}
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

// ---------- "Primeiros passos" ----------

interface Item {
  id: string
  title: string
  how: string
  done: (s: State) => boolean
  go: (s: State) => View
  action: string
}

const firstChannel = (s: State): View => {
  const c = s.conversations.find((x) => x.kind === 'channel')
  return c ? { kind: 'conversation', id: c.id } : { kind: 'new-agent' }
}

const ITEMS = (): Item[] => [
  { id: 'agent', title: L('Criar seu primeiro agente', 'Create your first agent'), how: L('Feito na introdução.', 'Done in the introduction.'), done: (s) => s.agents.some(isTeam), go: () => ({ kind: 'tuca' }), action: L('Criar', 'Create') },
  {
    id: 'reply',
    title: L('Ver um agente trabalhando', 'Watch an agent work'),
    how: L('Mande uma tarefa e acompanhe cada passo na conversa.', 'Send a task and follow every step in the conversation.'),
    done: (s) => s.messages.some((m) => m.author.kind === 'agent' && m.run?.status === 'done'),
    go: firstChannel,
    action: L('Abrir canal', 'Open channel')
  },
  {
    id: 'team',
    title: L('Montar um time', 'Build a team'),
    how: L('Crie um segundo agente e ponha os dois num canal: eles passam a vez com @menção.', 'Create a second agent and put both in a channel: they hand off with @mentions.'),
    done: (s) => s.agents.filter(isTeam).length >= 2,
    go: () => ({ kind: 'tuca' }),
    action: L('Novo agente', 'New agent')
  },
  {
    id: 'connector',
    title: L('Conectar uma ferramenta', 'Connect a tool'),
    how: L('Linear, GitHub, Notion… Cada agente só vê o que você liberar pra ele.', 'Linear, GitHub, Notion… Each agent only sees what you allow it.'),
    done: (s) => s.connectors.length > 0,
    go: () => ({ kind: 'connectors' }),
    action: L('Conectores', 'Connectors')
  },
  {
    id: 'memory',
    title: L('Ensinar algo sobre você', 'Teach something about you'),
    how: L('Uma coisa que todo agente deve lembrar, sempre.', 'Something every agent should always remember.'),
    done: (s) => s.memories.some((m) => m.state === 'active'),
    go: () => ({ kind: 'memory' }),
    action: L('Memória', 'Memory')
  },
  {
    id: 'routine',
    title: L('Agendar uma rotina', 'Schedule a routine'),
    how: L('Um agente trabalhando sozinho no dia e hora que você marcar.', 'An agent working on its own on the day and time you set.'),
    done: (s) => s.routines.length > 0,
    go: () => ({ kind: 'routines' }),
    action: L('Rotinas', 'Routines')
  },
  {
    id: 'approval',
    title: L('Decidir uma aprovação', 'Decide an approval'),
    how: L('Quando um agente quer enviar, publicar ou apagar, o pedido chega aqui com a ação exata.', 'When an agent wants to send, publish or delete, the request lands here with the exact action.'),
    done: (s) => s.approvals.some((a) => a.state !== 'pending'),
    go: () => ({ kind: 'approvals' }),
    action: L('Aprovações', 'Approvals')
  },
  {
    id: 'phone',
    title: L('Aprovar pelo celular', 'Approve from your phone'),
    how: L('Ligue o Telegram em Configurações e decida de qualquer lugar.', 'Turn on Telegram in Settings and decide from anywhere.'),
    done: (s) => !!s.settings.telegram?.chat,
    go: () => ({ kind: 'settings' }),
    action: L('Configurações', 'Settings')
  }
]

export function GettingStarted(): ReactNode {
  const items = ITEMS()
  const done = useStore((s) => items.map((i) => i.done(s)))
  const onboarding = useStore((s) => s.settings.onboarding)
  const [open, setOpen] = useState(false)
  const count = done.filter(Boolean).length
  const all = count === items.length
  const nextIndex = done.indexOf(false)

  return (
    <div className="getting">
      {open && (
        <div className="getting__pop" role="dialog" aria-label={L('Primeiros passos', 'Getting started')}>
          <div className="getting__head">
            <div>
              <strong>{all ? L('Você conhece o Tucano inteiro', 'You know all of Tucano') : L('Primeiros passos', 'Getting started')}</strong>
              <span className="muted small">
                {L(`${count} de ${items.length} · cada um se marca sozinho quando você usa`, `${count} of ${items.length} · each one checks itself off when you use it`)}
              </span>
            </div>
            <button className="icon-btn icon-btn--sm" title={L('Fechar', 'Close')} onClick={() => setOpen(false)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <ol className="getting__list">
            {items.map((item, i) => (
              <li key={item.id} className={`${done[i] ? 'is-done' : ''} ${i === nextIndex ? 'is-next' : ''}`}>
                <span className="getting__check">{done[i] && <Icon name="check" size={12} />}</span>
                <div className="grow">
                  <strong>{item.title}</strong>
                  {i === nextIndex && <span className="muted small">{item.how}</span>}
                </div>
                {!done[i] && (
                  <button
                    className={`btn btn--sm ${i === nextIndex ? 'btn--primary' : ''}`}
                    onClick={() => {
                      navigate(item.go(getState()))
                      setOpen(false)
                    }}
                  >
                    {item.action}
                  </button>
                )}
              </li>
            ))}
          </ol>
          <div className="getting__foot">
            <button className="link small" onClick={() => updateSettings({ onboarding: { ...(onboarding ?? { done: true }), checklistHidden: true } })}>
              {L('Esconder a lista', 'Hide the list')}
            </button>
            <span className="muted small">{L('Volta em Configurações.', 'Bring it back in Settings.')}</span>
          </div>
        </div>
      )}
      <button className={`getting__bar ${all ? 'is-all' : ''}`} onClick={() => setOpen(!open)}>
        <span className="getting__label">
          <Icon name={all ? 'check' : 'spark'} size={14} /> {L('Primeiros passos', 'Getting started')}
          <span className="muted">
            {count}/{items.length}
          </span>
        </span>
        <span className="getting__track">
          <span style={{ width: `${(count / items.length) * 100}%` }} />
        </span>
      </button>
    </div>
  )
}
