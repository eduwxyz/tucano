import { describe, expect, it } from 'vitest'
import {
  answerLabel,
  describeQuestions,
  draftAnswer,
  firstUnanswered,
  formatAnswers,
  isAnswered,
  isNewQuestion,
  parseQuestions,
  questionHeadline,
  questionsAsText,
  questionsOf,
  type AnswerDraft,
  type Decision
} from '../src/shared/questions'
import type { Message, Run } from '../src/shared/types'

const pagination: Decision = { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }
const parts: Decision = { question: 'O que remover?', kind: 'multiple', options: [{ label: 'Nó tag' }, { label: 'getUsedTags' }, { label: 'declaredTagIds' }] }
const deadline: Decision = { question: 'Pra quando?', kind: 'text' }

const refused = (args: Record<string, unknown>): boolean => 'error' in parseQuestions(args)

describe('draftAnswer', () => {
  const single: Decision = { question: 'Qual?', kind: 'single', options: [{ label: 'A' }, { label: 'B' }] }
  const multiple: Decision = { ...single, kind: 'multiple' }
  const text: Decision = { question: 'Qual?', kind: 'text' }
  const draft = (patch: Partial<AnswerDraft>): AnswerDraft => ({ chosen: [], other: '', text: '', ...patch })

  it('is the text, trimmed, or nothing', () => {
    expect(draftAnswer(text, draft({ text: ' sexta ' }))).toEqual({ text: 'sexta' })
    expect(draftAnswer(text, draft({ text: '  ' }))).toBeNull()
  })

  it('keeps every option ticked, in order, and something else with them', () => {
    expect(draftAnswer(multiple, draft({ chosen: [1, 0], other: ' C ' }))).toEqual({ chosen: [0, 1], other: 'C' })
    expect(draftAnswer(multiple, draft({}))).toBeNull()
  })

  it('in a single choice, something else takes the place of the option', () => {
    expect(draftAnswer(single, draft({ chosen: [1], other: 'C' }))).toEqual({ other: 'C' })
    expect(draftAnswer(single, draft({ chosen: [1] }))).toEqual({ chosen: [1] })
  })
})

describe('isNewQuestion', () => {
  const asked = (run: Partial<Run>): Message => ({ id: 'm', conversationId: 'c', author: { kind: 'agent', id: 'a' }, text: '', at: 0, run: { status: 'waiting_input', steps: [], questions: [{ question: 'Qual?', kind: 'text' }], ...run } })

  it('is a question waiting, before any answer', () => {
    expect(isNewQuestion(asked({}))).toBe(true)
    expect(isNewQuestion(asked({ questions: undefined, question: 'Qual?' }))).toBe(true)
  })

  it('is not a question saved again with an answer on it', () => {
    expect(isNewQuestion(asked({ answers: [null] }))).toBe(false)
  })

  it('is not anything else', () => {
    expect(isNewQuestion(asked({ status: 'done' }))).toBe(false)
    expect(isNewQuestion(asked({ questions: undefined }))).toBe(false)
  })
})

describe('questionsOf', () => {
  it('reads an old run with a question string as one text decision', () => {
    expect(questionsOf({ status: 'done', steps: [], question: 'Pra quando?' })).toEqual([deadline])
  })
  it('prefers run.questions over the old string', () => {
    expect(questionsOf({ status: 'done', steps: [], question: 'velha', questions: [pagination] })).toEqual([pagination])
  })
  it('is empty without a question', () => {
    expect(questionsOf(undefined)).toEqual([])
    expect(questionsOf({ status: 'done', steps: [] })).toEqual([])
  })
})

describe('parseQuestions', () => {
  it('accepts the old { question } form', () => {
    expect(parseQuestions({ question: ' Pra quando? ' })).toEqual({ questions: [deadline] })
  })
  it('accepts a list of decisions and trims labels', () => {
    const args = {
      questions: [
        { question: ' Paginação no menu? ', kind: 'single', options: [{ label: ' Busca remota ' }, { label: 'Scroll infinito', description: ' dá mais trabalho ' }] },
        { question: 'Pra quando?', kind: 'text' }
      ]
    }
    expect(parseQuestions(args)).toEqual({
      questions: [
        { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito', description: 'dá mais trabalho' }] },
        deadline
      ]
    })
  })
  it('refuses no decisions, more than 4, bad option counts, empty text and unknown kinds', () => {
    const two = [{ label: 'a' }, { label: 'b' }]
    expect(refused({})).toBe(true)
    expect(refused({ questions: [] })).toBe(true)
    expect(refused({ questions: Array.from({ length: 5 }, () => deadline) })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'single', options: [] }] })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'single', options: [{ label: 'a' }] }] })).toBe(false) // one suggestion, and Something else
    expect(refused({ questions: [{ question: ' ', kind: 'text' }] })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'single', options: [{ label: 'a' }, { label: ' ' }] }] })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'dropdown', options: two }] })).toBe(true)
    expect(refused({ question: '  ' })).toBe(true)
  })
  it('keeps the first 3 options of a longer list: the card adds Something else', () => {
    const r = parseQuestions({ questions: [{ question: 'x', kind: 'multiple', options: ['a', 'b', 'c', 'd', 'e'].map((label) => ({ label })) }] })
    expect(r).toEqual({ questions: [{ question: 'x', kind: 'multiple', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }] })
  })

  it('drops options from a text decision', () => {
    expect(parseQuestions({ questions: [{ question: 'Pra quando?', kind: 'text', options: [{ label: 'a' }, { label: 'b' }] }] })).toEqual({ questions: [deadline] })
  })
})

