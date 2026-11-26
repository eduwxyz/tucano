// Manage workspaces: the thumbnail on each row, its edit affordance, and the picture window's four
// ways in (paste, clipboard button, file, address) plus clearing. The main process is a stand-in
// that applies the same validation, so a rejected address is a visible error, not a stored picture.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import { validateWorkspacePicture } from '../src/shared/workspace-picture'
import type { WorkspaceList } from '../src/shared/workspaces'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false }) })
Object.assign(document, { oninput: null })

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>'
const svgFile = () => ({ name: 'mark.svg', type: 'image/svg+xml', size: SVG.length, text: async () => SVG })
const setPicture = vi.fn(async (id: string, value: string) => {
  validateWorkspacePicture(value)
  const found = list?.workspaces.find((w) => w.id === id)
  if (found) found.picture = value || undefined
})
const paste = vi.fn(async () => ({ mime: 'image/svg+xml', data: Buffer.from(SVG).toString('base64') }))
Object.assign(window, { tucano: { workspaces: { list: async () => list, subscribe: () => () => {}, setPicture }, image: { paste } } })

let list: WorkspaceList
vi.mock('../src/renderer/src/components/Workspaces', () => ({ useWorkspaceList: () => ({ list, error: '' }) }))
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: never) => T): T => select({ settings: { onboarding: { workspaceManagerSeen: true } } } as never), updateSettings: vi.fn(), toast: vi.fn() }
})

const { createRoot } = await import('react-dom/client')
const store = await import('../src/renderer/src/store')
const { WorkspaceManager } = await import('../src/renderer/src/components/WorkspaceManager')
const { WorkspaceThumbnail } = await import('../src/renderer/src/components/WorkspacePicture')

let root: Root
beforeEach(() => {
  setLang('en')
  list = { selected: '01900000-0000-7000-8000-000000000001', workspaces: [
    { id: '01900000-0000-7000-8000-000000000001', name: 'Work', isDefault: true, paused: false, unread: 0, approvals: 0, status: 'ready' },
    { id: '01900000-0000-7000-8000-000000000002', name: 'Home', isDefault: false, paused: false, unread: 0, approvals: 0, status: 'ready' }
  ] }
  setPicture.mockClear()
  paste.mockClear()
  vi.mocked(store.toast).mockClear()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => { await act(async () => root.unmount()); vi.clearAllMocks() })

const tick = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 10)))
const fire = async (el: Element | null | undefined, type: string, props: object = {}): Promise<void> => {
  if (!el) throw new Error(`no element for ${type}`)
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, props)
  await act(async () => void el.dispatchEvent(event))
  await tick()
}
const byText = (text: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === text && !x.disabled)
  if (!b) throw new Error(`no button "${text}" in ${[...document.querySelectorAll('button')].map((x) => x.textContent).join(' | ')}`)
  return b as HTMLButtonElement
}
const input = (selector: string): HTMLInputElement => document.querySelector(selector) as HTMLInputElement
// The manager sorts by name, so Work is not necessarily the first row.
const thumbnail = (name: string): Element | null => document.querySelector(`button[aria-label="Change picture for ${name}"]`)
const typeInto = async (el: HTMLInputElement, value: string): Promise<void> => {
  let proto: object | null = Object.getPrototypeOf(el)
  let setter: ((v: string) => void) | undefined
  while (proto && !setter) (setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set), (proto = Object.getPrototypeOf(proto))
  await act(async () => { setter!.call(el, value); el.dispatchEvent(new window.Event('input', { bubbles: true })) })
  await tick()
}
const openModal = async (): Promise<void> => {
  await act(async () => root.render(<WorkspaceManager onClose={() => {}} />))
  await tick()
  await fire(thumbnail('Work'), 'click')
  expect(document.querySelectorAll('.modal__card.workspace-picture')).toHaveLength(1)
}

