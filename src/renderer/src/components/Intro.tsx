// The first run: one guided path that someone who never used an AI app can follow, and that
// someone who has Claude Code or Codex ready crosses in three clicks. Hello, then the AI (found
// already set up, or set up here with no terminal: the official CLI and its own sign-in in the
// browser), then the Tuca asks what to hand off and the first agent is born from the answer. It
// lands in #geral with the first message written and not sent (Coach.tsx points at it). Someone
// invited to a team gets their own short welcome instead (GuestWelcome).
import { L } from '../../../shared/lang'
import { CATALOG, entryOf } from '../../../shared/connector-catalog'
import { agentModel, aiState, autonomyChosen, isFastModel, backgroundModel, FIRST_AUTONOMY, GOALS, goalForText, needsSignIn, storedAutonomy, type Goal } from '../../../shared/onboarding'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  ENGINES,
  ENGINE_IDS,
  cancelEngineSetup,
  engineModels,
  engineSetupState,
  ensureTuca,
  getState,
  harnessMcps,
  importHarnessMcp,
  isTeam,
  linkSkill,
  localSkills,
  loginEngine,
  installEngine,
  modelInfo,
  navigate,
  newAgentDraft,
  newChannel,
  openExternal,
  refreshEngines,
  saveAgent,
  setMyName,
  setupEngine,
  slug,
  testEngine,
  updateSettings,
  useStore,
  messagesIn,
  windowless,
  amOwner,
  initials,
  type Agent,
  type AgentColor,
  type AgentDraft,
  type EngineId,
  type HarnessMcp,
  type LocalSkill,
  type SetupEngine,
  type SetupState
} from '../store'
import { HarnessList } from './Harness'
import { BackupCard, STATUS, Toggle } from './Pages'
import { Select } from './Select'
import { useEngineModels } from './Harness'
import { Splash } from './Splash'
import { Composer, composerDraft, MessageList, setComposerDraft, useDictation, VoiceButton } from './Conversation'
import { draftAgent, UseDraft } from './Tuca'
import { Onboarding } from './Onboarding'
import { CatalogLogo, ConnectorGrid } from './ConnectorStore'
import { Modal } from './Modal'
import { AutonomyPick } from './AutonomyPick'
import { EngineProblem } from './EngineProblem'
import { explainEngineError } from '../../../shared/engine-errors'
import { ENGINE_LOGOS } from '../engine-logos'
import { AgentAvatar, Icon, MeAvatar, TucaMark } from './ui'

// The opening plays once per run of the app, not again when the language changes.
let opened = false

type Step = 'welcome' | 'ai' | 'goal' | 'agent' | 'adjust' | 'manual'
const DOT: Record<Step, number> = { welcome: 0, ai: 1, goal: 2, agent: 3, adjust: 3, manual: 3 }

