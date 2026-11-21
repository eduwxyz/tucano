// The MCP door on a real core (fake engines): a key made in Settings, a harness on 127.0.0.1 setting the
// Tucano up and talking to an agent, and what the person sees of it afterwards.
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Wire } from '../src/shared/rpc'
import type { ActivityEntry, Inbox, Memory } from '../src/shared/types'

const dataDir = mkdtempSync(join(tmpdir(), 'tucano-mcp-'))
const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
const saved = { ...process.env }
afterAll(() => {
  process.env = saved
})
const MCP_PORT = 47993
const BOOT = process.platform === 'win32' ? 60_000 : 20_000

function window(): (method: string, params?: unknown) => Promise<unknown> {
  const handlers: ((m: { data: unknown }) => void)[] = []
  const waits = new Map<number, (r: unknown) => void>()
  const port = {
    on: (ev: string, fn: (m: { data: unknown }) => void) => void (ev === 'message' && handlers.push(fn)),
    start: () => {},
    postMessage: (w: Wire) => {
      if (!('event' in w)) waits.get(w.id)?.('error' in w ? new Error(String(w.error)) : w.result)
    }
  }
  parent.emit('message', { data: undefined, ports: [port] })
  let id = 0
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      waits.set(++id, (r) => (r instanceof Error ? reject(r) : resolve(r)))
      for (const h of handlers) h({ data: { id, method, params } })
    })
}

async function mcp(key: string | undefined, method: string, params: unknown = {}, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  })
  const text = await r.text()
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
}
const tool = async (key: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; data: () => Record<string, unknown> }> => {
  const r = (await mcp(key, 'tools/call', { name, arguments: args })).body as { result?: { content: { text: string }[]; isError?: boolean }; error?: { message: string } }
  const text = r.result?.content[0]?.text ?? r.error?.message ?? ''
  const data = (): Record<string, unknown> => {
    const open = /\nBEGIN CONTENT [0-9a-f]+\n/.exec(text)
    return JSON.parse(open ? text.slice(open.index + open[0].length, text.lastIndexOf('\nEND CONTENT')) : text) as Record<string, unknown>
  }
  return { text, isError: !!r.result?.isError || !!r.error, data }
}

