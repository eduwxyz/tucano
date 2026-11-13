// The rule the panel leans on: draw the last read at once, and read behind it. Tested here rather than
// through the page, because what matters is which calls reach a provider and when.
import { expect, it, vi } from 'vitest'
import { quotaCache } from '../src/core/quota-cache'
import type { ProviderQuota } from '../src/shared/types'

const one = (id: string, at = 0): ProviderQuota => ({ id, label: id, via: 'Pi', at })

it('reads when there is nothing held yet, and hands the read back', async () => {
  const read = vi.fn(async () => [one('zai')])
  const cache = quotaCache(read, { now: () => 1_000 })
  const snap = await cache.get()
  expect(read).toHaveBeenCalledTimes(1)
  expect(snap.list).toHaveLength(1)
  expect(snap.at).toBe(1_000)
})

it('answers from what it holds inside the window, without asking a provider', async () => {
  const read = vi.fn(async () => [one('zai')])
  let clock = 1_000
  const cache = quotaCache(read, { staleMs: 60_000, now: () => clock })
  await cache.get()
  clock = 30_000
  const again = await cache.get()
  expect(read).toHaveBeenCalledTimes(1)
  expect(again.list[0]?.id).toBe('zai')
})

it('gives the held snapshot at once when it is old, and reads behind it', async () => {
  const read = vi.fn(async () => [one('zai')])
  let clock = 1_000
  const cache = quotaCache(read, { staleMs: 60_000, now: () => clock })
  await cache.get()
  read.mockImplementationOnce(async () => [one('deepseek')])
  clock = 200_000
  const held = await cache.get() // answers before the read even starts answering
  expect(held.list[0]?.id).toBe('zai')
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(cache.current()?.list[0]?.id).toBe('deepseek') // and the next look is the new one
})

it('reads now when asked, even when what it holds is fresh', async () => {
  const read = vi.fn(async () => [one('zai')])
  let clock = 1_000
  const cache = quotaCache(read, { staleMs: 60_000, now: () => clock })
  await cache.get()
  read.mockImplementationOnce(async () => [one('deepseek')])
  clock = 2_000
  const fresh = await cache.refresh()
  expect(read).toHaveBeenCalledTimes(2)
  expect(fresh.list[0]?.id).toBe('deepseek')
})

it('joins a read already running instead of starting a second', async () => {
  let release: (list: ProviderQuota[]) => void = () => {}
  const read = vi.fn(() => new Promise<ProviderQuota[]>((ok) => (release = ok)))
  const cache = quotaCache(read, { now: () => 1_000 })
  const a = cache.get()
  const b = cache.refresh()
  release([one('zai')])
  await Promise.all([a, b])
  expect(read).toHaveBeenCalledTimes(1)
})

it('keeps what it held when a read fails', async () => {
  const read = vi.fn(async () => [one('zai')])
  let clock = 1_000
  const cache = quotaCache(read, { staleMs: 60_000, now: () => clock })
  await cache.get()
  read.mockImplementationOnce(async () => {
    throw new Error('the network is down')
  })
  clock = 200_000
  await cache.refresh()
  expect(cache.current()?.list[0]?.id).toBe('zai') // an old number, not an empty panel
})
