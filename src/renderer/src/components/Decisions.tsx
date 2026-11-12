// The decisions an agent asked with ask_user, as a card under its reply. Whoever may answer
// goes through them one at a time (the agent's options, then "Something else"), checks them and
// sends them as their message; anyone else sees what's asked. Answered, the card keeps what
// was chosen, so the conversation still reads when scrolling back. The message box below stays
// as it is: writing there is a free answer, with what was picked here going along.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../shared/lang'
import { answerLabel, draftAnswer, firstUnanswered, isAnswered, isNextSteps, MAX_QUESTION_LENGTH, questionsOf, startsTicked, type Answer, type AnswerDraft, type Decision } from '../../../shared/questions'
import { answerDecision, submitDecisions, type Message } from '../store'
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
const Title = ({ q }: { q: Decision }): ReactNode => (isLong(q) ? <Prose className="ask__prose" text={q.question} /> : <div className="ask__title">{q.question}</div>)

// What's ticked or typed but not confirmed, by message and decision, so moving around or
// scrolling away keeps it (like the message box's drafts). In memory: closing the app drops them.
const drafts = new Map<string, AnswerDraft>()
const draftKey = (messageId: string, index: number): string => `${messageId}:${index}`

const inField = (e: KeyboardEvent): boolean => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement

export type AskMode = 'answer' | 'view' | 'done'

// `answer`: this person may answer it now. `view`: someone else's to answer (or not yet asked).
// `done`: answered. `badge`: the state, as the head says it; `byline`: who asked whom (a team).
// `recommended`: Jev's pick per decision, when it's turned on and has answered.
// `children`: what goes under it (a hint, buttons).
export function AskCard({
  id,
  questions,
  saved,
  mode,
  badge,
  byline,
  answeredInText,
  recommended,
  children
}: {
  id: string
  questions: Decision[]
  saved?: (Answer | null)[]
  mode: AskMode
  badge: string
  byline?: string
  answeredInText?: boolean
  recommended?: (number | null)[] | undefined
  children?: ReactNode
}): ReactNode {
  // A next-steps card is a to-do, not a menu: it says so, in every mode.
  const steps = questions.some(isNextSteps)
  if (mode === 'answer') return <Answering id={id} questions={questions} saved={saved} badge={badge} byline={byline} recommended={recommended} steps={steps} extra={children} />
  return (
    <section className={`ask ask--${mode}${steps ? ' ask--steps' : ''}`} aria-label={badge}>
      <Head badge={badge} byline={byline} done={mode === 'done'} steps={steps} />
      {mode === 'done' ? <Summary questions={questions} answers={saved} answeredInText={answeredInText} /> : <Asked questions={questions} recommended={recommended} />}
      {children}
    </section>
  )
}

function Head({ badge, byline, done, nav, steps }: { badge: string; byline?: string | undefined; done?: boolean; nav?: ReactNode; steps?: boolean }): ReactNode {
  return (
    <div className="ask__head">
      <span className="ask__badge">
        <Icon name={done ? 'check' : 'ask'} size={13} />
        {badge}
      </span>
      {steps && <span className="ask-option__pill">{L('Próximos passos', 'Next steps')}</span>}
      {byline && <span className="ask__byline">{byline}</span>}
      {nav}
    </div>
  )
}

// Jev's pick, as a pill: the card still waits for the person, so it never takes the tick or the
// keyboard. It's a hint on an option, not a state.
function Recommended(): ReactNode {
  return <span className="ask-option__pill">{L('Recomendado', 'Recommended')}</span>
}

// Someone else's question, waiting: each decision with its options, to read.
function Asked({ questions, recommended }: { questions: Decision[]; recommended?: (number | null)[] | undefined }): ReactNode {
  return (
    <ol className="ask-list">
      {questions.map((q, i) => (
        <li key={i} className="ask-list__row">
          {isLong(q) ? <Prose className="ask__prose" text={q.question} /> : <span className="ask-list__q">{q.question}</span>}
          {q.options && (
            <span className="ask-list__options">
              {q.options.map((o, j) => (
                <span key={j} className="ask-list__option">
                  <span className="ask-chip">{o.label}</span>
                  {recommended?.[i] === j && <Recommended />}
                </span>
              ))}
            </span>
          )}
        </li>
      ))}
    </ol>
  )
}

