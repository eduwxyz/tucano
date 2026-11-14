// The resolve button of a finding in Care: offered only where the resolver can do something, saying
// what it is doing while it reads, and showing what came back underneath.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WikiFinding, WikiReview } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
// the change card folds a long diff by measuring it: nothing to measure here
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} disconnect(): void {} } })

const asked: { method: string; params: unknown }[] = []
let answer: { resolved: boolean; note?: string; gone?: boolean } = { resolved: true }
vi.mock('../src/renderer/src/rpc', () => ({
  call: (method: string, params?: unknown) => {
    asked.push({ method, params })
    if (method === 'wikiReview') return Promise.resolve(review)
    if (method === 'wikiResolveFinding') return Promise.resolve(answer)
    return Promise.resolve(undefined)
  }
}))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { WikiReviewPane } = await import('../src/renderer/src/components/Wiki')

const finding = (over: Partial<WikiFinding>): WikiFinding => ({ id: 'f1', at: Date.now(), kind: 'contradiction', pages: ['Reforma do apto 302'], text: 'Uma página diz que espera resposta, a outra que começou.', ...over })
let review: WikiReview = { running: false, findings: [] }

let root: Root
const pane = async (): Promise<void> => {
  await act(async () => {
    root = createRoot(document.getElementById('root')!)
    root.render(<WikiReviewPane />)
  })
}
const buttons = (): string[] => [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim())
const click = async (label: string): Promise<void> => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').includes(label))
  if (!b) throw new Error(`no button ${label} in ${buttons().join(' | ')}`)
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
}

beforeEach(() => {
  const base = getState()
  fake = { ...base, ready: true, settings: { ...base.settings, wikiResolve: true, wikiEdits: 'approve' } }
  answer = { resolved: true }
  asked.length = 0
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.getElementById('root')!.innerHTML = ''
})

describe('the resolver in Care', () => {
  it("offers Resolve on a finding with no fix, and not on one that already has it nor on the git one", async () => {
    review = {
      running: false,
      findings: [
        finding({ id: 'f1' }),
        finding({ id: 'f2', kind: 'stale', text: 'A obra começou.', change: { id: 'c1', at: Date.now(), by: 'review', state: 'pending', ops: [{ op: 'append', page: 'Reforma do apto 302', section: 'Situação', text: 'Começou.' }] } }),
        finding({ id: 'f3', kind: 'git', text: 'A sincronização parou.' })
      ]
    }
    await pane()
    const html = document.getElementById('root')!.innerHTML
    // one Resolve, for the one finding that has neither a fix nor the repository behind it
    expect(buttons().filter((b) => b === 'Resolver')).toHaveLength(1)
    expect(html).toContain('Uma página diz que espera resposta')
    expect(buttons()).toContain('Deixar assim')
  })

  it('asks the resolver, says it is reading, and shows the question it came back with', async () => {
    review = { running: false, findings: [finding({ id: 'f1' })] }
    let done: (v: unknown) => void = () => {}
    answer = new Promise((res) => (done = res)) as unknown as typeof answer
    await pane()
    await click('Resolver')
    expect(asked.some((a) => a.method === 'wikiResolveFinding' && (a.params as { id: string }).id === 'f1')).toBe(true)
    expect(buttons().some((b) => b.includes('Resolvendo'))).toBe(true)
    await act(async () => done?.({ resolved: false, note: 'O orçamento foi aprovado ou ainda espera resposta?' }))
    const html = document.getElementById('root')!.innerHTML
    expect(html).toContain('O orçamento foi aprovado ou ainda espera resposta?')
    expect(buttons()).toContain('Resolver')
  })

  it('when the resolver is off, says where to turn it on instead of a dead button', async () => {
    fake = { ...fake, settings: { ...fake.settings, wikiResolve: false } }
    review = { running: false, findings: [finding({ id: 'f1' })] }
    await pane()
    expect(buttons()).not.toContain('Resolver')
    expect(document.getElementById('root')!.innerHTML).toMatch(/Ajustes da wiki|Wiki settings/)
  })

  it('shows what the resolver could not settle next to the finding', async () => {
    review = { running: false, findings: [finding({ id: 'f1', note: 'As duas páginas parecem certas: qual das duas vale?' })] }
    await pane()
    expect(document.getElementById('root')!.innerHTML).toContain('qual das duas vale?')
  })
})
