import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Routine, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string): Agent => ({ id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })

describe('the queue', () => {
  let db: Db
  let started: Turn[]
  let release: () => void
  let runner: Runner

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'qp-db-')), 'test.db'))
    started = []
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    release = open
    const base = fakeEngine('claude', { delayMs: 1 })
    // Routine turns hold until released; everything else answers right away.
    const claude: Engine = {
      ...base,
      async *run(t) {
        started.push(t)
        if (t.prompt.includes('rotina lenta')) await gate
        yield* base.run(t)
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'qp-work-')) })
    for (let i = 0; i < 6; i++) {
      db.saveAgent(agent(`r${i}`, `rot${i}`))
      db.createConversation({ id: `d-r${i}`, kind: 'dm', name: `r${i}`, members: [`r${i}`] })
    }
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  })

  const routine = (i: number): Routine => ({ id: `rt${i}`, name: `R${i}`, agentId: `r${i}`, conversationId: `d-r${i}`, prompt: 'rotina lenta', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 })

  it("doesn't keep a reply to the person waiting behind routines that fill every slot", async () => {
    const runs = [0, 1, 2, 3, 4, 5].map((i) => runner.runRoutine(routine(i), { scheduledAt: 1, late: false }))
    await expect.poll(() => started.length).toBe(4) // the usual limit: two routines wait
    await runner.send('d1', 'oi, tá aí?')
    await expect.poll(() => db.messages().find((m) => m.author.kind === 'agent' && m.author.id === 'a1')?.run?.status).toBe('done')
    expect(started.filter((t) => t.prompt.includes('rotina lenta'))).toHaveLength(4) // the waiting routines still wait
    release()
    await Promise.all(runs)
    await runner.idle()
    expect(started.filter((t) => t.prompt.includes('rotina lenta'))).toHaveLength(6)
  })
})
