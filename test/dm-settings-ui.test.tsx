// A DM's settings window: where its agent answers is up to whoever is in it, so the choice shows
// for a member too (it showed nothing since teams came in). A channel's stays its maker's and the admins'.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

let state: Record<string, unknown>
const lia = { id: 'lia', name: 'Lia' }
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
  agentById: (_s: unknown, id: string) => (id === 'lia' ? lia : undefined),
  // A member who didn't make the channel.
  canEditChannel: () => false,
  openDialog: vi.fn(),
  getState: () => state
}))
vi.mock('../src/renderer/src/components/Modal', () => ({ Modal: ({ title, children }: { title: string; children: ReactNode }) => <div data-title={title}>{children}</div> }))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, Icon: () => null }))
vi.mock('../src/renderer/src/components/WorkspaceManager', () => ({ WorkspaceManager: () => null }))
vi.mock('../src/renderer/src/components/LoginTerminal', () => ({ LoginHost: () => null }))
vi.mock('../src/renderer/src/components/Feedback', () => ({ FeedbackDialog: () => null }))
const { createRoot } = await import('react-dom/client')
const { Dialogs } = await import('../src/renderer/src/components/Dialogs')
let root: ReturnType<typeof createRoot>

const dm = { id: 'dm-lia', kind: 'dm', name: 'lia', members: ['lia'], threads: false }
const channel = { id: 'ch', kind: 'channel', name: 'geral', members: ['lia'], createdBy: 'ana' }
beforeEach(() => {
  state = { conversations: [dm, channel], dialog: null }
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => act(async () => root.unmount()))
const open = async (id: string): Promise<string> => {
  state.dialog = { kind: 'settings', id }
  await act(async () => root.render(<Dialogs />))
  return document.getElementById('root')!.innerHTML
}

it("shows a DM's choice of where its agent answers, to someone who isn't an admin", async () => {
  const html = await open('dm-lia')
  expect(html).toContain('Conversa com Lia')
  expect(html).toContain('Onde os agentes respondem')
  expect(html.match(/role="radio"/g)?.length).toBe(2)
})

it("still keeps a channel's choice to its maker and the admins", async () => {
  const html = await open('ch')
  expect(html).toContain('Configurações de #geral')
  expect(html).not.toContain('Onde os agentes respondem')
})
