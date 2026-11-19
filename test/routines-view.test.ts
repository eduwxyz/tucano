// The routines page's logic (src/renderer/src/components/routines-view.ts): which routines leave the
// hour grid for the "o dia todo" strip, how the list is split and ordered, and the short words it uses.
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Message, Routine, RunStatus } from '../src/shared/types'
import { allDay, chipOcc, failedWords, firstLine, listSections, markOf, nextWords, routineWords, scheduleWords, splitWeek, stripDay, type Occ } from '../src/renderer/src/components/routines-view'

const at = (d: number, h = 0, mi = 0): number => new Date(2026, 10, d, h, mi).getTime() // November 2026; the 16th is a Monday
const WEEKDAYS = [1, 2, 3, 4, 5]
const hourly = Array.from({ length: 9 }, (_, i) => `${String(9 + i).padStart(2, '0')}:00`)

const routine = (id: string, patch: Partial<Routine> = {}): Routine => ({ id, name: id, agentId: 'a1', conversationId: 'c1', prompt: 'x', schedule: { days: WEEKDAYS, time: '09:00' }, enabled: true, createdAt: 0, ...patch })
const run = (r: Routine, when: number, status?: RunStatus, text = ''): Occ => ({
  key: `${r.id}@${when}`,
  routine: r,
  name: r.name,
  agentId: r.agentId,
  at: when,
  conversationId: r.conversationId,
  status,
  reply: status ? ({ id: `m-${when}`, conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text, at: when, run: { status, steps: [] } } as Message) : undefined
})
const upcoming = (r: Routine, when: number): Occ => ({ key: `${r.id}-${when}`, routine: r, name: r.name, agentId: r.agentId, at: when, conversationId: r.conversationId, upcoming: true })

afterEach(() => setLang('pt'))

describe('the strip: routines that run several times a day', () => {
  const vigia = routine('vigia', { schedule: { days: WEEKDAYS, time: '09:00', times: hourly } })
  const briefing = routine('briefing', { schedule: { days: WEEKDAYS, time: '08:30' } })

  it('takes the ones with several times, and only those', () => {
    expect(allDay(vigia)).toBe(true)
    expect(allDay(routine('two', { schedule: { days: WEEKDAYS, time: '09:00', times: ['09:00', '18:00'] } }))).toBe(true)
    expect(allDay(routine('month', { schedule: { days: [], time: '08:00', times: ['08:00', '20:00'], monthDay: 5 } }))).toBe(true)
    expect(allDay(briefing)).toBe(false)
    expect(allDay(routine('once', { schedule: { days: [1], time: '09:00', once: true } }))).toBe(false)
    expect(allDay(routine('hook', { trigger: { kind: 'webhook', token: 't' }, schedule: { days: WEEKDAYS, time: '09:00', times: hourly } }))).toBe(false)
  })

  it('splits the week: one-time runs in the grid, several-a-day in the strip, a deleted routine’s run in the grid', () => {
    const gone: Occ = { key: 'x', name: 'Apagada', agentId: 'a1', at: at(16, 10), conversationId: 'c1', status: 'done' }
    const occs = [run(vigia, at(16, 9), 'done'), run(briefing, at(16, 8, 30), 'done'), upcoming(vigia, at(16, 14)), gone]
    const { grid, strip } = splitWeek(occs)
    expect(grid.map((o) => o.key)).toEqual([occs[1]!.key, 'x'])
    expect(strip).toHaveLength(2)
  })

  it('makes one chip a day per routine, a tick per run in order, and opens on the day’s failure', () => {
    const discord = routine('discord', { schedule: { days: WEEKDAYS, time: '10:00', times: ['10:00', '12:00', '14:00', '16:00'] } })
    const occs = [upcoming(vigia, at(16, 14)), run(vigia, at(16, 11), 'failed'), run(vigia, at(16, 9), 'done'), run(vigia, at(16, 10), 'done'), run(discord, at(16, 10), 'done'), upcoming(vigia, at(17, 9))]
    const chips = stripDay(occs, at(16))
    expect(chips.map((c) => c.routine.id)).toEqual(['vigia', 'discord'])
    expect(chips[0]!.ticks.map(markOf)).toEqual(['ok', 'ok', 'bad', 'todo'])
    expect(chipOcc(chips[0]!).at).toBe(at(16, 11))
    expect(chipOcc(chips[1]!).at).toBe(at(16, 10))
    expect(stripDay(occs, at(17))[0]!.ticks).toHaveLength(1)
    expect(chipOcc(stripDay(occs, at(17))[0]!).upcoming).toBe(true)
  })

  it('marks a run: waiting on me amber, running live, stopped as off', () => {
    expect(markOf({ status: 'waiting_approval' })).toBe('wait')
    expect(markOf({ status: 'waiting_input' })).toBe('wait')
    expect(markOf({ status: 'limit_reached' })).toBe('bad')
    expect(markOf({ status: 'working' })).toBe('live')
    expect(markOf({ status: 'stopped' })).toBe('off')
    expect(markOf({ upcoming: true })).toBe('todo')
  })
})

