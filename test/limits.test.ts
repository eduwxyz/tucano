import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }
const agent = (extra: Partial<Agent> = {}): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: true, archived: false, ...extra
})
const done = (text = 'fim'): EngineEvent => ({ type: 'done', text, usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 1 } })

// An engine that runs bash commands through the gateway, one after another, and keeps the replies.
const commands = (list: string[], replies: string[] = []): Engine => ({
  id: 'claude',
  async *run(turn): AsyncIterable<EngineEvent> {
    for (const command of list) {
      if (turn.signal.aborted) return
      const r = (await callTool(turn.mcpUrl!, 'bash', { command }).catch(() => null)) as CallToolResult | null
      replies.push(r ? r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') : '')
      yield { type: 'text', delta: '.' }
    }
    if (!turn.signal.aborted) yield done()
  }
})

let db: Db
let gateway: Gateway
let settings: Settings
let notes: string[]
let bash: (command: string) => CallToolResult // what the agent's "computer" answers

const runner = (claude: Engine): Runner => {
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), hermes: fakeEngine('hermes'), gemini: fakeEngine('gemini') }
  const computers = { call: async (_a: Agent, _n: string, args: Record<string, unknown>) => ({ result: bash(String(args['command'])) }) }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, computers, notify: (title) => notes.push(title) })
}
const reply = () => db.messages().filter((m) => m.author.kind === 'agent').at(-1)!
const labels = () => reply().run!.steps.map((s) => s.label)

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-limits-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, hermes: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  notes = []
  bash = () => textResult('ok')
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

describe('a loop', () => {
  it('the same call with the same result: warned on the 3rd, stopped on the 5th', async () => {
    bash = () => textResult('error: no such module SimulaCore', true)
    const replies: string[] = []
    const r = runner(commands(Array(10).fill('swift test'), replies))
    await r.send('d1', 'roda os testes')
    await r.idle()
    expect(replies[1]).not.toContain('Atenção')
    expect(replies[2]).toContain('deu exatamente o mesmo resultado 3 vezes')
    expect(replies).toHaveLength(5)
    expect(labels()).toContain('Repetiu a mesma chamada')
    expect(reply().run).toMatchObject({ status: 'failed', error: 'Parei: repeti a mesma coisa, com o mesmo resultado, 5 vezes. Parecia um loop.' })
  })

  it('is not long work that keeps changing: the same test run again after edits goes on', async () => {
    let run = 0
    bash = (c) => textResult(c === 'swift test' ? `rodada ${++run}: ${Math.max(0, 30 - run)} testes falhando` : 'editado')
    const r = runner(commands(Array.from({ length: 60 }, (_, i) => (i % 2 ? 'swift test' : `sed -i s/a/b/ arquivo${i}.swift`))))
    await r.send('d1', 'conserta tudo')
    await r.idle()
    expect(reply().run?.status).toBe('done')
    expect(reply().run?.steps.length).toBeGreaterThan(50) // past the old cap of 50 tool calls
  })

  it('stops after 8 tool calls failing in a row, even if each is different', async () => {
    bash = (c) => textResult(`falhou: ${c}`, true)
    const replies: string[] = []
    const r = runner(commands(Array.from({ length: 20 }, (_, i) => `tentativa ${i}`), replies))
    await r.send('d1', 'instala o swift')
    await r.idle()
    expect(replies).toHaveLength(8)
    expect(reply().run?.error).toBe('Parei: 8 ferramentas falharam seguidas.')
  })

  it('the same web search over and over is a loop too', async () => {
    const searching: Engine = {
      id: 'claude',
      async *run(turn) {
        for (let i = 0; i < 10 && !turn.signal.aborted; i++) yield { type: 'web', action: 'search', detail: 'swift linux' }
        if (!turn.signal.aborted) yield done()
      }
    }
    const r = runner(searching)
    await r.send('d1', 'pesquisa')
    await r.idle()
    expect(labels().filter((l) => l === 'Pesquisou na web')).toHaveLength(5)
    expect(reply().run?.status).toBe('failed')
  })
})

