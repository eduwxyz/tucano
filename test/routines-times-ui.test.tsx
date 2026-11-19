// The routine editor with several times a day, as pills: + time adds the next hour, × takes one off, the
// sentence says them all (and how many a week), and saving sends every one. Once and a date take one time. The core is a stand-in.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Routine } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: true }) })
Object.assign(document, { oninput: null })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    saveRoutine: vi.fn(async (r: Routine) => ({ ...r, id: 'r1' })),
    dmWith: vi.fn(async () => 'd1'),
    toast: vi.fn(),
    navigate: vi.fn()
  }
})
const { getState, saveRoutine, toast } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { RoutinesPage } = await import('../src/renderer/src/components/Routines')

const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }

let root: Root
beforeEach(() => {
  const base = getState()
  fake = { ...base, ready: true, agents: [lia], conversations: [{ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }], routines: [], messages: {}, connectors: [] } as State
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})

const text = (): string => document.body.textContent ?? ''
const button = (name: RegExp): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => name.test((x.textContent ?? '').trim()))
  if (!b) throw new Error(`no button ${name}: ${[...document.querySelectorAll('button')].map((x) => x.textContent).join(' | ')}`)
  return b as HTMLButtonElement
}
const click = async (b: Element): Promise<void> => {
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}
const type = async (input: Element, value: string): Promise<void> => {
  // linkedom has no default "text" type, and React only listens for typing on a text input.
  if (input.tagName === 'INPUT' && !input.getAttribute('type')) input.setAttribute('type', 'text')
  let proto: object | null = Object.getPrototypeOf(input)
  let set: ((v: string) => void) | undefined
  while (proto && !set) (set = Object.getOwnPropertyDescriptor(proto, 'value')?.set), (proto = Object.getPrototypeOf(proto))
  await act(async () => {
    set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const times = (): string[] => [...document.querySelectorAll('.routine-form input[type="time"]')].map((i) => (i as HTMLInputElement).value)
const start = async (): Promise<void> => {
  await act(async () => root.render(<RoutinesPage />))
  await click(button(/Nova rotina/))
  await type(document.querySelector('.routine-form input')!, 'Checar pedidos')
  await type(document.querySelector('.routine-form textarea')!, 'Olha os pedidos parados.')
  await type(document.querySelector('.routine-form input[type="time"]')!, '09:00')
}

describe('several times in one routine, in the editor', () => {
  it('adds the next hour, says them all and saves every one', async () => {
    await start()
    await click(button(/^\+ horário$/))
    await click(button(/^\+ horário$/))
    expect(times()).toEqual(['09:00', '10:00', '11:00'])
    expect(document.querySelectorAll('.time-pill')).toHaveLength(3)
    expect(text()).toContain('Seg a sex às 9h, 10h e 11h')
    expect(text()).toContain('15 vezes por semana')
    await click(document.querySelector('button[aria-label="Tirar 10:00"]')!)
    expect(times()).toEqual(['09:00', '11:00'])
    await click(button(/^Criar rotina$/))
    expect(saveRoutine).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveRoutine).mock.calls[0]![0].schedule).toMatchObject({ time: '09:00', times: ['09:00', '11:00'] })
  })

  it('sends a single time as one, so the server drops the ones it had', async () => {
    await start()
    expect(document.querySelector('button[aria-label^="Tirar"]')).toBeNull()
    await click(button(/^Criar rotina$/))
    expect(vi.mocked(saveRoutine).mock.calls[0]![0].schedule).toMatchObject({ time: '09:00', times: ['09:00'] })
  })

  it('a time left empty says so and holds the save, instead of going quietly', async () => {
    await start()
    await click(button(/^\+ horário$/))
    await type(document.querySelectorAll('.routine-form input[type="time"]')[1]!, '')
    expect(times()).toEqual(['09:00', ''])
    expect(text()).toContain('Preencha cada horário, ou tire o que sobrou.')
    expect(button(/^Criar rotina$/).disabled).toBe(true)
    await click(document.querySelector('button[aria-label="Tirar "]')!)
    expect(button(/^Criar rotina$/).disabled).toBe(false)
  })

  it('once takes one time, with no + time', async () => {
    await start()
    await click(button(/^\+ horário$/))
    await click(button(/^Uma vez$/))
    expect(times()).toEqual(['09:00'])
    expect(text()).not.toContain('+ horário')
    await click(button(/^Toda semana$/))
    expect(times()).toEqual(['09:00'])
  })

  it('turning on a date that has passed says why, instead of nothing', async () => {
    const old: Routine = { id: 'r9', name: 'Reunião', agentId: 'a1', conversationId: 'd1', prompt: 'Me lembre.', schedule: { days: [2], time: '09:00', once: true, date: '2026-01-06' }, enabled: false, createdAt: 0 }
    fake = { ...fake, routines: [old] }
    vi.mocked(saveRoutine).mockRejectedValueOnce(new Error('Essa data já passou (ter, 6 jan às 9h). Escolha um dia e horário que ainda vão chegar.'))
    await act(async () => root.render(<RoutinesPage />))
    await click(button(/1 rotina desligada/))
    await click(document.querySelector('.cal-off [role="switch"]')!)
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Essa data já passou'))
  })
})
