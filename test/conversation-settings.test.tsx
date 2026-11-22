// Settings › Conversations: how tall the reasoning preview is before it scrolls, and how many of a
// long reply's steps the list keeps. Both are the person's own, both are the same for everyone until
// someone changes them.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { settingsPatchError } from '../src/core/settings-patch'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'
import { STEPS_LATEST, stepsKeep, stepsModeFor, stepsWindow } from '../src/shared/steps'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    useLiveThoughtState: () => ({ text: 'weighing the two paths', start: 0 })
  }
})
const { getState } = await import('../src/renderer/src/store')
const { Thought, RunSteps } = await import('../src/renderer/src/components/Conversation')

const step = (n: number): Step => ({ id: `s${n}`, label: `Passo ${n}`, status: 'done' })
const reply = (count: number, status: 'working' | 'done' = 'working'): Message => ({
  id: 'm1',
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: '',
  at: Date.now(),
  run: { status, steps: Array.from({ length: count }, (_, i) => step(i + 1)) }
})

beforeEach(() => {
  fake = { ...getState(), ready: true, settings: { ...getState().settings, showThinking: true } }
})

describe('a long reply’s steps', () => {
  it('read every one when nothing was chosen, as before', () => {
    fake.settings = { ...fake.settings, steps: undefined, stepsLatest: undefined }
    const html = renderToStaticMarkup(<RunSteps message={reply(30)} />)
    expect(html.match(/<li class="step /g)?.length).toBe(30)
    expect(html).not.toContain('steps__more')
  })

  it('keep only the newest few when the person asked for a window, and say how many left', () => {
    fake.settings = { ...fake.settings, steps: 'latest', stepsLatest: 5 }
    const html = renderToStaticMarkup(<RunSteps message={reply(8)} />)
    expect(html.match(/<li class="step /g)?.length).toBe(5)
    expect(html).toContain('3 passos mais antigos fora da lista') // the window's own line, in the app's language
    // The line above the list still names every step the reply took, not the five on screen.
    expect(renderToStaticMarkup(<RunSteps message={reply(8, 'done')} />)).toContain('8 passos')
  })

  it('clamp the number to what the window can hold', () => {
    expect(stepsKeep(0)).toBe(5)
    expect(stepsKeep(10_000)).toBe(100)
    expect(stepsKeep(undefined)).toBe(STEPS_LATEST)
    expect(stepsWindow([step(1), step(2)], 'latest', 1).shown.map((s) => s.id)).toEqual(['s1', 's2'])
  })
})

describe('the reasoning preview', () => {
  it('wears the height the person chose', () => {
    fake.settings = { ...fake.settings, thinkingSize: 'lg' }
    expect(renderToStaticMarkup(<Thought message={reply(0)} working />)).toContain('data-size="lg"')
  })

  it('keeps the height it always had when nothing was chosen', () => {
    fake.settings = { ...fake.settings, thinkingSize: undefined }
    expect(renderToStaticMarkup(<Thought message={reply(0)} working />)).toContain('data-size="sm"')
  })
})

describe('the settings themselves', () => {
  it('are the person’s own, not the workspace’s', () => {
    for (const key of ['steps', 'stepsLatest', 'thinkingSize'] as const) expect(PERSONAL_SETTINGS).toContain(key)
  })

  it('take the values the controls offer and nothing else', () => {
    expect(settingsPatchError({ thinkingSize: 'md' })).toBeUndefined()
    expect(settingsPatchError({ steps: 'latest', stepsLatest: 12 })).toBeUndefined()
    expect(settingsPatchError({ thinkingSize: 'huge' })).toBeTruthy()
    expect(settingsPatchError({ steps: 'one-line' })).toBeTruthy()
    expect(settingsPatchError({ stepsLatest: 'twelve' })).toBeTruthy()
  })

  it('read as every step and the old height until someone picks', () => {
    expect(stepsModeFor({})).toBe('all')
    expect(stepsModeFor({ steps: 'latest' })).toBe('latest')
  })
})
