// Composio's runners (COMPOSIO_MULTI_EXECUTE_TOOL and the like) run whatever action they're handed, so
// each call counts as what it runs: reads go through on a read grant, a send asks for approval, anything
// not understood is sensitive. The rules, then the runner with a scripted model and a stand-in server.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { innerActions, isComposio, MANAGE_CONNECTIONS, MULTI_EXECUTE, perCallTool, PROXY_EXECUTE } from '../src/shared/composio'
import type { Agent, Connector, GrantLevel, Settings } from '../src/shared/types'
import { callClass, classify, classifyAction, runnerAllowed, runnerRules } from '../src/core/policy'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const URL_ = 'https://connect.composio.dev/mcp'
const multi = { name: MULTI_EXECUTE, cls: classify({ name: MULTI_EXECUTE }) }
const batch = (...slugs: string[]): Record<string, unknown> => ({ tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })), sync_response_to_workbench: false })
const withAccount = (slug: string, account: unknown): Record<string, unknown> => ({ tools: [{ tool_slug: slug, arguments: {}, account }] })
const proxy = (method: string, endpoint = '/user/repos', more: Record<string, unknown> = {}): Record<string, unknown> => ({ toolkit_slug: 'github', endpoint, method, ...more })
const of = (args: unknown, name = MULTI_EXECUTE): string => callClass({ name, cls: 'sensitive' }, URL_, args as Record<string, unknown>)

