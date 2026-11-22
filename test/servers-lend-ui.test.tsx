// Settings › Servers, lending this computer: on, what's left sits right under the switch (a folder, asked for at
// once when there's none, and the agents, picked on the server in one click).
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeInfo } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

let fake: State
let info: NodeInfo
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const call = vi.fn(async (method: string, p?: { path?: string }) => {
  if (method === 'addNodeFolder' && p?.path) info = { ...info, folders: [...info.folders, p.path] }
  return info
})
vi.mock('../src/renderer/src/rpc', () => ({ call: (m: string, p?: { path?: string }) => call(m, p) }))
vi.mock('../src/renderer/src/components/Dialogs', async (original) => ({ ...(await original<object>()), confirmDialog: vi.fn(async () => true) }))
const { getState } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ServersCard } = await import('../src/renderer/src/components/Servers')

let root: Root
const api = { list: vi.fn(), pair: vi.fn(), open: vi.fn(), local: vi.fn(), forget: vi.fn(), setNode: vi.fn(), openAgents: vi.fn(), onChanged: () => () => {} }
const render = async (o: { node: boolean; state?: 'connected' | 'connecting'; folders?: string[]; pick?: string | null }): Promise<string> => {
  info = { apps: [], folders: o.folders ?? [], links: o.state ? [{ serverId: 's1', origin: 'https://ana.example.com', state: o.state }] : [] }
  api.list.mockResolvedValue([{ id: 's1', name: 'ana.example.com', origin: 'https://ana.example.com', open: false, node: o.node }])
  Object.assign(window, { tucano: { servers: api, pickFolder: vi.fn(async () => o.pick ?? null) } })
  fake = { ...getState(), ready: true, defaultWorkspace: true, node: info }
  await act(async () => root.render(<ServersCard />))
  await act(async () => new Promise((r) => setTimeout(r, 5)))
  return document.querySelector('.server-lend')?.textContent ?? ''
}
const press = async (name: string): Promise<void> => {
  const b = [...document.querySelectorAll('.server-lend button')].find((x) => x.textContent === name || x.getAttribute('aria-label') === name)!
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await act(async () => new Promise((r) => setTimeout(r, 5)))
}

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe('lending this computer to a server', () => {
  it('turned on with no folder lent: asks for the first one right away', async () => {
    await render({ node: false, pick: '/Users/ana/dev/loja' })
    await press('Deixar ana.example.com usar este computador')
    expect(api.setNode).toHaveBeenCalledWith('s1', true)
    expect(call).toHaveBeenCalledWith('addNodeFolder', { path: '/Users/ana/dev/loja' })
  })

  it('on: the folders and the agents right under the switch, the agents one click away on the server', async () => {
    const t = await render({ node: true, state: 'connected', folders: ['/Users/ana/dev/loja'] })
    expect(t).toContain('Pastas: ~/dev/loja')
    expect(t).toContain('Escolha, no servidor, os agentes que usam este computador')
    await press('Escolher os agentes')
    expect(api.openAgents).toHaveBeenCalledWith('s1')
  })

  it('on with no folder: says so, with the button to lend one', async () => {
    const t = await render({ node: true, state: 'connected', pick: '/Users/ana/docs' })
    expect(t).toContain('Nenhuma pasta ainda')
    await press('Emprestar uma pasta')
    expect(call).toHaveBeenCalledWith('addNodeFolder', { path: '/Users/ana/docs' })
  })

  it('not connected yet: the agents wait for the line', async () => {
    await render({ node: true, state: 'connecting', folders: ['/Users/ana/dev/loja'] })
    const b = [...document.querySelectorAll('.server-lend button')].find((x) => x.textContent === 'Escolher os agentes')!
    expect(b.hasAttribute('disabled')).toBe(true)
  })

  it('off: nothing more than the switch', async () => {
    const t = await render({ node: false })
    expect(t).not.toContain('Escolher os agentes')
    expect(t).not.toContain('Nenhuma pasta ainda')
  })
})
