import { describe, expect, it } from 'vitest'
import { isPreviewOf, onServer, pairingLink, parsePairing, serverName } from '../src/shared/servers'

const token = 'Zx9-abc_DEF0123456789xyzQ'

describe('pairing with a Tucano on a server', () => {
  it('reads the link `server.js link` prints, down to the origin', () => {
    expect(parsePairing(`tucano://connect?url=https://ana.example.com&token=${token}`)).toEqual({ origin: 'https://ana.example.com', token })
    expect(parsePairing(`tucano://connect?url=${encodeURIComponent('https://ana.example.com/some/path?x=1')}&token=${token}`)?.origin).toBe('https://ana.example.com')
    // A server under test, on this machine.
    expect(parsePairing(`tucano://connect?url=http://127.0.0.1:7400&token=${token}`)?.origin).toBe('http://127.0.0.1:7400')
  })

  it('refuses what a page could send to take the app somewhere else', () => {
    for (const bad of [
      `tucano://connect?url=http://ana.example.com&token=${token}`, // plain http on the internet
      `tucano://connect?url=file:///etc/passwd&token=${token}`,
      `tucano://connect?url=javascript:alert(1)&token=${token}`,
      `tucano://connect?url=https://user:pw@ana.example.com&token=${token}`,
      `tucano://artifact/x?url=https://ana.example.com&token=${token}`, // the app's own pages, not a pairing
      `https://connect?url=https://ana.example.com&token=${token}`,
      'tucano://connect?url=https://ana.example.com&token=short',
      'tucano://connect?url=https://ana.example.com&token=has spaces and <tags>',
      'tucano://connect?url=https://ana.example.com',
      'not a link'
    ])
      expect(parsePairing(bad), bad).toBeNull()
  })

  it('makes the same link again', () => {
    const p = { origin: 'https://ana.example.com', token }
    expect(parsePairing(pairingLink(p))).toEqual(p)
  })

  it("keeps a server's window on its own pages", () => {
    const o = 'https://ana.example.com'
    expect(onServer('https://ana.example.com/#/agent/1', o)).toBe(true)
    expect(onServer('https://bruno.example.com/', o)).toBe(false)
    expect(onServer('http://ana.example.com/', o)).toBe(false)
    expect(onServer('file:///etc/hosts', o)).toBe(false)
    expect(onServer('garbage', o)).toBe(false)
    expect(serverName(o)).toBe('ana.example.com')
  })

  it("knows a server's preview addresses from anything else", () => {
    const o = 'https://ana.example.com'
    expect(isPreviewOf('https://5173-ana.example.com/app', o)).toBe(true)
    expect(isPreviewOf('https://5173-bruno.example.com/', o)).toBe(false)
    expect(isPreviewOf('http://5173-ana.example.com/', o)).toBe(false)
    expect(isPreviewOf('https://5173-anaxexample.com/', o)).toBe(false)
    expect(isPreviewOf('https://evil-ana.example.com/', o)).toBe(false)
  })
})
