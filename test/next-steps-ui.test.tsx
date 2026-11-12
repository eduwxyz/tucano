// The next-steps card: a to-do, not a menu — and it opens the way a question does, with nothing
// ticked. The only boxes that come ticked are the ones a classifier assigned to the job said are
// worth doing now, and those also wear the Recommended pill.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Decision } from '../src/shared/questions'
import { AskCard } from '../src/renderer/src/components/Decisions'

vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, answerDecision: () => {}, submitDecisions: async () => {} }
})

const steps = (ticked?: number[]): Decision[] => [
  {
    question: 'O que vem agora?',
    kind: 'multiple',
    nextSteps: true,
    options: [{ label: 'Rodar a suíte inteira' }, { label: 'Traduzir os rótulos novos' }, { label: 'Escrever o teste do card' }, { label: 'Publicar as capturas' }],
    ...(ticked ? { ticked } : {})
  }
]

const question = (): Decision[] => [{ question: 'Paginação no menu?', kind: 'multiple', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }] }]

const card = (questions: Decision[], mode: 'answer' | 'view' | 'done' = 'answer', recommended?: (number | null)[]): string =>
  renderToStaticMarkup(<AskCard id="m1" questions={questions} mode={mode} badge="Esperando você" recommended={recommended} />)

const count = (html: string, text: string): number => html.split(text).length - 1

describe('the next-steps card', () => {
  it('opens with every box clear, says so, and keeps "Do these" disabled until something is ticked', () => {
    const html = card(steps())
    expect(count(html, 'aria-checked="true"')).toBe(0)
    expect(html).toContain('Próximos passos')
    expect(html).toContain('ask--steps')
    expect(html).toContain('nada começa marcado')
    expect(html).toContain('disabled=""')
  })

  it('ticks only the steps the classifier found worth doing now, and marks those Recommended', () => {
    const html = card(steps([0, 2]))
    expect(count(html, 'aria-checked="true"')).toBe(2)
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Rodar a suíte inteira/s)
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Escrever o teste do card/s)
    expect(html).toMatch(/aria-checked="false"[^>]*>.*?Traduzir os rótulos novos/s)
    // Two boxes open ticked because the classifier picked them, and it says so on the card.
    expect(count(html, 'Recomendado')).toBe(2)
    expect(html).not.toContain('disabled=""')
  })

  it('sends them as a to-do: "Do these", not "Send"', () => {
    const html = card(steps([0]))
    expect(html).toContain('Fazer estes')
    expect(html).not.toContain('>Enviar<')
  })

  it('leaves a plain question exactly as it was: nothing ticked, no pill, "Send"', () => {
    const html = card(question())
    expect(count(html, 'aria-checked="true"')).toBe(0)
    expect(html).not.toContain('Próximos passos')
    expect(html).not.toContain('ask--steps')
    expect(html).not.toContain('Recomendado')
    expect(html).toContain('Enviar')
  })

  it('keeps the steps in the card once they are answered', () => {
    const html = renderToStaticMarkup(<AskCard id="m1" questions={steps()} saved={[{ chosen: [0, 3] }]} mode="done" badge="Respondida" />)
    expect(html).toContain('Rodar a suíte inteira')
    expect(html).toContain('Publicar as capturas')
    expect(html).toContain('Próximos passos')
  })

  it('reads a step written by hand as another step, on the card as in the message', () => {
    const html = renderToStaticMarkup(<AskCard id="m1" questions={steps()} saved={[{ chosen: [0], other: 'Escrever a nota de lançamento' }]} mode="done" badge="Respondida" />)
    expect(html).toContain('Outro passo: Escrever a nota de lançamento')
    expect(html).not.toContain('Outra coisa')
  })
})