describe('what a Composio call runs, and its class', () => {
  it('reads the slugs, skipping the toolkit for the read verb, with a sensitive word anywhere winning', () => {
    expect(of(batch('GMAIL_FETCH_EMAILS', 'GOOGLESHEETS_GET_SPREADSHEET_INFO', 'NOTION_SEARCH_NOTION_PAGE'))).toBe('read')
    expect(of(batch('GMAIL_CREATE_EMAIL_DRAFT'))).toBe('write')
    expect(of(batch('GMAIL_SEND_EMAIL'))).toBe('sensitive')
    expect(of(batch('GMAIL_FETCH_AND_DELETE_EMAILS'))).toBe('sensitive') // a read verb first doesn't save it
    expect(of(batch('gmail_fetch_emails'))).toBe('read') // same words, whatever the case
    expect(of(batch('FETCH_GMAIL_SEND'))).toBe('sensitive')
    expect(of(batch('GET_ISSUES'))).toBe('write') // "GET" is the toolkit here: no read verb after it
  })

  it('takes the strictest action in a batch', () => {
    expect(of(batch('GMAIL_FETCH_EMAILS', 'GMAIL_CREATE_EMAIL_DRAFT'))).toBe('write')
    expect(of(batch('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'))).toBe('sensitive')
  })

  it("treats Composio's own tools and code runners inside a call as sensitive", () => {
    expect(of(batch('COMPOSIO_REMOTE_BASH_TOOL'))).toBe('sensitive')
    expect(of(batch('COMPOSIO_SEARCH_TOOLS'))).toBe('sensitive')
    expect(of(batch('CODEINTERPRETER_EXECUTE_CODE'))).toBe('sensitive')
    expect(of(batch('GITHUB_RUN_WORKFLOW'))).toBe('sensitive')
  })

  it('fails closed on anything but the documented shape', () => {
    for (const bad of [
      undefined,
      {},
      { tools: [] },
      { tools: 'GMAIL_FETCH_EMAILS' },
      { tools: JSON.stringify([{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }]) }, // a JSON string, not the list
      { tools: [[{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }]] }, // nested
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }] }, // no arguments
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: '{}' }] },
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {}, tool: 'GMAIL_SEND_EMAIL' }] }, // an extra field
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }], then: 'GMAIL_SEND_EMAIL' },
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }], thought: { tool_slug: 'GMAIL_SEND_EMAIL' } }, // a note that isn't one
      { tools: [{ tool_slug: 'GMAIL', arguments: {} }] }, // no action in it
      { tools: [{ tool_slug: ' GMAIL_FETCH_EMAILS', arguments: {} }] },
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAİLS', arguments: {} }] }, // a look-alike letter
      { tools: [{ tool_slug: 'GMAIL__FETCH_EMAILS', arguments: {} }] },
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS,GMAIL_SEND_EMAIL', arguments: {} }] },
      { tools: [{ tool_slug: 42, arguments: {} }] },
      ...['', '   ', 42, null, true, {}, ['work']].map((account) => withAccount('GMAIL_FETCH_EMAILS', account)), // an account that isn't a name
      { tools: Array.from({ length: 51 }, () => ({ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} })) }
    ])
      expect(of(bad), JSON.stringify(bad)).toBe('sensitive')
    expect(innerActions(MULTI_EXECUTE, { tools: [{ tool_slug: 'X_GET_Y', arguments: {} }], thought: 'why', current_step: 'FETCHING', session_id: 's1' })).toEqual([{ kind: 'tool', slug: 'X_GET_Y' }])
  })

  it('knows which account an item runs as, and a read runs the same with or without it', () => {
    expect(innerActions(MULTI_EXECUTE, withAccount('GMAIL_FETCH_EMAILS', 'work'))).toEqual([{ kind: 'tool', slug: 'GMAIL_FETCH_EMAILS', account: 'work' }])
    expect(of(withAccount('GMAIL_FETCH_EMAILS', 'work'))).toBe('read')
    expect(innerActions(MULTI_EXECUTE, withAccount('GMAIL_FETCH_EMAILS', ' work '))).toEqual([{ kind: 'tool', slug: 'GMAIL_FETCH_EMAILS', account: ' work ' }]) // verbatim, as it runs
    expect(of(withAccount('GMAIL_CREATE_EMAIL_DRAFT', 'work'))).toBe('write')
    expect(of(withAccount('GMAIL_SEND_EMAIL', 'work'))).toBe('sensitive')
  })

  it('judges the older single runner the same way', () => {
    expect(of({ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }, 'COMPOSIO_EXECUTE_TOOL')).toBe('read')
    expect(of({ tool_slug: 'GMAIL_SEND_EMAIL', arguments: {} }, 'COMPOSIO_EXECUTE_TOOL')).toBe('sensitive')
    expect(of({ tool_slug: 'GMAIL_FETCH_EMAILS' }, 'COMPOSIO_EXECUTE_TOOL')).toBe('sensitive')
  })

  it('judges a raw request by its method, and a GET that names a change as a write', () => {
    expect(of(proxy('GET'), PROXY_EXECUTE)).toBe('read')
    expect(of(proxy('HEAD'), PROXY_EXECUTE)).toBe('read')
    expect(of(proxy('GET', '/repos/a/b/issues?state=open'), PROXY_EXECUTE)).toBe('read') // a value is a search, not a change
    expect(of(proxy('POST'), PROXY_EXECUTE)).toBe('write')
    expect(of(proxy('PATCH'), PROXY_EXECUTE)).toBe('write')
    expect(of(proxy('DELETE'), PROXY_EXECUTE)).toBe('sensitive')
    expect(of(proxy('GET', '/api/chat.postMessage'), PROXY_EXECUTE)).toBe('write') // RPC over GET
    expect(of(proxy('GET', '/api/chat.delete'), PROXY_EXECUTE)).toBe('sensitive')
    expect(of(proxy('GET', '/x', { parameters: [{ name: 'X-HTTP-Method-Override', value: 'DELETE', type: 'header' }] }), PROXY_EXECUTE)).toBe('sensitive')
    expect(of(proxy('GET', '/x', { parameters: [{ name: 'X-HTTP-Method-Override', value: 'PUT', type: 'header' }] }), PROXY_EXECUTE)).toBe('write')
    expect(of(proxy('GET', '/x', { body: { a: 1 } }), PROXY_EXECUTE)).toBe('write')
    expect(of(proxy('GET', '/legacy?action=create&id=1'), PROXY_EXECUTE)).toBe('write') // the operation in a query value
    expect(of(proxy('GET', '/legacy', { parameters: [{ name: 'Op', value: 'post', type: 'query' }] }), PROXY_EXECUTE)).toBe('write')
    expect(of(proxy('GET', '/x?then=remove'), PROXY_EXECUTE)).toBe('sensitive') // a sensitive word anywhere
    expect(of(proxy('GET', '/v1/tools', { toolkit_slug: 'composio' }), PROXY_EXECUTE)).toBe('sensitive') // Composio's own API
    expect(of(proxy('GET', '/x', { toolkit_slug: 'git hub' }), PROXY_EXECUTE)).toBe('sensitive')
    expect(of(proxy('get'), PROXY_EXECUTE)).toBe('sensitive') // not a documented method
    expect(of(proxy('GET', '/x', { parameters: [{ name: 'q', value: 'a', type: 'cookie' }] }), PROXY_EXECUTE)).toBe('sensitive')
    expect(of(proxy('GET', '/x', { extra: 1 }), PROXY_EXECUTE)).toBe('sensitive')
  })

  it('applies only to the runners on Composio itself; elsewhere, those names stay sensitive', () => {
    expect(isComposio(URL_)).toBe(true)
    expect(isComposio('https://backend.composio.dev/tool_router/x/mcp')).toBe(true)
    expect(isComposio('https://composio.dev.evil.com/mcp')).toBe(false)
    expect(isComposio('http://connect.composio.dev/mcp')).toBe(false)
    expect(perCallTool(URL_, 'COMPOSIO_REMOTE_BASH_TOOL')).toBe(false) // code: always sensitive
    expect(perCallTool(URL_, 'composio_multi_execute_tool')).toBe(false) // only the exact name
    expect(callClass(multi, 'https://mcp.example.com/mcp', batch('GMAIL_FETCH_EMAILS'))).toBe('sensitive')
    expect(callClass({ name: 'list_issues', cls: 'read' }, URL_, {})).toBe('read') // any other tool keeps its class
    expect(classifyAction({ kind: 'tool', slug: 'SLACK_LIST_CHANNELS' })).toBe('read')
  })
})

