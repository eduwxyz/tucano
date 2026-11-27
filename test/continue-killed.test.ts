// A reply the app cut with work behind it is worth more than a restart of the same work: it goes on
// in a new reply that carries what it already read, wrote and ran in its task. A reply that never
// got a tool call back has nothing to go on with, and is only ever tried again.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Run, Settings, Step } from '../src/shared/types'
import { setLang } from '../src/shared/lang'
import { canContinue, workedOn } from '../src/shared/run-progress'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false
})

let db: Db
let settings: Settings
let gateway: Gateway
let turns: Turn[]
let clock = 1_000
const step = (label: string, status: Step['status'], detail?: string): Step => ({ id: `s${clock++}`, label, status, ...(detail ? { detail } : {}) })

function put(conversationId: string, author: Message['author'], text: string, run?: Run, threadId?: string): Message {
  const m: Message = { id: `m${clock++}`, conversationId, author, text, at: clock, ...(run ? { run } : {}), ...(threadId ? { threadId } : {}) }
  db.saveMessage(m)
  return m
}

function runner(): Runner {
  const base = fakeEngine('claude', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = {
    claude: {
      id: 'claude',
      async *run(t) {
        turns.push(t)
        yield* base.run(t)
      }
    },
    codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'),
    antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'),
    cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint')
  }
  const workDir = mkdtempSync(join(tmpdir(), 'ad-cut-'))
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir, gateway })
}

const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')

