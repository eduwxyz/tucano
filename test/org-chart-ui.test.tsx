import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Delegation, Message } from '../src/shared/types'
import { BOARD, SLOT_GAP } from '../src/shared/org-layout'
import type { State } from '../src/renderer/src/store'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null }) // so React takes the input event for typing, as a browser's document has it
let fake: Pick<State, 'agents' | 'conversations' | 'me' | 'delegations'> & { settings: { orgLayout?: Record<string, { x: number; y: number }> } }
let busy = new Map<string, Message>()
let admin = true
const save = vi.fn(async (_agent: Agent, _channels: string[]) => {})
const settings = vi.fn((_patch: { orgLayout?: Record<string, { x: number; y: number }> | null }) => {})
const asked = vi.fn(async (_agent: string, _text: string) => 'dm')
const go = vi.fn()
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(fake),
  amAdmin: () => admin,
  isTeam: (a: Agent) => !a.archived && a.kind !== 'tuca',
  saveAgent: (a: Agent, c: string[]) => save(a, c),
  updateSettings: (p: never) => settings(p),
  askAgent: (id: string, text: string) => asked(id, text),
  navigate: (v: unknown) => go(v),
  setTab: () => {},
  openDm: (id: string) => go({ dm: id }),
  openThread: (id: string) => go({ thread: id }),
  openTuca: () => go('tuca'),
  workingOn: () => busy
}))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, MeAvatar: () => null, Icon: () => null, ago: () => 'há 2 min', ownColor: () => ({}) }))
vi.mock('../src/renderer/src/components/Select', () => ({ Select: ({ value, onChange, options, disabled }: { value: string | null; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) => <select aria-label="Responde a" disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }))
vi.mock('../src/renderer/src/components/Pages', () => ({ Sheet: ({ children, lede, actions }: { children: unknown; lede?: unknown; actions?: unknown }) => <main><p>{lede as never}</p>{actions as never}{children as never}</main> }))
const { createRoot } = await import('react-dom/client')
const { OrgPage } = await import('../src/renderer/src/components/OrgChart')
let root: ReturnType<typeof createRoot>
const bot = (id: string, reportsTo?: string, extra: Partial<Agent> = {}) => ({ id, name: id, handle: id, role: '', archived: false, ...(reportsTo ? { reportsTo } : {}), ...extra }) as Agent
const channel = (id: string, members: string[]) => ({ id, kind: 'channel', name: id, members }) as Conversation
const render = async () => act(async () => root.render(<OrgPage />))
beforeEach(async () => {
  busy = new Map()
  fake = { settings: {}, delegations: [], me: { name: 'Edu', initials: 'E' }, agents: [bot('orion'), bot('clara', 'orion'), bot('bento', 'orion'), bot('nico', 'bento'), bot('solo'), bot('tuca', undefined, { kind: 'tuca' }), bot('old', 'orion', { archived: true })], conversations: [channel('clientes', ['clara']), channel('eng', ['bento']), channel('vendas', ['clara'])] }
  admin = true
  save.mockReset().mockResolvedValue(undefined)
  settings.mockReset()
  asked.mockReset().mockResolvedValue('dm')
  go.mockReset()
  root = createRoot(document.getElementById('root')!)
  await render()
})
afterEach(async () => { await act(async () => root.unmount()) })
const card = (name: string): Element => [...document.querySelectorAll('.org-card')].find((c) => c.querySelector('strong')?.textContent === name)!
// A pointer event where it happens; the board listens for the move and the release on the document.
const ptr = async (el: Element | Document, type: string, x = 0, y = 0, extra: Record<string, unknown> = {}) =>
  act(async () => {
    const e = new window.Event(type, { bubbles: true, cancelable: true })
    Object.assign(e, { clientX: x, clientY: y, button: 0, relatedTarget: null, ...extra })
    el.dispatchEvent(e)
  })
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.Event('click', { bubbles: true })) })
// A press and a release in the same place: a click on a card.
const pick = async (name: string) => (await ptr(card(name), 'pointerdown', 10, 10), await ptr(document, 'pointerup', 10, 10))
// A line pulled from a card's dot (under it, above it, or the one beside that for another boss) and let go
// over another card.
const pull = async (from: string, side: 'out' | 'in' | 'also', onto: string) => {
  await ptr(card(from).querySelector(`.org-port--${side}`)!, 'pointerdown', 5, 5)
  await ptr(card(onto), 'pointerover', 50, 50)
  await ptr(document, 'pointerup', 50, 50)
  await ptr(card(onto), 'pointerout', 60, 60)
}
const names = (sel: string): (string | null | undefined)[] => [...document.querySelectorAll(sel)].map((c) => c.querySelector('strong')?.textContent ?? c.textContent)
const ask = (id: string, from: string, to: string, extra: Partial<Delegation> = {}) => ({ id, from, to, conversationId: 'clientes', rootId: `root-${id}`, originConversationId: 'dm', originMessageId: 'm', requestedBy: 'p', text: 'Responder o Fulano sobre o checkout', state: 'open', createdAt: 1, ...extra }) as Delegation
// Typing as React sees it: the value set past React's own tracker, then the input event.
const type = async (input: Element, value: string): Promise<void> => {
  let proto: object | null = Object.getPrototypeOf(input)
  let set: ((v: string) => void) | undefined
  while (proto && !set) (set = Object.getOwnPropertyDescriptor(proto, 'value')?.set), (proto = Object.getPrototypeOf(proto))
  await act(async () => {
    set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const at = (name: string): { x: number; y: number } => {
  const style = card(name).getAttribute('style') ?? ''
  return { x: Number(/left:\s*(-?[\d.]+)/.exec(style)?.[1]), y: Number(/top:\s*(-?[\d.]+)/.exec(style)?.[1]) }
}

it('puts me at the top and every agent on the board, with a line for each one that answers to someone', () => {
  expect(card('Edu').className).toContain('org-card--me')
  expect(names('.orgb .org-card').sort()).toEqual(['Edu', 'bento', 'clara', 'nico', 'orion', 'solo'])
  // Neither the Tuca nor an archived one.
  expect(document.body.textContent).not.toContain('tuca')
  expect(document.body.textContent).not.toContain('old')
  // Me to the top, and one for each of the three that answer to someone; none to the one on its own.
  expect(document.querySelectorAll('.orgb__lines g')).toHaveLength(4)
  expect(document.querySelectorAll('.orgb__lines g.is-me')).toHaveLength(1)
  // Whoever is above sits above; the one on its own, under everything.
  expect(at('orion').y).toBeGreaterThan(at('Edu').y)
  expect(at('nico').y).toBeGreaterThan(at('bento').y)
  expect(at('solo').y).toBeGreaterThan(at('nico').y)
  // Where each one's work arrives; in no channel, it's the DM, and nothing to warn about.
  expect(card('clara').textContent).toContain('#clientes +1')
  expect(card('nico').textContent).toContain('disponível')
  expect(card('solo').textContent).toContain('disponível')
})

it('makes an agent answer to another by pulling a line between them, keeping its channels', async () => {
  // From under Clara onto Solo: Solo answers to Clara.
  await pull('clara', 'out', 'solo')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'solo', reportsTo: 'clara' })
  // From above Clara onto Bento: Clara answers to Bento.
  await pull('clara', 'in', 'bento')
  expect(save.mock.calls[1]![0]).toMatchObject({ id: 'clara', reportsTo: 'bento' })
  expect(save.mock.calls[1]![1]).toEqual(['clientes', 'vendas'])
})

it('shows where a line being pulled may end', async () => {
  await ptr(card('orion').querySelector('.org-port--out')!, 'pointerdown', 5, 5)
  expect(document.querySelector('.orgb')?.className).toContain('is-linking')
  expect(document.querySelector('.orgb__line.is-new')).not.toBeNull()
  // Nico and Solo may come to answer to Orion; Clara and Bento already do, and I answer to no one.
  expect(card('nico').className).toContain('is-target')
  expect(card('solo').className).toContain('is-target')
  for (const name of ['clara', 'bento', 'Edu']) expect(card(name).className).toContain('is-dim')
  await ptr(card('solo'), 'pointerover')
  expect(card('solo').className).toContain('is-over')
  await ptr(document, 'pointerup')
  expect(document.querySelector('.orgb__line.is-new')).toBeNull()
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'solo', reportsTo: 'orion' })
})

