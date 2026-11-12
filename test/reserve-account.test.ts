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
let codexTurns: Turn[]
const work: Account = { id: 'w1', engine: 'claude', name: 'Trabalho', loggedIn: true }
const personal: Account = { id: 'p1', engine: 'claude', name: 'Pessoal', loggedIn: true }

function runner(claude: Engine): Runner {
  codexTurns = []
  const codex = fakeEngine('codex', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude, codex: { id: 'codex', run: (t) => (codexTurns.push(t), codex.run(t)) }, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), dataDir: data })
}
const reply = (): Message => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ad-data-'))
  db = new Db(join(data, 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', accounts: [work, personal] }
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('the reserve on another account', () => {
  it('is kept with the agent, and cleared', () => {
    db.saveAgent(agent({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
    expect(db.agent('a1')).toMatchObject({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' })
    db.saveAgent(agent())
    expect(db.agent('a1')!.fallbackAccountId).toBeUndefined()
  })

  it('takes the reply on the same model, from the usual login to another account', async () => {
    db.saveAgent(agent({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    const m = reply()
    expect(m.run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([undefined, accountDir(data, 'p1')])
    expect(claude.turns[1]!.model).toBe(claude.turns[0]!.model)
    expect(m.run?.steps.find((s) => s.label === 'Foi pro modelo reserva')?.detail).toBe('Claude Code · Sonnet está sem limite agora; segue no Claude Code · Sonnet (Pessoal)')
    expect(codexTurns).toHaveLength(0)
  })

  it('goes from one account to another, and from an account to the usual login', async () => {
    db.saveAgent(agent({ accountId: 'w1', fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
    let claude = claudeOutOn([accountDir(data, 'w1')])
    let r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'w1'), accountDir(data, 'p1')])
    expect(reply().run?.steps.find((s) => s.label === 'Foi pro modelo reserva')?.detail).toContain('(Trabalho) está sem limite')

    db.saveAgent(agent({ accountId: 'w1', fallbackModelId: 'sonnet' }))
    claude = claudeOutOn([accountDir(data, 'w1')])
    r = runner(claude)
    await r.send('d1', 'de novo')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([accountDir(data, 'w1'), undefined])
  })

  it('is tried once: when the reserve account is out too, the reply fails', async () => {
    db.saveAgent(agent({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
    const claude = claudeOutOn([undefined, accountDir(data, 'p1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(claude.turns).toHaveLength(2)
  })

  it('starts on the main account again on the next reply', async () => {
    db.saveAgent(agent({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'e agora?')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([undefined, accountDir(data, 'p1'), undefined, accountDir(data, 'p1')])
  })

  it('isn’t used when it’s the same model on the same login, nor when its account isn’t signed in', async () => {
    for (const setup of [
      () => db.saveAgent(agent({ fallbackModelId: 'sonnet' })),
      () => db.saveAgent(agent({ accountId: 'p1', fallbackModelId: 'sonnet', fallbackAccountId: 'p1' })),
      () => {
        db.saveAgent(agent({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
        settings = { ...settings, accounts: [work, { ...personal, loggedIn: false }] }
      }
    ]) {
      db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
      setup()
      db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
      const claude = claudeOutOn([undefined, accountDir(data, 'p1')])
      const r = runner(claude)
      await r.send('d1', 'oi')
      await r.idle()
      expect(reply().run).toMatchObject({ status: 'failed' })
      expect(claude.turns).toHaveLength(1)
    }
  })

  it('runs on the usual login when its account belongs to another harness', async () => {
    db.saveAgent(agent({ fallbackModelId: 'gpt-5.6-luna', fallbackAccountId: 'p1' }))
    const r = runner(claudeOutOn([undefined]))
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(codexTurns.map((t) => t.account)).toEqual([undefined])
  })
})
