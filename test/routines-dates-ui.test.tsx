// The routine editor saves a routine on a date (once) or on a day of every month, a past date can't
// be saved, and the week view shows a dated one in its own week only. The core is a stand-in.
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
    navigate: vi.fn()
  }
})
const { getState, saveRoutine, isoDay } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { RoutinesPage, duplicateDraft } = await import('../src/renderer/src/components/Routines')

const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const DAY = 86_400_000

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
const fillAndPickDate = async (date: string): Promise<void> => {
  await click(button(/Nova rotina/))
  await type(document.querySelector('.routine-form input')!, 'Reunião')
  await type(document.querySelector('.routine-form textarea')!, 'Me lembre da reunião.')
  await click(button(/^Numa data$/))
  await type(document.querySelector('.routine-form input[type="date"]')!, date)
}

describe('a routine on a date, in the editor', () => {
  it('saves a dated one-off with the date picked', async () => {
    await act(async () => root.render(<RoutinesPage />))
    const day = isoDay(Date.now() + 20 * DAY)
    await fillAndPickDate(day)
    expect(text()).toContain('Uma vez,')
    await click(button(/^Criar rotina$/))
    expect(saveRoutine).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveRoutine).mock.calls[0]![0]).toMatchObject({ name: 'Reunião', schedule: { date: day, once: true, time: '09:00' }, conversationId: 'd1' })
  })

  it("a past date says so and can't be saved", async () => {
    await act(async () => root.render(<RoutinesPage />))
    await fillAndPickDate(isoDay(Date.now() - 3 * DAY))
    expect(text()).toContain('Essa data já passou')
    expect(button(/^Criar rotina$/).disabled).toBe(true)
  })

  it('saves one for a day of every month', async () => {
    await act(async () => root.render(<RoutinesPage />))
    await click(button(/Nova rotina/))
    await type(document.querySelector('.routine-form input')!, 'Aluguel')
    await type(document.querySelector('.routine-form textarea')!, 'Me lembre do aluguel.')
    await click(button(/^Todo mês$/))
    expect(text()).toMatch(/Todo dia \d+ do mês às 9h/)
    await click(button(/^Criar rotina$/))
    expect(vi.mocked(saveRoutine).mock.calls[0]![0]).toMatchObject({ schedule: { monthDay: new Date().getDate() } })
    expect(vi.mocked(saveRoutine).mock.calls[0]![0].schedule.date).toBeUndefined()
  })
})

describe('the week view', () => {
  it('shows a dated routine in its own week, not in this one', async () => {
    const later = new Date(Date.now() + 14 * DAY)
    later.setHours(10, 0, 0, 0)
    const r: Routine = { id: 'r1', name: 'Dia marcado', agentId: 'a1', conversationId: 'd1', prompt: 'x', schedule: { days: [later.getDay()], time: '10:00', once: true, date: isoDay(later.getTime()) }, enabled: true, nextAt: later.getTime(), createdAt: 0 }
    fake = { ...fake, routines: [r] }
    await act(async () => root.render(<RoutinesPage />))
    const inCalendar = (): boolean => [...document.querySelectorAll('.cal-grid, .cal')].some((x) => (x.textContent ?? '').includes('Dia marcado')) || text().includes('Dia marcado')
    expect(inCalendar()).toBe(false)
    const next = document.querySelector('button[title^="Próxima semana"]')!
    await click(next)
    await click(next)
    expect(inCalendar()).toBe(true)
  })
})

describe('duplicating a routine', () => {
  it('opens a copy that saves as new, is yours, and starts off', () => {
    const r: Routine = { id: 'r9', name: 'Standup', agentId: 'a1', conversationId: 'd1', prompt: 'Sum up', schedule: { days: [1, 3], time: '09:00' }, enabled: true, nextAt: 1, lastAt: 1, createdBy: 'a1', createdAt: 1, owner: 'p2', trigger: { kind: 'webhook', token: 'tok' } }
    const d = duplicateDraft(r)
    expect(d).toEqual({ name: 'Standup (cópia)', prompt: 'Sum up', agentId: 'a1', conversationId: 'd1', schedule: { days: [1, 3], time: '09:00' }, enabled: false, trigger: { kind: 'webhook', token: '' } }) // the core gives the copy its own address
    expect(d.schedule.days).not.toBe(r.schedule.days)
  })
})
