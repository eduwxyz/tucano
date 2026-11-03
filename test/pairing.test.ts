import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cli } from '../src/server/cli'
import { parsePairLink } from '../src/shared/pairlink'
import { CODE_TTL_MS, Pairing, SESSION_MS, cleanLabel, cookieName, normalizeCode, pairRequest } from '../src/server/pairing'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

let dir: string
let t: number
const file = (): string => join(dir, 'pairing.json')
const lock = (): string => `${file()}.lock`
const open = (): Pairing => new Pairing(file(), () => t)
// A writer that gives up quickly, for a file somebody else keeps busy.
const impatient = (): Pairing => new Pairing(file(), () => t, { staleMs: 60_000, waitMs: 60 })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tucano-pair-'))
  t = 1_700_000_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('a pairing code', () => {
  it('is twelve characters, in groups of four, none easy to misread', () => {
    const { code, expires } = open().invite('Mac')
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(expires).toBe(t + CODE_TTL_MS)
  })

  it('is different every time', () => {
    const p = open()
    const codes = new Set(Array.from({ length: 15 }, () => p.invite().code))
    expect(codes.size).toBe(15)
  })

  it('trades once for a token, and not twice', () => {
    const p = open()
    const { code } = p.invite('Mac')
    const got = p.redeem(code)
    expect(got?.token).toMatch(/^tk_/)
    expect(got?.device.label).toBe('Mac')
    expect(p.redeem(code)).toBeUndefined()
  })

  it('is read however it was typed', () => {
    const p = open()
    expect(normalizeCode(' abcd-efgh jklm ')).toBe('ABCDEFGHJKLM')
    const { code } = p.invite()
    expect(p.redeem(code.toLowerCase().replace(/-/g, ' '))).toBeDefined()
  })

  it('works up to five minutes and not after', () => {
    const p = open()
    const early = p.invite().code
    const late = p.invite().code
    t += CODE_TTL_MS - 1
    expect(p.redeem(early)).toBeDefined()
    t += 2
    expect(p.redeem(late)).toBeUndefined()
  })

  it('is not used up by a wrong one', () => {
    const p = open()
    const { code } = p.invite()
    for (const bad of ['', 'short', 'AAAA-AAAA-AAAA', 'AAAA-AAAA-AAAA-AAAA']) expect(p.redeem(bad)).toBeUndefined()
    expect(p.redeem(code)).toBeDefined()
  })

  it('names the device as the owner did, or else as the device does', () => {
    const p = open()
    expect(p.redeem(p.invite().code, '  Julio’s iPad  ')?.device.label).toBe('Julio’s iPad')
    expect(p.redeem(p.invite('My Mac').code, 'something else')?.device.label).toBe('My Mac')
    expect(p.redeem(p.invite().code)?.device.label).toBe('device')
  })

  it('keeps twenty waiting at most, the oldest give way', () => {
    const p = open()
    const codes = Array.from({ length: 25 }, () => p.invite().code)
    expect(p.redeem(codes[0]!)).toBeUndefined()
    expect(p.redeem(codes[24]!)).toBeDefined()
  })
})

