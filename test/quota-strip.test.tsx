// The little bars in a session's header. What is checked here: one bar per provider, each naming the
// provider it draws, the window it draws is the longest the provider reports (month over week over
// the short one), a wallet with no cap draws nothing, the tone follows what is left, a click opens
// Usage and limits, and reading every provider costs one read even when several conversations are
// opened. What is checked about which bars are drawn is that only the providers the conversation's
// own bots are set to run on get one: a login on the computer that no member spends has no bar, and a
// fallback model's provider does, after its bot's main one. The widths the bars take are measured in
// a browser in test/quota-strip-layout.test.ts; linkedom has no layout.
//
// The box over a bar has its own block below: the pointer names one provider and gets that
// provider's windows alone, leaving the strip closes it, the keyboard opens it where there is no
// pointer to name a bar, and a wallet is a line of money rather than a bar.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Account, Agent, ProviderQuota } from '../src/shared/types'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

const accounts = [{ id: 'acc-work', engine: 'claude', name: 'Work', loggedIn: true }] as Account[]
let reply: ProviderQuota[] = []
const loadQuotas = vi.fn(async () => ({ list: reply, at: Date.now() }))
const navigate = vi.fn()
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select({ settings: { accounts } }),
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

const render = async (agents: Agent[]): Promise<void> => {
  await act(async () => root.render(<QuotaStrip agents={agents} />))
  await flush()
}
const pills = (): HTMLElement[] => [...document.querySelectorAll('.quota-strip__pill')] as HTMLElement[]
// The bar each pill draws, as the provider it stands for and the window it measures.
const drew = (): [string | undefined, string | undefined][] => pills().map((p) => [p.dataset.provider, p.dataset.span])
// The pointer and the keyboard, as the header hears them: a pointer moving onto an element arrives as
// `mouseover`, moving off it as `mouseout`, and the keyboard's focus as `focusin`, its leaving as
// `focusout`. linkedom has no MouseEvent, and React reads the target and its ancestors from these.
const hover = async (el: Element): Promise<void> => {
  await act(async () => el.dispatchEvent(new window.Event('mouseover', { bubbles: true })))
}
const leave = async (el: Element): Promise<void> => {
  await act(async () => el.dispatchEvent(new window.Event('mouseout', { bubbles: true })))
}
const focusOn = async (el: Element): Promise<void> => {
  await act(async () => el.dispatchEvent(new window.Event('focusin', { bubbles: true })))
}
const blurOff = async (el: Element): Promise<void> => {
  await act(async () => el.dispatchEvent(new window.Event('focusout', { bubbles: true })))
}
const plane = (over: Partial<ProviderQuota>): ProviderQuota => ({ id: 'openai-codex', label: 'Codex', via: 'Codex', at: Date.now(), ...over })
// A window with a cap, as a provider reports it: what is left, out of what it allows.
const pct = (leftOver: number, resetsAt?: number) => ({ used: 1 - leftOver, remaining: leftOver, limit: 1, unit: '%' as const, ...(resetsAt ? { resetsAt } : {}) })
// A bot as a conversation lists it: the model it replies on, and where a reply goes when that one is out.
const bot = (id: string, over: Partial<Agent> = {}): Agent =>
  ({ id, name: id, handle: id, role: '', modelId: 'codex:gpt-6.1-sol', archived: false, ...over }) as Agent

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

