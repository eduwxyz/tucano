// Actions that matter (a commit, a push, a PR, a merge, deleting, sending, publishing,
// paying) and what an agent does about each: asks me first, does it alone, or never.
// Set for everyone in Settings and per agent on its page; reading never asks.
// The gateway reads a call (a shell command, a connector tool) into these kinds
// before it runs, so a call that matches an "ask" rule waits for my answer.
import { L } from './lang'

// The "connector" of approvals for a command on the agent's computer.
export const COMPUTADOR = 'computador'

export const ACTION_KINDS = ['commit', 'push', 'pr', 'merge', 'delete', 'send', 'publish', 'pay'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
export type ActionMode = 'ask' | 'auto' | 'off'
export type ActionRules = Partial<Record<ActionKind, ActionMode>>

const MODES: readonly ActionMode[] = ['ask', 'auto', 'off']

// Out of the box every kind asks: it's the person who loosens a rule, never the app.
export const DEFAULT_ACTION_MODE: Record<ActionKind, ActionMode> = { commit: 'ask', push: 'ask', pr: 'ask', merge: 'ask', delete: 'ask', send: 'ask', publish: 'ask', pay: 'ask' }

export const actionLabel = (k: ActionKind): string =>
  ({
    commit: L('Fazer commit', 'Commit'),
    push: L('Subir commits (push)', 'Push commits'),
    pr: L('Abrir pull request', 'Open a pull request'),
    merge: L('Fazer merge', 'Merge'),
    delete: L('Apagar', 'Delete'),
    send: L('Enviar mensagem', 'Send a message'),
    publish: L('Publicar ou colocar no ar', 'Publish or deploy'),
    pay: L('Pagar ou transferir', 'Pay or transfer')
  })[k]

export const actionHint = (k: ActionKind): string =>
  ({
    commit: 'git commit',
    push: 'git push',
    pr: L('gh pr create, abrir_pr, criar PR num conector', 'gh pr create, abrir_pr, creating a PR in a connector'),
    merge: L('git merge, gh pr merge, merge num conector', 'git merge, gh pr merge, merging in a connector'),
    delete: L('rm -r, apagar branch, git reset --hard, apagar num conector', 'rm -r, deleting a branch, git reset --hard, deleting in a connector'),
    send: L('e-mail, Slack, comentário: num conector', 'email, Slack, a comment: in a connector'),
    publish: L('npm publish, deploy, release', 'npm publish, deploy, release'),
    pay: L('pagamento, transferência, reembolso: num conector', 'payment, transfer, refund: in a connector')
  })[k]

// What the agent does, in its own words for the approval card: "quer fazer commit".
export const actionVerb = (k: ActionKind): string =>
  ({
    commit: L('fazer commit', 'commit'),
    push: L('subir commits (push)', 'push commits'),
    pr: L('abrir uma pull request', 'open a pull request'),
    merge: L('fazer merge', 'merge'),
    delete: L('apagar', 'delete'),
    send: L('enviar uma mensagem', 'send a message'),
    publish: L('publicar', 'publish'),
    pay: L('pagar', 'pay')
  })[k]

export const modeLabel = (m: ActionMode): string => ({ ask: L('Pede aprovação', 'Asks first'), auto: L('Faz sozinho', 'Does it alone'), off: L('Nunca', 'Never') })[m]

// Only known kinds with known modes: what a saved rule set may hold.
export function cleanRules(value: unknown): ActionRules {
  if (!value || typeof value !== 'object') return {}
  const out: ActionRules = {}
  for (const k of ACTION_KINDS) {
    const m = (value as Record<string, unknown>)[k]
    if (typeof m === 'string' && (MODES as readonly string[]).includes(m)) out[k] = m as ActionMode
  }
  return out
}

// The agent's own rule wins; then the one in Settings; then the default.
export const actionMode = (kind: ActionKind, agentRules?: ActionRules, globalRules?: ActionRules): ActionMode => agentRules?.[kind] ?? globalRules?.[kind] ?? DEFAULT_ACTION_MODE[kind]

// One call may be several kinds at once (`git commit && git push`): any "never" stops it,
// else any "ask" makes it wait; `kinds` are the ones that decided it.
export function gate(kinds: readonly ActionKind[], agentRules?: ActionRules, globalRules?: ActionRules): { mode: ActionMode; kinds: ActionKind[] } {
  const unique = [...new Set(kinds)]
  for (const mode of ['off', 'ask'] as const) {
    const hit = unique.filter((k) => actionMode(k, agentRules, globalRules) === mode)
    if (hit.length) return { mode, kinds: hit }
  }
  return { mode: 'auto', kinds: unique }
}

// ---------- reading a connector tool ----------

// "mergePullRequest" and "merge_pull_request" both become ["merge", "pull", "request"].
const words = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

// What a connector tool that changes something does, by its name. Read tools have no kind.
export function toolActions(name: string): ActionKind[] {
  const w = new Set(words(name))
  const has = (...x: string[]): boolean => x.some((v) => w.has(v))
  const out: ActionKind[] = []
  if (has('commit')) out.push('commit')
  if (has('push')) out.push('push')
  if (((has('pull') && has('request')) || has('pr', 'mr')) && has('create', 'open', 'new')) out.push('pr')
  if (has('merge')) out.push('merge')
  if (has('delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'trash')) out.push('delete')
  if (has('send', 'reply') || (has('post') && has('message', 'comment', 'chat', 'email', 'mail'))) out.push('send')
  if (has('publish', 'deploy', 'release', 'rollback')) out.push('publish')
  if (has('pay', 'payment', 'transfer', 'charge', 'refund', 'purchase', 'payout', 'buy')) out.push('pay')
  return out
}

// ---------- reading a shell command ----------

// The simple commands in a command line, each as its words, with quotes taken off;
// what runs inside $(…), `…` and bash -c '…' counts as well.
export function simpleCommands(src: string, depth = 0): string[][] {
  const out: string[][] = []
  const nested: string[] = []
  let cur: string[] = []
  let tok = ''
  let started = false
  const end = (): void => {
    if (started) cur.push(tok)
    tok = ''
    started = false
  }
  const split = (): void => {
    end()
    if (cur.length) out.push(cur)
    cur = []
  }
  // From an opening "$(" or "(", the index of its closing ")".
  const closing = (from: number): number => {
    let level = 0
    for (let j = from; j < src.length; j++) {
      if (src[j] === '(') level++
      else if (src[j] === ')' && --level === 0) return j
    }
    return src.length
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === '\\') {
      if (src[i + 1] === '\n') i++
      else if (i + 1 < src.length) ((tok += src[++i]), (started = true))
      continue
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1)
      tok += src.slice(i + 1, j < 0 ? src.length : j)
      started = true
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          s += src[j + 1]
          j += 2
          continue
        }
        s += src[j]
        j++
      }
      // Substitutions inside double quotes still run.
      for (const m of s.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) nested.push(m[1] ?? m[2] ?? '')
      tok += s
      started = true
      i = j
      continue
    }
    if (c === '$' && src[i + 1] === '(') {
      const j = closing(i + 1)
      nested.push(src.slice(i + 2, j))
      tok += '$()'
      started = true
      i = j
      continue
    }
    if (c === '$' && src[i + 1] === '{') {
      const j = src.indexOf('}', i)
      tok += src.slice(i, j < 0 ? src.length : j + 1)
      started = true
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1)
      nested.push(src.slice(i + 1, j < 0 ? src.length : j))
      i = j < 0 ? src.length : j
      continue
    }
    if (c === '#' && !started) {
      const j = src.indexOf('\n', i)
      i = j < 0 ? src.length : j - 1
      continue
    }
    if (c === '\n' || ';&|(){}'.includes(c)) {
      split()
      continue
    }
    if (c === '<' || c === '>' || /\s/.test(c)) {
      end()
      continue
    }
    tok += c
    started = true
  }
  split()
  if (depth < 4) for (const n of nested) out.push(...simpleCommands(n, depth + 1))
  return out
}

