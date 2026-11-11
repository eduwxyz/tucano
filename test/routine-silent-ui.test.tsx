// A routine's reply with nothing to report, on screen: one quiet line, closed, and no text.
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Message, Step } from '../src/shared/types'

vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: Record<string, unknown>) => T): T => select({}) }
})
const { RunSteps } = await import('../src/renderer/src/components/Conversation')

const step = (i: number): Step => ({ id: `s${i}`, label: `Passo ${i}`, status: 'done', ms: 1000 })
const reply = (extra: Partial<Message['run']> = {}, steps = 3): Message => ({
  id: 'r1',
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: '',
  at: Date.now() - 4000,
  run: { status: 'done', steps: Array.from({ length: steps }, (_, i) => step(i + 1)), ...extra }
})

describe("a routine's empty reply", () => {
  it('is one quiet line saying there was nothing to report, with the steps closed', () => {
    const html = renderToStaticMarkup(<RunSteps message={reply({ silent: true })} />)
    expect(html).toContain('Nada a informar')
    expect(html).toContain('3 passos')
    expect(html).not.toContain('steps__list') // closed: a click opens what it did
    expect(html).not.toContain('Pronto') // it isn't "done" noise either
  })

  it('shows even when the run left no steps at all', () => {
    const html = renderToStaticMarkup(<RunSteps message={reply({ silent: true }, 0)} />)
    expect(html).toContain('Nada a informar')
    expect(html).not.toContain('passo')
  })

  it("a reply that said something is drawn as it always was", () => {
    const html = renderToStaticMarkup(<RunSteps message={reply()} />)
    expect(html).toContain('Pronto · 3 passos')
    expect(html).not.toContain('Nada a informar')
  })
})
