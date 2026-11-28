// A server's page in the desktop app: its own workspace menu lists this computer's workspaces and the
// servers, and goes to them, so the app's bar over the page can go (src/main/servers.ts). It says so
// only once it draws them, and stops when the menu goes. The settings say whose they are.
import { readFileSync } from 'node:fs'
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { placeOf, type DesktopPlaces } from '../src/shared/servers'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false }) })

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { WorkspaceMenu } = await import('../src/renderer/src/components/Workspaces')
const { SettingsWhere } = await import('../src/renderer/src/components/Pages')

const places: DesktopPlaces = {
  workspaces: [
    { id: '01936b2e-0000-7000-8000-000000000001', name: 'Eduardo' },
    { id: '01936b2e-0000-7000-8000-000000000002', name: 'Clientes' }
  ],
  servers: [
    { id: 'srv-kobi', name: 'kobi.tucano.pro', open: true },
    { id: 'srv-casa', name: 'casa.example.com', open: false }
  ]
}
const desk = { list: vi.fn(async () => places), onChanged: vi.fn(() => () => {}), go: vi.fn(), own: vi.fn(), os: 'darwin' }

let root: Root
const settle = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 5)))
const click = async (el: Element): Promise<void> => {
  await act(async () => void el.dispatchEvent(new window.Event('click', { bubbles: true })))
  await settle()
}
const items = (): string[] => [...document.querySelectorAll('[role="menu"] .menu__item')].map((x) => x.textContent ?? '')
const item = (text: string): Element => [...document.querySelectorAll('[role="menu"] .menu__item')].find((x) => x.textContent?.startsWith(text))!
const labels = (): string[] => [...document.querySelectorAll('[role="menu"] .ws-menu__label')].map((x) => x.textContent ?? '')

beforeEach(() => {
  root = createRoot(document.getElementById('root')!)
  fake = { ...real.getState(), ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', settings: { ...real.getState().settings, workspaceName: 'Kobi' } } as State
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
  delete (window as { __TUCANO_WEB__?: boolean }).__TUCANO_WEB__
})

describe("a server's page in the desktop app", () => {
  const onServer = async (): Promise<void> => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: { places: desk } })
    await act(async () => root.render(<WorkspaceMenu />))
    await settle()
  }

  it('says under its name that it is on the server', async () => {
    await onServer()
    expect(document.querySelector('.workspace-picker__button')?.textContent).toContain('Kobi')
    expect(document.querySelector('.workspace__where')?.textContent).toContain('no servidor')
  })

  it("lists this computer's workspaces and the servers, the one on screen checked", async () => {
    await onServer()
    await click(document.querySelector('.workspace-picker__button')!)
    expect(labels().slice(0, 2)).toEqual(['Neste computador', 'Servidores'])
    expect(items().slice(0, 4)).toEqual(['EEduardo', 'CClientes', 'Kobi kobi.tucano.pro', 'casa.example.com'])
    expect(item('Kobi').getAttribute('aria-checked')).toBe('true')
    expect(item('casa').getAttribute('aria-checked')).toBe('false')
  })

  it('goes to a workspace of this computer, or another server; the one on screen goes nowhere', async () => {
    await onServer()
    const menu = document.querySelector('.workspace-picker__button')!
    await click(menu)
    await click(item('CClientes'))
    expect(desk.go).toHaveBeenLastCalledWith({ kind: 'workspace', id: '01936b2e-0000-7000-8000-000000000002' })
    await click(menu)
    await click(item('casa'))
    expect(desk.go).toHaveBeenLastCalledWith({ kind: 'server', id: 'srv-casa' })
    await click(menu)
    await click(item('Kobi'))
    expect(desk.go).toHaveBeenCalledTimes(2)
  })

  it('tells the app it draws the way back once it has the places, and stops when the menu goes', async () => {
    await onServer()
    expect(desk.own).toHaveBeenCalledWith(true)
    await act(async () => root.render(<div />))
    expect(desk.own).toHaveBeenLastCalledWith(false)
  })

  it("keeps the app's bar when the app gives no places (it couldn't answer)", async () => {
    desk.list.mockResolvedValueOnce(null as unknown as DesktopPlaces)
    await onServer()
    expect(desk.own).not.toHaveBeenCalled()
  })

  it('keeps a server-page place initial', async () => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: { places: desk } })
    await act(async () => root.render(<WorkspaceMenu />))
    await settle()
    await click(document.querySelector('.workspace-picker__button')!)
    const tile = document.querySelector('.workspace-picker__menu .menu__item .ws-menu__logo:not(.is-server)')!
    expect(tile.querySelector('img')).toBeNull()
    expect(tile.textContent).toBe('E')
  })

  it('keeps the initial in the header, even when a local workspace has a picture', async () => {
    const list = { selected: '01936b2e-0000-7000-8000-000000000001', workspaces: [
      { id: '01936b2e-0000-7000-8000-000000000001', name: 'Eduardo', isDefault: true, paused: false, unread: 0, approvals: 0, status: 'ready' as const, picture: 'data:image/png;base64,iVBORw0KGgo=' }
    ] }
    Object.assign(window, { __TUCANO_WEB__: true, tucano: { places: desk, workspaces: { list: async () => list, subscribe: () => () => {} } } })
    await act(async () => root.render(<WorkspaceMenu />))
    await settle()
    const logo = document.querySelector('.workspace-picker__button .workspace__logo')!
    expect(logo.querySelector('img')).toBeNull()
    expect(logo.textContent).toBe('K')
  })

  it('in a browser: on the server, with no places to list', async () => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: {} })
    await act(async () => root.render(<WorkspaceMenu />))
    await click(document.querySelector('.workspace-picker__button')!)
    expect(document.querySelector('.workspace__where')?.textContent).toContain('no servidor')
    expect(labels()).not.toContain('Neste computador')
  })
})

