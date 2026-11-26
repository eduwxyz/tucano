// The two ends of a computer lent to a server (shared/node-link.ts says the way):
// - on the server, NodeLinks: a computer that calls in becomes a connector of its person's own, over the port
//   the server's HTTP side hands the core (one per link), and stops being reachable when it hangs up;
// - on the computer, NodeUplink: calls one server, keeps calling back when the line drops (sleep, a new
//   network), and answers the server's MCP messages with the node's tools (NodeServer).
import { randomUUID } from 'node:crypto'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'
import { cleanDevice, cleanMachine, NODE_LINK_HEADER, NODE_LINK_PATH, nodeOf, nodeUrl, type UplinkState, type UplinkStatus } from '../shared/node-link'
import type { Db } from './db'

// What the core gets from the server's HTTP side for each link (or a test's stand-in): Electron's port shape.
export interface LinkPort {
  postMessage(msg: unknown): void
  on(event: 'message', cb: (e: { data: unknown }) => void): unknown
  on(event: 'close', cb: () => void): unknown
  close(): void
  start?(): void
}

const isMessage = (m: unknown): m is JSONRPCMessage => !!m && typeof m === 'object' && (m as { jsonrpc?: unknown }).jsonrpc === '2.0'

// MCP over such a port: what the computer posts comes in as 'message', what the server sends goes out.
export class PortTransport implements Transport {
  onclose?: () => void
  onerror?: (e: Error) => void
  onmessage?: (m: JSONRPCMessage) => void
  private closed = false

  constructor(private port: LinkPort) {}

  async start(): Promise<void> {
    this.port.on('message', (e) => (isMessage(e.data) ? this.onmessage?.(e.data) : this.onerror?.(new Error('not a JSON-RPC message'))))
    this.port.on('close', () => this.end())
    this.port.start?.()
  }

  async send(m: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('Not connected')
    this.port.postMessage(m)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.port.close()
    this.end()
  }

  private end(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

// ---------- on the server ----------

export interface NodeLinksDeps {
  db: Pick<Db, 'connectors' | 'saveConnector' | 'person' | 'ownerId'>
  attach(connectorId: string, transport: Transport): Promise<void> // the connector manager connects over it
  connected?(connectorId: string): boolean // whether a computer's connector is on a line now
  remove?(connectorId: string): Promise<void> // a computer's connector, gone (to make room for a new one)
  emitConnector?(id: string): void
}

// Computers one person may lend a server: a new one past this replaces their oldest that isn't on a line.
export const MAX_COMPUTERS = 5

export class NodeLinks {
  constructor(private deps: NodeLinksDeps) {}

  // A computer called in: `person` signed in (undefined: the Tucano's owner, with its own token), `device` its
  // id, `name` what it calls itself. Its connector (made the first time, kept after) connects over the port.
  // Returns the connector's id, or undefined when the call isn't one (no device, an unknown person).
  attach(port: LinkPort, o: { person?: string; device?: unknown; name?: unknown }): string | undefined {
    const { db } = this.deps
    const device = cleanDevice(o.device)
    const owner = o.person ?? db.ownerId()
    const who = db.person(owner)
    if (!device || !who) {
      port.close()
      return undefined
    }
    const machine = cleanMachine(o.name) || L('Computador', 'Computer')
    // The Tucano's owner's computer goes by its name; anyone else's says it's a computer, and whose.
    const name = owner === db.ownerId() ? machine : L(`${machine} · computador de ${who.name}`, `${machine} · ${who.name}'s computer`)
    const url = nodeUrl(device, owner === db.ownerId() ? undefined : owner)
    const theirs = db.connectors().filter((c) => {
      const n = nodeOf(c.url)
      return !!n && (n.owner ?? db.ownerId()) === owner
    })
    const found = theirs.find((c) => nodeOf(c.url)!.device === device)
    // A new computer past the most one person lends: their oldest not on a line makes room; all on one, it's refused.
    if (!found && theirs.length >= MAX_COMPUTERS) {
      const idle = theirs.find((c) => !this.deps.connected?.(c.id))
      if (!idle || !this.deps.remove) {
        port.close()
        return undefined
      }
      void this.deps.remove(idle.id)
    }
    const id = found?.id ?? randomUUID()
    if (!found || found.name !== name) db.saveConnector({ id, name, kind: 'remote', url, auth: 'none' })
    if (found?.name !== name) this.deps.emitConnector?.(id)
    void this.deps.attach(id, new PortTransport(port)).catch((e: unknown) => {
      console.error('[node-link]', e)
      port.close()
    })
    return id
  }
}

// ---------- on the computer ----------

// Waits between calls back, growing; a refusal (the key no longer opens it) or an old server waits the longest.
const BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000]
const SLOW_MS = 10 * 60_000
// The server sends a beat every 25 s: nothing for this long means the line is dead (a Mac that slept with it open).
const SILENT_MS = 70_000

export interface UplinkOptions {
  serverId: string
  origin: string
  token: string // the key this computer got when it was paired with the server
  device: string
  name: string // this computer's name, as the server shows it
  server: () => Server // a fresh MCP server with the node's tools, one per link
  onStatus?: (s: UplinkStatus) => void
  fetch?: typeof fetch // tests
  backoffMs?: number[] // tests
}

// One server this computer is lent to: a line that comes back by itself until stop().
export class NodeUplink {
  private stopped = false
  private abort: AbortController | null = null
  private tries = 0
  private timer: NodeJS.Timeout | null = null
  private status: UplinkStatus

