import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

// Hermes' daemon keeps the MCP connection between turns, so an agent on it has one gateway URL and one
// home: two of its replies at once would share a session and rewrite each other's instructions.

const ready = { installed: true, loggedIn: true }
const agent = (id: string, handle: string, modelId: string): Agent => ({
  id, name: handle, handle, role: '', color: 'sky', instructions: '', modelId, effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false
})

let db: Db
let gateway: Gateway
let running: Record<string, number>
let most: Record<string, number>
let urls: string[]

// An engine whose turns take a while and count how many of each agent's run at once.
function slow(id: EngineId, keepsMcp: boolean): Engine {
  const base = fakeEngine(id, { delayMs: 1 })
  return {
    id,
    ...(keepsMcp ? { keepsMcp } : {}),
    async *run(t: Turn) {
      const key = `${id}:${t.agentKey ?? t.cwd}`
      running[key] = (running[key] ?? 0) + 1
      most[key] = Math.max(most[key] ?? 0, running[key]!)
      if (t.mcpUrl) urls.push(t.mcpUrl)
      await new Promise((r) => setTimeout(r, 150))
      running[key]!--
      yield* base.run(t)
    }
  }
}

function runner(): Runner {
  const engines: Record<EngineId, Engine> = { claude: fakeEngine('claude', { delayMs: 1 }), codex: slow('codex', false), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: slow('hermes', true) }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway })
}

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  running = {}
  most = {}
  urls = []
  gateway = new Gateway()
  await gateway.start()
})

afterEach(async () => {
  await gateway.stop()
})

const twoAtOnce = async (modelId: string): Promise<void> => {
  db.saveAgent(agent('a1', 'iris', modelId))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'], threads: true })
  db.createConversation({ id: 'c1', kind: 'channel', name: 'pesquisa', members: ['a1'], threads: true })
  const r = runner()
  await Promise.all([r.send('d1', 'resume o relatório'), r.send('c1', '@iris lista as fontes')])
  await r.idle()
  expect(db.messages().filter((m) => m.author.kind === 'agent' && m.run?.status === 'done')).toHaveLength(2)
}

describe('an agent on an engine that keeps the MCP connection', () => {
  it('answers one reply at a time, on the same gateway URL', async () => {
    await twoAtOnce('hermes:probe/probe-model')
    expect(Object.entries(most).filter(([k]) => k.startsWith('hermes:')).map(([, n]) => n)).toEqual([1])
    expect(new Set(urls).size).toBe(1)
  })

  it('leaves the other engines answering at once', async () => {
    await twoAtOnce('codex:gpt-5.6-luna')
    expect(Object.entries(most).filter(([k]) => k.startsWith('codex:')).map(([, n]) => n)).toEqual([2])
  })

  it("stops answering on the agent's URL once the agent goes", async () => {
    await twoAtOnce('hermes:probe/probe-model')
    runner().forgetSessions({ agentId: 'a1' })
    const res = await fetch(urls[0]!, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})
