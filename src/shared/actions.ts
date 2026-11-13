// How far an agent goes on its own. Each agent has a level (careful, normal, free) and,
// over it, a rule per kind of action that matters (a commit, a push, a PR, a merge,
// deleting, sending, publishing, paying, a risky click in its browser or in an app):
// asks me first, does it alone, or never. Settings hold the level and rules for every
// agent; an agent's page, its own. Reading never asks.
// The gateway reads a call (a shell command, a connector tool, a click) into these kinds
// before it runs; what no rule decides goes as the tool's class says, as it always has.
import { L } from './lang'

// The "connector" of approvals for a command on the agent's computer.
export const COMPUTADOR = 'computador'

export const ACTION_KINDS = ['commit', 'push', 'pr', 'merge', 'delete', 'send', 'publish', 'pay', 'browser', 'apps'] as const
export type ActionKind = (typeof ACTION_KINDS)[number]
export type ActionMode = 'ask' | 'auto' | 'off'
export type ActionRules = Partial<Record<ActionKind, ActionMode>>

const MODES: readonly ActionMode[] = ['ask', 'auto', 'off']

// What puts something in front of other people, spends money or can't be undone: after the agent
// has read something from outside in a turn (an email, a page, an issue), these may be what that
// text asked for, so with the guard on they ask first even when a rule lets them run.
export const OUTBOUND: readonly ActionKind[] = ['send', 'publish', 'pay', 'delete', 'browser', 'apps']

export const kindLabel = (k: ActionKind): string =>
  ({
    commit: L('Fazer commit', 'Commit'),
    push: L('Subir commits (push)', 'Push commits'),
    pr: L('Abrir pull request', 'Open a pull request'),
    merge: L('Fazer merge', 'Merge'),
    delete: L('Apagar', 'Delete'),
    send: L('Enviar mensagem', 'Send a message'),
    publish: L('Publicar ou colocar no ar', 'Publish or deploy'),
    pay: L('Pagar ou transferir', 'Pay or transfer'),
    browser: L('Clique arriscado no navegador', "Risky browser clicks"),
    apps: L('Ação arriscada nos apps', "Risky app actions")
  })[k]

export const actionHint = (k: ActionKind): string =>
  ({
    commit: 'git commit',
    push: 'git push',
    pr: L('gh pr create, criar PR num conector', 'gh pr create, creating a PR in a connector'),
    merge: L('git merge, gh pr merge, merge num conector', 'git merge, gh pr merge, merging in a connector'),
    delete: L('rm -r, apagar branch, git reset --hard, apagar num conector', 'rm -r, deleting a branch, git reset --hard, deleting in a connector'),
    send: L('e-mail, Slack, comentário: num conector', 'email, Slack, a comment: in a connector'),
    publish: L('npm publish, deploy, release', 'npm publish, deploy, release'),
    pay: L('pagamento, transferência, reembolso: num conector', 'payment, transfer, refund: in a connector'),
    browser: L('enviar, comprar, confirmar, um botão sem nome: no navegador do agente', 'send, buy, confirm, a button with no name: in the agent’s browser'),
    apps: L('enviar, apagar, confirmar: nos apps do computador', 'send, delete, confirm: in the computer’s apps')
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
    pay: L('pagar', 'pay'),
    browser: L('clicar no navegador', 'click in the browser'),
    apps: L('agir num app', 'act in an app')
  })[k]

export const modeLabel = (m: ActionMode): string => ({ ask: L('Pede aprovação', "Ask first"), auto: L('Faz sozinho', "Automatic"), off: L('Nunca', 'Never') })[m]

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

// ---------- levels ----------

// careful: asks before anything that changes something. normal: asks before what's sensitive
// (sending, deleting, paying…), as Tucano always has. free: does everything on its own.
export type Autonomy = 'careful' | 'normal' | 'free'
export const AUTONOMY_LEVELS: readonly Autonomy[] = ['careful', 'normal', 'free']
export const isAutonomy = (v: unknown): v is Autonomy => typeof v === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(v)

export const autonomyLabel = (a: Autonomy): string => ({ careful: L('Cuidadoso', 'Careful'), normal: L('Normal', 'Normal'), free: L('Sem travas', 'No guardrails') })[a]
export const autonomyHint = (a: Autonomy): string =>
  ({
    careful: L('Pede aprovação antes de qualquer coisa que mude algo: escrever num conector, commit, push, um clique arriscado.', "Ask before changes, including connector writes, commits, pushes, and risky clicks."),
    normal: L('Lê e escreve sozinho; pede antes do que é sensível: enviar, apagar, publicar, pagar, um clique arriscado.', "Allow reads and writes; ask before sending, deleting, publishing, paying, or risky clicks."),
    free: L('Faz tudo sozinho, sem pedir. O que você marcou como alto risco ainda pede.', "Act without approval, except for tools marked high risk.")
  })[a]