export function unique(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`
}

// A goal as an agent draft: who it is, what it knows, the web when the goal needs it, nothing else.
export function agentFromGoal(goal: Goal, base: Agent, modelId: string | undefined): Agent {
  return { ...base, name: goal.name, role: goal.role, color: goal.color, customColor: undefined, instructions: goal.instructions, web: goal.web, browser: false, computer: false, ...(modelId ? { modelId } : {}) }
}

export function Intro(): ReactNode {
  const settings = useStore((s) => s.settings)
  const hasAgents = useStore((s) => s.agents.some(isTeam))
  const [opening, setOpening] = useState(!opened)
  const onOpened = useCallback(() => ((opened = true), setOpening(false)), [])
  const [step, setStep] = useState<Step>('welcome')
  const [name, setName] = useState(settings.workspaceName)
  const [models, setModels] = useState<{ router: string; memory: string } | null>(null)
  const [goal, setGoal] = useState<Goal | null>(null)
  // How far it goes on its own starts on Normal, the recommended answer (kept as "Padrão" while Settings say Normal).
  const [agent, setAgent] = useState<Agent>(() => ({ ...newAgentDraft(), autonomy: storedAutonomy(FIRST_AUTONOMY, settings.autonomy) }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cheer, setCheer] = useState(false)
  const [dir, setDir] = useState<'next' | 'back'>('next')
  const go = (s: Step): void => (setDir(DOT[s] < DOT[step] ? 'back' : 'next'), setStep(s), setError(''))

  const pick = (g: Goal): void => {
    setGoal(g)
    const s = getState().settings
    setAgent((a) => agentFromGoal(g, a, agentModel(s.engines, listedNow) ?? a.modelId))
    go('agent')
  }

  // The first agent joins #geral, the first message waits in the field, and the tour starts there.
  async function call(a: Agent, task: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const s = getState()
      const handle = unique(slug(a.name).length >= 2 ? slug(a.name) : L('agente', 'agent'), s.agents.map((x) => x.handle))
      const channelId = await newChannel(unique(L('geral', 'general'), s.conversations.filter((c) => c.kind === 'channel').map((c) => c.name)))
      // What's connected starts read-only: writing is the person's to turn on, on the agent's page.
      const grants = Object.fromEntries(s.connectors.map((c) => [c.id, a.grants[c.id] ?? 'read' as const]))
      await saveAgent({ ...a, name: a.name.trim(), role: a.role.trim(), handle, grants }, [channelId])
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setCheer(true)
        await new Promise((done) => setTimeout(done, 650))
      }
      setComposerDraft(channelId, `@${handle} ${task.trim()}`)
      const o = getState().settings.onboarding
      updateSettings({
        workspaceName: name.trim() || settings.workspaceName,
        ...(models ? { routerModel: models.router, memoryModel: models.memory } : {}),
        onboarding: { ...o, done: true, channel: channelId, tour: { done: [] } }
      })
      navigate({ kind: 'conversation', id: channelId })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setCheer(false)
    } finally {
      setBusy(false)
    }
  }

  const close = (): void => updateSettings({ onboarding: { ...settings.onboarding, done: true } })

  if (opening) return <Splash onDone={onOpened} />
  if (step === 'manual')
    return <Onboarding manual={{ onBack: () => go('goal'), onCreate: (a, task) => call(a, task) }} />

  return (
    <div className="intro">
      <div className="intro__drag" />
      {hasAgents && (
        <button className="intro__close" onClick={close}>
          {L('Fechar', 'Close')}
        </button>
      )}
      <div className="intro__stage" key={step} data-dir={dir}>
        {step === 'welcome' && <Welcome name={name} setName={setName} onNext={() => go('ai')} />}
        {step === 'ai' && <ConnectAi name={name} onBack={() => go('welcome')} onNext={(m) => (setModels(m), go('goal'))} />}
        {step === 'goal' && <AskGoal name={name} onPick={pick} onOwn={(t) => pick(goalForText(t))} onManual={() => go('manual')} onBack={() => go('ai')} />}
        {step === 'agent' && goal && <Born agent={agent} goal={goal} patch={(p) => setAgent((a) => ({ ...a, ...p }))} busy={busy} error={error} onCall={() => void call(agent, goal.task)} onAdjust={() => go('adjust')} onBack={() => go('goal')} />}
        {step === 'adjust' && goal && (
          <Adjust
            agent={agent}
            goal={goal}
            onUse={(d) => {
              // The Tuca's version keeps the answer to how far it goes on its own.
              setAgent((a) => ({ ...draftAgent(d), id: a.id, limit: a.limit, autonomy: a.autonomy }))
              if (d.task) setGoal({ ...goal, task: d.task })
              go('agent')
            }}
            onBack={() => go('agent')}
          />
        )}
      </div>
      {cheer && (
        <div className="onb-cheer" aria-hidden>
          <TucaMark size={96} happy />
        </div>
      )}
    </div>
  )
}

// What the harnesses list (Codex's catalog, OpenCode's providers…), asked once and kept for the run.
let listedNow: Partial<Record<EngineId, string[]>> = {}
function useListed(): Partial<Record<EngineId, string[]>> {
  const engines = useStore((s) => s.settings.engines)
  const [listed, setListed] = useState(listedNow)
  const ready = ENGINE_IDS.filter((e) => e !== 'claude' && engines[e].loggedIn && !engines[e].soon)
  useEffect(() => {
    let live = true
    for (const e of ready.filter((x) => !listedNow[x]))
      void engineModels(e).then(
        (r) => {
          listedNow = { ...listedNow, [e]: r.models }
          if (live) setListed(listedNow)
        },
        () => {}
      )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready.join()])
  return listed
}

// ---------- the pieces every screen shares ----------

function Dots({ at }: { at: number }): ReactNode {
  return (
    <span className="intro-dots" role="img" aria-label={L(`Passo ${at + 1} de 5`, `Step ${at + 1} of 5`)}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span key={i} className={i === at ? 'is-now' : i < at ? 'is-done' : ''} />
      ))}
    </span>
  )
}

function Top({ at, onBack, right }: { at: number; onBack?: () => void; right?: ReactNode }): ReactNode {
  return (
    <div className="intro__top">
      <Dots at={at} />
      {right ?? (onBack && (
        <button className="intro-link intro-link--quiet" onClick={onBack}>
          {L('Voltar', 'Back')}
        </button>
      ))}
    </div>
  )
}

function Bubble({ children, strong }: { children: ReactNode; strong?: boolean }): ReactNode {
  return <div className={`intro-bubble ${strong ? 'is-strong' : ''}`}>{children}</div>
}

// The face of an agent as the mockups draw it, without a name to read: decoration.
function Face({ color, size, tilt = 0, style }: { color: AgentColor; size: number; tilt?: number; style?: CSSProperties }): ReactNode {
  return (
    <span className="intro-face" style={{ ...style, transform: `rotate(${tilt}deg)` }} aria-hidden>
      <AgentAvatar agent={{ name: '', color }} size={size} />
    </span>
  )
}

function Check({ size = 22 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 22 22" aria-hidden className="intro-check">
      <circle cx="11" cy="11" r="11" />
      <path d="M6.5 11.5 L9.5 14 L15.5 8" />
    </svg>
  )
}

function Spinner(): ReactNode {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="intro-spin">
      <circle cx="11" cy="11" r="9" />
    </svg>
  )
}

function Pending(): ReactNode {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden className="intro-pending">
      <circle cx="11" cy="11" r="9.5" />
    </svg>
  )
}

function LangToggle(): ReactNode {
  const language = useStore((s) => s.settings.language)
  return (
    <span className="intro-lang" role="radiogroup" aria-label="Idioma · Language">
      {(['pt', 'en'] as const).map((l, i) => (
        <span key={l}>
          {i > 0 && <span aria-hidden> · </span>}
          <button role="radio" aria-checked={language === l} className={language === l ? 'is-on' : ''} onClick={() => language !== l && updateSettings({ language: l })}>
            {l === 'pt' ? 'Português' : 'English'}
          </button>
        </span>
      ))}
    </span>
  )
}

// ---------- 1. hello ----------

function Welcome({ name, setName, onNext }: { name: string; setName: (v: string) => void; onNext: () => void }): ReactNode {
  const servers = !!window.tucano?.servers
  const [joining, setJoining] = useState(false)
  // A Tucano on a server, new: whoever used Tucano on their computer brings it all here instead.
  const web = windowless()
  const [restoring, setRestoring] = useState(false)
  return (
    <div className="intro__split">
      <div className="intro-art intro-art--peach" aria-hidden>
        <span className="intro-blob" style={{ left: 90, top: 150, width: 380, height: 380 }} />
        <span className="intro-hero">
          <TucaMark size={260} />
        </span>
        <Face color="violet" size={78} tilt={-9} style={{ left: 56, top: 110 }} />
        <Face color="amber" size={66} tilt={8} style={{ right: 70, top: 90 }} />
        <Face color="teal" size={84} tilt={-5} style={{ right: 60, top: 470 }} />
        <span className="intro-chip" style={{ left: 60, top: 520 }}>
          {L('Pesquisei 12 fontes', 'Read 12 sources')} <Icon name="check" size={14} />
        </span>
        <span className="intro-chip intro-chip--dark" style={{ right: 50, top: 610 }}>
          {L('Rascunho do e-mail pronto', 'Email draft ready')}
        </span>
        <span className="intro-chip" style={{ left: 110, top: 640 }}>
          {L('Posso enviar?', 'Can I send it?')} <b>{L('Aprovar', 'Approve')}</b>
        </span>
      </div>
      <section className="intro__main">
        <div className="intro__top">
          <Dots at={0} />
          <LangToggle />
        </div>
        <div className="intro__center">
          <h1 className="intro-h1">
            {L('Seu time de IA,', 'Your AI team,')}
            <br />
            {L('no seu computador.', 'on your computer.')}
          </h1>
          <p className="intro-lead">{L('Agentes que pesquisam, escrevem e organizam por você. Você conversa com eles como num chat, e nada importante acontece sem o seu ok.', 'Agents that research, write and organize for you. You talk to them like in a chat, and nothing important happens without your ok.')}</p>
          <label className="intro-field">
            {L('Como posso te chamar?', 'What should I call you?')}
            <input className="intro-input" autoFocus value={name} placeholder={L('Seu nome', 'Your name')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && onNext()} />
          </label>
          <div className="intro-actions">
            <button className="intro-btn" disabled={!name.trim()} onClick={onNext}>
              {L('Começar', 'Get started')}
            </button>
            {servers && (
              <button className="intro-link" aria-expanded={joining} onClick={() => setJoining(!joining)}>
                {L('Tenho um convite ou um servidor', 'I have an invite or a server')}
              </button>
            )}
            {web && (
              <button className="intro-link" aria-expanded={restoring} onClick={() => setRestoring(!restoring)}>
                {L('Já uso o Tucano no computador', 'I already use Tucano on my computer')}
              </button>
            )}
          </div>
          {joining && <JoinLink />}
          {restoring && (
            <div className="intro-restore">
              <BackupCard />
            </div>
          )}
        </div>
        <span className="intro-foot">{L('Conversas, memória e logins ficam no seu computador.', 'Conversations, memory and logins stay on your computer.')}</span>
      </section>
    </div>
  )
}

// A server's connection link pairs this app with it; an invite link opens in the browser, where the
// invited person picks their name (the server keeps who they are there).
function JoinLink(): ReactNode {
  const [link, setLink] = useState('')
  const [note, setNote] = useState('')
  const go = async (): Promise<void> => {
    const v = link.trim()
    setNote('')
    if (/^https?:\/\/\S+[?&]invite=/.test(v)) {
      openExternal(v)
      return setNote(L('Abri o convite no seu navegador. É lá que você entra no time.', 'I opened the invite in your browser. That’s where you join the team.'))
    }
    const r = await window.tucano.servers!.pair(v)
    if (r === 'invalid') setNote(L('Esse link não é um convite nem um link de conexão. Peça de novo a quem te chamou.', 'That link isn’t an invite or a connection link. Ask whoever invited you again.'))
  }
  return (
    <form
      className="intro-join"
      onSubmit={(e) => {
        e.preventDefault()
        if (link.trim()) void go()
      }}
    >
      <label className="sr-only" htmlFor="intro-join">
        {L('O link que te mandaram', 'The link you were sent')}
      </label>
      <input id="intro-join" className="intro-input" autoFocus type="password" autoComplete="off" spellCheck={false} placeholder={L('Cole o link do convite ou do servidor', 'Paste the invite or server link')} value={link} onChange={(e) => (setLink(e.target.value), setNote(''))} />
      <button className="intro-btn intro-btn--sm" type="submit" disabled={!link.trim()}>
        {L('Entrar', 'Join')}
      </button>
      {note && (
        <p className="intro-note" role="status">
          {note}
        </p>
      )}
    </form>
  )
}

// ---------- 2. the AI ----------

// The harness's own mark on its brand color (engine-logos.ts); its initial where there's no mark (Grok).
function EngineMark({ engine, size = 44 }: { engine: EngineId; size?: number }): ReactNode {
  const logo = ENGINE_LOGOS[engine]
  return (
    <span className={`intro-mark ${logo?.hex === '211E1B' || !logo ? 'intro-mark--ink' : ''}`} style={{ width: size, height: size, ...(logo ? { background: `#${logo.hex}` } : { fontSize: 17 }) }} aria-hidden>
      {logo ? (
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.54)} height={Math.round(size * 0.54)} fill="currentColor">
          <path d={logo.path} />
        </svg>
      ) : (
        ENGINES[engine].label[0]
      )}
    </span>
  )
}

