// The board's to-dos (Quadro): each person's own list, and starting one posts it to its agent.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import { isTeam, MAX_AGENT_SUGGESTIONS, type Agent, type Conversation, type EngineId, type Message, type Person, type Routine, type Schedule, type Settings, type Task } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Routines } from '../src/core/routines'
import { Runner } from '../src/core/runs'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bia: Client // a member
let lia: string // an agent's id
type Snap = { agents: { id: string; handle: string }[]; conversations: Conversation[]; messages: Message[] }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const until = async (ok: () => Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  lia = (await ana.call<Snap>('snapshot')).agents.find((a) => a.handle === 'lia')!.id
  const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
  const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
  bia = core.connect(r.data.person!.id)
}, 30_000)
afterAll(() => {
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
})

describe('the board’s to-dos', () => {
  it('a new one goes on top; edits keep what they leave out; text is trimmed and capped', async () => {
    const a = await ana.call<Task>('saveTask', { task: { title: '  Revisar   o contrato ' } })
    const b = await ana.call<Task>('saveTask', { task: { title: 'Levantar os clientes', agentId: lia, notes: 'dos últimos 30 dias' } })
    expect(a.title).toBe('Revisar o contrato')
    expect((await ana.call<Task[]>('tasks')).map((t) => t.id)).toEqual([b.id, a.id])
    const edited = await ana.call<Task>('saveTask', { task: { id: b.id, title: 'Levantar os clientes parados' } })
    expect(edited).toMatchObject({ agentId: lia, notes: 'dos últimos 30 dias', position: b.position })
    expect((await ana.call<Task>('saveTask', { task: { id: b.id, title: edited.title, agentId: '' } })).agentId).toBeUndefined()
    expect((await ana.call<Task>('saveTask', { task: { title: 'x'.repeat(1000) } })).title).toHaveLength(300)
    expect(await err(ana.call('saveTask', { task: { title: '   ' } }))).toMatch(/Escreva|Write/)
  })

  it('moving one sets its place', async () => {
    const [first, second] = await ana.call<Task[]>('tasks')
    await ana.call('saveTask', { task: { id: first!.id, title: first!.title, position: second!.position + 1 } })
    expect((await ana.call<Task[]>('tasks'))[0]!.id).toBe(second!.id)
  })

  it("each sees only their own, and can't change or start someone else's", async () => {
    const mine = (await ana.call<Task[]>('tasks'))[0]!
    expect(await bia.call<Task[]>('tasks')).toEqual([])
    expect(await err(bia.call('saveTask', { task: { id: mine.id, title: 'da Bia' } }))).toMatch(/não existe|no longer/)
    expect(await err(bia.call('startTask', { id: mine.id }))).toMatch(/não existe|no longer/)
    await bia.call('removeTask', { id: mine.id })
    expect((await ana.call<Task[]>('tasks')).some((t) => t.id === mine.id)).toBe(true)
  })

  it('a channel only when the agent is in it', async () => {
    const snap = await ana.call<Snap>('snapshot')
    const dm = snap.conversations.find((c) => c.kind === 'dm')
    if (dm) expect(await err(ana.call('saveTask', { task: { title: 'na DM', conversationId: dm.id } }))).toMatch(/canal|channel/)
    const other = snap.conversations.find((c) => c.kind === 'channel' && !c.members.includes(lia))
    if (other) expect(await err(ana.call('saveTask', { task: { title: 'fora', agentId: lia, conversationId: other.id } }))).toMatch(/não está|isn’t/)
  })

  it('starting needs an agent; then it posts as my message in its DM and leaves the list', async () => {
    const t = await ana.call<Task>('saveTask', { task: { title: 'Escrever o post 4242', notes: 'Tom leve.' } })
    expect(await err(ana.call('startTask', { id: t.id }))).toMatch(/quem faz|who does/)
    await ana.call('saveTask', { task: { id: t.id, title: t.title, agentId: lia } })
    const { conversationId } = await ana.call<{ conversationId: string }>('startTask', { id: t.id })
    expect((await ana.call<Task[]>('tasks')).some((x) => x.id === t.id)).toBe(false)
    await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.conversationId === conversationId && m.author.kind === 'person' && m.text === 'Escrever o post 4242\n\nTom leve.'))
    const conv = (await ana.call<Snap>('snapshot')).conversations.find((c) => c.id === conversationId)!
    expect(conv).toMatchObject({ kind: 'dm', name: lia })
    expect(await bia.call<Snap>('snapshot').then((s) => s.messages.some((m) => m.text.includes('4242')))).toBe(false)
  })

  it('removing one', async () => {
    const t = await ana.call<Task>('saveTask', { task: { title: 'Apagar' } })
    await ana.call('removeTask', { id: t.id })
    expect((await ana.call<Task[]>('tasks')).some((x) => x.id === t.id)).toBe(false)
  })
})

