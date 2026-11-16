// A computer lent to a server (shared/node-link.ts), the line itself: the desktop app calls the server with the key
// it was paired with, and becomes a connector there; nothing listens on the computer. Over real HTTP, in one process.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { textResult } from '../src/core/gateway'
import { events, NodeUplink } from '../src/core/node-link'
import { NODE_BASH, NodeServer } from '../src/core/node-server'
import { plainCipher, Secrets } from '../src/core/secrets'
import { NODE_LINK_HEADER, NODE_LINK_PATH, nodeOf, nodeUrl, type UplinkStatus } from '../src/shared/node-link'
import { lend, until, type Lent } from './helpers/node-link'

let dir: string
let db: Db // the server's
let connectors: ConnectorManager
let node: NodeServer
let ran: string[]
let lent: Lent | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'node-link-'))
  db = new Db(join(dir, 'server.db'))
  connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => 'http://127.0.0.1:1/cb' })
  ran = []
  const mac = { cwd: () => dir, call: async (_a: unknown, name: string, args: Record<string, unknown>) => (name === 'bash' && ran.push(String(args['command'])), { result: textResult(`ran ${String(args['command'] ?? name)}`) }) }
  node = new NodeServer(mac as never, {})
})

afterEach(async () => {
  await connectors.closeAll()
  await lent?.stop()
  lent = undefined
  db.close()
})

const text = (r: { content: unknown }): string => ((r.content as { text?: string }[])[0]?.text ?? '')
const connected = (): boolean => !!lent?.id() && connectors.get(lent.id()!)?.status === 'connected'
const last = (s: UplinkStatus[]): UplinkStatus['state'] | undefined => s.at(-1)?.state