// One real reply per harness, asked once per run: the screen says how long it took.
type Tested = { ok: boolean; seconds?: number; message: string }
const tests = new Map<string, Promise<Tested>>()
function useTest(model: string | undefined): [Tested | 'running' | undefined, () => void] {
  const [got, setGot] = useState<{ model: string; r: Tested } | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!model) return
    if (!tests.has(model)) tests.set(model, testEngine(model).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e) })))
    let live = true
    void tests.get(model)!.then((r) => live && setGot({ model, r }))
    return () => {
      live = false
    }
  }, [model, round])
  // "Tentar de novo": a new test, after the person fixed what was wrong (signed in again, say).
  const retry = (): void => {
    if (!model) return
    tests.delete(model)
    setGot(null)
    setRound((n) => n + 1)
  }
  if (!model) return [undefined, retry]
  return [got?.model === model ? got.r : 'running', retry]
}

const secs = (s: number): string => s.toLocaleString(L('pt-BR', 'en-US'), { minimumFractionDigits: 1, maximumFractionDigits: 1 })

// The everyday quick model of a harness, for its test reply.
function quickModel(engine: EngineId, listed: Partial<Record<EngineId, string[]>>): string | undefined {
  const s = getState().settings.engines
  const only = Object.fromEntries(ENGINE_IDS.map((e) => [e, e === engine ? s[e] : { installed: false, loggedIn: false }])) as typeof s
  return s[engine].route === 'gateway' ? undefined : backgroundModel(only, listed)
}

// The CLI being set up with no terminal, as the core reports it (asked every moment while it runs).
function useSetup(): [SetupState | null, (e: SetupEngine) => void, () => void] {
  const [state, setState] = useState<SetupState | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const poll = useCallback(() => {
    clearInterval(timer.current)
    timer.current = setInterval(() => {
      void engineSetupState().then((s) => {
        setState(s)
        if (!s || s.state !== 'running') clearInterval(timer.current)
        if (s && s.state === 'done') refreshEngines()
      })
    }, 700)
  }, [])
  useEffect(() => () => clearInterval(timer.current), [])
  const start = (e: SetupEngine): void => {
    setState({ engine: e, step: 'install', state: 'running' })
    void setupEngine(e).then(
      (s) => (setState(s), poll()),
      (err: unknown) => setState({ engine: e, step: 'install', state: 'error', error: err instanceof Error ? err.message : String(err) })
    )
  }
  const cancel = (): void => {
    cancelEngineSetup()
    clearInterval(timer.current)
    setState(null)
  }
  return [state, start, cancel]
}

function ConnectAi({ name, onBack, onNext }: { name: string; onBack: () => void; onNext: (m: { router: string; memory: string }) => void }): ReactNode {
  const engines = useStore((s) => s.settings.engines)
  const saved = useStore((s) => ({ router: s.settings.routerModel, memory: s.settings.memoryModel }))
  const keep = useStore((s) => s.agents.some(isTeam) || !!s.settings.onboarding?.carried)
  const listed = useListed()
  const [mode, setMode] = useState<'auto' | 'advanced'>(windowless() ? 'advanced' : 'auto')
  const [chosen, setChosen] = useState<SetupEngine | null>(null)
  const [setup, startSetup, cancelSetup] = useSetup()
  const state = aiState(engines)
  // Someone seeing this again keeps their models; a new install gets the quick one picked for it.
  const auto = backgroundModel(engines, listed)
  const [picked, setPicked] = useState<{ router: string; memory: string } | null>(keep ? saved : null)
  const models = picked ?? (auto ? { router: auto, memory: auto } : null)

  useEffect(() => {
    refreshEngines()
    if (state === 'ready') return
    const t = setInterval(refreshEngines, 5000)
    return () => clearInterval(t)
  }, [state])

  const begin = (e: SetupEngine): void => (setChosen(e), startSetup(e))
  const first = name.trim().split(' ')[0] ?? ''

  if (mode === 'advanced') return <Advanced models={models} setModels={setPicked} onBack={windowless() ? onBack : () => setMode('auto')} onNext={() => models && onNext(models)} />

  // Ready, and nothing being set up here: what was found, a click away.
  if (state === 'ready' && !chosen)
    return (
      <div className="intro__split">
        <aside className="intro-side intro-side--teal">
          <TucaHead />
          <Bubble>{L('Opa, você já tem tudo pronto aqui. Achei o que você usa.', 'Oh, you’re all set up already. I found what you use.')}</Bubble>
          <Bubble>{auto ? L('Já escolhi os modelos rápidos pros bastidores. Se quiser mexer, é ali embaixo.', "Fast models are selected for background tasks. You can change them below.") : L('Só falta escolher os modelos rápidos pros bastidores, ali embaixo.', 'Just pick the quick models for behind the scenes, down there.')}</Bubble>
        </aside>
        <section className="intro__main">
          <Top at={1} onBack={onBack} />
          <Found engines={engines} listed={listed} models={models} setModels={setPicked} onSignIn={begin} onNext={(m) => onNext(m)} />
        </section>
      </div>
    )

  return (
    <div className="intro__split">
      <aside className="intro-side intro-side--teal">
        <TucaHead />
        {state === 'checking' && !chosen ? (
          <Bubble>{L('Deixa eu ver o que você já tem por aqui…', 'Let me see what you already have here…')}</Bubble>
        ) : (
          <>
            <Bubble>{first ? L(`Oi, ${first}! Seus agentes precisam de uma IA pra pensar.`, `Hi, ${first}! Your agents need an AI to think with.`) : L('Oi! Seus agentes precisam de uma IA pra pensar.', 'Hi! Your agents need an AI to think with.')}</Bubble>
            <Bubble>{L('Eles usam a assinatura que você já tem, sem cobrança extra. Qual você assina?', 'They use the subscription you already have, at no extra cost. Which one do you have?')}</Bubble>
          </>
        )}
        <span className="grow" />
        <p className="intro-side__note">
          <Icon name="lock" size={20} /> {L('O login é feito no site deles. O Tucano nunca vê a sua senha.', 'You sign in on their website. Tucano never sees your password.')}
        </p>
      </aside>
      <section className="intro__main">
        <Top at={1} onBack={onBack} />
        <div className="intro__center intro__center--tight">
          <h1 className="intro-h2">{L('Conectar a IA', 'Connect the AI')}</h1>
          {state === 'checking' && !chosen ? (
            <p className="intro-wait" role="status">
              <Spinner /> {L('Procurando…', 'Looking…')}
            </p>
          ) : (
            <Plans engines={engines} chosen={chosen} setup={setup} begin={begin} cancel={() => (cancelSetup(), setChosen(null))} models={models} listed={listed} onNext={onNext} />
          )}
          <button className="intro-link" onClick={() => setMode('advanced')}>
            {L('Uso chave de API, gateway da empresa ou outro programa', 'I use an API key, a company gateway or another program')}
          </button>
        </div>
      </section>
    </div>
  )
}

function TucaHead(): ReactNode {
  return (
    <div className="intro-tuca">
      <TucaMark size={52} />
      <span>
        <b>Tuca</b>
        <span>{L('te ajuda a começar', 'helps you get started')}</span>
      </span>
    </div>
  )
}

