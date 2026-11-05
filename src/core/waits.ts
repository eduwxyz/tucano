// Waiting, done by the app instead of the agent. A connector's result can come back still being made
// (a SQL statement queued or running, a job started): left to the agent, it sleeps in a shell and asks
// again, a model step and a minute each time, and the repeat guards miss it since every answer differs
// a little. Here the app asks the connector's own status tool, with backoff, and hands back the result
// once it's done, in the one call the agent made.
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { ConnectorTool } from '../shared/types'

// States that mean "not done yet", as async APIs spell them (Databricks SQL: PENDING, RUNNING).
const NOT_DONE = /^(pending|running|queued|in_progress|in-progress|starting|submitted|scheduled|waiting|processing|accepted)$/i
const STATE_KEY = /^(state|status|life_cycle_state|lifecycle_state|run_state|statement_state)$/i
const ID_KEY = /(^id$|_id$|Id$)/

export interface Pending {
  state: string
  ids: Record<string, string> // every id-looking field of the result, by its key ("statement_id")
}

const text = (r: CallToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')

// Walks a parsed result for a not-done state and the ids next to it.
function walk(v: unknown, out: { state?: string; ids: Record<string, string> }, depth = 0): void {
  if (depth > 6 || !v || typeof v !== 'object') return
  if (Array.isArray(v)) return // a list of rows is data, not a status
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === 'string') {
      if (STATE_KEY.test(k) && NOT_DONE.test(x.trim())) out.state ??= x.trim().toUpperCase()
      else if (ID_KEY.test(k) && x.trim() && x.length <= 200) out.ids[k] ??= x.trim()
    } else if (x && typeof x === 'object') walk(x, out, depth + 1)
  }
}

// What a result says when it isn't done yet: its state and its ids. Undefined when it's done, failed,
// or isn't a status at all. Only structured results count (JSON text): prose saying "pending" doesn't.
export function pendingOf(r: CallToolResult): Pending | undefined {
  if (r.isError) return undefined
  const t = text(r).trim()
  if (!t.startsWith('{')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return undefined
  }
  const out: { state?: string; ids: Record<string, string> } = { ids: {} }
  walk(parsed, out)
  return out.state && Object.keys(out.ids).length ? { state: out.state, ids: out.ids } : undefined
}

type Tool = ConnectorTool & { inputSchema?: Record<string, unknown> }

const POLL_NAME = /poll|status|wait|get_?(statement|result|run|job|query|operation|execution)/i

// The connector's own status tool for a pending result: a read tool whose name says it polls, and
// whose required arguments are all ids the result gave. The tool that was just called counts too
// (asking poll_sql_result again is how the agent would have waited).
export function pollTool(tools: Tool[], p: Pending, can: (t: Tool) => boolean): { tool: Tool; args: Record<string, string> } | undefined {
  for (const t of tools) {
    if (t.cls !== 'read' || !POLL_NAME.test(t.name) || !can(t)) continue
    const schema = (t.inputSchema ?? {}) as { required?: unknown; properties?: Record<string, unknown> }
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
    const keys = required.length ? required : Object.keys(schema.properties ?? {}).filter((k) => k in p.ids)
    if (!keys.length || !keys.every((k) => k in p.ids)) continue
    return { tool: t, args: Object.fromEntries(keys.map((k) => [k, p.ids[k]!])) }
  }
  return undefined
}

// Seconds the command sleeps before anything else: "sleep 60", "sleep 1m && curl …". 0 when it doesn't
// start by sleeping (a sleep inside a loop that checks something is a real wait, and runs).
export function sleepSeconds(command: string): number {
  const m = /^\s*(?:\(\s*)?sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=\s|;|&|\)|$)/.exec(command)
  if (!m) return 0
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as '' | 's' | 'm' | 'h' | 'd']
  return Number(m[1]) * unit
}

export const realWait = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

// Polls until the result is done, the time is up or the reply is stopped: 2 s, 4 s, 8 s… up to 15 s apart.
export async function awaitDone(
  first: CallToolResult,
  poll: (p: Pending) => Promise<CallToolResult | undefined>, // undefined: nothing to poll with
  opts: { maxMs: number; wait?: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; signal?: AbortSignal }
): Promise<{ result: CallToolResult; polls: number; ms: number; pending?: Pending }> {
  const wait = opts.wait ?? realWait
  const now = opts.now ?? Date.now
  const start = now()
  let result = first
  let polls = 0
  let pause = 2_000
  for (let p = pendingOf(result); p; p = pendingOf(result)) {
    const left = opts.maxMs - (now() - start)
    if (left <= 0 || opts.signal?.aborted) return { result, polls, ms: now() - start, pending: p }
    await wait(Math.min(pause, left), opts.signal)
    pause = Math.min(pause * 2, 15_000)
    if (opts.signal?.aborted) return { result, polls, ms: now() - start, pending: p }
    const next = await poll(p)
    if (!next) return { result, polls, ms: now() - start, pending: p }
    polls++
    result = next
  }
  return { result, polls, ms: now() - start }
}