// What a level says about a kind; undefined: the tool's class decides (sensitive asks), as before levels.
export const levelMode = (level: Autonomy): ActionMode | undefined => (level === 'careful' ? 'ask' : level === 'free' ? 'auto' : undefined)

// Who decides, most specific first: the agent's rule for that kind; its own level (careful or free);
// the rule in Settings; the level in Settings. An agent left on "Padrão" follows Settings.
export interface Policy {
  agentRules?: ActionRules
  agentLevel?: Autonomy
  globalRules?: ActionRules
  globalLevel?: Autonomy
  guard?: boolean // the outside-content guard (OUTBOUND); off only when the person turned it off
}

export const policyOf = (agent: { actionRules?: ActionRules; autonomy?: Autonomy; outsideGuard?: boolean } | undefined, settings: { actionRules?: ActionRules; autonomy?: Autonomy; outsideGuard?: boolean }): Policy => ({
  agentRules: agent?.actionRules,
  agentLevel: agent?.autonomy,
  globalRules: settings.actionRules,
  globalLevel: settings.autonomy,
  guard: agent?.outsideGuard ?? settings.outsideGuard ?? true
})

export const levelOf = (p: Policy): Autonomy => p.agentLevel ?? p.globalLevel ?? 'normal'

export function actionMode(kind: ActionKind, p: Policy): ActionMode | undefined {
  const own = p.agentRules?.[kind]
  if (own) return own
  if (p.agentLevel && p.agentLevel !== 'normal') return levelMode(p.agentLevel)
  return p.globalRules?.[kind] ?? (p.agentLevel ? undefined : levelMode(p.globalLevel ?? 'normal'))
}

// One call may be several kinds at once (`git commit && git push`): any "never" stops it, else any
// "ask" makes it wait, else one no rule decides leaves it to the class; "auto" only when all say so.
export function gate(kinds: readonly ActionKind[], p: Policy): { mode?: ActionMode; kinds: ActionKind[] } {
  const unique = [...new Set(kinds)]
  for (const mode of ['off', 'ask'] as const) {
    const hit = unique.filter((k) => actionMode(k, p) === mode)
    if (hit.length) return { mode, kinds: hit }
  }
  if (!unique.length || unique.some((k) => actionMode(k, p) === undefined)) return { kinds: unique.filter((k) => actionMode(k, p) === undefined) }
  return { mode: 'auto', kinds: unique }
}

// What happens to one call. `cls`: the tool's class (a command is a write); `alwaysAllowed`: approved
// for good from a card; `outside`: the turn has read something from outside; `askByDefault`: what
// no rule decides asks (a risky click), else it goes by the class.
export type Verdict = { run: boolean; off?: boolean; why: 'read' | 'rule' | 'level' | 'class' | 'always' | 'risk' | 'guard' | 'never'; kinds: ActionKind[] }

export function verdict(o: { cls: 'read' | 'write' | 'sensitive'; kinds: readonly ActionKind[]; p: Policy; highRisk?: boolean; alwaysAllowed?: boolean; outside?: boolean; askByDefault?: boolean }): Verdict {
  if (o.cls === 'read' && !o.askByDefault) return { run: true, why: 'read', kinds: [] }
  const g = gate(o.kinds, o.p)
  if (g.mode === 'off') return { run: false, off: true, why: 'never', kinds: g.kinds }
  if (o.highRisk) return { run: false, why: 'risk', kinds: g.kinds }
  if (g.mode === 'ask') return { run: false, why: 'rule', kinds: g.kinds }
  const level = levelOf(o.p)
  // Let through by a rule or by the level: unless what goes out came after something from outside.
  const loose = (why: Verdict['why'], kinds: readonly ActionKind[], outbound: boolean): Verdict => (outbound && o.p.guard !== false && o.outside ? { run: false, why: 'guard', kinds: [...kinds] } : { run: true, why, kinds: [...kinds] })
  if (g.mode === 'auto') return loose('rule', g.kinds, g.kinds.some((k) => OUTBOUND.includes(k)))
  // No rule decides: the level, then the class.
  if (level === 'careful') return { run: false, why: 'level', kinds: g.kinds }
  if (level === 'free') return loose('level', g.kinds, o.cls === 'sensitive' || !!o.askByDefault || g.kinds.some((k) => OUTBOUND.includes(k)))
  if (o.askByDefault) return { run: false, why: 'class', kinds: g.kinds }
  if (o.cls === 'sensitive') return o.alwaysAllowed ? { run: true, why: 'always', kinds: g.kinds } : { run: false, why: 'class', kinds: g.kinds }
  return { run: true, why: 'class', kinds: g.kinds }
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
