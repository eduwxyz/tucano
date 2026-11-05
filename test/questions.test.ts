import { describe, expect, it } from 'vitest'
import {
  answerLabel,
  describeQuestions,
  firstUnanswered,
  formatAnswers,
  isAnswered,
  parseQuestions,
  questionHeadline,
  questionsAsText,
  questionsOf,
  type Question
} from '../src/shared/questions'

const pagination: Question = { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }
const parts: Question = { question: 'O que remover?', kind: 'multiple', options: [{ label: 'Nó tag' }, { label: 'getUsedTags' }, { label: 'declaredTagIds' }] }
const deadline: Question = { question: 'Pra quando?', kind: 'text' }

const refused = (args: Record<string, unknown>): boolean => 'error' in parseQuestions(args)

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
    expect(refused({ questions: [{ question: 'x', kind: 'single', options: [{ label: 'a' }] }] })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'multiple', options: [...two, ...two, { label: 'e' }] }] })).toBe(true)
    expect(refused({ questions: [{ question: ' ', kind: 'text' }] })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'single', options: [{ label: 'a' }, { label: ' ' }] }] })).toBe(true)
    expect(refused({ questions: [{ question: 'x', kind: 'dropdown', options: two }] })).toBe(true)
    expect(refused({ question: '  ' })).toBe(true)
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
  it('formats one line per answered decision and leaves the unanswered out', () => {
    expect(formatAnswers([pagination, parts, deadline], [{ chosen: [0] }, null, { skipped: true }])).toBe('Paginação no menu? → Busca remota\nPra quando? → (pulou)')
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
