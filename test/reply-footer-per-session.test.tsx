// Every session in a channel keeps its own action buttons. A channel holds the sessions of whoever
// answered in it, one under the other, and each row that ended carries its own ways on in its own
// footer: Continue, Try again, Try with instructions. They are the row's, not the channel's: the pill
// under the second of three acts on the second of three, and none of them hides until the pointer
// finds the row it belongs to.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(document, { oninput: null })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id)
})
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

// What each pill asked the core for, by the reply it sits under.
const continued = vi.hoisted(() => [] as string[])
const retried = vi.hoisted(() => [] as string[])
const steered = vi.hoisted(() => [] as { text: string; mode?: string; replyId?: string }[])

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    setTab: vi.fn(),
    navigate: vi.fn(),
    voiceStatus: vi.fn(() => new Promise(() => {})),
    continueRun: (id: string): void => void continued.push(id),
    retryRun: (id: string): void => void retried.push(id),
    sendMessage: (_conversationId: string, text: string, _images?: unknown, _threadId?: string, _files?: unknown, mode?: string, replyId?: string): void => void steered.push({ text, mode, replyId })
  }
})
const realStore = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ConversationView } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia = (): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Engineering', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
const channel: Conversation = { id: 'c1', kind: 'channel', name: 'engineering', members: ['a1'] }
const step = (id: string): Step => ({ id, label: `Read src/core/${id}.ts`, status: 'done', ms: 120 })
// A reply the person stopped: it did something before it ended, so it has somewhere to go on from.
const stopped = (id: string, at: number): Message => ({
  id,
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: `answer ${id}`,
  at,
  run: { status: 'stopped', steps: [step(id)] }
})
// A reply at work in that same channel: its own row, its own steer.
const running = (id: string, at: number): Message => ({
  ...stopped(id, at),
  run: { status: 'working', steps: [{ id, label: 'Pensando', status: 'running' }] }
})

let root: Root | undefined
beforeEach(() => {
  setLang('en')
  continued.length = 0
  retried.length = 0
  steered.length = 0
  document.getElementById('root')!.innerHTML = ''
  root = undefined
  fake = {
    ...realStore.getState(),
    ready: true,
    people: [ana],
    you: 'ana',
    agents: [lia()],
    conversations: [channel],
    messages: { c1: [stopped('m1', 1), stopped('m2', 2), stopped('m3', 3)] },
    inbox: { approvals: [], questions: [] }
  } as State
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
})

const render = async (): Promise<void> => {
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host)
  const mounted = root
  await act(async () => mounted.render(<ConversationView id="c1" />))
}

// The three sessions on screen, each with its own footer and the pills in it.
const rows = (): { id: string; foot: Element; pills: HTMLButtonElement[] }[] =>
  [...document.querySelectorAll('.msg--agent')].map((m) => {
    const foot = m.querySelector('.msg__meta')!
    return { id: m.getAttribute('data-id')!, foot, pills: [...foot.querySelectorAll<HTMLButtonElement>('button')] }
  })
const labelled = (p: HTMLButtonElement): string => p.getAttribute('aria-label') ?? ''

