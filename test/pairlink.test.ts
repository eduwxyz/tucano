import { describe, expect, it } from 'vitest'
import { formatPairLink, parsePairLink, parseServerUrl, parseSshTarget, type PairLink } from '../src/shared/pairlink'

const CODE = 'K7QM-2XPD-9TWH'
const link = (extra: string, code = CODE): string => `tucano://pair?v=1&code=${code}${extra}`
const ok = (text: string): PairLink => {
  const r = parsePairLink(text)
  if (!r.ok) throw new Error(`refused: ${r.error}`)
  return r.link
}
const refused = (text: string): string => {
  const r = parsePairLink(text)
  if (r.ok) throw new Error('should have been refused')
  return r.error
}

describe('an ssh address', () => {
  it('reads user@host, with a port or without, and an IPv6 address in brackets', () => {
    expect(parseSshTarget('julio@203.0.113.7')).toEqual({ via: 'ssh', user: 'julio', host: '203.0.113.7', port: 22 })
    expect(parseSshTarget('julio.cesar@vps.example.com:2222')).toEqual({ via: 'ssh', user: 'julio.cesar', host: 'vps.example.com', port: 2222 })
    expect(parseSshTarget('me@[2001:db8::1]:2200')).toEqual({ via: 'ssh', user: 'me', host: '2001:db8::1', port: 2200 })
    expect(parseSshTarget('me@[::1]')).toEqual({ via: 'ssh', user: 'me', host: '::1', port: 22 })
  })

  it('refuses anything ssh could read as an option, or that carries more than an address', () => {
    for (const bad of [
      '-oProxyCommand=touch@x', // a user that starts with "-"
      'me@-oProxyCommand=touch', // a host that starts with "-"
      'me@-host',
      '-me@host',
      'me@host -oProxyCommand=x',
      'me@host;reboot',
      'me@host$(id)',
      'me@`id`',
      'me@host\nProxyCommand x',
      'me @host',
      'me@host:22:22',
      'me@host:0',
      'me@host:65536',
      'me@host:99999999',
      'me@host:2x',
      'me@',
      '@host',
      'host', // no user: it would be left to the machine's own ssh config
      'me@ho st',
      'me@host/../x',
      'me@[::1',
      'me@[zz::1]',
      'me@[host]',
      'me@' + 'a'.repeat(254),
      'a'.repeat(33) + '@host',
      'me@exa_mple.com',
      'me@.example.com',
      'me@example..com',
      'me@example-.com'
    ]) {
      expect(parseSshTarget(bad), bad).toBeUndefined()
    }
  })
})

describe('a server address', () => {
  it('takes https anywhere, and http only on this machine or on Tailscale', () => {
    expect(parseServerUrl('https://tucano.example.com')).toBe('https://tucano.example.com')
    expect(parseServerUrl('https://tucano.example.com:8443/')).toBe('https://tucano.example.com:8443')
    expect(parseServerUrl('http://100.101.102.103:7337')).toBe('http://100.101.102.103:7337')
    expect(parseServerUrl('http://vps.tail1234.ts.net:7337')).toBe('http://vps.tail1234.ts.net:7337')
    expect(parseServerUrl('http://127.0.0.1:17337')).toBe('http://127.0.0.1:17337')
    expect(parseServerUrl('http://[::1]:7337')).toBe('http://[::1]:7337')
  })

  it('refuses plain http over the internet or a LAN, other schemes, and what rides along', () => {
    for (const bad of [
      'http://tucano.example.com',
      'http://203.0.113.7:7337',
      'http://192.168.1.10:7337',
      'http://10.0.0.5:7337',
      'http://100.63.0.1:7337', // just below Tailscale's range
      'http://100.128.0.1:7337', // just above it
      'http://127.0.0.1.evil.com',
      'http://evil.com.ts.net.evil.com',
      'ftp://tucano.example.com',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'https://user:pass@tucano.example.com',
      'https://tucano.example.com/path',
      'https://tucano.example.com/?token=x',
      'https://tucano.example.com/#x',
      'not a url',
      ''
    ]) {
      expect(parseServerUrl(bad), bad).toBeUndefined()
    }
  })
})

