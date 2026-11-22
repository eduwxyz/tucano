// "Enviar feedback" (the dialog, opened from the sidebar's foot and from Settings) and the small survey
// line above the foot. Both go through the core to tucano.sh (src/core/feedback.ts): the page never
// talks to it. The window's picture is taken by the desktop before the dialog opens over it.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L, lang } from '../../../shared/lang'
import type { SurveyView } from '../../../shared/rpc'
import type { FeedbackDraft, Message } from '../../../shared/types'
import { amOwner, openDialog, toast, useStore, windowless } from '../store'
import { call } from '../rpc'
import { Modal } from './Modal'
import { useUpdate } from './Update'
import { Icon } from './ui'

export type Shot = { type: 'image/png' | 'image/jpeg'; data: string }
type Kind = 'bug' | 'idea' | 'other'

const KINDS: { kind: Kind; label: () => string; ask: () => string }[] = [
  { kind: 'bug', label: () => L('Algo deu errado', 'Something went wrong'), ask: () => L('O que aconteceu?', 'What happened?') },
  { kind: 'idea', label: () => L('Uma ideia', 'An idea'), ask: () => L('Qual é a ideia?', "What's the idea?") },
  { kind: 'other', label: () => L('Outra coisa', 'Something else'), ask: () => L('O que você quer contar?', 'What would you like to tell us?') }
]

const SYSTEMS = { mac: 'macOS', windows: 'Windows', linux: 'Linux' } as const

// The picture first (the window as the person sees it), then the dialog over it. In a browser there's
// no picture to take: the dialog opens without the option. The picture waits two frames, so a menu or
// a popover the click just closed is off the screen and out of it.
// draft: what the Tuca wrote (propor_feedback), from his message `from`: the window opens with it, to review.
export async function openFeedback(draft?: FeedbackDraft, from?: string): Promise<void> {
  if (typeof requestAnimationFrame === 'function') await new Promise<void>((y) => requestAnimationFrame(() => requestAnimationFrame(() => y())))
  const shot = windowless() || !window.tucano?.capture ? null : await window.tucano.capture().catch(() => null)
  openDialog({ kind: 'feedback', ...(shot ? { image: shot } : {}), ...(draft ? { draft } : {}), ...(from ? { from } : {}) })
}

// What the Tuca's cards already sent, on this device: the card says so instead of offering it again.
const SENT_KEY = 'tucano.feedback-sent'
function sentFrom(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
function markSent(id: string): void {
  try {
    localStorage.setItem(SENT_KEY, JSON.stringify([...sentFrom().filter((x) => x !== id), id].slice(-50)))
  } catch {
    // Storage off: the card offers it again, and the person sees it went from the toast.
  }
  window.dispatchEvent(new Event(SENT_KEY))
}

// Under the Tuca's reply: the feedback he wrote, to review in the "Enviar feedback" window and send from there.
export function FeedbackDraftCard({ message }: { message: Message }): ReactNode {
  const draft = message.run?.feedbackDraft
  const [sent, setSent] = useState(() => sentFrom().includes(message.id))
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const seen = (): void => setSent(sentFrom().includes(message.id))
    window.addEventListener(SENT_KEY, seen)
    return () => window.removeEventListener(SENT_KEY, seen)
  }, [message.id])
  if (!draft) return null
  const kind = KINDS.find((k) => k.kind === draft.kind) ?? KINDS[0]!
  return (
    <div className={`draft-card feedback-card ${sent ? 'is-settled' : ''}`}>
      <div className="draft-card__head">
        <span className="proposal-icon">
          <Icon name="ask" size={18} />
        </span>
        <div className="grow">
          <strong>{L('Feedback pra quem faz o Tucano', 'Feedback for the people who make Tucano')}</strong>
          <span className="muted small">{kind.label()}</span>
        </div>
      </div>
      <p className={`draft-card__instructions ${open ? 'is-open' : ''}`} onClick={() => setOpen(!open)} title={open ? undefined : L('Ver tudo', 'Show all')}>
        {draft.message}
      </p>
      <div className="draft-card__actions">
        {sent ? (
          <span className="tag tag--ok">{L('enviado', 'sent')}</span>
        ) : (
          <button className="btn btn--primary btn--sm" onClick={() => void openFeedback(draft, message.id)}>
            {L('Revisar e enviar', 'Review and send')}
          </button>
        )}
      </div>
    </div>
  )
}

