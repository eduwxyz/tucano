// The little bars in a session's header. What is checked here: one bar per provider, the window it
// draws is the longest the provider reports (month over week over the short one), a wallet with no
// cap draws nothing, the tone follows what is left, a click opens Usage and limits, and reading every
// provider costs one read even when several conversations are opened. What the bars look like and
// where they sit is measured in the built app; linkedom has no layout.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { ProviderQuota } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

let reply: ProviderQuota[] = []
const loadQuotas = vi.fn(async () => reply)
const navigate = vi.fn()
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ settings: {} }),
  amAdmin: () => true,
  loadQuotas: () => loadQuotas(),
  navigate: (view: unknown) => navigate(view),
  agentById: () => undefined,
  countedTokens: () => 0,
  ENGINES: {},
  isTeam: () => false,
  loadUsage: async () => null,
  messageById: () => undefined,
  modelInfo: () => undefined,
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
const { QuotaStrip, forgetQuotaStrip, longest } = await import('../src/renderer/src/components/QuotaStrip')

beforeAll(() => setLang('en'))

let root: Root
const flush = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
beforeEach(() => {
  reply = []
  loadQuotas.mockClear()
  navigate.mockClear()
  forgetQuotaStrip()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => await act(async () => root.unmount()))

const render = async (): Promise<void> => {
  await act(async () => root.render(<QuotaStrip />))
  await flush()
}
const pills = (): HTMLElement[] => [...document.querySelectorAll('.quota-strip__pill')] as HTMLElement[]
const plane = (over: Partial<ProviderQuota>): ProviderQuota => ({ id: 'openai-codex', label: 'Codex', via: 'Codex', at: Date.now(), ...over })
// A window with a cap, as a provider reports it: what is left, out of what it allows.
const pct = (leftOver: number, resetsAt?: number) => ({ used: 1 - leftOver, remaining: leftOver, limit: 1, unit: '%' as const, ...(resetsAt ? { resetsAt } : {}) })

describe('the window it keeps', () => {
  it('keeps the month where there is a month, the week where there is a week', () => {
    expect(longest(plane({ session: pct(0.8), week: pct(0.5), month: pct(0.2) }))?.span).toBe('month')
    expect(longest(plane({ session: pct(0.8), week: pct(0.5) }))?.span).toBe('week')
    expect(longest(plane({ session: pct(0.8) }))?.span).toBe('session')
    expect(longest(plane({ error: 'the login expired' }))).toBeUndefined()
  })

  it('leaves a wallet alone: a balance with no cap has no bar to draw', () => {
    expect(longest(plane({ month: { remaining: 3.42, unit: 'usd' } }))).toBeUndefined()
    expect(longest(plane({ month: { remaining: 0, limit: 0, unit: 'usd' } }))).toBeUndefined()
  })

  it('reads a real zero as a real reading, not as absent', () => {
    const pick = longest(plane({ month: pct(0) }))
    expect(pick?.span).toBe('month')
    expect(pick?.w.remaining).toBe(0)
  })
})

describe('the strip in the header', () => {
  it('draws one bar per provider, in its longest window', async () => {
    reply = [
      plane({ session: pct(0.9), week: pct(0.7), month: pct(0.4) }),
      plane({ id: 'xai-oauth', label: 'Grok', via: 'Hermes', week: pct(0.38) }),
      plane({ id: 'deepseek', label: 'DeepSeek', via: 'Pi', month: { remaining: 3.42, unit: 'usd' } })
    ]
    await render()
    expect(pills().map((p) => [p.dataset.provider, p.dataset.span])).toEqual([
      ['openai-codex', 'month'],
      ['xai-oauth', 'week']
    ])
  })

  it('draws nothing at all when no provider has a cap', async () => {
    reply = [plane({ id: 'deepseek', label: 'DeepSeek', via: 'Pi', month: { remaining: 3.42, unit: 'usd' } })]
    await render()
    expect(document.querySelector('.quota-strip')).toBeNull()
    expect(loadQuotas).toHaveBeenCalledTimes(1)
  })

  it('tones the bar by what is left: danger at 10%, warn at 30%', async () => {
    reply = [
      plane({ session: pct(0.08) }),
      plane({ id: 'zai', label: 'Z.ai', via: 'Pi', week: pct(0.25) }),
      plane({ id: 'opencode-go', label: 'OpenCode Go', via: 'Pi', month: pct(0.79) })
    ]
    await render()
    const tone = (id: string): string => pills().find((p) => p.dataset.provider === id)!.className
    expect(tone('openai-codex')).toContain('is-danger')
    expect(tone('zai')).toContain('is-warn')
    expect(tone('opencode-go')).not.toContain('is-danger')
    expect(tone('opencode-go')).not.toContain('is-warn')
    // The bar is as long as what is left.
    expect(pills().find((p) => p.dataset.provider === 'opencode-go')!.querySelector('i')!.getAttribute('style')).toContain('79%')
  })

  it('says whose number it is and when it resets, without opening anything', async () => {
    reply = [plane({ label: 'OpenCode Go', via: 'Pi', month: { ...pct(0.5, Date.now() + 5 * 86_400_000) } })]
    await render()
    const title = pills()[0]!.getAttribute('title')!
    expect(title).toContain('OpenCode Go')
    expect(title).toContain('50%')
    expect(title).toContain('this month')
    expect(title).toContain('resets')
  })

  it('opens Usage and limits on a click', async () => {
    reply = [plane({ month: pct(0.5) })]
    await render()
    await act(async () => (document.querySelector('.quota-strip') as HTMLElement).click())
    expect(navigate).toHaveBeenCalledWith({ kind: 'usage' })
  })

  it('reads every provider once, however many conversations are opened', async () => {
    reply = [plane({ month: pct(0.5) })]
    await render()
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    await render()
    expect(loadQuotas).toHaveBeenCalledTimes(1)
    expect(pills()).toHaveLength(1)
  })

  it('draws nothing when the read fails, and says nothing about it here', async () => {
    loadQuotas.mockRejectedValueOnce(new Error('no logins on this computer'))
    await act(async () => root.render(<QuotaStrip />))
    await flush()
    expect(document.querySelector('.quota-strip')).toBeNull()
  })
})