it('takes an agent out by pulling its line onto me, or from the line itself', async () => {
  await pull('nico', 'in', 'Edu')
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'nico' })
  expect(save.mock.calls[0]![0].reportsTo).toBeUndefined()
  // A click on Clara's line picks it; the button on it, or Delete, undoes it.
  const lines = [...document.querySelectorAll('.orgb__hit')]
  expect(lines).toHaveLength(3) // not the one from me
  await ptr(lines[0]!, 'pointerdown')
  expect(document.querySelectorAll('.orgb__lines g.is-picked')).toHaveLength(1)
  await click(document.querySelector('.org-edge-x')!)
  expect(save.mock.calls[1]![0]).toMatchObject({ id: 'clara' })
  expect(save.mock.calls[1]![0].reportsTo).toBeUndefined()
  expect(document.querySelector('.org-edge-x')).toBeNull()
  await ptr(lines[1]!, 'pointerdown')
  await act(async () => { window.dispatchEvent(Object.assign(new window.Event('keydown'), { key: 'Delete' })) })
  expect(save.mock.calls[2]![0]).toMatchObject({ id: 'bento' })
})

it('refuses a line that closes a loop, onto itself, or that changes nothing', async () => {
  await pull('nico', 'out', 'orion') // Orion would answer to someone below it
  await pull('bento', 'out', 'bento')
  await pull('orion', 'out', 'clara') // already does
  await pull('solo', 'in', 'Edu') // already answers to no one
  await pull('orion', 'out', 'Edu') // I answer to no one
  expect(save).not.toHaveBeenCalled()
})

