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
type Change = { modelId?: string; effort?: string }
const save = vi.fn(async (_ids: string[], _change: Change) => 1)
vi.mock('../src/renderer/src/store', () => ({ useStore: (select: (s: unknown) => unknown) => select(fake), amAdmin: () => admin, setAgentModels: (ids: string[], change: Change) => save(ids, change) }))
// The real Select is a portal menu; here it is a plain one, so the tests can pick from it.
vi.mock('../src/renderer/src/components/Select', () => ({
  Select: ({ options = [], value, onChange, placeholder, 'aria-label': ariaLabel }: { options?: { value: string; label: string }[]; value?: string | null; onChange?: (v: string | null) => void; placeholder?: string; 'aria-label'?: string }) => (
    <select aria-label={ariaLabel} value={value ?? ''} onChange={(e) => onChange?.(e.target.value || null)}>
      <option value="">{placeholder ?? ''}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}))
vi.mock('../src/renderer/src/components/Harness', () => ({ ModelPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <select aria-label="Modelo" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Escolha</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option></select> }))
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

it('selects all displayed active agents and applies only after the button is pressed', async () => {
  await pick(document.querySelector('select')!, 'opus')
  expect(save).not.toHaveBeenCalled()
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], { modelId: 'opus' })
  expect(document.body.textContent).toContain('Modelo atualizado')
})
it('saves an individual agent without changing the others', async () => {
  const row = document.querySelector('[role="group"][aria-label="lia"]')!
  await pick(row.querySelector('select')!, 'opus')
  await click(row.querySelector('button')!)
  expect(save).toHaveBeenCalledWith(['lia'], { modelId: 'opus' })
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

it('changes the thinking for everyone selected without touching their models', async () => {
  // The thinking comes on its own, with no model picked.
  const thinking = document.querySelectorAll('select')[1]!
  await pick(thinking, 'low')
  expect(button('Aplicar aos selecionados').hasAttribute('disabled')).toBe(true)
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], { effort: 'low' })
  expect(document.body.textContent).toContain('Esforço atualizado em 1 agente')
})
it('says the model and the thinking when both were picked', async () => {
  await pick(document.querySelectorAll('select')[0]!, 'opus')
  await pick(document.querySelectorAll('select')[1]!, 'xhigh')
  const all = [...document.querySelectorAll('label')].find((l) => l.textContent?.includes('Selecionar todos'))!.querySelector('input')!
  await click(all)
  await click(button('Aplicar aos selecionados'))
  expect(save).toHaveBeenCalledWith(['lia', 'theo'], { modelId: 'opus', effort: 'xhigh' })
  expect(document.body.textContent).toContain('Modelo e esforço atualizados em 1 agente')
})
it('changes one agent’s thinking on its own, and shows the one it has', async () => {
  const row = document.querySelector('[role="group"][aria-label="lia"]')!
  expect(row.textContent).toContain('esforço Alto')
  const thinking = row.querySelectorAll('select')[1]!
  await pick(thinking, 'low')
  await click(row.querySelector('button')!)
  expect(save).toHaveBeenCalledWith(['lia'], { effort: 'low' })
})
it('keeps Save out of reach until something actually changes', async () => {
  const row = document.querySelector('[role="group"][aria-label="theo"]')!
  expect((row.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
})

it('puts the bulk change in one strip, and the thinking names itself', async () => {
  // The model picker and the thinking side by side in one strip, and no caption above either of
  // them: a caption on one would push the other down and break the line. (The real ModelPicker
  // draws two cells there, harness and model; the mock draws one.)
  const strip = document.querySelector('.agent-models__picks--bulk')!
  expect(strip.classList.contains('agent-models__pick')).toBe(false)
  expect(strip.querySelectorAll('.agent-models__label')).toHaveLength(0)
  expect(document.querySelectorAll('.agent-models__label')).toHaveLength(0)
  // The thinking has no label of its own, so its placeholder says what it is.
  const thinking = strip.lastElementChild as HTMLSelectElement
  expect(thinking.tagName).toBe('SELECT')
  expect(thinking.getAttribute('aria-label')).toBe('Esforço de raciocínio em lote')
  expect(thinking.querySelector('option')?.textContent).toBe('Esforço: não mudar')
  await pick(thinking, 'low')
  expect(thinking.value).toBe('low')
})
