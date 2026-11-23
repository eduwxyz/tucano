// The desktop's door to MCP (src/core/mcp.ts): 127.0.0.1 only, for the person's own harnesses on this
// computer. A web page open in a browser can reach 127.0.0.1 too, so a request that carries an Origin
// (a browser's) or names another host (DNS rebinding) is turned away before the key is even read.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { McpDoor } from './mcp'

const MAX_BODY = 256 * 1024

// Whether this request may come in: from a program, to this address.
export function localRequestOk(headers: IncomingMessage['headers'], port: number): boolean {
  if (headers.origin !== undefined) return false
  const host = (headers.host ?? '').toLowerCase()
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

export function startMcpHttp(door: McpDoor, port: number, onError: (e: Error) => void): Server {
  const server = createServer((req, res) => {
    const send = (status: number, headers: Record<string, string> = {}, body = ''): void => void res.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers }).end(body)
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/mcp' && path !== '/mcp/') return send(404)
    if (!localRequestOk(req.headers, port)) return send(403)
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) return req.destroy()
      chunks.push(c)
    })
    req.on('end', () => {
      door
        .http({ method: req.method ?? 'GET', auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') })
        .then((out) => send(out.status, out.headers, out.body))
        .catch((e: unknown) => {
          console.error('[mcp]', e)
          send(500)
        })
    })
    req.on('error', () => send(400))
  })
  server.on('error', onError)
  server.listen(port, '127.0.0.1')
  return server
}