// The store as it behaves: what is saved is what the screen draws next.
const live = (): void => void save.mockImplementation(async (a: Agent) => { fake = { ...fake, agents: fake.agents.map((x) => (x.id === a.id ? a : x)) } })

it('takes a change back for a moment, from the board or with ⌘Z', async () => {
  live()
  expect(document.querySelector('.org-undo')).toBeNull()
  await pull('clara', 'out', 'solo')
  await render()
  expect(document.querySelector('.org-undo span')?.textContent).toBe('solo agora responde a clara.')
  await click(document.querySelector('.org-undo button')!)
  // Solo answered to no one before.
  expect(save.mock.calls[1]![0]).toMatchObject({ id: 'solo' })
  expect(save.mock.calls[1]![0].reportsTo).toBeUndefined()
  expect(document.querySelector('.org-undo')).toBeNull()
  // Taking Nico out, and back under Bento with ⌘Z.
  await render()
  await pull('nico', 'in', 'Edu')
  await render()
  expect(document.querySelector('.org-undo span')?.textContent).toBe('nico não responde mais a ninguém.')
  await act(async () => { window.dispatchEvent(Object.assign(new window.Event('keydown', { cancelable: true }), { key: 'z', metaKey: true })) })
  expect(save.mock.calls[3]![0]).toMatchObject({ id: 'nico', reportsTo: 'bento' })
  // A change that didn't go through leaves nothing to take back.
  await render()
  save.mockRejectedValueOnce(new Error('não deu'))
  await pull('clara', 'out', 'solo')
  expect(document.querySelector('.org-undo')).toBeNull()
})

it('lets a line be as long as it is drawn, and refuses only a loop', async () => {
  // Under Nico, the third of its line, Solo is a fourth.
  await pull('nico', 'out', 'solo')
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'solo', reportsTo: 'nico' })
  expect(document.querySelector('[role="alert"]')).toBeNull()
  // A loop says nothing: the card was dimmed, and that is reason enough.
  await pull('nico', 'out', 'orion')
  expect(save).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="alert"]')).toBeNull()
})

it('shows why a change did not go through', async () => {
  save.mockRejectedValueOnce(new Error('Só um admin muda os agentes.'))
  await pull('clara', 'out', 'solo')
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Só um admin muda os agentes.')
})

it('moves a card with its branch, and keeps the board as I left it', async () => {
  const before = Object.fromEntries(['Edu', 'orion', 'clara', 'bento', 'nico', 'solo'].map((n) => [n, at(n)]))
  await ptr(card('bento'), 'pointerdown', 100, 100)
  // A twitch isn't a drag.
  await ptr(document, 'pointermove', 102, 101)
  expect(card('bento').className).not.toContain('is-moving')
  await ptr(document, 'pointermove', 160, 140)
  expect(card('bento').className).toContain('is-moving')
  expect(at('bento')).toEqual({ x: before.bento!.x + 60, y: before.bento!.y + 40 })
  expect(at('nico')).toEqual({ x: before.nico!.x + 60, y: before.nico!.y + 40 }) // it answers to Bento: it goes along
  expect(at('clara')).toEqual(before.clara)
  await ptr(document, 'pointerup', 160, 140)
  // Everything is kept where it is, by id; the release doesn't count as a click.
  const kept = settings.mock.calls[0]![0].orgLayout!
  expect(kept).toMatchObject({ me: before.Edu, orion: before.orion, clara: before.clara, solo: before.solo, bento: { x: before.bento!.x + 60, y: before.bento!.y + 40 }, nico: { x: before.nico!.x + 60, y: before.nico!.y + 40 } })
  expect(document.querySelector('.org-side')).toBeNull()
  // With ⌥ a card goes alone.
  await ptr(card('bento'), 'pointerdown', 100, 100, { altKey: true })
  await ptr(document, 'pointermove', 130, 100)
  await ptr(document, 'pointerup', 130, 100)
  expect(settings.mock.calls[1]![0].orgLayout).toMatchObject({ bento: { x: before.bento!.x + 30, y: before.bento!.y }, nico: before.nico })
})

