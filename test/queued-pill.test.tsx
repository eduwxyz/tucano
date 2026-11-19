// A queued prompt keeps a pill under it that says why it hasn't started: the label names the queue,
// and the line below says what it waits for. The pill belongs to the prompt, not to a reply.
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

const { createRoot } = await import('react-dom/client')
const { QueuedNote } = await import('../src/renderer/src/components/Conversation')
const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')

let root: Root
beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => act(() => root.unmount()))

it('says the prompt is queued and why, on two lines', async () => {
  await act(async () => root.render(<QueuedNote />))
  const pill = document.querySelector('.msg__queued')!
  expect(pill.querySelector('.msg__queued-label')?.textContent).toBe('Queued')
  expect(pill.querySelector('.msg__queued-sub')?.textContent).toBe('Waiting for the reply above to finish')
  expect(pill.getAttribute('title')).toBe('Goes when the reply above ends')
  expect(css).toMatch(/\.msg__queued-sub\s*\{[^}]*display:\s*block/)
})