// Commands that run the one after them, with the options of theirs that take a value.
const WRAPPERS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: ['-f', '-o'],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  xargs: ['-n', '-P', '-L', '-I', '-d', '-E', '-s', '-a'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k']
}
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish'])
// Folders a build makes again: wiping them isn't deleting anything of value.
const REGENERABLE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.cache|\.turbo|\.parcel-cache|coverage|__pycache__|\.pytest_cache|\.venv|venv|target)\/?$|^\/tmp\//
const base = (w: string): string => w.slice(w.lastIndexOf('/') + 1)
const flag = (args: string[], re: RegExp, ...long: string[]): boolean => args.some((a) => re.test(a) || long.includes(a))

// git's own options before the subcommand: `git -C repo -c k=v push`.
function gitSub(args: string[]): { sub: string; rest: string[] } {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(a)) i++
    else if (!a.startsWith('-')) return { sub: a, rest: args.slice(i + 1) }
  }
  return { sub: '', rest: [] }
}

function gitKinds(args: string[]): ActionKind[] {
  const { sub, rest } = gitSub(args)
  switch (sub) {
    case 'commit':
      return ['commit']
    case 'push':
      return flag(rest, /^-[a-zA-Z]*d$/, '--delete') || rest.some((r) => /^\+?:[^/]/.test(r)) ? ['push', 'delete'] : ['push']
    case 'merge':
      return rest.some((r) => r === '--abort' || r === '--quit') ? [] : ['merge']
    case 'branch':
      return flag(rest, /^-[a-zA-Z]*[dD]/, '--delete') ? ['delete'] : []
    case 'tag':
      return flag(rest, /^-[a-zA-Z]*d/, '--delete') ? ['delete'] : []
    case 'reset':
      return rest.includes('--hard') ? ['delete'] : []
    case 'clean':
      return flag(rest, /^-[a-zA-Z]*f/, '--force') ? ['delete'] : []
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? ['delete'] : []
    default:
      return []
  }
}