describe('the list', () => {
  const now = at(16, 13, 30)

  it('puts what waits on me and what failed in the last day on top, the rest by next run, the ones off apart', () => {
    const vigia = routine('Vigia', { schedule: { days: WEEKDAYS, time: '09:00', times: hourly }, nextAt: at(16, 14) })
    const post = routine('Post', { schedule: { days: WEEKDAYS, time: '11:00' }, nextAt: at(17, 11) })
    const briefing = routine('Briefing', { schedule: { days: WEEKDAYS, time: '08:30' }, nextAt: at(17, 8, 30) })
    const hook = routine('Clientes', { trigger: { kind: 'webhook', token: 't' } })
    const discord = routine('Discord', { schedule: { days: WEEKDAYS, time: '10:00', times: ['10:00', '12:00', '14:00'] }, nextAt: at(16, 14) })
    const old = routine('Velha', { nextAt: at(17, 9) })
    const off = routine('Desligada', { enabled: false })
    const done = routine('Feita', { enabled: false, schedule: { days: [1], time: '09:00', once: true }, lastAt: at(16, 9) })
    const runs = [
      run(vigia, at(16, 11), 'failed'),
      run(vigia, at(16, 12), 'done'),
      run(vigia, at(16, 13), 'done'),
      run(post, at(16, 11), 'waiting_approval'),
      run(briefing, at(16, 8, 30), 'done', 'Três coisas pra hoje'),
      run(old, at(14, 9), 'failed'), // two days ago: no longer on top
      run(old, at(15, 9), 'done'),
      run(off, at(16, 9), 'failed') // off: nothing to fix now
    ]
    const s = listSections([vigia, post, briefing, hook, discord, old, off, done], runs, now)
    expect(s.needs.map((n) => [n.routine.name, n.kind])).toEqual([
      ['Post', 'waiting'],
      ['Vigia', 'failed']
    ])
    expect(s.needs[1]!.occ.at).toBe(at(16, 11))
    expect(s.needs[1]!.okSince).toBe(2)
    expect(s.next.map((u) => u.routine.name)).toEqual(['Discord', 'Briefing', 'Velha', 'Clientes'])
    expect(s.next.find((u) => u.routine.name === 'Briefing')!.last?.reply?.text).toBe('Três coisas pra hoje')
    expect(s.next.at(-1)!.next).toBeUndefined()
    expect(s.off.map((r) => r.name)).toEqual(['Desligada', 'Feita'])
  })

  it('works out the next run of one the core hasn’t scheduled yet', () => {
    const r = routine('Nova', { schedule: { days: [2], time: '10:00' } })
    expect(listSections([r], [], now).next[0]!.next).toBe(at(17, 10))
  })

  it('takes a waiting run off the top once it’s answered', () => {
    const post = routine('Post', { nextAt: at(17, 11) })
    expect(listSections([post], [run(post, at(16, 11), 'done')], now).needs).toEqual([])
  })

  it('shows the first line of a reply, without Markdown', () => {
    expect(firstLine('\n## **Três** coisas pra `hoje`\n- o PR')).toBe('Três coisas pra hoje')
    expect(firstLine('Veja [o PR](https://x.y/1).')).toBe('Veja o PR.')
  })
})

