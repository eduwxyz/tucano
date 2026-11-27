// The side panel's copy glyph for a text file: its whole contents go to the clipboard, and the glyph
// says "Copiado" / "Copied" for a moment instead of copying in silence. A file it can't read says so.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { innerWidth: 1280, innerHeight: 800, tucano: {} })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

const written: string[] = []
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (t: string) => { written.push(t); return Promise.resolve() } }
})

const files: Record<string, string | null> = { a1: '# Resumo\n\n- um item', gone: null }
const asked: unknown[] = []
vi.mock('../src/renderer/src/rpc', async (original) => ({
  ...(await original<typeof import('../src/renderer/src/rpc')>()),
  call: vi.fn((method: string, args: { id: string }) => {
    asked.push([method, args])
    return Promise.resolve(files[args.id] ?? null)
  })
}))
const toast = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => ({ ...(await original<typeof import('../src/renderer/src/store')>()), toast: (...a: unknown[]) => toast(...a) }))

const { createRoot } = await import('react-dom/client')
const { CopyArtifact } = await import('../src/renderer/src/components/Panel')
const source = readFileSync(new URL('../src/renderer/src/components/Panel.tsx', import.meta.url), 'utf8')

let root: Root
beforeEach(() => {
  written.length = 0
  asked.length = 0
  toast.mockClear()
  document.getElementById('root')!.innerHTML = ''
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

const button = (): HTMLElement => document.querySelector('#root button') as HTMLElement

it('copies the file and says "Copiado" on the glyph', async () => {
  setLang('pt')
  await act(async () => root.render(<CopyArtifact id="a1" />))
  expect(button().getAttribute('title')).toBe('Copiar')
  expect(button().textContent).toBe('') // a glyph until it has copied
  await act(async () => button().click())
  expect(asked).toEqual([['artifactText', { id: 'a1' }]])
  expect(written).toEqual(['# Resumo\n\n- um item'])
  expect(button().textContent).toContain('Copiado')
  expect(button().getAttribute('aria-label')).toBe('Copiado')
  expect(button().className).toContain('is-copied')
  expect(toast).not.toHaveBeenCalled()
})

it('says "Copied" in English', async () => {
  setLang('en')
  await act(async () => root.render(<CopyArtifact id="a1" />))
  expect(button().getAttribute('title')).toBe('Copy')
  await act(async () => button().click())
  expect(button().textContent).toContain('Copied')
})

it('says it could not copy a file that is no longer there, and copies nothing', async () => {
  setLang('en')
  await act(async () => root.render(<CopyArtifact id="gone" />))
  await act(async () => button().click())
  expect(written).toEqual([])
  expect(button().className).not.toContain('is-copied')
  expect(toast).toHaveBeenCalledWith('Could not copy the file.')
})

it('is offered only for text files: markdown, text and csv', () => {
  expect(source).toContain("{artifact && (artifact.kind === 'markdown' || artifact.kind === 'text' || artifact.kind === 'csv') && <CopyArtifact id={artifact.id} />}")
})