function commandKinds(words: string[], depth: number): ActionKind[] {
  let w = words
  // Skip what only sets up the real command: VAR=1, sudo, env, xargs and their options.
  for (;;) {
    while (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1)
    const head = w[0] ? base(w[0]) : ''
    const valued = Object.hasOwn(WRAPPERS, head) ? WRAPPERS[head]! : undefined
    if (!valued) break
    w = w.slice(1)
    while (w[0]?.startsWith('-')) w = w.slice(valued.includes(w[0]) ? 2 : 1)
    if (head === 'timeout') w = w.slice(1) // the duration
  }
  const cmd = w[0] ? base(w[0]) : ''
  const args = w.slice(1)
  if (!cmd) return []
  if (SHELLS.has(cmd) || cmd === 'eval') {
    const at = cmd === 'eval' ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a))
    const script = cmd === 'eval' ? args.join(' ') : at >= 0 ? (args[at + 1] ?? '') : ''
    return depth < 4 ? shellActions(script, depth + 1) : []
  }
  const sub = args.find((a) => !a.startsWith('-')) ?? ''
  const after = (s: string): string | undefined => args[args.indexOf(s) + 1]
  switch (cmd) {
    case 'git':
      return gitKinds(args)
    case 'gh': {
      const what = after(sub)
      if (sub === 'pr' && what === 'create') return ['pr']
      if (sub === 'pr' && what === 'merge') return ['merge']
      if (sub === 'release' && what === 'create') return ['publish']
      if (what === 'delete' || what === 'delete-asset') return ['delete']
      if (sub === 'api' && args.some((a, i) => /^(-X|--method)$/.test(args[i - 1] ?? '') && a.toUpperCase() === 'DELETE')) return ['delete']
      return []
    }
    case 'glab': {
      const what = after(sub)
      if (sub === 'mr' && what === 'create') return ['pr']
      if (sub === 'mr' && what === 'merge') return ['merge']
      return what === 'delete' ? ['delete'] : []
    }
    case 'hub':
      return sub === 'pull-request' ? ['pr'] : []
    case 'rm': {
      if (!flag(args, /^-[a-zA-Z]*[rR]/, '--recursive')) return []
      const targets = args.filter((a) => !a.startsWith('-'))
      return targets.length && targets.every((t) => REGENERABLE.test(t)) ? [] : ['delete']
    }
    case 'find':
      return args.includes('-delete') ? ['delete'] : []
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
    case 'cargo':
    case 'poetry':
    case 'gem':
      return sub === 'publish' || (cmd === 'gem' && sub === 'push') ? ['publish'] : []
    case 'twine':
      return sub === 'upload' ? ['publish'] : []
    case 'docker':
    case 'podman':
      return sub === 'push' ? ['publish'] : []
    case 'vercel':
      return sub === 'deploy' || args.includes('--prod') ? ['publish'] : []
    case 'netlify':
    case 'fly':
    case 'flyctl':
    case 'firebase':
    case 'wrangler':
      return sub === 'deploy' || sub === 'publish' ? ['publish'] : []
    case 'terraform':
    case 'tofu':
      return sub === 'apply' || sub === 'destroy' ? [sub === 'apply' ? 'publish' : 'delete'] : []
    default:
      return []
  }
}

// What a shell command does that matters, in order, once each. It reads every
// command of the line (after &&, ;, |, inside $(…) and bash -c), and quoted text
// only where it runs: `git commit -m "rm -rf x"` is a commit, not a delete.
export function shellActions(command: string, depth = 0): ActionKind[] {
  const out: ActionKind[] = []
  for (const words of simpleCommands(command)) for (const k of commandKinds(words, depth)) if (!out.includes(k)) out.push(k)
  return out
}
