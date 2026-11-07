// The decisions an agent asked with ask_user: answered one at a time in place of the message
// box, reviewed and sent as my message; on the agent's message, what is waiting or what I chose.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../shared/lang'
import { answerLabel, draftAnswer, firstUnanswered, isAnswered, MAX_QUESTION_LENGTH, questionsOf, type Answer, type AnswerDraft, type Decision } from '../../../shared/questions'
import { answerDecision, dismissQuestion, reopenQuestion, submitDecisions, useStore, type Message } from '../store'
import { Icon } from './ui'
import { decisionKey } from './decision-keys'

type Step = number | 'review'

// Only a message from before the length limit has a question this long: it reads as text, not as a title.
const isLong = (q: Decision): boolean => q.question.length > MAX_QUESTION_LENGTH || q.question.includes('\n')
const Prose = ({ text, className }: { text: string; className: string }): ReactNode => (
  <div className={className}>
    <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
  </div>
)

// What's ticked or typed but not confirmed, by message and decision, so moving around or closing
// the card keeps it (like the message box's drafts). In memory: closing the app drops them.
const drafts = new Map<string, AnswerDraft>()
const draftKey = (messageId: string, index: number): string => `${messageId}:${index}`

// How long the keyboard stays quiet before a card that just showed up takes the focus.
const QUIET_MS = 800

const typing = (e: KeyboardEvent): boolean => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

// `id`: the asking message. In place of the message box (my question), or on a question's card
// (one I may answer for someone, in the conversation or in Pra você).
export function DecisionsCard({ id, questions, saved }: { id: string; questions: Decision[]; saved: (Answer | null)[] | undefined }): ReactNode {
  // Answers given here show at once, before the core echoes them back.
  const [answers, setAnswers] = useState<(Answer | null)[]>(() => questions.map((_, i) => saved?.[i] ?? null))
  useEffect(() => setAnswers(questions.map((_, i) => saved?.[i] ?? null)), [saved])
  const allAnswered = (list: (Answer | null)[]): boolean => firstUnanswered(questions, list) === -1
  const [step, setStep] = useState<Step>(() => {
    const unfinished = questions.findIndex((_, i) => drafts.has(draftKey(id, i))) // reopened: back where I was typing
    if (unfinished !== -1) return unfinished
    const first = firstUnanswered(questions, saved)
    return first === -1 ? (questions.length > 1 ? 'review' : 0) : first
  })
  const [sending, setSending] = useState(false)
  // The card shows up while I may be typing elsewhere: it takes the focus only once I've used it.
  const [engaged, setEngaged] = useState(false)

  const send = (): void => {
    if (sending) return
    setSending(true)
    void submitDecisions(id).finally(() => setSending(false)) // it failed if the card is still here: it can go again
  }

  const commit = (index: number, answer: Answer | null): void => {
    setEngaged(true)
    drafts.delete(draftKey(id, index))
    const next = answers.map((a, i) => (i === index ? answer : a))
    setAnswers(next)
    answerDecision(id, index, answer)
    if (!answer) return
    if (questions.length === 1) return send()
    const after = questions.findIndex((_, i) => i > index && !isAnswered(next[i]))
    setStep(after !== -1 ? after : allAnswered(next) ? 'review' : firstUnanswered(questions, next))
  }

  // Leaving a decision with the arrows keeps what's on it, as its answer if it is one.
  const settle = (): (Answer | null)[] => {
    if (step === 'review') return answers
    const key = draftKey(id, step)
    const draft = drafts.get(key)
    if (!draft) return answers
    drafts.delete(key)
    const answer = draftAnswer(questions[step]!, draft)
    const next = answers.map((a, i) => (i === step ? answer : a))
    setAnswers(next)
    answerDecision(id, step, answer)
    return next
  }

  const go = (to: Step): void => {
    const settled = settle()
    if (to === 'review' && !allAnswered(settled)) return
    setEngaged(true)
    setStep(to)
  }
  const position = step === 'review' ? questions.length : step
  const canGoNext = step !== 'review' && (step < questions.length - 1 || allAnswered(answers))

  return (
    <div className="decisions" aria-label={L('Decisões pra você', 'Decisions for you')}>
      <div className="decisions__progress" aria-hidden>
        {questions.map((_, i) => (
          <span key={i} className={`decisions__segment ${isAnswered(answers[i]) ? 'is-done' : ''} ${i === step ? 'is-current' : ''}`} />
        ))}
      </div>
      <div className="decisions__head">
        <h3 className="decisions__question">{step === 'review' ? L('Confira antes de enviar', 'Check before sending') : isLong(questions[step]!) ? L('Pergunta pra você', 'A question for you') : questions[step]!.question}</h3>
        {questions.length > 1 && (
          <div className="decisions__nav">
            <button className="icon-btn" disabled={position === 0} title={L('Anterior', 'Previous')} onClick={() => go(position - 1)}>
              <Icon name="back" size={14} />
            </button>
            <span className="decisions__count">{step === 'review' ? L('Revisão', 'Review') : L(`${position + 1} de ${questions.length}`, `${position + 1} of ${questions.length}`)}</span>
            <button className="icon-btn decisions__next" disabled={!canGoNext} title={L('Próxima', 'Next')} onClick={() => go(position + 1 < questions.length ? position + 1 : 'review')}>
              <Icon name="back" size={14} />
            </button>
          </div>
        )}
        <button className="icon-btn" title={L('Fechar e responder escrevendo', 'Close and answer in writing')} onClick={() => dismissQuestion(id)}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {step === 'review' ? (
        <Review questions={questions} answers={answers} onEdit={setStep} onSend={send} sending={sending} />
      ) : (
        <DecisionStep key={step} draftId={draftKey(id, step)} question={questions[step]!} answer={answers[step] ?? null} last={questions.length === 1} takeFocus={engaged} onAnswer={(a) => commit(step, a)} onDismiss={() => dismissQuestion(id)} />
      )}
    </div>
  )
}