it('moves and zooms the board straight on the page, and keeps the view once the move ends', async () => {
  vi.useFakeTimers()
  try {
    const board = document.querySelector('.orgb')!
    const stage = document.querySelector<HTMLElement>('.orgb__stage')!
    const label = document.querySelector('.org-tools__k')!
    const wheel = async (extra: Record<string, unknown>) =>
      act(async () => {
        const e = new window.Event('wheel', { bubbles: true, cancelable: true })
        Object.assign(e, { clientX: 0, clientY: 0, deltaX: 0, deltaY: 0, ...extra })
        board.dispatchEvent(e)
      })
    // Two fingers: the board slides at once, and only while it moves is it a layer of its own.
    await wheel({ deltaX: 30, deltaY: 10 })
    expect(stage.style.transform).toBe('translate(-30px, -10px) scale(1)')
    expect(board.classList.contains('is-panning')).toBe(true)
    // A pinch zooms where the pointer is, and the zoom reads right away.
    await wheel({ deltaY: -20, ctrlKey: true })
    expect(label.textContent).toBe(`${Math.round(Math.exp(0.2) * 100)}%`)
    // A moment without the wheel ends the move: the view is kept, and the layer goes.
    await act(async () => void vi.advanceTimersByTime(200))
    expect(board.classList.contains('is-panning')).toBe(false)
    expect(stage.getAttribute('style')).toContain(`scale(${Math.exp(0.2)})`)
    // A drag on the board goes on from there.
    await ptr(board, 'pointerdown', 100, 100)
    await ptr(document, 'pointermove', 140, 100)
    // (the zoom kept the corner under the pointer where it was: the board's origin moved with it)
    const f = Math.exp(0.2)
    expect(stage.style.transform).toBe(`translate(${-30 * f + 40}px, ${-10 * f}px) scale(${f})`)
    await ptr(document, 'pointerup', 140, 100)
    expect(board.classList.contains('is-panning')).toBe(false)
    expect(stage.getAttribute('style')).toContain(`translate(${-30 * f + 40}px, ${-10 * f}px)`)
  } finally {
    vi.useRealTimers()
  }
})

it('draws the board as it was left, and tidies it up when asked', async () => {
  expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Organizar')).toBe(false)
  fake = { ...fake, settings: { orgLayout: { me: { x: 0, y: 0 }, orion: { x: 500, y: 40 }, clara: { x: 10, y: 300 }, gone: { x: 9, y: 9 } } } }
  await render()
  expect(at('orion')).toEqual({ x: 500, y: 40 })
  expect(at('clara')).toEqual({ x: 10, y: 300 })
  // Whoever wasn't there when it was left goes under everything, side by side.
  expect(at('bento').y).toBeGreaterThan(300)
  expect(at('nico').y).toBe(at('bento').y)
  expect(at('nico').x).not.toBe(at('bento').x)
  await click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Organizar')!)
  expect(settings).toHaveBeenCalledWith({ orgLayout: null })
})

it('opens what there is to know about an agent on a click, and changes whom it answers to there', async () => {
  await pick('bento')
  const side = document.querySelector('.org-side')!
  expect(side.querySelector('h3')?.textContent).toBe('bento')
  expect(side.textContent).toContain('#eng')
  expect(side.textContent).toContain('nico')
  // Whom it may answer to: not itself, nor the one below it.
  const select = side.querySelector('select')!
  // Whom it may answer to: not itself, nor the one below it.
  expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Ninguém', 'orion', 'clara', 'solo'])
  await act(async () => { Object.defineProperty(select, 'value', { configurable: true, value: 'solo' }); select.dispatchEvent(new window.Event('change', { bubbles: true })) })
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'bento', reportsTo: 'solo' })
  // Its page and its DM are a click away (twice on the card is the DM too); a press on the board closes it.
  await click([...side.querySelectorAll('button')].find((b) => b.textContent === 'Página do agente')!)
  expect(go).toHaveBeenCalledWith({ kind: 'agent', id: 'bento' })
  await act(async () => { card('clara').dispatchEvent(new window.Event('dblclick', { bubbles: true })) })
  expect(go).toHaveBeenCalledWith({ dm: 'clara' })
  await pick('clara')
  expect(document.querySelector('.org-side h3')?.textContent).toBe('clara')
  await ptr(document.querySelector('.orgb')!, 'pointerdown')
  await ptr(document, 'pointerup')
  expect(document.querySelector('.org-side')).toBeNull()
})

