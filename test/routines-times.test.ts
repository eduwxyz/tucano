// One routine at several times a day ("weekdays at 9am, 1pm and 5pm"), instead of one routine per time:
// when it runs, how it's kept and said, what's refused, and how agents and Tuca ask for it.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { cleanTimes, describeSchedule, MAX_TIMES, nextRun, timesOf, type Agent, type EngineId, type Routine, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'
import { proposalFrom } from '../src/core/tuca-help'
import { tucanoSchedule } from '../src/core/agent-import'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const HOUR = 3_600_000
const WEEKDAYS = [1, 2, 3, 4, 5]

describe('a schedule with several times', () => {
  const s = { days: WEEKDAYS, time: '09:00', times: ['09:00', '13:00', '17:00'] }

  it('runs at the earliest of its times still to come', () => {
    expect(nextRun(s, at(2026, 11, 9, 8))).toBe(at(2026, 11, 9, 9)) // Monday
    expect(nextRun(s, at(2026, 11, 9, 9))).toBe(at(2026, 11, 9, 13))
    expect(nextRun(s, at(2026, 11, 9, 13, 30))).toBe(at(2026, 11, 9, 17))
    expect(nextRun(s, at(2026, 11, 13, 17))).toBe(at(2026, 11, 16, 9)) // Friday's last → Monday's first
    expect(nextRun({ days: [], time: '08:00', times: ['08:00', '20:00'], monthDay: 5 }, at(2026, 11, 5, 9))).toBe(at(2026, 11, 5, 20))
  })

  it('says every time, in order', () => {
    expect(describeSchedule(s)).toBe('Seg a sex às 9h, 13h e 17h')
    expect(describeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:30', times: ['08:30', '18:00'] })).toBe('Todo dia às 8:30 e 18h')
    expect(describeSchedule({ days: [], time: '08:00', times: ['08:00', '20:00'], monthDay: 5 })).toBe('Todo dia 5 do mês às 8h e 20h')
    expect(describeSchedule({ days: WEEKDAYS, time: '09:00' })).toBe('Seg a sex às 9h')
  })

  it('keeps times valid, each once, in order', () => {
    expect(cleanTimes(['17:00', '09:00', '13:00', '09:00', '25:00', ''])).toEqual(['09:00', '13:00', '17:00'])
    expect(timesOf({ time: '09:00' })).toEqual(['09:00'])
    expect(timesOf(s)).toEqual(s.times)
  })
})

describe('routines at several times', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false })

  let db: Db
  let gateway: Gateway
  let runner: Runner
  let routines: Routines
  let clock: number
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-times-'))
    db = new Db(join(dir, 'test.db'))
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    clock = at(2026, 11, 9, 7) // Monday 9 Nov, 7:00
    const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok'] as EngineId[]).map((e) => [e, fakeEngine(e, { delayMs: 1 })])) as Record<EngineId, Engine>
    const emit = (_: CoreEvent): void => {}
    gateway = new Gateway()
    await gateway.start()
    routines = new Routines({ db, runner: { runRoutine: (r, when) => runner.runRoutine(r, when) }, emit, now: () => clock })
    runner = new Runner({ db, engines, settings: async () => settings, emit, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, routines })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const settle = async (): Promise<void> => {
    await routines.idle()
    await runner.idle()
  }
  const create = (schedule: Routine['schedule'], extra: Partial<Routine> = {}): Routine =>
    routines.save({ name: 'Checar pedidos', agentId: 'a1', conversationId: 'd1', prompt: 'Olha os pedidos parados.', schedule, enabled: true, ...extra })
  const asks = () => db.messages().filter((m) => m.conversationId === 'd1' && m.author.kind === 'routine')

  it('one routine runs at each of its times, on its days only', async () => {
    const r = create({ days: WEEKDAYS, time: '13:00', times: ['17:00', '09:00', '13:00'] })
    expect(r.schedule).toEqual({ days: WEEKDAYS, time: '09:00', times: ['09:00', '13:00', '17:00'] })
    expect(r.nextAt).toBe(at(2026, 11, 9, 9))
    const fired: number[] = []
    for (; clock <= at(2026, 11, 15, 23); clock += HOUR / 2) {
      const before = asks().length
      routines.tick()
      await settle()
      if (asks().length > before) fired.push(clock)
    }
    // Monday to Friday, three times each; nothing on the weekend.
    expect(fired).toHaveLength(15)
    expect(fired.slice(0, 3)).toEqual([at(2026, 11, 9, 9), at(2026, 11, 9, 13), at(2026, 11, 9, 17)])
    expect(fired.every((t) => WEEKDAYS.includes(new Date(t).getDay()))).toBe(true)
    expect(db.routines()).toHaveLength(1)
  })

  it('keeps its times across a restart, and goes back to one when they go', () => {
    const r = create({ days: WEEKDAYS, time: '09:00', times: ['09:00', '15:00'] })
    expect(new Db(join(dir, 'test.db')).routine(r.id)!.schedule).toEqual({ days: WEEKDAYS, time: '09:00', times: ['09:00', '15:00'] })
    const one = create({ days: WEEKDAYS, time: '09:00', times: ['09:00'] }, { id: r.id })
    expect(one.schedule).toEqual({ days: WEEKDAYS, time: '09:00' })
    expect(new Db(join(dir, 'test.db')).routine(r.id)!.schedule.times).toBeUndefined()
  })

  it('an older client that sends only the first time keeps the others; a new first time drops them', () => {
    const r = create({ days: WEEKDAYS, time: '09:00', times: ['09:00', '15:00'] })
    // The phone app turning it off sends what it had, with no times.
    expect(create({ days: WEEKDAYS, time: '09:00' }, { id: r.id, enabled: false }).schedule.times).toEqual(['09:00', '15:00'])
    expect(create({ days: WEEKDAYS, time: '10:00' }, { id: r.id }).schedule).toEqual({ days: WEEKDAYS, time: '10:00' })
  })

  it('once, or on a date, runs at the first time only', () => {
    expect(create({ days: WEEKDAYS, time: '09:00', times: ['09:00', '15:00'], once: true }).schedule).toEqual({ days: WEEKDAYS, time: '09:00', once: true })
    expect(create({ days: [], time: '09:00', times: ['09:00', '15:00'], date: '2026-11-17' }).schedule).toEqual({ days: [2], time: '09:00', once: true, date: '2026-11-17' })
  })

  it('refuses a bad time and more than the most a day', () => {
    expect(() => create({ days: WEEKDAYS, time: '09:00', times: ['09:00', '9h'] })).toThrow(/Horário inválido/)
    const many = Array.from({ length: MAX_TIMES + 1 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
    expect(() => create({ days: WEEKDAYS, time: '00:00', times: many })).toThrow(new RegExp(`até ${MAX_TIMES} horários`))
  })

  it('an agent schedules one routine at several times with horarios', () => {
    const lia = db.agent('a1')!
    const dm = db.conversation('d1')!
    const out = routines.schedule(lia, dm, { nome: 'Pedidos', pedido: 'Olha os pedidos.', horarios: ['15:00', '9:00'], dias: ['seg', 'qua'] })
    expect(out.error).toBeFalsy()
    expect(out.routine?.schedule).toEqual({ days: [1, 3], time: '09:00', times: ['09:00', '15:00'] })
    expect(out.reply).toContain('seg e qua às 9h e 15h')
    // With a date, the first only.
    expect(routines.schedule(lia, dm, { nome: 'Dia 17', pedido: 'x', horarios: ['09:00', '15:00'], data: '2026-11-17' }).routine?.schedule).toMatchObject({ time: '09:00', once: true, date: '2026-11-17' })
  })

  it('Tuca proposes one routine at several times with horas', () => {
    const ctx = { agents: [db.agent('a1')!], conversations: [db.conversation('d1')!] } as unknown as Parameters<typeof proposalFrom>[2]
    const p = proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', horas: ['17:00', '09:00'], dias: [1, 2, 3, 4, 5] }, ctx)
    expect(p.proposal).toMatchObject({ routine: { schedule: { days: WEEKDAYS, time: '09:00', times: ['09:00', '17:00'] } } })
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', horas: ['9h'], dias: [1] }, ctx).error).toMatch(/HH:MM/)
  })

  it('a team file brings the times along', () => {
    expect(tucanoSchedule({ days: ['mon', 'fri'], time: '09:00', times: ['09:00', '18:00'] })).toEqual({ days: [1, 5], time: '09:00', times: ['09:00', '18:00'] })
    expect(tucanoSchedule({ days: ['mon'], time: '09:00' })).toEqual({ days: [1], time: '09:00' })
  })
})