function DecisionStep({ draftId, question, answer, last, takeFocus, onAnswer, onDismiss }: { draftId: string; question: Decision; answer: Answer | null; last: boolean; takeFocus: boolean; onAnswer: (a: Answer) => void; onDismiss: () => void }): ReactNode {
  const options = question.options ?? []
  const [draft, setDraft] = useState<AnswerDraft>(() => drafts.get(draftId) ?? { chosen: answer?.chosen ?? [], other: answer?.other ?? '', text: answer?.text ?? '' })
  const { chosen, other, text } = draft
  const edit = (patch: Partial<AnswerDraft>): void => {
    const next = { ...draft, ...patch }
    drafts.set(draftId, next)
    setDraft(next)
  }
  const [focus, setFocus] = useState<number | null>(null)
  const otherField = useRef<HTMLInputElement>(null)
  const textField = useRef<HTMLTextAreaElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // From the second decision on, keys work at once: the text field, or the options, takes the focus.
  // The first one may replace the message box under my fingers, and a digit would answer it: it
  // waits for a pause, and never takes the focus from a field I'm in.
  useEffect(() => {
    const target = (): HTMLElement | null => textField.current ?? body.current
    if (takeFocus) {
      target()?.focus()
      return
    }
    let timer: ReturnType<typeof setTimeout>
    const wait = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (document.activeElement === document.body) target()?.focus({ preventScroll: true })
      }, QUIET_MS)
    }
    wait()
    window.addEventListener('keydown', wait, true)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('keydown', wait, true)
    }
  }, [])

  const multiple = question.kind === 'multiple'
  const pick = (i: number): void => {
    if (!multiple) return onAnswer({ chosen: [i] })
    edit({ chosen: chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i] })
  }
  const typed = draftAnswer(question, draft)
  const ready = !!typed
  const confirm = (): void => {
    if (typed) onAnswer(typed)
  }
  const skip = (): void => onAnswer({ skipped: true })

  const keys = (e: KeyboardEvent): void => {
    const action = decisionKey(
      { key: e.key, shift: e.shiftKey, modifier: e.metaKey || e.ctrlKey || e.altKey, composing: e.nativeEvent.isComposing, inField: typing(e), onBody: e.target === e.currentTarget },
      focus,
      options.length
    )
    if (!action) return
    e.preventDefault()
    if (action.kind === 'dismiss') return onDismiss()
    if (action.kind === 'confirm') return confirm()
    if (action.kind === 'pick') return pick(action.index)
    if (action.kind === 'other') return otherField.current?.focus()
    setFocus(action.index)
    if (action.index === options.length) otherField.current?.focus()
    else body.current?.focus()
  }

  return (
    <div className="decisions__body" ref={body} tabIndex={-1} onKeyDown={keys}>
      {isLong(question) && <Prose className="decisions__prose" text={question.question} />}
      {question.kind === 'text' ? (
        <textarea ref={textField} className="decisions__text" rows={2} value={text} placeholder={L('Sua resposta', 'Your answer')} onChange={(e) => edit({ text: e.target.value })} />
      ) : (
        <div className="decisions__options" role={multiple ? 'group' : 'radiogroup'}>
          {options.map((o, i) => {
            const on = chosen.includes(i) || (!multiple && answer?.chosen?.includes(i))
            return (
              <button key={i} role={multiple ? 'checkbox' : 'radio'} aria-checked={!!on} className={`decisions__option ${on ? 'is-on' : ''} ${focus === i ? 'is-focus' : ''}`} onMouseEnter={() => setFocus(i)} onClick={() => pick(i)}>
                <span className="decisions__key">{multiple && on ? <Icon name="check" size={12} /> : i + 1}</span>
                <span className="decisions__label">
                  {o.label}
                  {o.description && <span className="decisions__detail">{o.description}</span>}
                </span>
              </button>
            )
          })}
          <label className={`decisions__option decisions__option--other ${focus === options.length ? 'is-focus' : ''}`} onMouseEnter={() => setFocus(options.length)}>
            <span className="decisions__key">
              <Icon name="edit" size={12} />
            </span>
            <input ref={otherField} value={other} placeholder={L('Outra coisa…', 'Something else…')} onChange={(e) => edit({ other: e.target.value })} />
          </label>
        </div>
      )}
      <div className="decisions__bar">
        <button className="btn btn--ghost btn--sm" onClick={skip}>
          {L('Pular', 'Skip')}
        </button>
        <span className="decisions__hint">
          {question.kind === 'text' ? L('Enter confirma · Shift+Enter quebra a linha', 'Enter confirms · Shift+Enter for a new line') : multiple ? L('Marque quantas quiser', 'Pick as many as you like') : L('Aperte o número da opção', 'Press the option’s number')}
        </span>
        {(question.kind !== 'single' || other.trim()) && (
          <button className="btn btn--primary btn--sm" disabled={!ready} onClick={confirm}>
            {last ? L('Enviar', 'Send') : L('Próxima', 'Next')}
          </button>
        )}
      </div>
    </div>
  )
}

