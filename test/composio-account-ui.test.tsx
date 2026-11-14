// A batch that runs the same action as two accounts shows which account each item uses, and the
// agent's saved rules show an account name exactly as it was written.
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
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), patchAgent: vi.fn(), ensureTuca: vi.fn(() => new Promise(() => {})) }
})
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ApprovalCard } = await import('../src/renderer/src/components/Conversation')
const { AgentPage } = await import('../src/renderer/src/components/Pages')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia = (p: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...p })
const item = (tool_slug: string, account?: unknown): Record<string, unknown> => ({ tool_slug, arguments: {}, ...(account === undefined ? {} : { account }) })
const approval = (tools: unknown[], highRisk = false): Approval => ({
  id: 'p1', hash: 'h', agentId: 'a1', conversationId: 'c1', messageId: 'm1', connectorId: 'cmp', connectorName: 'Composio', tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
  args: { tools }, why: '', highRisk, state: 'pending', createdAt: 0, expiresAt: 1
})

let root: Root
const render = async (node: React.ReactNode, agent = lia()): Promise<void> => {
  fake = { ...getState(), ready: true, people: [ana], you: 'ana', agents: [agent], connectors: [], tabs: { agent: 'ferramentas' }, isolatedComputers: true }
  await act(async () => root.render(node))
}
const rows = (): string[] => [...document.querySelectorAll('.approval__args code')].map((c) => c.textContent ?? '')

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe('the approval card of a batch with accounts', () => {
  it('tells apart the same action for two accounts, a read included, even on a high-risk card', async () => {
    await render(<ApprovalCard approval={approval([item('GMAIL_SEND_EMAIL', 'work'), item('GMAIL_SEND_EMAIL', 'personal'), item('GMAIL_FETCH_EMAILS', 'work'), item('GMAIL_FETCH_EMAILS')], true)} />)
    expect(rows()).toEqual(['GMAIL_SEND_EMAIL (conta work)', 'GMAIL_SEND_EMAIL (conta personal)', 'GMAIL_FETCH_EMAILS (conta work)', 'GMAIL_FETCH_EMAILS'])
  })

  it('offers "always" naming the account', async () => {
    await render(<ApprovalCard approval={approval([item('GMAIL_SEND_EMAIL', 'work')])} />)
    expect([...document.querySelectorAll('button')].some((b) => b.textContent === 'Aprovar e sempre permitir GMAIL_SEND_EMAIL (conta work)')).toBe(true)
  })
})

describe("an agent's saved rules", () => {
  it('show the account as written, and only the tool in words', async () => {
    await render(<AgentPage id="a1" />, lia({ autoApprove: ['cmp:GMAIL_SEND_EMAIL@Work:Admin@example.com', 'cmp:GMAIL_SEND_EMAIL@First.Last@example.com', 'cmp:GMAIL_REPLY_TO_THREAD'] }))
    const chips = [...document.querySelectorAll('.always__rule')].map((c) => c.textContent ?? '')
    expect(chips[0]).toContain('(conta Work:Admin@example.com)')
    expect(chips[1]).toContain('(conta First.Last@example.com)')
    expect(chips[2]).not.toContain('conta')
  })
})