describe('answers', () => {
  it('knows an answered decision', () => {
    expect(isAnswered(undefined)).toBe(false)
    expect(isAnswered(null)).toBe(false)
    expect(isAnswered({})).toBe(false)
    expect(isAnswered({ chosen: [] })).toBe(false)
    expect(isAnswered({ chosen: [0] })).toBe(true)
    expect(isAnswered({ other: 'x' })).toBe(true)
    expect(isAnswered({ text: 'x' })).toBe(true)
    expect(isAnswered({ skipped: true })).toBe(true)
  })
  it('finds the first unanswered decision, -1 when all are', () => {
    expect(firstUnanswered([pagination, parts], undefined)).toBe(0)
    expect(firstUnanswered([pagination, parts], [{ chosen: [0] }])).toBe(1)
    expect(firstUnanswered([pagination, parts], [{ chosen: [0] }, { skipped: true }])).toBe(-1)
  })
  it('labels each kind of answer', () => {
    expect(answerLabel(pagination, { chosen: [1] })).toBe('Scroll infinito')
    expect(answerLabel(parts, { chosen: [2, 0] })).toBe('Nó tag, declaredTagIds')
    expect(answerLabel(parts, { chosen: [0], other: 'o chip' })).toBe('Nó tag, Outra coisa: o chip')
    expect(answerLabel(pagination, { other: 'os dois' })).toBe('Outra coisa: os dois')
    expect(answerLabel(deadline, { text: 'sexta' })).toBe('sexta')
    expect(answerLabel(deadline, { skipped: true })).toBe('(pulou)')
  })
  it('reads a step written by hand as another step, not as something else', () => {
    const steps: Decision = { question: 'E agora?', kind: 'multiple', nextSteps: true, options: [{ label: 'Rodar a suíte' }, { label: 'Publicar as capturas' }] }
    expect(answerLabel(steps, { chosen: [0], other: 'Escrever a nota de lançamento' })).toBe('Rodar a suíte, Outro passo: Escrever a nota de lançamento')
    expect(answerLabel(steps, { other: 'Escrever a nota de lançamento' })).toBe('Outro passo: Escrever a nota de lançamento')
  })
  it('formats one line per answered decision and leaves the unanswered out', () => {
    expect(formatAnswers([pagination, parts, deadline], [{ chosen: [0] }, null, { skipped: true }])).toBe('- Paginação no menu? → Busca remota\n- Pra quando? → (pulou)')
    expect(formatAnswers([pagination], undefined)).toBe('')
  })
})

describe('headline and description', () => {
  it('headlines the first question, with how many more', () => {
    expect(questionHeadline([deadline])).toBe('Pra quando?')
    expect(questionHeadline([pagination, parts, deadline])).toBe('Paginação no menu? (+2)')
  })
  it('describes the decisions for the agent context, a lone text question exactly as before', () => {
    expect(describeQuestions([deadline])).toBe('Pra quando?')
    expect(describeQuestions([pagination, deadline])).toBe('1. Paginação no menu? (Busca remota | Scroll infinito); 2. Pra quando?')
  })
})

describe('questionsAsText', () => {
  it('is the question alone for one decision, and a numbered line each for more', () => {
    expect(questionsAsText([deadline])).toBe('Pra quando?')
    expect(questionsAsText([pagination, deadline])).toBe('1. Paginação no menu? (Busca remota | Scroll infinito)\n2. Pra quando?')
  })
})

describe('lengths', () => {
  it('refuses a long question, a long label or a long description, and says where the context goes', () => {
    const long = (n: number): string => 'x'.repeat(n)
    const result = parseQuestions({ questions: [{ question: long(201), kind: 'text' }] })
    expect('error' in result && result.error).toMatch(/texto da (sua )?resposta/)
    expect('error' in parseQuestions({ question: long(201) })).toBe(true)
    expect('error' in parseQuestions({ questions: [{ question: 'x', kind: 'single', options: [{ label: long(81) }, { label: 'b' }] }] })).toBe(true)
    expect('error' in parseQuestions({ questions: [{ question: 'x', kind: 'single', options: [{ label: 'a', description: long(201) }, { label: 'b' }] }] })).toBe(true)
    expect('error' in parseQuestions({ questions: [{ question: long(200), kind: 'single', options: [{ label: long(80), description: long(200) }, { label: 'b' }] }] })).toBe(false)
  })
})

describe('a lone text question', () => {
  it('is answered with the answer alone, as before decisions', () => {
    expect(formatAnswers([deadline], [{ text: 'sexta' }])).toBe('sexta')
    expect(formatAnswers([deadline], [{ skipped: true }])).toBe('(pulou)')
    expect(formatAnswers([pagination], [{ chosen: [0] }])).toBe('- Paginação no menu? → Busca remota')
  })
})