// Nothing set up: ChatGPT or Claude, each set up here; or what to subscribe to.
function Plans(p: {
  engines: ReturnType<typeof getState>['settings']['engines']
  chosen: SetupEngine | null
  setup: SetupState | null
  begin: (e: SetupEngine) => void
  cancel: () => void
  models: { router: string; memory: string } | null
  listed: Partial<Record<EngineId, string[]>>
  onNext: (m: { router: string; memory: string }) => void
}): ReactNode {
  const [none, setNone] = useState(false)
  const card = (e: SetupEngine): ReactNode => {
    const title = e === 'codex' ? 'ChatGPT' : 'Claude'
    const plans = e === 'codex' ? L('Plus, Pro ou Business', 'Plus, Pro or Business') : L('Pro ou Max', 'Pro or Max')
    if (p.chosen === e) return <SetupCard key={e} engine={e} title={title} plans={plans} setup={p.setup} retry={() => p.begin(e)} cancel={p.cancel} models={p.models} listed={p.listed} onNext={p.onNext} />
    return (
      <button key={e} className="intro-card intro-card--pick" disabled={!!p.chosen && p.setup?.state === 'running'} onClick={() => p.begin(e)}>
        <EngineMark engine={e} />
        <span className="intro-card__text">
          <b>{title}</b>
          <span>{plans}</span>
        </span>
      </button>
    )
  }
  const order: SetupEngine[] = p.chosen === 'claude' ? ['claude', 'codex'] : ['codex', 'claude']
  return (
    <>
      {p.chosen && card(p.chosen)}
      <div className="intro-grid2">
        {order.filter((e) => e !== p.chosen).map(card)}
        <button className="intro-card intro-card--quiet" aria-expanded={none} onClick={() => setNone(!none)}>
          <b>{L('Não assino nenhuma', 'I don’t subscribe to any')}</b>
          <span>{L('Te explico qual escolher', 'I’ll explain which to pick')}</span>
        </button>
      </div>
      {none && (
        <div className="intro-panel" role="region" aria-label={L('Qual assinar', 'Which to subscribe to')}>
          <p>{L('Os agentes pensam com a IA de uma assinatura sua. Qualquer uma destas serve, e você paga direto pra empresa, não pro Tucano:', 'The agents think with the AI of a subscription of yours. Any of these works, and you pay the company directly, not Tucano:')}</p>
          <ul>
            <li>
              <b>ChatGPT Plus</b> {L('(ou Pro, Business): da OpenAI. Bom pra quase tudo.', '(or Pro, Business): from OpenAI. Good for almost everything.')}{' '}
              <button className="intro-link" onClick={() => openExternal('https://chatgpt.com/pricing')}>
                {L('Ver os planos', 'See the plans')}
              </button>
            </li>
            <li>
              <b>Claude Pro</b> {L('(ou Max): da Anthropic. Muito bom pra escrever e pesquisar.', '(or Max): from Anthropic. Very good for writing and research.')}{' '}
              <button className="intro-link" onClick={() => openExternal('https://claude.com/pricing')}>
                {L('Ver os planos', 'See the plans')}
              </button>
            </li>
          </ul>
          <p className="intro-muted">{L('O plano grátis de cada uma não serve: ele não inclui o programa que os agentes usam. Depois de assinar, volte aqui e escolha a sua.', 'The free plan of either won’t do: it doesn’t include the program the agents use. Once you subscribe, come back and pick yours.')}</p>
        </div>
      )}
    </>
  )
}

// One being set up: the program, the sign-in, then a real reply.
function SetupCard(p: { engine: SetupEngine; title: string; plans: string; setup: SetupState | null; retry: () => void; cancel: () => void; models: { router: string; memory: string } | null; listed: Partial<Record<EngineId, string[]>>; onNext: (m: { router: string; memory: string }) => void }): ReactNode {
  const st = useStore((s) => s.settings.engines[p.engine])
  const s = p.setup?.engine === p.engine ? p.setup : null
  const signedIn = st.loggedIn || (s?.step === 'login' && s.state === 'done')
  const [test] = useTest(signedIn && st.loggedIn ? quickModel(p.engine, p.listed) : undefined)
  const failed = s?.state === 'error'
  const installDone = st.installed || s?.step === 'login'
  const result = test && test !== 'running' ? test : undefined
  const ok = !!result?.ok
  const pill = failed ? L('Não deu certo', 'Didn’t work') : ok ? L('Conectado', 'Connected') : L('Conectando…', 'Connecting…')
  const label = (state: 'done' | 'now' | 'later' | 'error', text: ReactNode): ReactNode => (
    <li className={`intro-step is-${state}`}>
      {state === 'done' ? <Check /> : state === 'now' ? <Spinner /> : state === 'error' ? <Icon name="x" size={20} /> : <Pending />}
      <span>{text}</span>
    </li>
  )
  const pct = s?.step === 'install' && s.progress ? ` ${Math.round(s.progress * 100)}%` : ''
  return (
    <div className="intro-card intro-card--live" aria-live="polite">
      <div className="intro-card__head">
        <EngineMark engine={p.engine} size={48} />
        <span className="intro-card__text">
          <b>{p.title}</b>
          <span>{p.plans}</span>
        </span>
        <span className={`intro-pill ${ok ? 'is-ok' : failed ? 'is-bad' : ''}`}>{pill}</span>
      </div>
      <ol className="intro-steps">
        {label(installDone ? 'done' : failed && s?.step === 'install' ? 'error' : 'now', installDone ? L('Preparei tudo no seu computador', 'I set everything up on your computer') : L(`Preparando tudo no seu computador…${pct}`, `Setting everything up on your computer…${pct}`))}
        {label(
          signedIn ? 'done' : failed && s?.step === 'login' ? 'error' : installDone ? 'now' : 'later',
          signedIn ? (
            L('Você entrou na sua conta', 'You’re signed in')
          ) : installDone ? (
            <>
              <b>{L('Abri o login no seu navegador.', 'I opened the sign-in in your browser.')}</b> {L('Entre com a sua conta e volte.', 'Sign in with your account and come back.')}
              {s?.url && (
                <>
                  {' '}
                  <button className="intro-link" onClick={() => openExternal(s.url!)}>
                    {L('Abrir de novo', 'Open it again')}
                  </button>
                </>
              )}
            </>
          ) : (
            L('Abrir o login no seu navegador', 'Open the sign-in in your browser')
          )
        )}
        {label(
          ok ? 'done' : result ? 'error' : signedIn ? 'now' : 'later',
          result?.ok ? L(`Respondeu em ${secs(result.seconds ?? 0)} s. Tudo certo.`, `Answered in ${secs(result.seconds ?? 0)} s. All set.`) : result ? explainEngineError(p.engine, result.message).line : L('Testar com uma resposta de verdade', 'Test with a real reply')
        )}
      </ol>
      {failed && (
        <div className="intro-fail" role="alert">
          {s?.error && <EngineProblem look="intro" engine={p.engine} message={s.error} />}
          <div className="intro-actions">
            <button className="intro-btn intro-btn--sm" onClick={p.retry}>
              {L('Tentar de novo', 'Try again')}
            </button>
            <Terminal engine={p.engine} installed={st.installed} />
          </div>
        </div>
      )}
      {ok && p.models ? (
        <div className="intro-actions">
          <button className="intro-btn" autoFocus onClick={() => p.onNext(p.models!)}>
            {L('Continuar', 'Continue')}
          </button>
        </div>
      ) : (
        !failed && (
          <button className="intro-link intro-link--quiet" onClick={p.cancel}>
            {L('Cancelar', 'Cancel')}
          </button>
        )
      )}
    </div>
  )
}

// Where the setup can't finish on its own: the CLI's own installer or sign-in in a terminal, as before.
function Terminal({ engine, installed }: { engine: SetupEngine; installed: boolean }): ReactNode {
  const [cmd, setCmd] = useState('')
  const open = (): void => void (installed ? loginEngine(engine) : installEngine(engine)).then((r) => setCmd(r.opened ? '' : r.command))
  return (
    <>
      <button className="intro-link" onClick={open}>
        {L('Fazer pelo terminal', 'Do it in a terminal')}
      </button>
      {cmd && (
        <p className="intro-note">
          {L('Cole isto num terminal:', 'Paste this in a terminal:')} <code>{cmd}</code>
        </p>
      )}
    </>
  )
}

