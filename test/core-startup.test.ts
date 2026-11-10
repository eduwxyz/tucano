import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { EngineId, EngineStatus } from '../src/shared/types'
import type { CoreEvent, Wire } from '../src/shared/rpc'

// The harnesses' check, held for as long as the test wants: on a real computer it takes
// seconds (a dozen CLIs), and longer with a hung one or no network.
const detection = vi.hoisted(() => {
  let release: (() => void) | undefined
  return { calls: 0, held: new Promise<void>((r) => (release = r)), release: () => release?.() }
})
const signedIn: EngineStatus = { installed: true, loggedIn: true, path: '/usr/local/bin/claude', version: '2.1.0', route: 'plan', account: 'Plano Claude Max' }
vi.mock('../src/core/engines/detect', async (original) => ({
  ...(await original<typeof import('../src/core/engines/detect')>()),
  adoptLoginShellPath: async () => {},
  detectEngines: async () => {
    detection.calls++
    await detection.held
    const no: EngineStatus = { installed: false, loggedIn: false }
    const engines: Record<EngineId, EngineStatus> = { claude: signedIn, codex: no, opencode: no, pi: no, antigravity: no, cursor: no, grok: no, cline: no }
    return { engines, listed: {}, codexCatalog: [] }
  }
}))

const dataDir = mkdtempSync(join(tmpdir(), 'tucano-startup-'))
const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() })
const saved = { ...process.env }
afterAll(() => {
  process.env = saved
})

// What the window does: a port, then the snapshot; and the events that come after.
function connect(): { events: CoreEvent[]; call: (method: string) => Promise<unknown> } {
  const events: CoreEvent[] = []
  const handlers: ((m: { data: unknown }) => void)[] = []
  const waits = new Map<number, (r: unknown) => void>()
  const port = {
    on: (ev: string, fn: (m: { data: unknown }) => void) => void (ev === 'message' && handlers.push(fn)),
    start: () => {},
    postMessage: (w: Wire) => {
      if ('event' in w) events.push(w.event)
      else waits.get(w.id)?.('result' in w ? w.result : w)
    }
  }
  parent.emit('message', { data: undefined, ports: [port] })
  let id = 0
  return {
    events,
    call: (method) =>
      new Promise((resolve) => {
        waits.set(++id, resolve)
        for (const h of handlers) h({ data: { id, method, params: {} } })
      })
  }
}

describe('the core starting', () => {
  it('says it is ready before the harnesses are checked, and tells the window when they are', async () => {
    Object.assign(process.env, { TUCANO_DATA: dataDir, TUCANO_DEFAULT_WORKSPACE: '0', TUCANO_SEED: '0', TUCANO_WEBHOOK_PORT: '47967', TUCANO_GIT_PORT: '47968', TUCANO_WIKI: join(dataDir, 'wiki') })
    delete process.env['TUCANO_FAKE_ENGINES']
    ;(process as unknown as { parentPort: typeof parent }).parentPort = parent
    await import('../src/core/index')
    // Only that "ready" arrives while the harnesses are still being checked, which the two
    // asserts below state. The boot's wall-clock time is a different claim and not this one's:
    // it measures the test's own poll latency as much as the core, and a starved CI runner took
    // 5.7 s on an unchanged commit, so the assert turned a busy machine into a red shard.
    await vi.waitFor(() => expect(parent.postMessage).toHaveBeenCalledWith({ type: 'ready' }), { timeout: 15_000 })
    expect(detection.calls).toBe(1) // started, and still running

    const window = connect()
    const snapshot = (await window.call('snapshot')) as { settings: { engines: Record<EngineId, EngineStatus> } }
    // Nothing known yet on a first start: the screens say "checking", not "not installed".
    expect(snapshot.settings.engines.claude.checking).toBe(true)

    // The screens asking again meanwhile join the same check.
    await window.call('refreshEngines')
    await window.call('refreshEngines')
    expect(detection.calls).toBe(1)

    detection.release()
    await vi.waitFor(() => expect(window.events.some((e) => e.type === 'settings' && e.settings.engines.claude.loggedIn)).toBe(true))
    // Kept for the next start, which opens on it.
    const kept = JSON.parse(readFileSync(join(dataDir, 'engines.json'), 'utf8')) as { engines: Record<EngineId, EngineStatus> }
    expect(kept.engines.claude).toMatchObject({ loggedIn: true, account: 'Plano Claude Max' })
  }, 15_000)
})
