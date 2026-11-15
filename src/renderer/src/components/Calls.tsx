// The number's "Ligações" card: an agent answers whoever calls the number, with a voice service's voice.
// Every change saves as soon as it is made (one save after another); a failure goes back and says why.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { CALL_LIMITS, GREETING_MAX, VOICE_PROVIDERS, clampCallSettings, type CallHours, type CallSetupStep, type CallSettings, type CallsState } from '../../../shared/calls'
import type { WhatsAppNumber } from '../../../shared/whatsapp'
import { call } from '../rpc'
import { navigate, useStore, type Agent } from '../store'
import { confirmDialog } from './Dialogs'
import { Card, Toggle } from './Pages'
import { Select } from './Select'
import { AgentAvatar, Icon } from './ui'
import { DraftText, errText, LimitRow, phoneText } from './WhatsAppParts'

const STEPS: CallSetupStep[] = ['connector', 'attendant', 'number', 'done']

// This computer's time zone: the hours mean the person's clock, not the server's.
const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone
// "America/Sao_Paulo" shows as "Sao Paulo".
const cityOf = (zone: string): string => (zone.split('/').pop() ?? zone).replace(/_/g, ' ')

// Sunday first, like the days in the settings.
const dayNames = (): string[] => [L('Dom', 'Sun'), L('Seg', 'Mon'), L('Ter', 'Tue'), L('Qua', 'Wed'), L('Qui', 'Thu'), L('Sex', 'Fri'), L('Sáb', 'Sat')]

export function CallsCard({ n, agents }: { n: WhatsAppNumber; agents: Agent[] }): ReactNode {
  // Only the official API takes calls: no question is asked of the core for a QR number.
  if (n.kind === 'qr')
    return (
      <Card title={L('Ligações', 'Calls')}>
        <p className="muted small">{L('Ligações só existem em um número da API oficial. Este número foi ligado por QR code.', 'Calls only exist on a number of the official API. This number was linked by QR code.')}</p>
      </Card>
    )
  return <CallsBody n={n} agents={agents} />
}

