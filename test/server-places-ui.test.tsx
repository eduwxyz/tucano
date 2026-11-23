// A server's page in the desktop app: its own workspace menu lists this computer's workspaces and the
// servers, and goes to them, so the app's bar over the page can go (src/main/servers.ts). It says so
// only once it draws them, and stops when the menu goes. The settings say whose they are.
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

  it('in a browser: on the server, with no places to list', async () => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: {} })
    await act(async () => root.render(<WorkspaceMenu />))
    await click(document.querySelector('.workspace-picker__button')!)
    expect(document.querySelector('.workspace__where')?.textContent).toContain('no servidor')
    expect(labels()).not.toContain('Neste computador')
  })
})

describe("the desktop app's own menu", () => {
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