// Answered: each decision and what was chosen. Answered in writing: the questions, and a note.
function Summary({ questions, answers, answeredInText }: { questions: Decision[]; answers?: (Answer | null)[] | undefined; answeredInText?: boolean | undefined }): ReactNode {
  const any = !!answers?.some(isAnswered)
  return (
    <>
      <dl className="ask-summary">
        {questions.map((q, i) => {
          const a = answers?.[i]
          return (
            <div key={i} className="ask-summary__row">
              <dt>{isLong(q) ? <Prose className="ask__prose" text={q.question} /> : q.question}</dt>
              <dd className={!a || !isAnswered(a) || a.skipped ? 'is-muted' : ''}>{a && isAnswered(a) ? answerLabel(q, a) : any ? L('respondida em texto', 'answered in text') : L('respondida na mensagem abaixo', 'answered in the message below')}</dd>
            </div>
          )
        })}
      </dl>
      {answeredInText && any && <p className="ask__note">{L('Com uma resposta escrita, logo abaixo.', 'With a written answer, just below.')}</p>}
    </>
  )
}

function Answering({ id, questions, saved, badge, byline, recommended, steps, extra }: { id: string; questions: Decision[]; saved?: (Answer | null)[] | undefined; badge: string; byline?: string | undefined; recommended?: (number | null)[] | undefined; steps?: boolean; extra?: ReactNode }): ReactNode {
  // Answers given here show at once, before the core echoes them back.
  const [answers, setAnswers] = useState<(Answer | null)[]>(() => questions.map((_, i) => saved?.[i] ?? null))
  useEffect(() => setAnswers(questions.map((_, i) => saved?.[i] ?? null)), [saved])
  const allAnswered = (list: (Answer | null)[]): boolean => firstUnanswered(questions, list) === -1
  const [step, setStep] = useState<Step>(() => {
    const unfinished = questions.findIndex((_, i) => drafts.has(draftKey(id, i))) // back where I was typing
    if (unfinished !== -1) return unfinished
    const first = firstUnanswered(questions, saved)
    return first === -1 ? (questions.length > 1 ? 'review' : 0) : first
  })
  const [sending, setSending] = useState(false)
  // Once used, moving to the next decision keeps the keyboard on the card.
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
  const nav =
    questions.length > 1 ? (
      <div className="ask__nav">
        <button className="icon-btn icon-btn--sm" disabled={position === 0} title={L('Anterior', 'Previous')} aria-label={L('Anterior', 'Previous')} onClick={() => go(position - 1)}>
          <Icon name="back" size={13} />
        </button>
        <span className="ask__count">{step === 'review' ? L('Revisão', 'Review') : L(`${position + 1} de ${questions.length}`, `${position + 1} of ${questions.length}`)}</span>
        <button className="icon-btn icon-btn--sm ask__next" disabled={!canGoNext} title={L('Próxima', 'Next')} aria-label={L('Próxima', 'Next')} onClick={() => go(position + 1 < questions.length ? position + 1 : 'review')}>
          <Icon name="back" size={13} />
        </button>
      </div>
    ) : undefined

  return (
    <section className={`ask ask--answer${steps ? ' ask--steps' : ''}`} aria-label={badge}>
      <Head badge={badge} byline={byline} nav={nav} steps={steps} />
      {questions.length > 1 && (
        <div className="ask__progress" aria-hidden>
          {questions.map((_, i) => (
            <span key={i} className={`ask__segment ${isAnswered(answers[i]) ? 'is-done' : ''} ${i === step ? 'is-current' : ''}`} />
          ))}
        </div>
      )}
      {step === 'review' ? (
        <Review takeFocus={engaged} questions={questions} answers={answers} onEdit={(i) => (setEngaged(true), setStep(i))} onSend={send} sending={sending} />
      ) : (
        <DecisionStep key={step} draftId={draftKey(id, step)} question={questions[step]!} answer={answers[step] ?? null} recommended={recommended?.[step] ?? null} last={questions.length === 1} takeFocus={engaged} onAnswer={(a) => commit(step, a)} />
      )}
      {extra}
    </section>
  )
}

