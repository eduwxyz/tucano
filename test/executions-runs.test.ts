// What a real reply records for Execuções, through the runner, the gateway and a real connector.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { executions, executionSteps } from '../src/core/executions'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'
import { ENGINE_IDS, type Agent, type EngineId, type Message, type Settings } from '../src/shared/types'

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }

describe('what a reply records for Executions', () => {
  let dir: string
  let db: Db
  let gateway: Gateway
  let connectors: ConnectorManager
  let connectorId: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-execrun-'))
    db = new Db(join(dir, 'test.db'))
    gateway = new Gateway()
    await gateway.start()
    connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
    connectorId = await connectors.add({ kind: 'stdio', name: 'Tarefas', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: join(dir, 'tasks.json') } })
    await connectors.connect(connectorId)
    db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: { [connectorId]: 'read' }, memory: 'auto', computer: true, archived: false } as unknown as Agent)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  })

  afterEach(async () => {
    await connectors.remove(connectorId)
    await gateway.stop()
  })

  const runner = (run: (turn: Turn) => AsyncIterable<import('../src/core/engines/types').EngineEvent>, reach: object = {}): Runner => {
    const engines = Object.fromEntries(ENGINE_IDS.map((id) => [id, fakeEngine(id, { delayMs: 1 })])) as Record<EngineId, Engine>
    engines.claude = { id: 'claude', run }
    const settings = { workspaceName: 'Edu', context: '', engines: Object.fromEntries(ENGINE_IDS.map((id) => [id, ready])), routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
    return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: join(dir, 'work'), gateway, connectors, computers: { call: async () => ({ result: textResult('ok') }) } as never, ...reach })
  }
  const replyOf = (): Message => db.messages().find((m) => m.author.kind === 'agent')!

  it('says which tool ran, for a command and for a connector, without the connector’s name', async () => {
    const r = runner(async function* (turn) {
      await callTool(turn.mcpUrl!, 'bash', { command: 'ls' })
      await callTool(turn.mcpUrl!, 'tarefas__list_tasks', {})
      yield { type: 'done', text: 'pronto', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    })

    await r.send('d1', 'olha as tarefas')
    await r.idle()

    expect(replyOf().run!.steps.flatMap((s) => (s.tool ? [s.tool] : []))).toEqual(['bash', 'list_tasks'])
  })

  it('says which tool ran in the browser and in an app', async () => {
    db.saveAgent({ ...db.agent('a1')!, browser: true, apps: ['com.example.app'] } as unknown as Agent)
    const r = runner(
      async function* (turn) {
        await callTool(turn.mcpUrl!, 'navegador_ler', {})
        await callTool(turn.mcpUrl!, 'app_ver', {})
        yield { type: 'done', text: 'pronto', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      },
      {
        browser: { tools: () => [], call: async () => ({ result: textResult('a página') }), approved: async () => ({ ok: true, text: '' }) },
        apps: { tools: () => [], call: async () => ({ result: textResult('a tela') }), approved: () => ({ ok: true, text: '' }), lent: () => [] }
      }
    )

    await r.send('d1', 'olha a página e o app')
    await r.idle()

    expect(replyOf().run!.steps.flatMap((s) => (s.tool ? [s.tool] : []))).toEqual(['navegador_ler', 'app_ver'])
  })

  it('leaves no time on a call the reply ended under', async () => {
    let answered = false
    const r = runner(async function* (turn) {
      void callTool(turn.mcpUrl!, 'bash', { command: 'sleep 60' }).then(() => (answered = true), () => {})
      await new Promise((ok) => setTimeout(ok, 40))
      yield { type: 'error', message: 'quebrou no meio' }
    }, { computers: { call: () => new Promise(() => {}) } })

    await r.send('d1', 'roda')
    await r.idle()

    const bash = replyOf().run!.steps.find((s) => s.tool === 'bash')!
    expect(bash.status).not.toBe('running')
    expect(bash.ms).toBeUndefined()
    expect(answered).toBe(false)
  })

  it('cuts a very long error the way a step already does', async () => {
    vi.spyOn(connectors, 'call').mockRejectedValueOnce(new Error('x'.repeat(5000)))
    const r = runner(async function* (turn) {
      await callTool(turn.mcpUrl!, 'tarefas__list_tasks', {})
      yield { type: 'done', text: 'pronto', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    })

    await r.send('d1', 'olha as tarefas')
    await r.idle()

    const failed = executionSteps(db, replyOf().id)!.find((s) => s.status === 'error')!
    expect(failed.tool).toBe('list_tasks')
    expect(failed.error!.length).toBeLessThanOrEqual(2001)
    expect(failed.error!.endsWith('…')).toBe(true)
  })

  it('keeps when the last attempt of a retried reply started, through how it ends', async () => {
    const r = runner(async function* () {
      yield { type: 'error', message: 'quebrou' }
    })
    await r.send('d1', 'tenta')
    await r.idle()
    const first = replyOf()
    expect(first.run).toMatchObject({ status: 'failed' })
    expect(first.run!.startedAt).toBeUndefined()

    await new Promise((ok) => setTimeout(ok, 15))
    const retriedAt = Date.now()
    r.retry(first.id)
    await r.idle()

    const again = replyOf()
    expect(again.id).toBe(first.id)
    expect(again.run).toMatchObject({ status: 'failed' })
    expect(again.run!.startedAt).toBeGreaterThanOrEqual(retriedAt)
    expect(again.at).toBe(first.at)
    expect(executions(db, () => true, { days: 1 }).rows.map((x) => x.id)).toEqual([first.id]) // counted once, as its latest attempt
  })

  it('keeps it too when the retry stops before running, so it isn’t timed from the first attempt', async () => {
    const r = runner(async function* () {
      yield { type: 'error', message: 'quebrou' }
    })
    await r.send('d1', 'tenta')
    await r.idle()
    const first = replyOf()
    vi.spyOn(db, 'usedThisMonth').mockReturnValue(2_000_000)

    await new Promise((ok) => setTimeout(ok, 15))
    const retriedAt = Date.now()
    r.retry(first.id)
    await r.idle()

    expect(replyOf().run).toMatchObject({ status: 'limit_reached' })
    expect(replyOf().run!.startedAt).toBeGreaterThanOrEqual(retriedAt)
  })
})
