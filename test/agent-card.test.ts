import { existsSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentChannels, agentNow, cardState, HOVER_CLOSE_MS, HOVER_OPEN_MS, placeCard } from '../src/renderer/src/agent-card'
import type { Conversation, Message, Run } from '../src/shared/types'

const agent = { id: 'lia', archived: false, used: 0, limit: 1000 }
const msg = (id: string, author: string, at: number, run?: Partial<Run>, conversationId = 'c1'): Message => ({
  id,
  conversationId,
  author: author === 'me' ? { kind: 'me' } : { kind: 'agent', id: author },
  text: '',
  at,
  run: run && { status: 'done', steps: [], ...run }
})

describe('what an agent’s card says it is doing', () => {
  it('says where it works now and the step running', () => {
    const messages = [
      msg('1', 'lia', 1, { status: 'done' }),
      msg('2', 'lia', 2, { status: 'working', steps: [{ id: 's1', label: 'Lendo o arquivo', status: 'done' }, { id: 's2', label: 'Rodando os testes', status: 'running' }] }, 'c2'),
      msg('3', 'theo', 3, { status: 'working' })
    ]
    expect(agentNow(agent, messages)).toEqual({ kind: 'working', conversationId: 'c2', doing: 'Rodando os testes', since: 2 })
  })
  it('says it waits on me, for an answer or an approval', () => {
    expect(agentNow(agent, [msg('1', 'lia', 1, { status: 'waiting_input' })])).toEqual({ kind: 'waiting', conversationId: 'c1', on: 'input' })
    expect(agentNow(agent, [msg('1', 'lia', 1, { status: 'waiting_approval' })])).toEqual({ kind: 'waiting', conversationId: 'c1', on: 'approval' })
  })
  it('puts work before waiting, and both before the limit', () => {
    const messages = [msg('1', 'lia', 1, { status: 'waiting_input' }), msg('2', 'lia', 2, { status: 'working' })]
    expect(agentNow({ ...agent, used: 1000 }, messages).kind).toBe('working')
    expect(agentNow({ ...agent, used: 1000 }, [msg('1', 'lia', 1)])).toEqual({ kind: 'limit' })
  })
  it('says an archived agent does nothing, whatever its messages say', () => {
    expect(agentNow({ ...agent, archived: true }, [msg('1', 'lia', 1, { status: 'working' })])).toEqual({ kind: 'archived' })
  })
  it('otherwise says when it last spoke, or nothing if it never did', () => {
    expect(agentNow(agent, [msg('1', 'lia', 5), msg('2', 'me', 9), msg('3', 'theo', 10)])).toEqual({ kind: 'idle', lastAt: 5 })
    expect(agentNow(agent, [msg('1', 'me', 1)])).toEqual({ kind: 'idle', lastAt: undefined })
  })
})

it('lists the channels an agent is in, not the DMs', () => {
  const conv = (id: string, kind: Conversation['kind'], members: string[]): Conversation => ({ id, kind, name: id, members })
  const all = [conv('eng', 'channel', ['lia', 'theo']), conv('dados', 'channel', ['theo']), conv('dm', 'dm', ['lia']), conv('geral', 'channel', ['lia'])]
  expect(agentChannels('lia', all).map((c) => c.id)).toEqual(['eng', 'geral'])
})

describe('where the card goes', () => {
  const view = { width: 1280, height: 820 }
  const card = { width: 320, height: 300 }
  const face = { left: 360, top: 150, width: 34, height: 34 }

  it('opens to the right of what was clicked, top-aligned with it', () => {
    expect(placeCard(face, card, view)).toEqual({ left: 402, top: 150, width: 320 })
  })
  it('goes left when there’s no room on the right (a face in a thread panel at the edge)', () => {
    expect(placeCard({ left: 1100, top: 150, width: 34, height: 34 }, card, view)).toEqual({ left: 772, top: 150, width: 320 })
  })
  it('stays whole on screen near the bottom', () => {
    const p = placeCard({ ...face, top: 700 }, card, view)
    expect(p.top + card.height).toBeLessThanOrEqual(view.height - 12)
  })
  it('opens under a top bar’s button, kept inside the window', () => {
    expect(placeCard({ left: 262, top: 20, width: 60, height: 28 }, card, view, 'below')).toEqual({ left: 262, top: 56, width: 320 })
    expect(placeCard({ left: 1200, top: 20, width: 24, height: 24 }, card, view, 'below').left).toBe(1280 - 320 - 12)
  })
  it('spans a narrow window, under the click or above it', () => {
    const phone = { width: 360, height: 700 }
    expect(placeCard({ left: 20, top: 100, width: 34, height: 34 }, card, phone)).toEqual({ left: 12, top: 142, width: 336 })
    expect(placeCard({ left: 20, top: 600, width: 34, height: 34 }, card, phone).top).toBe(600 - 8 - 300)
  })
})