  constructor(private o: UplinkOptions) {
    this.status = { serverId: o.serverId, origin: o.origin, state: 'connecting' }
  }

  get state(): UplinkStatus {
    return this.status
  }

  start(): void {
    this.stopped = false
    void this.run()
  }

  // Calls again now instead of at the end of its wait (the computer just woke, or came back on a network).
  nudge(): void {
    if (this.stopped || !this.timer) return
    clearTimeout(this.timer)
    this.timer = null
    this.tries = 0
    void this.run()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.abort?.abort()
  }

  private set(state: UplinkState, error?: string): void {
    this.status = { serverId: this.o.serverId, origin: this.o.origin, state, ...(error ? { error } : {}), ...(state === 'connected' ? { since: Date.now() } : {}) }
    this.o.onStatus?.(this.status)
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    // The key goes as the server's own cookie, the way its window there signs in: the server reads no other.
    return { cookie: `tucano=${this.o.token}`, [NODE_LINK_HEADER]: '1', ...extra }
  }

  private again(slow = false): void {
    if (this.stopped) return
    const waits = this.o.backoffMs ?? BACKOFF_MS
    const ms = slow ? SLOW_MS : waits[Math.min(this.tries, waits.length - 1)]!
    this.tries++
    this.timer = setTimeout(() => {
      this.timer = null
      void this.run()
    }, ms)
    this.timer.unref?.()
  }

