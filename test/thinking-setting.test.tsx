// The model's reasoning, on screen only when the person asked for it: off by default, one switch
// in Settings, and each person's own (it does not come with the workspace).
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
let thought: string | undefined
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), useLiveThought: () => thought }
})
const { getState } = await import('../src/renderer/src/store')
const { Thought } = await import('../src/renderer/src/components/Conversation')
const { settingsPatchError } = await import('../src/core/settings-patch')
const { People } = await import('../src/core/people')
const { PERSONAL_SETTINGS } = await import('../src/core/policy-people')

const message: Message = { id: 'm1', conversationId: 'dm', author: { kind: 'agent', id: 'a1' }, text: '', at: 1 }
const drawn = (): string => renderToStaticMarkup(<Thought message={message} working />)

beforeEach(() => {
  thought = 'o pedido tem duas partes'
  fake = { ...getState(), ready: true, settings: { ...getState().settings } }
})

describe("the model's thinking on screen", () => {
  it('is off when the setting was never touched: only the steps and the answer', () => {
    expect(getState().settings.showThinking).toBeUndefined()
    expect(drawn()).toBe('')
  })

  it('stays off when the person turned it off, and on when they turned it on', () => {
    fake = { ...fake, settings: { ...fake.settings, showThinking: false } }
    expect(drawn()).toBe('')
    fake = { ...fake, settings: { ...fake.settings, showThinking: true } }
    const html = drawn()
    expect(html).toContain('class="thought"')
    expect(html).toContain('Pensando')
    expect(html).toContain('o pedido tem duas partes')
  })

  it('once the reply ends it is kept, said in the past', () => {
    fake = { ...fake, settings: { ...fake.settings, showThinking: true } }
    expect(renderToStaticMarkup(<Thought message={message} working={false} />)).toContain('Pensou')
  })

  it('is nothing at all while the model has thought nothing yet', () => {
    thought = undefined
    fake = { ...fake, settings: { ...fake.settings, showThinking: true } }
    expect(drawn()).toBe('')
  })
})

describe('the switch that turns it on', () => {
  it('is a setting the app accepts, as a boolean and nothing else', () => {
    expect(settingsPatchError({ showThinking: true })).toBeUndefined()
    expect(settingsPatchError({ showThinking: false })).toBeUndefined()
    expect(settingsPatchError({ showThinking: null })).toBeUndefined()
    expect(settingsPatchError({ showThinking: 'sim' })).toBeTruthy()
    expect(settingsPatchError({ showThinking: 1 })).toBeTruthy()
  })

  it("is each person's own: a member does not inherit the owner's choice", () => {
    expect(PERSONAL_SETTINGS).toContain('showThinking')
    const people = new People({ prefs: () => ({}) } as never)
    const owner = people.settingsFor({ id: 'ana', role: 'owner' }, { showThinking: true } as Settings)
    expect(owner.showThinking).toBe(true)
    const member = people.settingsFor({ id: 'bia', role: 'member' }, { showThinking: true } as Settings)
    expect(member.showThinking).toBeUndefined()
  })
})
