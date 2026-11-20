// Reads a login's usage windows with one minimal turn on it, for a login that never reported them.
import type { Quota } from '../shared/types'
import type { Engine, Usage } from './engines/types'

export async function readQuota(engine: Engine, opts: { model: string; cwd: string; account?: string; timeoutMs?: number }): Promise<{ quota?: Quota; usage?: Usage; error?: string }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 60_000)
  let quota: Quota | undefined
  let usage: Usage | undefined
  let error: string | undefined
  try {
    for await (const e of engine.run({ model: opts.model, effort: 'low', system: 'Answer with one word.',prompt: 'Reply with the single word: ok', cwd: opts.cwd, signal: ctl.signal, web: false, ...(opts.account ? { account: opts.account } : {}) })) {
      if (e.type === 'quota') quota = e.quota
      else if (e.type === 'done') usage = e.usage
      else if (e.type === 'error') error = e.message
    }
    if (ctl.signal.aborted && !usage) error ??= 'Timed out'
  } catch (e) {
    error = ctl.signal.aborted ? 'Timed out' : e instanceof Error ? e.message : String(e)
  } finally {
    clearTimeout(timer)
  }
  return { ...(quota ? { quota } : {}), ...(usage ? { usage } : {}), ...(error ? { error } : {}) }
}
