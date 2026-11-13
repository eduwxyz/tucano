// The cards over every window: what waits on me shows up with the buttons that decide it, a reply
// that brought pictures shows them, and each card has the seconds it was given before it fades.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { NOTICE_LINGER, NOTICE_MAX, NOTICE_SECONDS, approvalCard, areaRect, clampArea, defaultArea, clockFading, clockGone, clockPart, noticeOf, noticeWhere, pushCard, runClock, stackCards, startClock, waitingCards, type NoticeCard, type NoticeFeed } from '../src/shared/notice'
import { CardView } from '../src/renderer/src/notice/Notice'
import type { Agent, Approval } from '../src/shared/types'

const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'ana' }

const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'ap1',
  hash: 'h',
  agentId: 'a1',
  conversationId: 'c1',
  messageId: 'm1',
  connectorId: 'github',
  connectorName: 'GitHub',
  tool: 'create_issue',
  args: {},
  why: 'Fechar o bug do menu.',
  highRisk: false,
  state: 'pending',
  createdAt: 1,
  expiresAt: 9_999_999_999_999,
  ...extra
})

const feed = (over: Partial<NoticeFeed> = {}): NoticeFeed => ({
  rules: noticeOf({}),
  language: 'en',
  agents: [lia],
  conversations: [{ id: 'c1', name: 'vendas', kind: 'channel' }],
  inbox: { approvals: [approval()], questions: [] },
  ...over
})

const draw = (card: NoticeCard, over: { feed?: NoticeFeed; full?: boolean; open?: boolean; act?: boolean } = {}): string =>
  renderToStaticMarkup(
    <CardView card={card} feed={over.feed ?? feed()} full={over.full ?? true} open={over.open ?? false} act={over.act ?? true} onOpen={() => {}} onClose={() => {}} onDecide={() => {}} />
  )

beforeEach(() => setLang('en'))
afterEach(() => setLang('pt'))

describe('how the cards are set', () => {
  it('is on by default, decides from the card, keeps each one six seconds, and holds it under the pointer', () => {
    expect(noticeOf({})).toEqual({ on: true, act: true, seconds: NOTICE_SECONDS, hover: true, skin: 'system', stack: false })
    // One choice at a time: what isn't chosen keeps its default.
    expect(noticeOf({ notice: { hover: false } })).toEqual({ on: true, act: true, seconds: NOTICE_SECONDS, hover: false, skin: 'system', stack: false })
    // A skin is only light, dark or the system's; the stack is on only when asked for.
    expect(noticeOf({ notice: { skin: 'dark', stack: true } })).toMatchObject({ skin: 'dark', stack: true })
    expect(noticeOf({ notice: { on: false } }).on).toBe(false)
    // The seconds stay inside what the card can show.
    expect(noticeOf({ notice: { seconds: 1 } }).seconds).toBe(3)
    expect(noticeOf({ notice: { seconds: 400 } }).seconds).toBe(30)
  })
})

describe('what waits on me', () => {
  it('is an approval card that says who asks for what, and the buttons decide it', () => {
    const [card] = waitingCards(feed())
    expect(card!.id).toBe('approval:ap1')
    expect(card!.title).toBe('Lia asks for approval')
    expect(card!.body).toBe('Fechar o bug do menu.')
    const html = draw(card!)
    expect(html).toContain('data-card="approval:ap1"')
    expect(html).toContain('Approve')
    expect(html).toContain('Refuse')
    expect(html).toContain('in #vendas')
  })

  it('approves with a hold, as the conversation’s own card does, high risk or not', () => {
    const risky = draw(approvalCard(approval({ highRisk: true }), 'Lia'))
    expect(risky).toContain('Lia asks for a high-risk approval')
    expect(risky).toContain('nc__hold')
    expect(risky).toContain('Hold to approve')
    // A high-risk tool is never kept for good, so there is no "always" beside it.
    expect(risky).not.toContain('Always allow')

    const plain = draw(approvalCard(approval(), 'Lia'))
    expect(plain).toContain('nc__hold')
    expect(plain).toContain('Always allow')
  })

  it('shows no buttons when deciding from the card is off: the card only opens the conversation', () => {
    const html = draw(approvalCard(approval(), 'Lia'), { act: false })
    expect(html).not.toContain('Approve')
    expect(html).not.toContain('Refuse')
  })

  it('a question shows its options as the conversation does: the app’s own card, one decision at a time', () => {
    const ask = { id: 'm9', agentId: 'a1', text: 'Paginação no menu?', askedTo: 'ana', requestedBy: 'ana', state: 'open' as const, deadlineAt: 9_999_999_999_999, createdAt: 2, decisions: [{ question: 'Paginação no menu?', kind: 'single' as const, options: [{ label: 'Scroll infinito' }, { label: 'Paginar' }] }] }
    const html = draw({ id: 'ask:m9', kind: 'ask', at: 2, title: 'Lia asks', body: 'Paginação no menu?', agentId: 'a1', agentName: 'Lia', ask })
    expect(html).toContain('Scroll infinito')
    expect(html).toContain('Paginar')
    // The app's own asking card, inside the notice: its option rows, its free answer and its skip.
    expect(html).toContain('ask-option')
    expect(html).toContain('Something else')
    expect(html).toContain('Skip')
    expect(html).toContain('Waiting for you')
  })

  it('says what it cannot see, instead of naming someone else’s conversation', () => {
    expect(noticeWhere([], 'c9', 'Lia')).toBe("in a conversation you don't see")
    expect(noticeWhere([{ id: 'c2', name: '', kind: 'dm' }], 'c2', 'Lia')).toBe('in your DM with Lia')
  })
})

