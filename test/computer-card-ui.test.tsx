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
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake ?? real.getState(), computerAction: vi.fn(), shareComputer: vi.fn(), harnessMcps: vi.fn(async () => []), saveAgent: vi.fn(async () => {}), ensureTuca: vi.fn(() => new Promise(() => {})) }
})
const { getState, saveAgent, shareComputer } = await import('../src/renderer/src/store')
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
const card = (): Element => [...document.querySelectorAll('.lgroup')].find((c) => c.textContent?.startsWith('Onde trabalha'))!
const text = (): string => card().textContent ?? ''
const picked = (): string => [...card().querySelectorAll('[role="radio"]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.textContent).join()
const click = async (name: string): Promise<void> => {
  const b = [...card().querySelectorAll('button')].find((x) => x.textContent === name)!
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
}
const lead = (): string => card().querySelector('.lgroup__lead')?.textContent ?? ''
const toggle = (label: string): Element => card().querySelector(`[role="switch"][aria-label="${label}"]`)!
const flip = async (label: string): Promise<void> => {
  await act(async () => void toggle(label).dispatchEvent(new window.Event('click', { bubbles: true })))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}

beforeEach(() => (root = createRoot(document.getElementById('root')!)))
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

describe('the Onde trabalha card, on its first render', () => {
  it('none: just the choice, and the line says it runs commands nowhere', async () => {
    await render(lia({ computer: false }))
    expect(picked()).toBe('Não')
    expect(lead()).toBe('Lia não roda comandos em nenhum computador: conversa, pesquisa e usa os conectores.')
    expect(text()).not.toContain('Liberar o computador pra ele')
    expect(text()).not.toContain('Emprestar pasta')
  })

  it("Linux: Docker's state, lent folders and the computer's buttons", async () => {
    await render(lia({ computer: true, computerKind: 'linux' }), info('linux', 'no_docker'))
    expect(picked()).toBe('Linux isolado')
    expect(lead()).toBe('Lia trabalha num Linux isolado neste computador.')
    for (const t of ['sem Docker', 'Verificar de novo', 'Pastas do seu computador', 'Emprestar pasta…', 'Abrir pasta', 'Reiniciar', 'Apagar computador']) expect(text()).toContain(t)
    expect(text()).not.toContain('Liberar o computador pra ele')
  })

  it('this computer, let: what it means, its folder and services, and nothing of Linux nor the confirmation', async () => {
    await render(lia({ computer: true, computerKind: 'mac' }), info('mac', 'running'))
    expect(picked()).toBe('Direto no computador')
    expect(lead()).toBe('Lia trabalha direto neste computador.')
    for (const t of ['no seu computador', 'Liberado: os comandos rodam direto no seu computador', 'alcança as suas pastas sem emprestar e não precisa do Docker', 'Abrir pasta dele', 'Parar serviços']) expect(text()).toContain(t)
    for (const t of ['Liberar o computador pra ele', 'Emprestar pasta', 'sem Docker', 'Verificar de novo', 'Apagar computador']) expect(text()).not.toContain(t)
  })
})

describe('picking "Direto no computador"', () => {
  it('from Linux: the confirmation alone, with "Direto no computador" picked; Cancelar goes back, nothing saved', async () => {
    await render(lia({ computer: true, computerKind: 'linux' }), info('linux', 'no_docker'))
    await click('Direto no computador')
    expect(picked()).toBe('Direto no computador')
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
    await click('Direto no computador')
    expect(text()).toContain('Liberar o computador pra ele')
    await click('Não')
    expect(picked()).toBe('Não')
    expect(text()).not.toContain('Liberar o computador pra ele')
  })

  it('Liberar saves it and shows this computer’s card', async () => {
    await render(lia({ computer: false }))
    await click('Direto no computador')
    await click('Liberar o computador pra ele')
    // It saves by itself, right away: the stored agent with the change, in its channels.
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', computer: true, computerKind: 'mac' }), [])
    expect(picked()).toBe('Direto no computador')
    expect(text()).toContain('Abrir pasta dele')
    expect(text()).not.toContain('Liberar o computador pra ele')
  })
})

// On a server (Tucano Pro's, with no Docker): the server is one place, an isolated Linux can't run there, and
// each computer lent to it is another, its person's to give.
describe('Onde trabalha on a server', () => {
  const node = { id: 'mac1', name: 'MacBook Air de Ana', kind: 'remote', url: 'tucano-node://dev1', auth: 'none', status: 'connected', tools: [] } as unknown as State['connectors'][number]
  const bias = { ...node, id: 'mac2', url: 'tucano-node://dev2?owner=bia', name: 'iMac de Bia', status: 'disconnected' } as unknown as State['connectors'][number]
  const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
  const onServer = async (agent: Agent, o: { connectors?: State['connectors']; lending?: () => void; you?: string } = {}): Promise<void> => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: { ...(o.lending ? { openLending: o.lending } : {}) } })
    Object.assign(globalThis, { location: { host: 'kobi.tucano.pro' } })
    fake = { ...getState(), ready: true, people: [ana, bia], you: o.you ?? 'ana', agents: [agent], connectors: o.connectors ?? [], tabs: { agent: 'ferramentas' }, computers: [], isolatedComputers: false }
    await act(async () => root.render(<AgentPage id="a1" />))
  }
  afterEach(() => void Object.assign(window, { __TUCANO_WEB__: undefined, tucano: undefined }))

  it('the server is a row of its own, named with its address', async () => {
    await onServer(lia({ computer: false }))
    expect(text()).toContain('Servidorkobi.tucano.pro · sempre ligado')
    expect(lead()).toBe('Lia não roda comandos em nenhum computador: conversa, pesquisa e usa os conectores. A conversa e a memória ficam sempre no servidor.')
  })

  it('Linux without Docker: says it can’t run here, with no "check again", and switches to Não in one click', async () => {
    await onServer(lia({ computer: true, computerKind: 'linux' }))
    expect(text()).toContain('Este servidor não tem Docker, então o Linux isolado não roda aqui')
    expect(lead()).toContain('Lia não roda comandos em nenhum computador')
    for (const t of ['Verificar de novo', 'Depois, clique', 'Emprestar pasta', 'Apagar computador']) expect(text()).not.toContain(t)
    await click('Trocar pra Não')
    await act(async () => new Promise((r) => setTimeout(r, 10)))
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', computer: false }), [])
  })

  it('names the server choice for what it is, and its confirmation says it isn’t your computer', async () => {
    await onServer(lia({ computer: false }))
    expect(text()).not.toContain('Este computador')
    await click('Direto no servidor')
    expect(text()).toContain('vão rodar direto no servidor, não no seu computador')
    expect(text()).toContain('Liberar o servidor pra ele')
  })

  it('no computer lent: how to lend it, and in the desktop app the button that goes there', async () => {
    const lending = vi.fn()
    await onServer(lia({ computer: false }), { lending })
    expect(text()).toContain('Deixar este servidor usar este computador')
    await click('Emprestar este computador')
    expect(lending).toHaveBeenCalled()
  })

  it('in a browser there is no app to open: the words only', async () => {
    await onServer(lia({ computer: false }))
    expect(text()).toContain('Deixar este servidor usar este computador')
    expect(text()).toContain('abra o app do Tucano nele, conecte este servidor em Configurações › Servidores')
    expect(text()).not.toContain('Emprestar este computador')
  })

  it('your computer lent but not given to this agent: a row of its own, turned on in one click', async () => {
    await onServer(lia({ computer: false }), { connectors: [node] })
    expect(text()).toContain('MacBook Air de Anaemprestado por você ·  conectado')
    expect(toggle('Usa o MacBook Air de Ana').getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('Pra ele usar outro computador, empreste ele no app do Tucano de lá.')
    expect(text()).not.toContain('Deixar este servidor usar este computador')
    await flip('Usa o MacBook Air de Ana')
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', grants: { mac1: 'read_write' } }), [])
  })

  it('given: the line names it with the server, and it turns off in one click', async () => {
    await onServer(lia({ computer: true, computerKind: 'mac', grants: { mac1: 'read_write' } }), { connectors: [node] })
    expect(lead()).toBe('Lia trabalha direto no servidor e no MacBook Air de Ana. Num computador emprestado, só quando trabalha pra quem emprestou. A conversa e a memória ficam sempre no servidor.')
    expect(toggle('Usa o MacBook Air de Ana').getAttribute('aria-checked')).toBe('true')
    await flip('Usa o MacBook Air de Ana')
    expect(saveAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', grants: {} }), [])
  })

  it('a member gives their own computer through the core, since they can’t save the agent', async () => {
    await onServer(lia({ computer: false }), { connectors: [{ ...bias, status: 'connected' } as State['connectors'][number]], you: 'bia' })
    await flip('Usa o iMac de Bia')
    expect(shareComputer).toHaveBeenCalledWith('mac2', ['a1'])
    expect(saveAgent).not.toHaveBeenCalled()
  })

  it("someone else's computer shows, off or on, but only its person turns it", async () => {
    await onServer(lia({ computer: false, grants: { mac2: 'read_write' } }), { connectors: [bias] })
    expect(text()).toContain('iMac de Biaemprestado por Bia ·  desligado')
    expect(text()).toContain('só Bia libera')
    expect(toggle('Usa o iMac de Bia').getAttribute('aria-checked')).toBe('true')
    expect(toggle('Usa o iMac de Bia').hasAttribute('disabled')).toBe(true)
    expect(lead()).toContain('Lia trabalha no iMac de Bia (desligado agora).')
    // None of the viewer's own is lent: how to lend it, still.
    expect(text()).toContain('Deixar este servidor usar este computador')
  })
})

// Connectors, on a server: the viewer's lent computer comes first, with every agent on or off, or all at once.
describe('Connectors on a server', () => {
  const node = { id: 'mac1', name: 'MacBook Air de Ana', kind: 'remote', url: 'tucano-node://dev1', auth: 'none', status: 'connected', tools: [] } as unknown as State['connectors'][number]
  const page = async (agents: Agent[], connectors: State['connectors'] = [node]): Promise<string> => {
    Object.assign(window, { __TUCANO_WEB__: true, tucano: {} })
    fake = { ...getState(), ready: true, people: [ana], you: 'ana', agents, connectors, tabs: {}, computers: [] }
    const { ConnectorsPage } = await import('../src/renderer/src/components/Pages')
    await act(async () => root.render(<ConnectorsPage />))
    return document.querySelector('.my-computers')?.textContent ?? ''
  }
  const press = async (name: string): Promise<void> => {
    const b = [...document.querySelectorAll('.my-computers button')].find((x) => x.textContent === name)!
    await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  }
  afterEach(() => void Object.assign(window, { __TUCANO_WEB__: undefined, tucano: undefined }))

  it('your computer, with no agent yet: all of them in one click', async () => {
    const t = await page([lia({}), lia({ id: 'a2', name: 'Rui', handle: 'rui' })])
    expect(t).toContain('MacBook Air de Ana')
    expect(t).toContain('Nenhum agente usa ainda')
    await press('Dar acesso a todos')
    expect(shareComputer).toHaveBeenCalledWith('mac1', ['a1', 'a2'])
  })

  it('one agent on its own switch, and all of them already: taken from all', async () => {
    await page([lia({ grants: { mac1: 'read_write' } }), lia({ id: 'a2', name: 'Rui', handle: 'rui' })])
    const sw = document.querySelector('.my-computers [aria-label="Rui usa o computador"]')!
    await act(async () => void sw.dispatchEvent(new window.Event('click', { bubbles: true })))
    expect(shareComputer).toHaveBeenCalledWith('mac1', ['a1', 'a2'])
    const t = await page([lia({ grants: { mac1: 'read_write' } })])
    expect(t).toContain('Todos os agentes usam')
    await press('Tirar de todos')
    expect(shareComputer).toHaveBeenLastCalledWith('mac1', [])
  })

  it('nothing lent: how to lend it, there and not on a desktop', async () => {
    expect(await page([lia({})], [])).toContain('conecte este servidor em Configurações › Servidores')
    Object.assign(window, { __TUCANO_WEB__: undefined })
    await act(async () => root.render(<div />))
    const { ConnectorsPage } = await import('../src/renderer/src/components/Pages')
    await act(async () => root.render(<ConnectorsPage />))
    expect(document.querySelector('.my-computers')).toBeNull()
  })
})
