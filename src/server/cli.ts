// The server's own commands, run on the machine it lives on, so only whoever can log in there
// decides who may sign in:
//
//   node out/main/server.js pair [--label "My Mac"]   a one-time code, and the link that signs a browser in
//   node out/main/server.js devices                   who is paired
//   node out/main/server.js revoke <id|label>|--all   take access away
//
// Returns the exit code, or undefined when the arguments aren't a command and the server should start.

import { CODE_TTL_MS, type Pairing } from './pairing'

const USAGE = [
  'Usage: node out/main/server.js [command]',
  '',
  '  (no command)              start the server',
  '  pair [--label "My Mac"]   make a one-time code to pair a browser or the app',
  '  devices                   list the paired devices',
  '  revoke <id|label>         take one device\'s access away',
  '  revoke --all              take every device\'s access away, and drop the codes not used yet'
]

function flag(args: string[], name: string): string | undefined {
  const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`))
  const a = args[i]
  if (a === undefined) return undefined
  return a === name ? args[i + 1] : a.slice(name.length + 1)
}

const stamp = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const count = (n: number): string => `${n} device${n === 1 ? '' : 's'}`

export function cli(argv: string[], pairing: Pairing, base: string, say: (line: string) => void): number | undefined {
  const [cmd, ...args] = argv
  if (cmd === undefined) return undefined
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    for (const l of USAGE) say(l)
    return 0
  }
  if (cmd.startsWith('-')) return undefined
  try {
    return run(cmd, args, pairing, base, say)
  } catch (e) {
    // The file is busy (another command, or the server, is changing it) or the data directory can't be written.
    say(`Could not do that: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

function run(cmd: string, args: string[], pairing: Pairing, base: string, say: (line: string) => void): number {
  if (cmd === 'pair') {
    const { code, expires } = pairing.invite(flag(args, '--label'))
    say(`Pairing code: ${code}`)
    say(`For one device, once, until ${stamp(expires)} UTC (${CODE_TTL_MS / 60_000} minutes).`)
    say(`In a browser: ${base}/?pair=${code}`)
    say('Through a tunnel or a proxy, use the address you reach the server at instead of that one.')
    return 0
  }

  if (cmd === 'devices') {
    const list = pairing.list()
    if (!list.length) {
      say('No paired devices. Make a code with: pair')
    } else {
      say('ID        LABEL                PAIRED (UTC)      LAST SEEN (UTC)')
      for (const d of list) say(`${d.id.padEnd(9)} ${d.label.padEnd(20)} ${stamp(d.created)}  ${stamp(d.seen)}`)
    }
    return 0
  }

  if (cmd === 'revoke') {
    if (args.includes('--all')) {
      say(`Revoked ${count(pairing.revokeAll())}.`)
      return 0
    }
    const which = args.find((a) => !a.startsWith('--'))
    if (!which) {
      say('Say which: revoke <id|label> (see devices), or revoke --all.')
      return 2
    }
    const n = pairing.revoke(which)
    say(n ? `Revoked ${count(n)}.` : `No device with the id or label "${which}".`)
    return n ? 0 : 1
  }

  say(`Unknown command: ${cmd}`)
  for (const l of USAGE) say(l)
  return 2
}
