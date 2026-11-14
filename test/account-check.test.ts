import { describe, expect, it } from 'vitest'
import type { Quota } from '../src/shared/types'
import { readQuota } from '../src/core/account-check'
import type { Engine, EngineEvent, Turn } from '../src/core/engines/types'

const quota = (u: number): Quota => ({ fiveHour: { utilization: u, resetsAt: 1 }, at: 1 })
const usage = { inputTokens: 5, cacheReadTokens: 0, outputTokens: 1 }
const engine = (events: EngineEvent[], seen: Turn[] = []): Engine => ({
  id: 'claude',
  run: (t) =>
    (async function* (): AsyncIterable<EngineEvent> {
      seen.push(t)
      yield* events
    })()
})
const opts = { model: 'haiku', cwd: '/tmp' }

describe('readQuota', () => {
  it('returns the last quota seen and the usage', async () => {
    const r = await readQuota(engine([{ type: 'quota', quota: quota(0.1) }, { type: 'text', delta: 'ok' }, { type: 'quota', quota: quota(0.4) }, { type: 'done', text: 'ok', usage }]), opts)
    expect(r.quota).toEqual(quota(0.4))
    expect(r.usage).toEqual(usage)
    expect(r.error).toBeUndefined()
  })

  it('returns the message of an error event', async () => {
    const r = await readQuota(engine([{ type: 'error', message: "You've hit your limit" }]), opts)
    expect(r.error).toBe("You've hit your limit")
    expect(r.quota).toBeUndefined()
  })

  it('times out into an error when the engine never ends', async () => {
    const hang: Engine = {
      id: 'claude',
      run: (t) =>
        (async function* (): AsyncIterable<EngineEvent> {
          await new Promise<void>((res) => t.signal.addEventListener('abort', () => res()))
        })()
    }
    const r = await readQuota(hang, { ...opts, timeoutMs: 20 })
    expect(r.error).toBeTruthy()
    expect(r.usage).toBeUndefined()
  })

  it('passes the account through to the turn, on a minimal one', async () => {
    const seen: Turn[] = []
    await readQuota(engine([{ type: 'done', text: 'ok', usage }], seen), { ...opts, account: '/data/accounts/w1' })
    expect(seen[0]!.account).toBe('/data/accounts/w1')
    expect(seen[0]!.model).toBe('haiku')
    expect(seen[0]!.effort).toBe('low')
    expect(seen[0]!.web).toBe(false)
    expect(seen[0]!.system).toBeTruthy()
    expect(seen[0]!.session).toBeUndefined()
    expect(seen[0]!.mcpUrl).toBeUndefined()
  })
})
