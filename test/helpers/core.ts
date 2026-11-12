// The real core (src/core/index.ts), booted in this test's process with fake engines and a
// stand-in for Electron's parentPort, as the server does: each person gets a port and calls
// the API as their page would. One core per test file (the module runs once).
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CoreEvent } from '../../src/shared/rpc'

export class Port extends EventEmitter {
  constructor(readonly postMessage: (msg: unknown) => void) {
    super()
  }
  start(): void {}
  close(): void {
    this.emit('close')
  }
}

export interface Client {
  call: <T = unknown>(method: string, params?: unknown) => Promise<T>
  events: CoreEvent[]
}

export interface TestCore {
  dataDir: string
  toMain: Record<string, unknown>[] // what the core sent its parent
  connect: (person?: string, device?: string) => Client
  ask: <T>(msg: Record<string, unknown>, type: string) => Promise<T>
}

export async function bootCore(opts: { server?: boolean; seed?: boolean } = {}): Promise<TestCore> {
  const dataDir = mkdtempSync(join(tmpdir(), 'tucano-core-'))
  const toMain: Record<string, unknown>[] = []
  const waits = new Map<string, (m: Record<string, unknown>) => void>()
  const parent = new Port((msg) => {
    const m = msg as Record<string, unknown>
    toMain.push(m)
    const w = typeof m['id'] === 'string' ? waits.get(m['id']) : undefined
    if (w) w(m)
  })
  process.env['TUCANO_DATA'] = dataDir
  process.env['TUCANO_FAKE_ENGINES'] = '1'
  if (opts.seed === false) process.env['TUCANO_DEFAULT_WORKSPACE'] = '0'
  if (opts.server) process.env['TUCANO_SERVER'] = '1'
  ;(process as unknown as { parentPort: Port }).parentPort = parent
  await import('../../src/core/index')
  let seq = 0
  let n = 0
  const connect = (person?: string, device?: string): Client => {
    const events: CoreEvent[] = []
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
    const port = new Port((msg) => {
      const m = msg as { id?: number; result?: unknown; error?: string; event?: CoreEvent }
      if (m.event) events.push(m.event)
      else if (typeof m.id === 'number') {
        const p = pending.get(m.id)
        pending.delete(m.id)
        if (m.error !== undefined) p?.reject(new Error(m.error))
        else p?.resolve(m.result)
      }
    })
    parent.emit('message', { data: person || device ? { ...(person ? { person } : {}), ...(device ? { device } : {}) } : null, ports: [port] })
    return {
      events,
      call: <T,>(method: string, params?: unknown) =>
        new Promise<T>((resolve, reject) => {
          const id = ++seq
          pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
          port.emit('message', { data: { id, method, params } })
        })
    }
  }
  const ask = <T,>(msg: Record<string, unknown>, type: string): Promise<T> =>
    new Promise<T>((resolve) => {
      const id = `t${++n}`
      waits.set(id, (m) => {
        if (m['type'] === type) waits.delete(id), resolve(m as T)
      })
      parent.emit('message', { data: { ...msg, id }, ports: [] })
    })
  return { dataDir, toMain, connect, ask }
}
