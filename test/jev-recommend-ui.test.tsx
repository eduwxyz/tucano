// Jev's pick on the card a person answers: a pill on one option, never a tick, and nothing at all
// when it isn't on or hasn't answered yet.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Decision } from '../src/shared/questions'
import { AskCard } from '../src/renderer/src/components/Decisions'

vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, answerDecision: () => {}, submitDecisions: async () => {} }
})

const decisions = (): Decision[] => [
  { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito', description: 'mais simples' }] },
  { question: 'Pra quando?', kind: 'text' }
]

const card = (recommended?: (number | null)[], mode: 'answer' | 'view' = 'answer'): string =>
  renderToStaticMarkup(<AskCard id="m1" questions={decisions()} mode={mode} badge="Esperando você" {...(recommended ? { recommended } : {})} />)

const count = (html: string, text: string): number => html.split(text).length - 1

describe('the recommended option', () => {
  it('marks the option Jev picked, and only that one', () => {
    const html = card([1, null])
    expect(count(html, 'Recomendado')).toBe(1)
    expect(html).toMatch(/Scroll infinito<\/span><span class="ask-option__pill">Recomendado<\/span>/)
    expect(html).not.toContain('Busca remota</span><span class="ask-option__pill"')
  })

  it('leaves the card as it was without a pick, or before Jev answers', () => {
    expect(card()).not.toContain('ask-option__pill')
    expect(card([null, null])).not.toContain('ask-option__pill')
  })

  it('never ticks the option it suggests: it is a hint, not an answer', () => {
    const html = card([1, null])
    expect(html).not.toContain('aria-checked="true"')
    expect(html).not.toContain('is-on')
  })

  it('shows on a card someone else answers, to read', () => {
    const html = card([1, null], 'view')
    expect(count(html, 'Recomendado')).toBe(1)
    expect(html).toMatch(/Scroll infinito<\/span><span class="ask-option__pill">Recomendado<\/span>/)
  })
})
