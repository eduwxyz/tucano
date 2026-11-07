// Tucano Team v1: an agent the core refuses to save (its name or @ is a person's) says why on the
// screen it was saved from, the agent's page or the new-agent wizard, and nothing goes uncaught.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

// The animated avatar draws on a canvas: not here.
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

const REFUSED = 'Já tem uma pessoa chamada Bia aqui. Dê outro nome e outro @ ao agente.'
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    saveAgent: vi.fn(() => Promise.reject(new Error(REFUSED))),
    ensureTuca: vi.fn(() => new Promise(() => {})), // the Tuca's session: not needed here
    navigate: vi.fn()
  }
})
const { getState, saveAgent } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { AgentPage } = await import('../src/renderer/src/components/Pages')
const { Onboarding } = await import('../src/renderer/src/components/Onboarding')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'ana' }
const ready = { installed: true, loggedIn: true }

const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)
beforeAll(() => process.on('unhandledRejection', onCrash))
afterAll(() => process.off('unhandledRejection', onCrash))

let root: Root
beforeEach(() => {
  const base = getState()
  fake = { ...base, ready: true, people: [ana, bia], you: 'ana', agents: [lia], connectors: [], tabs: {}, settings: { ...base.settings, engines: { ...base.settings.engines, claude: ready } } }
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

const text = (): string => document.body.textContent ?? ''
const button = (name: RegExp): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => name.test((x.textContent ?? '').trim()) && !x.disabled)
  if (!b) throw new Error(`no enabled button ${name}: ${[...document.querySelectorAll('button')].map((x) => `${x.textContent}${x.disabled ? '(off)' : ''}`).join(' | ')}`)
  return b as HTMLButtonElement
}
const click = async (name: RegExp): Promise<void> => {
  const b = button(name)
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}

describe('a refused save', () => {
  it("on an agent's page, says why, and nothing goes uncaught", async () => {
    await act(async () => root.render(<AgentPage id="a1" />))
    await click(/^Salvar$/)
    expect(saveAgent).toHaveBeenCalled()
    expect(text()).toContain(REFUSED)
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(REFUSED)
    expect(crashes).toEqual([])
  })

  it('on a new agent from the form, says why, and nothing goes uncaught', async () => {
    await act(async () => root.render(<AgentPage draft={{ ...lia, id: 'new1', name: 'Bia', handle: 'bia2' }} />))
    await click(/^Criar agente$/)
    expect(saveAgent).toHaveBeenCalled()
    expect(text()).toContain(REFUSED)
    expect(crashes).toEqual([])
  })

  it('in the new-agent wizard, says why on its last step, and nothing goes uncaught', async () => {
    await act(async () => root.render(<Onboarding build />))
    await click(/Prefiro montar eu mesmo/)
    await click(/^Continuar$/)
    await click(/^Continuar$/)
    await click(/^Criar .* e enviar$/)
    expect(saveAgent).toHaveBeenCalled()
    expect(text()).toContain(REFUSED)
    expect(document.querySelector('.note--error')?.textContent).toContain(REFUSED)
    expect(button(/^Criar .* e enviar$/)).toBeTruthy() // can try again
    expect(crashes).toEqual([])
  })
})
