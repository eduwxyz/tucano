// A connector tool that fails must say why: in the reply's step, where the person sees it, and in the
// result the agent gets. Through the real pieces (a stdio MCP server, the connector manager, the gateway
// and the runner); only the model is scripted, calling one tool like a CLI would.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Message, Settings } from '../src/shared/types'
import { callError, ConnectorManager, errorReason, GOOGLE_PREVIEW_URL, googlePreviewHint } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'

const sdk = pathToFileURL(resolve('node_modules/@modelcontextprotocol/sdk/dist/esm')).href
const ready = { installed: true, loggedIn: true }

// A SQL tool like Databricks' that fails in every way a server can: the statement picks the way.
const SERVER = `const { Server } = await import('${sdk}/server/index.js')
const { StdioServerTransport } = await import('${sdk}/server/stdio.js')
const { ListToolsRequestSchema, CallToolRequestSchema, McpError } = await import('${sdk}/types.js')
const s = new Server({ name: 'sql', version: '1' }, { capabilities: { tools: {} } })
const input = { type: 'object', properties: { statement: { type: 'string' } }, required: ['statement'] }
s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'execute_sql_read_only', description: 'Runs a read-only SQL statement.', inputSchema: input, annotations: { readOnlyHint: true } },
  { name: 'query_typed', description: 'Runs SQL, typed output.', inputSchema: input, annotations: { readOnlyHint: true },
    outputSchema: { type: 'object', properties: { rows: { type: 'array' } }, required: ['rows'] } }
] }))
s.setRequestHandler(CallToolRequestSchema, async (r) => {
  const q = r.params.arguments.statement
  if (r.params.name === 'query_typed') return { content: [{ type: 'text', text: '3 rows' }], structuredContent: { row_count: 3 } }
  if (q === 'structured') return { isError: true, content: [], structuredContent: { error_code: 'RESOURCE_DOES_NOT_EXIST', message: 'Warehouse abc123 is stopped' } }
  if (q === 'empty') return { isError: true, content: [{ type: 'text', text: '   ' }] }
  if (q === 'resource') return { isError: true, content: [{ type: 'resource', resource: { uri: 'sql://error', text: 'TABLE_OR_VIEW_NOT_FOUND: main.sales.orders' } }] }
  if (q === 'throw') throw new McpError(-32603, 'Statement failed', { error_code: 'PERMISSION_DENIED', message: 'User does not have SELECT on main.sales' })
  if (q === 'slow') await new Promise((ok) => setTimeout(ok, 3000))
  if (q.startsWith('select region')) {
    await new Promise((ok) => setTimeout(ok, 400))
    return { content: [{ type: 'text', text: 'region,total\\nSul,120\\nSudeste,340' }] }
  }
  return { content: [{ type: 'text', text: 'id\\n1\\n2' }] }
})
await s.connect(new StdioServerTransport())`

let dir: string
let db: Db
let gateway: Gateway
let connectors: ConnectorManager
let connectorId: string
let settings: Settings
let results: { text: string; isError?: boolean }[]
let events: CoreEvent[]

// A "model" that calls the SQL tool once with the statement in the message, and says what it got.
function sqlModel(tool = 'execute_sql_read_only'): Engine {
  return {
    id: 'claude',
    async *run(turn) {
      let reply = 'ok'
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        const name = (await client.listTools()).tools.map((t) => t.name).find((t) => t.endsWith(`__${tool}`))!
        const statement = /`([^`]+)`/.exec(turn.prompt)?.[1] ?? 'select 1'
        const r = (await client.callTool({ name, arguments: { statement } })) as { content: { type: string; text?: string }[]; isError?: boolean }
        results.push({ text: r.content.map((c) => c.text ?? '').join('\n'), isError: r.isError })
        await client.close()
        reply = 'feito'
      }
      yield { type: 'text', delta: reply }
      yield { type: 'done', text: reply, usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

const agent: () => Agent = () => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: { [connectorId]: 'read' }, memory: 'auto', computer: false, archived: false
})

async function ask(statement: string, tool?: string): Promise<{ step: NonNullable<Message['run']>['steps'][number]; result: { text: string; isError?: boolean } }> {
  const runner = new Runner({
    db,
    engines: { claude: sqlModel(tool), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
    settings: async () => settings,
    emit: (e) => events.push(e),
    workDir: join(dir, 'work'),
    gateway,
    connectors
  })
  await runner.send('d1', `rode \`${statement}\``)
  await runner.idle()
  const reply = db.messages().filter((m) => m.author.kind === 'agent').at(-1)!
  const step = reply.run!.steps.find((s) => s.detail?.includes(tool ?? 'execute_sql_read_only'))!
  return { step, result: results.at(-1)! }
}

beforeEach(async () => {
  setLang('en')
  dir = mkdtempSync(join(tmpdir(), 'tucano-conn-errors-'))
  db = new Db(join(dir, 'test.db'))
  results = []
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  gateway = new Gateway()
  await gateway.start()
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback'), callTimeoutMs: 1000 })
  const script = join(dir, 'server.mjs')
  writeFileSync(script, SERVER)
  connectorId = await connectors.add({ kind: 'stdio', name: 'Databricks', command: process.execPath, args: [script] })
  await connectors.connect(connectorId)
  db.saveAgent(agent())
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await connectors.closeAll()
  await gateway.stop()
  db.close()
  setLang('pt')
})

