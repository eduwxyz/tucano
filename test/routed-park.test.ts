import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Followups, replyKey } from '../src/core/followups'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra
})

let db: Db
let settings: Settings
let gateway: Gateway
let turns: string[]

// The router picks theo (Dados) for a question about numbers; the engine records every turn so a
// reply that never happened is easy to tell from one that did.
function runner(codexDelayMs = 1): Runner {
  const engines: Record<EngineId, Engine> = {
    claude: fakeEngine('claude', { delayMs: 1 }),
    codex: {
      id: 'codex',
      async *run(t) {
        turns.push(t.model)
        yield* fakeEngine('codex', { delayMs: codexDelayMs }).run(t)
      }
    },
    opencode: fakeEngine('opencode'),
    pi: fakeEngine('pi'),
    antigravity: fakeEngine('antigravity'),
    cursor: fakeEngine('cursor'),
    grok: fakeEngine('grok'),
    cline: fakeEngine('cline')
  }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway })
}

const replies = (): Message[] => db.messages().filter((m) => m.author.kind === 'agent')
const place = (key: string, f: Followups): void => f.reserve(key) // a job was queued for the place and never ran

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('a1', 'lia', { role: 'Engenharia' }))
  db.saveAgent(agent('a2', 'theo', { role: 'Dados', modelId: 'gpt-5.6-luna' }))
  db.createConversation({ id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] })
  gateway = new Gateway()
})

afterEach(async () => {
  await gateway.stop()
})

describe('a routed reply waiting for its place', () => {
  it('goes when the place was taken for a job that never started, instead of waiting for good', async () => {
    const r = runner()
    // A hand-off took theo's place here and the job it queued never ran: nothing is running on
    // that key, and nothing ever will be, so no end can come to start the routed reply.
    place(replyKey('a2', 'c1'), (r as unknown as { followups: Followups }).followups)

    await r.send('c1', 'qual foi a receita da semana?')
    await new Promise((ok) => setTimeout(ok, 2600))
    await r.idle()

    expect(db.messages().find((m) => m.author.kind === 'system')!.text).toContain('Chamei **theo**')
    expect(replies().map((m) => (m.author as { id: string }).id)).toEqual(['a2'])
    expect(replies()[0]!.run!.status).toBe('done')
  })

  it('waits for the reply that really holds the place, and answers once when the place is free', async () => {
    const r = runner(1)
    const f = (r as unknown as { followups: Followups }).followups
    f.start(replyKey('a2', 'c1')) // theo is replying here right now

    await r.send('c1', 'qual foi a receita da semana?')
    await new Promise((ok) => setTimeout(ok, 300))
    expect(replies()).toHaveLength(0) // a reply is on it: parked, not run

    f.end(replyKey('a2', 'c1'))
    await new Promise((ok) => setTimeout(ok, 2600)) // the next look
    await r.idle()
    expect(replies().map((m) => (m.author as { id: string }).id)).toEqual(['a2'])
  })

  it('is answered by the mention that comes instead of it, and never answers the same thing twice', async () => {
    const r = runner()
    const f = (r as unknown as { followups: Followups }).followups
    f.start(replyKey('a2', 'c1')) // theo is replying here right now

    await r.send('c1', 'qual foi a receita da semana?') // routed to theo, which is busy here: parked
    await new Promise((ok) => setTimeout(ok, 300)) // the router reads the thread before it calls anyone
    expect(db.messages().some((m) => m.author.kind === 'system' && m.text.includes('Chamei'))).toBe(true)
    expect(replies()).toHaveLength(0)

    await r.send('c1', '@theo e a de ontem?') // the person asks it by hand, before the place frees
    await new Promise((ok) => setTimeout(ok, 300))
    f.end(replyKey('a2', 'c1')) // the reply that held the place ends
    await new Promise((ok) => setTimeout(ok, 2600)) // past the look: nothing else must start
    await r.idle()

    const from = replies().filter((m) => (m.author as { id: string }).id === 'a2')
    expect(from).toHaveLength(1) // the mention: the routed one was answered in its stead
    expect(from[0]!.run!.status).toBe('done')
  })
})
