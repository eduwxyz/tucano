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
const save = vi.fn(async (_ids: string[], _model: string, _effort?: string) => 1)
vi.mock('../src/renderer/src/store', () => ({ useStore: (select: (s: unknown) => unknown) => select(fake), amAdmin: () => admin, setAgentModels: (ids: string[], model: string, effort?: string) => save(ids, model, effort) }))
vi.mock('../src/renderer/src/components/Harness', () => ({
  ModelPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <select aria-label="Modelo" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Escolha</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select>,
  // No level picked yet: the trigger says Keep, and with `keep` the list carries it as a pick of its own
  // that reports null (the real one has it as the placeholder and as an option).
  EffortSelect: ({ value, onChange, keep }: { value?: string | null; onChange: (e: string | null) => void; keep?: boolean }) => <select aria-label="Esforço" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}>{keep && <option value="">Manter</option>}<option value="low">Baixo</option><option value="medium">Médio</option><option value="high">Alto</option><option value="xhigh">Máximo</option></select>
}))
vi.mock('../src/renderer/src/components/ui', () => ({ AgentAvatar: () => null }))
const { createRoot } = await import('react-dom/client')
const { AgentModelsPanel } = await import('../src/renderer/src/components/AgentModelsPanel')
let root: ReturnType<typeof createRoot>
const bot = (id: string, archived = false) => ({ id, name: id, handle: id, modelId: 'sonnet', effort: 'high', archived }) as Agent
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
const field = (scope: ParentNode, label: string) => scope.querySelector(`select[aria-label="${label}"]`) as unknown as HTMLSelectElement
it('selects all displayed active agents and applies only after the button is pressed', async () => {
  await pick(document.querySelector('select')!, 'opus')
  expect(save).not.toHaveBeenCalled()
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  // The thinking level is only sent when one is picked: an untouched control keeps each agent's own.
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], 'opus', undefined)
  expect(document.body.textContent).toContain('Modelo atualizado')
})
it('sends the thinking level picked in the bulk row along with the model', async () => {
  await pick(document.querySelector('select')!, 'opus')
  await pick(field(document.querySelector('.agent-models__bulk')!, 'Esforço'), 'xhigh')
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], 'opus', 'xhigh')
})
it('offers Keep in the bulk level list, and a level picked can go back to it', async () => {
  const bulk = field(document.querySelector('.agent-models__bulk')!, 'Esforço')
  expect([...bulk.querySelectorAll('option')].map((o) => o.textContent)).toContain('Manter')
  await pick(document.querySelector('select')!, 'opus')
  await pick(bulk, 'xhigh')
  await pick(bulk, '')
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  // Back on Keep, only the model is left to apply: the agents keep their own levels.
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], 'opus', undefined)
})
it('applies a level alone to the selected agents when no model is picked', async () => {
  const apply = button('Aplicar aos selecionados')
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  expect(apply.disabled).toBe(true) // nothing picked yet
  await pick(field(document.querySelector('.agent-models__bulk')!, 'Esforço'), 'high')
  expect(apply.disabled).toBe(false)
  await click(apply)
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], '', 'high')
  expect(document.body.textContent).toContain('Esforço atualizado')
})
it('saves an individual agent without changing the others', async () => {
  const row = document.querySelector('[role="group"][aria-label="lia"]')!
  await pick(field(row, 'Modelo'), 'opus')
  await click(row.querySelector('button')!)
  expect(save).toHaveBeenCalledWith(['lia'], 'opus', undefined)
})
it('shows each agent its own level and saves a changed one on its own', async () => {
  const row = document.querySelector('[role="group"][aria-label="theo"]')!
  expect(field(row, 'Esforço').value).toBe('high')
  expect(row.querySelector('button')?.disabled).toBe(true)
  await pick(field(row, 'Esforço'), 'low')
  expect(row.querySelector('button')?.disabled).toBe(false)
  await click(row.querySelector('button')!)
  expect(save).toHaveBeenCalledWith(['theo'], 'sonnet', 'low')
})
it('shows failures and keeps the choice available to retry', async () => {
  save.mockRejectedValueOnce(new Error('Falha ao salvar'))
  const row = document.querySelector('[role="group"][aria-label="lia"]')!
  await pick(field(row, 'Modelo'), 'opus')
  await click(row.querySelector('button')!)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Falha ao salvar')
  expect(row.querySelector('button')?.disabled).toBe(false)
})
it('hides the controls from members', async () => {
  admin = false
  await act(async () => root.render(<AgentModelsPanel />))
  expect(document.querySelector('section')).toBeNull()
})
