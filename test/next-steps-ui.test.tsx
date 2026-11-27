// The next-steps card: a to-do, not a menu. The card says what it is.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Decision } from '../src/shared/questions'
import { AskCard, cardAnswers, ReplacedStepsCard } from '../src/renderer/src/components/Decisions'
import type { Message } from '../src/shared/types'

vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  // The card reads the store (the microphone, as in the message box): the state as it starts, without a React store behind it.
  return { ...real, answerDecision: () => {}, submitDecisions: async () => {}, useStore: <T,>(select: (s: ReturnType<typeof real.getState>) => T): T => select(real.getState()) }
})

const steps = (): Decision[] => [
  {
    question: 'O que vem agora?',
    kind: 'multiple',
    nextSteps: true,
    options: [{ label: 'Rodar a suíte inteira' }, { label: 'Traduzir os rótulos novos' }, { label: 'Escrever o teste do card' }, { label: 'Publicar as capturas' }]
  }
]

const question = (): Decision[] => [{ question: 'Paginação no menu?', kind: 'multiple', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }]

const card = (questions: Decision[], mode: 'answer' | 'view' | 'done' = 'answer'): string =>
  renderToStaticMarkup(<AskCard id="m1" questions={questions} mode={mode} badge="Esperando você" />)

const count = (html: string, text: string): number => html.split(text).length - 1

describe('the next-steps card', () => {
  it('opens with nothing ticked and Do these disabled, and says so', () => {
    const html = card(steps())
    expect(count(html, 'aria-checked="true"')).toBe(0)
    expect(count(html, 'aria-checked="false"')).toBe(4)
    expect(html).toContain('Próximos passos')
    expect(html).toContain('ask--steps')
    expect(html).toContain('nada começa marcado')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Fazer estes/)
    // A step can still be written by hand, and Cancel is the only way to wave it off.
    expect(html).toContain('Outro passo…')
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Cancelar/)
    expect(html).not.toContain('Pular')
  })

  it('keeps Skip on a plain question', () => {
    const html = card(question())
    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Pular/)
    expect(html).toContain('Cancelar')
  })

  it('reads as replaced once a newer card took its place, with nothing to click', () => {
    const message: Message = { id: 'm1', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: '', at: 1, run: { status: 'done', steps: [], depth: 1, questions: steps(), stepsReplaced: true } }
    const html = renderToStaticMarkup(<ReplacedStepsCard message={message} />)
    expect(html).toContain('Substituído')
    expect(html).toContain('substituído por um card mais novo')
    expect(html).toContain('ask--done')
    expect(html).not.toContain('Respondida')
    expect(html).not.toContain('Cancelada')
    expect(html).not.toContain('role="checkbox"')
    expect(html).not.toContain('Fazer estes')
  })

  it('sends them as a to-do: "Do these", not "Send"', () => {
    const html = card(steps())
    expect(html).toContain('Fazer estes')
    expect(html).not.toContain('>Enviar<')
  })

  it('leaves a plain question exactly as it was: nothing ticked, no pill, "Send"', () => {
    const html = card(question())
    expect(count(html, 'aria-checked="true"')).toBe(0)
    expect(html).not.toContain('Próximos passos')
    expect(html).not.toContain('ask--steps')
    expect(html).toContain('Enviar')
  })

  it('keeps the steps in the card once they are answered', () => {
    const html = renderToStaticMarkup(<AskCard id="m1" questions={steps()} saved={[{ chosen: [0, 3] }]} mode="done" badge="Respondida" />)
    expect(html).toContain('Rodar a suíte inteira')
    expect(html).toContain('Publicar as capturas')
    expect(html).toContain('Próximos passos')
  })

  it('hides the message a card sent only when it comes right after the card', () => {
    const at = (id: string, kind: 'agent' | 'person', run?: Message['run']): Message => ({ id, conversationId: 'c', author: { kind, id: 'x' }, text: id, at: 1, ...(run ? { run } : {}) })
    const answered = (answerMessage: string): Message['run'] => ({ status: 'done', steps: [], depth: 1, questions: steps(), answerMessage })
    expect(cardAnswers([at('card', 'agent', answered('sent')), at('sent', 'person')]).has('sent')).toBe(true)
    // The person wrote something else first: what the card sent stays visible, with its reply under it.
    expect(cardAnswers([at('card', 'agent', answered('sent')), at('other', 'person'), at('reply', 'agent'), at('sent', 'person')]).has('sent')).toBe(false)
  })

  it('reads a step written by hand as another step, on the card as in the message', () => {
    const html = renderToStaticMarkup(<AskCard id="m1" questions={steps()} saved={[{ chosen: [0], other: 'Escrever a nota de lançamento' }]} mode="done" badge="Respondida" />)
    expect(html).toContain('Outro passo: Escrever a nota de lançamento')
    expect(html).not.toContain('Outra coisa')
  })
})