describe('a channel with three sessions', () => {
  it('draws one footer and its own ways on under each session that ended', async () => {
    await render()
    const all = rows()
    expect(all).toHaveLength(3)
    // One footer per session: the newest one does not collect a second cluster of its own.
    expect(document.querySelectorAll('.msg__meta')).toHaveLength(3)
    for (const row of all) {
      expect(row.foot).not.toBeNull()
      const words = row.pills.map(labelled)
      expect(words).toContain('Continue')
      expect(words).toContain('Try again')
      expect(words).toContain('Try with instructions')
    }
  })

  it('keeps the ways on in sight, not behind the pointer', async () => {
    // A pill that is only there while the row is hovered is a control the channel does not show: with
    // three sessions in a column, every one of them has to say how it goes on.
    await render()
    for (const row of rows())
      for (const p of row.pills) expect(p.className).not.toContain('msg__hire')
  })

  it('wires each pill to the session it sits under, not to the newest one', async () => {
    await render()
    const [, second] = rows()
    const click = async (label: string): Promise<void> => {
      const p = second!.pills.find((b) => labelled(b) === label)!
      await act(async () => p.click())
    }
    await click('Continue')
    expect(continued).toEqual(['m2'])
    await click('Try again')
    expect(retried).toEqual(['m2'])
    // "Try with instructions" opens the row's own note, and what is written goes to that same reply.
    await click('Try with instructions')
    const note = second!.foot.querySelector<HTMLTextAreaElement>('.retry-note textarea')!
    expect(note).not.toBeNull()
    let proto: object | null = Object.getPrototypeOf(note)
    let set: ((v: string) => void) | undefined
    while (proto && !set) {
      set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      proto = Object.getPrototypeOf(proto)
    }
    await act(async () => {
      set!.call(note, 'say it in a table')
      note.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const send = [...second!.foot.querySelectorAll<HTMLButtonElement>('.retry-note__row button')].find((b) => b.textContent?.includes('Try again with this'))!
    expect(send.disabled).toBe(false)
    await act(async () => send.click())
    expect(retried).toEqual(['m2', 'm2'])
    // And the same pill on the third row asks for the third reply.
    const third = rows()[2]!
    await act(async () => third.pills.find((b) => labelled(b) === 'Continue')!.click())
    expect(continued).toEqual(['m2', 'm3'])
  })

  it('gives the steer only to the session at work', async () => {
    // Two finished and one at work: the finished pair keeps its three ways on, and the row at work
    // carries the steer in their place.
    fake = { ...fake, messages: { c1: [stopped('m1', 1), stopped('m2', 2), running('m3', 3)] } } as State
    await render()
    const all = rows()
    expect(all.map((r) => r.foot.querySelectorAll('.steps__steer-pill').length)).toEqual([0, 0, 1])
    const count = (label: string): number[] => all.map((r) => r.pills.filter((b) => labelled(b) === label).length)
    expect(count('Continue')).toEqual([1, 1, 0])
    expect(count('Try again')).toEqual([1, 1, 0])
    expect(count('Try with instructions')).toEqual([1, 1, 0])
  })

  it('gives every session at work its own steer, and steers the one it sits under', async () => {
    // Three replies running at once in one channel: each is a session of its own, so each says how to go
    // on, and the note under the second reaches the second.
    fake = { ...fake, messages: { c1: [running('m1', 1), running('m2', 2), running('m3', 3)] } } as State
    await render()
    const all = rows()
    expect(all.map((r) => r.foot.querySelectorAll('.steps__steer-pill').length)).toEqual([1, 1, 1])
    // None of them offers a way back: a reply at work is steered, not tried again.
    for (const row of all) expect(row.pills.some((b) => labelled(b) === 'Try again')).toBe(false)
    const second = all[1]!
    await act(async () => second.foot.querySelector<HTMLButtonElement>('.steps__steer-pill')!.click())
    const note = second.foot.querySelector<HTMLTextAreaElement>('.retry-note textarea')!
    let proto: object | null = Object.getPrototypeOf(note)
    let set: ((v: string) => void) | undefined
    while (proto && !set) {
      set = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      proto = Object.getPrototypeOf(proto)
    }
    await act(async () => {
      set!.call(note, 'go with the second layout')
      note.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const send = [...second.foot.querySelectorAll<HTMLButtonElement>('.retry-note__row button')].find((b) => b.textContent?.trim() === 'Steer')!
    expect(send.disabled).toBe(false)
    await act(async () => send.click())
    // Handed into the second reply, as a steer, and into no other.
    expect(steered).toEqual([{ text: 'go with the second layout', mode: 'steer', replyId: 'm2' }])
  })
})
