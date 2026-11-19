// A computer lent to a server, end to end in one process: a real HTTP server with the server's /node/link
// (src/server/node-link-http.ts), the server's core side (NodeLinks → ConnectorManager.attachNode), and the
// computer's NodeUplink calling it with its key, as the cookie the desktop app keeps for that server.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ConnectorManager } from '../../src/core/connectors'
import type { Db } from '../../src/core/db'
import { NodeLinks, NodeUplink, type LinkPort } from '../../src/core/node-link'
import type { NodeServer } from '../../src/core/node-server'
import { NodeLinkHttp } from '../../src/server/node-link-http'
import { nodeOf, type UplinkStatus } from '../../src/shared/node-link'

export interface Lent {
  id: () => string | undefined // the computer's connector on the server, once it called
  uplink: NodeUplink
  links: NodeLinkHttp
  statuses: UplinkStatus[]
  origin: string
  stop(): Promise<void>
}

// `keys`: which key signs in as whom (person unset: the Tucano's owner). The computer signs in with `token`.
export async function lend(o: {
  node: NodeServer
  db: Db // the server's
  connectors: ConnectorManager // the server's
  token?: string
  keys?: Record<string, { person?: string }>
  device?: string
  name?: string
  fetch?: typeof fetch
}): Promise<Lent> {
  const keys = o.keys ?? { 'the-key': {} }
  const nodeLinks = new NodeLinks({ db: o.db, attach: (id, t) => o.connectors.attachNode(id, t) })
  let attached: string | undefined
  const links = new NodeLinkHttp((data, port) => {
    attached = nodeLinks.attach(port as unknown as LinkPort, data)
  })
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const cookie = /(?:^|;\s*)tucano=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''
    const who = keys[cookie]
    if (!links.handles(url)) return void res.writeHead(404).end()
    if (!who) return void res.writeHead(401).end()
    links.handle(req, res, url, who.person ? { person: who.person } : { owner: true })
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()))
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  const statuses: UplinkStatus[] = []
  const uplink = new NodeUplink({
    serverId: 's1',
    origin,
    token: o.token ?? Object.keys(keys)[0]!,
    device: o.device ?? 'mac-1',
    name: o.name ?? 'MacBook do Edu',
    server: () => o.node.mcp(),
    onStatus: (s) => statuses.push(s),
    backoffMs: [20, 40],
    ...(o.fetch ? { fetch: o.fetch } : {})
  })
  uplink.start()
  return {
    id: () => attached ?? o.db.connectors().find((c) => nodeOf(c.url)?.device === (o.device ?? 'mac-1'))?.id,
    uplink,
    links,
    statuses,
    origin,
    async stop() {
      uplink.stop()
      links.closeAll()
      http.closeAllConnections()
      await new Promise<void>((r) => http.close(() => r()))
    }
  }
}

// Waits until `ok` holds (a status, a connector connected), up to `ms`.
export async function until(ok: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}