describe('a paired device', () => {
  it('gets in with its token and nobody else does', () => {
    const p = open()
    const { token, device } = p.enroll('Mac')
    expect(p.check(token)?.id).toBe(device.id)
    for (const bad of ['tk_nope', '', undefined, 'x'.repeat(500)]) expect(p.check(bad)).toBeUndefined()
  })

  it('is kept as hashes: neither the code nor the token is in the file', () => {
    const p = open()
    const { code } = p.invite('Mac')
    expect(readFileSync(file(), 'utf8')).not.toContain(normalizeCode(code))
    const { token } = p.redeem(code)!
    const text = readFileSync(file(), 'utf8')
    expect(text).not.toContain(token)
    expect(text).not.toContain(normalizeCode(code))
  })

  it('is in a file only this user reads', () => {
    open().invite()
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('is seen at once by another process, the commands next to the server', () => {
    const server = open()
    const commands = open()
    const { code } = commands.invite('Mac')
    const { token } = server.redeem(code)!
    expect(commands.list().map((d) => d.label)).toEqual(['Mac'])
    expect(commands.revokeAll()).toBe(1)
    expect(server.check(token)).toBeUndefined()
  })

  it('is listed without its hash', () => {
    const p = open()
    p.enroll('Mac')
    expect(JSON.stringify(p.list())).not.toContain('hash')
  })

  it('pairs nobody from a file that is garbage, and recovers', () => {
    const p = open()
    const { token } = p.enroll('Mac')
    writeFileSync(file(), '{nope')
    expect(p.check(token)).toBeUndefined()
    expect(p.list()).toEqual([])
    expect(p.invite().code).toBeDefined()
  })

  it('keeps a hundred at most, the longest unused give way', () => {
    const p = open()
    const first = p.enroll('first')
    for (let i = 0; i < 100; i++) {
      t += 1000
      p.enroll(`d${i}`)
    }
    expect(p.list()).toHaveLength(100)
    expect(p.check(first.token)).toBeUndefined()
  })
})

describe('how long a session lasts', () => {
  it('goes on while it is used and ends thirty days after the last use', () => {
    const p = open()
    const { token } = p.enroll('Mac')
    t += 29 * DAY
    expect(p.check(token)).toBeDefined()
    t += 29 * DAY
    expect(p.check(token)).toBeDefined()
    t += SESSION_MS + 1
    expect(p.check(token)).toBeUndefined()
    expect(p.list()).toEqual([])
  })

  it('does not renew on every request, only once an hour has gone', () => {
    const p = open()
    const { token, device } = p.enroll('Mac')
    t += 10 * MINUTE
    p.check(token)
    expect(p.list()[0]?.seen).toBe(device.seen)
    t += 51 * MINUTE
    p.check(token)
    expect(p.list()[0]?.seen).toBe(t)
  })
})

describe('taking access away', () => {
  it('by id or by label, one device at a time', () => {
    const p = open()
    const mac = p.enroll('Mac')
    const phone = p.enroll('Phone')
    expect(p.revoke(mac.device.id)).toBe(1)
    expect(p.check(mac.token)).toBeUndefined()
    expect(p.check(phone.token)).toBeDefined()
    expect(p.revoke('nobody')).toBe(0)
    expect(p.revoke(' PHONE ')).toBe(1)
    expect(p.check(phone.token)).toBeUndefined()
  })

  it('all of them, and the codes not used yet', () => {
    const p = open()
    p.enroll('Mac')
    const { code } = p.invite()
    expect(p.revokeAll()).toBe(1)
    expect(p.redeem(code)).toBeUndefined()
  })
})

describe('two writers at once', () => {
  it('take the lock for their moment and give it back', () => {
    open().invite()
    expect(existsSync(lock())).toBe(false)
  })

  it('clear a lock left by a process that died', () => {
    writeFileSync(lock(), '')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock(), old, old)
    expect(open().invite().code).toBeDefined()
    expect(existsSync(lock())).toBe(false)
  })

  it('give up, saying why, when another writer keeps the lock, and leave it alone', () => {
    writeFileSync(lock(), '')
    expect(() => impatient().invite()).toThrow(/busy/)
    expect(existsSync(lock())).toBe(true)
  })

  it('do not bring back a device revoked between the read and the write of a renewal', () => {
    let between: (() => void) | undefined
    // The server's clock is read right after it has read the file: that is the moment another process revokes.
    const server = new Pairing(file(), () => {
      const run = between
      between = undefined
      run?.()
      return t
    })
    const commands = open()
    const { token } = server.enroll('Mac')
    t += 2 * 60 * MINUTE
    between = () => commands.revokeAll()
    expect(server.check(token)).toBeUndefined()
    expect(open().list()).toEqual([])
  })

  it('keep a device in when the file is busy and its session cannot be renewed yet', () => {
    const p = impatient()
    const { token, device } = p.enroll('Mac')
    t += 2 * 60 * MINUTE
    writeFileSync(lock(), '')
    expect(p.check(token)?.id).toBe(device.id)
    expect(p.list()[0]?.seen).toBe(device.seen)
  })

  it('answer a wrong code without the lock, so guessing cannot keep the commands waiting', () => {
    const p = impatient()
    p.invite()
    writeFileSync(lock(), '')
    expect(p.redeem('AAAA-AAAA-AAAA')).toBeUndefined()
  })
})

describe('a label', () => {
  it('is trimmed, free of control characters, short, and never empty', () => {
    expect(cleanLabel('  My Mac  ', 'x')).toBe('My Mac')
    expect(cleanLabel('a\nb', 'x')).toBe('a b')
    expect(cleanLabel('a'.repeat(100), 'x')).toHaveLength(60)
    expect(cleanLabel('   ', 'x')).toBe('x')
    expect(cleanLabel(42, 'x')).toBe('x')
  })
})

describe('the cookie of a server', () => {
  it('is named after the server, so two servers on one host do not take each other’s', () => {
    expect(cookieName('a1b2c3d4e5f6')).toBe('tucano-a1b2c3d4e5f6')
    expect(cookieName('a1b2c3d4e5f6')).not.toBe(cookieName('0f0f0f0f0f0f'))
    expect(cookieName('a1b2c3d4e5f6')).not.toBe('tucano')
  })

  it('keeps only letters and digits, and not too many', () => {
    expect(cookieName('x; y=z\n')).toBe('tucano-xyz')
    expect(cookieName('a'.repeat(100))).toHaveLength('tucano-'.length + 24)
  })
})

describe('what the app sends to trade a code', () => {
  it('is JSON with the code, and the name the device gives itself if it has one', () => {
    expect(pairRequest('{"code":"K7QM-2XPD-9TWH","label":"My Mac"}')).toEqual({ code: 'K7QM-2XPD-9TWH', label: 'My Mac' })
    expect(pairRequest('{"code":"K7QM-2XPD-9TWH"}')).toEqual({ code: 'K7QM-2XPD-9TWH', label: undefined })
    expect(pairRequest('{"code":"AAAA","label":7}')).toEqual({ code: 'AAAA', label: undefined })
  })

  it('is nothing at all when it is anything else', () => {
    const long = `{"code":"${'A'.repeat(65)}"}`
    for (const bad of ['', '{', 'null', '[]', '"K7QM"', '{}', '{"code":42}', '{"code":""}', '{"code":"   "}', long]) {
      expect(pairRequest(bad)).toBeUndefined()
    }
  })

  it('trades through the same code as the browser does', () => {
    const p = open()
    const ask = pairRequest(JSON.stringify({ code: p.invite().code.toLowerCase(), label: 'My Mac' }))!
    const got = p.redeem(ask.code, ask.label)
    expect(got?.device.label).toBe('My Mac')
    expect(p.check(got?.token)?.id).toBe(got?.device.id)
  })
})

describe('the commands on the server machine', () => {
  const base = 'http://127.0.0.1:7337'
  const run = (args: string[], p = open(), at = base): { code: number | undefined; out: string } => {
    const lines: string[] = []
    const code = cli(args, p, at, (l) => lines.push(l))
    return { code, out: lines.join('\n') }
  }

  it('leave the server to start when there is no command, or only flags', () => {
    expect(run([]).code).toBeUndefined()
    expect(run(['--port', '1']).code).toBeUndefined()
  })

  it('pair prints a code and the link that signs a browser in', () => {
    const p = open()
    const { code, out } = run(['pair', '--label', 'My Mac'], p)
    expect(code).toBe(0)
    const given = /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(out)?.[0]
    expect(given).toBeDefined()
    expect(out).toContain(`${base}/?pair=${given}`)
    expect(p.redeem(given!)?.device.label).toBe('My Mac')
  })

  it('pair takes --label=Name as well', () => {
    const p = open()
    const given = /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(run(['pair', '--label=Phone'], p).out)?.[0]
    expect(p.redeem(given!)?.device.label).toBe('Phone')
  })

  it('pair --ssh also prints the link that pairs the Mac app, and it reads back as what was asked', () => {
    const p = open()
    const { code, out } = run(['pair', '--label', 'My VPS', '--ssh', 'julio@203.0.113.7:2222'], p)
    expect(code).toBe(0)
    const given = /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(out)![0]
    const shown = /(tucano:\/\/pair\?\S+)/.exec(out)?.[1]
    expect(shown).toBeDefined()
    const parsed = parsePairLink(shown!)
    expect(parsed).toEqual({
      ok: true,
      link: { code: given, reach: { via: 'ssh', user: 'julio', host: '203.0.113.7', port: 2222 }, remotePort: 7337, name: 'My VPS' }
    })
    expect(out).toContain(`${base}/?pair=${given}`) // the browser link is still there
  })

  it('pair --url prints the link for an address, and the port of the server comes from where it listens', () => {
    const out = run(['pair', '--url', 'https://tucano.example.com'], open(), 'http://127.0.0.1:9000').out
    const link = parsePairLink(/(tucano:\/\/pair\?\S+)/.exec(out)![1]!)
    expect(link).toMatchObject({ ok: true, link: { reach: { via: 'url', url: 'https://tucano.example.com' }, name: 'tucano.example.com' } })
    const ssh = parsePairLink(/(tucano:\/\/pair\?\S+)/.exec(run(['pair', '--ssh=me@h.io'], open(), 'http://127.0.0.1:9000').out)![1]!)
    expect(ssh).toMatchObject({ ok: true, link: { remotePort: 9000 } })
  })

  it('pair refuses a bad --ssh or --url without using up a code', () => {
    for (const args of [['--ssh', '-oProxyCommand=x@h.io'], ['--ssh', 'h.io'], ['--ssh'], ['--url', 'http://203.0.113.7'], ['--ssh', 'a@b.io', '--url', 'https://x.io']]) {
      const p = open()
      const { code, out } = run(['pair', ...args], p)
      expect(code, args.join(' ')).toBe(2)
      expect(out).not.toContain('Pairing code')
      expect(existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')).pending : []).toHaveLength(0) // no code was made
    }
  })

  it('devices says who is paired, or that nobody is', () => {
    const p = open()
    expect(run(['devices'], p).out).toContain('No paired devices')
    const { device } = p.enroll('My Mac')
    const { code, out } = run(['devices'], p)
    expect(code).toBe(0)
    expect(out).toContain(device.id)
    expect(out).toContain('My Mac')
  })

  it('revoke takes one device, or all, and says when there is none to take', () => {
    const p = open()
    const { device, token } = p.enroll('My Mac')
    expect(run(['revoke', 'nobody'], p).code).toBe(1)
    expect(run(['revoke'], p).code).toBe(2)
    expect(run(['revoke', device.id], p).code).toBe(0)
    expect(p.check(token)).toBeUndefined()
    p.enroll('Other')
    expect(run(['revoke', '--all'], p).out).toContain('Revoked 1 device.')
  })

  it('answer help, and refuse what they do not know', () => {
    expect(run(['help']).code).toBe(0)
    const bad = run(['pari'])
    expect(bad.code).toBe(2)
    expect(bad.out).toContain('Unknown command: pari')
  })

  it('say why, and exit 1, when the file stays busy', () => {
    writeFileSync(lock(), '')
    const { code, out } = run(['pair'], impatient())
    expect(code).toBe(1)
    expect(out).toContain('busy')
  })
})