function Review({ questions, answers, onEdit, onSend, sending }: { questions: Decision[]; answers: (Answer | null)[]; onEdit: (i: number) => void; onSend: () => void; sending: boolean }): ReactNode {
  return (
    <div className="decisions__body">
      <ol className="decisions__review">
        {questions.map((q, i) => (
          <li key={i}>
            <button className="decisions__review-row" title={L('Mudar esta resposta', 'Change this answer')} onClick={() => onEdit(i)}>
              <span className="decisions__review-question">{isLong(q) ? L('Pergunta', 'Decision') : q.question}</span>
              <span className={`decisions__review-answer ${answers[i]?.skipped ? 'is-skipped' : ''}`}>{answers[i] ? answerLabel(q, answers[i]) : ''}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="decisions__bar">
        <span className="decisions__hint">{L('Clique numa resposta pra mudar', 'Click an answer to change it')}</span>
        <button className="btn btn--primary btn--sm" disabled={sending} onClick={onSend} autoFocus>
          <Icon name="send" size={12} /> {L('Enviar', 'Send')}
        </button>
      </div>
    </div>
  )
}

// On the agent's message: what's waiting for me, or what I chose.
export function AnswersSummary({ message }: { message: Message }): ReactNode {
  const questions = questionsOf(message.run)
  const dismissed = useStore((s) => s.dismissedQuestions.includes(message.id))
  if (!questions.length) return null
  if (message.run?.status === 'waiting_input') {
    return (
      <div className="answers is-waiting">
        <Icon name="down" size={13} />
        <span>{questions.length > 1 ? L(`${questions.length} decisões esperando você`, `${questions.length} decisions waiting for you`) : L('Uma pergunta esperando você', 'A question waiting for you')}</span>
        {dismissed && (
          <button className="link" onClick={() => reopenQuestion(message.id)}>
            {L('Responder', 'Answer')}
          </button>
        )}
      </div>
    )
  }
  return (
    <div className="answers">
      <span className="answers__label">{L('Perguntou', 'Asked')}</span>
      <DecisionList questions={questions} answers={message.run?.answers} answeredInText={message.run?.answeredInText} />
    </div>
  )
}

// The decisions asked: with what was chosen, once answered on the card; otherwise the questions alone.
export function DecisionList({ questions, answers, answeredInText }: { questions: Decision[]; answers?: (Answer | null)[]; answeredInText?: boolean }): ReactNode {
  const answered = questions.map((q, i) => ({ q, a: answers?.[i] })).filter((x) => isAnswered(x.a))
  return (
    <>
      {answered.length ? (
        <dl className="answers__list">
          {answered.map(({ q, a }, i) => (
            <div key={q.question + i}>
              <dt>{isLong(q) ? <Prose className="answers__prose" text={q.question} /> : q.question}</dt>
              <dd className={a!.skipped ? 'is-skipped' : ''}>{answerLabel(q, a!)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <ul className="answers__questions">
          {questions.map((q, i) => (
            <li key={i}>
              {isLong(q) ? <Prose className="answers__prose" text={q.question} /> : q.question}
              {q.options && <span className="answers__options"> ({q.options.map((o) => o.label).join(' · ')})</span>}
            </li>
          ))}
        </ul>
      )}
      {answeredInText && answered.length > 0 && <span className="answers__note">{L('O resto foi respondido em texto.', 'The rest was answered in text.')}</span>}
    </>
  )
}