describe("the desktop app's own menu", () => {
  const withHeader = async (picture?: string): Promise<Element> => {
    const list = { selected: 'w1', workspaces: [{ id: 'w1', name: 'Eduardo', isDefault: true, paused: false, unread: 0, approvals: 0, status: 'ready' as const, picture }] }
    fake = { ...fake, settings: { ...fake.settings, workspaceName: 'Eduardo' } }
    const servers = { list: vi.fn(async () => [{ id: 's1', name: 'kobi.tucano.pro', origin: 'https://kobi.tucano.pro', open: false, node: false }]), onChanged: () => () => {}, open: vi.fn() }
    Object.assign(window, { tucano: { workspaces: { list: async () => list, subscribe: () => () => {} }, servers } })
    await act(async () => root.render(<WorkspaceMenu />))
    await settle()
    return document.querySelector('.workspace-picker__button .workspace__logo')!
  }
  const row = (id: string, name: string, picture = ''): Record<string, unknown> => ({ id, name, picture, isDefault: id === 'w1', paused: false, unread: 0, approvals: 0, status: 'ready' })
  const mountList = async (list: unknown): Promise<void> => {
    Object.assign(window, { tucano: { workspaces: { list: async () => list, subscribe: () => () => {} } } })
    await act(async () => root.render(<WorkspaceMenu />))
    await settle()
  }
  const tileOf = (name: string): Element => [...document.querySelectorAll('.workspace-picker__menu [role="menuitemradio"]')].find((b) => b.textContent?.includes(name))!.querySelector('.ws-menu__logo')!

  it('wears the selected workspace picture before its name, and the initial when there is none', async () => {
    const picture = 'data:image/png;base64,iVBORw0KGgo='
    const logo = await withHeader(picture)
    expect(logo.querySelector('img')?.getAttribute('src')).toBe(picture)
    expect(logo.textContent).toBe('')
    const button = logo.parentElement!
    const name = button.querySelector('.workspace__name')!
    expect([...button.children].indexOf(logo)).toBeLessThan([...button.children].indexOf(name))

    await act(async () => root.render(<div />))
    const plain = await withHeader()
    expect(plain.querySelector('img')).toBeNull()
    expect(plain.textContent).toBe('E')
  })

  it('returns the header to the initial when its picture fails, then tries again after the picture changes', async () => {
    const bad = 'https://example.com/broken.png'
    const good = 'data:image/png;base64,iVBORw0KGgo='
    const img = (await withHeader(bad)).querySelector('img')!
    expect(img.getAttribute('src')).toBe(bad)
    expect(document.querySelector('.workspace__logo')!.getAttribute('aria-hidden')).toBeNull()
    await act(async () => { img.dispatchEvent(new window.Event('error')) })
    const failed = document.querySelector('.workspace__logo')!
    expect(failed.querySelector('img')).toBeNull()
    expect(failed.textContent).toBe('E')
    const retried = await withHeader(good)
    expect(retried.querySelector('img')?.getAttribute('src')).toBe(good)
    expect(retried.textContent).toBe('')
  })

  it('names its workspaces "on this computer" once there are servers', async () => {
    const list = { selected: 'w1', workspaces: [{ id: 'w1', name: 'Eduardo', isDefault: true, paused: false, unread: 0, approvals: 0, status: 'ready' }] }
    const servers = { list: vi.fn(async () => [{ id: 's1', name: 'kobi.tucano.pro', origin: 'https://kobi.tucano.pro', open: false, node: false }]), onChanged: () => () => {}, open: vi.fn() }
    Object.assign(window, { tucano: { workspaces: { list: async () => list, subscribe: () => () => {} }, servers } })
    await act(async () => root.render(<WorkspaceMenu />))
    await settle()
    expect(document.querySelector('.workspace__where')).toBeNull()
    await click(document.querySelector('.workspace-picker__button')!)
    expect(labels().slice(0, 2)).toEqual(['Neste computador', 'Servidores'])
  })

  it('draws every local workspace picture inside its own dropdown tile', async () => {
    const first = 'data:image/png;base64,AAAA'
    const second = 'data:image/png;base64,BBBB'
    await mountList({ selected: 'w1', workspaces: [row('w1', 'Alpha', first), row('w2', 'Beta', second)] })
    await click(document.querySelector('.workspace-picker__button')!)
    const checked = document.querySelector('.workspace-picker__menu [role="menuitemradio"][aria-checked="true"] .ws-menu__logo')!
    expect(checked.querySelector('img')?.getAttribute('src')).toBe(first)
    expect(checked.textContent).toBe('')
    expect(tileOf('Beta').querySelector('img')?.getAttribute('src')).toBe(second)
    const css = readFileSync('src/renderer/src/styles.css', 'utf8')
    expect(css).toContain('.ws-menu__logo img { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: contain; }')
  })

  it('keeps a local row without a picture as its initial after the dropdown opens', async () => {
    await mountList({ selected: 'w1', workspaces: [row('w1', 'Alpha')] })
    await click(document.querySelector('.workspace-picker__button')!)
    expect(tileOf('Alpha').querySelector('img')).toBeNull()
    expect(tileOf('Alpha').textContent).toBe('A')
  })

  it('returns a row to its initial when an https image fails, then tries again after the picture changes', async () => {
    const bad = 'https://example.com/broken.png'
    const good = 'data:image/png;base64,AAAA'
    await mountList({ selected: 'w1', workspaces: [row('w1', 'Alpha', bad)] })
    await click(document.querySelector('.workspace-picker__button')!)
    const img = tileOf('Alpha').querySelector('img')!
    expect(img.getAttribute('src')).toBe(bad)
    await act(async () => { img.dispatchEvent(new window.Event('error')) })
    expect(tileOf('Alpha').querySelector('img')).toBeNull()
    expect(tileOf('Alpha').textContent).toBe('A')
    await mountList({ selected: 'w1', workspaces: [row('w1', 'Alpha', good)] })
    expect(tileOf('Alpha').querySelector('img')?.getAttribute('src')).toBe(good)
    expect(tileOf('Alpha').textContent).toBe('')
  })
})

