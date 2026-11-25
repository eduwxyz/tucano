// An OTLP/HTTP collector for tests: it keeps the spans it gets, in JSON.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { flushTelemetry } from '../../src/core/telemetry'

export type OtlpValue = { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
export type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: { key: string; value: OtlpValue }[]
  links?: { traceId: string; spanId: string }[]
  status?: { code?: number }
}
export type Received = { resource: Record<string, unknown>; span: OtlpSpan }

const plain = (v: OtlpValue): unknown => v.stringValue ?? (v.intValue !== undefined ? Number(v.intValue) : (v.doubleValue ?? v.boolValue))
const attrs = (list: { key: string; value: OtlpValue }[] = []): Record<string, unknown> => Object.fromEntries(list.map((a) => [a.key, plain(a.value)]))
export const attrsOf = (r: Received): Record<string, unknown> => attrs(r.span.attributes)

export async function collector(): Promise<{ url: string; spans: Received[]; headers: IncomingHttpHeaders[]; close(): Promise<void> }> {
  const spans: Received[] = []
  const headers: IncomingHttpHeaders[] = [] // each request's, to see what a backend's key looked like on arrival
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      headers.push(req.headers)
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { resourceSpans: { resource: { attributes: { key: string; value: OtlpValue }[] }; scopeSpans: { spans: OtlpSpan[] }[] }[] }
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) for (const span of ss.spans) spans.push({ resource: attrs(rs.resource.attributes), span })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    spans,
    headers,
    close: () => new Promise((ok) => server.close(() => ok()))
  }
}

// The core sends its spans in a batch every 5 s. A test asks for what there is each time it looks, so
// it waits on the reply and not on the clock.
export async function arrived(ok: () => boolean, ms = 9_000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await flushTelemetry()
    await new Promise((r) => setTimeout(r, 10))
  }
}
