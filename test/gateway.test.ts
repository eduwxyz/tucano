import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createServer } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, textResult, type ToolDef } from '../src/core/gateway'

const tool = (name: string): ToolDef => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

async function canBind(host: string): Promise<boolean> {
  const probe = createServer()
  return new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.listen(0, host, () => probe.close(() => resolve(true)))
  })
}

let gateway: Gateway
beforeEach(async () => {
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('Gateway', () => {
  it('uses loopback for agent sessions unless WSL needs another host address', async () => {
    await gateway.exposeToWsl()
    expect(gateway.agentTarget()).toMatchObject({ host: '127.0.0.1' })
  })

  it('lists only the tools of the session behind the URL', async () => {
    const a = gateway.open({ tools: [tool('ask_user')], call: async () => textResult('ok') })
    const b = gateway.open({ tools: [tool('list_issues'), tool('create_issue')], call: async () => textResult('ok') })
    const ca = await connect(a.url)
    const cb = await connect(b.url)
    expect((await ca.listTools()).tools.map((t) => t.name)).toEqual(['ask_user'])
    expect((await cb.listTools()).tools.map((t) => t.name)).toEqual(['list_issues', 'create_issue'])
    await Promise.all([ca.close(), cb.close()])
  })

  it('runs listed tools and refuses anything else without calling the session', async () => {
    const calls: string[] = []
    const s = gateway.open({ tools: [tool('list_issues')], call: async (name) => (calls.push(name), textResult(`ran ${name}`)) })
    const client = await connect(s.url)
    expect(await client.callTool({ name: 'list_issues', arguments: {} })).toMatchObject({ content: [{ text: 'ran list_issues' }] })
    expect(await client.callTool({ name: 'merge_pull_request', arguments: {} })).toMatchObject({ isError: true, content: [{ text: 'Ferramenta não permitida: merge_pull_request' }] })
    expect(calls).toEqual(['list_issues'])
    await client.close()
  })

  it('rejects unknown and revoked URLs', async () => {
    const s = gateway.open({ tools: [tool('ask_user')], call: async () => textResult('ok') })
    const base = s.url.replace(/[a-f0-9]{48}$/, '')
    expect((await fetch(`${base}${'0'.repeat(48)}`, { method: 'POST' })).status).toBe(404)
    s.close()
    await expect(connect(s.url)).rejects.toThrow()
  })

  it('exposes agent sessions on a second loopback interface when WSL needs another host address', async ({ skip }) => {
    if (!(await canBind('127.0.0.2'))) return skip()
    await gateway.exposeToWsl('127.0.0.2')
    const session = gateway.open({ tools: [tool('ask_user')], call: async () => textResult('ok') })
    expect(new URL(session.url).hostname).toBe('127.0.0.2')
    const client = await connect(session.url)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['ask_user'])
    await client.close()

    gateway.useWindowsHost()
    expect(new URL(gateway.open({ tools: [], call: async () => textResult('ok') }).url).hostname).toBe('127.0.0.1')
  })
})
