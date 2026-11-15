import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, expect, it } from 'vitest'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { Diff } = await import('../src/renderer/src/components/skills/SkillDiff')
let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined })

it('renders both large versions completely without creating per-line DOM nodes', async () => {
  const before = '\n<script>plain text</script>\n' + 'old\n'.repeat(25_000) + 'old end'
  const after = '\nnew\n'.repeat(25_000) + 'new end\n'
  root = createRoot(document.getElementById('root')!)
  await act(async () => root!.render(<Diff before={before} after={after} />))
  const versions = [...document.querySelectorAll('.diff-full pre')]
  expect(versions).toHaveLength(2)
  expect(versions.map(node => node.textContent)).toEqual([before, after])
  expect(versions.every(node => node.childNodes.length === 1)).toBe(true)
  expect(document.querySelectorAll('.diff__add, .diff__del, .diff__same, script')).toHaveLength(0)
  expect(document.querySelectorAll('section[aria-label]')).toHaveLength(2)
})

it('keeps the existing detailed presentation and replaces the fallback when selection changes', async () => {
  root = createRoot(document.getElementById('root')!)
  await act(async () => root!.render(<Diff before={'a\n'.repeat(6000)} after={'b\n'.repeat(6000)} />))
  expect(document.querySelector('.diff-full')).not.toBeNull()
  await act(async () => root!.render(<Diff before="old" after="new" />))
  expect(document.querySelector('.diff-full')).toBeNull()
  expect(document.querySelector('.diff__del')?.textContent).toBe('- old')
  expect(document.querySelector('.diff__add')?.textContent).toBe('+ new')
})