describe('MCP on a real core', () => {
  it('a harness sets the Tucano up and talks to an agent, as the person, within its key', async () => {
    Object.assign(process.env, { TUCANO_DATA: dataDir, TUCANO_DEFAULT_WORKSPACE: '0', TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '0', TUCANO_WEBHOOK_PORT: '47991', TUCANO_GIT_PORT: '47992', TUCANO_MCP_PORT: String(MCP_PORT), TUCANO_WIKI: join(dataDir, 'wiki') })
    ;(process as unknown as { parentPort: typeof parent }).parentPort = parent
    await import('../src/core/index')
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith({ type: 'ready' }), { timeout: BOOT })
    const call = window()

    const info = (await call('mcpInfo')) as { url?: string; local: boolean }
    await vi.waitFor(async () => expect(((await call('mcpInfo')) as { url?: string }).url).toBe(`http://127.0.0.1:${MCP_PORT}/mcp`))
    expect(info.local).toBe(true)

    // No key, a web page, a wrong key: nothing.
    expect((await mcp(undefined, 'tools/list')).status).toBe(401)
    expect((await mcp('tk_' + 'x'.repeat(43), 'tools/list')).status).toBe(401)

    const { key } = (await call('createHarnessKey', { name: 'Claude Code', level: 'configure' })) as { key: string }
    expect(key).toMatch(/^tk_[\w-]{43}$/)
    expect((await mcp(key, 'tools/list', {}, { origin: 'https://evil.example' })).status).toBe(403)
    const init = await mcp(key, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    expect(init.status).toBe(200)

    // The official client (what Claude Code, Cursor and others are built on) connects and calls a tool.
    const client = new Client({ name: 'sdk-test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }))
    expect(client.getServerVersion()?.name).toBe('tucano')
    const sdkTools = await client.listTools()
    expect(sdkTools.tools.map((t) => t.name)).toContain('create_agent')
    const guide = await client.callTool({ name: 'tucano_guide', arguments: {} })
    expect((guide.content as { text: string }[])[0]!.text.length).toBeGreaterThan(20)
    await client.close()

    // Set the team up.
    const lia = await tool(key, 'create_agent', { name: 'Lia', role: 'Revisa contratos', instructions: 'Você revisa contratos.' })
    expect(lia.isError).toBe(false)
    expect((await tool(key, 'create_agent', { name: 'lia', instructions: 'outra' })).data()['existing']).toBe(true)
    expect((await tool(key, 'create_channel', { name: 'juridico', topic: 'Contratos', members: ['Lia'] })).isError).toBe(false)
    const routine = await tool(key, 'create_routine', { agent: 'Lia', name: 'Revisão de segunda', prompt: 'Revise os contratos novos.', schedule: { days: [1], time: '09:00' } })
    expect(routine.isError).toBe(false)
    expect((await tool(key, 'create_skill', { name: 'revisar-contratos', description: 'Ao revisar um contrato', body: '# Passos\n1. Leia tudo.', agents: ['Lia'] })).isError).toBe(false)
    expect((await tool(key, 'add_memory', { agent: 'Lia', text: 'O Edu prefere respostas curtas.' })).isError).toBe(false)

    const state = (await tool(key, 'get_state')).data() as { agents: { name: string; channels: string[]; skills: string[] }[]; routines: { name: string; agent: string; schedule: { days: number[] } }[] }
    const liaState = state.agents.find((a) => a.name === 'Lia')!
    expect(liaState.channels).toEqual(['#juridico'])
    expect(liaState.skills).toContain('revisar-contratos')
    expect(state.routines).toEqual([expect.objectContaining({ name: 'Revisão de segunda', agent: 'Lia', schedule: expect.objectContaining({ days: [1], time: '09:00' }) })])

    // Talk to her: the fake engine answers.
    const sent = (await tool(key, 'send_message', { to: 'Lia', text: 'Oi Lia, tudo certo?', wait_seconds: 20 })).data() as { status: string; replies: { agent: string; text?: string }[] }
    expect(sent.status).toBe('done')
    expect(sent.replies[0]!.agent).toBe('Lia')
    const read = (await tool(key, 'read_conversation', { conversation: 'Lia' })).data() as { messages: { author: string; text: string }[] }
    expect(read.messages.some((m) => m.text === 'Oi Lia, tudo certo?')).toBe(true)

    // A key that only reads sees no tool to change anything.
    const { key: reader } = (await call('createHarnessKey', { name: 'Leitor', level: 'read' })) as { key: string }
    const listed = ((await mcp(reader, 'tools/list')).body as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name)
    expect(listed).toContain('get_state')
    expect(listed).not.toContain('send_message')
    expect((await tool(reader, 'create_agent', { name: 'Zé', instructions: 'x' })).isError).toBe(true)

    // The person sees what it did: in the Activity with the key's name, in the inbox, and the memory waiting.
    const activity = (await call('activity', {})) as ActivityEntry[]
    expect(activity.some((e) => e.kind === 'agent.created' && e.detail?.['via'] === 'Claude Code')).toBe(true)
    const inbox = (await call('inbox')) as Inbox
    expect(inbox.harness?.[0]?.text).toMatch(/^Claude Code (criou 1 agente, 1 canal, 1 rotina, 1 skill e 1 memória|created 1 agent, 1 channel, 1 routine, 1 skill and 1 memory)/)
    await call('harnessNoticeSeen')
    expect(((await call('inbox')) as Inbox).harness).toBeUndefined()
    const snapshot = (await call('snapshot')) as { memories: Memory[] }
    expect(snapshot.memories.find((m) => m.text === 'O Edu prefere respostas curtas.')?.state).toBe('pending')

    // Taken out of the list: the harness is out at once.
    const keys = (await call('harnessKeys')) as { id: string; name: string; seenAt?: number }[]
    expect(keys.find((k) => k.name === 'Claude Code')?.seenAt).toBeGreaterThan(0)
    await call('removeHarnessKey', { id: keys.find((k) => k.name === 'Claude Code')!.id })
    expect((await mcp(key, 'tools/list')).status).toBe(401)
  }, BOOT * 2)
})
