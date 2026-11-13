import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Delegation, Message } from '../src/shared/types'
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
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, MeAvatar: () => null, Icon: () => null, ago: () => 'há 2 min' }))
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
// A line pulled from a card's dot (under it, or above it) and let go over another card.
const pull = async (from: string, side: 'out' | 'in', onto: string) => {
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

it('says why a line that would be too long does not hold', async () => {
  // Under Nico, the third of its line, Solo would be a fourth.
  await pull('nico', 'out', 'solo')
  expect(save).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Uma linha tem no máximo 3 agentes')
  // A loop says nothing: the card was dimmed, and that is reason enough.
  await pull('clara', 'out', 'solo')
  expect(document.querySelector('[role="alert"]')).toBeNull()
  await pull('nico', 'out', 'orion')
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
  // Whom it may answer to: not itself, nor the one below it, nor one that would make its line too long (Clara, with Nico below it).
  expect([...select.querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Ninguém', 'orion', 'solo'])
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
