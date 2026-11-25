// Execuções, in Uso e limites: what an admin sees and does with it.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Conversation, ExecutionPage, ExecutionRow, ExecutionStep, Message, Person, Report } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const loadExecutions = vi.fn<(q: { days: number; agentId?: string; status?: string; beforeAt?: number; beforeId?: string }) => Promise<ExecutionPage>>()
const loadExecutionSteps = vi.fn<(id: string) => Promise<ExecutionStep[]>>()
const navigate = vi.fn()
const loadReport = vi.fn<() => Promise<Report>>()
const loadUsage = vi.fn<() => Promise<unknown>>()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, navigate: (v: unknown) => navigate(v), loadExecutions: (q: never) => loadExecutions(q), loadExecutionSteps: (id: string) => loadExecutionSteps(id), loadReport: () => loadReport(), loadUsage: () => loadUsage() }
})

const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Executions } = await import('../src/renderer/src/components/Executions')
const { ReportPage, ToolsSection } = await import('../src/renderer/src/components/Report')
const { UsagePage } = await import('../src/renderer/src/components/Usage')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, grants: {} } as unknown as Agent
const channel: Conversation = { id: 'c1', kind: 'channel', name: 'geral', members: ['a1'] }
const row = (id: string, extra: Partial<ExecutionRow> = {}): ExecutionRow => ({ id, conversationId: 'c1', agentId: 'a1', preview: `resposta ${id}`, status: 'done', at: Date.now() - 60_000, model: 'opus', ms: 9400, tokens: 6000, tools: 2, ...extra })
const page = (rows: ExecutionRow[], extra: Partial<ExecutionPage> = {}): ExecutionPage => ({ rows, count: rows.length, p50: 9400, p95: 41_000, errorRate: 0.021, ...extra })

let root: Root
const text = (): string => document.getElementById('root')!.textContent ?? ''
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name)
  if (!found) throw new Error(`no button "${name}" in: ${text()}`)
  return found as unknown as HTMLButtonElement
}
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => void el.dispatchEvent(new window.Event('click', { bubbles: true })))
}
const render = async (node: React.ReactNode): Promise<void> => {
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host as unknown as Element)
  await act(async () => root.render(node))
}

beforeEach(() => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  vi.clearAllMocks()
  loadExecutions.mockResolvedValue(page([row('r1')]))
  fake = { ...real.getState(), ready: true, people: [ana], you: 'ana', agents: [lia], conversations: [channel], messages: {} } as State
})
afterEach(async () => {
  await act(async () => root.unmount())
})