describe('the providers it draws', () => {
  it('draws no bar for a provider that is logged in but that no member runs on', async () => {
    // Three logins answer; the conversation's one bot replies on Codex alone.
    reply = [
      plane({ month: pct(0.4) }),
      plane({ id: 'deepseek', label: 'DeepSeek', via: 'Pi', month: pct(0.9) }),
      plane({ id: 'zai', label: 'Z.ai', via: 'Pi', week: pct(0.6) })
    ]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' })])
    expect(drew()).toEqual([['openai-codex', 'month']])
  })

  it('draws a fallback model provider, after the main model one', async () => {
    // The main model is not the one that runs out when the plan is spent: the fallback's is.
    reply = [plane({ month: pct(0.5) }), plane({ id: 'zai', label: 'Z.ai', via: 'Pi', week: pct(0.4) })]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol', fallbackModelId: 'pi:zai/glm-5.3' })])
    expect(drew()).toEqual([
      ['openai-codex', 'month'],
      ['zai', 'week']
    ])
  })

  it("draws a DM's one member and a channel's in the order it lists them, two at most", async () => {
    // A DM carries one member and a channel the ones it lists; the strip reads whichever it is given.
    reply = [
      plane({ month: pct(0.5) }),
      plane({ id: 'zai', label: 'Z.ai', via: 'Pi', week: pct(0.4) }),
      plane({ id: 'xai-oauth', label: 'Grok', via: 'Hermes', week: pct(0.3) })
    ]
    await render([bot('theo', { modelId: 'pi:zai/glm-5.3' })])
    expect(drew()).toEqual([['zai', 'week']])
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    await render([
      bot('lia', { modelId: 'codex:gpt-6.1-sol' }),
      bot('theo', { modelId: 'pi:zai/glm-5.3' }),
      bot('nina', { modelId: 'pi:xai-oauth/grok-4.6' })
    ])
    // Two at most: the third member's provider is on the Usage page, not in this header.
    expect(drew()).toEqual([
      ['openai-codex', 'month'],
      ['zai', 'week']
    ])
  })

  it('draws nothing when the bot names no provider at all', async () => {
    reply = [plane({ month: pct(0.5) })]
    await render([bot('lia', { modelId: 'hermes:deepseek-v4.1-flash' })])
    expect(document.querySelector('.quota-strip')).toBeNull()
  })
})

describe('the strip in the header', () => {
  it('draws one bar per provider, in its longest window', async () => {
    reply = [
      plane({ session: pct(0.9), week: pct(0.7), month: pct(0.4) }),
      plane({ id: 'xai-oauth', label: 'Grok', via: 'Hermes', week: pct(0.38) }),
      plane({ id: 'deepseek', label: 'DeepSeek', via: 'Pi', month: { remaining: 3.42, unit: 'usd' } })
    ]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' }), bot('theo', { modelId: 'pi:xai-oauth/grok-4.6' })])
    expect(drew()).toEqual([
      ['openai-codex', 'month'],
      ['xai-oauth', 'week']
    ])
    // Each bar names the provider it draws, above its track.
    expect(pills().map((p) => p.querySelector('.quota-strip__name')?.textContent)).toEqual(['Codex', 'Grok'])
    expect(pills().every((p) => !!p.querySelector('.quota-strip__track > i'))).toBe(true)
  })

  it('draws nothing at all when no provider has a cap', async () => {
    reply = [plane({ month: { remaining: 3.42, unit: 'usd' } })]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' })])
    expect(document.querySelector('.quota-strip')).toBeNull()
    expect(loadQuotas).toHaveBeenCalledTimes(1)
  })

  it('tones the bar by what is left: danger at 10%, warn at 30%', async () => {
    reply = [
      plane({ session: pct(0.08) }),
      plane({ id: 'zai', label: 'Z.ai', via: 'Pi', week: pct(0.25) }),
      // Logged in, plenty left, and spent by nobody in this conversation: no bar of its own.
      plane({ id: 'opencode-go', label: 'OpenCode Go', via: 'Pi', month: pct(0.79) })
    ]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' }), bot('theo', { modelId: 'pi:zai/glm-5.3' })])
    const tone = (id: string): string => pills().find((p) => p.dataset.provider === id)!.className
    expect(tone('openai-codex')).toContain('is-danger')
    expect(tone('zai')).toContain('is-warn')
    expect(tone('zai')).not.toContain('is-danger')
    expect(pills().map((p) => p.dataset.provider)).not.toContain('opencode-go')
    // The bar is as long as what is left.
    expect(pills().find((p) => p.dataset.provider === 'openai-codex')!.querySelector('i')!.getAttribute('style')).toContain('8%')
  })

  it('says whose number it is and when it resets, without leaving the header', async () => {
    reply = [plane({ id: 'opencode-go', label: 'OpenCode Go', via: 'Pi', month: { ...pct(0.5, Date.now() + 5 * 86_400_000) } })]
    await render([bot('lia', { modelId: 'pi:opencode-go/deepseek-v4.1-flash' })])
    await hover(pills()[0]!)
    const said = document.querySelector('.quota-card')!.textContent!
    expect(said).toContain('OpenCode Go')
    expect(said).toContain('Month')
    expect(said).toContain('50%')
    expect(said).toContain('resets')
    // Reading it is not opening Usage and limits: the click is still the click.
    expect(navigate).not.toHaveBeenCalled()
  })

  it('opens Usage and limits on a click', async () => {
    reply = [plane({ month: pct(0.5) })]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' })])
    await act(async () => (document.querySelector('.quota-strip') as HTMLElement).click())
    expect(navigate).toHaveBeenCalledWith({ kind: 'usage' })
  })

  it('reads every provider once, however many conversations are opened', async () => {
    reply = [plane({ month: pct(0.5) })]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' })])
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    // Another member, the same provider: the cache still answers, and the bar is still drawn.
    await render([bot('theo', { modelId: 'pi:openai-codex/gpt-6.1-sol' })])
    expect(loadQuotas).toHaveBeenCalledTimes(1)
    expect(pills()).toHaveLength(1)
  })

  it('draws nothing when the read fails, and says nothing about it here', async () => {
    loadQuotas.mockRejectedValueOnce(new Error('no logins on this computer'))
    await act(async () => root.render(<QuotaStrip agents={[bot('lia', { modelId: 'codex:gpt-6.1-sol' })]} />))
    await flush()
    expect(document.querySelector('.quota-strip')).toBeNull()
  })
})

