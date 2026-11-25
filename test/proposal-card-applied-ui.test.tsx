// A team card from a regular agent ("proposed by Tinker"), on screen: what it shows comes only from the
// card on the message (the core keeps it settled, see proposal-once-core), so once applied it never
// offers "Criar time" again, however often it's drawn: while the reply still works, after it, or
// when the conversation is opened again from a snapshot.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message, Proposal } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { Proposals } = await import('../src/renderer/src/components/Tuca')

const agent = (id: string, name: string): Agent => ({ id, name, handle: name.toLowerCase(), role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 2_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }) as Agent
const tinker = agent('tinker', 'Tinker')
const member = (name: string): Extract<Proposal, { kind: 'team' }>['agents'][number] => ({ name, role: 'Ops', color: 'amber', instructions: `Você é ${name}.`, modelId: 'sonnet', effort: 'low', web: false, grants: {} })
const team: Proposal = { id: 'p1', kind: 'team', agents: [member('Critic'), member('Shipper')] }
const reply = (p: Proposal, status: 'working' | 'done'): Message => ({ id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'tinker' }, text: '', at: 10, run: { status, steps: [], proposals: [p] } }) as Message
const html = (m: Message): string => {
  fake = { ...getState(), ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', agents: [tinker, agent('c1', 'Critic'), agent('s1', 'Shipper')], connectors: [], conversations: [], messages: { d1: [m] } } as State
  return renderToStaticMarkup(<Proposals message={m} />)
}

beforeEach(() => vi.clearAllMocks())

describe("a regular agent's team card", () => {
  it('open, offers Criar time and Descartar', () => {
    const out = html(reply(team, 'working'))
    expect(out).toContain('proposta de Tinker')
    expect(out).toContain('Criar time')
    expect(out).toContain('Descartar')
  })

  it('applied, says so and never offers Criar time again: while the reply works, after it, drawn again', () => {
    const applied: Proposal = { ...team, state: 'applied', appliedId: 'c1', agentIds: ['c1', 's1'], undo: { until: Date.now() + 3_600_000 } } as Proposal
    for (const status of ['working', 'done', 'done'] as const) {
      const out = html(reply(applied, status))
      expect(out).toContain('aplicado')
      expect(out).not.toContain('Criar time')
      expect(out).not.toContain('>Descartar<')
      expect(out).toContain('Desfazer')
    }
  })
})