const WEEKDAYS: Schedule = { days: [1, 2, 3, 4, 5], time: '09:00' }
const DAY = 86_400_000

// What a person can do with a task on their own, what an agent suggests, and a routine that repeats one,
// through the real core. A second connection to its database plants what only an agent's tool makes
// (a suggestion) and reads what the API doesn't return (the routine behind a task).
describe('the board’s tasks: states, suggestions, repeating', () => {
  let raw: Db
  let other: string // another agent's id
  beforeAll(async () => {
    raw = new Db(join(core.dataDir, 'tucano.db'))
    other = raw.agents().find((a) => isTeam(a) && a.id !== lia)!.id
  })
  afterAll(() => raw.close())
  const suggestion = (title: string): Task => {
    const t: Task = { id: `sug-${title}`, owner: raw.ownerId(), title, position: 100, createdAt: Date.now(), agentId: lia, suggestedBy: lia, fromRoutine: 'Revisão semanal' }
    raw.saveTask(t)
    return t
  }
  const mk = (title: string, extra: Record<string, unknown> = {}): Promise<Task> => ana.call<Task>('saveTask', { task: { title, agentId: lia, ...extra } })

  it('one’s own task moves by hand: doing, done (with its time), back to do; nothing else is forged', async () => {
    const t = await mk('Ligar pro contador', { agentId: '' })
    expect(t.state).toBeUndefined()
    expect((await ana.call<Task>('saveTask', { task: { id: t.id, title: t.title, state: 'doing' } })).state).toBe('doing')
    const done = await ana.call<Task>('saveTask', { task: { id: t.id, title: t.title, state: 'done' } })
    expect(done.state).toBe('done')
    expect(Math.abs(done.doneAt! - Date.now())).toBeLessThan(10_000)
    await new Promise((r) => setTimeout(r, 5))
    const again = await ana.call<Task>('saveTask', { task: { id: t.id, title: 'Ligar pro contador hoje', state: 'done' } }) // still done: its time stays
    expect(again).toMatchObject({ state: 'done', doneAt: done.doneAt, title: 'Ligar pro contador hoje' })
    expect(await ana.call<Task>('saveTask', { task: { id: t.id, title: again.title } })).toMatchObject({ state: 'done', doneAt: done.doneAt }) // not moved: kept
    const back = await ana.call<Task>('saveTask', { task: { id: t.id, title: again.title, state: 'todo' } })
    expect(back.state).toBeUndefined()
    expect(back.doneAt).toBeUndefined()
    // What marks a task as an agent's or a routine's is never taken from the caller.
    const forged = await ana.call<Task>('saveTask', { task: { title: 'Forjada', state: 'done', result: 'x', suggestedBy: lia, routineId: 'r1', fromRoutine: 'y' } as never })
    expect(forged).toMatchObject({ state: 'done' })
    expect([forged.result, forged.suggestedBy, forged.routineId, forged.fromRoutine]).toEqual([undefined, undefined, undefined, undefined])
  })

  it('an invalid state is refused, and so is moving a task that isn’t mine', async () => {
    const t = await mk('Estado ruim', { agentId: '' })
    expect(await err(ana.call('saveTask', { task: { id: t.id, title: t.title, state: 'finished' } as never }))).toMatch(/inválido|Invalid/)
    expect((await ana.call<Task[]>('tasks')).find((x) => x.id === t.id)!.state).toBeUndefined()
    expect(await err(bia.call('saveTask', { task: { id: t.id, title: t.title, state: 'done' } }))).toMatch(/não existe|no longer/)
  })

  it('marking done clears done tasks older than 30 days', async () => {
    const old = { id: 'old-done', owner: raw.ownerId(), title: 'Antiga', position: 1, createdAt: Date.now() - 40 * DAY, state: 'done' as const, doneAt: Date.now() - 31 * DAY }
    const recent = { ...old, id: 'recent-done', title: 'Recente', doneAt: Date.now() - 2 * DAY }
    raw.saveTask(old)
    raw.saveTask(recent)
    const t = await mk('Gatilho da limpeza', { agentId: '' })
    await ana.call('saveTask', { task: { id: t.id, title: t.title, state: 'done' } })
    const ids = (await ana.call<Task[]>('tasks')).map((x) => x.id)
    expect(ids).not.toContain('old-done')
    expect(ids).toContain('recent-done')
  })

  it('a suggestion waits: it can’t be moved, started or repeated until accepted; accepting puts it on top', async () => {
    const s = suggestion('Rever o contrato novo')
    expect(await err(ana.call('saveTask', { task: { id: s.id, title: s.title, state: 'doing' } }))).toMatch(/Aceite|Accept/)
    expect(await err(ana.call('startTask', { id: s.id }))).toMatch(/Aceite|Accept/)
    expect(await err(ana.call('repeatTask', { id: s.id, schedule: WEEKDAYS }))).toMatch(/Aceite|Accept/)
    expect(await err(bia.call('acceptTask', { id: s.id }))).toMatch(/não existe|no longer/)
    const kept = await ana.call<Task>('saveTask', { task: { id: s.id, title: 'Rever o contrato novo (edit)' } }) // editing the text is fine; it stays a suggestion
    expect(kept).toMatchObject({ suggestedBy: lia, fromRoutine: 'Revisão semanal' })
    const accepted = await ana.call<Task>('acceptTask', { id: s.id })
    expect(accepted.suggestedBy).toBeUndefined()
    expect(accepted.fromRoutine).toBe('Revisão semanal')
    const list = await ana.call<Task[]>('tasks')
    expect(list[0]!.id).toBe(s.id)
    expect(await ana.call<Task>('acceptTask', { id: s.id })).toEqual(accepted) // not a suggestion any more: unchanged
  })

  it('a suggestion can be dismissed with removeTask, and only by its person', async () => {
    const s = suggestion('Descartar isto')
    await bia.call('removeTask', { id: s.id })
    expect(raw.task(s.id)).toBeDefined()
    await ana.call('removeTask', { id: s.id })
    expect(raw.task(s.id)).toBeUndefined()
  })

  it('repeating makes a routine that works on the task; null puts the task back', async () => {
    const t = await mk('Acompanhar o caixa', { notes: 'toda semana' })
    const rep = await ana.call<Task>('repeatTask', { id: t.id, schedule: WEEKDAYS })
    expect(rep).toMatchObject({ state: 'doing', routineId: expect.any(String) })
    const dm = (await ana.call<Snap>('snapshot')).conversations.find((c) => c.kind === 'dm' && c.name === lia)!
    expect(raw.routine(rep.routineId!)).toMatchObject({ taskId: t.id, name: 'Acompanhar o caixa', prompt: 'Acompanhar o caixa\n\ntoda semana', agentId: lia, conversationId: dm.id, enabled: true, schedule: WEEKDAYS })
    expect(raw.routines().filter((r) => r.taskId === t.id)).toHaveLength(1)
    const again = await ana.call<Task>('repeatTask', { id: t.id, schedule: { days: [1], time: '10:30' } }) // changes the same routine
    expect(again.routineId).toBe(rep.routineId)
    expect(raw.routine(rep.routineId!)!.schedule).toMatchObject({ days: [1], time: '10:30' })
    const undone = await ana.call<Task>('repeatTask', { id: t.id, schedule: null })
    expect(undone.routineId).toBeUndefined()
    expect(undone.state).toBeUndefined()
    expect(raw.routine(rep.routineId!)).toBeUndefined()
  })

  it('clearing the repeat of a done task with no routine leaves it done', async () => {
    const t = await mk('Entregar o relatório')
    const done = await ana.call<Task>('saveTask', { task: { id: t.id, title: t.title, state: 'done' } })
    const kept = await ana.call<Task>('repeatTask', { id: t.id, schedule: null })
    expect(kept).toMatchObject({ state: 'done', doneAt: done.doneAt })
    expect(raw.routines().filter((r) => r.taskId === t.id)).toHaveLength(0)
  })

  it('a task repeats only until it is done: a one-off schedule is saved as a repeating one', async () => {
    const t = await mk('Pagar a conta de luz')
    const rep = await ana.call<Task>('repeatTask', { id: t.id, schedule: { ...WEEKDAYS, once: true } })
    expect(rep.routineId).toBeDefined()
    expect('once' in raw.routine(rep.routineId!)!.schedule).toBe(false)
    expect(raw.routine(rep.routineId!)!.schedule).toMatchObject(WEEKDAYS)
    await ana.call('repeatTask', { id: t.id, schedule: null })
  })

  it('a task with a routine: not started, not moved to another agent, edits go to the routine, only "done" moves it', async () => {
    const t = await mk('Vigiar os pedidos')
    const rep = await ana.call<Task>('repeatTask', { id: t.id, schedule: WEEKDAYS })
    expect(await err(ana.call('startTask', { id: t.id }))).toMatch(/rotina|routine/)
    expect(await err(ana.call('saveTask', { task: { id: t.id, title: t.title, agentId: other } }))).toMatch(/Pare de repetir|Stop repeating/)
    expect(await err(ana.call('saveTask', { task: { id: t.id, title: t.title, state: 'todo' } }))).toMatch(/Pare de repetir|Stop repeating/)
    await ana.call('saveTask', { task: { id: t.id, title: 'Vigiar os pedidos novos', notes: 'só os urgentes' } })
    expect(raw.routine(rep.routineId!)).toMatchObject({ name: 'Vigiar os pedidos novos', prompt: 'Vigiar os pedidos novos\n\nsó os urgentes' })
    const done = await ana.call<Task>('saveTask', { task: { id: t.id, title: 'Vigiar os pedidos novos', state: 'done' } })
    expect(done).toMatchObject({ state: 'done' })
    expect(done.routineId).toBeUndefined()
    expect(raw.routine(rep.routineId!)).toBeUndefined() // the routine ends with the task
  })

  it('deleting the task takes its routine; deleting the routine puts the task back', async () => {
    const a = await ana.call<Task>('repeatTask', { id: (await mk('Apagar a tarefa')).id, schedule: WEEKDAYS })
    await ana.call('removeTask', { id: a.id })
    expect(raw.routine(a.routineId!)).toBeUndefined()
    const b = await ana.call<Task>('repeatTask', { id: (await mk('Apagar a rotina')).id, schedule: WEEKDAYS })
    const mark = ana.events.length
    await ana.call('removeRoutine', { id: b.routineId! })
    const back = (await ana.call<Task[]>('tasks')).find((x) => x.id === b.id)!
    expect(back.routineId).toBeUndefined()
    expect(back.state).toBeUndefined()
    expect(ana.events.slice(mark).some((e) => e.type === 'tasks')).toBe(true)
    // a conversation deleted with its routines: the same
    const c = await ana.call<Task>('repeatTask', { id: (await mk('Apagar a conversa')).id, schedule: WEEKDAYS })
    await ana.call('deleteConversation', { id: raw.routine(c.routineId!)!.conversationId })
    expect(raw.routine(c.routineId!)).toBeUndefined()
    expect((await ana.call<Task[]>('tasks')).find((x) => x.id === c.id)).toMatchObject({ title: 'Apagar a conversa' })
    expect(raw.task(c.id)!.routineId).toBeUndefined()
  })

  it('repeating says what is wrong in plain words, and changes nothing', async () => {
    const noAgent = await mk('Sem quem faça', { agentId: '' })
    expect(await err(ana.call('repeatTask', { id: noAgent.id, schedule: WEEKDAYS }))).toMatch(/quem faz|who does/)
    const t = await mk('Horário ruim')
    expect(await err(ana.call('repeatTask', { id: t.id, schedule: { days: 'x', time: 5 } as never }))).toMatch(/dia|day/)
    expect(await err(ana.call('repeatTask', { id: t.id, schedule: { days: [1], time: '25:99' } }))).toMatch(/Horário|time/)
    expect(await err(bia.call('repeatTask', { id: t.id, schedule: WEEKDAYS }))).toMatch(/não existe|no longer/)
    expect(raw.task(t.id)).toMatchObject({ title: 'Horário ruim' })
    expect(raw.task(t.id)!.routineId).toBeUndefined()
    expect(raw.routines().some((r) => r.taskId === t.id)).toBe(false)
  })

  it('a routine can’t be given a task through saveRoutine', async () => {
    const dm = await ana.call<string>('openDm', { agentId: lia })
    const made = await ana.call<Routine>('saveRoutine', { routine: { name: 'Forjada', agentId: lia, conversationId: dm, prompt: 'p', schedule: WEEKDAYS, enabled: true, taskId: 'whatever' } as never })
    expect(made.taskId).toBeUndefined()
    expect(raw.routine(made.id)!.taskId).toBeUndefined()
    await ana.call('removeRoutine', { id: made.id })
  })
})

