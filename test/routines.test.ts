import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { describeSchedule, nextRun, type Agent, type EngineId, type Routine, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { LATE_GRACE_MS, MAX_AGENT_ROUTINES, outcome, Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const WEEKDAYS = [1, 2, 3, 4, 5]

describe('schedule', () => {
  it('finds the next matching day and time, in local time', () => {
    const s = { days: WEEKDAYS, time: '09:00' }
    expect(nextRun(s, at(2026, 10, 16, 8, 0))).toBe(at(2026, 10, 16, 9, 0)) // Friday, before 9
    expect(nextRun(s, at(2026, 10, 16, 9, 0))).toBe(at(2026, 10, 19, 9, 0)) // exactly at 9 → Monday
    expect(nextRun({ days: [0], time: '23:30' }, at(2026, 10, 17, 12))).toBe(at(2026, 10, 18, 23, 30))
    expect(nextRun({ days: [], time: '09:00' }, Date.now())).toBeUndefined()
    expect(nextRun({ days: [1], time: '25:00' }, Date.now())).toBeUndefined()
  })

  it('says when it runs in plain words', () => {
    expect(describeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: '08:30' })).toBe('Todo dia às 8:30')
    expect(describeSchedule({ days: WEEKDAYS, time: '09:00' })).toBe('Seg a sex às 9h')
    expect(describeSchedule({ days: [5], time: '17:00' })).toBe('Toda sexta às 17h')
    expect(describeSchedule({ days: [1, 3, 5], time: '07:15' })).toBe('Seg, qua e sex às 7:15')
    expect(describeSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: '13:15', once: true })).toBe('Uma vez, às 13:15')
    expect(describeSchedule({ days: [5], time: '17:00', once: true })).toBe('Uma vez, sexta às 17h')
  })
})

