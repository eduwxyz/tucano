// On a server, a computer someone lent it can be off (the Tucano app closed there). An agent that uses it
// says so in two places only: a quiet line above its DM's field, and a line in its card. Nothing while it's on.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Agent, Connector } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { nodeUrl } from '../src/shared/node-link'
import { lentComputersOf } from '../src/renderer/src/lent'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })

let fake: State
const navigate = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake), getState: () => fake, navigate: (v: unknown) => navigate(v) }
})
const { createRoot } = await import('react-dom/client')
const { ComputerOff } = await import('../src/renderer/src/components/Conversation')
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()

const node = (id: string, name: string, status: Connector['status'], owner?: string): Connector => ({ id, name, kind: 'remote', url: nodeUrl(name, owner), auth: 'none', status, tools: [] }) as unknown as Connector
const nina = { id: 'n1', name: 'Nina', grants: { mac: 'read_write' } } as unknown as Agent
const people = [
  { id: 'edu', name: 'Edu', role: 'owner', about: '' },
  { id: 'ana', name: 'Ana', role: 'member', about: '' }
]

let root: Root
const render = async (connectors: Connector[], agent: Agent = nina): Promise<string> => {
  fake = { ...base, ready: true, people, you: 'edu', connectors } as unknown as State
  await act(async () => root.render(<ComputerOff agent={agent} />))
  return document.getElementById('root')!.textContent ?? ''
}
beforeEach(() => {
  navigate.mockClear()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => act(async () => root.unmount()))

it("finds the lent computers an agent may use, whose they are and whether they're on", () => {
  const connectors = [node('mac', 'MacBook do Edu', 'connected'), node('pc', 'PC da Ana', 'disconnected', 'ana'), node('linear', 'Linear', 'connected')]
  connectors[2]!.url = 'https://mcp.linear.app/mcp'
  const s = { connectors, people, you: 'edu' }
  expect(lentComputersOf(s, { grants: { mac: 'read', pc: 'read_write', linear: 'read' } })).toEqual([
    { id: 'mac', name: 'MacBook do Edu', on: true, mine: true },
    { id: 'pc', name: 'PC da Ana', on: false, mine: false }
  ])
  expect(lentComputersOf(s, { grants: { mac: 'none' } })).toEqual([])
})

it('says nothing while the computer is on', async () => {
  expect(await render([node('mac', 'MacBook do Edu', 'connected')])).toBe('')
})

it("says the computer is off and the agent can't reach it, with the way to my computers when it's mine", async () => {
  const text = await render([node('mac', 'MacBook do Edu', 'disconnected')])
  expect(text).toContain('MacBook do Edu está desligado. Nina responde, mas só usa esse computador quando ele ligar.')
  const button = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Ver computadores') as unknown as HTMLElement
  await act(async () => button.click())
  expect(navigate).toHaveBeenCalledWith({ kind: 'connectors' })
})

it("names someone else's computer without a way to settings that aren't mine", async () => {
  const ana = { ...nina, grants: { pc: 'read' } } as unknown as Agent
  const text = await render([node('pc', 'PC da Ana', 'disconnected', 'ana')], ana)
  expect(text).toContain('PC da Ana está desligado.')
  expect(text).not.toContain('Ver computadores')
})
