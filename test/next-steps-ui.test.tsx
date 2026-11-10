// The next-steps card: a to-do, not a menu. Every box starts ticked (or the ones Jev picked), and
// the card says what it is — while a question keeps opening with nothing chosen.
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

const card = (questions: Decision[], mode: 'answer' | 'view' | 'done' = 'answer'): string =>
  renderToStaticMarkup(<AskCard id="m1" questions={questions} mode={mode} badge="Esperando você" />)

const count = (html: string, text: string): number => html.split(text).length - 1

describe('the next-steps card', () => {
  it('opens with every box ticked, and says so', () => {
    const html = card(steps())
    expect(count(html, 'aria-checked="true"')).toBe(4)
    expect(html).toContain('Próximos passos')
    expect(html).toContain('ask--steps')
    expect(html).toContain('todas começam marcadas')
  })

  it('ticks only the steps Jev found worth doing now', () => {
    const html = card(steps([0, 2]))
    expect(count(html, 'aria-checked="true"')).toBe(2)
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Rodar a suíte inteira/s)
    expect(html).toMatch(/aria-checked="true"[^>]*>.*?Escrever o teste do card/s)
    expect(html).toMatch(/aria-checked="false"[^>]*>.*?Traduzir os rótulos novos/s)
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
})