function DecisionStep({ draftId, question, answer, recommended, last, takeFocus, onAnswer }: { draftId: string; question: Decision; answer: Answer | null; recommended?: number | null; last: boolean; takeFocus: boolean; onAnswer: (a: Answer) => void }): ReactNode {
  const options = question.options ?? []
  // A next-steps card opens with its boxes already ticked (or with the ones Jev found worth doing
  // now); a question opens with nothing picked. A draft I left here, or an answer saved, wins.
  const [draft, setDraft] = useState<AnswerDraft>(() => drafts.get(draftId) ?? { chosen: answer?.chosen ?? startsTicked(question), other: answer?.other ?? '', text: answer?.text ?? '' })
  const { chosen, other, text } = draft
  const edit = (patch: Partial<AnswerDraft>): void => {
    const next = { ...draft, ...patch }
    drafts.set(draftId, next)
    setDraft(next)
  }
  const [focus, setFocus] = useState<number | null>(null)
  // "Something else" opens a field in its row; open from the start when it already has an answer.
  const [writing, setWriting] = useState(() => !!(drafts.get(draftId)?.other ?? answer?.other))
  const otherField = useRef<HTMLInputElement>(null)
  const textField = useRef<HTMLTextAreaElement>(null)
  const body = useRef<HTMLDivElement>(null)
  // Moving on from a decision I just answered keeps the keyboard here; the card never takes it from the message box by itself.
  useEffect(() => {
    if (takeFocus) (textField.current ?? body.current)?.focus({ preventScroll: true })
  }, [])

  const multiple = question.kind === 'multiple'
  const pick = (i: number): void => {
    if (!multiple) return onAnswer({ chosen: [i] })
    edit({ chosen: chosen.includes(i) ? chosen.filter((x) => x !== i) : [...chosen, i] })
  }
  const openOther = (): void => {
    setFocus(options.length) // the field takes the focus as it opens (autoFocus)
    setWriting(true)
  }
  const typed = draftAnswer(question, draft)
  const confirm = (): void => {
    if (typed) onAnswer(typed)
  }
  const skip = (): void => onAnswer({ skipped: true })

  const keys = (e: KeyboardEvent): void => {
    const action = decisionKey(
      { key: e.key, shift: e.shiftKey, modifier: e.metaKey || e.ctrlKey || e.altKey, composing: e.nativeEvent.isComposing, inField: inField(e), onBody: e.target === e.currentTarget },
      focus,
      options.length
    )
    if (!action) return
    e.preventDefault()
    if (action.kind === 'dismiss') {
      // Esc: out of "Something else" (closed when empty), then off the card.
      if (e.target === otherField.current) {
        if (!other.trim()) setWriting(false)
        body.current?.focus()
      } else (e.target as HTMLElement).blur()
      return
    }
    if (action.kind === 'confirm') return confirm()
    if (action.kind === 'pick') return pick(action.index)
    if (action.kind === 'other') return openOther()
    setFocus(action.index)
    if (action.index === options.length && writing) otherField.current?.focus()
    else body.current?.focus()
  }

  const steps = isNextSteps(question)
  const keyHint =
    question.kind === 'text'
      ? L('Enter confirma · Shift+Enter quebra a linha', 'Enter confirms · Shift+Enter for a new line')
      : steps
        ? L(`Marque quantos quiser com 1 a ${options.length + 1} · nada começa marcado`, `Tick as many as you like with 1 to ${options.length + 1} · nothing starts ticked`)
        : multiple
          ? L(`Marque quantas quiser com 1 a ${options.length + 1}`, `Tick as many as you like with 1 to ${options.length + 1}`)
          : L(`Escolha com 1 a ${options.length + 1}`, `Pick with 1 to ${options.length + 1}`)

  return (
    <div className="ask__body" ref={body} tabIndex={-1} onKeyDown={keys}>
      <Title q={question} />
      {question.kind === 'text' ? (
        <textarea ref={textField} className="ask__text" rows={2} value={text} placeholder={L('Sua resposta', 'Your answer')} onChange={(e) => edit({ text: e.target.value })} />
      ) : (
        <div className="ask-options" role={multiple ? 'group' : 'radiogroup'} aria-label={question.question}>
          {options.map((o, i) => {
            const on = chosen.includes(i) || (!multiple && !!answer?.chosen?.includes(i))
            return (
              <button key={i} role={multiple ? 'checkbox' : 'radio'} aria-checked={on} className={`ask-option ${on ? 'is-on' : ''} ${focus === i ? 'is-focus' : ''}`} onMouseEnter={() => setFocus(i)} onClick={() => pick(i)}>
                <span className="ask-option__key">{i + 1}</span>
                <span className="ask-option__text">
                  <span className="ask-option__line">
                    <span className="ask-option__label">{o.label}</span>
                    {(recommended === i || (steps && !!question.ticked?.includes(i))) && <Recommended />}
                  </span>
                  {o.description && <span className="ask-option__detail">{o.description}</span>}
                </span>
                <span className={`ask-option__mark ${multiple ? 'is-box' : ''}`} aria-hidden>
                  {on && <Icon name="check" size={12} />}
                </span>
              </button>
            )
          })}
          {writing ? (
            <label className={`ask-option ask-option--other is-open ${other.trim() ? 'is-on' : ''}`} onMouseEnter={() => setFocus(options.length)}>
              <span className="ask-option__key">{options.length + 1}</span>
              <input ref={otherField} className="ask-option__input" autoFocus={focus === options.length} value={other} placeholder={L('Escreva sua resposta…', 'Write your answer…')} onChange={(e) => edit({ other: e.target.value })} />
            </label>
          ) : (
            <button className={`ask-option ask-option--other ${focus === options.length ? 'is-focus' : ''}`} onMouseEnter={() => setFocus(options.length)} onClick={openOther}>
              <span className="ask-option__key">{options.length + 1}</span>
              <span className="ask-option__text">
                <span className="ask-option__label">{steps ? L('Outro passo…', 'Another step…') : L('Outra coisa…', 'Something else…')}</span>
              </span>
              <span className="ask-option__mark" aria-hidden>
                <Icon name="edit" size={12} />
              </span>
            </button>
          )}
        </div>
      )}
      <div className="ask__foot">
        <span className="ask__hint">{keyHint}</span>
        <button className="btn btn--ghost btn--sm" onClick={skip}>
          {L('Pular', 'Skip')}
        </button>
        {(question.kind !== 'single' || writing) && (
          <button className="btn btn--primary btn--sm" disabled={!typed} onClick={confirm}>
            {steps && last ? L('Fazer estes', 'Do these') : last ? L('Enviar', 'Send') : L('Próxima', 'Next')}
          </button>
        )}
      </div>
    </div>
  )
}

