// Mention mode on the screens: the checkbox in the channel's agent list, only for agents in the
// channel, and the line under the field when everyone in the room waits to be called.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

// The screens read the store through useStore; here it reads a state made for each test.
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { MembersDialog } = await import('../src/renderer/src/components/Dialogs')
const { allMentionOnly, composerNote } = await import('../src/renderer/src/components/Conversation')

const agent = (id: string, name: string, handle: string): Agent => ({
  id,
  name,
  handle,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false
})
const lia = agent('a1', 'Lia', 'lia')
const theo = agent('a2', 'Theo', 'theo')
const nina = agent('a3', 'Nina', 'nina')
const chan = (mentionOnly?: string[]): Conversation => ({ id: 'c1', kind: 'channel', name: 'engenharia', members: [lia.id, theo.id], ...(mentionOnly ? { mentionOnly } : {}) })

beforeEach(() => {
  fake = { ...getState(), ready: true, agents: [lia, theo, nina] }
})
afterEach(() => vi.clearAllMocks())

const dialog = (mentionOnly: string[]): string =>
  renderToStaticMarkup(<MembersDialog id="c1" name="engenharia" members={[lia.id, theo.id]} mentionOnly={mentionOnly} onClose={() => {}} />)
// The state of one agent's checkbox, as the markup carries it.
const checkedFor = (html: string, name: string): boolean => new RegExp(`<input[^>]*checked=""[^>]*aria-label="Modo menção para ${name}"|<input[^>]*aria-label="Modo menção para ${name}"[^>]*checked=""`).test(html)

describe("a channel's agent list", () => {
  it('shows mention mode ticked for the agent that has it, and unticked for the rest', () => {
    const html = dialog([theo.id])
    expect(checkedFor(html, 'Theo')).toBe(true)
    expect(checkedFor(html, 'Lia')).toBe(false)
  })

  it('offers mention mode only for agents in the channel', () => {
    const html = dialog([])
    expect(html).toContain('@nina') // in the list…
    expect(html).toContain('Modo menção para Lia')
    expect(html).not.toContain('Modo menção para Nina') // …but not in the channel, so nothing to set
  })

  it('counts who is in mention mode', () => {
    expect(dialog([theo.id])).toContain('1 em modo menção')
    expect(dialog([])).not.toContain('em modo menção')
  })
})

describe('the line under the field', () => {
  it('says the room waits to be called when every agent is in mention mode', () => {
    expect(composerNote({ members: [lia, theo], mentionOnly: true })).toContain('modo menção')
    expect(composerNote({ members: [lia, theo], mentionOnly: false })).toContain('Quem estiver no canal responde')
    // A DM and a thread keep their own line, whatever the channel says.
    expect(composerNote({ members: [lia], dm: true, mentionOnly: true })).toContain('sempre responde aqui')
    expect(composerNote({ members: [lia, theo], thread: true, mentionOnly: true })).toContain('Fica nesta thread')
  })
})

describe('a channel where everyone waits to be called', () => {
  it('knows it from the modal', () => {
    const both = [lia.id, theo.id]
    expect(allMentionOnly(chan(both), [lia, theo])).toBe(true)
    expect(allMentionOnly(chan([lia.id]), [lia, theo])).toBe(false)
    expect(allMentionOnly({ id: 'd1', kind: 'dm', name: 'lia', members: [lia.id], mentionOnly: [lia.id] }, [lia])).toBe(false)
    expect(allMentionOnly(chan(), [])).toBe(false)
  })
})