describe('a stuck reply', () => {
  it('is cut after a while without any sign of life, keeping what it wrote', async () => {
    settings.runStallMinutes = 0.002 // ~120 ms
    const hanging: Engine = {
      id: 'claude',
      async *run(turn) {
        yield { type: 'text', delta: 'Começando' }
        await new Promise((r) => turn.signal.addEventListener('abort', r))
      }
    }
    const r = runner(hanging)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply()).toMatchObject({ text: 'Começando …', run: { status: 'failed', error: 'Parei: fiquei 0 minutos sem nenhum sinal, travado.' } })
  })

  it('is not one that takes long but keeps going', async () => {
    settings.runStallMinutes = 0.004 // ~240 ms of silence; it runs ~4x that, never silent that long
    const slow: Engine = {
      id: 'claude',
      async *run(turn) {
        for (let i = 0; i < 20 && !turn.signal.aborted; i++) {
          await new Promise((r) => setTimeout(r, 50))
          yield { type: 'text', delta: '.' }
        }
        if (!turn.signal.aborted) yield done()
      }
    }
    const r = runner(slow)
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run?.status).toBe('done')
  })
})

describe('the budget per reply', () => {
  // Spends `tokens` (with `cacheRead` of them from the cache), then tries a tool and wraps up.
  const spending = (tokens: number, cacheRead: number, seen: { refused?: string; turns: Turn[] }): Engine => ({
    id: 'claude',
    async *run(turn) {
      seen.turns.push(turn)
      yield { type: 'progress', tokens, cacheRead }
      const r = (await callTool(turn.mcpUrl!, 'bash', { command: 'swift build' })) as CallToolResult
      seen.refused ??= r.isError ? (r.content[0] as { text: string }).text : undefined
      yield { type: 'text', delta: 'Instalei o Swift; falta rodar os testes.' }
      yield { type: 'done', text: 'Instalei o Swift; falta rodar os testes.', usage: { inputTokens: tokens, cacheReadTokens: cacheRead, outputTokens: 0 } }
    }
  })

  it('pauses the reply at its share of the month, and Continuar picks up from what it did', async () => {
    const seen: { refused?: string; turns: Turn[] } = { turns: [] }
    const r = runner(spending(120_000, 0, seen)) // the budget is 10% of 1M
    await r.send('d1', 'investiga o bug')
    await r.idle()
    expect(seen.refused).toContain('Você chegou no teto de gasto desta resposta (100 mil tokens)')
    const paused = reply()
    expect(paused).toMatchObject({ text: 'Instalei o Swift; falta rodar os testes.', run: { status: 'paused', budget: 100_000 } })
    expect(labels()).toContain('Chegou no teto da resposta')

    await r.continue(paused.id)
    await r.idle()
    expect(db.message(paused.id)!.run!.status).toBe('done')
    expect(seen.turns.at(-1)!.prompt).toContain('Edu pediu pra continuar')
    expect(seen.turns.at(-1)!.prompt).toContain('- Chegou no teto da resposta: 100 mil tokens')
  })

  it('counts a token read from the cache as a tenth', async () => {
    const seen: { refused?: string; turns: Turn[] } = { turns: [] }
    const r = runner(spending(500_000, 480_000, seen)) // 20k new + 480k cached: counts 68k
    await r.send('d1', 'investiga o bug')
    await r.idle()
    expect(seen.refused).toBeUndefined()
    expect(reply().run?.status).toBe('done')
    expect(db.usedThisMonth('a1')).toBe(68_000)
  })

  it('cuts a reply that keeps spending far past it', async () => {
    const r = runner({
      id: 'claude',
      async *run(turn) {
        for (let t = 50_000; t <= 400_000 && !turn.signal.aborted; t += 50_000) yield { type: 'progress', tokens: t, cacheRead: 0 }
        if (!turn.signal.aborted) yield done()
      }
    })
    await r.send('d1', 'oi')
    await r.idle()
    expect(reply().run).toMatchObject({ status: 'paused' })
    expect(reply().run!.receipt!.inputTokens).toBeLessThanOrEqual(150_000)
  })
})

