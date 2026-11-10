// The providers panel in Usage and limits: one column per provider, the same three rows in each,
// the numbers the provider gave, and a column that says why it has nothing instead of vanishing.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ProviderQuota } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })

let reply: ProviderQuota[] = []
let reported: { fiveHour?: { utilization: number; resetsAt: number }; sevenDay?: { utilization: number; resetsAt: number }; at: number } | undefined
const loadQuotas = vi.fn(async () => reply)
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ settings: { quota: reported } }),
  amAdmin: () => true,
  loadQuotas: () => loadQuotas(),
  agentById: () => undefined,
  countedTokens: () => 0,
  ENGINES: {},
  isTeam: () => false,
  loadUsage: async () => null,
  messageById: () => undefined,
  modelInfo: () => undefined,
  navigate: () => undefined,
  receipts: () => []
}))
vi.mock('../src/renderer/src/components/ui', () => ({
  AgentAvatar: () => null,
  duration: (ms: number) => `${ms}`,
  Icon: () => null,
  tokens: (n: number) => `${Math.round(n)}`,
  usd: (v: number) => `$${v.toFixed(2)}`
}))
vi.mock('../src/renderer/src/components/Pages', () => ({ Sheet: ({ children }: { children?: unknown }) => children }))
vi.mock('../src/renderer/src/components/People', () => ({ AdminOnly: ({ children }: { children?: unknown }) => children }))

const { createRoot } = await import('react-dom/client')
const { Quotas } = await import('../src/renderer/src/components/Usage')

let root: ReturnType<typeof createRoot>
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(async () => {
  reply = []
  reported = undefined
  loadQuotas.mockClear()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => await act(async () => root.unmount()))

const render = async (): Promise<void> => {
  await act(async () => root.render(<Quotas />))
  await flush()
}
const heads = (): Element[] => [...document.querySelectorAll('.usage-quota__head')]
const cells = (): Element[] => [...document.querySelectorAll('.usage-quota__cell')]

const quota = (over: Partial<ProviderQuota>): ProviderQuota => ({ id: 'openai-codex', label: 'Codex', via: 'Codex', at: Date.now(), ...over })

it('draws one column per provider and the same three rows in each', async () => {
  reply = [
    quota({ session: { used: 0.42, remaining: 0.58, limit: 1, unit: '%' }, week: { used: 0.1, remaining: 0.9, limit: 1, unit: '%' } }),
    quota({ id: 'opencode-go', label: 'OpenCode Go', via: 'Pi', session: { used: 0.2, remaining: 0.8, limit: 1, unit: '%' }, week: { used: 0.55, remaining: 0.45, limit: 1, unit: '%' }, month: { used: 0.1, remaining: 0.9, limit: 1, unit: '%' } })
  ]
  await render()
  expect(heads().map((h) => h.textContent)).toEqual(['CodexCodex', 'OpenCode GoPi'])
  // Three rows of provider cells, and no more: a missing window keeps its place.
  expect(cells()).toHaveLength(6)
  expect(document.querySelectorAll('.usage-quotas__row')).toHaveLength(3)
  expect(loadQuotas).toHaveBeenCalledTimes(1)
})

it('shows what the provider says is left, and the bar for it', async () => {
  reply = [quota({ session: { used: 0.42, remaining: 0.58, limit: 1, unit: '%' }, week: { used: 1, remaining: 0, limit: 1, unit: '%', resetsAt: Date.now() + 3_600_000 } })]
  await render()
  const [session, week, month] = cells()
  expect(session!.textContent).toContain('58%')
  expect(session!.querySelector('.usage-quota__track i')!.getAttribute('style')).toContain('width:58%')
  expect(week!.textContent).toContain('0%')
  expect(week!.className).toContain('is-danger')
  expect(month!.className).toContain('is-empty')
})

it('keeps a column whose provider could not be read, and says why there', async () => {
  reply = [quota({ error: 'The login expired. Sign in again through that tool.' }), quota({ id: 'zai', label: 'Z.ai', via: 'Pi', session: { used: 0.3, remaining: 0.7, limit: 1, unit: '%' } })]
  await render()
  expect(heads()).toHaveLength(2)
  expect(heads()[0]!.className).toContain('is-off')
  expect(heads()[0]!.textContent).toContain('expired')
  expect(cells()[0]!.textContent).toContain('—')
  expect(cells()[1]!.textContent).toContain('70%')
})

it('shows a balance in its own money, with no bar invented for it', async () => {
  reply = [quota({ id: 'openrouter', label: 'OpenRouter', via: 'Hermes', month: { remaining: 15, limit: 20, used: 0.25, unit: 'usd' } })]
  await render()
  expect(document.body.textContent).toContain('$15.00')
  expect(document.querySelectorAll('.usage-quota__track')).toHaveLength(1)
})

it('fills the Claude column from the last reply when its credentials are not on disk', async () => {
  reported = { fiveHour: { utilization: 0.34, resetsAt: Date.now() + 3_600_000 }, sevenDay: { utilization: 0.21, resetsAt: Date.now() + 86_400_000 }, at: Date.now() }
  reply = []
  await render()
  expect(heads()).toHaveLength(1)
  expect(heads()[0]!.textContent).toContain('Claude Code')
  expect(cells()[0]!.textContent).toContain('66%')
  expect(cells()[1]!.textContent).toContain('79%')
})

it('says where it looks when there is no login at all', async () => {
  await render()
  expect(heads()).toHaveLength(0)
  expect(document.body.textContent).toMatch(/Nenhum login|No login/)
})

it('reads again on demand', async () => {
  await render()
  const button = [...document.querySelectorAll('button')].find((b) => /Ler de novo|Read again/.test(b.textContent ?? ''))!
  await act(async () => button.dispatchEvent(new window.Event('click', { bubbles: true })))
  await flush()
  expect(loadQuotas).toHaveBeenCalledTimes(2)
})
