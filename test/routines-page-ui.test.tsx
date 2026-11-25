// The routines page: the week by default, with every run of a routine at its own hour, what failed
// counted on top, and the list that starts with what needs me. The choice of view stays while the
// app is open. The core is a stand-in.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message, Routine } from '../src/shared/types'
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
    saveRoutine: vi.fn(async (r: Routine) => r),
    runRoutine: vi.fn(),
    navigate: vi.fn()
  }
})
const { getState, runRoutine, saveRoutine } = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { RoutinesPage } = await import('../src/renderer/src/components/Routines')

const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const vigia: Routine = { id: 'r1', name: 'Vigia', agentId: 'a1', conversationId: 'd1', prompt: 'x', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', times: ['09:00', '10:00', '11:00'] }, enabled: true, createdAt: 0 }
const briefing: Routine = { id: 'r2', name: 'Briefing', agentId: 'a1', conversationId: 'd1', prompt: 'y', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '08:30' }, enabled: true, createdAt: 0 }
// A run of each, a moment ago: Vigia's failed.
const ran = (r: Routine, n: number, status: 'done' | 'failed', error?: string): Message[] => {
  const at = Date.now() - 2000 + n
  return [
    { id: `ask${n}`, conversationId: 'd1', author: { kind: 'routine', id: r.id }, text: r.prompt, at, routine: { name: r.name, scheduledAt: at, late: false } },
    { id: `rep${n}`, conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'Feito.', at: at + 1, run: { status, steps: [], ...(error ? { error } : {}) } }
  ] as Message[]
}

let root: Root
beforeEach(() => {
  // The week is drawn around today, so the clock is fixed: on a Sunday after 09:00 every block of a
  // 09:00 routine would already be in the past, and there would be no upcoming one to open.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 18, 8, 0))
  const base = getState()
  fake = { ...base, ready: true, agents: [lia], conversations: [{ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }], routines: [vigia, briefing], messages: { d1: [...ran(vigia, 0, 'failed', 'O GitHub não respondeu.'), ...ran(briefing, 10, 'done')] }, connectors: [] } as State
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.useRealTimers()
  vi.clearAllMocks()
})

const text = (): string => document.body.textContent ?? ''
const all = (sel: string): string[] => [...document.querySelectorAll(sel)].map((x) => x.textContent ?? '')
const button = (name: RegExp): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => name.test((x.textContent ?? '').trim()))
  if (!b) throw new Error(`no button ${name}: ${[...document.querySelectorAll('button')].map((x) => x.textContent).join(' | ')}`)
  return b as HTMLButtonElement
}
const click = async (b: Element): Promise<void> => {
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await act(async () => new Promise((r) => setTimeout(r, 10)))
}

describe('the routines page', () => {
  it('opens on the week: each run of a several-times-a-day routine at its hour, and what failed on top', async () => {
    await act(async () => root.render(<RoutinesPage />))
    expect(button(/^Semana$/).getAttribute('aria-checked')).toBe('true')
    expect(document.querySelector('.cal__strip')).toBeNull()
    expect(document.querySelector('.cal__allday')).toBeNull()
    const vigiaBlocks = all('.cal__ev').filter((t) => t.includes('Vigia'))
    expect(vigiaBlocks.some((t) => t.includes('09:00'))).toBe(true)
    expect(vigiaBlocks.some((t) => t.includes('10:00'))).toBe(true)
    expect(vigiaBlocks.some((t) => t.includes('11:00'))).toBe(true)
    expect(all('.cal__ev').some((t) => t.includes('Briefing'))).toBe(true)
    expect(button(/1 falhou/).getAttribute('aria-pressed')).toBe('false')
    await click(button(/1 falhou/))
    expect(document.querySelector('.cal__ev.is-dim')?.textContent).toContain('Briefing')
    const failed = [...document.querySelectorAll('.cal__ev')].find((x) => x.textContent?.includes('Vigia') && x.querySelector('i.is-bad'))!
    expect(failed.className).not.toContain('is-dim')
    await click(failed)
    expect(document.querySelector('.cal-pop h3')?.textContent).toBe('Vigia')
    expect(document.querySelector('.cal-pop__when')?.textContent).toContain('falhou')
  })

  it('keeps one block for each routine when they share an hour', async () => {
    const coletar: Routine = { id: 'r5', name: 'Coletar', agentId: 'a1', conversationId: 'd1', prompt: 'c', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', times: ['09:00'] }, enabled: true, createdAt: 0 }
    fake = { ...fake, routines: [vigia, coletar], messages: { d1: [] } }
    await act(async () => root.render(<RoutinesPage />))
    const together = [...document.querySelectorAll('.cal__col')].filter((col) => {
      const blocks = [...col.querySelectorAll('.cal__ev')].map((x) => x.textContent ?? '')
      return blocks.some((t) => t.includes('Vigia') && t.includes('09:00')) && blocks.some((t) => t.includes('Coletar') && t.includes('09:00'))
    })
    expect(together.length).toBeGreaterThan(0)
    expect(together[0]!.querySelectorAll('.cal__ev').length).toBeGreaterThanOrEqual(2)
  })

  it('keeps a routine that’s off in the week, greyed, and turns it back on from its own panel', async () => {
    const semanal: Routine = { id: 'r3', name: 'Semanal', agentId: 'a1', conversationId: 'd1', prompt: 'z', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, enabled: false, createdAt: 0 }
    const apagada: Routine = { id: 'r4', name: 'Apagada', agentId: 'a1', conversationId: 'd1', prompt: 'w', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, enabled: true, createdAt: 0 }
    fake = { ...fake, routines: [vigia, briefing, semanal], messages: { d1: [...(fake.messages.d1 ?? []), ...ran(semanal, 20, 'done'), ...ran(apagada, 30, 'done')] } }
    await act(async () => root.render(<RoutinesPage />))
    const offBlocks = () => [...document.querySelectorAll('.cal__ev.is-off')]
    expect(offBlocks().map((x) => x.textContent ?? '').join(' | ')).toContain('Semanal')
    expect(all('.cal__ev').some((t) => t.includes('Apagada'))).toBe(false)

    const block = offBlocks().find((x) => (x.textContent ?? '').includes('Semanal') && !x.className.includes('is-past'))!
    await click(block)
    const toggle = document.querySelector('.cal-pop .toggle')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(document.querySelector('.cal-pop__when')?.textContent).toContain('Desligada')
    await click(toggle)
    expect(saveRoutine).toHaveBeenCalledWith(expect.objectContaining({ id: 'r3', enabled: true }))
  })

  it('lists what needs me first, with why and what to do, then the rest; and remembers the list', async () => {
    await act(async () => root.render(<RoutinesPage />))
    await click(button(/^Lista$/))
    expect(text()).toContain('Precisa de você · 1')
    expect(document.querySelector('.rt-need')?.textContent).toContain('Vigia')
    expect(document.querySelector('.rt-need__what')?.textContent).toMatch(/^falhou às \d\d:\d\d$/)
    expect(document.querySelector('.rt-need__body')?.textContent).toContain('O GitHub não respondeu.')
    await click(button(/Rodar agora/))
    expect(runRoutine).toHaveBeenCalledWith('r1')
    expect(all('.rt-row .rt-row__name')).toEqual(['Briefing'])
    expect(document.querySelector('.rt-row .rt-row__sub')?.textContent).toBe('Lia · todo dia, 08:30')
    expect(document.querySelector('.cal')).toBeNull()

    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    await act(async () => root.render(<RoutinesPage />))
    expect(button(/^Lista$/).getAttribute('aria-checked')).toBe('true')
    await click(button(/^Semana$/))
  })
})