function CallsBody({ n, agents }: { n: WhatsAppNumber; agents: Agent[] }): ReactNode {
  const rev = useStore((s) => s.whatsappRev)
  const team = useStore((s) => s.settings.workspaceName)
  const service = VOICE_PROVIDERS.elevenlabs
  // Whether the voice service's connector is there and connected right now, as the connector list says.
  const inStore = useStore((s) => s.connectors.find((c) => c.url?.includes(service.connector))?.status === 'connected')

  const [state, setState] = useState<CallsState | null>(null)
  const [readError, setReadError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<'' | 'enable' | 'disable'>('')
  const [saved, setSaved] = useState(false)
  const alive = useRef(true)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // The newest copy: every change starts from it, never from one captured earlier.
  const latest = useRef<CallsState | null>(null)
  const seq = useRef(0)
  const pending = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      clearTimeout(savedTimer.current)
    }
  }, [])

  const apply = (next: CallsState): void => {
    // Anything asked before this answer must not overwrite it.
    seq.current++
    latest.current = next
    setState(next)
    setReadError('')
  }

  // The latest answer wins. While a save is on its way the screen keeps what the person just changed.
  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const next = await call('callsState', { id: n.id })
      if (!alive.current || mine !== seq.current || pending.current > 0) return
      latest.current = next
      setState(next)
      setReadError('')
    } catch (e) {
      if (alive.current && mine === seq.current) setReadError(errText(e))
    }
  }, [n.id])
  useEffect(() => {
    void load()
  }, [rev, load, inStore])

  const save = (patch: Partial<CallSettings>): void => {
    const cur = latest.current
    if (!cur) return
    const merged = clampCallSettings({ ...cur.settings, ...patch })
    const diff: Record<string, unknown> = {}
    for (const k of Object.keys(merged) as (keyof CallSettings)[]) if (JSON.stringify(merged[k]) !== JSON.stringify(cur.settings[k])) diff[k] = merged[k]
    // Only what changed goes; nothing changed, nothing is sent.
    if (Object.keys(diff).length === 0) return
    const optimistic: CallsState = { ...cur, settings: merged }
    latest.current = optimistic
    setState(optimistic)
    setError('')
    pending.current++
    const run = async (): Promise<void> => {
      let failed = false
      try {
        const kept = await call('callsUpdate', { id: n.id, settings: diff as Partial<CallSettings> })
        // Only the last save in line shows the core's copy; an earlier one would hide the changes still waiting.
        if (pending.current === 1 && alive.current) apply(kept)
        if (alive.current) {
          setSaved(true)
          clearTimeout(savedTimer.current)
          savedTimer.current = setTimeout(() => setSaved(false), 1800)
        }
      } catch (e) {
        failed = true
        if (alive.current) setError(errText(e))
      } finally {
        pending.current--
      }
      if (failed && alive.current) void load()
    }
    queue.current = queue.current.then(run, run)
  }

  const enable = async (): Promise<void> => {
    setBusy('enable')
    setError('')
    try {
      const next = await call('callsEnable', { id: n.id })
      if (alive.current) apply(next)
    } catch (e) {
      if (alive.current) {
        setError(errText(e))
        void load()
      }
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const disable = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: L('Desligar as ligações?', 'Turn calls off?'),
      body: L('Quem ligar para este número deixa de ser atendido pelo agente. As ligações que já aconteceram continuam guardadas nas conversas.', 'Whoever calls this number is no longer answered by the agent. Calls that already happened stay saved in the conversations.'),
      confirm: L('Desligar as ligações', 'Turn calls off'),
      danger: true
    })
    if (!ok) return
    setBusy('disable')
    setError('')
    try {
      const next = await call('callsDisable', { id: n.id })
      if (alive.current) apply(next)
    } catch (e) {
      if (alive.current) {
        setError(errText(e))
        void load()
      }
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const title = L('Ligações', 'Calls')
  const lead = L('Um agente atende quem ligar para este número.', 'An agent answers whoever calls this number.')

  if (!state)
    return readError ? (
      <Card title={title} lead={lead}>
        <div className="note note--error" role="alert">
          <p>{readError}</p>
          <button className="btn btn--sm" onClick={() => void load()}>{L('Tentar de novo', 'Try again')}</button>
        </div>
      </Card>
    ) : (
      <Card title={title} lead={lead}>
        <div className="wa-skeleton" aria-hidden />
      </Card>
    )

  if (!state.available)
    return (
      <Card title={title} lead={lead}>
        <p className="muted small">{state.why || L('As ligações ainda não estão disponíveis para este número.', 'Calls aren’t available for this number yet.')}</p>
      </Card>
    )

  const s = state.settings
  const providerName = state.provider?.name ?? service.name
  // The core knows best; before it names the service, the connector list stands in.
  const connected = state.provider ? state.provider.connected : inStore
  // Someone else's turning-on shows here too: the core says which step it is at.
  const step = state.step
  const preparing = busy === 'enable' || step !== undefined
  const problem = preparing ? '' : (state.problem ?? '')

  // Agents that may answer: those allowed to read and reply on this number.
  const answerIds = [...new Set(n.access.filter((a) => a.level === 'reply').map((a) => a.agentId))]
  const answerers = answerIds.flatMap((id) => agents.filter((a) => a.id === id && !a.archived))
  const chosen = agents.find((a) => a.id === s.agentId)
  // Nobody answers unless one of those agents is chosen, whatever the switch says.
  const answering = answerers.some((a) => a.id === s.agentId)
  const attending = state.ready && answering
  const options = [...answerers, ...(chosen && !answerers.some((a) => a.id === chosen.id) ? [chosen] : [])].map((a) => ({ value: a.id, label: a.role ? `${a.name} · ${a.role}` : a.name }))

  const connectNow = (): void => navigate({ kind: 'connectors' })
  // Off with a problem left behind, "Got it" only reads the state again. On and not ready, it tries turning on.
  const retry = (): void => void (s.enabled && !state.ready ? enable() : load())
  const retryLabel = s.enabled ? L('Tentar de novo', 'Try again') : L('Entendi', 'Got it')

  const tag = preparing ? (
    <span className="tag tag--warn">{L('Preparando', 'Getting ready')}</span>
  ) : s.enabled && attending ? (
    <span className="tag tag--ok">{L('Atendendo', 'Answering')}</span>
  ) : s.enabled ? (
    <span className="tag tag--warn">{L('Precisa de atenção', 'Needs attention')}</span>
  ) : !connected ? (
    <span className="tag">{L('Sem serviço de voz', 'No voice service')}</span>
  ) : (
    <span className="tag">{L('Desligadas', 'Off')}</span>
  )
  const action = (
    <span className="row wa-call__tags">
      {saved && <span className="tag tag--ok wa-saved" role="status"><Icon name="check" size={11} />{L('Salvo', 'Saved')}</span>}
      {tag}
    </span>
  )

  const problemBlock = problem && (
    <div className="note note--error wa-call__problem" role="alert">
      <p>{problem}</p>
      <button className="btn btn--sm" disabled={busy !== ''} onClick={retry}>{retryLabel}</button>
    </div>
  )
  const errorLine = error && <p className="note note--error" role="alert">{error}</p>
  // Calls are on, but nobody answers, or the setup was left unfinished: say what to do, in one line.
  const setupWarn = !answering ? (
    <div className="hint hint--warn wa-call__warn">
      <Icon name="user" size={13} />
      <span className="grow">{L('Ninguém está atendendo: escolha um agente abaixo.', 'Nobody is answering: choose an agent below.')}</span>
    </div>
  ) : !state.ready ? (
    <div className="hint hint--warn wa-call__warn">
      <Icon name="shield" size={13} />
      <span className="grow">{L('As ligações estão ligadas aqui, mas faltou terminar a preparação.', 'Calls are on here, but the setup was not finished.')}</span>
      <button className="btn btn--primary btn--sm" disabled={busy !== ''} onClick={() => void enable()}>{L('Terminar de ligar', 'Finish turning on')}</button>
    </div>
  ) : null

  // (c) no voice service connected, and nothing prepared yet: one row, one button.
  if (!connected && !state.ready && !preparing)
    return (
      <Card title={title} lead={L('Um agente atende quem ligar para este número. Para isso o Tucano precisa de um serviço de voz.', 'An agent answers whoever calls this number. For that, Tucano needs a voice service.')} action={action}>
        {problemBlock}
        {errorLine}
        <div className="wa-call__service">
          <span className="wa-who">{providerName.slice(0, 2)}</span>
          <div className="grow">
            <strong>{providerName}</strong> <span className="muted small">{L('voz e transcrição · gasta créditos', 'voice and transcription · uses credits')}</span>
          </div>
          <button className="btn btn--primary btn--sm" onClick={connectNow}>{L('Conectar', 'Connect')}</button>
        </div>
        <p className="hint">
          <Icon name="shield" size={13} />
          {L(`Abre os conectores. Você entra com a sua conta do ${providerName}, uma vez.`, `Opens the connectors. You sign in with your ${providerName} account, once.`)}
        </p>
      </Card>
    )

  // (d) the service is connected and calls are off: one button, then the steps one by one.
  if (!s.enabled || preparing)
    return (
      <Card title={title} lead={L('Um agente atende quem ligar para este número. O Tucano prepara tudo e mostra cada passo.', 'An agent answers whoever calls this number. Tucano gets everything ready and shows each step.')} action={action}>
        {problemBlock}
        {errorLine}
        <div className="row wa-wrap wa-call__start">
          <span className="muted small">{L('Serviço de voz', 'Voice service')}: <strong>{providerName}</strong></span>
          <span className="grow" />
          <button className="btn btn--primary" disabled={busy !== '' || answerers.length === 0} onClick={() => void enable()}>
            {preparing ? L('Ligando…', 'Turning on…') : L('Ligar as ligações', 'Turn calls on')}
          </button>
        </div>
        {answerers.length === 0 && !preparing && (
          <p className="hint hint--warn">
            <Icon name="user" size={13} />
            {L('Antes, libere uma conversa para um agente com “Ler e responder”, em “Quem pode usar”. É ele quem vai atender.', 'First, allow a conversation for an agent with “Read and reply”, under “Who can use it”. It is the one who will answer.')}
          </p>
        )}
        {preparing && <Steps step={step} providerName={providerName} />}
      </Card>
    )

  // (e) and (f): calls are on.
  const hours = s.hours
  const withNumber = n.phone ? L(`Quem ligar para ${phoneText(n.phone)} fala com`, `Whoever calls ${phoneText(n.phone)} talks to`) : L('Quem ligar fala com', 'Whoever calls talks to')
  const greetingFor = chosen?.name ?? L('o agente', 'the agent')
  const hoursOn = (on: boolean): void => {
    if (on && !(hours.from < hours.to)) return setError(L('Antes de ligar o horário, deixe a hora de começar antes da hora de terminar.', 'Before turning the hours on, make the start time earlier than the end time.'))
    save({ hours: { ...hours, on, tz: browserZone() } })
  }
  const limit = (field: 'minutesPerDay' | 'minutesPerCall', v: number): number => {
    const patch: Partial<CallSettings> = field === 'minutesPerDay' ? { minutesPerDay: v } : { minutesPerCall: v }
    save(patch)
    return clampCallSettings({ ...s, ...patch })[field]
  }
  return (
    <Card title={title} lead={chosen ? `${withNumber} ${chosen.name}.` : lead} action={action}>
      {problemBlock}
      {errorLine}
      {setupWarn}
      {!connected && (
        <div className="hint hint--warn wa-call__warn">
          <Icon name="shield" size={13} />
          <span className="grow">{attending ? L(`O ${providerName} está desconectado. As ligações continuam sendo atendidas, mas para trocar quem atende ou a voz é preciso conectar de novo.`, `${providerName} is disconnected. Calls keep being answered, but to change who answers or the voice you need to connect again.`) : L(`O ${providerName} está desconectado. Conecte de novo para as ligações voltarem a funcionar.`, `${providerName} is disconnected. Connect it again for the calls to work.`)}</span>
          <button className="btn btn--primary btn--sm" onClick={connectNow}>{L('Conectar', 'Connect')}</button>
        </div>
      )}

      <div className="field">
        <span className="field__label">{L('Quem atende', 'Who answers')}</span>
        {options.length === 0 ? (
          <p className="hint hint--text">{L('Nenhum agente pode atender ainda. Abra uma conversa para um agente com “Ler e responder”, em “Quem pode usar”.', 'No agent can answer yet. Open a conversation to an agent with “Read and reply”, under “Who can use it”.')}</p>
        ) : (
          <div className="wa-call__who">
            {chosen && <AgentAvatar agent={chosen} size={28} still />}
            <div className="wa-call__select">
              <Select aria-label={L('Quem atende', 'Who answers')} value={s.agentId ?? null} placeholder={L('Escolha quem atende', 'Pick who answers')} disabled={busy !== ''} options={options} onChange={(v) => v && save({ agentId: v })} />
            </div>
          </div>
        )}
        <span className="hint">{L('Atende com o objetivo e o comportamento que o agente já tem. Na ligação ele só consulta e anota; o que combinar, faz depois por mensagem.', 'Answers with the goal and behaviour the agent already has. On the call it only looks things up and takes notes; what it agrees to, it does afterwards by message.')}</span>
      </div>

      <label className="field">
        <span className="field__label">{L('Como atende (a primeira frase)', 'How it answers (the first sentence)')}</span>
        <DraftText
          label={L('A primeira frase da ligação', 'The first sentence of the call')}
          value={s.greeting}
          maxLength={GREETING_MAX}
          placeholder={team ? L(`Olá, aqui é ${greetingFor}, assistente virtual de ${team}. Como posso ajudar?`, `Hi, this is ${greetingFor}, virtual assistant at ${team}. How can I help?`) : L(`Olá, aqui é ${greetingFor}, assistente virtual. Como posso ajudar?`, `Hi, this is ${greetingFor}, virtual assistant. How can I help?`)}
          onCommit={(greeting) => save({ greeting })}
        />
        <span className="hint">{L('Deixe vazio para usar a frase de sempre.', 'Leave it empty to use the usual sentence.')}</span>
      </label>

      <div className="wa-toggles">
        <div className="key-row" role="group" aria-labelledby="wa-call-hours-title">
          <div className="grow">
            <strong id="wa-call-hours-title">{L('Só atender no horário', 'Only answer during set hours')}</strong>
            <p className="muted small">{L('Fora do horário a ligação não é atendida: o WhatsApp mostra o número como fechado.', 'Outside the hours the call isn’t answered: WhatsApp shows the number as closed.')}</p>
          </div>
          <Toggle on={hours.on} onChange={hoursOn} />
        </div>
        {hours.on && <Hours hours={hours} onSave={(h) => save({ hours: h })} />}
        <div className="key-row" role="group" aria-labelledby="wa-call-out-title">
          <div className="grow">
            <strong id="wa-call-out-title">{L('Agentes podem ligar para as pessoas', 'Agents can call people')}</strong>
            <p className="muted small">{L('Sempre com a sua aprovação, e só depois que a pessoa aceitar receber ligações.', 'Always with your approval, and only after the person accepts receiving calls.')}</p>
          </div>
          <Toggle on={s.outbound} onChange={(outbound) => save({ outbound })} />
        </div>
      </div>

      <h3 className="wa-call__sub">{L('Limites', 'Limits')}</h3>
      <p className="muted small wa-call__subtext">{L('Minutos de voz custam. O Tucano para de atender quando o limite do dia acaba.', 'Voice minutes cost money. Tucano stops answering when the day’s limit is used up.')}</p>
      <p className="muted small wa-call__subtext">{L(`Cada minuto de ligação gasta créditos do ${providerName}.`, `Each minute of a call uses ${providerName} credits.`)}</p>
      <div className="wa-quotas">
        <LimitRow
          label={L('Minutos por dia', 'Minutes per day')}
          value={s.minutesPerDay}
          onCommit={(v) => limit('minutesPerDay', v)}
          used={state.usedToday}
          caption={L(`Hoje: ${state.usedToday} de ${s.minutesPerDay} min · máximo ${CALL_LIMITS.minutesPerDayMax.toLocaleString()}`, `Today: ${state.usedToday} of ${s.minutesPerDay} min · at most ${CALL_LIMITS.minutesPerDayMax.toLocaleString()}`)}
        />
        <LimitRow
          label={L('Minutos por ligação', 'Minutes per call')}
          value={s.minutesPerCall}
          onCommit={(v) => limit('minutesPerCall', v)}
          caption={L(`A ligação termina sozinha nesse tempo · máximo ${CALL_LIMITS.minutesPerCallMax}`, `The call ends by itself at this time · at most ${CALL_LIMITS.minutesPerCallMax}`)}
        />
      </div>

      <div className="wa-call__off">
        <button className="btn btn--danger" disabled={busy !== ''} onClick={() => void disable()}>
          {busy === 'disable' ? L('Desligando…', 'Turning off…') : L('Desligar as ligações', 'Turn calls off')}
        </button>
      </div>
    </Card>
  )
}

