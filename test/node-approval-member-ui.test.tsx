// On a lent computer, only its person decides what runs on it (0.2.37): the store's canDecide
// gave the buttons to the admins and to the agent's person, so a member whose computer an agent
// of the team wanted to use saw no buttons, and an admin saw them and got the core's refusal.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Approval, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { canDecide, getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ApprovalCard } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'admin', about: '' }
const maria: Person = { id: 'maria', name: 'Maria', role: 'member', about: '' }
const carl: Person = { id: 'carl', name: 'Carl', role: 'member', about: '' }
const people = [ana, bia, maria, carl]
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'carl' }
const as = (you: string): Pick<State, 'people' | 'you' | 'agents'> => ({ people, you, agents: [lia] })
const lent: Approval = {
  id: 'p1', hash: 'h', agentId: 'a1', conversationId: 'c1', messageId: 'm1', connectorId: 'node-maria', connectorName: 'MacBook da Maria', tool: 'node_bash',
  args: { command: 'ls ~/proj' }, why: '', highRisk: false, state: 'pending', createdAt: 0, expiresAt: Date.now() + 60_000, computerOwner: 'maria'
}

describe('canDecide in the store', () => {
  it("on a lent computer: its person only, not the admins, the owner nor the agent's person", () => {
    expect(['ana', 'bia', 'maria', 'carl'].map((p) => canDecide(as(p), lent))).toEqual([false, false, true, false])
  })

  it("elsewhere, as before: the admins and the agent's person", () => {
    const a = { agentId: 'a1' }
    expect(['ana', 'bia', 'maria', 'carl'].map((p) => canDecide(as(p), a))).toEqual([true, true, false, true])
  })
})

describe('the approval card on a lent computer', () => {
  let root: Root
  const render = async (you: string): Promise<void> => {
    fake = { ...getState(), ready: true, people, you, agents: [lia], connectors: [] }
    await act(async () => root.render(<ApprovalCard approval={lent} />))
  }
  const text = (): string => document.getElementById('root')!.textContent ?? ''
  const buttons = (): string[] => [...document.querySelectorAll('button')].map((b) => b.textContent ?? '')
  beforeEach(() => (root = createRoot(document.getElementById('root')!)))
  afterEach(async () => act(async () => root.unmount()))

  it('gives its person the buttons, saying it goes to them', async () => {
    await render('maria')
    expect(text()).toContain('Esperando você')
    expect(text()).toContain('Vai pra você: roda no seu computador')
    expect(buttons().some((b) => /Recusar/.test(b))).toBe(true)
  })

  it('tells an admin whose computer it is, with no buttons', async () => {
    await render('bia')
    expect(text()).toContain('Roda no computador de Maria: só essa pessoa decide.')
    expect(text()).toContain('Vai pra Maria: roda no computador dela')
    expect(buttons().some((b) => /Recusar|Aprovar/.test(b))).toBe(false)
  })
})
