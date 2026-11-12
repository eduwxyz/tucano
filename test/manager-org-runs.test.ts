// Over the runner and the gateway, as a model calls the tools: an agent that doesn't organize the team
// isn't offered responde_a, and asking for it anyway is a refusal it passes on, not eight failures that
// stop the reply; one that organizes the team gets its card.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { proposalsOf, type Agent, type EngineId, type Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { setLang } from '../src/shared/lang'

setLang('pt')
const ready = { installed: true, loggedIn: true }
const settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as Settings
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'medium', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

describe('asking an agent to organize the team', () => {
  let db: Db
  let gateway: Gateway
  let runner: Runner
  let calls: { tool: string; args: Record<string, unknown> }[] = []
  const results: { content: { text: string }[]; isError?: boolean }[] = []
  let tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] = []

  const scripted: Engine = {
    id: 'claude',
    async *run(turn) {
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        tools = (await client.listTools()).tools as typeof tools
        for (const c of calls) results.push((await client.callTool({ name: c.tool, arguments: c.args })) as (typeof results)[number])
        await client.close()
      }
      yield { type: 'done', text: 'pronto', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    }
  }

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
    gateway = new Gateway()
    await gateway.start()
    calls = []
    results.length = 0
    const engines = { claude: scripted, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') } as Record<EngineId, Engine>
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway })
    db.saveAgent(agent('a1', 'lia'))
    db.saveAgent(agent('a2', 'theo'))
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a2', members: ['a2'] })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  it("without the setting: not offered, and a refusal it passes on, never the reply stopped for failures", async () => {
    // Nine different tries (the same one five times is a loop, stopped on its own: REPEAT_STOP).
    calls = Array.from({ length: 9 }, (_, i) => ({ tool: 'propor_ajuste', args: { agente: 'lia', responde_a: `chefe-${i}` } }))
    await runner.send('d2', 'organiza o time pra eu falar só com você')
    await runner.idle()
    const ajuste = tools.find((t) => t.name === 'propor_ajuste')!
    expect(Object.keys(ajuste.inputSchema.properties ?? {})).not.toContain('responde_a')
    expect(results.every((r) => !r.isError && r.content[0]!.text.includes('Você não tem permissão pra mudar o organograma'))).toBe(true)
    const reply = db.recentMessages('d2', 10).find((m) => m.author.kind === 'agent')!
    expect([reply.run?.status, reply.run?.error]).toEqual(['done', undefined])
    expect(reply.run?.steps.some((s) => s.label === 'Sem permissão' && s.detail === 'Organiza o time está desligado pra este agente')).toBe(true)
    expect(db.agent('a1')?.reportsTo).toBeUndefined()
  })

  it('with the setting: offered, and the change is a card', async () => {
    db.saveAgent({ ...db.agent('a2')!, manager: true })
    calls = [{ tool: 'propor_ajuste', args: { agente: 'lia', responde_a: 'theo', motivo: 'O Theo coordena.' } }]
    await runner.send('d2', 'organiza o time pra eu falar só com você')
    await runner.idle()
    expect(Object.keys(tools.find((t) => t.name === 'propor_ajuste')!.inputSchema.properties ?? {})).toContain('responde_a')
    const reply = db.recentMessages('d2', 10).find((m) => m.author.kind === 'agent')!
    expect(proposalsOf(reply.run)[0]).toMatchObject({ kind: 'agent', agentId: 'a1', changes: { reportsTo: 'a2' } })
    expect(db.agent('a1')?.reportsTo).toBeUndefined() // nothing until applied
  })
})