// The steps of turning calls on: done, the one in progress, and the ones still to come.
function Steps({ step, providerName }: { step?: CallSetupStep; providerName: string }): ReactNode {
  // Until the core says where it is, the first step is the one in progress.
  const at = Math.max(0, step ? STEPS.indexOf(step) : 0)
  const labels: Record<CallSetupStep, string> = {
    connector: L(`Conferindo a conexão com o ${providerName}`, `Checking the connection with ${providerName}`),
    attendant: L('Criando o atendente de voz', 'Creating the voice attendant'),
    number: L('Apontando as ligações deste número para ele', 'Pointing this number’s calls to it'),
    done: L('Tudo pronto para atender', 'All set to answer')
  }
  return (
    <ul className="wa-call__steps" role="status" aria-live="polite">
      {STEPS.map((id, i) => {
        // "done" is a result, not work: it shows a check only once it is reached.
        const state = i < at || (id === 'done' && i === at) ? 'ok' : i === at ? 'now' : 'wait'
        return (
          <li key={id} className={`wa-call__step wa-call__step--${state}`}>
            <span className="wa-call__mark" aria-hidden>
              {state === 'ok' ? <Icon name="check" size={12} /> : state === 'now' ? <span className="spinner" /> : <span className="wa-call__dot" />}
            </span>
            <span>{labels[id]}</span>
          </li>
        )
      })}
    </ul>
  )
}

