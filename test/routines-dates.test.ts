// A routine on a date ("on the 17th at 9am", once, even weeks ahead) and on a day of every month
// ("on the 5th"): when they run, what's refused, what agents can ask for, and the clock's edges.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { describeSchedule, nextRun, type Agent, type EngineId, type Routine, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { dateArg, LATE_GRACE_MS, Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'
import { proposalFrom } from '../src/core/tuca-help'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const HOUR = 3_600_000

// Runs with the process in another time zone, then puts it back.
const inZone = <T,>(tz: string, fn: () => T): T => {
  const before = process.env['TZ']
  process.env['TZ'] = tz
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env['TZ']
    else process.env['TZ'] = before
  }
}

describe('a schedule on a date or a day of the month', () => {
  it('a date runs at that day and time only, and never after', () => {
    const s = { days: [], time: '09:00', once: true, date: '2026-11-17' }
    expect(nextRun(s, at(2026, 10, 19, 8))).toBe(at(2026, 11, 17, 9))
    expect(nextRun(s, at(2026, 11, 17, 8, 59))).toBe(at(2026, 11, 17, 9))
    expect(nextRun(s, at(2026, 11, 17, 9))).toBeUndefined()
    expect(nextRun({ ...s, date: '2026-02-30' }, at(2026, 1, 1))).toBeUndefined() // no such day
    expect(nextRun({ ...s, date: '17/11/2026' }, at(2026, 1, 1))).toBeUndefined()
  })

  it('a day of the month repeats, on the last day of a shorter month', () => {
    const s = { days: [], time: '08:00', monthDay: 31 }
    expect(nextRun(s, at(2026, 11, 9))).toBe(at(2026, 11, 30, 8))
    expect(nextRun(s, at(2026, 11, 30, 8))).toBe(at(2026, 12, 31, 8))
    expect(nextRun(s, at(2027, 2, 1))).toBe(at(2027, 2, 28, 8))
    expect(nextRun({ ...s, monthDay: 5 }, at(2026, 11, 9))).toBe(at(2026, 12, 5, 8))
    expect(nextRun({ ...s, monthDay: 0 }, at(2026, 11, 9))).toBeUndefined()
  })

  it('says when in plain words', () => {
    const year = new Date().getFullYear()
    expect(describeSchedule({ days: [2], time: '09:00', once: true, date: `${year}-11-17` })).toMatch(/^Uma vez, \S+, 17 de nov às 9h$/)
    expect(describeSchedule({ days: [], time: '09:00', once: true, date: `${year + 1}-01-05` })).toContain(String(year + 1))
    expect(describeSchedule({ days: [], time: '08:30', monthDay: 5 })).toBe('Todo dia 5 do mês às 8:30')
  })

  it('reads an agent’s ISO date, with or without the time or a zone', () => {
    expect(dateArg('2026-11-17')).toEqual({ date: '2026-11-17' })
    expect(dateArg('2026-11-17T09:00')).toEqual({ date: '2026-11-17', time: '09:00' })
    expect(dateArg('2026-11-17 9:05:00')).toEqual({ date: '2026-11-17', time: '09:05' })
    expect(dateArg('2026-11-31')).toBeNull()
    expect(dateArg('17/11')).toBeNull()
    expect(dateArg('2026-11-17T25:00')).toBeNull()
    // A zone is turned into this computer's day and time.
    inZone('America/Sao_Paulo', () => {
      expect(dateArg('2026-11-17T12:00Z')).toEqual({ date: '2026-11-17', time: '09:00' })
      expect(dateArg('2026-11-17T01:00Z')).toEqual({ date: '2026-11-16', time: '22:00' })
      expect(dateArg('2026-11-17T09:00-03:00')).toEqual({ date: '2026-11-17', time: '09:00' })
    })
  })

  it('across a change of daylight saving time, it is still that day at that local time', () => {
    inZone('America/New_York', () => {
      // Clocks went back on 1 Nov 2026: 9:00 on the 2nd is 14:00 UTC, not 13:00.
      expect(nextRun({ days: [], time: '09:00', once: true, date: '2026-11-02' }, Date.UTC(2026, 9, 30, 12))).toBe(Date.UTC(2026, 10, 2, 14))
      // A monthly one keeps its local hour on both sides.
      const first = nextRun({ days: [], time: '09:00', monthDay: 15 }, Date.UTC(2026, 9, 1))!
      const second = nextRun({ days: [], time: '09:00', monthDay: 15 }, first)!
      expect([new Date(first).getHours(), new Date(second).getHours()]).toEqual([9, 9])
      expect(second - first).toBe(31 * 24 * HOUR + HOUR) // October had one more hour
      // 2:30 doesn't exist on 8 Mar 2027 there: it still runs that day.
      const gap = nextRun({ days: [], time: '02:30', once: true, date: '2027-03-08' }, Date.UTC(2027, 0, 1))!
      expect(new Date(gap).getDate()).toBe(8)
    })
  })
})