describe("a server's settings", () => {
  it('say whose they are, and in the desktop app open the computer’s own', async () => {
    const openLending = vi.fn()
    Object.assign(window, { tucano: { openLending } })
    Object.assign(globalThis, { location: { host: 'kobi.tucano.pro' } })
    await act(async () => root.render(<SettingsWhere />))
    const note = document.querySelector('.settings-where')!
    expect(note.textContent).toContain('Estes ajustes são do servidor kobi.tucano.pro')
    expect(note.textContent).toContain('emprestá-lo aos agentes')
    await click(note.querySelector('button')!)
    expect(openLending).toHaveBeenCalled()
  })

  it('in a browser, with nothing to open', async () => {
    Object.assign(window, { tucano: {} })
    await act(async () => root.render(<SettingsWhere />))
    expect(document.querySelector('.settings-where button')).toBeNull()
  })
})

describe('where a server page may send the app', () => {
  it('only a workspace or a server, by an id of the shape the app makes', () => {
    expect(placeOf({ kind: 'workspace', id: '01936b2e-0000-7000-8000-000000000001' })).toEqual({ kind: 'workspace', id: '01936b2e-0000-7000-8000-000000000001' })
    expect(placeOf({ kind: 'server', id: 'srv-kobi', extra: 1 })).toEqual({ kind: 'server', id: 'srv-kobi' })
    for (const bad of [null, 'workspace', { kind: 'file', id: 'x' }, { kind: 'server' }, { kind: 'server', id: '../etc' }, { kind: 'server', id: 'a'.repeat(65) }, { kind: 'workspace', id: 3 }])
      expect(placeOf(bad), JSON.stringify(bad)).toBeNull()
  })
})