// ---- Through the runner ----

const ready = { installed: true, loggedIn: true }
type Plan = { tool: string; args: Record<string, unknown> } | null
let dir: string
let db: Db
let gateway: Gateway
let settings: Settings
let calls: { name: string; args: Record<string, unknown> }[]
let seen: { prompts: string[]; tools: string[][]; results: CallToolResult[] }
const CID = 'cmp'
const SID = 'slk' // a direct connector, for the outbound defaults

const composio = (): Connector => ({ id: CID, name: 'Composio', kind: 'remote', url: URL_, auth: 'oauth', status: 'connected', tools: db.tools(CID) })
const agent = (grant: GrantLevel, autoApprove: string[] = []): Agent => ({
  id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: { [CID]: grant, [SID]: grant }, memory: 'auto', computer: false, archived: false, autoApprove
})

function scripted(plan: (prompt: string, tools: string[]) => Plan): Engine {
  return {
    id: 'claude',
    async *run(turn: Turn) {
      seen.prompts.push(turn.prompt)
      if (turn.mcpUrl) {
        const client = new Client({ name: 'scripted', version: '0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcpUrl)))
        const tools = (await client.listTools()).tools.map((t) => t.name)
        seen.tools.push(tools)
        const p = plan(turn.prompt, tools)
        if (p) seen.results.push((await client.callTool({ name: p.tool, arguments: p.args })) as CallToolResult)
        await client.close()
      }
      yield { type: 'text', delta: 'ok' }
      yield { type: 'done', text: 'ok', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

function runner(plan: (prompt: string, tools: string[]) => Plan): Runner {
  return new Runner({
    db,
    engines: { claude: scripted(plan), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') },
    settings: async () => settings,
    emit: () => {},
    workDir: join(dir, 'work'),
    gateway,
    connectors: {
      list: () => [composio(), { id: SID, name: 'Slack', kind: 'remote', url: 'https://mcp.slack.com/mcp', auth: 'oauth', status: 'connected', tools: db.tools(SID) }],
      call: async (_id, name, args) => (calls.push({ name, args }), { content: [{ type: 'text', text: `ran ${name}` }] })
    }
  })
}

const once = (args: Record<string, unknown>) => (prompt: string, tools: string[]): Plan =>
  prompt.includes('aprovou') || prompt.includes('recusou') ? null : { tool: tools.find((t) => t.endsWith(`__${MULTI_EXECUTE}`)) ?? `composio__${MULTI_EXECUTE}`, args }
const textOf = (r: CallToolResult | undefined): string => (r?.content[0] as { text?: string } | undefined)?.text ?? ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ad-composio-'))
  db = new Db(join(dir, 'test.db'))
  calls = []
  seen = { prompts: [], tools: [], results: [] }
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  gateway = new Gateway()
  await gateway.start()
  db.saveConnector({ id: CID, name: 'Composio', kind: 'remote', url: URL_, auth: 'oauth' })
  const schema = { type: 'object', properties: {} }
  db.syncTools(CID, [
    { name: MULTI_EXECUTE, description: 'Runs tools.', inputSchema: schema, cls: classify({ name: MULTI_EXECUTE, annotations: { destructiveHint: true } }) },
    { name: 'COMPOSIO_SEARCH_TOOLS', description: 'Finds tools.', inputSchema: schema, cls: classify({ name: 'COMPOSIO_SEARCH_TOOLS', annotations: { readOnlyHint: true } }) },
    { name: 'COMPOSIO_REMOTE_BASH_TOOL', description: 'Runs bash.', inputSchema: schema, cls: classify({ name: 'COMPOSIO_REMOTE_BASH_TOOL' }) },
    { name: MANAGE_CONNECTIONS, description: 'Links accounts.', inputSchema: schema, cls: 'sensitive' }
  ])
  db.saveConnector({ id: SID, name: 'Slack', kind: 'remote', url: 'https://mcp.slack.com/mcp', auth: 'oauth' })
  db.syncTools(SID, ['chat_post_message', 'conversations_history'].map((name) => ({ name, description: name, inputSchema: schema, cls: classify({ name }) })))
  db.saveAgent(agent('none'))
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

afterEach(async () => {
  await gateway.stop()
})

describe('a Composio call through the runner', () => {
  it('a read grant sees the runner (not bash) and runs a batch of reads right away', async () => {
    db.saveAgent(agent('read'))
    const r = runner(once(batch('GMAIL_FETCH_EMAILS', 'GOOGLESHEETS_GET_SPREADSHEET_INFO')))
    await r.send('d1', 'lê meus e-mails')
    await r.idle()
    expect(seen.tools[0]).toEqual(expect.arrayContaining([`composio__${MULTI_EXECUTE}`, 'composio__COMPOSIO_SEARCH_TOOLS']))
    expect(seen.tools[0]!.some((t) => t.includes('BASH'))).toBe(false)
    expect(calls).toEqual([{ name: MULTI_EXECUTE, args: batch('GMAIL_FETCH_EMAILS', 'GOOGLESHEETS_GET_SPREADSHEET_INFO') }])
    expect(db.approvals()).toHaveLength(0)
    expect(db.messages().find((m) => m.author.kind === 'agent')?.run?.steps.map((s) => s.label)).toContain('Consultou')
  })

  it('a read grant sees the account linking, which asks every time and runs once approved', async () => {
    // Even with a rule for it and the agent let loose, a reader asks.
    db.saveAgent({ ...agent('read', [`${CID}:${MANAGE_CONNECTIONS}`]), autonomy: 'free' })
    const link = { toolkits: ['googlecalendar'] }
    const r = runner((prompt, tools) => (prompt.includes('aprovou') ? null : { tool: tools.find((t) => t.endsWith(`__${MANAGE_CONNECTIONS}`))!, args: link }))
    await r.send('d1', 'liga minha agenda')
    await r.idle()
    expect(seen.tools[0]).toContain(`composio__${MANAGE_CONNECTIONS}`)
    expect(calls).toHaveLength(0)
    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', tool: MANAGE_CONNECTIONS, args: link })
    await r.decide(ap!.id, 'approved')
    await r.idle()
    expect(calls).toEqual([{ name: MANAGE_CONNECTIONS, args: link }])
  })

  it('a reader still sees no other sensitive Composio tool', async () => {
    db.saveAgent(agent('read'))
    const r = runner(() => null)
    await r.send('d1', 'oi')
    await r.idle()
    expect(seen.tools[0]!.some((t) => t.includes('BASH'))).toBe(false)
  })

  it('a read grant is refused a write inside the batch, and nothing runs', async () => {
    db.saveAgent(agent('read'))
    const r = runner(once(batch('GMAIL_FETCH_EMAILS', 'GMAIL_CREATE_EMAIL_DRAFT')))
    await r.send('d1', 'rascunha')
    await r.idle()
    expect(seen.results[0]).toMatchObject({ isError: true })
    expect(textOf(seen.results[0])).toContain('leitura e escrita')
    expect(calls).toHaveLength(0)
    expect(db.approvals()).toHaveLength(0)
  })

  it('read_write: a write runs; a batch mixing a read and a send asks for approval with exactly its arguments', async () => {
    db.saveAgent(agent('read_write'))
    const w = runner(once(batch('GMAIL_CREATE_EMAIL_DRAFT')))
    await w.send('d1', 'rascunha')
    await w.idle()
    expect(calls).toHaveLength(1)
    expect(db.approvals()).toHaveLength(0)
    calls = []
    const args = { ...batch('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'), _motivo: 'responder o cliente' }
    const r = runner(once(args))
    await r.send('d1', 'responde')
    await r.idle()
    expect(calls).toHaveLength(0)
    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', tool: MULTI_EXECUTE, args: batch('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL'), why: 'responder o cliente' })
    await r.decide(ap!.id, 'approved')
    await r.idle()
    expect(calls).toEqual([{ name: MULTI_EXECUTE, args: batch('GMAIL_FETCH_EMAILS', 'GMAIL_SEND_EMAIL') }]) // the stored call, as approved
  })

  it('an unknown or malformed call asks for approval instead of running', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(once({ tools: JSON.stringify([{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: {} }]) }))
    await r.send('d1', 'lê')
    await r.idle()
    expect(calls).toHaveLength(0)
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', tool: MULTI_EXECUTE })
  })

  it('"always allow" never sticks to the runner itself, even a rule for it already there', async () => {
    db.saveAgent(agent('read_write', [`${CID}:${MULTI_EXECUTE}`])) // even if it got there somehow
    const r = runner(once(batch('GMAIL_SEND_EMAIL')))
    await r.send('d1', 'manda')
    await r.idle()
    expect(calls).toHaveLength(0)
    expect(db.approvals()[0]?.state).toBe('pending')
  })

  it('"always allow" on a batch allows each inner tool that asked, on its own, for this agent', async () => {
    db.saveAgent(agent('read_write'))
    // One batch per message, in order (a prompt carries the history, so it goes by count).
    const plans = [batch('GMAIL_FETCH_EMAILS', 'GMAIL_REPLY_TO_THREAD'), batch('gmail_reply_to_thread', 'GMAIL_FETCH_EMAILS'), batch('GMAIL_REPLY_TO_THREAD', 'GMAIL_SEND_EMAIL')]
    const r = runner((prompt, tools) => (prompt.includes('aprovou') ? null : { tool: tools.find((t) => t.endsWith(`__${MULTI_EXECUTE}`))!, args: plans.shift()! }))
    await r.send('d1', 'primeira')
    await r.idle()
    const ap = db.approvals()[0]!
    await r.decide(ap.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')?.autoApprove).toEqual([`${CID}:GMAIL_REPLY_TO_THREAD`]) // the inner tool, not the runner
    expect(calls).toHaveLength(1)

    await r.send('d1', 'segunda')
    await r.idle()
    expect(calls).toHaveLength(2) // ran without asking
    expect(db.approvals()).toHaveLength(1)

    await r.send('d1', 'terceira') // a reply and a send: the send still asks, so the whole call does
    await r.idle()
    expect(calls).toHaveLength(2)
    expect(db.approvals().filter((a) => a.state === 'pending')).toHaveLength(1)
  })

  it('"always allow" for an item that names an account is for that account only', () => {
    const work = withAccount('GMAIL_SEND_EMAIL', 'work')
    expect(runnerRules(CID, MULTI_EXECUTE, work)).toEqual([`${CID}:GMAIL_SEND_EMAIL@work`])
    expect(runnerRules(CID, MULTI_EXECUTE, withAccount('GMAIL_FETCH_EMAILS', 'work'))).toBeUndefined() // a read has nothing to allow
    expect(runnerAllowed(CID, MULTI_EXECUTE, work, [`${CID}:GMAIL_SEND_EMAIL@work`])).toBe(true)
    expect(runnerAllowed(CID, MULTI_EXECUTE, work, [`${CID}:GMAIL_SEND_EMAIL@personal`])).toBe(false)
    expect(runnerAllowed(CID, MULTI_EXECUTE, withAccount('GMAIL_SEND_EMAIL', ' work '), [`${CID}:GMAIL_SEND_EMAIL@work`])).toBe(false) // no trimming to match
    expect(runnerAllowed(CID, MULTI_EXECUTE, work, [`${CID}:GMAIL_SEND_EMAIL`])).toBe(false) // a rule without account doesn't cover an account
    expect(runnerAllowed(CID, MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL'), [`${CID}:GMAIL_SEND_EMAIL@work`])).toBe(false) // nor the other way round
    expect(runnerAllowed(CID, MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL'), [`${CID}:GMAIL_SEND_EMAIL`])).toBe(true) // saved before accounts existed
  })

  it('a read with an account runs at once; a send with one asks, and "always" is saved for that account', async () => {
    db.saveAgent(agent('read_write'))
    const plans = [withAccount('GMAIL_FETCH_EMAILS', 'work'), withAccount('GMAIL_SEND_EMAIL', 'work'), withAccount('GMAIL_SEND_EMAIL', 'work'), withAccount('GMAIL_SEND_EMAIL', 'personal')]
    const r = runner((prompt, tools) => (prompt.includes('aprovou') ? null : { tool: tools.find((t) => t.endsWith(`__${MULTI_EXECUTE}`))!, args: plans.shift()! }))
    await r.send('d1', 'le')
    await r.idle()
    expect(calls).toHaveLength(1)
    expect(db.approvals()).toHaveLength(0)

    await r.send('d1', 'manda')
    await r.idle()
    const ap = db.approvals()[0]!
    expect(ap.state).toBe('pending')
    await r.decide(ap.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')?.autoApprove).toEqual([`${CID}:GMAIL_SEND_EMAIL@work`])
    expect(calls).toHaveLength(2)

    await r.send('d1', 'de novo') // same account: runs alone
    await r.idle()
    expect(calls).toHaveLength(3)

    await r.send('d1', 'outra conta') // another account: asks
    await r.idle()
    expect(calls).toHaveLength(3)
    expect(db.approvals().filter((a) => a.state === 'pending')).toHaveLength(1)
  })

  it('a code tool called directly is never allowed for good, even with a rule saved for it', async () => {
    const rule = `${CID}:COMPOSIO_REMOTE_BASH_TOOL`
    db.saveAgent(agent('read_write', [rule]))
    const bash = (prompt: string, tools: string[]): Plan => (prompt.includes('aprovou') ? null : { tool: tools.find((t) => t.endsWith('__COMPOSIO_REMOTE_BASH_TOOL'))!, args: { command: 'ls' } })
    const r = runner(bash)
    await r.send('d1', 'roda')
    await r.idle()
    expect(calls).toHaveLength(0) // the saved rule isn't honoured
    const ap = db.approvals()[0]!
    expect(ap.state).toBe('pending')
    await r.decide(ap.id, 'approved', undefined, true)
    await r.idle()
    expect(calls).toHaveLength(1)
    expect(db.agent('a1')?.autoApprove).toEqual([rule]) // and "always" adds nothing
  })

  it('a raw request, a call not understood, code and a high-risk runner are never allowed for good', async () => {
    const rules = [`${CID}:GMAIL_SEND_EMAIL`, `${CID}:COMPOSIO_REMOTE_BASH_TOOL`, `${CID}:${PROXY_EXECUTE}`]
    expect(runnerRules(CID, PROXY_EXECUTE, proxy('DELETE'))).toBeUndefined()
    expect(runnerRules(CID, MULTI_EXECUTE, { tools: 'GMAIL_SEND_EMAIL' })).toBeUndefined()
    expect(runnerRules(CID, MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL', 'COMPOSIO_REMOTE_BASH_TOOL'))).toBeUndefined()
    expect(runnerRules(CID, MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL', 'CODEINTERPRETER_EXECUTE_CODE'))).toBeUndefined()
    expect(runnerRules(CID, MULTI_EXECUTE, batch('GMAIL_FETCH_EMAILS'))).toBeUndefined() // nothing to allow
    expect(runnerAllowed(CID, MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL', 'COMPOSIO_REMOTE_BASH_TOOL'), rules)).toBe(false)
    expect(runnerAllowed(CID, PROXY_EXECUTE, proxy('DELETE'), rules)).toBe(false)
    expect(runnerAllowed(CID, MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL'), rules)).toBe(true)
    expect(runnerAllowed('other', MULTI_EXECUTE, batch('GMAIL_SEND_EMAIL'), rules)).toBe(false) // per connector

    // High risk on the runner: an allowed action still asks, and "always" adds nothing.
    db.saveAgent(agent('read_write', [`${CID}:GMAIL_SEND_EMAIL`]))
    db.updateTool(CID, MULTI_EXECUTE, { highRisk: true })
    const r = runner(once(batch('GMAIL_SEND_EMAIL')))
    await r.send('d1', 'manda')
    await r.idle()
    expect(calls).toHaveLength(0)
    const ap = db.approvals()[0]!
    expect(ap).toMatchObject({ state: 'pending', highRisk: true })
    db.saveAgent(agent('read_write'))
    await r.decide(ap.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')?.autoApprove ?? []).toEqual([])
  })

  it('an approved call whose grant dropped to read no longer runs a send', async () => {
    db.saveAgent(agent('read_write'))
    const r = runner(once(batch('GMAIL_SEND_EMAIL')))
    await r.send('d1', 'manda')
    await r.idle()
    db.saveAgent(agent('read'))
    await r.decide(db.approvals()[0]!.id, 'approved')
    await r.idle()
    expect(calls).toHaveLength(0)
    expect(db.approvals()[0]?.outcome).toMatch(/Não executou/)
  })
})

describe('sends and posts ask by default, and the person can change that', () => {
  const post = (prompt: string, tools: string[]): Plan => (prompt.includes('aprovou') ? null : { tool: tools.find((t) => t.endsWith('__chat_post_message'))!, args: { channel: 'C1', text: 'oi' } })

  it('a post asks; "always allow" then lets this agent post without asking', async () => {
    db.saveAgent(agent('read_write'))
    expect(db.tools(SID).find((t) => t.name === 'chat_post_message')?.cls).toBe('sensitive')
    const r = runner(post)
    await r.send('d1', 'avisa no canal')
    await r.idle()
    expect(calls).toHaveLength(0)
    await r.decide(db.approvals()[0]!.id, 'approved', undefined, true)
    await r.idle()
    expect(db.agent('a1')?.autoApprove).toEqual([`${SID}:chat_post_message`])
    await r.send('d1', 'avisa de novo')
    await r.idle()
    expect(calls).toHaveLength(2)
    expect(db.approvals()).toHaveLength(1)
  })

  it('a post set to "write" by hand runs right away, and stays so when the tools are refreshed', async () => {
    db.saveAgent(agent('read_write'))
    db.updateTool(SID, 'chat_post_message', { cls: 'write' })
    db.syncTools(SID, ['chat_post_message', 'conversations_history'].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, cls: classify({ name }) })))
    expect(db.tools(SID).find((t) => t.name === 'chat_post_message')?.cls).toBe('write')
    const r = runner(post)
    await r.send('d1', 'avisa no canal')
    await r.idle()
    expect(calls).toHaveLength(1)
    expect(db.approvals()).toHaveLength(0)
  })
})
