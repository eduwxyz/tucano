// Settings › Connections › Traces: where an admin points the traces from the screen, with no OTEL_
// variables. Kept apart from Settings, which every person's page receives.
import { L } from '../shared/lang'
import type { OtelConfig } from './telemetry'

export interface StoredTraces {
  on: boolean
  endpoint: string
  text: boolean
  textBy?: string // the admin who turned the text on: it goes only for what they may read
}

export const NO_TRACES: StoredTraces = { on: false, endpoint: '', text: false }

// The base address a backend documents (as OTEL_EXPORTER_OTLP_ENDPOINT takes it), and where traces go under it.
export const tracesUrl = (endpoint: string): string => {
  const base = endpoint.trim().replace(/\/+$/, '')
  return /\/v1\/traces$/.test(base) ? base : `${base}/v1/traces`
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]'])

// Why this address can't take traces, if it can't. What's sent crosses the network in the clear over
// plain http, so that's only for this machine.
export function endpointError(endpoint: string, on: boolean): string | undefined {
  const raw = endpoint.trim()
  if (!raw) return on ? L('Diga o endereço do backend.', "Say the backend's address.") : undefined
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return L('Esse endereço não é válido. Comece com https://.', "That address isn't valid. Start it with https://.")
  }
  if (url.protocol === 'https:') return undefined
  if (url.protocol === 'http:' && LOCAL.has(url.hostname)) return undefined
  if (url.protocol === 'http:') return L('Use HTTPS para um backend em outra máquina. http:// só vale para este computador (localhost).', 'Use HTTPS for a backend on another machine. http:// only works for this computer (localhost).')
  return L('Esse endereço não é web. Comece com https://.', "That address isn't a web address. Start it with https://.")
}

// One per line, as a backend's page writes it: `Authorization: Basic …` or `Authorization=Basic …`, spaces as they are.
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const at = line.search(/[:=]/)
    if (at <= 0) continue
    const name = line.slice(0, at).trim()
    if (name) out[name] = line.slice(at + 1).trim()
  }
  return out
}

// What the screen asks for, as the exporter takes it. JSON, which every OTLP/HTTP backend accepts.
export const screenConfig = (s: StoredTraces, headers: Record<string, string>): OtelConfig | undefined =>
  s.on && s.endpoint.trim() ? { url: tracesUrl(s.endpoint), protocol: 'http/json', headers } : undefined