it('draws a shared specialist from every boss it answers to, and hangs it under the first', async () => {
  // Three campaigns and the artist they share: it answers to all three, its own line being the first.
  fake = { ...fake, agents: [bot('campaign-a'), bot('campaign-b'), bot('campaign-c'), bot('artist', 'campaign-a', { alsoTo: ['campaign-b', 'campaign-c'] })], conversations: [channel('arte', ['artist'])] }
  await render()
  // One line from me to each campaign, one from the first to the artist, and a dashed one from each other.
  const lines = [...document.querySelectorAll('.orgb__lines g')]
  expect(lines).toHaveLength(6)
  expect(lines.filter((g) => g.classList.contains('is-also'))).toHaveLength(2)
  expect(document.querySelectorAll('.orgb__lines g.is-me')).toHaveLength(3)
  // Drawn once, under the first one: the other two are leaves with a line down to it.
  expect(document.querySelectorAll('.orgb .org-card').length).toBe(5) // me and the four of them
  expect(card('artist').textContent).toContain('#arte')
  expect(at('artist').y).toBeGreaterThan(at('campaign-a').y)
  // Both kinds of line are made and unmade here: the tree's own and the extra ones (only mine, from me, are not).
  expect(document.querySelectorAll('.orgb__hit')).toHaveLength(3)
  // The panel offers the bosses it also answers to, beside the one it answers to first.
  await pick('artist')
  expect(document.querySelector('.org-side')?.textContent).toContain('Também responde a')
  // An extra line picked, and taken out: that one link goes, the one it hangs from stays.
  const extra = [...document.querySelectorAll('.orgb__lines g.is-also')][1]!
  await ptr(extra.querySelector('.orgb__hit')!, 'pointerdown', 5, 5)
  expect(extra.getAttribute('class')).toContain('is-picked')
  await click(document.querySelector('.org-edge-x')!)
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'artist', alsoTo: ['campaign-b'] })
  expect(save.mock.calls[0]![1]).toEqual(['arte'])
  expect(document.body.textContent).toContain('artist não responde mais a campaign-c.')
})

it('gives an agent another boss from the dot beside the one above its card', async () => {
  // Two campaigns and an artist that answers to the first of them; the second takes it too, from the board.
  fake = { ...fake, agents: [bot('campaign-a'), bot('campaign-b'), bot('artist', 'campaign-a'), bot('nina', 'artist')], conversations: [channel('arte', ['artist'])] }
  await render()
  // The dots above the artist's card: the one it answers to, and beside it the one for another boss — on the very
  // point that line will arrive at, clear of the first (topSlots: the middle, then SLOT_GAP to the right).
  const dots = [...card('artist').querySelectorAll('.org-port--in, .org-port--also')]
  expect(dots.map((d) => d.className.includes('org-port--in'))).toEqual([true, false])
  expect((dots[1] as HTMLElement).style.left).toBe(`calc(50% + ${SLOT_GAP}px)`)
  // A card that answers to nobody has no such dot: its first boss is made from the one above it.
  expect(card('campaign-a').querySelector('.org-port--also')).toBeNull()
  expect(card('campaign-a').querySelector('.org-port--in')).not.toBeNull()
  // While it comes from that dot, only a boss it may also answer to is a place to land.
  await ptr(card('artist').querySelector('.org-port--also')!, 'pointerdown', 5, 5)
  expect(document.querySelector('.orgb__line.is-new.is-extra')).not.toBeNull()
  expect(card('campaign-b').className).toContain('is-target')
  expect(card('campaign-a').className).not.toContain('is-target') // the one it already hangs from
  expect(card('Edu').className).not.toContain('is-target') // and never me: I am no boss it answers to
  await ptr(document, 'pointerup', 50, 50)
  expect(save).not.toHaveBeenCalled() // let go on no card at all
  // Let go over the second campaign: one more boss, and it is the extra line, not the one it hangs from.
  await pull('artist', 'also', 'campaign-b')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'artist', alsoTo: ['campaign-b'] })
  expect(save.mock.calls[0]![0].reportsTo).toBe('campaign-a')
  expect(document.body.textContent).toContain('artist também responde a campaign-b.')
  // Never the same one twice, nor one below it: that would close a circle.
  save.mockClear()
  await pull('artist', 'also', 'campaign-a')
  expect(save).not.toHaveBeenCalled()
  await pull('artist', 'also', 'nina')
  expect(save).not.toHaveBeenCalled()
})

