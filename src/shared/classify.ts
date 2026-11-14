// How a connector's tool, or one call of it, is classified: read, write or sensitive. Pure, so the
// core decides with it and the approval card shows what "always allow" would cover.
import { innerActions, perCallTool, PROXY_EXECUTE, type InnerAction } from './composio'
import type { GrantLevel, ToolClass } from './types'

const READ_WORDS = new Set(['get', 'list', 'search', 'read', 'find', 'fetch', 'query', 'describe', 'show', 'view', 'count', 'lookup', 'retrieve'])
const SENSITIVE_WORDS = new Set(['delete', 'remove', 'merge', 'deploy', 'send', 'publish', 'transfer', 'pay', 'destroy', 'drop', 'revoke'])
// Verbs that put something in front of other people. Each is also a noun ("list_messages", "get_comment"),
// so it counts only as the call's verb: the first verb in the name, with no read verb after it.
const OUTBOUND = new Set(['reply', 'post', 'forward', 'invite', 'share', 'comment', 'email', 'message'])
// Verbs that make something: what they make, when it's one of those (create_comment, add_reply,
// save_comment), goes out too; a draft doesn't.
const MAKE = new Set(['create', 'add', 'new', 'write', 'compose', 'submit', 'make', 'save'])
// Other verbs: the first one in the name is the call's verb, so a noun after it is only a noun.
const OTHER_VERBS = new Set(
  'update set edit modify patch put insert upsert upload download move mark label unlabel assign unassign rename archive unarchive close open reopen star unstar pin unpin react resolve complete toggle enable disable apply attach detach link unlink copy duplicate import export sync generate summarize translate format convert parse schedule cancel start stop run execute restore trash untrash mute unmute block unblock watch unwatch subscribe unsubscribe approve reject lock unlock join leave install uninstall render validate check test preview draft unshare'.split(' ')
)
const PREPOSITIONS = new Set(['to', 'for', 'on', 'in', 'into', 'from', 'with', 'by', 'of', 'at', 'as', 'via'])
// What a made thing is called, plural or not.
const OUTBOUND_THING: Record<string, string> = { replies: 'reply', posts: 'post', invites: 'invite', invitation: 'invite', invitations: 'invite', comments: 'comment', emails: 'email', messages: 'message' }
const thing = (w: string): string => OUTBOUND_THING[w] ?? w

// Tools that run whatever action they're handed (another tool, a request, code), so neither their
// name nor their annotations say what a call does: Composio's, which stand in front of every app's
// real actions. By name they're sensitive; on Composio itself each call is judged by what it runs.
const RUNS_ANY_ACTION = new Set(['composio_multi_execute_tool', 'composio_execute_tool', 'composio_proxy_execute', 'composio_remote_workbench', 'composio_remote_bash_tool'])

// "mergePullRequest" and "merge_pull_request" both become ["merge", "pull", "request"].
export const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// Whether the name's verb, from word `from` on, sends something out: an outbound verb ("post_message",
// "GMAIL_REPLY_TO_THREAD"), or a verb that makes an outbound thing ("create_issue_comment"; not
// "create_email_draft", nor "add_label_to_email", whose thing is the label).
function outbound(w: string[], from: number): boolean {
  const i = w.findIndex((x, k) => k >= from && (READ_WORDS.has(x) || OUTBOUND.has(x) || MAKE.has(x) || OTHER_VERBS.has(x) || SENSITIVE_WORDS.has(x)))
  if (i < 0) return false
  const verb = w[i]!
  if (OUTBOUND.has(verb)) return !w.slice(i + 1).some((x) => READ_WORDS.has(x)) // "email_search" is a search
  if (!MAKE.has(verb) || w.includes('draft')) return false
  const span = w.slice(i + 1)
  const end = span.findIndex((x) => PREPOSITIONS.has(x))
  const made = (end < 0 ? span : span.slice(0, end)).at(-1)
  return !!made && OUTBOUND.has(thing(made))
}