describe('the box over a bar', () => {
  // Two providers whose windows differ, so the box says which bar the pointer named: the header
  // carries one number each, and the box is the one place those numbers are spelled out.
  const both = async (): Promise<void> => {
    reply = [
      plane({ session: pct(0.9), week: pct(0.7), month: pct(0.5, Date.now() + 5 * 86_400_000) }),
      plane({ id: 'zai', label: 'Z.ai', via: 'Pi', week: pct(0.4) })
    ]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' }), bot('theo', { modelId: 'pi:zai/glm-5.3' })])
  }
  const card = (): HTMLElement | null => document.querySelector('.quota-card')
  const written = (sel: string): string[] => [...document.querySelectorAll(sel)].map((n) => n.textContent ?? '')

  it("opens the pointed-at provider's own windows, and only those", async () => {
    await both()
    // Nothing is open until the pointer says which bar it is asking about.
    expect(card()).toBeNull()
    await hover(pills()[0]!)
    expect(card()!.getAttribute('role')).toBe('tooltip')
    expect(written('.quota-card__name')).toEqual(['Codex'])
    // Every window that provider reports a cap for, longest first, each with what is left and when it
    // resets — the three rows the Usage page draws, in the header's own box.
    expect(written('.quota-card__span')).toEqual(['Month', 'Week', '5h'])
    expect(written('.quota-card__left')).toEqual(['50% left', '70% left', '90% left'])
    expect(written('.quota-card__track')).toHaveLength(3)
    expect(written('.quota-card__reset')[0]).toContain('resets')
    expect(card()!.textContent).not.toContain('Z.ai')
    // The other bar names the other provider, in the one window that one reports.
    await hover(pills()[1]!)
    expect(written('.quota-card__name')).toEqual(['Z.ai'])
    expect(written('.quota-card__span')).toEqual(['Week'])
    expect(card()!.textContent).not.toContain('Codex')
  })

  it('closes when the pointer leaves the strip', async () => {
    await both()
    await hover(pills()[1]!)
    expect(card()).not.toBeNull()
    await leave(document.querySelector('.quota-strip-wrap')!)
    expect(card()).toBeNull()
  })

  it('opens on the keyboard, where there is no pointer to name one bar, and closes when it goes', async () => {
    await both()
    const strip = document.querySelector('.quota-strip')!
    await focusOn(strip)
    expect(card()!.getAttribute('role')).toBe('tooltip')
    // No pointer named a bar, so the box holds each bar it could be reading.
    expect(written('.quota-card__name')).toEqual(['Codex', 'Z.ai'])
    await blurOff(strip)
    expect(card()).toBeNull()
  })

  it('says what is in a wallet, which draws no bar of its own', async () => {
    reply = [plane({ month: pct(0.3), week: { remaining: 3.42, unit: 'usd' } })]
    await render([bot('lia', { modelId: 'codex:gpt-6.1-sol' })])
    await hover(pills()[0]!)
    // A balance has no cap, so it is a line of money rather than a bar.
    expect(written('.quota-card__span')).toEqual(['Month'])
    expect(card()!.textContent).toContain('$3.42 in the wallet')
  })
})