// The other way round, with the same two dots: pulled from under a boss, a line let go on the dot beside the
// one above a card adds it as another boss; let go on the card itself it replaces the boss it hangs from.
it('adds or replaces a boss with the dot it is let go on, from the card above', async () => {
  fake = { ...fake, agents: [bot('campaign-a'), bot('campaign-b'), bot('artist', 'campaign-a')], conversations: [channel('arte', ['artist'])] }
  await render()
  // Pulled from under the second campaign, let go on the artist's dot for another boss: added, nothing replaced.
  const drop = async (boss: string, onto: string, where: 'dot' | 'card' = 'dot') => {
    await ptr(card(boss).querySelector('.org-port--out')!, 'pointerdown', 5, 5)
    const el = where === 'dot' ? card(onto).querySelector('.org-port--also')! : card(onto)
    await ptr(el, 'pointerover', 50, 50)
    await ptr(document, 'pointerup', 50, 50)
    await ptr(el, 'pointerout', 60, 60)
  }
  // Only the cards the line may land on offer the dot, and it shows while the line is being pulled.
  await ptr(card('campaign-b').querySelector('.org-port--out')!, 'pointerdown', 5, 5)
  expect(card('artist').querySelector('.org-port--also')?.className).toContain('is-offer')
  expect(card('campaign-a').querySelector('.org-port--also')).toBeNull() // it answers to nobody yet
  await ptr(card('artist').querySelector('.org-port--also')!, 'pointerover', 50, 50)
  expect(card('artist').querySelector('.org-port--also')?.className).toContain('is-over')
  await ptr(document, 'pointerup', 50, 50)
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'artist', reportsTo: 'campaign-a', alsoTo: ['campaign-b'] })
  expect(document.body.textContent).toContain('artist também responde a campaign-b.')
  // Let go on the card body instead: that is the one it hangs from, so what it answered to before is undone.
  save.mockClear()
  await act(async () => root.unmount())
  root = createRoot(document.getElementById('root')!)
  await render()
  await drop('campaign-b', 'artist', 'card')
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'artist', reportsTo: 'campaign-b' })
  expect(save.mock.calls[0]![0].alsoTo).toBeUndefined()
})

// Every boss's line arrives on its own point of the shared card's top edge, however many teams share it.
it('lands each boss line on its own point along the top of a card', async () => {
  fake = {
    ...fake,
    agents: [bot('a'), bot('b'), bot('c'), bot('d'), bot('artist', 'a', { alsoTo: ['b', 'c', 'd'] })],
    conversations: [channel('arte', ['artist'])]
  }
  await render()
  // Where each line ends: the last point of its path, on the artist's top edge.
  const ends = [...document.querySelectorAll('.orgb__lines g')]
    .filter((g) => g.querySelector('.orgb__line'))
    .map((g) => (g.querySelector('.orgb__line')!.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g)!.map(Number))
    .map((n) => ({ x: n[n.length - 2]!, y: n[n.length - 1]! }))
  const top = at('artist').y
  const landings = ends.filter((e) => e.y === top).map((e) => e.x).sort((l, r) => l - r)
  expect(landings).toHaveLength(4) // the tree's own plus the three extras
  expect(new Set(landings).size).toBe(4) // no two on the same spot
  for (let i = 1; i < landings.length; i++) expect(landings[i]! - landings[i - 1]!).toBeGreaterThanOrEqual(14)
  // The one it hangs from stays in the middle, and the others step out from it.
  const middle = at('artist').x + BOARD.w / 2
  expect(landings).toContain(middle)
  expect(landings).toContain(middle + SLOT_GAP)
  expect(landings).toContain(middle - SLOT_GAP)
})

it('asks whoever is at the top, or the agent picked, without leaving the board', async () => {
  const box = (): HTMLInputElement => document.querySelector('.org-ask input')!
  expect(box().getAttribute('placeholder')).toBe('Pedir algo a orion…')
  await type(box(), '  veja por que a conversão caiu  ')
  await act(async () => { document.querySelector('.org-ask')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
  expect(asked).toHaveBeenCalledWith('orion', 'veja por que a conversão caiu')
  expect(box().getAttribute('placeholder')).toContain('Enviado a orion')
  await pick('clara')
  expect(box().getAttribute('placeholder')).toContain('clara')
  await type(box(), 'responda o Fulano')
  await act(async () => { document.querySelector('.org-ask')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })) })
  expect(asked).toHaveBeenLastCalledWith('clara', 'responda o Fulano')
})

