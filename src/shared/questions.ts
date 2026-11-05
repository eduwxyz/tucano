// What an agent asks with ask_user: one to four decisions, each a single choice, a multiple
// choice or a free text. The answers are kept on the asking message, one per decision, and
// go to the agent as my next message, one line each.
import { L } from './lang'
import type { Run } from './types'

export type QuestionKind = 'single' | 'multiple' | 'text'
export interface QuestionOption {
  label: string
  description?: string
}
export interface Question {
  question: string
  kind: QuestionKind
  options?: QuestionOption[]
}
export interface Answer {
  chosen?: number[] // indexes into the options
  other?: string // "Something else", in a single or multiple choice
  text?: string // the answer to a text decision
  skipped?: true
}

export const MAX_QUESTIONS = 4
export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 4

const KINDS: QuestionKind[] = ['single', 'multiple', 'text']

// Messages saved before decisions existed have a question string: it reads as one text decision.
export function questionsOf(run: Run | undefined): Question[] {
  if (run?.questions?.length) return run.questions
  return run?.question ? [{ question: run.question, kind: 'text' }] : []
}

const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

export function parseQuestions(args: Record<string, unknown>): { questions: Question[] } | { error: string } {
  if (args['questions'] === undefined && typeof args['question'] === 'string') {
    const question = trimmed(args['question'])
    return question ? { questions: [{ question, kind: 'text' }] } : { error: L('Faltou a pergunta.', 'Missing the question.') }
  }
  const list = args['questions']
  if (!Array.isArray(list) || list.length === 0) return { error: L('Faltou a pergunta: mande ao menos uma decisão em questions.', 'Missing the question: send at least one decision in questions.') }
  if (list.length > MAX_QUESTIONS) return { error: L(`No máximo ${MAX_QUESTIONS} decisões por pergunta: divida em mais de uma.`, `At most ${MAX_QUESTIONS} decisions per question: split them up.`) }
  const questions: Question[] = []
  for (const item of list as Record<string, unknown>[]) {
    const question = trimmed(item?.['question'])
    if (!question) return { error: L('Toda decisão precisa de uma pergunta.', 'Every decision needs a question.') }
    const kind = item['kind'] as QuestionKind
    if (!KINDS.includes(kind)) return { error: L(`"${question}": kind tem que ser single, multiple ou text.`, `"${question}": kind must be single, multiple or text.`) }
    if (kind === 'text') {
      questions.push({ question, kind })
      continue
    }
    const raw = Array.isArray(item['options']) ? (item['options'] as Record<string, unknown>[]) : []
    if (raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) return { error: L(`"${question}": de ${MIN_OPTIONS} a ${MAX_OPTIONS} opções.`, `"${question}": ${MIN_OPTIONS} to ${MAX_OPTIONS} options.`) }
    const options: QuestionOption[] = []
    for (const o of raw) {
      const label = trimmed(o?.['label'])
      if (!label) return { error: L(`"${question}": toda opção precisa de um label.`, `"${question}": every option needs a label.`) }
      const description = trimmed(o['description'])
      options.push(description ? { label, description } : { label })
    }
    questions.push({ question, kind, options })
  }
  return { questions }
}

export function isAnswered(answer: Answer | null | undefined): boolean {
  return !!answer && (!!answer.chosen?.length || !!answer.other || !!answer.text || !!answer.skipped)
}

export function firstUnanswered(questions: Question[], answers: (Answer | null)[] | undefined): number {
  return questions.findIndex((_, i) => !isAnswered(answers?.[i]))
}

export function answerLabel(question: Question, answer: Answer): string {
  if (answer.skipped) return L('(pulou)', '(skipped)')
  if (question.kind === 'text') return answer.text ?? ''
  const chosen = [...(answer.chosen ?? [])].sort((a, b) => a - b).map((i) => question.options?.[i]?.label).filter(Boolean)
  if (answer.other) chosen.push(`${L('Outra coisa', 'Something else')}: ${answer.other}`)
  return chosen.join(', ')
}

export function formatAnswers(questions: Question[], answers: (Answer | null)[] | undefined): string {
  return questions
    .map((q, i) => {
      const answer = answers?.[i]
      return answer && isAnswered(answer) ? `${q.question} → ${answerLabel(q, answer)}` : ''
    })
    .filter(Boolean)
    .join('\n')
}

export function questionHeadline(questions: Question[]): string {
  const first = questions[0]?.question ?? ''
  return questions.length > 1 ? `${first} (+${questions.length - 1})` : first
}

// For the agent's context: a lone text question reads exactly as a question did before.
export function describeQuestions(questions: Question[]): string {
  if (questions.length === 1 && !questions[0]!.options) return questions[0]!.question
  return questions.map((q, i) => `${i + 1}. ${q.question}${q.options ? ` (${q.options.map((o) => o.label).join(' | ')})` : ''}`).join('; ')
}
