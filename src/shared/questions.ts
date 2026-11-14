// What an agent asks with ask_user: one to four decisions, each a single choice, a multiple
// choice or a free text. The answers are kept on the asking message, one per decision, and
// go to the agent as my next message, one line each.
import { L } from './lang'
import type { Message, Run } from './types'

export type DecisionKind = 'single' | 'multiple' | 'text'
export interface DecisionOption {
  label: string
  description?: string
}
export interface Decision {
  question: string
  kind: DecisionKind
  options?: DecisionOption[]
  nextSteps?: true // a list of next steps, not a question: the card sends what's ticked as a to-do
  ticked?: number[] // which options start ticked: on a next-steps list, the ones the classifier found worth doing now
}
export interface Answer {
  chosen?: number[] // indexes into the options
  other?: string // "Something else", in a single or multiple choice
  text?: string // the answer to a text decision
  skipped?: true
}
// What's on a decision's card before it's confirmed.
export interface AnswerDraft {
  chosen: number[]
  other: string
  text: string
}

export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 1
// The card always adds "Something else" (a free answer) after the agent's options: 4 rows at most.
export const MAX_OPTIONS = 3
// A next-steps list is read as a to-do, not as a menu: it takes more lines than a question's
// options, and it has no "Something else" row pushing the count down.
export const MAX_STEPS = 6
// A decision is read at a glance: the context goes in the reply's text, not here.
export const MAX_QUESTION_LENGTH = 200
export const MAX_LABEL_LENGTH = 80
export const MAX_DESCRIPTION_LENGTH = 200

const KINDS: DecisionKind[] = ['single', 'multiple', 'text']

// Messages saved before decisions existed have a question string: it reads as one text decision.
export function questionsOf(run: Run | undefined): Decision[] {
  if (run?.questions?.length) return run.questions
  return run?.question ? [{ question: run.question, kind: 'text' }] : []
}

// A question that was just asked. Answering part of it saves the message again, which asks nothing new.
export function isNewQuestion(message: Message): boolean {
  return message.run?.status === 'waiting_input' && !message.run.answers && questionsOf(message.run).length > 0
}

// A list of next steps: the card reads as a to-do. Like a question, it opens with nothing ticked —
// the person ticks what they want done — and the only boxes that come ticked are the ones a
// classifier named as worth doing now (Settings › Classifiers).
export const isNextSteps = (question: Decision): boolean => question.nextSteps === true

