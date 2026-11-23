// What may run through the Databricks CLI. Nothing here runs anything: it answers yes or no for a list
// of arguments, before any process starts. What isn't allowed is refused.
import { L } from '../shared/lang'
import { commandWords, isReadCommand } from '../shared/job-watch'

export interface CliPolicy {
  commands: string[] // "jobs list-runs --job-id --limit"
  apiPaths: string[]
  actions: boolean
}

export type CliVerdict = { ok: true; write: boolean } | { ok: false; reason: string }

// Set by the app on every call, so they're never a reason to refuse.
const APP_FLAGS = new Set(['--output', '--profile'])
// Starting and canceling a job follow their own setting, whatever the list says.
const ACTIONS: Record<string, string[]> = { 'jobs run-now': ['--no-wait'], 'jobs cancel-run': ['--no-wait'] }
const VALUE = /^[\w.:/=?&%,-]+$/

const refuse = (reason: string): CliVerdict => ({ ok: false, reason })

function pathAllowed(path: string, allowed: string[]): boolean {
  const bare = path.split('?')[0]!
  return allowed.some((p) => {
    const prefix = p.trim()
    if (!prefix) return false
    return bare === prefix || bare.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
  })
}

export function checkCli(argv: string[], policy: CliPolicy): CliVerdict {
  if (!argv.length) return refuse(L('Comando vazio.', 'Empty command.'))
  const shown = argv.join(' ')
  const words: string[] = []
  for (const a of argv) {
    if (a.startsWith('-')) break
    words.push(a)
  }

  const action = Object.keys(ACTIONS).find((k) => words.join(' ').startsWith(`${k} `) || words.join(' ') === k)
  if (action && !policy.actions) return refuse(L(`Ações no job estão desligadas nas Configurações: ${shown}`, `Job actions are off in Settings: ${shown}`))

  // Writing through the raw API never goes on the list.
  if (words[0] === 'api' && words[1] !== 'get') return refuse(L(`Só \`api get\` é permitido: ${shown}`, `Only \`api get\` is allowed: ${shown}`))

  const rules = policy.commands.map((line) => ({ words: commandWords(line), flags: line.trim().split(/\s+/).filter((w) => w.startsWith('--')) }))
  const rule = action
    ? { words: action.split(' '), flags: ACTIONS[action]! }
    : rules.filter((r) => r.words.length > 0 && r.words.every((w, i) => words[i] === w)).sort((a, b) => b.words.length - a.words.length)[0]
  if (!rule) return refuse(L(`Comando fora da lista de permitidos: ${shown}`, `Command not on the allowed list: ${shown}`))

  const flags = new Set(rule.flags)
  const values: string[] = words.slice(rule.words.length)
  for (let i = words.length; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const name = a.split('=')[0]!
      if (!APP_FLAGS.has(name) && !flags.has(name)) return refuse(L(`Opção fora da lista de permitidas: ${name}`, `Flag not on the allowed list: ${name}`))
      const inline = a.includes('=') ? a.slice(a.indexOf('=') + 1) : undefined
      if (inline !== undefined) values.push(inline)
    } else if (a.startsWith('-')) {
      return refuse(L(`Opção fora da lista de permitidas: ${a}`, `Flag not on the allowed list: ${a}`))
    } else {
      values.push(a)
    }
  }
  // "@file" makes the CLI read a local file; a shell isn't involved, but nothing here needs either.
  for (const v of values) if (!VALUE.test(v)) return refuse(L(`Argumento recusado: ${v}`, `Argument refused: ${v}`))

  if (words[0] === 'api') {
    // The path comes before any flag: what follows a flag is that flag's value.
    const paths = words.slice(rule.words.length)
    if (paths.length !== 1) return refuse(L(`\`api get\` leva um caminho só: ${shown}`, `\`api get\` takes one path: ${shown}`))
    const path = paths[0]!
    if (!path.startsWith('/') || path.includes('..') || path.includes('//') || path.includes('%') || !pathAllowed(path, policy.apiPaths)) return refuse(L(`Caminho fora da lista de permitidos: ${path}`, `Path not on the allowed list: ${path}`))
  }

  return { ok: true, write: !!action || !isReadCommand(rule.words) }
}
