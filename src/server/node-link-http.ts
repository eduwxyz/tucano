// A computer lent to this server calls in here (shared/node-link.ts): the stream that brings it the core's
// MCP messages, and the posts that carry its answers back. Signed in already (the caller checked the key);
// the core gets a port per link, as it gets one per page on /events, and says no more than the port.
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cleanDevice, cleanMachine, NODE_LINK_HEADER, NODE_LINK_MAX_BYTES, NODE_LINK_PATH } from '../shared/node-link'

// Electron's port shape, as the core uses it (the same as server/index.ts's Port).
export class LinkPortHttp extends EventEmitter {
  constructor(readonly postMessage: (msg: unknown) => void) {
    super()
  }
  start(): void {}
  close(): void {
    this.emit('close')
  }
}

type Who = { owner?: boolean; person?: string }
interface Live {
  who: Who
  port: LinkPortHttp
}

const BEAT_MS = 25_000
// Lines one person may have open at once: a new one past this closes their oldest.
export const MAX_LINKS = 5

export class NodeLinkHttp {
  private links = new Map<string, Live>()

  // `toCore`: hands the core a link's port, with whose computer it is (person unset: the Tucano's owner).
  constructor(private toCore: (data: { type: 'node-link'; person?: string; device: string; name: string }, port: LinkPortHttp) => void) {}

  // Whether this request is a link's: then it's answered here.
  handles(url: URL): boolean {
    return url.pathname === NODE_LINK_PATH
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL, who: Who, headers: Record<string, string> = {}): void {
    // Never from a page: only the desktop app sends this header (a page would have to ask first, and isn't let).
    if (req.headers[NODE_LINK_HEADER] !== '1') return void res.writeHead(403, headers).end()
    if (req.method === 'GET') return this.open(req, res, url, who, headers)
    if (req.method === 'POST') return this.post(req, res, url, who, headers)
    res.writeHead(405, headers).end()
  }

  get size(): number {
    return this.links.size
  }

  // Everyone's links end (the server is going down), or one person's (they were removed).
  closeAll(person?: string): void {
    for (const [id, l] of this.links) if (person === undefined || l.who.person === person) (this.links.delete(id), l.port.close())
  }

  private open(req: IncomingMessage, res: ServerResponse, url: URL, who: Who, headers: Record<string, string>): void {
    const device = cleanDevice(url.searchParams.get('device'))
    if (!device) return void res.writeHead(400, headers).end()
    const name = cleanMachine(url.searchParams.get('name'))
    const id = randomUUID()
    const mine = [...this.links].filter(([, l]) => !!l.who.owner === !!who.owner && l.who.person === who.person)
    for (const [old, l] of mine.slice(0, Math.max(0, mine.length - MAX_LINKS + 1))) (this.links.delete(old), l.port.close())
    const port = new LinkPortHttp((msg) => void (!res.writableEnded && res.write(`data: ${JSON.stringify(msg)}\n\n`)))
    this.links.set(id, { who, port })
    const end = (): void => {
      this.links.delete(id)
      if (!res.writableEnded) res.end()
    }
    port.once('close', end)
    res.writeHead(200, { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' })
    res.write(`event: hello\ndata: ${id}\n\n`)
    const beat = setInterval(() => res.write('event: ping\ndata: \n\n'), BEAT_MS)
    beat.unref?.()
    req.on('close', () => {
      clearInterval(beat)
      if (this.links.get(id)?.port === port) port.close()
    })
    this.toCore({ type: 'node-link', ...(who.owner ? {} : { person: who.person }), device, name }, port)
  }

  private post(req: IncomingMessage, res: ServerResponse, url: URL, who: Who, headers: Record<string, string>): void {
    const live = this.links.get(url.searchParams.get('id') ?? '')
    // A link is its own person's: another key can't speak on it.
    if (!live || !!live.who.owner !== !!who.owner || live.who.person !== who.person) return void (req.resume(), res.writeHead(410, headers).end())
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > NODE_LINK_MAX_BYTES) {
        req.destroy()
        if (!res.headersSent) res.writeHead(413, headers).end()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (res.headersSent) return
      let msg: unknown
      try {
        msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return void res.writeHead(400, headers).end()
      }
      live.port.emit('message', { data: msg })
      res.writeHead(202, headers).end()
    })
    req.on('error', () => !res.headersSent && res.writeHead(400, headers).end())
  }
}