describe('a workspace picture', () => {
  it('draws a thumbnail with an accessible edit glyph, or a neutral one before a picture is set', () => {
    const thumb = (picture?: string): string => renderToStaticMarkup(<WorkspaceThumbnail workspace={{ id: 'x', name: 'Work', picture }} onEdit={() => {}} />)
    expect(thumb(PNG)).toContain(`src="${PNG}"`)
    const empty = thumb()
    expect(empty).toContain('Change picture for Work')
    expect(empty).toContain('workspace-manager__pic-edit')
    expect(empty).not.toContain('<img')
  })

  it('opens the picture window from the row and shows the empty placeholder', async () => {
    await openModal()
    const placeholder = document.querySelector('.workspace-picture__placeholder')!
    expect(placeholder.textContent).toContain('No picture yet')
    expect(document.querySelectorAll('.workspace-picture__url')).toHaveLength(1)
    expect(document.querySelector('.workspace-picture__placeholder img')).toBeNull()
  })

  it('accepts a paste, a clipboard button, a picked file and an https address', async () => {
    await openModal()
    await fire(document.querySelector('.workspace-picture__body'), 'paste', { clipboardData: { items: [{ type: 'image/svg+xml', getAsFile: svgFile }] } })
    expect(setPicture).toHaveBeenCalledWith('01900000-0000-7000-8000-000000000001', expect.stringMatching(/^data:image\/svg\+xml;base64,/))
    expect(document.querySelector('.workspace-picture__placeholder img')).not.toBeNull()

    setPicture.mockClear()
    await fire(byText('Paste image'), 'click')
    expect(paste).toHaveBeenCalled()
    expect(setPicture).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^data:image\/svg\+xml;base64,/))

    setPicture.mockClear()
    const file = input('.workspace-picture__file')
    Object.defineProperty(file, 'files', { value: { 0: svgFile(), length: 1, item: () => svgFile() }, configurable: true })
    await fire(file, 'change')
    expect(setPicture).toHaveBeenCalledWith(expect.any(String), expect.stringMatching(/^data:image\/svg\+xml;base64,/))

    setPicture.mockClear()
    await typeInto(input('.workspace-picture__url'), 'https://example.com/mark.png')
    await fire(byText('Add'), 'click')
    expect(setPicture).toHaveBeenCalledWith(expect.any(String), 'https://example.com/mark.png')
  })

  it('clears back to the default and shows a rejected address instead of storing it', async () => {
    list.workspaces[0]!.picture = PNG
    await openModal()
    expect(document.querySelector('.workspace-picture__placeholder img')?.getAttribute('src')).toBe(PNG)
    await fire(byText('Use the default'), 'click')
    expect(setPicture).toHaveBeenCalledWith(expect.any(String), '')
    expect(document.querySelector('.workspace-picture__placeholder img')).toBeNull()

    await typeInto(input('.workspace-picture__url'), 'http://127.0.0.1/mark.png')
    await fire(byText('Add'), 'click')
    expect(setPicture).toHaveBeenCalledWith(expect.any(String), 'http://127.0.0.1/mark.png')
    expect(store.toast).toHaveBeenCalledWith(expect.stringMatching(/https/))
    expect(document.querySelector('.workspace-picture__placeholder img')).toBeNull()

    // A rejection from the main process carries Electron's IPC wrapper; the toast shows the reason.
    setPicture.mockRejectedValueOnce(new Error("Error invoking remote method 'workspaces:setPicture': Error: That is not an image (PNG, JPEG, WebP, GIF or SVG)."))
    await typeInto(input('.workspace-picture__url'), 'https://example.com/ok.png')
    await fire(byText('Add'), 'click')
    expect(store.toast).toHaveBeenLastCalledWith('That is not an image (PNG, JPEG, WebP, GIF or SVG).')
  })

  it('does not change the other workspace in the list', async () => {
    await openModal()
    await typeInto(input('.workspace-picture__url'), 'https://example.com/mark.png')
    await fire(byText('Add'), 'click')
    expect(setPicture).toHaveBeenCalledTimes(1)
    expect(setPicture.mock.calls[0]![0]).toBe('01900000-0000-7000-8000-000000000001')
    expect(list.workspaces[0]!.picture).toBe('https://example.com/mark.png')
    expect(list.workspaces[1]!.picture).toBeUndefined()
  })
})
