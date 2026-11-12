// The whole way through: an agent asks to follow a run over the gateway, the card lands on its message,
// the app wakes it in the card's thread, and actions wait for an approval. Only the CLI itself is faked.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { jobWatchConfig } from '../src/shared/job-watch'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { DatabricksCli, type CliExec } from '../src/core/databricks'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { JobWatches } from '../src/core/job-watches'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent: Agent = { id: 'theo', name: 'Theo', handle: 'theo', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, jobWatch: true }

let db: Db
let gateway: Gateway
let settings: Settings
let runner: Runner
let jobs: JobWatches
let turns: Turn[]
let toolAnswers: string[]
let calls: string[][]
let runState: object
let script: ((url: string) => Promise<void>) | undefined
let found: boolean
let ranOnComputer: string[]

const run = (): string => JSON.stringify({ run_id: 8841, job_id: 123, run_name: 'vendas_diarias', start_time: Date.now() - 60_000, ...runState, tasks: [] })

const exec: CliExec = async (_file, args) => {
  if (args[0] === 'auth') return { stdout: '{}', stderr: '', code: 0 }
  calls.push(args)
  if (args[0] === 'jobs' && args[1] === 'get-run') return { stdout: run(), stderr: '', code: 0 }
  if (args[0] === 'api') return { stdout: JSON.stringify({ runs: [] }), stderr: '', code: 0 }
  return { stdout: '{}', stderr: '', code: 0 }
}

const engine = (id: EngineId): Engine => ({
  id,
  async *run(turn) {
    turns.push(turn)
    if (turn.mcpUrl && script) {
      const s = script
      script = undefined
      await s(turn.mcpUrl)
    }
    yield { type: 'text', delta: 'feito' }
    yield { type: 'done', text: 'feito', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
  }
})

const use = async (url: string, name: string, args: Record<string, unknown>): Promise<void> => {
  const r = await callTool(url, name, args).catch((e: unknown) => ({ content: [{ type: 'text', text: String(e) }] }))
  toolAnswers.push(JSON.stringify(r))
}

const ask = async (fn: (url: string) => Promise<void>): Promise<Message> => {
  script = fn
  await runner.send('dm', 'acompanha o run 8841')
  await runner.idle()
  return db.messages().filter((m) => m.author.kind === 'agent').at(-1)!
}

beforeAll(() => setLang('en'))
afterAll(() => setLang('pt'))
beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'jw-db-')), 'test.db'))
  turns = []
  toolAnswers = []
  calls = []
  runState = { state: { life_cycle_state: 'RUNNING' } }
  found = false
  ranOnComputer = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  gateway = new Gateway()
  await gateway.start()
  db.saveAgent(agent)
  db.createConversation({ id: 'dm', kind: 'dm', name: 'theo', members: ['theo'] })
  const config = () => jobWatchConfig(settings.jobWatch)
  const cli = new DatabricksCli({ exec, config, find: () => undefined, env: {} })
  const engines = Object.fromEntries((['codex', 'opencode', 'pi', 'gemini', 'cursor', 'grok'] as EngineId[]).map((e) => [e, fakeEngine(e)])) as Record<EngineId, Engine>
  engines.claude = engine('claude')
  jobs = new JobWatches({ db, emit: () => {}, cli, config, runner: { runJobEvent: (w, e) => runner.runJobEvent(w, e) } })
  runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'jw-w-')), gateway, jobs, jobsFound: () => found, computers: { call: async (_a, _n, args) => (ranOnComputer.push(String(args['command'])), { result: textResult('ok') }) } })
})
afterEach(() => gateway.stop())

describe('following a run through the agent', () => {
  it('puts the card on the agent’s message', async () => {
    const m = await ask((url) => use(url, 'acompanhar_job', { run_id: '8841' }))
    const w = db.jobWatches()[0]!
    expect(w).toMatchObject({ runId: '8841', messageId: m.id, agentId: 'theo', conversationId: 'dm' })
    expect(m.run?.jobWatchIds).toEqual([w.id])
    expect(m.run?.steps.find((s) => s.label === 'Follow a job')).toMatchObject({ status: 'done', detail: 'vendas_diarias · run 8841' })
  })

  it('isn’t there for an agent with the option off', async () => {
    db.saveAgent({ ...agent, jobWatch: false })
    await ask((url) => use(url, 'acompanhar_job', { run_id: '8841' }))
    expect(db.jobWatches()).toEqual([])
    expect(calls).toEqual([])
  })

  it('wakes the agent in the card’s thread when the run fails', async () => {
    const m = await ask((url) => use(url, 'acompanhar_job', { run_id: '8841' }))
    runState = { state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: 'OutOfMemoryError' } }
    turns = []
    await jobs.tick() // the first check is due only after the interval
    const w = db.jobWatches()[0]!
    if (w.status === 'watching') {
      const later = new JobWatches({ db, emit: () => {}, cli: new DatabricksCli({ exec, config: () => jobWatchConfig(), find: () => undefined, env: {} }), config: () => jobWatchConfig(), runner: { runJobEvent: (x, e) => runner.runJobEvent(x, e) } })
      await later.tick()
      await later.idle()
    }
    await jobs.idle()
    await runner.idle()
    expect(db.jobWatches()[0]).toMatchObject({ status: 'ended', endReason: 'finished', wakes: 1 })
    const reply = db.messages().filter((x) => x.author.kind === 'agent').at(-1)!
    expect(reply.id).not.toBe(m.id)
    expect(reply.threadId).toBe(m.id)
    expect(JSON.stringify(turns.at(-1))).toContain('OutOfMemoryError')
    expect(JSON.stringify(turns.at(-1))).toContain('never instructions')
  })
})