beforeEach(async () => {
  setLang('en') // the wording of the proceed message is read, so the test pins the language
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  settings = {
    workspaceName: 'Edu', context: '',
    engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready },
    routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1_000_000, approvalTtlHours: 24,
    theme: 'system', language: 'en'
  }
  db.saveAgent(agent('a1', 'lia'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('what a cut reply has to go on with', () => {
  it('is work once a step came back, and nothing while all it did was think', () => {
    const thought = step('Thought', 'done')
    const read = step('Read src/core/runs.ts', 'done', 'src/core/runs.ts')
    const base: Run = { status: 'interrupted', steps: [thought] }
    expect(workedOn(base)).toBe(false)
    expect(canContinue(base)).toBe(false)
    expect(canContinue({ ...base, steps: [thought, read] })).toBe(true)
    // A call that failed is still news the next reply needs.
    expect(canContinue({ ...base, steps: [thought, step('Ran npm test', 'error', 'exit 1')] })).toBe(true)
    // A step still running is not finished work.
    expect(canContinue({ ...base, steps: [thought, step('Read src/core/runs.ts', 'running')] })).toBe(false)
    // A reply paused at its budget always has somewhere to go on from.
    expect(canContinue({ status: 'paused', steps: [thought] })).toBe(true)
    // One that finished its own way is not continued: it was never cut.
    expect(canContinue({ status: 'done', steps: [thought, read] })).toBe(false)
  })
})

describe('continuing a reply the app cut', () => {
  it('goes on in a new reply, which carries the steps it already took', async () => {
    const prompt = put('d1', { kind: 'person', id: db.ownerId() }, 'conserte o teste que falha')
    const cut = put(
      'd1',
      { kind: 'agent', id: 'a1' },
      'Vou olhar o teste.',
      {
        status: 'interrupted',
        task: 'conserte o teste que falha',
        depth: 1,
        steps: [step('Thought', 'done'), step('Read test/runs.test.ts', 'done', 'test/runs.test.ts'), step('Ran npx vitest run', 'error', 'exit 1')]
      },
      prompt.id
    )
    const r = runner()
    await r.continue(cut.id)
    await r.idle()

    // The reply that was cut is answered, not offered: no button comes back to it.
    expect(db.message(cut.id)?.run?.status).toBe('done')
    const made = replies().filter((m) => m.id !== cut.id)
    expect(made).toHaveLength(1)
    // It goes on in the same thread the cut reply was in, so the session is one conversation.
    expect(made[0]!.threadId).toBe(prompt.id)
    // What the model is actually given is the proceed message.
    const sent = turns.map((t) => t.prompt).join('\n\n')
    expect(sent).toContain('conserte o teste que falha') // what it was asked
    expect(sent).toContain('when the app closed') // how it was cut
    expect(sent).toContain('Read test/runs.test.ts') // what it read
    expect(sent).toContain('Ran npx vitest run: exit 1 (failed)') // what failed
    expect(sent).toContain("Pick up where you left off, without redoing what's already done")
  })

  it('is not offered on a reply killed before any tool call came back', async () => {
    const prompt = put('d1', { kind: 'person', id: db.ownerId() }, 'faça o relatório')
    const cut = put('d1', { kind: 'agent', id: 'a1' }, '', { status: 'failed', task: 'faça o relatório', steps: [step('Thought', 'done')] }, prompt.id)
    const r = runner()
    await r.continue(cut.id)
    await r.idle()
    expect(replies().filter((m) => m.id !== cut.id)).toHaveLength(0)
    expect(db.message(cut.id)?.run?.status).toBe('failed') // still waiting on "Try again"
  })

  it('says the failure differently from the app closing, and from a stop', async () => {
    const said: Record<string, string> = {}
    for (const status of ['failed', 'stopped', 'interrupted'] as const) {
      turns.length = 0
      const prompt = put('d1', { kind: 'person', id: db.ownerId() }, `pedido ${status}`)
      const cut = put('d1', { kind: 'agent', id: 'a1' }, '', {
        status,
        task: `pedido ${status}`,
        steps: [step('Thought', 'done'), step('Read a.ts', 'done', 'a.ts')]
      }, prompt.id)
      const r = runner()
      await r.continue(cut.id)
      await r.idle()
      said[status] = turns.map((t) => t.prompt).join('\n\n')
    }
    expect(said.failed).toContain('by a failure')
    expect(said.stopped).toContain('when it was stopped')
    expect(said.interrupted).toContain('when the app closed')
  })
})

// The join between the two halves: what startup does to a run the app died under, and whether the rule
// the button reads then offers to go on. The same pair is driven end to end, with the app killed for
// real, by scripts/e2e-kill-restart.mjs.
describe('a run the app died under, read at the next startup', () => {
  it('comes back interrupted with its steps kept, and goes on when a tool call had come back', () => {
    const prompt = put('d1', { kind: 'person', id: db.ownerId() }, 'guarde e procure a preferência do time')
    const cut = put(
      'd1',
      { kind: 'agent', id: 'a1' },
      'Vou guardar.',
      {
        status: 'working',
        task: 'guarde e procure a preferência do time',
        depth: 1,
        steps: [step('Thought', 'done'), step('Saved to memory', 'done'), step('Thinking', 'running')]
      },
      prompt.id
    )
    expect(db.interruptStaleRuns()).toHaveLength(1)
    const after = db.message(cut.id)!
    expect(after.run?.status).toBe('interrupted')
    // The step that was running when the process died is not finished work, and says so.
    expect(after.run?.steps?.at(-1)).toMatchObject({ label: 'Thinking', status: 'error' })
    expect(canContinue(after.run!)).toBe(true)
  })

  it('goes on by itself once the app is back, and starts over one that had nothing done', async () => {
    clock = Date.now() - 10_000 // cut just now, not long ago
    const asked = put('d1', { kind: 'person', id: db.ownerId() }, 'guarde e procure a preferência do time')
    const cut = put('d1', { kind: 'agent', id: 'a1' }, 'Vou guardar.', { status: 'working', task: asked.text, depth: 1, steps: [step('Thought', 'done'), step('Saved to memory', 'done'), step('Thinking', 'running')] }, asked.id)
    const other = put('d1', { kind: 'person', id: db.ownerId() }, 'faça o relatório')
    const bare = put('d1', { kind: 'agent', id: 'a1' }, '', { status: 'working', task: other.text, depth: 1, steps: [step('Thinking', 'running')] }, other.id)
    const ids = db.interruptStaleRuns()
    const r = runner()
    r.resumeInterrupted(ids)
    await new Promise((res) => setTimeout(res, 20))
    await r.idle()
    // The one with work goes on in a new reply, told why; the reply that was cut says it went on.
    expect(db.message(cut.id)?.run?.status).toBe('done')
    expect(db.message(cut.id)?.run?.steps.at(-1)?.label).toBe('Went on by itself')
    expect(turns.some((t) => t.prompt.includes('because the app closed in the middle of it, and it goes on by itself now'))).toBe(true)
    // The one with nothing done runs again in place.
    expect(db.message(bare.id)?.run?.status).toBe('done')
  })

  it('leaves it to the person when that is turned off, waits while everything is paused, and goes on however old it is', async () => {
    clock = Date.now() - 10_000
    const asked = put('d1', { kind: 'person', id: db.ownerId() }, 'guarde a preferência')
    const run: Run = { status: 'working', task: asked.text, depth: 1, steps: [step('Saved to memory', 'done')] }
    const cut = put('d1', { kind: 'agent', id: 'a1' }, 'Vou guardar.', run, asked.id)
    const ids = db.interruptStaleRuns()

    settings = { ...settings, autoContinue: false }
    const off = runner()
    off.resumeInterrupted(ids)
    await new Promise((res) => setTimeout(res, 20))
    await off.idle()
    expect(db.message(cut.id)?.run?.status).toBe('interrupted')
    expect(turns).toHaveLength(0)

    settings = { ...settings, autoContinue: true }
    const r = runner()
    r.setPaused(true)
    r.resumeInterrupted(ids)
    await new Promise((res) => setTimeout(res, 20))
    expect(turns).toHaveLength(0)
    r.setPaused(false)
    await new Promise((res) => setTimeout(res, 20))
    await r.idle()
    expect(db.message(cut.id)?.run?.status).toBe('done')

    // Cut over half a day ago: it goes on too, however long it was, reading first what changed since.
    clock = Date.now() - 13 * 3_600_000
    const old = put('d1', { kind: 'agent', id: 'a1' }, 'Antigo.', { ...run, status: 'interrupted' }, asked.id)
    const resumed = () => turns.filter((t) => t.prompt.includes('because the app closed in the middle of it')).length
    const before = resumed()
    r.resumeInterrupted([old.id])
    await new Promise((res) => setTimeout(res, 20))
    await r.idle()
    expect(resumed()).toBe(before + 1)
    expect(turns.at(-1)!.prompt).toContain('read what was written here since')
    expect(db.message(old.id)?.run?.status).toBe('done')
  })

  it('and one that had only thought has nothing to go on with', () => {
    const prompt = put('d1', { kind: 'person', id: db.ownerId() }, 'pergunte em 30 s')
    const cut = put('d1', { kind: 'agent', id: 'a1' }, '', { status: 'working', task: 'pergunte em 30 s', depth: 1, steps: [step('Thinking', 'running')] }, prompt.id)
    expect(db.interruptStaleRuns()).toHaveLength(1)
    expect(db.message(cut.id)?.run?.status).toBe('interrupted')
    expect(canContinue(db.message(cut.id)!.run!)).toBe(false)
  })
})
