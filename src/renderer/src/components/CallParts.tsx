// Calls, the two pieces that live outside the number's screen: the agent's voice (its profile page) and
// the call inside a conversation (the live line, then the card). Rows come from the core and may be old
// or partial, so every field is read as if it could be missing.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { VOICE_PROVIDERS, type CallCard, type VoiceChoice, type VoiceOption } from '../../../shared/calls'
import { call } from '../rpc'
import { navigate, toast, useStore, type Agent } from '../store'
import { Card } from './Pages'
import { Icon, time } from './ui'
import { errText } from './WhatsAppParts'

const VOICES_SHOWN = 30 // the list scrolls inside its own box
const SEARCH_MS = 350
const SAID_MAX = 80

// ---------- the agent's voice ----------

type Note = { ok: boolean; text: string }

export function VoiceSection({ agent }: { agent: Agent }): ReactNode {
  const service = VOICE_PROVIDERS.elevenlabs
  // Whether the voice service's connector is connected, as the connector list says.
  const connected = useStore((s) => s.connectors.find((c) => c.url?.includes(service.connector))?.status === 'connected')
  const [choice, setChoice] = useState<VoiceChoice | null | undefined>(undefined)
  const [open, setOpen] = useState(false) // the list of voices shows only while one is being picked
  const [q, setQ] = useState('')
  const [voices, setVoices] = useState<VoiceOption[] | null>(null)
  const [voicesError, setVoicesError] = useState('')
  const [retry, setRetry] = useState(0)
  const [busy, setBusy] = useState('')
  const [note, setNote] = useState<Note | null>(null)
  const [playing, setPlaying] = useState<string | null>(null)
  const alive = useRef(true)
  const audio = useRef<HTMLAudioElement | null>(null)
  const seq = useRef(0)
  const name = agent.name || L('O agente', 'The agent')

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      audio.current?.pause()
      audio.current = null
    }
  }, [])

  // The voice this agent has now. A read that fails leaves it as "no voice yet", with the reason under it.
  useEffect(() => {
    let current = true
    setChoice(undefined)
    setNote(null)
    setOpen(false)
    setQ('')
    call('callsVoice', { agentId: agent.id })
      .then((v) => current && setChoice(v ?? null))
      .catch((e: unknown) => {
        if (!current) return
        setChoice(null)
        setNote({ ok: false, text: errText(e) })
      })
    return () => {
      current = false
    }
  }, [agent.id])

  // The search waits for a pause in typing; of two answers, the one asked last wins.
  useEffect(() => {
    const mine = ++seq.current
    setVoicesError('')
    setVoices(null)
    if (!open) return
    const timer = setTimeout(
      () => {
        call('callsVoices', q.trim() ? { q: q.trim() } : {})
          .then((list) => {
            if (!alive.current || mine !== seq.current) return
            setVoices(Array.isArray(list) ? list : [])
          })
          .catch((e: unknown) => {
            if (!alive.current || mine !== seq.current) return
            setVoices(null)
            setVoicesError(errText(e))
          })
      },
      q.trim() ? SEARCH_MS : 0
    )
    return () => clearTimeout(timer)
  }, [q, connected, retry, open])

  // One sample at a time: starting another stops the one playing.
  const play = (v: VoiceOption): void => {
    if (!v.preview) return
    setNote(null)
    const cur = audio.current
    if (playing === v.voiceId && cur) {
      cur.pause()
      setPlaying(null)
      return
    }
    cur?.pause()
    const next = new Audio(v.preview)
    audio.current = next
    const stop = (failed: boolean): void => {
      if (audio.current !== next || !alive.current) return
      setPlaying(null)
      if (failed) setNote({ ok: false, text: L('Não consegui tocar esta amostra.', 'I couldn’t play this sample.') })
    }
    next.onended = () => stop(false)
    next.onerror = () => stop(true)
    setPlaying(v.voiceId)
    next.play().catch(() => stop(true))
  }

  const choose = async (v: VoiceOption | null): Promise<void> => {
    setBusy(v?.voiceId ?? 'clear')
    setNote(null)
    try {
      const voice: VoiceChoice | null = v ? { provider: 'elevenlabs', voiceId: v.voiceId, name: v.name } : null
      await call('callsSetVoice', { agentId: agent.id, voice })
      if (!alive.current) return
      setChoice(voice)
      setOpen(false)
      setQ('')
      audio.current?.pause()
      setPlaying(null)
      toast(v ? L(`Pronto: ${name} atende com a voz ${v.name}.`, `Done: ${name} answers with the voice ${v.name}.`) : L('Voz tirada.', 'Voice removed.'))
    } catch (e) {
      if (alive.current) setNote({ ok: false, text: errText(e) })
    } finally {
      if (alive.current) setBusy('')
    }
  }

  const lead = L(`Como ${name} soa em uma ligação. O que diz vem das instruções do agente.`, `How ${name} sounds on a call. What it says comes from the agent’s instructions.`)
  const title = L('Voz', 'Voice')

  // No voice service: the chosen voice still shows; only the search and the list give way to the core's sentence.
  const offline = Boolean(voicesError) && !connected
  const list = (voices ?? []).filter((v) => v && typeof v.voiceId === 'string' && v.voiceId && typeof v.name === 'string').slice(0, VOICES_SHOWN)
  const loading = voices === null && !voicesError
  // "Bella - Professional, Bright, Warm": the name, and what comes after it as a quieter line.
  const parts = (full: string): [string, string] => {
    const at = full.indexOf(' - ')
    return at > 0 ? [full.slice(0, at), full.slice(at + 3)] : [full, '']
  }
  const close = (): void => {
    setOpen(false)
    setQ('')
    audio.current?.pause()
    setPlaying(null)
  }
  const [chosenName, chosenStyle] = parts(choice?.name ?? '')
  return (
    <Card title={title} lead={lead}>
      {choice === undefined ? (
        <div className="wa-skeleton wa-skeleton--line" aria-hidden />
      ) : (
        <div className={`wa-voice wa-voice--now ${choice ? 'is-on' : ''}`}>
          <span className="wa-voice__play wa-voice__play--none" aria-hidden><Icon name="volume" size={15} /></span>
          <div className="grow">
            {choice ? (
              <>
                <strong>{chosenName}</strong> {chosenStyle && <span className="muted small">{chosenStyle}</span>}
              </>
            ) : (
              <span className="muted small">{L('Sem voz escolhida: atende com a voz padrão.', 'No voice chosen: it answers with the default voice.')}</span>
            )}
          </div>
          {choice && !open && (
            <button className="btn btn--sm btn--ghost" disabled={busy !== ''} onClick={() => void choose(null)}>
              {busy === 'clear' ? L('Tirando…', 'Removing…') : L('Tirar', 'Remove')}
            </button>
          )}
          <button className="btn btn--sm" aria-expanded={open} disabled={busy !== ''} onClick={() => (open ? close() : setOpen(true))}>
            {open ? L('Fechar', 'Close') : choice ? L('Trocar', 'Change') : L('Escolher voz', 'Choose a voice')}
          </button>
        </div>
      )}

      {open &&
        (offline ? (
          <div className="wa-voice__offline">
            <p className="muted small wa-voice__text">{voicesError}</p>
            <button className="btn btn--primary btn--sm" onClick={() => navigate({ kind: 'connectors' })}>{L('Conectar', 'Connect')}</button>
          </div>
        ) : (
          <div className="wa-voice__picker">
            <label className="wa-voice__search">
              <Icon name="search" size={14} />
              <input autoFocus value={q} maxLength={60} placeholder={L('Buscar uma voz pelo nome', 'Search a voice by name')} aria-label={L('Buscar uma voz pelo nome', 'Search a voice by name')} onChange={(e) => setQ(e.target.value)} />
            </label>
            {voicesError ? (
              <div className="note note--error" role="alert">
                <p>{voicesError}</p>
                <button className="btn btn--sm" onClick={() => setRetry((r) => r + 1)}>{L('Tentar de novo', 'Try again')}</button>
              </div>
            ) : loading ? (
              <div className="wa-voice__list" aria-hidden>
                <div className="wa-skeleton wa-skeleton--line" />
                <div className="wa-skeleton wa-skeleton--line" />
                <div className="wa-skeleton wa-skeleton--line" />
              </div>
            ) : list.length === 0 ? (
              <p className="muted small wa-voice__text">{q.trim() ? L('Nenhuma voz com esse nome.', 'No voice with that name.') : L('O serviço de voz não trouxe nenhuma voz.', 'The voice service brought no voices.')}</p>
            ) : (
              <ul className="wa-voice__list">
                {list.map((v) => {
                  const on = choice?.voiceId === v.voiceId
                  const going = playing === v.voiceId
                  const label = going ? L(`Parar a amostra de ${v.name}`, `Stop ${v.name}’s sample`) : L(`Ouvir a voz ${v.name}`, `Listen to the voice ${v.name}`)
                  const [head, style] = parts(v.name)
                  return (
                    <li key={v.voiceId} className={`wa-voice__row ${on ? 'is-on' : ''}`}>
                      {v.preview ? (
                        <button className="icon-btn wa-voice__play" title={label} aria-label={label} aria-pressed={going} onClick={() => play(v)}>
                          <Icon name={going ? 'pause' : 'play'} size={13} />
                        </button>
                      ) : (
                        <span className="wa-voice__play wa-voice__play--none" aria-hidden />
                      )}
                      <div className="grow">
                        <strong>{head}</strong> <span className="muted small">{[style, v.description].filter(Boolean).join(' · ')}</span>
                      </div>
                      {on ? (
                        <span className="tag tag--agent">{L('Escolhida', 'Chosen')}</span>
                      ) : (
                        <button className="btn btn--sm btn--ghost" disabled={busy !== ''} onClick={() => void choose(v)}>
                          {busy === v.voiceId ? L('Escolhendo…', 'Choosing…') : L('Escolher', 'Choose')}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ))}
      {note && <p className={`hint wa-voice__note ${note.ok ? 'wa-voice__note--ok' : 'wa-voice__note--err'}`} role={note.ok ? 'status' : 'alert'}>{note.text}</p>}
    </Card>
  )
}

// ---------- a call in a conversation ----------

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const firstName = (full: string): string => full.split(/\s+/)[0] || full

const clock = (seconds: number): string => {
  // Past 99:59 the display stops: a call never gets there, and a wider number would break the line.
  const s = Math.min(seconds, 99 * 60 + 59)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

const spoken = (seconds: number): string => {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m === 0) return `${s} s`
  return s === 0 ? `${m} min` : `${m} min ${s} s`
}

// Seconds since the call began, ticking while it is on; undefined when the row has no usable start.
function useElapsed(startedAt: unknown, on: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return typeof startedAt === 'number' && Number.isFinite(startedAt) ? Math.max(0, Math.floor((now - startedAt) / 1000)) : undefined
}

export function CallMessage({ call: c }: { call: CallCard }): ReactNode {
  const state = str(c.state)
  const person = str(c.person) || L('alguém', 'someone')
  const where = str(c.numberName)
  const elapsed = useElapsed(c.startedAt, state === 'live')
  const at = typeof c.startedAt === 'number' && Number.isFinite(c.startedAt) ? time(c.startedAt) : ''

  if (state === 'live')
    return (
      <div className="wa-call-line wa-call-line--live">
        <span className="wa-call__live" aria-hidden />
        <p>
          <strong>{L('Em ligação', 'On a call')}</strong> {L('com', 'with')} {person}
          {elapsed !== undefined && <> · <span className="wa-call__clock">{clock(elapsed)}</span></>}
          {where && <span className="muted small"> · {where}</span>}
        </p>
      </div>
    )

  if (state === 'missed' || state === 'failed')
    return (
      <div className="wa-call-line wa-call-line--warn">
        <Icon name="phone" size={13} />
        <p>{state === 'missed' ? (c.direction === 'out' ? L(`${person} não atendeu.`, `${person} did not answer.`) : L(`Ligação de ${person} não atendida.`, `Call from ${person} was not answered.`)) : L(`A ligação com ${person} não chegou a começar.`, `The call with ${person} never started.`)}</p>
        {at && <span className="muted">{at}</span>}
      </div>
    )

  return <DoneCard c={c} person={person} where={where} at={at} />
}

function DoneCard({ c, person, where, at }: { c: CallCard; person: string; where: string; at: string }): ReactNode {
  const out = c.direction === 'out'
  const summary = str(c.summary)
  const note = str(c.note)
  const agreed = Array.isArray(c.agreed) ? c.agreed.map(str).filter(Boolean) : []
  const turns = (Array.isArray(c.turns) ? c.turns : []).filter((t) => t && typeof t.text === 'string' && t.text.trim())
  const length = typeof c.seconds === 'number' && Number.isFinite(c.seconds) && c.seconds > 0 ? spoken(c.seconds) : ''
  return (
    <div className="wa-call">
      <div className="wa-call__head">
        <Icon name="phone" size={15} />
        <strong>{out ? L('Ligação feita', 'Call made') : L('Ligação atendida', 'Call answered')}</strong>
        <span className="muted wa-call__person">{[person, length, where].filter(Boolean).join(' · ')}</span>
        {at && <span className="muted small wa-call__at">{at}</span>}
      </div>
      {(summary || agreed.length > 0 || note) && (
        <div className="wa-call__body">
          {summary && <p className="wa-call__summary">{summary}</p>}
          {agreed.length > 0 && (
            <div className="wa-call__agreed">
              <strong>{L('Ficou combinado', 'What was agreed')}</strong>
              <ul>
                {agreed.map((item, i) => (
                  <li key={i}>
                    <Icon name="check" size={13} />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {note && <p className="muted small wa-call__note">{note}</p>}
        </div>
      )}
      {turns.length > 0 && <Said turns={turns} person={person} />}
    </div>
  )
}

// "Ver o que foi dito": closed until asked, so a long call doesn't push the conversation away.
function Said({ turns, person }: { turns: NonNullable<CallCard['turns']>; person: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const id = useId()
  const who = firstName(person)
  // A very long call shows only its first lines.
  const more = turns.length - SAID_MAX
  return (
    <div className="wa-call__fold">
      <button type="button" className="wa-call__fold-btn" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevron" size={13} />
        {open ? L('Esconder o que foi dito', 'Hide what was said') : L('Ver o que foi dito', 'See what was said')}
      </button>
      {open && (
        <div id={id} className="wa-call__turns">
          {turns.slice(0, SAID_MAX).map((t, i) => (
            <div key={i} className={`wa-call__turn ${t.who === 'agent' ? 'wa-call__turn--agent' : ''}`}>
              <span>{t.who === 'agent' ? L('Agente', 'Agent') : who}</span>
              <div>{t.text}</div>
            </div>
          ))}
          {more > 0 && <p className="muted small">{L(`Mais ${more} falas não mostradas aqui.`, `${more} more lines not shown here.`)}</p>}
        </div>
      )}
    </div>
  )
}