export function startsTicked(question: Decision): number[] {
  if (!question.nextSteps) return []
  const picked = question.ticked
  if (!picked?.length) return []
  return (question.options ?? []).map((_, i) => i).filter((i) => picked.includes(i))
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
const tooLong = (question: string): string =>
  L(
    `Pergunta longa demais (${question.length} caracteres, o máximo é ${MAX_QUESTION_LENGTH}): coloque o contexto e a proposta no texto da sua resposta e deixe aqui só a decisão.`,
    `Question too long (${question.length} characters, at most ${MAX_QUESTION_LENGTH}): put the context and the proposal in your reply's text and leave only the decision here.`
  )

export function parseQuestions(args: Record<string, unknown>): { questions: Decision[] } | { error: string } {
  if (args['questions'] === undefined && typeof args['question'] === 'string') {
    const question = trimmed(args['question'])
    if (!question) return { error: L('Faltou a pergunta.', 'Missing the question.') }
    return question.length > MAX_QUESTION_LENGTH ? { error: tooLong(question) } : { questions: [{ question, kind: 'text' }] }
  }
  const list = args['questions']
  if (!Array.isArray(list) || list.length === 0) return { error: L('Faltou a pergunta: mande ao menos uma decisão em questions.', 'Missing the question: send at least one decision in questions.') }
  if (list.length > MAX_QUESTIONS) return { error: L(`No máximo ${MAX_QUESTIONS} decisões por pergunta: divida em mais de uma.`, `At most ${MAX_QUESTIONS} decisions per question: split them up.`) }
  const questions: Decision[] = []
  for (const item of list as Record<string, unknown>[]) {
    const question = trimmed(item?.['question'])
    if (!question) return { error: L('Toda decisão precisa de uma pergunta.', 'Every decision needs a question.') }
    if (question.length > MAX_QUESTION_LENGTH) return { error: tooLong(question) }
    const kind = item['kind'] as DecisionKind
    if (!KINDS.includes(kind)) return { error: L(`"${question}": kind tem que ser single, multiple ou text.`, `"${question}": kind must be single, multiple or text.`) }
    if (kind === 'text') {
      questions.push({ question, kind })
      continue
    }
    // Past the limit, the first ones are kept: "Something else" covers the rest.
    const raw = (Array.isArray(item['options']) ? (item['options'] as Record<string, unknown>[]) : []).slice(0, MAX_OPTIONS)
    if (raw.length < MIN_OPTIONS) return { error: L(`"${question}": de ${MIN_OPTIONS} a ${MAX_OPTIONS} opções.`, `"${question}": ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`) }
    const options: DecisionOption[] = []
    for (const o of raw) {
      const label = trimmed(o?.['label'])
      if (!label) return { error: L(`"${question}": toda opção precisa de um label.`, `"${question}": every option needs a label.`) }
      const description = trimmed(o['description'])
      if (label.length > MAX_LABEL_LENGTH || description.length > MAX_DESCRIPTION_LENGTH)
        return {
          error: L(
            `"${question}": label de até ${MAX_LABEL_LENGTH} caracteres e description de até ${MAX_DESCRIPTION_LENGTH}; o detalhe vai no texto da sua resposta.`,
            `"${question}": label up to ${MAX_LABEL_LENGTH} characters and description up to ${MAX_DESCRIPTION_LENGTH}; the detail goes in your reply's text.`
          )
        }
      options.push(description ? { label, description } : { label })
    }
    questions.push({ question, kind, options })
  }
  return { questions }
}

// What an agent proposes with next_steps: one multiple decision, nothing ticked until the person
// ticks it (or a classifier says which ones are worth doing now). Same limits as a decision's
// options, but more of them and no "Something else" row: an extra step is something the person
// writes in the message box.
export function parseNextSteps(args: Record<string, unknown>): { decision: Decision } | { error: string } {
  const question = trimmed(args['question'])
  if (question.length > MAX_QUESTION_LENGTH) return { error: tooLong(question) }
  const list = args['steps']
  if (!Array.isArray(list) || list.length === 0) return { error: L('Faltaram os próximos passos: mande de 1 a ' + MAX_STEPS + ' em steps.', 'Missing the next steps: send 1 to ' + MAX_STEPS + ' of them in steps.') }
  if (list.length > MAX_STEPS) return { error: L(`No máximo ${MAX_STEPS} próximos passos: os que não couberem vão no texto da sua resposta.`, `At most ${MAX_STEPS} next steps: the ones that don't fit go in your reply's text.`) }
  const options: DecisionOption[] = []
  const seen = new Set<string>()
  for (const item of list as Record<string, unknown>[]) {
    const label = trimmed(typeof item === 'string' ? item : item?.['label'])
    const description = trimmed(typeof item === 'string' ? '' : item?.['description'])
    if (!label) return { error: L('Todo próximo passo precisa de um label.', 'Every next step needs a label.') }
    if (label.length > MAX_LABEL_LENGTH || description.length > MAX_DESCRIPTION_LENGTH)
      return {
        error: L(
          `Label de até ${MAX_LABEL_LENGTH} caracteres e description de até ${MAX_DESCRIPTION_LENGTH}; o detalhe vai no texto da sua resposta.`,
          `Label up to ${MAX_LABEL_LENGTH} characters and description up to ${MAX_DESCRIPTION_LENGTH}; the detail goes in your reply's text.`
        )
      }
    const key = label.toLowerCase()
    if (seen.has(key)) return { error: L(`"${label}" está duas vezes na lista: junte os dois num só passo.`, `"${label}" is in the list twice: put both in one step.`) }
    seen.add(key)
    options.push(description ? { label, description } : { label })
  }
  return {
    decision: {
      question: question || L('Por onde eu sigo?', 'What comes next?'),
      kind: 'multiple',
      options,
      nextSteps: true
    }
  }
}

export function isAnswered(answer: Answer | null | undefined): boolean {
  return !!answer && (!!answer.chosen?.length || !!answer.other || !!answer.text || !!answer.skipped)
}

export function draftAnswer(question: Decision, draft: AnswerDraft): Answer | null {
  if (question.kind === 'text') return draft.text.trim() ? { text: draft.text.trim() } : null
  const other = draft.other.trim()
  if (question.kind === 'single') return other ? { other } : draft.chosen.length ? { chosen: draft.chosen } : null
  if (!draft.chosen.length && !other) return null
  return { ...(draft.chosen.length ? { chosen: [...draft.chosen].sort((a, b) => a - b) } : {}), ...(other ? { other } : {}) }
}

export function firstUnanswered(questions: Decision[], answers: (Answer | null)[] | undefined): number {
  return questions.findIndex((_, i) => !isAnswered(answers?.[i]))
}

export function answerLabel(question: Decision, answer: Answer): string {
  if (answer.skipped) return L('(pulou)', '(skipped)')
  if (question.kind === 'text') return answer.text ?? ''
  const chosen = [...(answer.chosen ?? [])].sort((a, b) => a - b).map((i) => question.options?.[i]?.label).filter(Boolean)
  // A step written by hand is one more step, not the "Something else" of a menu.
  if (answer.other) chosen.push(`${isNextSteps(question) ? L('Outro passo', 'Another step') : L('Outra coisa', 'Something else')}: ${answer.other}`)
  return chosen.join(', ')
}

// A Markdown list: one line each, in my message bubble as well as for the agent.
export function formatAnswers(questions: Decision[], answers: (Answer | null)[] | undefined): string {
  // One text question reads as a reply, as it did before decisions: the agent knows what it asked.
  const lone = questions.length === 1 && questions[0]!.kind === 'text' ? answers?.[0] : undefined
  if (lone && isAnswered(lone)) return answerLabel(questions[0]!, lone)
  return questions
    .map((q, i) => {
      const answer = answers?.[i]
      return answer && isAnswered(answer) ? `- ${q.question} → ${answerLabel(q, answer)}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function questionHeadline(questions: Decision[]): string {
  const first = questions[0]?.question ?? ''
  return questions.length > 1 ? `${first} (+${questions.length - 1})` : first
}

// For the agent's context: a lone text question reads exactly as a question did before.
export function describeQuestions(questions: Decision[]): string {
  return numberedQuestions(questions, '; ')
}

// For a text-only place (the phone): the question alone, or one numbered line per decision.
export function questionsAsText(questions: Decision[]): string {
  return numberedQuestions(questions, '\n')
}

function numberedQuestions(questions: Decision[], separator: string): string {
  if (questions.length === 1 && !questions[0]!.options) return questions[0]!.question
  return questions.map((q, i) => `${i + 1}. ${q.question}${q.options ? ` (${q.options.map((o) => o.label).join(' | ')})` : ''}`).join(separator)
}