describe('routines on a date', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false })

  let db: Db
  let gateway: Gateway
  let runner: Runner
  let routines: Routines
  let clock: number
  let quiet: boolean
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-dated-'))
    db = new Db(join(dir, 'test.db'))
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    clock = at(2026, 11, 9, 10) // Monday 9 Nov
    quiet = false
    const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok'] as EngineId[]).map((e) => [e, fakeEngine(e, { delayMs: 1 })])) as Record<EngineId, Engine>
    const emit = (_: CoreEvent): void => {}
    gateway = new Gateway()
    await gateway.start()
    routines = new Routines({ db, runner: { runRoutine: (r, when) => runner.runRoutine(r, when) }, emit, now: () => clock, blocked: () => quiet })
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
    routines.save({ name: 'Lembrete', agentId: 'a1', conversationId: 'd1', prompt: 'Me lembre da reunião.', schedule, enabled: true, ...extra })
  const asks = () => db.messages().filter((m) => m.conversationId === 'd1' && m.author.kind === 'routine')

  it('a date weeks ahead fires on that date only, once, and then turns itself off', async () => {
    const r = create({ days: [], time: '09:00', date: '2026-11-17' })
    expect(r).toMatchObject({ enabled: true, nextAt: at(2026, 11, 17, 9), schedule: { date: '2026-11-17', once: true, days: [2] } })
    // Every 30 min until the 18th, through tomorrow's Tuesday 9:00, which isn't it.
    for (; clock < at(2026, 11, 18, 12); clock += HOUR / 2) {
      routines.tick()
      if (clock === at(2026, 11, 10, 9) + HOUR) expect(asks()).toHaveLength(0) // Tuesday the 10th: nothing
    }
    await settle()
    expect(asks()).toHaveLength(1)
    expect(asks()[0]!.routine).toMatchObject({ scheduledAt: at(2026, 11, 17, 9), late: false })
    expect(db.routine(r.id)).toMatchObject({ enabled: false, nextAt: undefined })
    // Kept as it was, after the app opens again.
    expect(new Db(join(dir, 'test.db')).routine(r.id)!.schedule).toEqual({ days: [2], time: '09:00', once: true, date: '2026-11-17' })
  })

  it('a past date is refused with a clear message; one that ran can still be kept, off', () => {
    expect(() => create({ days: [], time: '09:00', date: '2026-11-09' })).toThrow(/já passou/)
    expect(() => create({ days: [], time: '09:00', date: '2026-11-31' })).toThrow(/Data inválida/)
    expect(create({ days: [], time: '11:00', date: '2026-11-09' }).nextAt).toBe(at(2026, 11, 9, 11)) // later today is fine
    expect(create({ days: [], time: '09:00', date: '2026-11-01' }, { enabled: false }).enabled).toBe(false)
  })

  it('missed while the app was closed: runs late within 12 h, and is skipped (and off) after', async () => {
    const r = create({ days: [], time: '09:00', date: '2026-11-17' })
    clock = at(2026, 11, 17, 11)
    routines.tick()
    await settle()
    expect(asks()[0]!.routine).toMatchObject({ late: true, scheduledAt: at(2026, 11, 17, 9) })

    const s = create({ days: [], time: '09:00', date: '2026-11-20' })
    clock = at(2026, 11, 20, 9) + LATE_GRACE_MS + 60_000
    routines.tick()
    await settle()
    expect(asks()).toHaveLength(1)
    expect(db.routine(s.id)!.enabled).toBe(false)
    expect(db.routine(r.id)!.enabled).toBe(false)
  })

  it('quiet hours hold it, and it runs late when they end', async () => {
    create({ days: [], time: '09:00', date: '2026-11-17' })
    quiet = true
    clock = at(2026, 11, 17, 9, 30)
    routines.tick()
    await settle()
    expect(asks()).toHaveLength(0)
    quiet = false
    clock = at(2026, 11, 17, 10)
    routines.tick()
    await settle()
    expect(asks()[0]!.routine).toMatchObject({ late: true })
  })

  it('every month on a day: runs on the 5th and comes back next month', async () => {
    const r = create({ days: [], time: '08:00', monthDay: 5 })
    expect(r.nextAt).toBe(at(2026, 12, 5, 8))
    clock = at(2026, 12, 5, 8) + 10_000
    routines.tick()
    await settle()
    expect(asks()).toHaveLength(1)
    expect(db.routine(r.id)).toMatchObject({ enabled: true, nextAt: at(2027, 1, 5, 8) })
  })

  it('the agent’s tool takes a date, with the time in it or apart, and refuses one past', () => {
    const lia = db.agent('a1')!
    const dm = db.conversation('d1')!
    const one = routines.schedule(lia, dm, { nome: 'Dia 17', pedido: 'Me lembre.', data: '2026-11-17', horario: '9:00' })
    expect(one.error).toBeFalsy()
    expect(one.routine).toMatchObject({ nextAt: at(2026, 11, 17, 9), schedule: { date: '2026-11-17', once: true } })
    expect(one.reply).toContain('17/11')
    expect(routines.schedule(lia, dm, { nome: 'Dia 17', pedido: 'x', data: '2026-11-17T14:30' }).routine?.nextAt).toBe(at(2026, 11, 17, 14, 30))
    expect(routines.schedule(lia, dm, { nome: 'Todo dia 5', pedido: 'x', horario: '08:00', dia_do_mes: 5 }).routine?.schedule).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:00', monthDay: 5 })
    expect(routines.schedule(lia, dm, { nome: 'x', pedido: 'x', data: '2026-11-01', horario: '09:00' })).toMatchObject({ error: true, reply: expect.stringContaining('já passou') as string })
    expect(routines.schedule(lia, dm, { nome: 'x', pedido: 'x', data: '17/11', horario: '09:00' })).toMatchObject({ error: true, reply: expect.stringContaining('Data inválida') as string })
    expect(routines.schedule(lia, dm, { nome: 'x', pedido: 'x', data: '2026-11-17' })).toMatchObject({ error: true, reply: expect.stringContaining('horario') as string })
  })

  it('an agent asked for the 17th schedules it through its tool, and the instructions say it can', async () => {
    await runner.send('d1', 'agende `Reunião` em 2026-11-17 às 09:00: me lembre da reunião')
    await runner.idle()
    const [r] = db.routines()
    expect(r).toMatchObject({ name: 'Reunião', createdBy: 'a1', schedule: { date: '2026-11-17', once: true }, nextAt: at(2026, 11, 17, 9) })
    const reply = db.messages().find((m) => m.conversationId === 'd1' && m.author.kind === 'agent')!
    expect(reply.text).toContain('Próxima vez: ter, 17/11')
    expect(reply.text).toContain('17 de nov')
    const { AGENDAR } = await import('../src/core/routines')
    expect(AGENDAR.description).toContain('data específica')
    expect(Object.keys((AGENDAR.inputSchema as { properties: object }).properties)).toEqual(expect.arrayContaining(['data', 'dia_do_mes']))
  })

  it('the Tuca proposes a routine on a date or a day of the month', () => {
    const ctx = { agents: [db.agent('a1')!], conversations: [db.conversation('d1')!] } as unknown as Parameters<typeof proposalFrom>[2]
    const later = new Date(Date.now() + 30 * 86_400_000)
    const iso = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, '0')}-${String(later.getDate()).padStart(2, '0')}`
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', data: `${iso}T09:00` }, ctx).proposal).toMatchObject({ routine: { schedule: { date: iso, time: '09:00', once: true } } })
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', hora: '08:00', dia_do_mes: 5 }, ctx).proposal).toMatchObject({ routine: { schedule: { monthDay: 5 } } })
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', data: '2020-01-01', hora: '09:00' }, ctx).error).toContain('já passou')
    expect(proposalFrom('propor_rotina', { agente: 'lia', nome: 'R', pedido: 'p', hora: '09:00' }, ctx).error).toContain('pelo menos um dia')
  })
})
