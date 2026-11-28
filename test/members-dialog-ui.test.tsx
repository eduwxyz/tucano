// The members dialog is a membership list again: one button per agent, a check glyph when included,
// no mode select, a count of agents in the room, and a save of the checked ids alone.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

const save = vi.fn(async (_id: string, _ids: string[]) => {})
let state: Record<string, unknown>
const agents = [
  { id: 'lia', name: 'Lia', handle: 'lia', role: 'Research' },
  { id: 'theo', name: 'Theo', handle: 'theo', role: 'Build' },
  { id: 'nina', name: 'Nina', handle: 'nina', role: 'Docs' }
]
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: unknown) => unknown) => select(state),
  isTeam: () => true,
  agentById: () => undefined,
  canEditChannel: () => true,
  openDialog: vi.fn(),
  getState: () => state,
  setChannelMembers: (id: string, ids: string[]) => save(id, ids)
}))
vi.mock('../src/renderer/src/components/Modal', () => ({ Modal: ({ title, children }: { title: string; children: ReactNode }) => <div data-title={title}>{children}</div> }))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, Icon: ({ name }: { name: string }) => <span data-icon={name} /> }))
vi.mock('../src/renderer/src/components/WorkspaceManager', () => ({ WorkspaceManager: () => null }))
vi.mock('../src/renderer/src/components/LoginTerminal', () => ({ LoginHost: () => null }))
vi.mock('../src/renderer/src/components/Feedback', () => ({ FeedbackDialog: () => null }))
const { createRoot } = await import('react-dom/client')
const { Dialogs } = await import('../src/renderer/src/components/Dialogs')
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  save.mockClear()
  state = {
    agents,
    dialog: { kind: 'members', id: 'ch' },
    // Modes stay in the conversation for silent witnesses; the dialog never reads or writes them.
    conversations: [{ id: 'ch', kind: 'channel', name: 'geral', members: ['lia', 'theo'], modes: { lia: 'mention', theo: 'answer' } }]
  }
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => act(async () => root.unmount()))

const open = async (): Promise<string> => {
  await act(async () => root.render(<Dialogs />))
  return document.getElementById('root')!.innerHTML
}

it('shows one toggle per agent, checks only the two in the room and offers no mode select', async () => {
  const html = await open()
  const rows = [...document.querySelectorAll('button.member')]
  expect(rows).toHaveLength(3) // one button per agent
  expect(document.querySelectorAll('select')).toHaveLength(0) // no mode control anywhere in the dialog
  expect(document.querySelectorAll('[data-icon="check"]')).toHaveLength(2) // checked rows: 2 agents
  expect(html).toContain('2 agentes')
  expect(html).toContain('Quem está no canal lê a conversa e pode responder. Pra chamar alguém específico, use @.')
  expect(html).not.toContain('agentes respondem')
})

it('saves only the checked membership and keeps a silent member silent on round trip', async () => {
  await open()
  const rows = [...document.querySelectorAll('button.member')] as HTMLButtonElement[]
  await act(async () => rows[2]!.click()) // Nina, out of the room, goes in
  await act(async () => rows[1]!.click()) // Theo, in the room, goes out
  const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Salvar') as HTMLButtonElement
  await act(async () => saveButton.click())
  expect(save).toHaveBeenCalledWith('ch', ['lia', 'nina'])
  expect(save.mock.calls[0]).toHaveLength(2) // no modes argument from the restored dialog
})