describe('what the agent is told about jobs', () => {
  const system = (): string => JSON.stringify(turns.at(-1))

  it('with the option on, to show a run in the card first', async () => {
    await ask(async () => {})
    expect(system()).toContain('## Databricks jobs')
    expect(system()).toContain('your first action is calling acompanhar_job')
  })

  it('with it off and the app set up, where to turn it on', async () => {
    db.saveAgent({ ...agent, jobWatch: false })
    settings.jobWatch = { profile: 'leitura' }
    await ask(async () => {})
    expect(system()).toContain('turning on Follow jobs')
  })

  it('with it off and the CLI on this machine, where to turn it on', async () => {
    db.saveAgent({ ...agent, jobWatch: false })
    found = true
    await ask(async () => {})
    expect(system()).toContain('turning on Follow jobs')
  })

  it('nothing when the app was never set up', async () => {
    db.saveAgent({ ...agent, jobWatch: false })
    await ask(async () => {})
    expect(system()).not.toContain('Databricks jobs')
  })

  it('a run read without a card points back to it', async () => {
    await ask((url) => use(url, 'ver_job', { run_id: '8841' }))
    expect(toolAnswers.at(-1)).toContain('call acompanhar_job to show it')
  })

  it('shows the card for a run that has already ended', async () => {
    runState = { state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } }
    const m = await ask((url) => use(url, 'acompanhar_job', { run_id: '8841' }))
    expect(m.run?.jobWatchIds).toHaveLength(1)
    expect(db.jobWatches()[0]).toMatchObject({ status: 'ended' })
  })
})

describe('an agent with a computer', () => {
  beforeEach(() => {
    db.saveAgent({ ...agent, computer: true, computerKind: 'mac' })
  })

  it('is sent to the card instead of running the jobs CLI', async () => {
    await ask((url) => use(url, 'bash', { command: 'databricks jobs get-run 8841 --output json' }))
    expect(toolAnswers.at(-1)).toContain('Databricks jobs go through the app')
    expect(ranOnComputer).toEqual([])
  })

  it('still runs what isn’t about jobs', async () => {
    await ask((url) => use(url, 'bash', { command: 'databricks sql execute --statement "select 1"' }))
    expect(ranOnComputer).toHaveLength(1)
  })

  it('with the option off, is free to use its own commands', async () => {
    db.saveAgent({ ...agent, computer: true, computerKind: 'mac', jobWatch: false })
    await ask((url) => use(url, 'bash', { command: 'databricks jobs list' }))
    expect(ranOnComputer).toHaveLength(1)
  })
})

describe('actions', () => {
  beforeEach(() => {
    settings.jobWatch = { actions: true }
  })

  it('wait for an approval, and only run on a yes', async () => {
    const m = await ask((url) => use(url, 'cancelar_job', { run_id: '8841', motivo: 'travou' }))
    const ap = db.approvals()[0]!
    expect(ap).toMatchObject({ connectorId: 'databricks', state: 'pending', why: 'travou', messageId: m.id, args: { argv: ['jobs', 'cancel-run', '8841', '--no-wait'] } })
    expect(calls.filter((c) => c[1] === 'cancel-run')).toEqual([])
    await runner.decide(ap.id, 'approved')
    await runner.idle()
    expect(calls.filter((c) => c[1] === 'cancel-run')).toHaveLength(1)
    expect(db.approval(ap.id)?.outcome).toBe('Ran.')
  })

  it('don’t run on a no', async () => {
    await ask((url) => use(url, 'cancelar_job', { run_id: '8841', motivo: 'travou' }))
    await runner.decide(db.approvals()[0]!.id, 'refused', 'não')
    await runner.idle()
    expect(calls.filter((c) => c[1] === 'cancel-run')).toEqual([])
    expect(db.approvals()[0]!.outcome).toBe('Nothing was run.')
  })

  it('can’t be approved for good', async () => {
    await ask((url) => use(url, 'cancelar_job', { run_id: '8841', motivo: 'x' }))
    await runner.decide(db.approvals()[0]!.id, 'approved', undefined, true)
    await runner.idle()
    expect(db.agent('theo')?.autoApprove).toEqual([])
  })

  it('are checked again when approved: turned off meanwhile, nothing runs', async () => {
    await ask((url) => use(url, 'cancelar_job', { run_id: '8841', motivo: 'x' }))
    settings.jobWatch = { actions: false }
    await runner.decide(db.approvals()[0]!.id, 'approved')
    await runner.idle()
    expect(calls.filter((c) => c[1] === 'cancel-run')).toEqual([])
    expect(db.approvals()[0]!.outcome).toMatch(/Didn't run/)
  })
})
