import { describe, expect, it } from 'vitest'
import { isPreviewOf, onServer, pairingLink, parsePairing, serverMayHave, serverName, serverNote } from '../src/shared/servers'

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

  it('reads a one-time code, in the app\'s link or the browser\'s, and nothing else in its place', () => {
    const code = 'abcDEF123_-abcDEF123_-ab'
    expect(parsePairing(`tucano://connect?url=https://ana.example.com&code=${code}`)).toEqual({ origin: 'https://ana.example.com', code })
    expect(parsePairing(`https://ana.example.com/?code=${code}`)).toEqual({ origin: 'https://ana.example.com', code })
    for (const bad of [
      'tucano://connect?url=https://ana.example.com&code=short',
      `tucano://connect?url=http://ana.example.com&code=${code}`, // plain http on the internet
      `http://ana.example.com/?code=${code}`,
      `https://ana.example.com/elsewhere?code=${code}`,
      `https://u:p@ana.example.com/?code=${code}`,
      'https://ana.example.com/?code=<script>'
    ])
      expect(parsePairing(bad), bad).toBeNull()
    expect(parsePairing(pairingLink({ origin: 'https://ana.example.com', code }))).toEqual({ origin: 'https://ana.example.com', code })
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

describe("a server's page in the app's window", () => {
  it('has notifications on its own address, though Electron gives the origin with a slash at the end', () => {
    expect(serverMayHave('notifications', 'https://ana.example.com/', 'https://ana.example.com')).toBe(true)
    expect(serverMayHave('notifications', 'https://ana.example.com', 'https://ana.example.com')).toBe(true)
    expect(serverMayHave('clipboard-sanitized-write', 'http://127.0.0.1:7400/', 'http://127.0.0.1:7400')).toBe(true)
    expect(serverMayHave('notifications', 'https://evil.example.com/', 'https://ana.example.com')).toBe(false)
    expect(serverMayHave('geolocation', 'https://ana.example.com/', 'https://ana.example.com')).toBe(false)
    expect(serverMayHave('notifications', 'not a url', 'https://ana.example.com')).toBe(false)
  })

  it('hands the app only a notification of sane shape', () => {
    expect(serverNote({ title: 'Lia · Lembrete', body: 'Oi!', conversationId: 'c-1', threadId: 't_2', kind: 'done', sound: false, extra: 'x' })).toEqual({
      title: 'Lia · Lembrete',
      body: 'Oi!',
      conversationId: 'c-1',
      threadId: 't_2',
      kind: 'done',
      sound: false
    })
    expect(serverNote({ title: 'Skills', body: 'nova', page: 'skills' })).toEqual({ title: 'Skills', body: 'nova', page: 'skills' })
    // Ids not of the core's shape, kinds and pages it doesn't make: left out.
    expect(serverNote({ title: 'T', body: 'b', conversationId: '../x', threadId: 't', kind: 'evil', page: 'settings' })).toEqual({ title: 'T', body: 'b' })
    // A thread only with its conversation.
    expect(serverNote({ title: 'T', threadId: 't' })).toEqual({ title: 'T', body: '' })
    expect(serverNote({ title: 'x'.repeat(1000), body: 'y'.repeat(5000) })).toMatchObject({ title: 'x'.repeat(200), body: 'y'.repeat(500) })
    for (const bad of [null, 'text', 3, {}, { title: '' }, { title: '  ' }, { title: 5 }]) expect(serverNote(bad)).toBeNull()
  })
})
