import { createServer, type ServerResponse } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { RemoteClient, type RemoteState } from '../src/main/remote'

let cleanup = async (): Promise<void> => {}
afterEach(async () => { await cleanup() })
it('pairs and reconnects against real HTTP + SSE using the server wire protocol', async () => {
  const secret = 'ephemeral-test-device-token-123456', calls: string[] = [], states: RemoteState[] = [], messages: unknown[] = []
  let stream: ServerResponse | undefined, connection = 0
  const server = createServer((req, res) => {
    calls.push(req.url!)
    if (req.url === '/identity') {
      expect(req.headers.authorization).toBeUndefined()
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ server: 'fixture', protocol: 1 })); return
    }
    if (req.url === '/pair') {
      let body = ''; req.on('data', b => { body += b }); req.on('end', () => {
        expect(JSON.parse(body).code).toBe('K7QM-2XPD-9TWH')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ server: 'fixture', device: { id: 'device', label: 'test', created: 1, seen: 1 }, token: secret, days: 30 }))
      }); return
    }
    if (req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401).end(); return }
    if (req.url === '/events') {
      stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: hello\ndata: connection-${++connection}\n\n`); return
    }
    if (req.url?.startsWith('/rpc?c=connection-')) {
      let body = ''; req.on('data', b => { body += b }); req.on('end', () => {
        const message = JSON.parse(body)
        stream!.write(`data: ${JSON.stringify({ id: message.id, result: { ok: true } })}\n\n`)
        res.writeHead(204).end()
      }); return
    }
    if (req.url?.startsWith('/artifact/')) { res.end('artifact fixture'); return }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture failed')
  const client = new RemoteClient({ onState: s => states.push(s), onMessage: m => messages.push(m), timeoutMs: 1000 })
  cleanup = async () => { client.disconnect(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  const paired = await client.pair({ name: 'fixture', code: 'K7QM-2XPD-9TWH', reach: { via: 'url', url: `http://127.0.0.1:${address.port}` }, remotePort: 7337 })
  await client.connect(paired.profile, paired.token)
  await client.send({ id: 7, method: 'snapshot', params: null })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(messages).toEqual([{ id: 7, result: { ok: true } }])
  expect(await (await client.asset('/artifact/00000000-0000-0000-0000-000000000000/a.txt')).text()).toBe('artifact fixture')
  client.disconnect(); await client.connect(paired.profile, paired.token)
  expect(connection).toBe(2); expect(states.at(-1)?.status).toBe('connected')
  expect(calls.every(url => !url.includes(secret))).toBe(true)
  expect(JSON.stringify(states)).not.toContain(secret)
})