describe('opening the card on a click and on hover', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())
  const face = { name: 'Lia’s face' }
  const other = { name: 'Theo’s face' }
  const open = (s: ReturnType<typeof cardState<object>>) => s.get() && { agentId: s.get()!.agentId, anchor: s.get()!.anchor, via: s.get()!.via }

  it('opens after the pointer rests on a face for the delay, not before', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS - 1)
    expect(s.get()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(open(s)).toEqual({ agentId: 'lia', anchor: face, via: 'hover' })
  })
  it('doesn’t open when the pointer leaves before the delay', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS - 100)
    s.hoverLeave()
    vi.advanceTimersByTime(HOVER_OPEN_MS * 4)
    expect(s.get()).toBeNull()
  })
  it('stays while the pointer moves from the face onto the card, and goes a moment after it leaves both', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS)
    s.hoverLeave()
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 50)
    s.cardEnter()
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 10)
    expect(open(s)?.via).toBe('hover')
    s.cardLeave()
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 1)
    expect(s.get()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(s.get()).toBeNull()
  })
  it('stays when the pointer comes back to its face in time', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS)
    s.hoverLeave()
    vi.advanceTimersByTime(HOVER_CLOSE_MS - 50)
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 10)
    expect(open(s)?.anchor).toBe(face)
  })
  it('opens at once on a click, which the same click closes, and a clicked card ignores the pointer', () => {
    const s = cardState<object>()
    s.click('lia', face)
    expect(open(s)).toEqual({ agentId: 'lia', anchor: face, via: 'click' })
    s.hoverLeave()
    s.hoverEnter('theo', other)
    vi.advanceTimersByTime(HOVER_OPEN_MS * 4)
    expect(open(s)).toEqual({ agentId: 'lia', anchor: face, via: 'click' })
    s.click('lia', face)
    expect(s.get()).toBeNull()
  })
  it('keeps a hovered card open as a clicked one when its face is clicked', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS)
    s.click('lia', face)
    s.hoverLeave()
    vi.advanceTimersByTime(HOVER_CLOSE_MS * 10)
    expect(open(s)).toEqual({ agentId: 'lia', anchor: face, via: 'click' })
  })
  it('a click before the delay opens it right away, with no second card after', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(100)
    s.click('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS * 4)
    expect(open(s)?.via).toBe('click')
  })
  it('shows one card at a time: a hovered face replaces the hovered card once its delay passes', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    vi.advanceTimersByTime(HOVER_OPEN_MS)
    s.hoverLeave()
    s.hoverEnter('theo', other)
    vi.advanceTimersByTime(HOVER_OPEN_MS)
    expect(open(s)).toEqual({ agentId: 'theo', anchor: other, via: 'hover' })
  })
  it('doesn’t open while the page scrolls under a still pointer', () => {
    const s = cardState<object>()
    s.hoverEnter('lia', face)
    s.scrolled()
    vi.advanceTimersByTime(HOVER_OPEN_MS * 2)
    expect(s.get()).toBeNull()
    s.scrolled()
    vi.advanceTimersByTime(50)
    s.hoverEnter('theo', other) // a face passing under the pointer, right after the scroll
    vi.advanceTimersByTime(HOVER_OPEN_MS * 2)
    expect(s.get()).toBeNull()
    s.hoverEnter('theo', other) // the pointer moves onto it once the page is still
    vi.advanceTimersByTime(HOVER_OPEN_MS)
    expect(open(s)?.agentId).toBe('theo')
  })
  it('tells who listens when the card opens and closes', () => {
    const s = cardState<object>()
    const seen = vi.fn()
    const stop = s.subscribe(seen)
    s.click('lia', face)
    s.close()
    stop()
    s.click('lia', face)
    expect(seen).toHaveBeenCalledTimes(2)
  })
})

// Layout needs a browser: a long name or role must wrap inside the card, not widen it.
it.skipIf(!existsSync(chromium.executablePath()))('keeps a long name, handle and role inside the card', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    const long = 'Pesquisa-e-desenvolvimento-de-projetos-complexos'.repeat(3)
    await page.setContent(`
      <style>${readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')}</style>
      <div class="agent-card c-sky" style="left: 20px; top: 20px">
        <div class="agent-card__band"></div>
        <div class="agent-card__head">
          <span class="agent-card__face"><span class="avatar" style="width:64px;height:64px"></span></span>
          <div class="agent-card__who">
            <h2 class="agent-card__name">${long}</h2>
            <div class="agent-card__handle">@${long.toLowerCase()}</div>
            <div class="agent-card__role">${long}</div>
          </div>
        </div>
        <dl class="agent-card__facts"><div><dt>Modelo</dt><dd>${long}</dd></div></dl>
        <div class="agent-card__actions"><button class="btn btn--primary btn--sm">Mensagem</button><button class="btn btn--sm">Ver perfil completo</button></div>
      </div>`)
    const fits = await page.locator('.agent-card').evaluate((card) => ({ width: (card as HTMLElement).offsetWidth, overflow: card.scrollWidth > card.clientWidth, position: getComputedStyle(card).position }))
    expect(fits).toEqual({ width: 320, overflow: false, position: 'fixed' })
  } finally {
    await browser.close()
  }
})
