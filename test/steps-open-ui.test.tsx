// A reply's steps open while the agent works, so they read as they go. With several agents working
// at once that fills the conversation, so each person can keep them closed (#403): only the line with
// what the agent is doing now stays, and a click on it still opens the steps.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { settingsPatchError } from '../src/core/settings-patch'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { RunSteps } = await import('../src/renderer/src/components/Conversation')

const reply = (status: 'working' | 'done'): Message => ({
  id: 'm1',
  conversationId: 'c1',
  author: { kind: 'agent', id: 'a1' },
  text: '',
  at: Date.now(),
  run: { status, steps: [{ id: 's1', label: 'Lendo arquivo', detail: 'src/app.ts', status: status === 'working' ? 'running' : 'done' }] }
})
const steps = (status: 'working' | 'done'): string => renderToStaticMarkup(<RunSteps message={reply(status)} />)

beforeEach(() => {
  fake = { ...getState(), ready: true }
})

describe("a reply's steps while the agent works", () => {
  it('open as it works when the setting is untouched, as before', () => {
    const html = steps('working')
    expect(html).toContain('steps__list')
    expect(html).toContain('Lendo arquivo…') // the line with what it's doing now
  })

  it('stay closed when the person turned them off, keeping the line with what it does now', () => {
    fake = { ...fake, settings: { ...fake.settings, stepsOpen: false } }
    const html = steps('working')
    expect(html).not.toContain('steps__list')
    expect(html).toContain('Lendo arquivo…')
    expect(html).toContain('steps__stop')
  })

  it('are closed after the reply either way', () => {
    expect(steps('done')).not.toContain('steps__list')
    fake = { ...fake, settings: { ...fake.settings, stepsOpen: true } }
    expect(steps('done')).not.toContain('steps__list')
  })

  it("the setting takes a yes or a no, nothing else, and is each person's own", () => {
    expect(settingsPatchError({ stepsOpen: false })).toBeUndefined()
    expect(settingsPatchError({ stepsOpen: null })).toBeUndefined()
    expect(settingsPatchError({ stepsOpen: 'no' })).toBeDefined()
    expect(PERSONAL_SETTINGS).toContain('stepsOpen')
  })
})