function Review({ takeFocus, questions, answers, onEdit, onSend, sending }: { takeFocus: boolean; questions: Decision[]; answers: (Answer | null)[]; onEdit: (i: number) => void; onSend: () => void; sending: boolean }): ReactNode {
  // Reached from the last decision, Send has the keyboard; on a card that just showed up, nothing does.
  const sendButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (takeFocus) sendButton.current?.focus({ preventScroll: true })
  }, [])
  return (
    <div className="ask__body">
      <div className="ask__title">{L('Confira antes de enviar', 'Check before sending')}</div>
      <ol className="ask-review">
        {questions.map((q, i) => (
          <li key={i}>
            <button className="ask-review__row" title={L('Mudar esta resposta', 'Change this answer')} onClick={() => onEdit(i)}>
              <span className="ask-review__q">{isLong(q) ? L('Pergunta', 'Question') : q.question}</span>
              <span className={`ask-review__a ${answers[i]?.skipped ? 'is-muted' : ''}`}>{answers[i] ? answerLabel(q, answers[i]) : ''}</span>
              <Icon name="edit" size={12} />
            </button>
          </li>
        ))}
      </ol>
      <div className="ask__foot">
        <span className="ask__hint">{L('Clique numa resposta pra mudar', 'Click an answer to change it')}</span>
        <button ref={sendButton} className="btn btn--primary btn--sm" disabled={sending} onClick={onSend}>
          <Icon name="send" size={12} /> {L('Enviar', 'Send')}
        </button>
      </div>
    </div>
  )
}

// Alone, on the agent's message: my question, to answer here, or what I chose.
export function AnswersSummary({ message }: { message: Message }): ReactNode {
  const questions = questionsOf(message.run)
  if (!questions.length) return null
  const waiting = message.run?.status === 'waiting_input'
  return <AskCard id={message.id} questions={questions} saved={message.run?.answers} recommended={message.run?.recommended} mode={waiting ? 'answer' : 'done'} badge={waiting ? L('Esperando você', 'Waiting for you') : L('Respondida', 'Answered')} answeredInText={!!message.run?.answeredInText} />
}

// The message that sent a card's answers says nothing the card doesn't: in the conversation it
// shows only what was written beyond them, or not at all. It stays as it is everywhere else (the
// agent, the wiki, search, Telegram). Found by the link the card keeps, never by the text.
const linked = new WeakMap<Message[], Map<string, string>>()
export function cardAnswers(all: Message[]): Map<string, string> {
  const had = linked.get(all)
  if (had) return had
  const map = new Map<string, string>()
  for (const m of all) if (m.run?.answerMessage) map.set(m.run.answerMessage, m.run.answerTyped ?? '')
  linked.set(all, map)
  return map
}

export function asShown(messages: Message[], answers: Map<string, string>): Message[] {
  if (!answers.size || !messages.some((m) => answers.has(m.id))) return messages
  return messages.flatMap((m) => {
    if (m.author.kind !== 'person' || !answers.has(m.id)) return [m]
    const typed = answers.get(m.id)!
    return typed ? [{ ...m, text: typed }] : []
  })
}