describe('web', () => {
  // Searches with the CLI's own tool, which never passes through the gateway.
  const searching = (times: number): Engine => ({
    id: 'claude',
    async *run(turn): AsyncIterable<EngineEvent> {
      expect(turn.web).toBe(true)
      for (let i = 0; i < times && !turn.signal.aborted; i++) yield { type: 'web', action: 'search', detail: `busca ${i}` }
      if (!turn.signal.aborted) yield done('Achei.')
    }
  })

  it('shows each search as a step', async () => {
    const r = runner(searching(2))
    await r.send('d1', 'pesquisa aí')
    await r.idle()
    expect(reply().run?.steps.filter((s) => s.label === 'Pesquisou na web').map((s) => s.detail)).toEqual(['busca 0', 'busca 1'])
  })

  it('is on unless turned off on the agent', async () => {
    db.saveAgent(agent({ web: false }))
    expect(db.agent('a1')!.web).toBe(false)
    const seen: (boolean | undefined)[] = []
    const r = runner({ id: 'claude', run: (t) => (seen.push(t.web), fakeEngine('claude', { delayMs: 1 }).run(t)) })
    await r.send('d1', 'oi')
    await r.idle()
    expect(seen).toEqual([false])
    db.saveAgent(agent())
    expect(db.agent('a1')!.web).toBe(true)
  })
})

describe('keeping the Mac awake', () => {
  it('says when replies start and when the last one ends', async () => {
    const busy: boolean[] = []
    const r = new Runner({ db, engines: { claude: fakeEngine('claude', { delayMs: 5 }), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), hermes: fakeEngine('hermes'), gemini: fakeEngine('gemini') }, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), onBusy: (b) => busy.push(b) })
    db.saveAgent(agent({ id: 'a2', handle: 'theo', name: 'Theo' }))
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] })
    await r.send('c1', '@lia @theo oi')
    await r.idle()
    expect(busy).toEqual([true, false])
  })
})

describe('usage alert', () => {
  it('warns once, in the conversation and with a notification, when an agent crosses 80% of its limit', async () => {
    db.saveAgent(agent({ limit: 10_000 }))
    db.addReceipt({ model: 'sonnet', inputTokens: 7_900, cacheReadTokens: 0, outputTokens: 0, ms: 1, messageId: 'old', agentId: 'a1', engine: 'claude', at: Date.now() })
    const r = runner(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', 'oi')
    await r.idle()
    await r.send('d1', 'oi de novo')
    await r.idle()
    const alerts = db.messages().filter((m) => m.author.kind === 'system' && m.text.includes('do limite do mês'))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]!.text).toMatch(/\*\*Lia\*\* já usou 8\d% do limite do mês \(\d+ mil de 10 mil tokens\)/)
    expect(notes.filter((n) => n.includes('limite'))).toEqual([expect.stringMatching(/^Lia usou 8\d% do limite do mês$/)])
  })
})

describe('notifications', () => {
  it('tells you once when the work ends, not at each agent of a chain', async () => {
    db.saveAgent(agent({ id: 'a2', handle: 'theo', name: 'Theo' }))
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1', 'a2'] })
    const r = runner(fakeEngine('claude', { delayMs: 1 }))
    await r.send('c1', '@lia peça pro theo dar uma olhada')
    await r.idle()
    expect(notes).toEqual(['Theo terminou'])
  })

  it('tells you when an agent asks you something, and not that it ended', async () => {
    const r = runner(fakeEngine('claude', { delayMs: 1 }))
    await r.send('d1', 'me pergunta uma coisa')
    await r.idle()
    expect(notes).toEqual(['Lia te perguntou'])
  })
})
