import { describe, expect, it } from 'vitest'
import { clearedCookie, clientKey, cookieValue, decodePart, parseJson, parseOrigins, sameOrigin, sessionCookie, Strikes } from '../src/server/guard'

describe('what a client sends that would throw', () => {
  it('reads JSON, also a body that is only null or false', () => {
    expect(parseJson('{"a":[1,2]}')).toEqual({ value: { a: [1, 2] } })
    expect(parseJson('null')).toEqual({ value: null })
    expect(parseJson('false')).toEqual({ value: false })
  })

  it('answers nothing for what is not JSON', () => {
    for (const bad of ['', '{', '{"a":', 'undefined', '<html>']) expect(parseJson(bad)).toBeUndefined()
  })

  it('decodes a path part, and answers nothing for a broken escape', () => {
    expect(decodePart('a%20b%C3%A7')).toBe('a bç')
    expect(decodePart('%')).toBeUndefined()
    expect(decodePart('%E0%A4%A')).toBeUndefined()
  })
})

describe('which page a request comes from', () => {
  const host = '127.0.0.1:7337'

  it('lets through a request with no Origin: not a browser, the token still decides', () => {
    expect(sameOrigin(undefined, host)).toBe(true)
  })

  it('lets the page this server served, through a tunnel or a proxy', () => {
    expect(sameOrigin('http://127.0.0.1:7337', host)).toBe(true)
    expect(sameOrigin('http://LOCALHOST:9000', 'localhost:9000')).toBe(true)
    expect(sameOrigin('https://tucano.example.com', 'tucano.example.com')).toBe(true)
  })

  it('refuses another site, another port, a null origin and what is not a URL', () => {
    expect(sameOrigin('https://evil.example', host)).toBe(false)
    expect(sameOrigin('http://127.0.0.1:8080', host)).toBe(false)
    expect(sameOrigin('null', host)).toBe(false)
    expect(sameOrigin('not a url', host)).toBe(false)
    expect(sameOrigin('http://127.0.0.1:7337', undefined)).toBe(false)
  })

  it('lets an origin the owner listed, for a proxy that rewrites Host', () => {
    const allowed = parseOrigins('https://tucano.example.com/, nope, ,http://b.example:8080')
    expect(allowed).toEqual(['https://tucano.example.com', 'http://b.example:8080'])
    expect(sameOrigin('https://tucano.example.com', host, allowed)).toBe(true)
    expect(sameOrigin('https://evil.example', host, allowed)).toBe(false)
    expect(parseOrigins(undefined)).toEqual([])
  })
})

describe('who is asking', () => {
  it('is the socket, unless it is a proxy on this machine', () => {
    expect(clientKey('203.0.113.7', '10.0.0.1')).toBe('203.0.113.7') // a direct client can write any header
    expect(clientKey('127.0.0.1', '203.0.113.9')).toBe('203.0.113.9')
    expect(clientKey('::ffff:127.0.0.1', '203.0.113.9')).toBe('203.0.113.9')
  })

  it('reads the entry the proxy added, the last, not what the client claimed first', () => {
    expect(clientKey('::1', '1.1.1.1, 203.0.113.9')).toBe('203.0.113.9')
    expect(clientKey('127.0.0.1', ['1.1.1.1', '203.0.113.9'])).toBe('203.0.113.9')
  })

  it('falls back to the socket without the header, or without a socket', () => {
    expect(clientKey('127.0.0.1', undefined)).toBe('127.0.0.1')
    expect(clientKey('127.0.0.1', '')).toBe('127.0.0.1')
    expect(clientKey(undefined, undefined)).toBe('unknown')
  })
})

describe('too many wrong tokens', () => {
  it('makes a key wait once it has hit the limit, until its oldest strike ages out', () => {
    let t = 1_000_000
    const s = new Strikes(3, 60_000, () => t)
    expect(s.retryAfter('a')).toBe(0)
    s.fail('a')
    t += 10_000
    s.fail('a')
    t += 10_000
    expect(s.retryAfter('a')).toBe(0)
    s.fail('a')
    expect(s.retryAfter('a')).toBe(40)
    t += 39_000
    expect(s.retryAfter('a')).toBe(1)
    t += 1_000
    expect(s.retryAfter('a')).toBe(0)
  })

  it('keeps each key apart, and forgets one that signed in', () => {
    const s = new Strikes(2, 60_000, () => 1_000)
    s.fail('a')
    s.fail('a')
    expect(s.retryAfter('a')).toBeGreaterThan(0)
    expect(s.retryAfter('b')).toBe(0)
    s.clear('a')
    expect(s.retryAfter('a')).toBe(0)
  })

  it('stays bounded when many addresses fail once', () => {
    const s = new Strikes(1, 60_000, () => 1_000)
    for (let i = 0; i <= 10_000; i++) s.fail(`k${i}`)
    expect(s.retryAfter('k0')).toBe(0) // the oldest was dropped
    expect(s.retryAfter('k10000')).toBeGreaterThan(0)
  })
})

describe('the cookie', () => {
  it('signs a browser in: HttpOnly, Lax, the whole site, Secure when asked', () => {
    expect(sessionCookie('tucano', 'abc', 60, false)).toBe('tucano=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=60')
    expect(sessionCookie('tucano', 'abc', 60, true)).toBe('tucano=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=60; Secure')
  })

  it('is taken back with nothing in it and no time left', () => {
    expect(clearedCookie('tucano', false)).toBe('tucano=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0')
    expect(clearedCookie('tucano', true)).toBe('tucano=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure')
  })

  it('is read by its name among the others, and only by its whole name', () => {
    expect(cookieValue('a=1; tucano=tok; b=2', 'tucano')).toBe('tok')
    expect(cookieValue('tucano=tok', 'tucano')).toBe('tok')
    expect(cookieValue('xtucano=1; tucano-2=z', 'tucano')).toBeUndefined()
    expect(cookieValue('tucano-2=z', 'tucano-2')).toBe('z')
  })

  it('is none when it is empty or the header is not there', () => {
    expect(cookieValue('tucano=', 'tucano')).toBeUndefined()
    expect(cookieValue('', 'tucano')).toBeUndefined()
    expect(cookieValue(undefined, 'tucano')).toBeUndefined()
  })
})
