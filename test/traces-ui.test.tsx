// Settings › Connections › Traces: what an admin sees and does there.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { TracesTest, TracesView } from '../src/shared/types'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { tucano: {} })

const loadTraces = vi.fn<() => Promise<TracesView>>()
const saveTraces = vi.fn<(p: { on: boolean; endpoint: string; text?: boolean; headers?: string | null }) => Promise<TracesView>>()
const testTraces = vi.fn<(p: { endpoint: string; headers?: string }) => Promise<TracesTest>>()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, loadTraces: () => loadTraces(), saveTraces: (p: never) => saveTraces(p), testTraces: (p: never) => testTraces(p) }
})

const { createRoot } = await import('react-dom/client')
const { TracesPane } = await import('../src/renderer/src/components/Traces')

const off: TracesView = { on: false, endpoint: '', text: false, headers: false }
let root: Root
const text = (): string => document.getElementById('root')!.textContent ?? ''
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name)
  if (!found) throw new Error(`no button "${name}" in: ${text()}`)
  return found as unknown as HTMLButtonElement
}
const input = (label: string): HTMLInputElement => {
  const found = [...document.querySelectorAll('label')].find((l) => (l.textContent ?? '').startsWith(label))?.querySelector('input, textarea')
  if (!found) throw new Error(`no field "${label}" in: ${text()}`)
  return found as unknown as HTMLInputElement
}
const click = async (el: HTMLElement): Promise<void> => {
  await act(async () => void el.dispatchEvent(new window.Event('click', { bubbles: true })))
}
// Typing, as the field's handler gets it (linkedom's inputs don't feed React's change events).
const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  const props = Object.entries(el).find(([k]) => k.startsWith('__reactProps'))![1] as { onChange: (e: unknown) => void }
  await act(async () => props.onChange({ target: { value } }))
}
const render = async (): Promise<void> => {
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host as unknown as Element)
  await act(async () => root.render(<TracesPane />))
}

beforeEach(() => {
  setLang('en')
  document.getElementById('root')!.innerHTML = ''
  vi.clearAllMocks()
  loadTraces.mockResolvedValue(off)
  saveTraces.mockImplementation(async (p) => ({ on: p.on, endpoint: p.endpoint, text: !!p.text, headers: !!p.headers }))
})

describe('the Traces settings', () => {
  it('fills the address from an example, and nothing else', async () => {
    await render()

    await click(button('Langfuse'))

    expect(input('Address').value).toBe('https://cloud.langfuse.com/api/public/otel')
    expect(saveTraces).not.toHaveBeenCalled()
  })

  it('saves what the form holds, sending headers only when typed, and never shows them again', async () => {
    await render()
    await click(button('Send traces'))
    await type(input('Address'), 'https://otel.example.com')
    await type(input('Headers'), 'Authorization: Basic cGs6c2s=')

    await click(button('Save'))

    expect(saveTraces).toHaveBeenLastCalledWith({ on: true, endpoint: 'https://otel.example.com', text: false, headers: 'Authorization: Basic cGs6c2s=' })
    expect(input('Headers').value).toBe('')
    expect(input('Headers').getAttribute('placeholder')).toBe('Saved. Type to replace them.')
    await click(button('Save'))
    expect(saveTraces).toHaveBeenLastCalledWith({ on: true, endpoint: 'https://otel.example.com', text: false })
  })

  it('tests the address as typed and says what came back', async () => {
    await render()
    await type(input('Address'), 'https://otel.example.com')
    await type(input('Headers'), 'Authorization: Bearer x')

    testTraces.mockResolvedValueOnce({ ok: true })
    await click(button('Test connection'))
    expect(testTraces).toHaveBeenLastCalledWith({ endpoint: 'https://otel.example.com', headers: 'Authorization: Bearer x' })
    expect(text()).toContain('The backend took the test trace.')

    testTraces.mockResolvedValueOnce({ ok: false, status: 401 })
    await click(button('Test connection'))
    expect(text()).toContain('The backend refused it (HTTP 401): check the key in the headers.')

    testTraces.mockResolvedValueOnce({ ok: false })
    await click(button('Test connection'))
    expect(text()).toContain("Couldn't reach that address.")
    expect(saveTraces).not.toHaveBeenCalled()
  })

  it('shows what the server’s environment configures, with nothing to change', async () => {
    loadTraces.mockResolvedValue({ ...off, fromEnv: 'https://otel.company.com' })

    await render()

    expect(text()).toContain("Configured by the server's environment: https://otel.company.com")
    expect(document.querySelectorAll('input, textarea, button')).toHaveLength(0)
  })

  it('says the text stayed off when the address or headers changed', async () => {
    loadTraces.mockResolvedValue({ on: true, endpoint: 'https://a.example.com', text: true, headers: true })
    saveTraces.mockImplementation(async (p) => ({ on: p.on, endpoint: p.endpoint, text: false, headers: true }))
    await render()
    await type(input('Address'), 'https://b.example.com')

    await click(button('Save'))

    expect(text()).toContain('The text stayed off because the address or headers changed. Turn it on again to send the text there.')
    expect(button('Send the conversation text').getAttribute('aria-checked')).toBe('false')
  })

  it('reads in Portuguese', async () => {
    setLang('pt')

    await render()

    for (const shown of ['Enviar traces', 'Endereço', 'Cabeçalhos', 'Enviar o texto das conversas', 'Testar conexão', 'Nenhum texto das conversas']) expect(text()).toContain(shown)
  })

  it('clears what the last save or test said once the form changes', async () => {
    saveTraces.mockRejectedValueOnce(new Error('Use HTTPS for a backend on another machine.'))
    await render()
    await type(input('Address'), 'http://otel.example.com')
    await click(button('Save'))
    expect(text()).toContain('Use HTTPS for a backend on another machine.')

    await type(input('Address'), 'https://otel.example.com')

    expect(text()).not.toContain('Use HTTPS for a backend on another machine.')
  })
})
