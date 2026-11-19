// A reply's steps: every one (what the app has always done), the latest few in a window that
// fades the oldest out, or one line of current activity. Chosen in Settings › General, per reply by
// agent over workspace, and nothing changes unless someone picks one.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message, Settings, Step } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  // The reasoning panel is drawn by RunSteps too; it has its own test, and it reads a live store.
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), useLiveThought: () => undefined }
})
const { getState } = await import('../src/renderer/src/store')
const { RunSteps } = await import('../src/renderer/src/components/Conversation')
const { settingsPatchError } = await import('../src/core/settings-patch')
const { People } = await import('../src/core/people')
const { PERSONAL_SETTINGS } = await import('../src/core/policy-people')
const { setLang } = await import('../src/shared/lang')
const { stepsModeFor, stepsKeep, stepsWindow, STEPS_LATEST, STEPS_FADE, STEPS_LATEST_MIN, STEPS_LATEST_MAX } = await import('../src/shared/steps')

const steps = (n: number, running = false): Step[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, label: `passo ${i + 1}`, status: i === n - 1 && running ? ('running' as const) : ('done' as const) }))
const reply = (n: number): Message => ({ id: 'm1', conversationId: 'dm', author: { kind: 'agent', id: 'a1' }, text: '', at: Date.now(), run: { status: 'working', steps: steps(n, true) } })
const drawn = (n: number): string => renderToStaticMarkup(<RunSteps message={reply(n)} />)
const settings = (s: Partial<Settings>): Settings => ({ ...getState().settings, ...s })
const withAgent = (a: Partial<Agent>): void => {
  fake = { ...fake, agents: fake.agents.map((x) => (x.id === 'a1' ? { ...x, ...a } : x)) }
}

// The words in the markup are the English ones, so a failing line says what it means.
beforeAll(() => setLang('en'))

beforeEach(() => {
  const clean = { ...getState().settings }
  delete clean.steps
  delete clean.stepsLatest
  // One agent, a1, who is the author of every reply drawn here.
  const one: Agent = { ...getState().agents[0]!, id: 'a1', name: 'Theo', handle: 'theo' }
  fake = { ...getState(), ready: true, settings: clean, agents: [{ ...one, steps: undefined }] }
})

describe('which mode a reply reads in', () => {
  it('is every step when nobody chose anything', () => {
    expect(stepsModeFor({}, undefined)).toBe('all')
    expect(stepsModeFor(undefined, null)).toBe('all')
    expect(drawn(3)).toContain('steps--all')
  })

  it("follows the workspace's, and an agent's own wins over it", () => {
    expect(stepsModeFor({ steps: 'latest' }, undefined)).toBe('latest')
    expect(stepsModeFor({ steps: 'latest' }, { steps: 'one-line' })).toBe('one-line')
    // An agent left on "same as the app" doesn't hold a value of its own.
    expect(stepsModeFor({ steps: 'latest' }, { steps: undefined })).toBe('latest')
  })

  it('ignores a value that is not one of the three', () => {
    expect(stepsModeFor({ steps: 'folded' as never }, undefined)).toBe('all')
    expect(stepsModeFor({}, { steps: 'todos' as never })).toBe('all')
  })
})

describe('the window of latest steps', () => {
  it('keeps 20 by default, and clamps what was saved', () => {
    expect(stepsKeep(undefined)).toBe(STEPS_LATEST)
    expect(stepsKeep(0)).toBe(STEPS_LATEST_MIN)
    expect(stepsKeep(10_000)).toBe(STEPS_LATEST_MAX)
    expect(stepsKeep(12.6)).toBe(13)
    expect(stepsKeep(Number.NaN)).toBe(STEPS_LATEST)
  })

  it('shows the last ones, counts the ones left behind and fades the oldest shown', () => {
    const w = stepsWindow(steps(25), 'latest', undefined)
    expect(w.shown).toHaveLength(20)
    expect(w.shown[0]!.id).toBe('s6')
    expect(w.hidden).toBe(5)
    expect(w.fade).toBe(STEPS_FADE)
  })

  it('fades nothing when they all fit, and never touches the other modes', () => {
    expect(stepsWindow(steps(8), 'latest', 20)).toEqual({ shown: steps(8), hidden: 0, fade: 0 })
    expect(stepsWindow(steps(30), 'all', 20)).toEqual({ shown: steps(30), hidden: 0, fade: 0 })
    expect(stepsWindow(steps(30), 'one-line', 20)).toEqual({ shown: steps(30), hidden: 0, fade: 0 })
  })
})

describe('a reply drawn in each mode', () => {
  it('every step: the list is there while it works, all of them', () => {
    const html = drawn(25)
    expect(html).toContain('steps__list')
    expect(html.match(/class="step /g)).toHaveLength(25)
    expect(html).not.toContain('steps__earlier')
    expect(html).not.toContain('step--fading')
  })

  it('the latest 20: a window, the 5 left out said, and the oldest shown fading', () => {
    fake = { ...fake, settings: settings({ steps: 'latest' }) }
    const html = drawn(25)
    expect(html).toContain('steps--latest')
    expect(html.match(/class="step /g)).toHaveLength(20)
    expect(html).toContain('5 earlier steps')
    expect(html.match(/step--fading/g)).toHaveLength(5)
    // The fade goes from almost gone at the top to nearly opaque at the bottom of the five.
    expect(html).toContain('opacity:0.2')
    expect(html).toContain('opacity:0.84')
  })

  it('one line: the current action, a disclosure, and the stop still there', () => {
    fake = { ...fake, settings: settings({ steps: 'one-line' }) }
    const html = drawn(7)
    expect(html).toContain('steps--one-line')
    expect(html).not.toContain('steps__list')
    expect(html).toContain('steps__chev')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('passo 7')
    expect(html).toContain('Stop')
  })

  it("one agent's own choice shows in its replies even when the app's is different", () => {
    fake = { ...fake, settings: settings({ steps: 'all' }) }
    withAgent({ steps: 'one-line' })
    expect(drawn(4)).not.toContain('steps__list')
    withAgent({ steps: undefined })
    expect(drawn(4)).toContain('steps__list')
  })
})

describe('the setting itself', () => {
  it('takes the three modes, and nothing else', () => {
    expect(settingsPatchError({ steps: 'all' })).toBeUndefined()
    expect(settingsPatchError({ steps: 'latest' })).toBeUndefined()
    expect(settingsPatchError({ steps: 'one-line' })).toBeUndefined()
    expect(settingsPatchError({ steps: null })).toBeUndefined()
    expect(settingsPatchError({ steps: 'folded' })).toBeTruthy()
    expect(settingsPatchError({ stepsLatest: 20 })).toBeUndefined()
    expect(settingsPatchError({ stepsLatest: '20' })).toBeTruthy()
  })

  it("is each person's own, and doesn't come with the workspace", () => {
    expect(PERSONAL_SETTINGS).toContain('steps')
    expect(PERSONAL_SETTINGS).toContain('stepsLatest')
    const saved = settings({ steps: 'one-line', stepsLatest: 12 })
    const people = new People({ prefs: () => ({}) } as never)
    const ownerView = people.settingsFor({ id: 'ana', role: 'owner' }, saved)
    expect(ownerView.steps).toBe('one-line')
    expect(ownerView.stepsLatest).toBe(12)
    const memberView = people.settingsFor({ id: 'bia', role: 'member' }, saved)
    expect(memberView.steps).toBeUndefined()
    expect(memberView.stepsLatest).toBeUndefined()
  })
})