// The agent's side: its tools, with a real runner and gateway. The engine below makes the calls the next turn is
// told to (a queue), then answers like the fake one.
describe('the board’s tasks: sugerir_tarefa and concluir_tarefa', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false })
  type Call = { name: string; args: Record<string, unknown> }
  type Result = { isError?: boolean; content: { text: string }[] }

  let db: Db
  let gateway: Gateway
  let runner: Runner
  let routines: Routines
  let todo: Call[]
  let results: Result[]
  let turns: Turn[]
  let events: CoreEvent[]
  let owner: string

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-board-')), 'test.db'))
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    owner = db.ownerId()
    todo = []
    results = []
    turns = []
    events = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = {
      id: 'claude',
      async *run(t) {
        turns.push(t)
        if (t.mcpUrl) for (const c of todo.splice(0)) results.push((await callTool(t.mcpUrl, c.name, c.args)) as Result)
        yield* base.run(t)
      }
    }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }
    const emit = (e: CoreEvent): void => void events.push(e)
    gateway = new Gateway()
    await gateway.start()
    routines = new Routines({ db, runner: { runRoutine: (r, when) => runner.runRoutine(r, when) }, emit })
    runner = new Runner({ db, engines, settings: async () => settings, emit, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, routines })
  })
  afterEach(async () => {
    await gateway.stop()
  })

  const ask = async (...calls: Call[]): Promise<void> => {
    todo.push(...calls)
    await runner.send('d1', 'oi')
    await runner.idle()
  }
  const suggest = (titulo: string, extra: Record<string, unknown> = {}): Call => ({ name: 'sugerir_tarefa', args: { titulo, ...extra } })
  const open = (): Task[] => db.tasks(owner)

  it('an agent suggests a task: saved for the person with who suggested it, told not to start it', async () => {
    await ask(suggest('  Revisar   o contrato ', { detalhes: 'o de março' }))
    expect(open()).toHaveLength(1)
    expect(open()[0]).toMatchObject({ title: 'Revisar o contrato', notes: 'o de março', suggestedBy: 'a1', agentId: 'a1', owner })
    expect(open()[0]!.fromRoutine).toBeUndefined()
    expect(results[0]!.isError).toBeFalsy()
    expect(results[0]!.content[0]!.text).toMatch(/não comece/)
    expect(events).toContainEqual({ type: 'tasks', for: owner })
    const reply = db.messages().find((m) => m.author.kind === 'agent')!
    expect(reply.run?.steps.map((s) => s.label)).toContain('Sugeriu tarefa')
  })

  it('it can pick another agent by handle or name; an unknown one lists who can be picked', async () => {
    await ask(suggest('Uma', { para: '@theo' }), suggest('Duas', { para: 'Theo' }), suggest('Três', { para: 'ninguém' }))
    expect(open().filter((t) => t.agentId === 'a2').map((t) => t.title).sort()).toEqual(['Duas', 'Uma'])
    expect(open().every((t) => t.suggestedBy === 'a1')).toBe(true)
    expect(results[2]!.isError).toBe(true)
    expect(results[2]!.content[0]!.text).toContain('@theo')
    expect(open().some((t) => t.title === 'Três')).toBe(false)
  })

  it('a title already there (case and accents aside), open or pending, is not made again, and is no error', async () => {
    db.saveTask({ id: 't1', owner, title: 'Cotação do pão', position: 0, createdAt: 1 })
    db.saveTask({ id: 't2', owner, title: 'Feita antes', position: 1, createdAt: 1, state: 'done', doneAt: 5 })
    await ask(suggest('cotacao DO PAO'), suggest('Nova ideia'), suggest('nova  ideia'), suggest('feita antes'))
    expect(results.slice(0, 3).map((r) => !!r.isError)).toEqual([false, false, false])
    expect(results[0]!.content[0]!.text).toMatch(/já está lá/)
    expect(results[2]!.content[0]!.text).toMatch(/já está lá/)
    expect(open().map((t) => t.title).sort()).toEqual(['Cotação do pão', 'Feita antes', 'Nova ideia', 'feita antes'].sort()) // a done one doesn't block: it's not open
  })

  it('past the cap of pending suggestions it is told to wait; accepting one frees a place', async () => {
    const titles = Array.from({ length: MAX_AGENT_SUGGESTIONS + 1 }, (_, i) => `Ideia ${i}`)
    await ask(...titles.map((t) => suggest(t)))
    expect(open()).toHaveLength(MAX_AGENT_SUGGESTIONS)
    expect(results.at(-1)!.isError).toBe(true)
    expect(results.at(-1)!.content[0]!.text).toMatch(/Espere/)
    const first = open()[0]!
    db.saveTask({ ...first, suggestedBy: undefined }) // what acceptTask does
    await ask(suggest('Ideia nova depois'))
    expect(open()).toHaveLength(MAX_AGENT_SUGGESTIONS + 1)
    expect(results.at(-1)!.isError).toBeFalsy()
  })

  it('a suggestion made in a routine’s run says which routine', async () => {
    const r = routines.save({ name: 'Revisão semanal', agentId: 'a1', conversationId: 'd1', prompt: 'olhe o que está aberto', schedule: WEEKDAYS, enabled: true })
    todo.push(suggest('Achado na revisão'))
    routines.runNow(r.id)
    await routines.idle()
    await runner.idle()
    expect(open()).toHaveLength(1)
    expect(open()[0]).toMatchObject({ title: 'Achado na revisão', fromRoutine: 'Revisão semanal' })
  })

  it('a routine that works on a task is told so, and ends it with concluir_tarefa: the task is done, the routine gone', async () => {
    const t: Task = { id: 'w1', owner, title: 'Fechar o caixa', position: 0, createdAt: 1, agentId: 'a1', state: 'doing' }
    const r = routines.save({ name: t.title, agentId: 'a1', conversationId: 'd1', prompt: t.title, schedule: WEEKDAYS, enabled: true }, owner, t.id)
    db.saveTask({ ...t, routineId: r.id })
    expect(db.routine(r.id)!.taskId).toBe(t.id)
    todo.push({ name: 'concluir_tarefa', args: { resultado: 'Caixa fechado: 3 pendências.' } }, { name: 'concluir_tarefa', args: { resultado: 'de novo' } })
    routines.runNow(r.id)
    await routines.idle()
    await runner.idle()
    expect(turns.at(-1)!.prompt).toContain('concluir_tarefa') // told what the routine is for
    expect(turns.at(-1)!.prompt).toContain('"Fechar o caixa"')
    expect(db.task('w1')).toMatchObject({ state: 'done', result: 'Caixa fechado: 3 pendências.' })
    expect(db.task('w1')!.routineId).toBeUndefined()
    expect(Math.abs(db.task('w1')!.doneAt! - Date.now())).toBeLessThan(10_000)
    expect(db.routine(r.id)).toBeUndefined() // removed while its own run was still going, and nothing wrote it back
    expect(results[0]!.isError).toBeFalsy()
    expect(results[1]!.isError).toBe(true) // the second call finds no routine behind it any more
    expect(events).toContainEqual(expect.objectContaining({ type: 'routine_removed', id: r.id }))
    expect(events).toContainEqual({ type: 'tasks', for: owner })
    expect(db.tasks(owner)).toHaveLength(1)
  })

  it('the result is capped, and an empty one is refused (the routine stays)', async () => {
    const t: Task = { id: 'w2', owner, title: 'Longa', position: 0, createdAt: 1, agentId: 'a1', state: 'doing' }
    const r = routines.save({ name: t.title, agentId: 'a1', conversationId: 'd1', prompt: t.title, schedule: WEEKDAYS, enabled: true }, owner, t.id)
    db.saveTask({ ...t, routineId: r.id })
    todo.push({ name: 'concluir_tarefa', args: { resultado: '   ' } })
    routines.runNow(r.id)
    await routines.idle()
    await runner.idle()
    expect(results[0]!.isError).toBe(true)
    expect(db.routine(r.id)).toBeDefined()
    expect(db.task('w2')).toMatchObject({ state: 'doing', routineId: r.id })
    todo.push({ name: 'concluir_tarefa', args: { resultado: 'x'.repeat(2000) } })
    routines.runNow(r.id)
    await routines.idle()
    await runner.idle()
    expect(db.task('w2')!.result).toHaveLength(600)
  })

  it('a second concluir_tarefa in the same run is refused and changes nothing', async () => {
    const t: Task = { id: 'w4', owner, title: 'Conferir estoque', position: 0, createdAt: 1, agentId: 'a1', state: 'doing' }
    const r = routines.save({ name: t.title, agentId: 'a1', conversationId: 'd1', prompt: t.title, schedule: WEEKDAYS, enabled: true }, owner, t.id)
    db.saveTask({ ...t, routineId: r.id })
    todo.push({ name: 'concluir_tarefa', args: { resultado: 'Estoque conferido.' } }, { name: 'concluir_tarefa', args: { resultado: 'Outra coisa.' } })
    routines.runNow(r.id)
    await routines.idle()
    await runner.idle()
    expect(results[0]!.isError).toBeFalsy()
    expect(results[1]!.isError).toBe(true)
    expect(db.task('w4')).toMatchObject({ state: 'done', result: 'Estoque conferido.' })
    expect(db.task('w4')!.routineId).toBeUndefined()
  })

  it('removing a routine by hand puts its task back, and the task points at nothing', () => {
    const t: Task = { id: 'w3', owner, title: 'Solta', position: 0, createdAt: 1, agentId: 'a1', state: 'doing' }
    const r = routines.save({ name: t.title, agentId: 'a1', conversationId: 'd1', prompt: t.title, schedule: WEEKDAYS, enabled: true }, owner, t.id)
    db.saveTask({ ...t, routineId: r.id })
    routines.remove(r.id)
    expect(db.task('w3')!.routineId).toBeUndefined()
    expect(db.task('w3')!.state).toBeUndefined()
    expect(events).toContainEqual({ type: 'tasks', for: owner })
    expect(db.releaseOrphanTasks()).toEqual([]) // nothing left to put back
  })
})
