import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Account, Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { accountDir } from '../src/core/engines/detect'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { handoffSystem, routerSystem } from '../src/core/router'
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
  const engines: Record<EngineId, Engine> = { claude, codex: { id: 'codex', run: (t) => (codexTurns.push(t), codex.run(t)) }, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), dataDir: data })
}
const reply = (): Message => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'ad-data-'))
  db = new Db(join(data, 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', accounts: [work, personal] }
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

describe('the router on another account', () => {
  const routerAccounts = (claude: { turns: Turn[] }): (string | undefined)[] => claude.turns.filter((t) => t.system === routerSystem()).map((t) => t.account)
  const note = (): string => db.messages().find((m) => m.author.kind === 'system')!.text

  // The agents answer on Pessoal, so only the router meets the usual login's limit.
  beforeEach(() => {
    db.saveAgent(agent({ accountId: 'p1' }))
    db.saveAgent(agent({ id: 'a2', name: 'bia', handle: 'bia', accountId: 'p1' }))
    db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
  })

  it('moves to another account when the usual login is out of quota', async () => {
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('c1', 'oi')
    await r.idle()
    expect(routerAccounts(claude)).toEqual([undefined, accountDir(data, 'w1')])
    expect(note()).toMatch(/^Chamei/)
    expect(note()).toContain('o limite do Claude Code acabou, decidi pela conta “Trabalho”')
  })

  it('says it could not pick when every login is out of quota', async () => {
    const claude = claudeOutOn([undefined, accountDir(data, 'w1'), accountDir(data, 'p1')])
    const r = runner(claude)
    await r.send('c1', 'oi')
    await r.idle()
    expect(routerAccounts(claude)).toHaveLength(3)
    expect(note()).toContain('Não consegui escolher quem responde')
    expect(db.messages().some((m) => m.author.kind === 'agent')).toBe(false)
  })

  it('runs straight on an account when the usual login is signed out', async () => {
    settings.engines.claude = { installed: true, loggedIn: false }
    const claude = claudeOutOn([])
    const r = runner(claude)
    await r.send('c1', 'oi')
    await r.idle()
    expect(routerAccounts(claude)).toEqual([accountDir(data, 'w1')])
    expect(note()).toMatch(/^Chamei/)
    expect(note()).toContain('decidi pela conta “Trabalho” do Claude Code')
    expect(note()).not.toContain('limite')
  })

  it('does not retry on another account for an error that is not the limit', async () => {
    const base = claudeOutOn([undefined])
    const claude: Engine & { turns: Turn[] } = {
      id: 'claude',
      turns: base.turns,
      run: (t) =>
        t.system === routerSystem()
          ? (base.turns.push(t),
            (async function* (): AsyncIterable<EngineEvent> {
              yield { type: 'error', message: 'boom' }
            })())
          : base.run(t)
    }
    const r = runner(claude)
    await r.send('c1', 'oi')
    await r.idle()
    expect(routerAccounts(claude)).toHaveLength(1)
    expect(note()).toContain('Não consegui escolher quem responde')
  })

  it('screens a hand-off on another account too', async () => {
    const claude = claudeOutOn([undefined])
    const r = runner(claude)
    await r.send('c1', '@lia peça pra bia ver isso')
    await r.idle()
    expect(claude.turns.filter((t) => t.system === handoffSystem()).map((t) => t.account)).toEqual([undefined, accountDir(data, 'w1')])
    const steps = db.messages().flatMap((m) => m.run?.steps ?? [])
    expect(steps.some((x) => x.label === 'Chamou' && !!x.detail?.includes('bia') && !!x.detail?.includes('o limite do Claude Code acabou, decidi pela conta “Trabalho”'))).toBe(true)
    expect(db.messages().some((m) => m.author.kind === 'agent' && m.author.id === 'a2')).toBe(true)
  })
})