// Already set up: what was found, tested; what can come along from Claude Code; the models behind the scenes.
function Found(p: {
  engines: ReturnType<typeof getState>['settings']['engines']
  listed: Partial<Record<EngineId, string[]>>
  models: { router: string; memory: string } | null
  setModels: (m: { router: string; memory: string }) => void
  onSignIn: (e: SetupEngine) => void
  onNext: (m: { router: string; memory: string }) => void
}): ReactNode {
  const ready = ENGINE_IDS.filter((e) => p.engines[e].loggedIn && !p.engines[e].soon && !p.engines[e].off)
  const signIn = needsSignIn(p.engines).filter((e) => !ready.includes(e))
  const [mcps, setMcps] = useState<HarnessMcp[]>([])
  const [skills, setSkills] = useState<LocalSkill[]>([])
  const [bring, setBring] = useState({ mcps: true, skills: true })
  const [change, setChange] = useState(!p.models)
  const [busy, setBusy] = useState(false)
  // How each one's test went: one that failed doesn't hold the others up.
  const [results, setResults] = useState<Partial<Record<EngineId, boolean>>>({})
  const onResult = useCallback((e: EngineId, ok: boolean | undefined) => setResults((r) => (r[e] === ok ? r : { ...r, [e]: ok })), [])
  const working = ready.filter((e) => results[e] === true)
  const failing = ready.filter((e) => results[e] === false)
  useEffect(() => {
    void harnessMcps().then((f) => setMcps(f.filter((m) => !m.added)), () => {})
    void localSkills().then(setSkills, () => {})
  }, [])
  const fromClaude = mcps.every((m) => m.harnesses.includes('claude')) && skills.every((k) => k.origin === 'Claude Code')
  const label = (v: string): string => (v === 'jev' ? 'Jev' : (modelInfo(v)?.label ?? v))

  async function next(): Promise<void> {
    if (!p.models) return
    setBusy(true)
    // What comes along, in the background of the next screen: none of it is needed to go on.
    if (bring.mcps) for (const m of mcps) void importHarnessMcp(m.key).catch(() => {})
    if (bring.skills) for (const k of skills) void linkSkill(k.source).catch(() => {})
    p.onNext(p.models)
  }

  return (
    <div className="intro__center intro__center--tight intro__center--found">
      <h1 className="intro-h2">{foundTitle(working.length, ready.length - working.length - failing.length)}</h1>
      <div className="intro-card intro-card--list intro-found">
        {ready.map((e) => (
          <FoundRow key={e} engine={e} account={p.engines[e].account} gateway={p.engines[e].route === 'gateway'} listed={p.listed} onResult={onResult} onSignIn={() => (e === 'claude' || e === 'codex' ? p.onSignIn(e) : void loginEngine(e))} />
        ))}
        {signIn.map((e) => (
          <div key={e} className="intro-row">
            <EngineMark engine={e} />
            <span className="intro-card__text">
              <b>{ENGINES[e].label}</b>
              <span>{e === 'codex' ? L('Instalado. Falta entrar uma vez, pro Tucano.', 'Installed. Needs one sign-in, for Tucano.') : L('Instalado. Falta entrar.', 'Installed. Not signed in.')}</span>
            </span>
            <button className="intro-btn intro-btn--sm intro-btn--light" onClick={() => p.onSignIn(e as SetupEngine)}>
              {L('Entrar', 'Sign in')}
            </button>
          </div>
        ))}
      </div>
      {(mcps.length > 0 || skills.length > 0 || p.models || change) && (
        <div className="intro-panel intro-panel--tight">
          {(mcps.length > 0 || skills.length > 0) && <b className="intro-panel__title">{L('Também achei', 'I also found')}</b>}
          {mcps.length > 0 && (
            <BringRow
              from={fromClaude ? 'claude' : undefined}
              icon="plug"
              on={bring.mcps}
              onChange={(v) => setBring({ ...bring, mcps: v })}
              title={
                fromClaude
                  ? mcps.length === 1 ? L('Trazer 1 ferramenta do Claude Code', 'Bring 1 tool from Claude Code') : L(`Trazer ${mcps.length} ferramentas do Claude Code`, `Bring ${mcps.length} tools from Claude Code`)
                  : mcps.length === 1 ? L('Trazer 1 ferramenta', 'Bring 1 tool') : L(`Trazer ${mcps.length} ferramentas`, `Bring ${mcps.length} tools`)
              }
              names={mcps.map((m) => m.name)}
            />
          )}
          {skills.length > 0 && (
            <BringRow
              from={fromClaude ? 'claude' : undefined}
              icon="spark"
              on={bring.skills}
              onChange={(v) => setBring({ ...bring, skills: v })}
              title={skills.length === 1 ? L('Trazer 1 skill', 'Bring 1 skill') : L(`Trazer ${skills.length} skills`, `Bring ${skills.length} skills`)}
              names={skills.map((k) => k.name)}
            />
          )}
          {change ? (
            <BackgroundPickers models={p.models} setModels={p.setModels} />
          ) : (
            p.models && (
              <span className="intro-muted">
                {p.models.router === p.models.memory
                  ? L(`Modelos dos bastidores: ${label(p.models.router)} pra escolher quem responde e pra memória.`, `Behind the scenes: ${label(p.models.router)} picks who replies and keeps the memory.`)
                  : L(`Modelos dos bastidores: ${label(p.models.router)} pra escolher quem responde, ${label(p.models.memory)} pra memória.`, `Behind the scenes: ${label(p.models.router)} picks who replies, ${label(p.models.memory)} keeps the memory.`)}{' '}
                <button className="intro-link" onClick={() => setChange(true)}>
                  {L('Trocar', 'Change')}
                </button>
              </span>
            )
          )}
        </div>
      )}
      <div className="intro-actions">
        <button className="intro-btn" disabled={!p.models || busy} onClick={() => void next()}>
          {continueLabel(failing.length > 0 ? working : [])}
        </button>
        <span className={`intro-muted ${failing.length && working.length ? 'intro-actions__note' : ''}`}>
          {failing.length && working.length
            ? leftOut(failing)
            : L('Clique 2 de 3', 'Click 2 of 3')}
        </span>
      </div>
    </div>
  )
}

// The title counts only what answered; while tests still run, it says so instead of a number that may drop.
export function foundTitle(working: number, testing: number): string {
  if (testing > 0) return L('Testando o que achei…', 'Testing what I found…')
  if (working === 0) return L('Nenhum respondeu ao teste', 'None of them answered the test')
  return working === 1 ? L('Achei 1 pronto pra usar', 'Found 1 ready to use') : L(`Achei ${working} prontos pra usar`, `Found ${working} ready to use`)
}

// With one that failed: who goes on, by name when it's one, by count when several (the rows name them).
export function continueLabel(working: EngineId[]): string {
  if (working.length === 1) return L(`Continuar com ${ENGINES[working[0]!].label}`, `Continue with ${ENGINES[working[0]!].label}`)
  if (working.length > 1) return L(`Continuar com os ${working.length}`, `Continue with these ${working.length}`)
  return L('Continuar', 'Continue')
}