  private async run(): Promise<void> {
    if (this.stopped) return
    const f = this.o.fetch ?? fetch
    const abort = new AbortController()
    this.abort = abort
    this.set('connecting')
    const url = new URL(NODE_LINK_PATH, this.o.origin)
    url.searchParams.set('device', this.o.device)
    url.searchParams.set('name', this.o.name)
    let res: Response
    try {
      res = await f(url, { headers: this.headers({ accept: 'text/event-stream' }), signal: abort.signal, redirect: 'error' }) // never on to another address, key and all
    } catch (e) {
      if (this.stopped) return
      this.set('error', L(`Não alcancei o servidor (${(e as Error).message}). Tento de novo sozinho.`, `Couldn't reach the server (${(e as Error).message}). Retrying automatically.`))
      return this.again()
    }
    if (res.status === 401 || res.status === 403) {
      void res.body?.cancel()
      this.set('refused', L('O servidor não aceitou este computador: a chave dele saiu de lá. Conecte o servidor de novo com um link novo.', "The server didn't accept this computer: its key was removed there. Connect the server again with a new link."))
      return this.again(true)
    }
    if (res.status === 404) {
      void res.body?.cancel()
      this.set('outdated', L('Esse servidor ainda não sabe usar este computador: atualize o Tucano dele.', "That server doesn't know how to use this computer yet: update its Tucano."))
      return this.again(true)
    }
    if (!res.ok || !res.body) {
      void res.body?.cancel()
      this.set('error', L(`O servidor respondeu ${res.status}. Tento de novo sozinho.`, `The server returned ${res.status}. Retrying automatically.`))
      return this.again()
    }
    await this.serve(res.body, abort)
    if (this.stopped) return
    this.set('connecting')
    this.again()
  }

  // Reads the stream until it ends: the first event names the link, then each event is a message from the server.
  private async serve(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<void> {
    const f = this.o.fetch ?? fetch
    let link = ''
    let transport: UplinkTransport | null = null
    let server: Server | null = null
    let silent: NodeJS.Timeout | null = null
    const beat = (): void => {
      if (silent) clearTimeout(silent)
      silent = setTimeout(() => abort.abort(), SILENT_MS)
      silent.unref?.()
    }
    beat()
    const post = async (m: JSONRPCMessage): Promise<void> => {
      const url = new URL(NODE_LINK_PATH, this.o.origin)
      url.searchParams.set('id', link)
      const r = await f(url, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(m), signal: abort.signal, redirect: 'error' })
      void r.body?.cancel()
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
    }
    try {
      for await (const ev of events(body)) {
        beat()
        if (ev.event === 'hello') {
          if (transport) continue // one line, one link: a second hello changes nothing
          link = ev.data.trim()
          transport = new UplinkTransport(post)
          server = this.o.server()
          await server.connect(transport)
          this.tries = 0
          this.set('connected')
        } else if (ev.event === 'message' && transport && ev.data) {
          try {
            transport.receive(JSON.parse(ev.data) as JSONRPCMessage)
          } catch (e) {
            console.error('[node-link] a message it could not read', e)
          }
        }
      }
    } catch (e) {
      if (!this.stopped && !abort.signal.aborted) console.error('[node-link]', (e as Error).message)
    } finally {
      if (silent) clearTimeout(silent)
      transport?.end()
      await server?.close().catch(() => {})
    }
  }
}

// The computer's side of MCP: what comes down the stream goes in, answers go up as posts.
class UplinkTransport implements Transport {
  onclose?: () => void
  onerror?: (e: Error) => void
  onmessage?: (m: JSONRPCMessage) => void
  private closed = false
  constructor(private post: (m: JSONRPCMessage) => Promise<void>) {}
  async start(): Promise<void> {}
  async send(m: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('Not connected')
    await this.post(m)
  }
  receive(m: JSONRPCMessage): void {
    if (isMessage(m)) this.onmessage?.(m)
  }
  async close(): Promise<void> {
    this.end()
  }
  end(): void {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }
}

// The longest event a server may send down a line (a tool call's arguments): past it, the line is dropped.
const MAX_EVENT_CHARS = 16 * 1024 * 1024

// Server-sent events from a byte stream: each event's name (message by default) and its data lines joined.
export async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event = 'message'
  let data: string[] = []
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > MAX_EVENT_CHARS) throw new Error('an event too long')
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        if (line === '') {
          if (data.length || event !== 'message') yield { event, data: data.join('\n') }
          event = 'message'
          data = []
        } else if (line.startsWith(':')) {
          // a comment
        } else {
          const at = line.indexOf(':')
          const field = at < 0 ? line : line.slice(0, at)
          const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '')
          if (field === 'event') event = value
          else if (field === 'data') data.push(value)
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