describe('a computer lent to a server', () => {
  it("calls the server with its key and becomes a connector there, the owner's by its name; a command runs on it", async () => {
    lent = await lend({ node, db, connectors })
    await until(connected)
    const c = connectors.get(lent.id()!)!
    expect(c.name).toBe('MacBook do Edu')
    expect(nodeOf(c.url)).toEqual({ device: 'mac-1' })
    expect(c.tools.map((t) => t.name)).toContain(NODE_BASH)
    expect(last(lent.statuses)).toBe('connected')
    expect(text(await connectors.call(c.id, NODE_BASH, { command: 'echo oi' }))).toBe('ran echo oi')
    expect(ran).toEqual(['echo oi'])
  })

  it("someone else's computer on a team server says whose it is, and is a connector of theirs", async () => {
    db.addPerson({ id: 'maria', name: 'Maria', role: 'member', about: '' })
    lent = await lend({ node, db, connectors, keys: { 'maria-key': { person: 'maria' } }, name: 'iMac' })
    await until(connected)
    const c = connectors.get(lent.id()!)!
    expect(c.name).toBe('iMac (Maria)')
    expect(nodeOf(c.url)).toEqual({ device: 'mac-1', owner: 'maria' })
  })

  it('comes back by itself when the line drops, as the same connector', async () => {
    lent = await lend({ node, db, connectors })
    await until(connected)
    const id = lent.id()!
    lent.links.closeAll() // the server dropped it (a restart, a proxy's timeout)
    await until(() => connectors.get(id)?.status === 'disconnected' || lent!.statuses.some((s, i) => i > 0 && s.state === 'connecting'))
    await until(connected)
    expect(lent.id()).toBe(id)
    expect(db.connectors().filter((c) => nodeOf(c.url))).toHaveLength(1)
    expect(text(await connectors.call(id, NODE_BASH, { command: 'echo de-volta' }))).toBe('ran echo de-volta')
  })

  it('while it is away, a call says the computer is not connected (the agent goes on without it)', async () => {
    lent = await lend({ node, db, connectors })
    await until(connected)
    const id = lent.id()!
    await lent.stop()
    await until(() => connectors.get(id)?.status === 'disconnected')
    await expect(connectors.call(id, NODE_BASH, { command: 'ls' })).rejects.toThrow(/não está conectado|isn't connected/)
    // And nothing tries to call it: a computer calls in, it isn't called.
    await connectors.connect(id)
    expect(connectors.get(id)?.status).toBe('disconnected')
  })

  it('a key the server no longer takes: refused, and it says to connect the server again', async () => {
    lent = await lend({ node, db, connectors, token: 'old-key', keys: { 'the-key': {} } })
    await until(() => last(lent!.statuses) === 'refused')
    expect(lent.uplink.state.error).toMatch(/Conecte o servidor de novo|Connect the server again/)
    expect(db.connectors()).toHaveLength(0)
  })

  it('a server too old to know about it: says to update that server', async () => {
    const old = createServer((_req, res) => res.writeHead(404).end())
    await new Promise<void>((r) => old.listen(0, '127.0.0.1', () => r()))
    const statuses: UplinkStatus[] = []
    const up = new NodeUplink({ serverId: 's', origin: `http://127.0.0.1:${(old.address() as AddressInfo).port}`, token: 'k', device: 'd', name: 'n', server: () => node.mcp(), onStatus: (s) => statuses.push(s) })
    up.start()
    await until(() => last(statuses) === 'outdated')
    expect(up.state.error).toMatch(/atualize|update/)
    up.stop()
    old.closeAllConnections()
    await new Promise<void>((r) => old.close(() => r()))
  })

  it('turned off on the computer, it hangs up at once and stays off', async () => {
    lent = await lend({ node, db, connectors })
    await until(connected)
    lent.uplink.stop()
    await until(() => connectors.get(lent!.id()!)?.status === 'disconnected')
    await new Promise((r) => setTimeout(r, 120)) // longer than its waits to call back
    expect(connectors.get(lent.id()!)?.status).toBe('disconnected')
  })
})

describe("the server's /node/link", () => {
  it('only the desktop app opens one (a page would have to send its header), and a link speaks only for its own key', async () => {
    db.addPerson({ id: 'maria', name: 'Maria', role: 'member', about: '' })
    db.addPerson({ id: 'joao', name: 'João', role: 'member', about: '' })
    lent = await lend({ node, db, connectors, keys: { 'maria-key': { person: 'maria' }, 'joao-key': { person: 'joao' } } })
    await until(connected)
    // Without the header: refused, even with a good key.
    const bare = await fetch(`${lent.origin}${NODE_LINK_PATH}?device=x`, { headers: { cookie: 'tucano=maria-key' } })
    expect(bare.status).toBe(403)
    // João can't post into Maria's link.
    const opened = await fetch(`${lent.origin}${NODE_LINK_PATH}?device=x`, { headers: { cookie: 'tucano=maria-key', [NODE_LINK_HEADER]: '1' } })
    let link = ''
    for await (const ev of events(opened.body!)) {
      if (ev.event !== 'hello') continue
      link = ev.data
      break
    }
    expect(link).toBeTruthy()
    const post = await fetch(`${lent.origin}${NODE_LINK_PATH}?id=${link}`, { method: 'POST', headers: { cookie: 'tucano=joao-key', [NODE_LINK_HEADER]: '1', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) })
    expect(post.status).toBe(410)
  })

  it("someone removed: their computers' links end at once", async () => {
    db.addPerson({ id: 'maria', name: 'Maria', role: 'member', about: '' })
    lent = await lend({ node, db, connectors, keys: { 'maria-key': { person: 'maria' } } })
    await until(connected)
    expect(lent.links.size).toBe(1)
    lent.links.closeAll('maria')
    expect(lent.links.size).toBe(0)
    await until(() => connectors.get(lent!.id()!)?.status === 'disconnected')
  })

  it('a node address keeps the device and whose it is', () => {
    expect(nodeOf(nodeUrl('mac-1'))).toEqual({ device: 'mac-1' })
    expect(nodeOf(nodeUrl('mac-1', 'maria'))).toEqual({ device: 'mac-1', owner: 'maria' })
    expect(nodeOf('https://mcp.linear.app/mcp')).toBeUndefined()
  })
})