// A tool that runs any action is sensitive; then annotations; then the name. A sensitive word anywhere,
// or an outbound verb, wins over a read verb at the start, since a wrong "read" would skip approval.
export function classify(tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): ToolClass {
  if (RUNS_ANY_ACTION.has(tool.name.toLowerCase())) return 'sensitive'
  if (tool.annotations?.readOnlyHint === true) return 'read'
  if (tool.annotations?.destructiveHint === true) return 'sensitive'
  const w = words(tool.name)
  if (w.some((x) => SENSITIVE_WORDS.has(x)) || outbound(w, 0)) return 'sensitive'
  if (w[0] && READ_WORDS.has(w[0])) return 'read'
  return 'write'
}

// The rules before outbound verbs (0.2.15 and earlier). Only to tell, on the first sync after an
// upgrade, a class still automatic (equal to this) from one the person chose by hand.
export function legacyClassify(tool: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }): ToolClass {
  if (tool.annotations?.readOnlyHint === true) return 'read'
  if (tool.annotations?.destructiveHint === true) return 'sensitive'
  const w = words(tool.name)
  if (w.some((x) => SENSITIVE_WORDS.has(x))) return 'sensitive'
  if (w[0] && READ_WORDS.has(w[0])) return 'read'
  return 'write'
}

// Whether a grant lets one call of this class run (a sensitive one still asks for approval).
export const permits = (cls: ToolClass, grant: GrantLevel | undefined): boolean => (grant === 'read' ? cls === 'read' : grant === 'read_write')

const RANK: Record<ToolClass, number> = { read: 0, write: 1, sensitive: 2 }
const strictest = (classes: ToolClass[]): ToolClass => classes.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'read')

// Words that run code or a workflow: inside a Composio call they're sensitive, like the runners themselves.
const RUNS_CODE = new Set(['execute', 'exec', 'run', 'bash', 'shell', 'eval', 'script'])
// Words in a request that change something, though it goes as a GET (RPC-style APIs: chat.postMessage).
const CHANGE_WORDS = new Set(['post', 'create', 'update', 'set', 'add', 'edit', 'modify', 'write', 'put', 'patch', 'insert', 'upload', 'invite', 'kick', 'archive', 'move', 'rename', 'mark', 'star', 'pin', 'react', 'join', 'leave', 'close', 'open', 'reply', 'forward', 'share', 'approve', 'cancel', 'subscribe', 'unsubscribe', 'trash', 'restore', 'save', 'start', 'stop'])
// Query keys whose value is the operation itself (?action=create).
const OPERATION_KEYS = new Set(['action', 'method', '_method', 'op', 'operation', 'do', 'cmd', 'command', 'mode', 'verb'])

// Remote code tools called directly: they run anything, so a call to them is never allowed for good.
const RUNS_CODE_DIRECTLY = new Set(['composio_remote_workbench', 'composio_remote_bash_tool'])
export const neverAllowedForGood = (toolName: string): boolean => RUNS_CODE_DIRECTLY.has(toolName.toLowerCase())

// A Composio tool inside a call that can't be allowed for good: Composio's own (a runner inside a
// runner) or one that runs code.
const neverForGood = (slug: string): boolean => {
  const w = words(slug)
  return w[0] === 'composio' || w.some((x) => RUNS_CODE.has(x))
}