it('shows what is under way: the request, the line it travels and what each one is doing', async () => {
  busy = new Map([['nico', { id: 'm1', conversationId: 'eng', threadId: 't1', run: { status: 'working', steps: [{ id: 's', label: 'Rodou', detail: 'npm test', status: 'done' }] } } as Message]])
  fake = { ...fake, delegations: [ask('d1', 'orion', 'nico'), ask('d2', 'orion', 'clara', { asking: 'm9' }), ask('d3', 'orion', 'clara', { state: 'done' })] }
  await render()
  // A chip for each open one, which opens its thread.
  const chips = [...document.querySelectorAll('.org-now .cal-watch__chip')]
  expect(chips).toHaveLength(2)
  await click(chips[0]!)
  expect(go).toHaveBeenCalledWith({ kind: 'conversation', id: 'clientes', message: 'root-d1' })
  expect(go).toHaveBeenCalledWith({ thread: 'root-d1' })
  // Down through Bento to Nico, a dot running on each line; up from Clara, whose question waits.
  expect(document.querySelectorAll('.orgb__lines g.is-flow.is-down')).toHaveLength(2)
  expect(document.querySelectorAll('.orgb__lines g.is-flow.is-up')).toHaveLength(1)
  expect(document.querySelectorAll('.orgb__dot')).toHaveLength(3)
  // What Nico is doing this second, on its card; and from its details, the reply as it is written.
  expect(card('nico').className).toContain('is-working')
  expect(card('nico').textContent).toContain('Rodou: npm test')
  expect(card('clara').textContent).toContain('esperando orion')
  expect(card('orion').textContent).toContain('2 pedidos com o time')
  expect(card('bento').querySelector('.org-card__team')?.getAttribute('title')).toBe('1 responde a ele')
  expect(document.body.textContent).toContain('2 pedidos em andamento')
  await pick('nico')
  await click(document.querySelector('.org-side__live')!)
  expect(go).toHaveBeenCalledWith({ kind: 'conversation', id: 'eng', message: 't1' })
})

it('lets a member look without moving anyone', async () => {
  admin = false
  await render()
  expect(document.querySelector('.org-port')).toBeNull()
  expect(document.querySelector('.orgb__hit')).toBeNull()
  await ptr(card('bento'), 'pointerdown', 100, 100)
  await ptr(document, 'pointermove', 180, 160)
  await ptr(document, 'pointerup', 180, 160)
  expect(settings).not.toHaveBeenCalled()
  expect(save).not.toHaveBeenCalled()
  await pick('bento')
  expect(document.querySelector('.org-side select')?.hasAttribute('disabled')).toBe(true)
})

it('starts a tree in a click when no one answers to anyone', async () => {
  fake = { ...fake, agents: [bot('lia'), bot('theo'), bot('nina')] }
  live()
  await render()
  expect(document.querySelector('.org-coach h2')?.textContent).toBe('Fale com um só. Ele divide o trabalho.')
  // Everyone is on the board all the same, with no one to ask yet.
  expect(names('.orgb .org-card').sort()).toEqual(['Edu', 'lia', 'nina', 'theo'])
  expect(document.querySelector('.org-ask')).toBeNull()
  await click([...document.querySelectorAll('.org-chip--pick')].find((b) => b.textContent?.includes('lia'))!)
  expect(save.mock.calls.map((c) => [c[0].id, c[0].reportsTo])).toEqual([['theo', 'lia'], ['nina', 'lia']])
  // One change, taken back as one.
  await render()
  expect(document.querySelector('.org-undo span')?.textContent).toBe('Todos respondem a lia agora.')
  await click(document.querySelector('.org-undo button')!)
  expect(save.mock.calls.slice(2).map((c) => [c[0].id, c[0].reportsTo])).toEqual([['nina', undefined], ['theo', undefined]])
})

