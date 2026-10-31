import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MEMORY_PROMPT_BUDGET, splitForPrompt, type Agent, type Memory, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Memories, rankMemories } from '../src/core/memory'
import { Runner } from '../src/core/runs'

const mem = (id: string, text: string, confirmedAt: number, scope = 'me'): Memory => ({ id, scope, text, state: 'active', origin: 'me', messageIds: [], createdAt: confirmedAt, confirmedAt })
const filler = (i: number): Memory => mem(`f${i}`, `Nota número ${i} sobre um assunto qualquer do trabalho, ${'longa '.repeat(30)}`, 1_000 + i)

describe('memories past the prompt budget', () => {
  it('keeps the newest in the prompt and the rest for search', () => {
    const small = [mem('a', 'Prefere PR pequeno', 2), mem('b', 'Usa o Linear', 1)]
    expect(splitForPrompt(small)).toEqual({ prompt: [small[0], small[1]], searchable: [] })
    const many = Array.from({ length: 60 }, (_, i) => filler(i))
    const { prompt, searchable } = splitForPrompt(many)
    expect(prompt.reduce((n, m) => n + m.text.length + 1, 0)).toBeLessThanOrEqual(MEMORY_PROMPT_BUDGET)
    expect(prompt[0]!.id).toBe('f59') // newest first
    expect(searchable.length).toBe(60 - prompt.length)
    expect(Math.max(...searchable.map((m) => m.confirmedAt))).toBeLessThan(Math.min(...prompt.map((m) => m.confirmedAt)))
  })

  it('ranks by the words asked, Portuguese forms included', () => {
    const ms = [
      mem('1', 'Eduardo prefere deploy na sexta pela Vercel', 1),
      mem('2', 'A preferência de café é sem açúcar', 2),
      mem('3', 'O cupom da campanha é ZEBRA', 3),
      mem('4', 'PR sempre pequeno, com descrição em bullets', 4)
    ]
    expect(rankMemories(ms, 'deploys vercel').map((m) => m.id)).toEqual(['1'])
    expect(rankMemories(ms, 'preferencias').map((m) => m.id).sort()).toEqual(['1', '2'])
    expect(rankMemories(ms, 'cafe acucar')[0]!.id).toBe('2') // accents don't matter
    expect(rankMemories(ms, 'pr')[0]!.id).toBe('4') // short words match whole: not "prefere"
    expect(rankMemories(ms, 'pr').map((m) => m.id)).toEqual(['4'])
    expect(rankMemories(ms, 'kubernetes')).toEqual([])
  })
})

describe('buscar_memorias', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, hermes: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  let db: Db
  let gateway: Gateway
  let runner: Runner
  const turns: Turn[] = []
  const results: unknown[] = []

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
    db.saveAgent(lia)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    gateway = new Gateway()
    await gateway.start()
    turns.length = 0
    results.length = 0
    const claude: Engine = {
      id: 'claude',
      async *run(turn) {
        turns.push(turn)
        if (turn.mcpUrl) results.push(await callTool(turn.mcpUrl, 'buscar_memorias', { busca: 'cupom campanha' }))
        yield { type: 'done', text: 'ok', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const engines = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), hermes: fakeEngine('hermes'), gemini: fakeEngine('gemini') }
    const workDir = mkdtempSync(join(tmpdir(), 'ad-work-'))
    const memory = new Memories({ db, engines, settings: async () => settings, emit: () => {}, workDir })
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir, gateway, memory })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it('is not offered while every memory fits the prompt', async () => {
    db.saveMemory(mem('z', 'O cupom da campanha é ZEBRA', 5))
    await runner.send('d1', 'qual o cupom?')
    await runner.idle()
    expect(turns[0]!.system).toContain('ZEBRA')
    expect(turns[0]!.system).not.toContain('buscar_memorias')
    expect(JSON.stringify(results[0])).not.toContain('ZEBRA') // no such tool
  })

  it('turns on by itself once memories pass the budget, and finds the old ones', async () => {
    db.saveMemory(mem('z', 'O cupom da campanha é ZEBRA', 1)) // the oldest
    for (let i = 0; i < 60; i++) db.saveMemory(filler(i))
    await runner.send('d1', 'qual o cupom?')
    await runner.idle()
    const system = turns[0]!.system
    expect(system).not.toContain('ZEBRA')
    expect(system).toContain('procure com buscar_memorias')
    expect(JSON.stringify(results[0])).toContain('ZEBRA')
    const reply = db.messages().find((m) => m.author.kind === 'agent')!
    expect(reply.run?.steps.map((s) => s.label)).toContain('Buscou na memória')
  })
})