describe('words', () => {
  it('says a schedule in a few words', () => {
    expect(scheduleWords({ days: WEEKDAYS, time: '08:30' })).toBe('seg a sex, 08:30')
    expect(scheduleWords({ days: [1], time: '09:00' })).toBe('segunda, 09:00')
    expect(scheduleWords({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:30' })).toBe('todo dia, 08:30')
    expect(scheduleWords({ days: [1, 3, 5], time: '09:00' })).toBe('seg, qua e sex, 09:00')
    expect(scheduleWords({ days: WEEKDAYS, time: '09:00', times: hourly })).toBe('seg a sex, de hora em hora, 9h–17h')
    expect(scheduleWords({ days: [0, 1, 2, 3, 4, 5, 6], time: '10:00', times: ['10:00', '12:00', '14:00', '16:00'] })).toBe('de 2 em 2 horas, 10h–16h')
    expect(scheduleWords({ days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', times: ['09:00', '09:30', '10:00'] })).toBe('de 30 em 30 min, 9h–10h')
    expect(scheduleWords({ days: WEEKDAYS, time: '09:00', times: ['09:00', '18:00'] })).toBe('seg a sex, 09:00 e 18:00')
    expect(scheduleWords({ days: [], time: '09:00', monthDay: 5 })).toBe('todo dia 5, 09:00')
    expect(scheduleWords({ days: [2], time: '09:00', once: true, date: '2026-11-17' })).toBe('uma vez, 17 nov, 09:00')
    expect(scheduleWords({ days: [0, 1, 2, 3, 4, 5, 6], time: '09:00', once: true })).toBe('uma vez, 09:00')
  })

  it('says what a trigger watches', () => {
    expect(routineWords({ schedule: { days: [], time: '' }, trigger: { kind: 'webhook', token: 't' } })).toBe('quando chamada neste computador')
    const poll = { kind: 'poll' as const, connectorId: 'g', tool: 'search', args: {}, everyMinutes: 5 }
    expect(routineWords({ schedule: { days: [], time: '' }, trigger: poll }, 'Gmail')).toBe('quando chega um e-mail')
    expect(routineWords({ schedule: { days: [], time: '' }, trigger: poll }, 'Linear')).toBe('quando aparece algo novo em Linear')
  })

  it('says when it runs next and when it failed', () => {
    const now = at(16, 13, 30)
    expect(nextWords(at(16, 14), now)).toBe('hoje, 14:00')
    expect(nextWords(at(17, 8, 30), now)).toBe('amanhã, 08:30')
    expect(nextWords(at(19, 15), now)).toBe('qui, 15:00')
    expect(nextWords(at(23, 9), now)).toBe('seg 23, 09:00')
    expect(failedWords(at(16, 11), now)).toBe('falhou às 11:00')
    expect(failedWords(at(15, 11), now)).toBe('falhou ontem às 11:00')
  })

  it('speaks English too', () => {
    setLang('en')
    expect(scheduleWords({ days: WEEKDAYS, time: '09:00', times: hourly })).toBe('Mon–Fri, every hour, 9:00–17:00')
    expect(scheduleWords({ days: [1], time: '09:00' })).toBe('Mondays, 09:00')
    expect(nextWords(at(17, 8, 30), at(16, 13))).toBe('tomorrow, 08:30')
  })
})
