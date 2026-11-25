import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Account, Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { accountDir } from '../src/core/engines/detect'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'
import { route } from '../src/core/router'

const ready = { installed: true, loggedIn: true }
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

// Claude, whose limit is out on some logins (by their folder; undefined: the usual login) and not on others.
const claudeOutOn = (out: (string | undefined)[]): Engine & { turns: Turn[] } => {
  const turns: Turn[] = []
  const ok = fakeEngine('claude', { delayMs: 1 })
  return {
    id: 'claude',
    turns,
    run: (t) => {
      turns.push(t)
      if (!out.includes(t.account)) return ok.run(t)
      return (async function* (): AsyncIterable<EngineEvent> {
        yield { type: 'error', message: "You've hit your limit · resets 5pm" }
      })()
    }
  }
}

let db: Db
let data: string
let settings: Settings
const work: Account = { id: 'w1', engine: 'claude', name: 'Trabalho', loggedIn: true }
const personal: Account = { id: 'p1', engine: 'claude', name: 'Pessoal', loggedIn: true }

function runner(claude: Engine): Runner {
  const codex = fakeEngine('codex', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude, codex, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity') } as Record<EngineId, Engine>
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'pa-work-')), dataDir: data })
}
const reply = (): Message => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'pa-data-'))
  db = new Db(join(data, 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', accounts: [work, personal] } as unknown as Settings
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('the primary login runs the reply', () => {
  it('is used when the agent has no login of its own', async () => {
    settings = { ...settings, primaryAccounts: { claude: 'p1' } }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'p1')])
  })

  it('moves the same reply to the next login in order when the primary is out, and says so', async () => {
    settings = { ...settings, primaryAccounts: { claude: 'p1' } }
    const claude = claudeOutOn([accountDir(data, 'p1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'p1'), undefined])
    expect(reply().run?.steps.find((s) => s.label === 'Trocou de conta')?.detail).toContain('(Pessoal) está sem limite agora')
  })

  it('keeps the primary out for the next replies, so they start on the next login', async () => {
    settings = { ...settings, primaryAccounts: { claude: 'p1' } }
    const claude = claudeOutOn([accountDir(data, 'p1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'e agora?')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'p1'), undefined, undefined])
  })

  it('is tried once, then the reply fails clearly: no loop over the logins', async () => {
    settings = { ...settings, primaryAccounts: { claude: 'p1' } }
    const claude = claudeOutOn([accountDir(data, 'p1'), undefined, accountDir(data, 'w1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'p1'), undefined, accountDir(data, 'w1')])
  })

  it('does nothing new when no primary is set: the usual login, as before', async () => {
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(claude.turns.map((t) => t.account)).toEqual([undefined])
  })

  it("is not used when the agent has its own login: that one, with no fallback to the rest", async () => {
    settings = { ...settings, primaryAccounts: { claude: 'p1' } }
    db.saveAgent(agent({ accountId: 'w1' }))
    const claude = claudeOutOn([accountDir(data, 'w1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'w1')])
  })
})

describe('the router runs on the login it is given', () => {
  it('passes the login folder to the engine turn', async () => {
    const turns: Turn[] = []
    const engine: Engine = {
      id: 'claude',
      run: (t) => {
        turns.push(t)
        return (async function* (): AsyncIterable<EngineEvent> {
          yield { type: 'done', text: '', usage: undefined } as unknown as EngineEvent
        })()
      }
    }
    await route({ engine, model: 'haiku', messages: [], agents: [agent()], me: 'Edu', cwd: data, account: accountDir(data, 'p1') })
    expect(turns.map((t) => t.account)).toEqual([accountDir(data, 'p1')])
  })
})