describe('routines', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, 'opencode-v2': ready, pi: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
    id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, ...extra
  })

  let db: Db
  let gateway: Gateway
  let turns: Turn[]
  let runner: Runner
  let routines: Routines
  let clock: number
  let notes: { title: string; body: string; conversationId: string }[]

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-routines-')), 'test.db'))
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1'] })
    turns = []
    notes = []
    clock = at(2026, 10, 19, 8, 0) // a Monday
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), 'opencode-v2': fakeEngine('opencode-v2'), pi: fakeEngine('pi') }
    const emit = (_: CoreEvent): void => {}
    gateway = new Gateway()
    await gateway.start()
    routines = new Routines({
      db,
      runner: { runRoutine: (r, when) => runner.runRoutine(r, when) },
      emit,
      now: () => clock,
      notify: (title, body, conversationId) => notes.push({ title, body, conversationId })
    })
    runner = new Runner({ db, engines, settings: async () => settings, emit, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, routines })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  const settle = async (): Promise<void> => {
    await routines.idle()
    await runner.idle()
  }
  const create = (extra: Partial<Routine> = {}): Routine =>
    routines.save({ name: 'Bom dia', agentId: 'a1', conversationId: 'c1', prompt: 'Resume o que está aberto no Linear.', schedule: { days: WEEKDAYS, time: '09:00' }, enabled: true, ...extra })
  const posted = (conv = 'c1') => db.messages().filter((m) => m.conversationId === conv)

  it('runs at its time: posts the request, the agent answers, and I get notified', async () => {
    const r = create()
    expect(r.nextAt).toBe(at(2026, 10, 19, 9, 0))

    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0)

    clock = at(2026, 10, 19, 9, 0) + 10_000
    routines.tick()
    await settle()
    const [ask, reply] = posted()
    expect(ask).toMatchObject({ author: { kind: 'routine', id: r.id }, text: 'Resume o que está aberto no Linear.', routine: { name: 'Bom dia', late: false } })
    expect(reply).toMatchObject({ author: { kind: 'agent', id: 'a1' }, run: { status: 'done' } })

    const turn = turns.at(-1)!
    expect(turn.prompt).toContain('[Rotina "Bom dia", agendada por Edu')
    expect(turn.prompt).toContain('Esta é a rotina "Bom dia" (seg a sex às 9h)')
    expect(turn.prompt).toContain('pode não estar olhando')

    const saved = db.routine(r.id)!
    expect(saved.lastMessageId).toBe(reply!.id)
    expect(saved.nextAt).toBe(at(2026, 10, 20, 9, 0))
    expect(notes).toEqual([{ title: 'Lia · Bom dia', body: expect.stringContaining('Resposta de teste') as string, conversationId: 'c1' }])

    routines.tick() // nothing new is due
    await settle()
    expect(posted()).toHaveLength(2)
  })

  it('a run missed while the app was closed runs once, as late; one missed for too long is skipped', async () => {
    const r = create()
    clock = at(2026, 10, 19, 9, 40)
    routines.tick()
    routines.tick()
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    expect(posted()[0]!.routine).toMatchObject({ late: true, scheduledAt: at(2026, 10, 19, 9, 0) })
    expect(turns.at(-1)!.prompt).toContain('Era pra ter rodado às 09:00')

    clock = at(2026, 10, 20, 9, 0) + LATE_GRACE_MS + 60_000 // Tuesday's run, missed by more than the grace
    routines.tick()
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    expect(db.routine(r.id)!.nextAt).toBe(at(2026, 10, 21, 9, 0))
  })

  it("waits while the Mac sleeps, even through its short maintenance wakes, and runs late on a real wake", async () => {
    create()
    routines.setAwake(false) // went to sleep at 8:50
    clock = at(2026, 10, 19, 9, 20) // a DarkWake: timers run for a few seconds
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0)
    routines.setAwake(true) // opened the lid at 9:20
    await settle()
    expect(posted().find((m) => m.author.kind === 'routine')?.routine).toMatchObject({ late: true })
  })

  it('off means off, and turning it back on schedules from now', async () => {
    const r = create({ enabled: false })
    expect(r.nextAt).toBeUndefined()
    clock = at(2026, 10, 20, 12, 0)
    routines.tick()
    await settle()
    expect(posted()).toHaveLength(0)
    expect(routines.save({ ...r, enabled: true }).nextAt).toBe(at(2026, 10, 21, 9, 0))
  })

  it('one run at a time per routine', async () => {
    const r = create()
    routines.runNow(r.id)
    routines.runNow(r.id)
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
    routines.runNow(r.id)
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(2)
  })

  it('an agent past its limit does not open the CLI, and the notification says so', async () => {
    db.saveAgent(agent('a1', 'lia', { limit: 0 }))
    const r = create()
    routines.runNow(r.id)
    await settle()
    expect(turns).toHaveLength(0)
    expect(posted().at(-1)!.run?.status).toBe('limit_reached')
    expect(notes[0]!.body).toBe('Parou: chegou no limite de tokens do mês.')
  })

  it('posts only where the agent is: its DM or one of its channels', () => {
    expect(() => create({ agentId: 'a2' })).toThrow(/participa/)
    expect(() => create({ conversationId: 'd1', agentId: 'a2' })).toThrow(/participa/)
    expect(() => create({ schedule: { days: [], time: '09:00' } })).toThrow(/dia/)
    expect(create({ conversationId: 'd1' }).conversationId).toBe('d1')
  })

  it('the notification is the start of the reply, in plain text', () => {
    const base = { id: 'm', conversationId: 'c1', author: { kind: 'agent' as const, id: 'a1' }, at: 0 }
    expect(outcome({ ...base, text: '## Resumo\n\n**3 issues** vencidas: [ENG-1](https://x.y/1)', run: { status: 'done', steps: [] } })).toBe('Resumo 3 issues vencidas: ENG-1')
    expect(outcome({ ...base, text: '', run: { status: 'waiting_approval', steps: [] } })).toBe('Pediu aprovação pra continuar.')
  })

  it('a one-off routine runs once and turns itself off', async () => {
    const r = create({ schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:30', once: true } })
    clock = at(2026, 10, 19, 9, 30) + 5_000
    routines.tick()
    await settle()
    expect(db.routine(r.id)).toMatchObject({ enabled: false, nextAt: undefined })
    clock = at(2026, 10, 20, 9, 30) + 5_000
    routines.tick()
    await settle()
    expect(posted().filter((m) => m.author.kind === 'routine')).toHaveLength(1)
  })

  it('an agent schedules a routine for itself when asked, and it runs on its own', async () => {
    await runner.send('d1', 'agende `Teste` às 09:30 uma vez: diga oi')
    await runner.idle()
    const reply = posted('d1').find((m) => m.author.kind === 'agent')!
    const [r] = db.routines()
    expect(r).toMatchObject({ name: 'Teste', agentId: 'a1', conversationId: 'd1', prompt: 'diga oi', createdBy: 'a1', schedule: { once: true }, nextAt: at(2026, 10, 19, 9, 30) })
    expect(reply.run?.routineIds).toEqual([r!.id])
    expect(reply.run?.steps.map((s) => s.label)).toContain('Agendou rotina')
    expect(reply.text).toContain('Próxima vez: seg, 19/10')

    clock = at(2026, 10, 19, 9, 30) + 5_000
    routines.tick()
    await settle()
    expect(posted('d1').filter((m) => m.author.kind === 'routine').map((m) => m.text)).toEqual(['diga oi'])
    expect(db.routine(r!.id)!.enabled).toBe(false)

    await runner.send('d1', 'oi de novo') // its next turn sees the time and only its active routines
    await runner.idle()
    expect(turns.at(-1)!.prompt).toMatch(/\[Edu · (dom|seg|ter|qua|qui|sex|sáb) \d\d\/\d\d \d\d:\d\d\]\noi de novo$/) // the time, with the weekday, in each message
    expect(turns.at(-1)!.system).not.toContain('## Suas rotinas')
  })

  it("an agent only touches its own routines, and only up to a limit", () => {
    const lia = db.agent('a1')!
    const theo = db.agent('a2')!
    const dm = db.conversation('d1')!
    const ask = { nome: 'x', pedido: 'y', horario: '9:00' }
    const mine = routines.schedule(lia, dm, ask)
    expect(mine.routine?.schedule).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' })
    expect(routines.schedule(theo, dm, { ...ask, substitui: mine.routine!.id }).error).toBe(true)
    expect(routines.cancel(theo, mine.routine!.id).error).toBe(true)
    expect(routines.schedule(lia, dm, { ...ask, dias: ['sex', 'sábado'], substitui: mine.routine!.id }).routine?.schedule.days).toEqual([5, 6])
    for (let i = 1; i < MAX_AGENT_ROUTINES; i++) routines.schedule(lia, dm, ask)
    expect(routines.schedule(lia, dm, ask)).toMatchObject({ error: true, reply: expect.stringContaining('Cancele') as string })
    expect(routines.cancel(lia, mine.routine!.id).reply).toContain('apagada')
    expect(db.routines()).toHaveLength(MAX_AGENT_ROUTINES - 1)
  })
})

describe('quiet hours', () => {
  it('cross midnight when they should', async () => {
    const { inQuietHours } = await import('../src/shared/types')
    const at = (h: number, m = 0): Date => new Date(2026, 9, 19, h, m)
    expect(inQuietHours({ from: '22:00', to: '07:00' }, at(23))).toBe(true)
    expect(inQuietHours({ from: '22:00', to: '07:00' }, at(6, 59))).toBe(true)
    expect(inQuietHours({ from: '22:00', to: '07:00' }, at(7))).toBe(false)
    expect(inQuietHours({ from: '12:00', to: '13:00' }, at(12, 30))).toBe(true)
    expect(inQuietHours(undefined, at(3))).toBe(false)
  })
})