describe('the stack', () => {
  it('takes what just happened, newest first, one card per thing, and leaves out what was closed', () => {
    const waiting = waitingCards(feed())
    const done = pushCard({ title: 'Lia is done', body: 'Pronto', messageId: 'm2', at: 5 })
    const note = pushCard({ title: 'Lia mentioned you', body: 'oi', at: 6 })
    expect(stackCards(waiting, [done!, note!], new Set()).map((c) => c.id)).toEqual(['note:6', `done:m2`, 'approval:ap1'])
    // The same message twice is one card.
    expect(stackCards([], [done!, { ...done! }], new Set())).toHaveLength(1)
    expect(stackCards(waiting, [], new Set(['approval:ap1']))).toHaveLength(0)
  })

  it('keeps a bounded stack', () => {
    const many = Array.from({ length: NOTICE_MAX + 6 }, (_, i) => pushCard({ title: 'n', body: 'b', at: i })!)
    expect(stackCards([], many, new Set())).toHaveLength(NOTICE_MAX)
  })

  it('a decision already has its card from what waits: its notification draws nothing twice', () => {
    expect(pushCard({ title: 'Lia asks for approval', body: '…', kind: 'approval' })).toBeNull()
    expect(pushCard({ title: 'Lia asks', body: '…', kind: 'question' })).toBeNull()
  })

  it('a reply that brought pictures shows them, and the rest wait behind a count', () => {
    const pictures = [0, 1, 2, 3].map((i) => ({ url: `tucano://artifact/a${i}/p${i}.png`, title: `p${i}`, kind: 'image' as const }))
    const card = pushCard({ title: 'Lia is done', body: 'Achei três bugs.', messageId: 'm2', pictures })!
    const folded = draw(card)
    expect(folded.match(/<img /g)).toHaveLength(3)
    expect(folded).toContain('+2')
    const open = draw(card, { open: true })
    expect(open.match(/<img /g)).toHaveLength(4)
    expect(open).not.toContain('nc__more')
  })
})

describe('the seconds on a card', () => {
  it('drains, fades, and comes back while the pointer is on it', () => {
    let clock = startClock(2)
    clock = runClock(clock, 1_000, false)
    expect(clockPart(clock, 2)).toBeCloseTo(0.5)
    clock = runClock(clock, 1_200, false)
    expect(clockFading(clock)).toBe(true) // past its seconds: the fade has begun
    expect(clockGone(clock)).toBe(false) // and it can still be had back
    clock = runClock(clock, 400, true) // the pointer came back
    expect(clockFading(clock)).toBe(false)
    expect(clockPart(clock, 2)).toBe(0)
  })

  it('is gone once the fade has run out unhovered', () => {
    const left = runClock(runClock(startClock(1), 1_000, false), NOTICE_LINGER, false)
    expect(clockGone(left)).toBe(true)
  })

  it('does not run while hovered, and the whole period is still owed after it', () => {
    const held = runClock(startClock(3), 60_000, true)
    expect(held.left).toBe(3_000)
    expect(clockGone(held)).toBe(false)
  })
})

describe('where they appear', () => {
  it('sits in the bottom right corner until the person draws another place', () => {
    const a = defaultArea({ width: 1600, height: 900 })
    expect(a.up).toBe(true) // the newest card nearest the bottom
    expect(a.x + a.w).toBeGreaterThan(0.95) // against the right edge
    expect(a.y + a.h).toBeGreaterThan(0.9) // and the bottom one
    // As wide as a card, whatever the screen.
    expect(Math.round(a.w * 1600)).toBe(372)
  })

  it('keeps a rectangle on the screen, never smaller than a card', () => {
    expect(clampArea({ x: -1, y: 2, w: 0.02, h: 0.02, up: true })).toEqual({ x: 0, y: 0.94, w: 0.12, h: 0.06, up: true })
    // A rectangle that would hang off the right or bottom edge comes back inside it.
    const kept = clampArea({ x: 0.9, y: 0.9, w: 0.5, h: 0.5, up: false })
    expect(kept.x + kept.w).toBeLessThanOrEqual(1)
    expect(kept.y + kept.h).toBeLessThanOrEqual(1)
  })

  it('reads back as the same rectangle on screen, whichever display it is', () => {
    const area = { x: 0.5, y: 0.2, w: 0.25, h: 0.4, up: false }
    expect(areaRect(area, { x: 0, y: 0, width: 1200, height: 800 })).toEqual({ x: 600, y: 160, w: 300, h: 320 })
    // A second screen's own coordinates.
    expect(areaRect(area, { x: 1920, y: 0, width: 1200, height: 800 })).toEqual({ x: 2520, y: 160, w: 300, h: 320 })
  })
})
