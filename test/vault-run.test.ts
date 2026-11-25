// The Cofre in a reply: bash and start_service take `keys`, the app puts only those values in that
// command's environment, masks them in what comes back, logs each use, and a key that asks for
// approval holds the command until a person decides.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import type { EngineId } from '../src/shared/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'
import { Vault } from '../src/core/vault'

const ready = { installed: true, loggedIn: true }
const owner = { id: 'owner', admin: true, team: false }

let db: Db
let gateway: Gateway
let vault: Vault
let settings: Settings
let ran: { name: string; args: Record<string, unknown>; env?: Record<string, string> }[]
const computers = {
  call: async (_a: unknown, name: string, args: Record<string, unknown>, ctx: { env?: Record<string, string> }) => {
    ran.push({ name, args, ...(ctx.env ? { env: ctx.env } : {}) })
    // A command that prints what it got: the value would reach the agent if nothing masked it.
    return { result: textResult(`exit code 0\n${Object.values(ctx.env ?? {}).join(' ')} cat .env: STRIPE_KEY=${'sk_live_abcdef123456'}`) }
  },
  mac: { cwd: () => '/tmp/lia' }
}

type Seen = { tools: { name: string; inputSchema: { properties?: Record<string, { description?: string }> } }[]; results: string[] }
function scripted(seen: Seen, calls: { tool: string; args: Record<string, unknown> }[]): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      const client = new Client({ name: 'scripted', version: '0' })
      await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl!)))
      seen.tools = (await client.listTools()).tools as Seen['tools']
      for (const c of calls) seen.results.push(((await client.callTool({ name: c.tool, arguments: c.args })) as { content: { text: string }[] }).content[0]?.text ?? '')
      await client.close()
      yield { type: 'text', delta: 'ok' }
      yield { type: 'done', text: 'ok', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

const withFakes = (claude: Engine): Record<EngineId, Engine> => Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok'] as EngineId[]).map((e) => [e, e === 'claude' ? claude : fakeEngine(e)])) as Record<EngineId, Engine>

async function turn(calls: { tool: string; args: Record<string, unknown> }[]): Promise<Seen> {
  const seen: Seen = { tools: [], results: [] }
  const runner = new Runner({ db, engines: withFakes(scripted(seen, calls)), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'v-w-')), gateway, computers: computers as never, vault })
  await runner.send('dm', 'puxa as cobranças do mês')
  await runner.idle()
  return seen
}

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'v-db-')), 'test.db'))
  ran = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as never
  db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: true, computerKind: 'linux', archived: false })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  vault = new Vault({ db, secrets: new Secrets(db, plainCipher) })
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('a key of the Cofre in a command', () => {
  it('without keys given, bash is as it always was', async () => {
    const seen = await turn([])
    expect(seen.tools.find((t) => t.name === 'bash')?.inputSchema.properties?.['keys']).toBeUndefined()
  })

  it('is offered by name, goes only into that command, comes back masked and is logged', async () => {
    await vault.save(owner, { name: 'STRIPE_KEY', value: 'sk_live_abcdef123456', agents: ['lia'], approve: false })
    const seen = await turn([
      { tool: 'bash', args: { command: 'curl -u $STRIPE_KEY: https://api.stripe.com/v1/charges', keys: ['STRIPE_KEY'] } },
      { tool: 'bash', args: { command: 'ls' } }
    ])
    expect(seen.tools.find((t) => t.name === 'bash')?.inputSchema.properties?.['keys']?.description).toContain('STRIPE_KEY')
    expect(ran[0]).toMatchObject({ name: 'bash', env: { STRIPE_KEY: 'sk_live_abcdef123456' } })
    expect(ran[1]?.env).toBeUndefined() // the next command, without keys, gets none
    for (const r of seen.results) expect(r).not.toContain('sk_live_abcdef123456')
    expect(seen.results[1]).toContain('[cofre:STRIPE_KEY]') // known from the first use, masked in any later output
    expect(db.vaultUses()).toMatchObject([{ name: 'STRIPE_KEY', agentId: 'lia', via: 'bash' }])
    const steps = db.message(db.messagesWithRun(['done'])[0]?.id ?? '')?.run?.steps ?? []
    expect(steps.some((s) => s.keys?.includes('STRIPE_KEY'))).toBe(true)
  })

  it('a key not given to it doesn’t run, and says which ones it has', async () => {
    await vault.save(owner, { name: 'OTHER_KEY', value: 'other-value-123', agents: ['lia'], approve: false })
    await vault.save(owner, { name: 'STRIPE_KEY', value: 'sk_live_abcdef123456', agents: [], approve: false })
    const seen = await turn([{ tool: 'bash', args: { command: 'echo $STRIPE_KEY', keys: ['STRIPE_KEY'] } }])
    expect(ran).toEqual([])
    expect(seen.results[0]).toContain('OTHER_KEY')
    expect(db.vaultUses()).toEqual([])
  })

  it('a key that asks for approval holds the command, and runs it with the key once approved', async () => {
    await vault.save(owner, { name: 'STRIPE_KEY', value: 'sk_live_abcdef123456', agents: ['lia'], approve: true })
    const seen = await turn([{ tool: 'bash', args: { command: 'curl -u $STRIPE_KEY: https://api.stripe.com', keys: ['STRIPE_KEY'] } }])
    expect(ran).toEqual([])
    expect(seen.results[0]).toContain('NÃO rodou')
    const ap = db.approvals().find((a) => a.state === 'pending')!
    expect(ap.args['keys']).toEqual(['STRIPE_KEY'])
    expect(db.vaultUses()).toEqual([])

    const runner = new Runner({ db, engines: withFakes(scripted({ tools: [], results: [] }, [])), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'v-w-')), gateway, computers: computers as never, vault })
    await runner.decide(ap.id, 'approved')
    await runner.idle()
    expect(ran[0]).toMatchObject({ name: 'bash', env: { STRIPE_KEY: 'sk_live_abcdef123456' } })
    expect(db.vaultUses()).toHaveLength(1)
  })

  it('a service can’t take a key that asks for approval', async () => {
    await vault.save(owner, { name: 'STRIPE_KEY', value: 'sk_live_abcdef123456', agents: ['lia'], approve: true })
    const seen = await turn([{ tool: 'start_service', args: { name: 'api', command: 'node server.js', port: 3000, keys: ['STRIPE_KEY'] } }])
    expect(ran).toEqual([])
    expect(seen.results[0]).toContain('use essa chave com bash')
  })

  it('without the key, pedir_chave leaves a card; saved there, the agent is told to use it by name', async () => {
    const seen = await turn([{ tool: 'pedir_chave', args: { nome: 'STRIPE_KEY', motivo: 'puxar as cobranças' } }])
    expect(seen.tools.some((t) => t.name === 'pedir_chave')).toBe(true)
    expect(seen.results[0]).toContain('Encerre')
    const ap = db.approvals().find((a) => a.state === 'pending')!
    expect(ap).toMatchObject({ connectorId: 'cofre', tool: 'pedir_chave', args: { nome: 'STRIPE_KEY' }, why: 'puxar as cobranças', requestedBy: db.ownerId() })
    expect(JSON.stringify(ap)).not.toContain('sk_live')

    await vault.answer(owner, 'lia', ap.args, { value: 'sk_live_abcdef123456' })
    const runner = new Runner({ db, engines: withFakes(scripted({ tools: [], results: [] }, [])), settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'v-w-')), gateway, computers: computers as never, vault })
    await runner.decide(ap.id, 'approved', undefined, false, 'owner')
    await runner.idle()
    expect(db.approval(ap.id)).toMatchObject({ state: 'approved', outcome: 'Salvo no Cofre e liberado.' })
    expect(vault.usable('lia', 'owner').map((k) => k.name)).toEqual(['STRIPE_KEY'])
  })

  it('pedir_chave for a key it already has says so, and leaves no card', async () => {
    await vault.save(owner, { name: 'STRIPE_KEY', value: 'sk_live_abcdef123456', agents: ['lia'], approve: false })
    const seen = await turn([{ tool: 'pedir_chave', args: { nome: 'STRIPE_KEY', motivo: 'x' } }])
    expect(seen.results[0]).toContain('já tem')
    expect(db.approvals()).toEqual([])
  })
})