export function FeedbackDialog({ image, draft, from, onClose }: { image?: Shot; draft?: FeedbackDraft; from?: string; onClose: () => void }): ReactNode {
  const [kind, setKind] = useState<Kind>(draft?.kind ?? 'bug')
  const [text, setText] = useState(draft?.message ?? '')
  const [attach, setAttach] = useState(!!image)
  const [peek, setPeek] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const platform = useStore((s) => s.platform)
  const version = useUpdate()?.version
  const ask = KINDS.find((k) => k.kind === kind)!.ask()
  const what = L(
    `Além do seu texto, vão só a versão do Tucano${version ? ` (${version})` : ''}, o sistema (${SYSTEMS[platform]}) e o idioma.${image ? ' E a imagem da tela, se estiver marcada.' : ''}`,
    `Besides your text, only Tucano's version${version ? ` (${version})` : ''}, the system (${SYSTEMS[platform]}) and the language go.${image ? ' And the screen image, if it’s checked.' : ''}`
  )
  const send = async (): Promise<void> => {
    if (!text.trim() || sending) return
    setSending(true)
    setError('')
    try {
      await call('sendFeedback', { kind, message: text, ...(attach && image ? { image: image.data } : {}), lang: lang() })
      if (from) markSent(from)
      onClose()
      toast(L('Recebido. Obrigado!', 'Received. Thank you!'))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : L('Não consegui enviar agora. Tente de novo.', "I couldn't send it right now. Try again."))
      setSending(false)
    }
  }
  return (
    <Modal title={L('Enviar feedback', 'Send feedback')} onClose={onClose} className="feedback">
      <p className="small muted modal__lead">{L('Vai direto pra quem faz o Tucano. Eu leio tudo.', 'It goes straight to the people who make Tucano. I read everything.')}</p>
      <div className="feedback__kinds" role="radiogroup" aria-label={L('Tipo', 'Kind')}>
        {KINDS.map((k) => (
          <button key={k.kind} type="button" role="radio" aria-checked={kind === k.kind} className={`chip ${kind === k.kind ? 'is-on' : ''}`} onClick={() => setKind(k.kind)}>
            {k.label()}
          </button>
        ))}
      </div>
      <label className="field">
        <span className="field__label">{ask}</span>
        <textarea rows={5} value={text} maxLength={5000} autoFocus onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void send()} />
      </label>
      {image && (
        <div className="feedback__shot">
          <label className="feedback__attach">
            <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
            <span>{L('Anexar uma imagem da tela do Tucano', 'Attach a picture of the Tucano screen')}</span>
          </label>
          <button type="button" className="text-btn small" aria-expanded={peek} onClick={() => setPeek((v) => !v)}>
            {peek ? L('esconder a imagem', 'hide the picture') : L('ver a imagem', 'see the picture')}
          </button>
          {peek && <img className="feedback__preview" src={`data:${image.type};base64,${image.data}`} alt={L('A imagem da tela que vai junto', 'The screen picture that goes along')} />}
        </div>
      )}
      <p className="feedback__what small">{what}</p>
      {error && <p className="field__error small">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={!text.trim() || sending} onClick={() => void send()}>
          {sending ? L('Enviando…', 'Sending…') : L('Enviar', 'Send')}
        </button>
      </footer>
    </Modal>
  )
}

// ---------- the survey ----------

const ASK_EVERY_MS = 6 * 60 * 60 * 1000
const THANKS_MS = 3_000

type Step = { at: 'line' } | { at: 'open' } | { at: 'why'; choice: string } | { at: 'thanks' }