it('lets an admin choose an entry point, marks it, hangs the sectors from it and asks it from the box', async () => {
  // Not chosen yet: Orion heads the one sector, and its panel offers the choice.
  expect(card('orion').textContent).toContain('Chefe do setor')
  await pick('orion')
  const box = document.querySelector('.org-pop__entry input') as HTMLInputElement
  expect(box.checked).toBe(false)
  await act(async () => { Object.defineProperty(box, 'checked', { configurable: true, value: true }); box.dispatchEvent(new window.Event('click', { bubbles: true })) })
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'orion', entry: true })
  // Chosen: orion ← clara, bento; bento ← nico. Bento's team is the sector; Orion is over it, with Mira's beside.
  fake = { ...fake, agents: [...fake.agents.map((x) => (x.id === 'orion' ? { ...x, entry: true } : x)), bot('mira'), bot('lino', 'mira')], delegations: [ask('e1', 'orion', 'bento')] }
  await render()
  expect(card('orion').textContent).toContain('Porta de entrada')
  expect(card('orion').textContent).not.toContain('Chefe do setor')
  expect(card('bento').textContent).toContain('Chefe do setor')
  expect([...document.querySelectorAll('.org-zone__name')].map((z) => z.textContent)).toEqual(['Setor de bento', 'Setor de mira'])
  // Its request to a sector goes down its own line, lit, and says which sector it is for.
  expect(document.querySelector('.org-xlabel')?.textContent).toContain('Pedido para Setor de bento')
  expect(document.querySelectorAll('.org-xline')).toHaveLength(0)
  expect(document.querySelectorAll('.orgb__lines g.is-flow.is-down')).toHaveLength(1)
  expect(document.querySelector('main > p')?.textContent).toContain('1 pedido entre setores')
  // A card that answers to someone has no such choice.
  await pick('bento')
  expect(document.querySelector('.org-pop__entry')).toBeNull()
})

it('lights every line up to the sector\'s head when a request skips whoever is between', async () => {
  // Nico answers to Bento, who answers to Orion: Nico passed it straight to Orion, its sector's head.
  fake = { ...fake, delegations: [ask('u2', 'nico', 'orion')] }
  await render()
  expect(document.querySelectorAll('.orgb__lines g.is-flow.is-up')).toHaveLength(2)
  expect(document.querySelectorAll('.orgb__lines g.is-flow.is-down')).toHaveLength(0)
  expect(document.querySelector('.org-now')?.textContent).toContain('(chefe)')
})

it('tints each sector behind its branch, names it in its panel, and draws a request between two heads', async () => {
  // Two trees, two sectors: Orion's (unnamed) and Mira's, named, with Lino below it.
  fake = { ...fake, agents: [...fake.agents, bot('mira', undefined, { sectorName: 'Financeiro', sectorDoes: 'Cobranças' }), bot('lino', 'mira')], delegations: [ask('x1', 'mira', 'orion'), ask('u1', 'lino', 'mira')] }
  await render()
  expect([...document.querySelectorAll('.org-zone__name')].map((z) => z.textContent)).toEqual(['Setor de orion', 'Financeiro'])
  expect(document.querySelector('.org-zone__does.is-empty')?.textContent).toBe('Diga o que este setor resolve') // wide enough, with nothing written yet; Mira's is too narrow for that line
  expect(card('orion').textContent).toContain('Chefe do setor')
  expect(card('lino').textContent).not.toContain('Chefe do setor')
  const lede = document.querySelector('main > p')?.textContent
  expect(lede).toContain('2 setores')
  expect(lede).toContain('1 pedido entre setores')
  // Mira asked Orion: a dashed line between the two heads, named for the sector it went to.
  expect(document.querySelectorAll('.org-xline')).toHaveLength(1)
  expect(document.querySelector('.org-xlabel')?.textContent).toContain('Pedido para Setor de orion')
  // Lino passed it up to Mira: the line between them flows up.
  expect(document.querySelectorAll('.orgb__lines g.is-flow.is-up')).toHaveLength(1)
  // A click on the sector's name opens its panel, with what came from other sectors. A name typed is
  // saved even when the panel closes before the field is left (a press on the board).
  await click(document.querySelector('.org-zone__name')!)
  const side = document.querySelector('.org-side')!
  expect(side.querySelector('h3')?.textContent).toBe('Setor de orion')
  expect(side.textContent).toContain('Pedido de mira')
  await type(side.querySelector('input')!, 'Técnico')
  expect(document.querySelector('.org-side h3')?.textContent).toBe('Técnico')
  await ptr(document.querySelector('.orgb')!, 'pointerdown')
  await ptr(document, 'pointerup')
  expect(document.querySelector('.org-side')).toBeNull()
  expect(save).toHaveBeenCalledTimes(1)
  expect(save.mock.calls[0]![0]).toMatchObject({ id: 'orion', sectorName: 'Técnico', sectorDoes: '' })
  // A member only looks.
  admin = false
  await render()
  await click(document.querySelector('.org-zone__name')!)
  expect(document.querySelector('.org-side h3')).not.toBeNull()
  expect(document.querySelector('.org-side input')).toBeNull()
})