describe('a connector tool that fails shows why, in the step and to the agent', () => {
  it('an error result whose reason is only in structuredContent', async () => {
    const { step, result } = await ask('structured')
    expect(step.status).toBe('error')
    expect(step.error).toContain('Warehouse abc123 is stopped')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Warehouse abc123 is stopped')
  }, 20_000)

  it('an error result with no text at all says so instead of nothing', async () => {
    const { step, result } = await ask('empty')
    expect(step.status).toBe('error')
    expect(step.error).toMatch(/no message/)
    expect(result.text).toMatch(/no message/)
  }, 20_000)

  it('an error result whose text is in an embedded resource', async () => {
    const { step, result } = await ask('resource')
    expect(step.error).toContain('TABLE_OR_VIEW_NOT_FOUND: main.sales.orders')
    expect(result.text).toContain('TABLE_OR_VIEW_NOT_FOUND')
  }, 20_000)

  it('an MCP error thrown by the server keeps the data it came with', async () => {
    const { step, result } = await ask('throw')
    expect(step.status).toBe('error')
    expect(step.error).toMatch(/^Statement failed \(code -32603\)/)
    expect(step.error).toContain('User does not have SELECT on main.sales')
    expect(result.isError).toBe(true)
    expect(result.text).toContain('PERMISSION_DENIED')
  }, 20_000)

  it('a call the server never answers says how long it waited', async () => {
    const { step, result } = await ask('slow')
    expect(step.status).toBe('error')
    expect(step.error).toMatch(/didn't answer in 1 s/)
    expect(result.text).toMatch(/didn't answer in 1 s/)
  }, 20_000)

  it("a result that doesn't match the tool's own output schema says that, not just 'failed'", async () => {
    const { step } = await ask('select 1', 'query_typed')
    expect(step.status).toBe('error')
    expect(step.error).toMatch(/output schema/)
  }, 20_000)

  it('a call that works has no error on its step', async () => {
    const { step, result } = await ask('select id from t')
    expect(step.status).toBe('done')
    expect(step.error).toBeUndefined()
    expect(result.text).toContain('id')
  }, 20_000)
})

describe('callError and errorReason', () => {
  it('turn what a call threw, or an error result, into a reason', () => {
    expect(callError(new McpError(ErrorCode.RequestTimeout, 'Request timed out'), 120_000)).toMatch(/120 s/)
    expect(callError(new McpError(-32603, 'Boom', 'stack here'))).toBe('Boom (code -32603): stack here')
    expect(callError(new Error('fetch failed'))).toBe('fetch failed')
    expect(errorReason({ content: [{ type: 'text', text: 'bad SQL' }] })).toBe('bad SQL')
    expect(errorReason({ content: [] })).toMatch(/no message/)
  })
})

describe("Google's Developer Preview error", () => {
  const raw = 'Access to this tool requires that your Google Cloud project (123456789012) is enrolled in the Google Workspace Developer Preview Program.'
  it('says it is a step in the person’s own Google Cloud project, not something to retry or ask the Tuca for', () => {
    setLang('en')
    const hint = googlePreviewHint('https://gmailmcp.googleapis.com/mcp/v1', raw)!
    expect(hint).toContain(GOOGLE_PREVIEW_URL)
    expect(hint).toMatch(/only the person can do/)
    expect(hint).toMatch(/few days/)
    expect(hint).toMatch(/Neither you nor the Tuca can fix this/)
    setLang('pt')
    expect(googlePreviewHint('https://sheetsmcp.googleapis.com/mcp/v1', raw)).toMatch(/só a pessoa pode fazer/)
  })

  it("leaves other servers' errors, and Google's other errors, as they are", () => {
    expect(googlePreviewHint('https://mcp.linear.app/mcp', raw)).toBeUndefined()
    expect(googlePreviewHint('https://evil.example/googleapis.com', raw)).toBeUndefined()
    expect(googlePreviewHint('https://gmailmcp.googleapis.com/mcp/v1', 'Requested entity was not found.')).toBeUndefined()
    expect(googlePreviewHint(undefined, raw)).toBeUndefined()
  })
})

describe('a connector step reads as it goes', () => {
  it('shows the SQL while it runs, and the result in a few words when it is done', async () => {
    const sql = 'select region, sum(total) from main.sales.orders group by 1'
    const { step } = await ask(sql)
    const running = events
      .flatMap((e) => (e.type === 'message' ? (e.message.run?.steps ?? []) : []))
      .find((s) => s.id === step.id && s.status === 'running')
    expect(running?.input).toBe(sql) // already there before the server answered
    expect(running?.output).toBeUndefined()
    expect(step).toMatchObject({ status: 'done', input: sql, output: '2 rows' })
  }, 20_000)

  it('a failed call keeps what it asked, and its reason instead of a result', async () => {
    const { step } = await ask('structured')
    expect(step).toMatchObject({ status: 'error', input: 'structured' })
    expect(step.output).toBeUndefined()
    expect(step.error).toContain('Warehouse abc123 is stopped')
  }, 20_000)
})
