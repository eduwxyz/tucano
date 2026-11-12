// Composio's tools that run other actions: what one call runs, read from its arguments, so the call is
// judged by that and not by the runner's name. Shapes from docs.composio.dev/toolkits/meta-tools
// (multi_execute_tool, proxy_execute); anything else, an extra field included, isn't understood, and a
// call that isn't understood is sensitive.

export const MULTI_EXECUTE = 'COMPOSIO_MULTI_EXECUTE_TOOL'
export const EXECUTE = 'COMPOSIO_EXECUTE_TOOL' // the older single one: tool_slug and arguments at the top
export const PROXY_EXECUTE = 'COMPOSIO_PROXY_EXECUTE'
export const MANAGE_CONNECTIONS = 'COMPOSIO_MANAGE_CONNECTIONS' // links an app's account: the sign-in link
const RUNNERS = new Set([MULTI_EXECUTE, EXECUTE, PROXY_EXECUTE])

// One action a call runs: an app's tool by its slug ("GMAIL_FETCH_EMAILS"), or a raw request to an app's API.
export type InnerAction = { kind: 'tool'; slug: string } | { kind: 'http'; toolkit: string; method: string; endpoint: string; params: { name: string; value: string; type: string }[] }

export const isComposio = (url: string | undefined): boolean => {
  try {
    const u = new URL(url ?? '')
    return u.protocol === 'https:' && /(^|\.)composio\.dev$/i.test(u.hostname)
  } catch {
    return false
  }
}

// A runner whose every call is judged by what it runs: only on Composio's own servers, by its exact name.
export const perCallTool = (url: string | undefined, name: string): boolean => isComposio(url) && RUNNERS.has(name)
// Linking an app's account (Gmail, Calendar…) on Composio's own servers: what even reading needs the first
// time, so a reader sees it too, and each call asks.
export const linksAccounts = (url: string | undefined, name: string): boolean => isComposio(url) && name === MANAGE_CONNECTIONS
// What a read grant sees besides read tools: the runners, for their read-only calls, and the linking.
export const forReaders = (url: string | undefined, name: string): boolean => perCallTool(url, name) || linksAccounts(url, name)
// The same by name only, for the approval card, which shows what a call runs.
export const isRunner = (name: string): boolean => RUNNERS.has(name)

const SLUG = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/ // TOOLKIT_ACTION: letters, digits, single underscores
const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'])
// What the runners take besides the actions themselves: notes about the workflow, never an action.
const NOTES: Record<string, 'string' | 'boolean'> = { thought: 'string', current_step: 'string', current_step_metric: 'string', session_id: 'string', sync_response_to_workbench: 'boolean' }

const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype
// Only these keys, and the notes with their types.
const only = (o: Record<string, unknown>, keys: string[]): boolean => Object.entries(o).every(([k, v]) => keys.includes(k) || (k in NOTES && typeof v === NOTES[k]))
const toolOf = (o: unknown): InnerAction | undefined =>
  plainObject(o) && only(o, ['tool_slug', 'arguments']) && typeof o['tool_slug'] === 'string' && SLUG.test(o['tool_slug']) && plainObject(o['arguments']) ? { kind: 'tool', slug: o['tool_slug'] } : undefined

// What a runner's call runs; undefined when its arguments aren't one of the documented shapes.
export function innerActions(name: string, args: unknown): InnerAction[] | undefined {
  if (!plainObject(args)) return undefined
  if (name === MULTI_EXECUTE) {
    const tools = args['tools']
    if (!only(args, ['tools']) || !Array.isArray(tools) || tools.length === 0 || tools.length > 50) return undefined
    const actions = tools.map(toolOf)
    return actions.every(Boolean) ? (actions as InnerAction[]) : undefined
  }
  if (name === EXECUTE) {
    const { tool_slug, arguments: a, ...rest } = args
    const action = only(rest, []) ? toolOf({ tool_slug, arguments: a }) : undefined
    return action ? [action] : undefined
  }
  if (name === PROXY_EXECUTE) {
    const { toolkit_slug: toolkit, endpoint, method, parameters = [] } = args
    if (!only(args, ['toolkit_slug', 'endpoint', 'method', 'body', 'parameters'])) return undefined
    if (typeof toolkit !== 'string' || !/^[A-Za-z0-9_]+$/.test(toolkit) || typeof endpoint !== 'string' || typeof method !== 'string' || !METHODS.has(method) || !Array.isArray(parameters)) return undefined
    const params = parameters.map((p) => (plainObject(p) && only(p, ['name', 'value', 'type']) && typeof p['name'] === 'string' && typeof p['value'] === 'string' && (p['type'] === 'header' || p['type'] === 'query') ? { name: p['name'], value: p['value'], type: p['type'] } : undefined))
    if (!params.every(Boolean)) return undefined
    return [{ kind: 'http', toolkit, method, endpoint, params: params as { name: string; value: string; type: string }[] }]
  }
  return undefined
}

// "GMAIL_SEND_EMAIL" or "GET github /user/repos", for the approval card.
export const actionLabel = (a: InnerAction): string => (a.kind === 'tool' ? a.slug : `${a.method} ${a.toolkit} ${a.endpoint}`)
