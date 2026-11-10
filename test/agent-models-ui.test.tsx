import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(document, { oninput: null })
let fake: Pick<State, 'agents'>
let admin = true
const save = vi.fn(async (_ids: string[], _model: string) => 1)
vi.mock('../src/renderer/src/store', () => ({ useStore: (select: (s: unknown) => unknown) => select(fake), amAdmin: () => admin, setAgentModels: (ids: string[], model: string) => save(ids, model) }))
vi.mock('../src/renderer/src/components/Harness', () => ({ ModelPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <select aria-label="Modelo" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Escolha</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select> }))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null }))
const { createRoot } = await import('react-dom/client')
const { AgentModelsPanel } = await import('../src/renderer/src/components/AgentModelsPanel')
let root: ReturnType<typeof createRoot>
const bot = (id: string, archived = false) => ({ id, name: id, handle: id, modelId: 'sonnet', archived }) as Agent
beforeEach(async () => {
  fake = { agents: [bot('lia'), bot('theo'), bot('old', true)] }
  admin = true
  save.mockReset().mockResolvedValue(1)
  root = createRoot(document.getElementById('root')!)
  await act(async () => root.render(<AgentModelsPanel />))
})
afterEach(async () => { await act(async () => root.unmount()) })
const click = async (el: Element) => act(async () => { el.dispatchEvent(new window.Event('click', { bubbles: true })) })
const pick = async (el: Element, value: string) => act(async () => { Object.defineProperty(el, 'value', { configurable: true, value }); el.dispatchEvent(new window.Event('change', { bubbles: true })) })
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

it('selects all displayed active agents and applies only after the button is pressed', async () => {
  await pick(document.querySelector('select')!, 'opus')
  expect(save).not.toHaveBeenCalled()
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], 'opus')
  expect(document.body.textContent).toContain('Modelo atualizado')
})
it('saves an individual agent without changing the others', async () => {
  const row = document.querySelector('[role="group"][aria-label="lia"]')!
  await pick(row.querySelector('select')!, 'opus')
  await click(row.querySelector('button')!)
  expect(save).toHaveBeenCalledWith(['lia'], 'opus')
})
it('shows failures and keeps the choice available to retry', async () => {
  save.mockRejectedValueOnce(new Error('Falha ao salvar'))
  const row = document.querySelector('[role="group"][aria-label="lia"]')!
  await pick(row.querySelector('select')!, 'opus')
  await click(row.querySelector('button')!)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Falha ao salvar')
  expect(row.querySelector('button')?.disabled).toBe(false)
})
it('hides the controls from members', async () => {
  admin = false
  await act(async () => root.render(<AgentModelsPanel />))
  expect(document.querySelector('section')).toBeNull()
})
