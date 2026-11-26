// Follow keeps each turn in its own round: the earlier toolchain, thinking and answer stay under
// the newer one. The thinking of a finished round is kept on the run, so starting another Follow
// cannot clear it, and a Proceed or next-steps card on the reply changes none of it.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, RunRound, Settings, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
window.Element.prototype.scrollTo = () => {}
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

const live = vi.hoisted(() => ({ thought: 'a newer thought that arrived live' }))
let fake: State
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(fake),
  useLiveThoughtState: () => ({ text: live.thought, start: 0 }),
  sendMessage: (): void => {},
  stopRun: (): void => {}
}))

const { createRoot } = await import('react-dom/client')
const { Rounds } = await import('../src/renderer/src/components/Conversation')

const step = (id: string, label = 'Read a file'): Step => ({ id, label, status: 'done', ms: 10 })
const thinking = (n: number): Step => ({ id: `thought-${n}`, label: 'Thought', status: 'done' })
const instruction = (n: number): Step => ({ id: `follow-${n}`, kind: 'steer', label: 'You asked it to go on', input: `go on ${n}`, status: 'done' })
const round = (n: number, follow?: number): RunRound => ({
  id: `round-${n}`,
  steps: [...(follow ? [instruction(follow)] : []), thinking(n), step(`tool-${n}`)],
  text: `Answer ${n}`,
  thought: `kept thought ${n}`
})

const message = (rounds: RunRound[], extra: Partial<NonNullable<Message['run']>> = {}): Message => ({
  id: 'm1',
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: rounds.map((r) => r.text).join('\n\n'),
  at: Date.now(),
  run: { status: 'working', steps: rounds.flatMap((r) => r.steps), rounds, ...(extra as object) } as NonNullable<Message['run']>
})

let root: Root
beforeEach(() => {
  fake = { settings: { showThinking: true, stepsOpen: true } as Settings } as State
  live.thought = 'a newer thought that arrived live'
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const draw = async (msg: Message): Promise<void> => {
  await act(async () => root.render(<Rounds message={msg} said={msg.text} components={{}} />))
}
const outputs = (): string[] => [...document.querySelectorAll('.msg__round .msg__text')].map((el) => el.textContent?.trim() ?? '')
const thoughts = (): string[] => [...document.querySelectorAll('.msg__round .thought')].map((el) => (el.querySelector('.thought__last') ?? el.querySelector('.thought__text'))?.textContent?.trim() ?? '')

describe('a reply that kept going', () => {
  it('draws each round in order, and a new Follow does not clear an earlier thought', async () => {
    // Two Follows: the answer it first gave, then two rounds under it. The last one is at work.
    const msg = message([round(1), round(2, 2), round(3, 3)])
    await draw(msg)
    expect(document.querySelectorAll('.msg__round')).toHaveLength(3)
    expect(outputs()).toEqual(['Answer 1', 'Answer 2', 'Answer 3'])
    expect(thoughts().slice(0, 2)).toEqual(['kept thought 1', 'kept thought 2'])
    expect(thoughts()[2]).toBe('a newer thought that arrived live')

    // The live cache starts over with the next round. The two earlier blocks read from the run.
    live.thought = ''
    await draw(msg)
    expect(document.querySelectorAll('.msg__round')).toHaveLength(3)
    expect(thoughts().slice(0, 2)).toEqual(['kept thought 1', 'kept thought 2'])
    expect(outputs()).toEqual(['Answer 1', 'Answer 2', 'Answer 3'])
  })

  it('gives each round its own reasoning container, under that round’s own steps', async () => {
    const rounds = [
      { id: 'r1', steps: [step('tool-1'), thinking(1)], text: 'Answer 1' }, // no reasoning was kept
      { id: 'r2', steps: [step('tool-2'), thinking(2)], text: 'Answer 2', thought: 'Reasoning kept with round two' },
      { id: 'r3', steps: [step('tool-3'), thinking(3)], text: '' }
    ]
    live.thought = 'Live reasoning of round three'
    await draw(message(rounds))

    const blocks = [...document.querySelectorAll('.msg__round')]
    expect(blocks).toHaveLength(3)
    expect(blocks[0]!.querySelector('.thought')).toBeNull() // an old round with no thought of its own
    const older = blocks[1]!.querySelector('.thought')
    expect(older?.textContent).toContain('Reasoning kept with round two')
    expect(older?.textContent).not.toContain('Live reasoning of round three')

    const newest = blocks[2]!.querySelector('.thought')
    expect(newest?.textContent).toContain('Live reasoning of round three')
    expect(newest?.previousElementSibling?.classList.contains('steps__list')).toBe(true)

    // Opened, the older round's container follows its own steps, not the newest round's.
    await act(async () => blocks[1]!.querySelector('.steps__toggle')!.dispatchEvent(new window.Event('click', { bubbles: true })))
    expect(blocks[1]!.querySelector('.steps__list')!.nextElementSibling).toBe(older)
  })

  it('keeps each finished round’s reasoning with it and hides the stream when thinking is off', async () => {
    const rounds = [
      { id: 'r1', steps: [thinking(1)], text: 'Answer 1', thought: 'Reasoning kept with round one' },
      { id: 'r2', steps: [thinking(2)], text: 'Answer 2', thought: 'Reasoning kept with round two' }
    ]
    live.thought = 'The words of a different round, never shown here'
    await draw(message(rounds, { status: 'done' }))

    expect(thoughts()).toEqual(['Reasoning kept with round one', 'Reasoning kept with round two'])
    expect([...document.querySelectorAll('.thought')].some((el) => el.textContent?.includes('different round'))).toBe(false)

    fake.settings.showThinking = false
    await draw(message(rounds, { status: 'done' }))
    expect(document.querySelectorAll('.thought')).toHaveLength(0)
  })

  it('does not make or remove a round when the reply has a Proceed or next-steps card', async () => {
    const rounds = [round(1), round(2, 2), round(3, 3)]
    await draw(message(rounds))
    const before = document.querySelectorAll('.msg__round').length

    const questions = [{ id: 'q1', kind: 'text' as const, question: 'Go on?', proceed: true as const }]
    await draw(message(rounds, { questions, stepsOpen: true, status: 'done' }))
    expect(document.querySelectorAll('.msg__round').length).toBe(before)
    expect(outputs()).toEqual(['Answer 1', 'Answer 2', 'Answer 3'])
    expect(thoughts().slice(0, 2)).toEqual(['kept thought 1', 'kept thought 2'])

    await draw(message(rounds, { questions: undefined, stepsOpen: undefined }))
    expect(document.querySelectorAll('.msg__round').length).toBe(before)
  })
})
