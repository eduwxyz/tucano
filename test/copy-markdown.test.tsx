// A finished session's last word, as it was written: the glyph in its footer puts the reply's own
// Markdown on the clipboard, not what the screen drew from it.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'

setLang('en')

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(window, { innerWidth: 1280, innerHeight: 800 })

const written: string[] = []
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (t: string) => { written.push(t); return Promise.resolve() } }
})

const { createRoot } = await import('react-dom/client')
const { CopyMarkdown } = await import('../src/renderer/src/components/Conversation')
const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
const source = readFileSync(new URL('../src/renderer/src/components/Conversation.tsx', import.meta.url), 'utf8')

let root: Root
beforeEach(() => {
  written.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

it('copies the answer’s own Markdown, and says so on the glyph for a moment', async () => {
  const md = '## Hoje\n\n- um item\n- outro, com **negrito**\n\n```ts\nconst a = 1\n```'
  await act(async () => root.render(<CopyMarkdown text={md} />))
  const button = document.querySelector('.msg__copy') as HTMLElement
  expect(button).toBeTruthy()
  expect(button.getAttribute('title')).toBe('Copy as Markdown')
  expect(button.getAttribute('aria-label')).toBe('Copy as Markdown')
  expect(button.querySelector('svg')).toBeTruthy()
  expect(button.textContent).toBe('') // a glyph, no label beside it
  await act(async () => button.click())
  expect(written).toEqual([md]) // the source, unmangled by the page
  expect(document.querySelector('.msg__copy')!.className).toContain('is-copied')
})

it('belongs to the footer of a finished reply, and to nothing else', async () => {
  // In the footer row, ahead of the numbers that footer already carries.
  const footer = source.indexOf('<div className="msg__meta">')
  const copy = source.indexOf('<CopyMarkdown text={message.text} />')
  const receipt = source.indexOf('<ReceiptLine receipt={message.run.receipt} />')
  expect(footer).toBeGreaterThan(0)
  expect(copy).toBeGreaterThan(footer) // inside the footer…
  expect(copy).toBeLessThan(receipt) // …at its head
  expect(source.match(/<CopyMarkdown text=/g)!.length).toBe(1) // once, on the reply row
  // Only an agent's answer, only once it is done, only when it has words.
  expect(source).toMatch(/message\.author\.kind === 'agent' && message\.run\?\.status === 'done' && message\.text\.trim\(\) && <CopyMarkdown/)
  // Borderless and dim, like the answer glyph beside it; it only lights up under the pointer.
  expect(css).toMatch(/\.msg__copy\s*\{[^}]*color:\s*var\(--text-3\)/)
  expect(css).toMatch(/\.msg__copy\s*\{[^}]*border:\s*0/)
  expect(css).toMatch(/\.msg__copy:hover,[\s\S]{0,80}\.msg__copy\.is-copied\s*\{[^}]*color:\s*var\(--text\)/)
  // It rides the footer's own height instead of standing a button tall inside it.
  expect(css).toMatch(/\.msg__meta \.msg__copy\s*\{[^}]*min-height:\s*0/)
})