// Days and times. The times are kept as typed until they make sense (start before end), then saved.
function Hours({ hours, onSave }: { hours: CallHours; onSave: (h: CallHours) => void }): ReactNode {
  const [from, setFrom] = useState(hours.from)
  const [to, setTo] = useState(hours.to)
  const [warn, setWarn] = useState('')
  const zone = cityOf(hours.tz ?? browserZone())
  useEffect(() => {
    setFrom(hours.from)
    setTo(hours.to)
  }, [hours.from, hours.to])
  const day = (d: number): void => {
    const has = hours.days.includes(d)
    if (has && hours.days.length === 1) return setWarn(L('Deixe pelo menos um dia marcado.', 'Keep at least one day selected.'))
    setWarn('')
    onSave({ ...hours, days: has ? hours.days.filter((x) => x !== d) : [...hours.days, d].sort(), tz: browserZone() })
  }
  const time = (which: 'from' | 'to', v: string): void => {
    const nextFrom = which === 'from' ? v : from
    const nextTo = which === 'to' ? v : to
    if (which === 'from') setFrom(v)
    else setTo(v)
    if (!nextFrom || !nextTo || nextFrom >= nextTo) return setWarn(L('A hora de começar precisa ser antes da hora de terminar.', 'The start time needs to be before the end time.'))
    setWarn('')
    onSave({ ...hours, from: nextFrom, to: nextTo, tz: browserZone() })
  }
  return (
    <div className="wa-call__hours">
      <div className="wa-chips" role="group" aria-label={L('Dias em que atende', 'Days it answers')}>
        {dayNames().map((name, d) => (
          <button key={d} type="button" className={`chip ${hours.days.includes(d) ? 'is-on' : ''}`} aria-pressed={hours.days.includes(d)} onClick={() => day(d)}>
            {name}
          </button>
        ))}
      </div>
      <div className="row wa-wrap wa-call__times">
        <label className="row wa-call__time">
          <span className="muted small">{L('Das', 'From')}</span>
          <input type="time" value={from} aria-label={L('Hora de começar', 'Start time')} aria-invalid={!!warn || undefined} onChange={(e) => time('from', e.target.value)} />
        </label>
        <label className="row wa-call__time">
          <span className="muted small">{L('às', 'to')}</span>
          <input type="time" value={to} aria-label={L('Hora de terminar', 'End time')} aria-invalid={!!warn || undefined} onChange={(e) => time('to', e.target.value)} />
        </label>
      </div>
      <span className="muted small">{L(`No horário de ${zone}.`, `In ${zone} time.`)}</span>
      {warn && <span className="field__error" role="alert">{warn}</span>}
    </div>
  )
}