// One action inside a Composio call. A tool's slug starts with its toolkit ("GMAIL_FETCH_EMAILS"),
// so its verb comes after that; a sensitive word anywhere, or an outbound verb, still wins.
export function classifyAction(a: InnerAction): ToolClass {
  if (a.kind === 'tool') {
    const w = words(a.slug)
    if (neverForGood(a.slug) || w.some((x) => SENSITIVE_WORDS.has(x)) || outbound(w, 1)) return 'sensitive'
    return w[1] && READ_WORDS.has(w[1]) ? 'read' : 'write'
  }
  // A raw request: DELETE, or a sensitive word anywhere in it (path, query, headers), is sensitive.
  // GET and HEAD read, unless the path or a parameter's name names a change (a value may be a search:
  // "state=open") or a header overrides the method; the other methods write.
  const said = words([a.toolkit, a.endpoint, ...a.params.flatMap((p) => [p.name, p.value])].join(' '))
  if (a.method === 'DELETE' || a.toolkit.toLowerCase() === 'composio' || said.some((x) => SENSITIVE_WORDS.has(x) || RUNS_CODE.has(x))) return 'sensitive'
  if (a.method !== 'GET' && a.method !== 'HEAD') return 'write'
  // The query in the endpoint counts like the query parameters; a value counts when its key names an operation.
  const [path = '', query = ''] = a.endpoint.split('?')
  const pairs = [...new URLSearchParams(query)].map(([name, value]) => ({ name, value })).concat(a.params)
  const named = words([path, ...pairs.flatMap((p) => (OPERATION_KEYS.has(p.name.toLowerCase()) ? [p.name, p.value] : [p.name]))].join(' '))
  const override = a.params.some((p) => p.type === 'header' && /method|override/i.test(p.name))
  return override || named.some((x) => CHANGE_WORDS.has(x)) ? 'write' : 'read'
}

// The class of one call: a runner judged on each call takes the strictest of what it runs, and a call
// whose arguments aren't understood is sensitive; any other tool keeps its own class.
export function callClass(tool: { name: string; cls: ToolClass }, connectorUrl: string | undefined, args: Record<string, unknown>): ToolClass {
  if (!perCallTool(connectorUrl, tool.name)) return tool.cls
  const actions = innerActions(tool.name, args)
  if (!actions) return 'sensitive'
  const cls = strictest(actions.map(classifyAction))
  // A request with a body but read by its method would send that body: not a read.
  return cls === 'read' && 'body' in args && args['body'] !== undefined && args['body'] !== null ? 'write' : cls
}

// An item that names an account is allowed for good for that account only: "<connector>:GMAIL_SEND_EMAIL@work".
// A slug never holds "@", so this key can't be one saved before accounts existed.
const ACCOUNT_SEPARATOR = '@'
const ruleKey = (connectorId: string, slug: string, account: string | undefined): string => `${connectorId}:${slug.toUpperCase()}${account ? ACCOUNT_SEPARATOR + account : ''}`
export const ruleTool = (rule: string): { tool: string; account?: string } => {
  const named = rule.slice(rule.indexOf(':') + 1)
  const at = named.indexOf(ACCOUNT_SEPARATOR)
  return at < 0 ? { tool: named } : { tool: named.slice(0, at), account: named.slice(at + 1) }
}

// "Always allow" on a runner's call: one rule per inner tool that asked for approval, keyed by the
// connector and that tool's slug ("<connector>:GMAIL_REPLY_TO_THREAD"), never by the runner. Undefined
// when any of them can't be allowed for good: a raw request, a call not understood, Composio's own
// tools or code.
export function runnerRules(connectorId: string, toolName: string, args: Record<string, unknown>): string[] | undefined {
  if (toolName === PROXY_EXECUTE) return undefined
  const actions = innerActions(toolName, args)
  if (!actions) return undefined
  const asking = actions.filter((a) => classifyAction(a) === 'sensitive')
  if (!asking.length || asking.some((a) => a.kind !== 'tool' || neverForGood(a.slug))) return undefined
  return [...new Set(asking.map((a) => ruleKey(connectorId, (a as { slug: string }).slug, (a as { account?: string }).account)))]
}

// A runner's call runs without asking only when every inner tool that would ask is allowed for good.
export const runnerAllowed = (connectorId: string, toolName: string, args: Record<string, unknown>, rules: string[]): boolean => {
  const need = runnerRules(connectorId, toolName, args)
  return !!need && need.every((r) => rules.includes(r))
}
