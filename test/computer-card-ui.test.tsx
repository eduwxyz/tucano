// The agent's "Computador" card (0.2.18, a person's report): on "Este computador" it showed a short
// line and two buttons, and only after clicking Linux and back did the "full" card appear. That
// card was Linux's panel (Docker, lent folders, erase) under the confirmation, with Linux still
// picked and already saved. Each saved state shows its own content on the first render, and a
// confirmation shows alone, with the choice it confirms picked.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, ComputerInfo, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), computerAction: vi.fn(), saveAgent: vi.fn(async () => {}), ensureTuca: vi.fn(() => new Promise(() => {})) }
})
const { getState, saveAgent } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { AgentPage } = await import('../src/renderer/src/components/Pages')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia = (p: Partial<Agent>): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...p })
const info = (kind: 'mac' | 'linux', state: ComputerInfo['state']): ComputerInfo => ({ agentId: 'a1', kind, state, folder: '/Users/ana/x', services: [] })

let root: Root
const render = async (agent: Agent, computer?: ComputerInfo): Promise<void> => {
  fake = { ...getState(), ready: true, people: [ana], you: 'ana', agents: [agent], connectors: [], tabs: { agent: 'ferramentas' }, computers: computer ? [computer] : [], isolatedComputers: true }
  await act(async () => root.render(<AgentPage id="a1" />))
}
// The section, since the page's sections became list groups (its title, a "?", then its rows).
const card = (): Element => [...document.querySelectorAll('.lgroup')].find((c) => c.textContent?.startsWith('Computador'))!
const text = (): string => card().textContent ?? ''
const picked = (): string => [...card().querySelectorAll('[role="radio"]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent).join()
const click = async (name: string): Promise<void> => {
  const b = [...card().querySelectorAll('button')].find((x) => x.textContent === name)!
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
}

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe('the Computador card, on its first render', () => {
  it('none: just the choice', async () => {
    await render(lia({ computer: false }))
    expect(picked()).toBe('Nenhum')
    expect(text()).not.toContain('Liberar o computador pra ele')
    expect(text()).not.toContain('Emprestar pasta')
  })

  it("Linux: Docker's state, lent folders and the computer's buttons", async () => {
    await render(lia({ computer: true, computerKind: 'linux' }), info('linux', 'no_docker'))
    expect(picked()).toBe('Linux isolado')
    for (const t of ['sem Docker', 'Verificar de novo', 'Pastas do seu computador', 'Emprestar pasta…', 'Abrir pasta', 'Reiniciar', 'Apagar computador']) expect(text()).toContain(t)
    expect(text()).not.toContain('Liberar o computador pra ele')
  })

  it('this computer, let: what it means, its folder and services, and nothing of Linux nor the confirmation', async () => {
    await render(lia({ computer: true, computerKind: 'mac' }), info('mac', 'running'))
    expect(picked()).toBe('Este computador')
    for (const t of ['no seu computador', 'Liberado: os comandos rodam direto no seu computador', 'alcança as suas pastas sem emprestar e não precisa do Docker', 'Abrir pasta dele', 'Parar serviços']) expect(text()).toContain(t)
    for (const t of ['Liberar o computador pra ele', 'Emprestar pasta', 'sem Docker', 'Verificar de novo', 'Apagar computador']) expect(text()).not.toContain(t)
  })
})

describe('picking "Este computador"', () => {
  it('from Linux: the confirmation alone, with "Este computador" picked; Cancelar goes back, nothing saved', async () => {
    await render(lia({ computer: true, computerKind: 'linux' }), info('linux', 'no_docker'))
    await click('Este computador')
    expect(picked()).toBe('Este computador')
    expect(text()).toContain('Liberar o computador pra ele')
    for (const t of ['sem Docker', 'Emprestar pasta', 'Apagar computador']) expect(text()).not.toContain(t)
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(saveAgent).not.toHaveBeenCalled()
    await click('Cancelar')
    expect(picked()).toBe('Linux isolado')
    expect(text()).toContain('Emprestar pasta')
  })

  it('clicking the saved choice again drops the confirmation', async () => {
    await render(lia({ computer: false }))
    await click('Este computador')
    expect(text()).toContain('Liberar o computador pra ele')
    await click('Nenhum')
    expect(picked()).toBe('Nenhum')
    expect(text()).not.toContain('Liberar o computador pra ele')
  })

  it('Liberar saves it and shows this computer’s card', async () => {
    await render(lia({ computer: false }))
    await click('Este computador')
    await click('Liberar o computador pra ele')
    // It saves by itself, right away: the stored agent with the change, in its channels.
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', computer: true, computerKind: 'mac' }), [])
    expect(picked()).toBe('Este computador')
    expect(text()).toContain('Abrir pasta dele')
    expect(text()).not.toContain('Liberar o computador pra ele')
  })
})

// On a server (Tucano Pro's, with no Docker): "this computer" is the server, an isolated Linux can't run,
// and the person's own computer comes lent from the desktop app, as a connector the agent needs access to.
describe('the Computador card on a server', () => {
  const node = { id: 'mac1', name: 'MacBook Air de Ana', kind: 'remote', url: 'tucano-node://dev1', auth: 'none', status: 'connected', tools: [] } as unknown as State['connectors'][number]
  const onServer = async (agent: Agent, o: { connectors?: State['connectors']; lending?: () => void } = {}): Promise<void> => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: { ...(o.lending ? { openLending: o.lending } : {}) } })
    fake = { ...getState(), ready: true, people: [ana], you: 'ana', agents: [agent], connectors: o.connectors ?? [], tabs: { agent: 'ferramentas' }, computers: [], isolatedComputers: false }
    await act(async () => root.render(<AgentPage id="a1" />))
  }
  afterEach(() => void Object.assign(window, { __TUCANO_WEB__: undefined, tucano: undefined }))

  it('Linux without Docker: says it can’t run here, with no "check again", and switches to None in one click', async () => {
    await onServer(lia({ computer: true, computerKind: 'linux' }))
    expect(text()).toContain('Este servidor não tem Docker, então o Linux isolado não roda aqui')
    for (const t of ['Verificar de novo', 'Depois, clique', 'Emprestar pasta', 'Apagar computador']) expect(text()).not.toContain(t)
    await click('Trocar pra Nenhum')
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', computer: false }), [])
  })

  it('names the server choice for what it is, and its confirmation says it isn’t your computer', async () => {
    await onServer(lia({ computer: false }))
    expect(card().textContent).toContain('O servidor')
    expect(text()).not.toContain('Este computador')
    await click('O servidor')
    expect(text()).toContain('vão rodar direto no servidor, não no seu computador')
    expect(text()).toContain('Liberar o servidor pra ele')
  })

  it('no computer lent: how to lend it, and in the desktop app the button that goes there', async () => {
    const lending = vi.fn()
    await onServer(lia({ computer: false }), { lending })
    expect(text()).toContain('Deixar este servidor usar este computador')
    await click('Abrir no Tucano deste computador')
    expect(lending).toHaveBeenCalled()
  })

  it('in a browser there is no app to open: the words only', async () => {
    await onServer(lia({ computer: false }))
    expect(text()).toContain('Deixar este servidor usar este computador')
    expect(text()).not.toContain('Abrir no Tucano deste computador')
  })

  it('your computer lent but not given to this agent: gives access in one click', async () => {
    await onServer(lia({ computer: false }), { connectors: [node] })
    expect(text()).toContain('MacBook Air de Ana está emprestado a este servidor, mas este agente ainda não tem acesso a ele')
    await click('Dar acesso')
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', grants: { mac1: 'read_write' } }), [])
  })

  it('given: says what it uses and where the level is', async () => {
    await onServer(lia({ computer: false, grants: { mac1: 'read_write' } }), { connectors: [node] })
    expect(text()).toContain('Ele usa o MacBook Air de Ana (terminal, pastas emprestadas e navegador)')
    expect(text()).not.toContain('Dar acesso')
  })

  it("someone else's computer isn't yours to give", async () => {
    await onServer(lia({ computer: false }), { connectors: [{ ...node, url: 'tucano-node://dev2?owner=bia' }] })
    expect(text()).not.toContain('MacBook Air de Ana')
    expect(text()).toContain('Deixar este servidor usar este computador')
  })
})