// Who stays out, by name: "Pi fica de fora…", "OpenCode e Pi ficam de fora…".
export function leftOut(failing: EngineId[]): string {
  const names = failing.map((e) => ENGINES[e].label)
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${L('e', 'and')} ${names.at(-1)}` : (names[0] ?? '')
  return names.length > 1 ? L(`${who} ficam de fora por agora; dá pra arrumar em Configurações.`, `${who} stay out for now; you can fix them in Settings.`) : L(`${who} fica de fora por agora; dá pra arrumar em Configurações.`, `${who} stays out for now; you can fix it in Settings.`)
}

const list = (names: string[]): string => (names.length > 4 ? `${names.slice(0, 4).join(', ')}${L(` e mais ${names.length - 4}`, ` and ${names.length - 4} more`)}` : names.join(', '))

function FoundRow({ engine, account, gateway, listed, onResult, onSignIn }: { engine: EngineId; account?: string; gateway: boolean; listed: Partial<Record<EngineId, string[]>>; onResult: (e: EngineId, ok: boolean | undefined) => void; onSignIn: () => void }): ReactNode {
  const [test, retry] = useTest(quickModel(engine, listed))
  const done = test && test !== 'running'
  const failed = !!done && !test.ok
  // A gateway names its own models, so there's nothing to test here: it counts as found.
  useEffect(() => onResult(engine, gateway ? true : done ? test.ok : undefined), [engine, gateway, done, test, onResult])
  return (
    <div className={`intro-row ${failed ? 'is-failed' : ''}`}>
      <EngineMark engine={engine} />
      <span className="intro-card__text">
        <b>{ENGINES[engine].label}</b>
        {/* Failed: the problem's line takes the account's place (it names the provider when it can). */}
        {failed ? (
          <EngineProblem look="intro" engine={engine} message={test.message} onSignIn={onSignIn} onRetry={retry} />
        ) : (
          <span>
            {account ?? L('Pronto', 'Ready')}
            {done && test.ok && test.seconds !== undefined && L(` · respondeu em ${secs(test.seconds)} s`, ` · answered in ${secs(test.seconds)} s`)}
          </span>
        )}
      </span>
      {gateway ? (
        <span role="img" aria-label={L('Pronto', 'Ready')}>
          <Check size={26} />
        </span>
      ) : !test || test === 'running' ? (
        <span role="img" aria-label={L('Testando', 'Testing')}>
          <Spinner />
        </span>
      ) : test.ok ? (
        <span role="img" aria-label={L('Pronto', 'Ready')}>
          <Check size={26} />
        </span>
      ) : (
        <Icon name="x" size={20} />
      )}
    </div>
  )
}

// Something found in the person's programs, to bring along: a switch, and the names under "ver quais".
function BringRow({ from, icon, on, onChange, title, names }: { from?: EngineId; icon: 'plug' | 'spark'; on: boolean; onChange: (v: boolean) => void; title: string; names: string[] }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className={`intro-bring ${on ? '' : 'is-off'}`}>
      {from ? (
        <EngineMark engine={from} size={28} />
      ) : (
        <span className="intro-bring__dot" aria-hidden>
          <Icon name={icon} size={15} />
        </span>
      )}
      <span className="intro-bring__text">
        <span>
          {title}{' '}
          <button className="intro-link intro-bring__more" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? L('esconder', 'hide') : names.length === 1 ? L('ver qual', 'see which') : L('ver quais', 'see which')}
          </button>
        </span>
        {open && <span className="intro-bring__names">{names.join(', ')}</span>}
      </span>
      <Toggle on={on} onChange={onChange} />
    </div>
  )
}

// The two small jobs behind the scenes, as two cards: the harness's mark, the model and how quick it is.
// A click opens the app's own menu, every ready harness's models grouped under its name.
function BackgroundPickers({ models, setModels }: { models: { router: string; memory: string } | null; setModels: (m: { router: string; memory: string }) => void }): ReactNode {
  const m = models ?? { router: '', memory: '' }
  const groups = useModelGroups()
  return (
    <div className="intro-jobs">
      <JobCard title={L('Escolhe quem responde', 'Picks who replies')} value={m.router} groups={groups} onChange={(v) => setModels({ ...m, router: v })} />
      <JobCard title={L('Cuida da memória', 'Keeps the memory')} value={m.memory} groups={groups} onChange={(v) => setModels({ ...m, memory: v })} />
      <span className="intro-muted intro-jobs__hint">{L('Quem responde decide, num canal, qual agente fala; a memória resume conversas longas. Um modelo rápido basta. Dá pra trocar depois em Configurações.', "The router chooses who replies in channels. The memory model summarizes long conversations. Use fast models; change them later in Settings.")}</span>
    </div>
  )
}

// Every ready harness's models, by harness, for one menu (a hook per harness, in a fixed order).
function useModelGroups(): Record<string, Record<string, string>> {
  const engines = useStore((s) => s.settings.engines)
  // eslint-disable-next-line react-hooks/rules-of-hooks -- ENGINE_IDS is fixed, so the hooks keep their order
  const lists = ENGINE_IDS.map((e) => [e, useEngineModels(engines[e].loggedIn && !engines[e].soon && !engines[e].off ? e : undefined)] as const)
  const groups: Record<string, Record<string, string>> = {}
  for (const [e, l] of lists) {
    if (!l.options.length) continue
    groups[ENGINES[e].label] = Object.fromEntries(l.options.map((o) => [o.value, o.hint ? `${o.label} · ${o.hint}` : o.label]))
  }
  return groups
}

function JobCard({ title, value, groups, onChange }: { title: string; value: string; groups: Record<string, Record<string, string>>; onChange: (v: string) => void }): ReactNode {
  const info = modelInfo(value)
  const name = info?.label ?? (value.includes(':') ? value.slice(value.indexOf(':') + 1) : value)
  return (
    <div className="intro-job">
      {info ? <EngineMark engine={info.engine} size={36} /> : <span className="intro-bring__dot" aria-hidden />}
      <span className="intro-job__text">
        <span className="intro-job__title">{title}</span>
        <span className="intro-job__model">
          <b>{value ? name : L('Escolher', 'Choose')}</b>
          {value && <span className={`intro-job__tag ${isFastModel(value) ? 'is-fast' : ''}`}>{isFastModel(value) ? L('rápido', 'fast') : L('forte', 'strong')}</span>}
        </span>
      </span>
      <Icon name="caret" size={14} />
      {/* The whole card is the menu's trigger: the app's Select, laid over it. */}
      <Select className="intro-job__select" aria-label={title} value={value || null} groups={groups} searchable onChange={(v) => v && onChange(v)} />
    </div>
  )
}

// API keys, a company's gateway, OpenCode, Pi and the rest: the harnesses as they're set up, by hand.
function Advanced({ models, setModels, onBack, onNext }: { models: { router: string; memory: string } | null; setModels: (m: { router: string; memory: string }) => void; onBack: () => void; onNext: () => void }): ReactNode {
  const engines = useStore((s) => s.settings.engines)
  const ok = (v: string | undefined): boolean => !!v && (v === 'jev' || !!modelInfo(v)?.id)
  const ready = aiState(engines) === 'ready'
  return (
    <div className="intro__split">
      <aside className="intro-side intro-side--teal">
        <TucaHead />
        <Bubble>{L('Sem problema. O Tucano usa o Claude Code, o Codex, o OpenCode e outros do jeito que você configurou: no plano, no gateway da empresa ou com os seus provedores.', 'No problem. Tucano uses Claude Code, Codex, OpenCode and others the way you set them up: on a plan, your company’s gateway or your providers.')}</Bubble>
        <Bubble>{L('Ele só lê essa configuração. Nunca vê nem guarda as suas senhas e chaves.', 'It only reads that setup. It never sees or stores your passwords and keys.')}</Bubble>
      </aside>
      <section className="intro__main intro__main--scroll">
        <Top at={1} onBack={onBack} />
        <div className="intro__center intro__center--tight intro__center--top">
          <h1 className="intro-h2">{L('Outros jeitos de conectar', 'Other ways to connect')}</h1>
          <div className="intro-harnesses">
            <HarnessList />
          </div>
          <div className="intro-panel">
            <BackgroundPickers models={models} setModels={setModels} />
          </div>
          <div className="intro-actions">
            <button className="intro-btn" disabled={!ready || !ok(models?.router) || !ok(models?.memory)} onClick={onNext}>
              {L('Continuar', 'Continue')}
            </button>
            {!ready && (
              <span className="intro-muted" role="status">
                {L('Entre em um deles e eu sigo sozinho.', 'Sign in to one of them and I’ll move on.')}
              </span>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}

// ---------- 3. the Tuca asks ----------

const TILE_ICONS: Record<string, { color: string; d: ReactNode }> = {
  week: { color: '#6D3FE0', d: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></> },
  research: { color: '#0D7A7A', d: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></> },
  write: { color: '#8A5A00', d: <path d="M4 20h4L19 9l-4-4L4 16zM13 7l4 4" /> },
  customers: { color: '#B8460F', d: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" /> },
  sheets: { color: '#2A6FB0', d: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M3 15h18M9 3v18" /></> },
  code: { color: '#3F3A33', d: <path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" /> }
}

function AskGoal({ name, onPick, onOwn, onManual, onBack }: { name: string; onPick: (g: Goal) => void; onOwn: (text: string) => void; onManual: () => void; onBack: () => void }): ReactNode {
  const engines = useStore((s) => s.settings.engines)
  const on = ENGINE_IDS.find((e) => engines[e].loggedIn && !engines[e].soon)
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const insert = (said: string): void => {
    setText((t) => (t.trim() ? `${t.trimEnd()} ${said}` : said))
    field.current?.focus()
  }
  const [voice, controls] = useDictation(insert, setNote, 'intro-goal')
  const first = name.trim().split(' ')[0] ?? ''
  const plan = on === 'codex' ? 'ChatGPT' : on === 'claude' ? 'Claude' : on ? ENGINES[on].label : ''
  return (
    <section className="intro__full">
      <Top
        at={2}
        right={
          <span className="intro__top-right">
            {plan && (
              <span className="intro-status">
                <span className="intro-status__dot" /> {L(`${plan} conectado`, `${plan} connected`)}
              </span>
            )}
            <button className="intro-link intro-link--quiet" onClick={onBack}>
              {L('Voltar', 'Back')}
            </button>
          </span>
        }
      />
      <div className="intro__center intro__center--narrow">
        <div className="intro-ask">
          <TucaMark size={56} />
          <div className="intro-ask__bubbles">
            <Bubble>{first ? L(`Pronto, ${first}! Agora vamos montar o seu primeiro agente.`, `Done, ${first}! Now let’s build your first agent.`) : L('Pronto! Agora vamos montar o seu primeiro agente.', 'Done! Now let’s build your first agent.')}</Bubble>
            <Bubble strong>
              <span id="intro-goal-q">{L('Qual é a primeira coisa que você queria tirar das suas costas?', 'What’s the first thing you’d like off your plate?')}</span>
            </Bubble>
          </div>
        </div>
        <div className="intro-tiles" role="group" aria-labelledby="intro-goal-q">
          {GOALS().map((g) => (
            <button key={g.id} className="intro-tile" onClick={() => onPick(g)}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={TILE_ICONS[g.id]!.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`intro-tile__icon is-${g.id}`}>
                {TILE_ICONS[g.id]!.d}
              </svg>
              <span>{g.title}</span>
            </button>
          ))}
        </div>
        <form
          className="intro-say"
          onSubmit={(e) => {
            e.preventDefault()
            if (text.trim()) onOwn(text)
          }}
        >
          <label htmlFor="intro-say" className="sr-only">
            {L('Conte pro Tuca', 'Tell Tuca')}
          </label>
          <input id="intro-say" ref={field} type="text" value={text} placeholder={L('Ou conte do seu jeito: responder clientes da minha loja no Instagram…', 'Or say it your way: reply to customers of my Instagram shop…')} onChange={(e) => setText(e.target.value)} />
          {text.trim() ? (
            <button className="intro-round" type="submit" aria-label={L('Mandar pro Tuca', 'Send to Tuca')}>
              <Icon name="send" size={18} />
            </button>
          ) : (
            <span className="intro-voice">
              <VoiceButton controls={controls} state={voice} />
            </span>
          )}
        </form>
        {note && (
          <p className="intro-note" role="status">
            {note}
          </p>
        )}
        <button className="intro-link intro-link--center" onClick={onManual}>
          {L('Prefiro configurar do zero', 'I’d rather set it up from scratch')}
        </button>
      </div>
    </section>
  )
}

// ---------- 4. the agent is born ----------

const DOTS: AgentColor[] = ['violet', 'sky', 'teal', 'amber', 'rose', 'green', 'indigo']
const COLOR_NAME = (): Record<AgentColor, string> => ({ violet: L('Lilás', 'Violet'), sky: L('Azul', 'Blue'), teal: L('Verde-água', 'Teal'), amber: L('Amarelo', 'Amber'), rose: L('Rosa', 'Rose'), green: L('Verde', 'Green'), indigo: L('Anil', 'Indigo'), graphite: L('Grafite', 'Graphite') })

function Born(p: { agent: Agent; goal: Goal; patch: (a: Partial<Agent>) => void; busy: boolean; error: string; onCall: () => void; onAdjust: () => void; onBack: () => void }): ReactNode {
  const { agent, goal } = p
  const [naming, setNaming] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const connected = useStore((s) => !!goal.connector && s.connectors.some((c) => entryOf(c)?.id === goal.connector!.id))
  const name = agent.name.trim() || L('seu agente', 'your agent')
  const offered = goal.connector && CATALOG.find((e) => e.id === goal.connector!.id)
  const settingsLevel = useStore((s) => s.settings.autonomy)
  const guard = useStore((s) => s.settings.outsideGuard ?? true)
  return (
    <div className="intro__split">
      <div className="intro-art intro-art--lilac">
        <div className="intro-art__say">
          <TucaMark size={44} />
          <Bubble>{L(`Pronto! Esse é o seu agente, ${name}. Quer mudar algo antes?`, `Done! This is your agent, ${name}. Want to change anything first?`)}</Bubble>
        </div>
        <span className="intro-blob intro-blob--lilac" aria-hidden style={{ left: 140, top: 190, width: 280, height: 280 }} />
        <span className="intro-born">
          <AgentAvatar agent={{ ...agent, name }} size={176} />
        </span>
        <div className="intro-name">
          {naming ? (
            <input
              className="intro-name__input"
              autoFocus
              aria-label={L('Nome do agente', 'The agent’s name')}
              value={agent.name}
              maxLength={40}
              onChange={(e) => p.patch({ name: e.target.value })}
              onBlur={() => setNaming(false)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && setNaming(false)}
            />
          ) : (
            <>
              <b>{name}</b>
              <button className="intro-name__edit" aria-label={L('Mudar o nome', 'Change the name')} onClick={() => setNaming(true)}>
                <Icon name="edit" size={16} />
              </button>
            </>
          )}
        </div>
        <span className="intro-tagline">{goal.tagline}</span>
        <div className="intro-colors" role="group" aria-label={L('Cor', 'Color')}>
          {DOTS.map((c) => (
            <button key={c} aria-pressed={!agent.customColor && agent.color === c} aria-label={COLOR_NAME()[c]} className={`intro-color c-${c} ${!agent.customColor && agent.color === c ? 'is-on' : ''}`} onClick={() => p.patch({ color: c, customColor: undefined })} />
          ))}
        </div>
      </div>
      <section className="intro__main">
        <Top at={3} onBack={p.onBack} />
        <div className="intro__center intro__center--tight">
          <h1 className="intro-h2">{L(`O que ${name} faz por você`, `What ${name} does for you`)}</h1>
          <ul className="intro-card intro-card--list intro-does">
            {goal.does.map((d) => (
              <li key={d} className="intro-row">
                <span className="intro-tick" aria-hidden>
                  <Icon name="check" size={16} />
                </span>
                {d}
              </li>
            ))}
          </ul>
          <AutonomyPick name={name} value={autonomyChosen(agent.autonomy, settingsLevel)} guard={guard} onPick={(level) => p.patch({ autonomy: storedAutonomy(level, settingsLevel) })} />
          {goal.connector && (
            <div className="intro-offer">
              {offered ? <CatalogLogo entry={offered} size={22} /> : <Icon name="plug" size={17} />}
              <span>
                {goal.connector.label} <span className="intro-muted">· {connected ? L('conectado, só leitura pra começar', 'connected, read-only to start') : L('opcional', 'optional')}</span>
              </span>
              {!connected && (
                <button className="intro-link" onClick={() => setConnecting(true)}>
                  {L('Conectar', 'Connect')}
                </button>
              )}
            </div>
          )}
          {p.error && (
            <p className="intro-note intro-note--bad" role="alert">
              {p.error}
            </p>
          )}
          <div className="intro-actions">
            <button className="intro-btn" disabled={p.busy || !agent.name.trim() || !modelInfo(agent.modelId)?.id} onClick={p.onCall}>
              {L(`Chamar ${name} pro time`, `Bring ${name} to the team`)}
            </button>
            <button className="intro-link" onClick={p.onAdjust}>
              {L('Ajustar com o Tuca', 'Adjust with Tuca')}
            </button>
          </div>
        </div>
      </section>
      {connecting && goal.connector && (
        <Modal title={L('Conectar uma conta', 'Connect an account')} className="intro-connect" onClose={() => setConnecting(false)}>
          <ConnectorGrid status={STATUS()} query={goal.connector.id.startsWith('google-') ? `Google ${goal.connector.id.slice(7)}` : goal.connector.id} onManage={() => setConnecting(false)} />
        </Modal>
      )}
    </div>
  )
}

// "Ajustar com o Tuca": a talk with him about this agent; his card brings the new version back here.
function Adjust({ agent, goal, onUse, onBack }: { agent: Agent; goal: Goal; onUse: (d: AgentDraft) => void; onBack: () => void }): ReactNode {
  const tuca = useStore((s) => s.agents.find((a) => a.kind === 'tuca'))
  const [conv, setConv] = useState<string | null>(null)
  const [error, setError] = useState('')
  const messages = useStore((s) => (conv ? messagesIn(s, conv) : []))
  useEffect(() => {
    // The person's conversation with him, where it was (going back and coming here again keeps it).
    void ensureTuca(agent.modelId).then(
      (r) => {
        // What he's adjusting, written for the person to finish and send (unless they're typing something).
        if (!composerDraft(r.conversationId).trim()) setComposerDraft(r.conversationId, L(`Quero ajustar ${agent.name} antes de chamar pro time. Hoje: ${goal.tagline.toLowerCase()}. Quero que `, `I want to adjust ${agent.name} before bringing it to the team. Right now it ${goal.tagline.charAt(0).toLowerCase()}${goal.tagline.slice(1)}. I want it to `))
        setConv(r.conversationId)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <section className="intro__full">
      <Top at={3} onBack={onBack} />
      <div className="intro__center intro__center--chat">
        <h1 className="intro-h2">{L(`Ajustar ${agent.name} com o Tuca`, `Adjust ${agent.name} with Tuca`)}</h1>
        <p className="intro-lead intro-lead--sm">{L('Diga o que quer diferente. Ele propõe uma versão nova, e você usa se gostar.', 'Say what you want different. He proposes a new version, and you use it if you like it.')}</p>
        <div className="intro-chat">
          {conv && tuca ? (
            <UseDraft.Provider value={(d) => onUse(d)}>
              <MessageList messages={messages} conversationId={conv} />
              <Composer conversationId={conv} members={[tuca]} placeholder={L('Escreva pro Tuca', 'Write to Tuca')} />
            </UseDraft.Provider>
          ) : (
            <p className="intro-wait" role="status">
              {error || (
                <>
                  <Spinner /> {L('Chamando o Tuca…', 'Calling Tuca…')}
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

// ---------- someone invited to a team ----------

const ABOUT = (): string[] => [L('Atendimento', 'Support'), L('Vendas', 'Sales'), 'Marketing', L('Financeiro', 'Finance')]

export function GuestWelcome(): ReactNode {
  const settings = useStore((s) => s.settings)
  const people = useStore((s) => s.people)
  const you = useStore((s) => s.you)
  const agents = useStore((s) => s.agents.filter(isTeam))
  const me = people.find((p) => p.id === you)
  const owner = people.find((p) => p.role === 'owner')
  const by = settings.onboarding?.guest?.by ?? owner?.name ?? ''
  const team = settings.workspaceLabel?.trim() || (owner ? L(`O time de ${owner.name}`, `${owner.name}’s team`) : L('O time', 'The team'))
  const others = people.filter((p) => p.id !== you)
  const [name, setName] = useState(me?.name ?? '')
  const [about, setAbout] = useState(me?.about ?? '')
  const [other, setOther] = useState(!!me?.about && !ABOUT().includes(me.about))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function enter(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      if (name.trim() !== me?.name || about.trim() !== (me?.about ?? '')) await setMyName(name.trim(), about.trim())
      // The first message's mark is the introduction's: someone invited starts the tour at the first request.
      updateSettings({ onboarding: { done: true, tour: { done: ['first'] } } })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="intro">
      <div className="intro__drag" />
      <div className="intro__stage">
        <div className="intro__split">
          <div className="intro-art intro-art--ink">
            <span className="intro-blob intro-blob--ember" aria-hidden />
            <span className="intro-invited">
              {by && <MeAvatar initials={initials(by)} size={32} />}
              {by ? L(`${by} te chamou pro time`, `${by} invited you to the team`) : L('Você foi chamado pro time', 'You were invited to the team')}
            </span>
            <h1 className="intro-h1 intro-h1--team">{team}</h1>
            {agents.length > 0 && (
              <div className="intro-team">
                <span className="intro-kicker">{L('O TIME', 'THE TEAM')}</span>
                {agents.slice(0, 4).map((a) => (
                  <div key={a.id} className="intro-team__row">
                    <AgentAvatar agent={a} size={44} />
                    <span>
                      <b>{a.name}</b>
                      <br />
                      <span>{a.role}</span>
                    </span>
                  </div>
                ))}
                {agents.length > 4 && <span className="intro-team__more">{L(`e mais ${agents.length - 4}`, `and ${agents.length - 4} more`)}</span>}
              </div>
            )}
            <span className="grow" />
            {others.length > 0 && (
              <div className="intro-people">
                <span className="intro-people__faces" aria-hidden>
                  {others.slice(0, 3).map((p) => (
                    <MeAvatar key={p.id} initials={initials(p.name)} size={30} />
                  ))}
                </span>
                {others.length === 1 ? L(`${others[0]!.name} já está aqui`, `${others[0]!.name} is already here`) : L(`${list(others.map((p) => p.name)).replace(/, ([^,]*)$/, ' e $1')} já estão aqui`, `${list(others.map((p) => p.name)).replace(/, ([^,]*)$/, ' and $1')} are already here`)}
              </div>
            )}
          </div>
          <section className="intro__main">
            <div className="intro__top">
              <span />
              <LangToggle />
            </div>
            <div className="intro__center intro__center--tight">
              <h2 className="intro-h2">
                <label htmlFor="guest-name">{L('Como te chamam?', 'What do people call you?')}</label>
              </h2>
              <input id="guest-name" className="intro-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              <div className="intro-about" role="group" aria-labelledby="guest-about">
                <span id="guest-about" className="intro-label">
                  {L('O que você faz no time?', 'What do you do on the team?')} <span className="intro-muted">{L('(opcional)', '(optional)')}</span>
                </span>
                <div className="intro-chips">
                  {ABOUT().map((a) => (
                    <button key={a} className={`intro-chipbtn ${!other && about === a ? 'is-on' : ''}`} aria-pressed={!other && about === a} onClick={() => (setOther(false), setAbout(about === a ? '' : a))}>
                      {a}
                    </button>
                  ))}
                  <button className={`intro-chipbtn ${other ? 'is-on' : ''}`} aria-pressed={other} onClick={() => (setOther(!other), setAbout(''))}>
                    {L('Outro…', 'Other…')}
                  </button>
                </div>
                {other && <input className="intro-input intro-input--sm" autoFocus aria-label={L('O que você faz', 'What you do')} value={about} maxLength={120} placeholder={L('Ex.: cuido das compras', 'E.g. I handle purchasing')} onChange={(e) => setAbout(e.target.value)} />}
              </div>
              <div className="intro-deal">
                <b>{L('O combinado', 'The deal')}</b>
                <span>{owner && owner.id !== you ? L(`O que você fala direto com um agente só você lê. Nem ${owner.name}.`, `What you say directly to an agent only you read. Not even ${owner.name}.`) : L('O que você fala direto com um agente só você lê.', 'What you say directly to an agent only you read.')}</span>
                <span>{L('Nos canais, o time todo vê.', 'In channels, the whole team sees.')}</span>
                <span>{L('Os agentes pedem o ok de quem decide antes do que o time combinou.', 'Agents ask whoever decides before what the team agreed on.')}</span>
              </div>
              {error && (
                <p className="intro-note intro-note--bad" role="alert">
                  {error}
                </p>
              )}
              <div className="intro-actions">
                <button className="intro-btn" disabled={busy || !name.trim()} onClick={() => void enter()}>
                  {L('Entrar no time', 'Join the team')}
                </button>
                <span className="intro-muted">{L('Depois, um tour de 1 minuto', 'Then a 1-minute tour')}</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

// Whether this window shows someone's invited welcome: theirs, once, and never the owner's.
export const guestWelcome = (s: ReturnType<typeof getState>): boolean => s.ready && !!s.settings.onboarding?.guest && !amOwner(s)
