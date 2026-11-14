// Deleting a session whose reply is still at work: the run is dropped, and nothing of it lands
// afterwards — not the words it had already written, not a note that it stopped. What it spent stays
// in the receipts, since the tokens went out either way.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

function agent(id: string, handle: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

describe('a session deleted while its reply is still at work', () => {
  let db: Db
  let settings: Settings
  let heard: string[]

  const runner = (delayMs: number): Runner => {
    const engines = { claude: fakeEngine('claude', { delayMs, reply: () => 'uma resposta bem longa que demora pra chegar inteira' }), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
    return new Runner({
      db,
      engines: engines as Record<EngineId, Engine>,
      settings: async () => settings,
      emit: (e) => void heard.push(e.type),
      workDir: mkdtempSync(join(tmpdir(), 'del-work-'))
    })
  }
  const atWork = (): Message => db.messages().find((m) => m.author.kind === 'agent')!

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'del-db-')), 'test.db'))
    heard = []
    settings = { workspaceName: 'Ana', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'] })
  })

  it('stops the run and never writes it back: the reply stays gone', async () => {
    const r = runner(40)
    void r.send('dm', 'corrige o login')
    await new Promise((res) => setTimeout(res, 120))
    const reply = atWork()
    expect(reply.run?.status).toBe('working')

    r.drop(reply.id) // what deleteMessage does first, for a reply at work
    db.deleteMessage(reply.id)
    await r.idle()

    expect(db.message(reply.id)).toBeUndefined() // nothing of it came back as a half reply
    expect(db.messages().some((m) => m.author.kind === 'agent')).toBe(false)
    expect(db.messages().some((m) => m.author.kind === 'person')).toBe(true) // the prompt it answered stays
  })

  it('keeps what it spent in the receipts', async () => {
    const r = runner(40)
    void r.send('dm', 'corrige o login')
    await new Promise((res) => setTimeout(res, 120))
    const reply = atWork()
    r.drop(reply.id)
    db.deleteMessage(reply.id)
    await r.idle()

    expect(db.receiptTotals(reply.id).tokens).toBeGreaterThan(0) // the tokens went out either way
  })
})
