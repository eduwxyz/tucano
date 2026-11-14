import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Account, Agent, EngineId, Message, Quota, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { accountDir } from '../src/core/engines/detect'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const used = (u: number): Quota => ({ fiveHour: { utilization: u, resetsAt: Date.now() + 3_600_000 }, at: Date.now() })

// Claude, whose limit is out on some logins (by their folder; undefined: the usual login).
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
let quotas: [Quota, string | undefined][]
let spent: (string | undefined)[]
const work: Account = { id: 'w1', engine: 'claude', name: 'Trabalho', loggedIn: true }
const personal: Account = { id: 'p1', engine: 'claude', name: 'Pessoal', loggedIn: true }

function runner(claude: Engine): Runner {
  codexTurns = []
  quotas = []
  spent = []
  const codex = fakeEngine('codex', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude, codex: { id: 'codex', run: (t) => (codexTurns.push(t), codex.run(t)) }, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({
    db,
    engines,
    settings: async () => settings,
    emit: () => {},
    workDir: mkdtempSync(join(tmpdir(), 'ad-work-')),
    dataDir: data,
    onQuota: (q, id) => quotas.push([q, id]),
    onSpent: (id) => spent.push(id)
  })
}
const reply = (): Message => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!
const dir = (id: string): string => accountDir(data, id)

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ad-data-'))
  db = new Db(join(data, 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', accounts: [work, personal] }
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('using the accounts in order', () => {
  it('keeps the agent on its own login even when another has more left', async () => {
    settings = { ...settings, quota: used(0.9), accountQuota: { w1: used(0), p1: used(0) } }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([undefined])
  })

  it('also moves to the reserve, not to another account, when the login is out', async () => {
    db.saveAgent(agent({ fallbackModelId: 'sonnet', fallbackAccountId: 'p1' }))
    settings = { ...settings, accountQuota: { w1: used(0) } }
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([undefined, dir('p1')])
    expect(spent).toEqual([]) // order mode marks nothing as spent
  })
})

describe('balancing the accounts', () => {
  beforeEach(() => {
    settings = { ...settings, accountUse: 'balance' }
  })

  it('runs the reply on the login with the most left', async () => {
    settings = { ...settings, quota: used(0.8), accountQuota: { w1: used(0.5), p1: used(0.1) } }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([dir('p1')])
  })

  it('stays on the login it used last while the gap is small', async () => {
    settings = { ...settings, quota: used(0.5), accountQuota: { w1: used(0.6), p1: used(0.7) } }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    settings = { ...settings, quota: used(0.6), accountQuota: { w1: used(0.5), p1: used(0.7) } } // w1 now leads by less than the gap
    await r.send('d1', 'e agora?')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([undefined, undefined])
    settings = { ...settings, quota: used(0.9), accountQuota: { w1: used(0.2), p1: used(0.7) } } // now by a lot
    await r.send('d1', 'e depois?')
    await r.idle()
    expect(claude.turns.at(-1)!.account).toBe(dir('w1'))
  })

  it('keeps the reply on the login that reported while another has not been checked yet', async () => {
    settings = { ...settings, quota: used(0.97), accountQuota: {} } // the usual login reported, nearly full; w1 and p1 never did
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([undefined])
  })

  it('runs the reply on the account that never reported, not on the usual login that is out', async () => {
    settings = { ...settings, accounts: [work], quota: used(1), accountQuota: {} }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([dir('w1')])
  })

  it('does not fail for an unsigned-in agent account when another login was picked', async () => {
    db.saveAgent(agent({ accountId: 'w1' }))
    settings = { ...settings, accounts: [{ ...work, loggedIn: false }, personal] }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([undefined])
  })

  it('behaves as in order with a single login', async () => {
    db.saveAgent(agent({ accountId: 'w1' }))
    settings = { ...settings, engines: { ...settings.engines, claude: { installed: true, loggedIn: false } }, accounts: [work] }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(claude.turns.map((t) => t.account)).toEqual([dir('w1')])
  })

  it('reports each login’s quota under its id, the usual login’s without one', async () => {
    const reported = used(0.3)
    const ok = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine & { turns: Turn[] } = {
      id: 'claude',
      turns: [],
      run: (t) => {
        claude.turns.push(t)
        return (async function* (): AsyncIterable<EngineEvent> {
          yield { type: 'quota', quota: reported }
          yield* ok.run(t)
        })()
      }
    }
    settings = { ...settings, quota: used(0.5), accountQuota: { w1: used(0.2), p1: used(0.9) } }
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    const mine = (): [Quota, string | undefined][] => quotas.filter(([q]) => q === reported)
    expect(mine()[0]).toEqual([reported, 'w1'])
    settings = { ...settings, quota: used(0.1), accountQuota: { w1: used(0.9), p1: used(0.9) } }
    await r.send('d1', 'de novo')
    await r.idle()
    expect(mine().at(-1)).toEqual([reported, undefined])
  })

  it('moves on to another login on the same model, marks the first as spent, and does not use the reserve', async () => {
    db.saveAgent(agent({ fallbackModelId: 'gpt-5.6-luna' }))
    settings = { ...settings, quota: used(0.1), accountQuota: { w1: used(0.4), p1: used(0.5) } }
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns.map((t) => t.account)).toEqual([undefined, dir('w1')])
    expect(claude.turns[1]!.model).toBe(claude.turns[0]!.model)
    expect(spent).toEqual([undefined])
    expect(reply().run?.steps.some((s) => s.label === 'Foi pra outra conta')).toBe(true)
    expect(codexTurns).toHaveLength(0)
  })

  it('tries each login once, then the reserve only when every login is out', async () => {
    db.saveAgent(agent({ fallbackModelId: 'gpt-5.6-luna' }))
    const claude = claudeOutOn([undefined, dir('w1'), dir('p1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(claude.turns).toHaveLength(3)
    expect(new Set(claude.turns.map((t) => t.account)).size).toBe(3)
    expect(spent.sort()).toEqual([undefined, 'p1', 'w1'].sort())
    expect(codexTurns).toHaveLength(1)
  })

  it('fails when every login is out and there is no reserve', async () => {
    const claude = claudeOutOn([undefined, dir('w1'), dir('p1')])
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(claude.turns).toHaveLength(3)
  })
})
