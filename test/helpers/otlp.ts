// An OTLP/HTTP collector for tests: it keeps the spans it gets, in JSON.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

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

export async function collector(): Promise<{ url: string; spans: Received[]; close(): Promise<void> }> {
  const spans: Received[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { resourceSpans: { resource: { attributes: { key: string; value: OtlpValue }[] }; scopeSpans: { spans: OtlpSpan[] }[] }[] }
      for (const rs of body.resourceSpans) for (const ss of rs.scopeSpans) for (const span of ss.spans) spans.push({ resource: attrs(rs.resource.attributes), span })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    spans,
    close: () => new Promise((ok) => server.close(() => ok()))
  }
}
