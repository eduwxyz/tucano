// Keeping the last quota read so the page never opens on an empty panel: the snapshot is handed back
// at once, and a read is started behind it when what is held is old. The five-hour windows providers
// report move slowly, so a minute of staleness costs nothing and a read every time the page opens costs
// a request to every provider.
import type { ProviderQuota, QuotasSnapshot } from '../shared/types'

export interface QuotaCache {
  // The snapshot held, or a read when there is none yet. Old enough to be worth re-reading: the cached
  // one comes back now and the read runs behind it.
  get: () => Promise<QuotasSnapshot>
  // A read now, whether or not the cache is recent. Joins one already running.
  refresh: () => Promise<QuotasSnapshot>
  // What is held, without asking anything.
  current: () => QuotasSnapshot | undefined
}

export function quotaCache(
  read: () => Promise<ProviderQuota[]>,
  opts: { staleMs?: number; now?: () => number } = {}
): QuotaCache {
  const staleMs = opts.staleMs ?? 60_000
  const now = opts.now ?? Date.now
  let held: QuotasSnapshot | undefined
  let running: Promise<QuotasSnapshot> | undefined

  const refresh = (): Promise<QuotasSnapshot> => {
    if (running) return running
    const started = read()
      .then((list) => {
        held = { list, at: now() }
        return held
      })
      .finally(() => {
        running = undefined
      })
    // A failed read keeps what was already held: an empty panel says less than a slightly old one.
    running = started.catch(() => held ?? { list: [], at: now() })
    return running
  }

  return {
    get: () => {
      if (!held) return refresh()
      // Stale: the panel draws what is held, and the read lands in the cache for the next look.
      if (now() - held.at > staleMs) void refresh()
      return Promise.resolve(held)
    },
    refresh,
    current: () => held
  }
}
