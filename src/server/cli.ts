// The server's own commands, run on the machine it lives on, so only whoever can log in there
// decides who may sign in:
//
//   node out/main/server.js pair [--label "My Mac"] [--ssh you@host[:port] | --url https://…]
//                                                     a one-time code, the link that signs a browser in, and
//                                                     (with --ssh or --url) the link that pairs the Mac app
//   node out/main/server.js devices                   who is paired
//   node out/main/server.js revoke <id|label>|--all   take access away
//
// Returns the exit code, or undefined when the arguments aren't a command and the server should start.

import { DEFAULT_PORT, formatPairLink, parseServerUrl, parseSshTarget, type Reach } from '../shared/pairlink'
import { CODE_TTL_MS, type Pairing } from './pairing'

const USAGE = [
  'Usage: tucano-server [command]',
  'From a source checkout: node out/main/server.js [command]',
  '',
  '  (no command)              start the server',
  '  pair [--label "My Mac"]   make a one-time code; label identifies the device, not the VPS',
  '       [--ssh you@host[:port]]   also print the link for the Mac app, to reach this server by an SSH tunnel',
  '       [--url https://…]         or the link for the app to reach it at an address (HTTPS, including Tailscale Serve)',
  '  devices                   list the paired devices',
  '  revoke <id|label>         revoke an exact ID, or all devices with this label (quote spaces)',
  '  revoke --all              take every device\'s access away, and drop the codes not used yet',
  '',
  'Run commands on the VPS as its service user, with the same TUCANO_DATA as the service.',
  'The installed command remembers its data directory and service port.',
  'SSH needs a verified known host and an authorized key available to ssh-agent.',
  'Use a real host/IP: the app does not read SSH config aliases, IdentityFile or ProxyJump.',
  '--url only chooses the pairing address; configure and verify HTTPS separately.',
  'Open the app\'s top environment selector, add an environment, then review and confirm the link.'
]

function pairOptions(args: string[], say: (line: string) => void): Record<string, string> | undefined {
  const options: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!
    const equal = argument.indexOf('=')
    const name = equal < 0 ? argument : argument.slice(0, equal)
    if (!['--label', '--ssh', '--url'].includes(name)) {
      say(`Unknown pairing option: ${name}. See pair --help.`)
      return undefined
    }
    if (name in options) {
      say(`${name} was given twice.`)
      return undefined
    }
    const value = equal < 0 ? args[++i] : argument.slice(equal + 1)
    if (!value?.trim() || value.startsWith('-')) {
      say(`${name} needs a value.`)
      return undefined
    }
    options[name] = value
  }
  return options
}

// How the app reaches this server, from --ssh or --url: undefined when neither is given, null (after saying
// why) when what was given isn't valid.
function reachOf(options: Record<string, string>, say: (line: string) => void): Reach | undefined | null {
  const ssh = options['--ssh']
  const url = options['--url']
  if (ssh === undefined && url === undefined) return undefined
  if (ssh !== undefined && url !== undefined) {
    say('Give --ssh or --url, not both.')
    return null
  }
  if (ssh !== undefined) {
    const r = parseSshTarget(ssh)
    if (!r) say('--ssh wants user@host or user@host:port (the user you sign in to this machine as, and the address you reach it at).')
    return r ?? null
  }
  const origin = url === undefined ? undefined : parseServerUrl(url)
  if (!origin) say('--url wants an HTTPS address (including Tailscale Serve), or HTTP on localhost only, with no path.')
  return origin ? { via: 'url', url: origin } : null
}

const stamp = (t: number): string => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
const count = (n: number): string => `${n} device${n === 1 ? '' : 's'}`

export function cli(argv: string[], pairing: Pairing, base: string, say: (line: string) => void): number | undefined {
  const [cmd, ...args] = argv
  if (cmd === undefined) return undefined
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' ||
    (['pair', 'devices', 'revoke'].includes(cmd) && args.some(a => a === '--help' || a === '-h'))) {
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
    const options = pairOptions(args, say)
    if (!options) return 2
    const label = options['--label']
    // Checked before the code is made, so a typo doesn't use one up.
    const reach = reachOf(options, say)
    if (reach === null) return 2
    const { code, expires } = pairing.invite(label)
    say(`Pairing code: ${code}`)
    say(`For one device, once, until ${stamp(expires)} UTC (${CODE_TTL_MS / 60_000} minutes).`)
    if (reach) {
      const name = label?.trim() || (reach.via === 'ssh' ? reach.host : new URL(reach.url).hostname)
      say(`For the Mac app: ${formatPairLink({ code, reach, remotePort: Number(new URL(base).port) || DEFAULT_PORT, name })}`)
    }
    say(`In a browser: ${reach?.via === 'url' ? reach.url : base}/?pair=${code}`)
    if (reach?.via === 'url') say('The URL must already reach this server; this command does not configure the route.')
    else say('Through a tunnel, use its local address and port instead of the server address above.')
    say('Use this code in the app OR a browser, not both. Generate a separate code for each device.')
    return 0
  }

  if (cmd === 'devices') {
    if (args.length) {
      say('devices takes no arguments. See devices --help.')
      return 2
    }
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
    if (args.length !== 1 || (args[0]!.startsWith('-') && args[0] !== '--all')) {
      say('Say which: revoke <id|label> (quote labels with spaces; see devices), or revoke --all.')
      return 2
    }
    if (args[0] === '--all') {
      say(`Revoked ${count(pairing.revokeAll())}.`)
      return 0
    }
    const which = args[0]!
    const n = pairing.revoke(which)
    say(n ? `Revoked ${count(n)}.` : `No device with the id or label "${which}".`)
    return n ? 0 : 1
  }

  say(`Unknown command: ${cmd}`)
  for (const l of USAGE) say(l)
  return 2
}