describe('Executions', () => {
  it('opens on the last 24 hours, with the numbers and a row for each reply', async () => {
    await render(<Executions />)

    expect(loadExecutions).toHaveBeenCalledWith({ days: 1 })
    for (const shown of ['p50', '9s', 'p95', '41s', '2.1%', 'Lia', 'resposta r1', '#geral', '6k']) expect(text()).toContain(shown)
  })

  it('narrows by period and status, asking the core again', async () => {
    await render(<Executions />)

    await click(button('7 days'))
    expect(loadExecutions).toHaveBeenLastCalledWith({ days: 7 })
    await click(button('Failed'))
    expect(loadExecutions).toHaveBeenLastCalledWith({ days: 7, status: 'failed' })
  })

  it('starts on the filter a link brought it', async () => {
    await render(<Executions filter={{ agentId: 'a1', days: 7 }} />)

    expect(loadExecutions).toHaveBeenCalledWith({ days: 7, agentId: 'a1' })
  })

  it('opens a row into its steps, with time, error and the way to the conversation', async () => {
    loadExecutionSteps.mockResolvedValue([
      { id: 's1', label: 'Ran', detail: 'npm test', tool: 'bash', status: 'done', ms: 48_000 },
      { id: 's2', label: 'Ran', detail: 'npm run lint', tool: 'bash', status: 'error', ms: 9000, error: 'exit code 1' }
    ])
    await render(<Executions />)

    await click(document.querySelector('button.usage-receipt') as unknown as HTMLElement)

    expect(loadExecutionSteps).toHaveBeenCalledWith('r1')
    for (const shown of ['npm test', '48s', 'npm run lint', 'exit code 1']) expect(text()).toContain(shown)
    await click(button('Open in conversation'))
    expect(navigate).toHaveBeenCalledWith({ kind: 'conversation', id: 'c1', message: 'r1' })
  })

  it('shows a step that never closed with no time and no bar', async () => {
    loadExecutionSteps.mockResolvedValue([{ id: 's1', label: 'Ran', detail: 'npm test', tool: 'bash', status: 'running' }])
    await render(<Executions />)

    await click(document.querySelector('button.usage-receipt') as unknown as HTMLElement)

    const step = document.querySelector('.exec-step')!
    expect(step.textContent).toContain('—')
    expect(step.querySelector('.exec-step__bar i')).toBeNull()
  })

  it('says so when a reply used no tools', async () => {
    loadExecutionSteps.mockResolvedValue([])
    await render(<Executions />)

    await click(document.querySelector('button.usage-receipt') as unknown as HTMLElement)

    expect(text()).toContain('No tools used.')
  })

  it('loads the next page after the last row, keeping what it had', async () => {
    loadExecutions.mockResolvedValueOnce(page([row('r1', { at: 500 })], { count: 2, next: { at: 500, id: 'r1' } }))
    loadExecutions.mockResolvedValueOnce(page([row('r2', { at: 400 })], { count: 2 }))
    await render(<Executions />)

    await click(button('Show more'))

    expect(loadExecutions).toHaveBeenLastCalledWith({ days: 1, beforeAt: 500, beforeId: 'r1' })
    expect(text()).toContain('resposta r1')
    expect(text()).toContain('resposta r2')
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Show more')).toBe(false)
  })

  it('drops the numbers of the filter it left when the new one can’t load', async () => {
    await render(<Executions />)
    loadExecutions.mockRejectedValueOnce(new Error('offline'))

    await click(button('Failed'))

    expect(text()).toContain("Couldn't load the executions.")
    expect(text()).not.toContain('resposta r1')
  })

  it('with nothing in the period, says so and shows a dash for the numbers', async () => {
    loadExecutions.mockResolvedValue({ rows: [], count: 0 })
    await render(<Executions />)

    expect(text()).toContain('No executions in this period.')
    expect(text()).toContain('—')
  })

  it('keeps listing a reply whose agent was deleted, and one that never reported tokens', async () => {
    loadExecutions.mockResolvedValue(page([row('gone', { agentId: 'deleted', status: 'failed', tokens: undefined, model: undefined })]))
    await render(<Executions />)

    expect(text()).toContain('Deleted agent')
    expect(text()).toContain('Failed')
  })

  it('catches up with a burst of new replies in one request', async () => {
    vi.useFakeTimers()
    try {
      await render(<Executions refresh={1} />)
      loadExecutions.mockClear()

      for (const refresh of [2, 3, 4]) await act(async () => root.render(<Executions refresh={refresh} />))
      expect(loadExecutions).not.toHaveBeenCalled()
      await act(async () => void vi.advanceTimersByTime(3000))

      expect(loadExecutions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is in Portuguese too', async () => {
    setLang('pt')
    await render(<Executions />)

    for (const shown of ['Execuções', '7 dias', 'Falhas', 'taxa de erro']) expect(text().toLowerCase()).toContain(shown.toLowerCase())
  })
})

describe('getting to Executions', () => {
  const usage = { monthStart: Date.now() - 86_400_000, daysInMonth: 30, total: 100, replies: 1, apiUsd: 0, avgMs: 1000, days: [{ a1: 100 }], who: [{ id: 'a1', tokens: 100, replies: 1, avgMs: 1000 }], models: [] }
  const report: Report = {
    since: Date.now() - 86_400_000,
    until: Date.now() + 86_400_000,
    agents: [{ agentId: 'a1', total: { replies: 2, ok: 1 }, failed: 1, cut: 0, paused: 0, approvals: { asked: 0, refused: 0 }, avgTokens: 10, avgMs: 1000, problems: [], weeks: [] }],
    skills: [],
    work: [],
    tools: []
  }

  it('from a Report agent’s card, opens that agent’s last 7 days', async () => {
    loadReport.mockResolvedValue(report)
    await render(<ReportPage />)
    expect(text()).toContain('Lia') // the card it always had

    await click(button('See executions →'))

    expect(navigate).toHaveBeenCalledWith({ kind: 'usage', executions: { agentId: 'a1', days: 7 } })
  })

  it('in Usage and limits, replaces the old receipts, and starts on the filter the link brought', async () => {
    loadUsage.mockResolvedValue(usage)
    fake = { ...fake, view: { kind: 'usage', executions: { agentId: 'a1', days: 7 } } }
    await render(<UsagePage />)

    expect(loadExecutions).toHaveBeenCalledWith({ days: 7, agentId: 'a1' })
    expect(text()).toContain('See executions')
    expect(text()).toContain('Executions')
    expect(text()).not.toContain('Recent receipts')
    for (const kept of ['By agent', 'By model', 'Behind the scenes']) expect(text()).toContain(kept)
  })

  it('is in Portuguese on the Report and in Usage too', async () => {
    setLang('pt')
    loadReport.mockResolvedValue({ ...report, tools: [{ tool: 'bash', uses: 3, p95: 1000, errorRate: 0 }] })
    loadUsage.mockResolvedValue(usage)
    await render(<ReportPage />)
    for (const shown of ['Ver execuções →', 'Ferramentas', 'Usos', 'Erros']) expect(text()).toContain(shown)
    await act(async () => root.unmount())

    await render(<UsagePage />)

    expect(text()).toContain('Ver execuções')
  })

  it('in Usage and limits, catches up when a reply ends without a receipt', async () => {
    vi.useFakeTimers()
    try {
      loadUsage.mockResolvedValue(usage)
      const working = { id: 'w1', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: Date.now(), run: { status: 'working', steps: [] } } as Message
      fake = { ...fake, view: { kind: 'usage' }, messages: { c1: [working] } }
      await render(<UsagePage />)
      loadExecutions.mockClear()

      fake = { ...fake, messages: { c1: [{ ...working, run: { status: 'failed', steps: [], endedAt: Date.now() } }] } }
      await act(async () => root.render(<UsagePage />))
      await act(async () => void vi.advanceTimersByTime(3000))

      expect(loadExecutions).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never asks for them on behalf of a member', async () => {
    fake = { ...fake, people: [{ ...ana, role: 'member' }] }
    await render(<Executions />)

    expect(loadExecutions).not.toHaveBeenCalled()
  })
})

describe('the Report’s tools', () => {
  it('lists each tool with its uses, p95 and error rate', async () => {
    const tools: Report['tools'] = [{ tool: 'bash', uses: 312, p95: 18_000, errorRate: 0.042 }, { tool: 'web_search', uses: 96, errorRate: 0 }]
    await render(<ToolsSection tools={tools} />)

    for (const shown of ['Tools', 'bash', '312', '18s', '4.2%', 'web_search', '96', '0%']) expect(text()).toContain(shown)
  })

  it('says when there is nothing to show yet', async () => {
    await render(<ToolsSection tools={[]} />)

    expect(text()).toContain('Tools show up here as replies use them.')
  })
})