// A gray line with a dot, above the foot, when there's a survey for this install. A click opens the
// card upward; a click outside closes it and the line stays. A choice counts the moment it's clicked.
export function SurveyLine(): ReactNode {
  const owner = useStore(amOwner)
  const on = useStore((s) => s.settings.surveys !== false)
  const language = useStore((s) => s.settings.language)
  const [survey, setSurvey] = useState<SurveyView | null>(null)
  const [step, setStep] = useState<Step>({ at: 'line' })
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const busyWith = useRef(false) // in the middle of answering: a new ask doesn't swap the card
  busyWith.current = step.at !== 'line'

  // Asked on start and every few hours; the core keeps the answer meanwhile.
  useEffect(() => {
    if (!owner || !on) return setSurvey(null)
    let live = true
    const ask = (): void =>
      void call('survey', { lang: lang() }).then(
        (s) => live && setSurvey((now) => (now && busyWith.current ? now : s)),
        () => {}
      )
    ask()
    const timer = setInterval(ask, ASK_EVERY_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [owner, on, language])

  useEffect(() => {
    if (step.at !== 'open' && step.at !== 'why') return
    const outside = (e: MouseEvent): void => {
      if (box.current?.contains(e.target as Node)) return
      // Open, it closes back to the line; past the choice, it's answered: the line goes.
      if (step.at === 'open') setStep({ at: 'line' })
      else setStep({ at: 'thanks' })
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [step.at])

  useEffect(() => {
    if (step.at !== 'thanks') return
    const t = setTimeout(() => (setSurvey(null), setStep({ at: 'line' })), THANKS_MS)
    return () => clearTimeout(t)
  }, [step.at])

  if (!survey) return null
  const answer = async (p: { choice?: string; comment?: string; dismiss?: boolean }): Promise<boolean> => {
    setBusy(true)
    try {
      await call('answerSurvey', { survey: survey.id, ...p, lang: lang() })
      return true
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : L('Não consegui enviar a resposta. Tente de novo.', "I couldn't send the answer. Try again."))
      return false
    } finally {
      setBusy(false)
    }
  }
  const choose = async (choice: string): Promise<void> => {
    if (!(await answer({ choice }))) return
    setComment('')
    setStep(survey.followUp ? { at: 'why', choice } : { at: 'thanks' })
  }

  if (step.at === 'thanks')
    return (
      <div className="survey survey--thanks" role="status">
        <Icon name="check" size={13} />
        <span>{L('Valeu! Isso ajuda.', 'Thanks! That helps.')}</span>
      </div>
    )
  if (step.at === 'line')
    return (
      <div className="survey">
        <button className="survey__line" onClick={() => setStep({ at: 'open' })}>
          <span className="survey__dot" aria-hidden />
          <span className="survey__label">{L('Uma pergunta rápida pra você', 'A quick question for you')}</span>
          <span className="survey__time">10 s</span>
        </button>
      </div>
    )
  return (
    <div className="survey" ref={box}>
      <section className="survey__card" aria-label={L('Pesquisa', 'Survey')}>
        {step.at === 'open' ? (
          <>
            <strong className="survey__question">{survey.question}</strong>
            <div className="survey__options">
              {survey.options.map((o) => (
                <button key={o.id} className="btn btn--sm" disabled={busy} onClick={() => void choose(o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
            <button className="text-btn survey__skip" disabled={busy} onClick={() => void answer({ dismiss: true }).then((ok) => ok && setSurvey(null))}>
              {L('Não quero responder', "I'd rather not answer")}
            </button>
          </>
        ) : (
          <>
            <label className="survey__why">
              <strong className="survey__question">{survey.followUp}</strong>
              <textarea rows={3} value={comment} maxLength={2000} autoFocus onChange={(e) => setComment(e.target.value)} />
            </label>
            <div className="survey__options">
              <button className="btn btn--primary btn--sm" disabled={busy || !comment.trim()} onClick={() => void answer({ choice: step.choice, comment }).then((ok) => ok && setStep({ at: 'thanks' }))}>
                {L('Enviar', 'Send')}
              </button>
              <button className="text-btn survey__skip" disabled={busy} onClick={() => setStep({ at: 'thanks' })}>
                {L('Pular', 'Skip')}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
