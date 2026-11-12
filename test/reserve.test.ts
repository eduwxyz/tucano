import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { outOfQuota } from '../src/core/engines/cli'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (extra: Partial<Agent> = {}): Agent => ({ id: 'a1', name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

// Claude says its subscription is out (as text, then as the error, like the CLI can), or fails some other way.
const failing = (message: string, text = ''): Engine & { turns: Turn[] } => {
  const turns: Turn[] = []
  return {
    id: 'claude',
    turns,
    run: (t) => {
      turns.push(t)
      return (async function* (): AsyncIterable<EngineEvent> {
        if (text) yield { type: 'text', delta: text }
        yield { type: 'error', message }
      })()
    }
  }
}
const counted = (engine: Engine): Engine & { turns: Turn[] } => {
  const turns: Turn[] = []
  return { id: engine.id, turns, run: (t) => (turns.push(t), engine.run(t)) }
}

let db: Db
let settings: Settings
let codex: ReturnType<typeof counted>

function runner(claude: Engine): Runner {
  codex = counted(fakeEngine('codex', { delayMs: 1 }))
  const engines: Record<EngineId, Engine> = { claude, codex, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')) })
}
const reply = (): Message => db.messages().find((m) => m.author.kind === 'agent')!

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent({ fallbackModelId: 'gpt-5.6-luna' }))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

describe('the reserve model', () => {
  it('is kept with the agent, and cleared', () => {
    expect(db.agent('a1')!.fallbackModelId).toBe('gpt-5.6-luna')
    db.saveAgent(agent())
    expect(db.agent('a1')!.fallbackModelId).toBeUndefined()
  })

  it('takes the reply when the main model’s subscription is out, and the receipt says so', async () => {
    const claude = failing("You've hit your limit · resets 5pm", "You've hit your limit · resets 5pm")
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    const m = reply()
    expect(m.run?.status).toBe('done')
    expect(m.text).toContain('Resposta de teste (codex')
    expect(m.text).not.toContain('hit your limit')
    expect(m.run?.steps.some((s) => s.label === 'Foi pro modelo reserva' && s.detail?.includes('Codex'))).toBe(true)
    expect(m.run?.receipt?.model).toBe('gpt-5.6-luna')
    expect(claude.turns).toHaveLength(1)
    expect(codex.turns).toHaveLength(1)
  })

  it('starts on the main model again on the next reply', async () => {
    const claude = failing('usage limit reached')
    const r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'e agora?')
    await r.idle()
    expect(claude.turns).toHaveLength(2)
    expect(codex.turns).toHaveLength(2)
  })

  it('isn’t used for other failures, nor without a reserve, nor when its harness isn’t ready', async () => {
    let claude = failing('Claude Code exited without a reply (code 1).')
    let r = runner(claude)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(codex.turns).toHaveLength(0)

    for (const setup of [() => db.saveAgent(agent()), () => (settings = { ...settings, engines: { ...settings.engines, codex: { installed: true, loggedIn: false } } })]) {
      db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
      db.saveAgent(agent({ fallbackModelId: 'gpt-5.6-luna' }))
      db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
      setup()
      claude = failing('usage limit reached')
      r = runner(claude)
      await r.send('d1', 'oi')
      await r.idle()
      expect(reply().run).toMatchObject({ status: 'failed', error: expect.stringContaining('chegou no limite') as string, errorDetail: 'usage limit reached' })
      expect(codex.turns).toHaveLength(0)
    }
  })

  it('isn’t used once the reply already said something of its own', async () => {
    const r = runner(failing('rate limit', 'Vou abrir o arquivo e'))
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('failed')
    expect(codex.turns).toHaveLength(0)
  })
})

describe('out of quota', () => {
  it('knows the CLIs’ words for a subscription that’s out', () => {
    for (const m of [
      "You've hit your limit · resets 5pm (America/Sao_Paulo)",
      "You've hit your 5-hour limit · resets 5:30pm (Europe/Madrid)",
      "You've hit your weekly limit · resets Nov 5, 11pm (Europe/Madrid)",
      "You've hit your Opus weekly limit · resets Nov 5, 11pm (Europe/Madrid)",
      'Claude AI usage limit reached|1792374000',
      '5-hour limit reached ∙ resets 3pm',
      "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at 3:21 PM.",
      'usage_limit_reached',
      '[API Error: 429 RESOURCE_EXHAUSTED] Quota exceeded for quota metric',
      'Rate limit exceeded. Too many requests.',
      'Your credit balance is too low to access the Anthropic API.'
    ])
      expect(outOfQuota(m), m).toBe(true)
  })

  it('leaves other failures alone', () => {
    for (const m of ["Claude Code isn't installed. See Settings.", 'Claude Code exited without a reply (code 1).', 'prompt is too long: 210000 tokens > 200000 maximum', 'Codex ended with an error.', 'Not logged in · Please run /login'])
      expect(outOfQuota(m), m).toBe(false)
  })
})
