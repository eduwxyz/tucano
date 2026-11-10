// Listen mode on the screens: the second checkbox in the channel's agent list, the count, and the
// line under the field when a channel has agents that Jev may bring in.
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
const { allMentionOnly, anyListening, composerNote } = await import('../src/renderer/src/components/Conversation')

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
const astra = agent('a3', 'Astra', 'astra')
const chan = (modes: { mentionOnly?: string[]; listen?: string[] } = {}): Conversation => ({
  id: 'c1',
  kind: 'channel',
  name: 'engenharia',
  members: [lia.id, theo.id, astra.id],
  ...(modes.mentionOnly ? { mentionOnly: modes.mentionOnly } : {}),
  ...(modes.listen ? { listen: modes.listen } : {})
})

beforeEach(() => {
  fake = { ...getState(), ready: true, agents: [lia, theo, astra] }
})
afterEach(() => vi.clearAllMocks())

const dialog = (modes: { mentionOnly?: string[]; listen?: string[] }): string =>
  renderToStaticMarkup(
    <MembersDialog id="c1" name="engenharia" members={[lia.id, theo.id, astra.id]} mentionOnly={modes.mentionOnly ?? []} listen={modes.listen ?? []} onClose={() => {}} />
  )
const checkedFor = (html: string, label: string, name: string): boolean =>
  new RegExp(`<input[^>]*checked=""[^>]*aria-label="${label} para ${name}"|<input[^>]*aria-label="${label} para ${name}"[^>]*checked=""`).test(html)

describe("a channel's agent list", () => {
  it('shows listen mode ticked for the agent that has it, and unticked for the rest', () => {
    const html = dialog({ listen: [astra.id] })
    expect(checkedFor(html, 'Modo escuta', 'Astra')).toBe(true)
    expect(checkedFor(html, 'Modo escuta', 'Lia')).toBe(false)
    // The two modes sit side by side, and an agent in one isn't in the other.
    expect(checkedFor(html, 'Modo menção', 'Astra')).toBe(false)
  })

  it('offers listen mode only for agents in the channel', () => {
    const html = dialog({})
    expect(html).toContain('Modo escuta para Lia')
    expect(html).toContain('Modo escuta para Astra')
    expect(html).toContain('Modo menção para Astra')
  })

  it('counts who is in each mode', () => {
    expect(dialog({ listen: [astra.id] })).toContain('1 em modo escuta')
    expect(dialog({ listen: [astra.id], mentionOnly: [lia.id] })).toContain('1 em modo menção')
    expect(dialog({ listen: [astra.id], mentionOnly: [lia.id] })).toContain('1 em modo escuta')
    expect(dialog({})).not.toContain('em modo escuta')
  })
})

describe('the line under the field', () => {
  it('says who joins when the message is theirs, and that @ calls right away', () => {
    expect(composerNote({ members: [lia, astra], listening: true })).toContain('Quem escuta entra quando a mensagem é do assunto dele')
    // Everyone quiet, in either mode: the shortest true line wins.
    expect(composerNote({ members: [lia, astra], mentionOnly: true, listening: true })).toContain('modo menção ou escuta')
    expect(composerNote({ members: [lia, astra], mentionOnly: false, listening: false })).toContain('Quem estiver no canal responde')
  })
})

describe('a channel where nobody answers by default', () => {
  it('counts a listening agent as quiet too', () => {
    const both = [lia.id, theo.id]
    expect(allMentionOnly(chan({ mentionOnly: [lia.id], listen: [theo.id] }), [lia, theo])).toBe(true)
    expect(allMentionOnly(chan({ listen: [theo.id] }), [lia, theo])).toBe(false)
    expect(anyListening(chan({ listen: [theo.id] }), [lia, theo])).toBe(true)
    expect(anyListening(chan({ mentionOnly: [theo.id] }), [lia, theo])).toBe(false)
    expect(anyListening({ id: 'd1', kind: 'dm', name: 'lia', members: [lia.id], listen: [lia.id] }, [lia])).toBe(false)
  })
})
