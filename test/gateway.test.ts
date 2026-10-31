import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, textResult, type ToolDef } from '../src/core/gateway'
import { setLang } from '../src/shared/lang'

// The app speaks both; assert the English side of its messages.
setLang('en')

const tool = (name: string): ToolDef => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })

async function connect(url: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

let gateway: Gateway
beforeEach(async () => {
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('Gateway', () => {
  it('gives an agent one stable URL, and lists the tools of the current turn', async () => {
    gateway.agentTurn('iris', { tools: [tool('ask_user')], call: async () => textResult('ok') })
    const url = gateway.agentUrl('iris')
    gateway.agentTurn('rafa', { tools: [tool('list_issues'), tool('create_issue')], call: async () => textResult('ok') })
    const ci = await connect(url)
    expect(gateway.agentUrl('iris')).toBe(url) // stable across turns
    expect((await ci.listTools()).tools.map((t) => t.name)).toEqual(['ask_user'])
    // next turn swaps the tools under the same URL
    gateway.agentTurn('iris', { tools: [tool('bash')], call: async () => textResult('ok') })
    expect((await ci.listTools()).tools.map((t) => t.name)).toEqual(['bash'])
    await ci.close()
    const cr = await connect(gateway.agentUrl('rafa'))
    expect((await cr.listTools()).tools.map((t) => t.name)).toEqual(['list_issues', 'create_issue'])
    await cr.close()
  })

  it('runs listed tools and refuses anything else without calling the agent', async () => {
    const calls: string[] = []
    gateway.agentTurn('iris', { tools: [tool('list_issues')], call: async (name) => (calls.push(name), textResult(`ran ${name}`)) })
    const client = await connect(gateway.agentUrl('iris'))
    expect(await client.callTool({ name: 'list_issues', arguments: {} })).toMatchObject({ content: [{ text: 'ran list_issues' }] })
    expect(await client.callTool({ name: 'merge_pull_request', arguments: {} })).toMatchObject({ isError: true, content: [{ text: 'Tool not allowed: merge_pull_request' }] })
    expect(calls).toEqual(['list_issues'])
    await client.close()
  })

  it('rejects unknown tokens and stops serving a forgotten agent', async () => {
    gateway.agentTurn('iris', { tools: [tool('ask_user')], call: async () => textResult('ok') })
    const base = gateway.agentUrl('iris').replace(/[a-f0-9]{48}$/, '')
    expect((await fetch(`${base}${'0'.repeat(48)}`, { method: 'POST' })).status).toBe(404)
    gateway.agentForget('iris')
    await expect(connect(gateway.agentUrl('iris'))).rejects.toThrow()
  })
})