describe('a pairing link', () => {
  it('carries the code, the way in and a name', () => {
    expect(ok(link('&ssh=julio@203.0.113.7&name=My%20VPS'))).toEqual({
      code: CODE,
      reach: { via: 'ssh', user: 'julio', host: '203.0.113.7', port: 22 },
      remotePort: 7337,
      name: 'My VPS'
    })
    expect(ok(link('&ssh=julio@vps.example.com:2222&port=8000')).remotePort).toBe(8000)
    expect(ok(link('&url=https://tucano.example.com')).reach).toEqual({ via: 'url', url: 'https://tucano.example.com' })
  })

  it('is read with the code typed any way, and named after the host when it has no name', () => {
    expect(ok(link('&ssh=me@vps.example.com', 'k7qm2xpd9twh')).code).toBe(CODE)
    expect(ok(link('&ssh=me@vps.example.com', 'k7qm 2xpd 9twh')).code).toBe(CODE)
    expect(ok(link('&ssh=me@vps.example.com')).name).toBe('vps.example.com')
    expect(ok(link('&url=https://tucano.example.com')).name).toBe('tucano.example.com')
  })

  it('cleans the name: no control characters, and no more than 60 characters', () => {
    expect(ok(link('&ssh=me@h.io&name=a%0Ab%00c')).name).toBe('a b c')
    expect(ok(link('&ssh=me@h.io&name=' + 'x'.repeat(200))).name).toHaveLength(60)
    expect(ok(link('&ssh=me@h.io&name=%20%20')).name).toBe('h.io')
  })

  it('goes out and comes back the same, for ssh and for a url', () => {
    const a: PairLink = { code: CODE, reach: { via: 'ssh', user: 'me', host: '2001:db8::1', port: 2222 }, remotePort: 8000, name: 'Casa & VPS' }
    const b: PairLink = { code: CODE, reach: { via: 'ssh', user: 'me', host: 'h.io', port: 22 }, remotePort: 7337, name: 'h.io' }
    const c: PairLink = { code: CODE, reach: { via: 'url', url: 'https://t.example.com' }, remotePort: 7337, name: 'Meu servidor' }
    for (const l of [a, b, c]) expect(ok(formatPairLink(l))).toEqual(l)
    expect(formatPairLink(b)).toBe('tucano://pair?v=1&code=K7QM-2XPD-9TWH&ssh=me%40h.io&name=h.io')
  })

  it('refuses a link that is not one, or not from a version it knows', () => {
    expect(refused('https://example.com')).toContain('not a Tucano pairing link')
    expect(refused('tucano://artifact/x/y')).toContain('not a Tucano pairing link')
    expect(refused('tucano://pair.evil.com?v=1')).toContain('not a Tucano pairing link')
    expect(refused('nonsense')).toContain('not a Tucano link')
    expect(refused('tucano://pair?code=' + CODE + '&ssh=me@h.io')).toContain('version')
    expect(refused('tucano://pair?v=2&code=' + CODE + '&ssh=me@h.io')).toContain('version')
    expect(refused('x'.repeat(3000))).toContain('not a Tucano link')
  })

  it('refuses a code that is not one', () => {
    for (const code of ['', 'SHORT', 'K7QM-2XPD-9TW', 'K7QM-2XPD-9TWHH', 'K7QM-2XPD-9TW0', 'K7QM-2XPD-9TWI', 'K7QM-2XPD-9TWO', 'K7QM-2XPD-9TW1']) {
      expect(refused(link('&ssh=me@h.io', code)), code).toContain('code')
    }
  })

  it('wants one way in, not none and not two', () => {
    expect(refused(link(''))).toContain('ssh or url')
    expect(refused(link('&ssh=me@h.io&url=https://t.example.com'))).toContain('ssh or url')
  })

  it('refuses a way in that is not valid, and says which', () => {
    expect(refused(link('&ssh=-oProxyCommand=x@h.io'))).toContain('ssh address')
    expect(refused(link('&ssh=me@-oProxyCommand=x'))).toContain('ssh address')
    expect(refused(link('&ssh=me@h.io;id'))).toContain('ssh address')
    expect(refused(link('&url=http://203.0.113.7:7337'))).toContain('address')
    expect(refused(link('&url=javascript:alert(1)'))).toContain('address')
    expect(refused(link('&ssh=me@h.io&port=0'))).toContain('port')
    expect(refused(link('&ssh=me@h.io&port=70000'))).toContain('port')
    expect(refused(link('&ssh=me@h.io&port=7337x'))).toContain('port')
  })

  it('refuses a part given twice: which one counts would be anyone’s guess', () => {
    expect(refused(link('&ssh=me@h.io&ssh=me@evil.com'))).toContain('twice')
    expect(refused(link('&ssh=me@h.io&code=AAAA-AAAA-AAAA'))).toContain('twice')
  })

  it('does nothing with parts it does not know', () => {
    expect(ok(link('&ssh=me@h.io&exec=rm%20-rf%20/&ssh_args=-oProxyCommand=x'))).toEqual(ok(link('&ssh=me@h.io')))
  })
})
