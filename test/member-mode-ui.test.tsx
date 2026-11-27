// The members dialog: one answer/mention select per agent, the count of agents who answer normally,
// and the modes sent back with the membership on Save.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

const save = vi.fn(async (_id: string, _ids: string[], _modes: Record<string, string>) => {})
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
  setChannelMembers: (id: string, ids: string[], modes: Record<string, string>) => save(id, ids, modes)
}))
vi.mock('../src/renderer/src/components/Modal', () => ({ Modal: ({ title, children }: { title: string; children: ReactNode }) => <div data-title={title}>{children}</div> }))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null, Icon: () => null }))
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
    conversations: [{ id: 'ch', kind: 'channel', name: 'geral', members: ['lia', 'theo'], modes: { lia: 'mention', theo: 'answer' } }]
  }
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => act(async () => root.unmount()))

const open = async (): Promise<string> => {
  await act(async () => root.render(<Dialogs />))
  return document.getElementById('root')!.innerHTML
}

it('shows one mode select per agent and counts those who answer normally', async () => {
  const html = await open()
  const selects = [...document.querySelectorAll('select')]
  expect(selects).toHaveLength(3) // one per agent, including one not in the room
  expect(selects.filter((s) => (s as HTMLSelectElement).value === 'mention')).toHaveLength(1)
  expect(html).toContain('1 agente responde')
  expect(html).not.toContain('member__check') // the per-agent checkbox is gone
})

it('saves one mode per agent and keeps a removed agent out of the mode list', async () => {
  await open()
  const select = document.querySelectorAll('select')[0] as HTMLSelectElement
  await act(async () => {
    const options = select.querySelectorAll('option')
    ;(options[0] as unknown as { selected: boolean }).selected = true
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  const saveButton = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Salvar') as HTMLButtonElement
  await act(async () => saveButton.click())
  expect(save).toHaveBeenCalledWith('ch', ['lia', 'theo'], { lia: 'answer', theo: 'answer' })
})
