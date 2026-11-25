import { fstatSync, mkdtempSync, openSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { localResponse, localType } from '../src/main/local-file'

// A cited file on the desktop, served from the descriptor the core checked (src/main/local-file.ts).
describe('a cited file, as the window gets it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-local-file-'))
  const file = (name: string, text: string): { fd: number; size: number } => {
    writeFileSync(join(dir, name), text)
    const fd = openSync(join(dir, name), 'r')
    return { fd, size: fstatSync(fd).size }
  }
  const ask = (range?: string, method = 'GET'): Request => new Request('http://local/x', { method, headers: range ? { range } : {} })
  const closed = (fd: number): boolean => {
    try {
      fstatSync(fd)
      return false
    } catch {
      return true
    }
  }

  it('comes whole when no part is asked for, sandboxed, with its type', async () => {
    const r = localResponse(ask(), file('a.mp4', '0123456789'), localType('/x/a.MP4'))
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('video/mp4')
    expect(r.headers.get('content-security-policy')).toBe('sandbox')
    expect(r.headers.get('content-length')).toBe('10')
    expect(await r.text()).toBe('0123456789')
  })

  it('gives the part a video asks for when it seeks: from a byte on, between two, or the last few', async () => {
    const on = localResponse(ask('bytes=4-'), file('b.mp4', '0123456789'), 'video/mp4')
    expect([on.status, on.headers.get('content-range'), on.headers.get('content-length'), await on.text()]).toEqual([206, 'bytes 4-9/10', '6', '456789'])
    const between = localResponse(ask('bytes=2-5'), file('c.mp4', '0123456789'), 'video/mp4')
    expect([between.status, between.headers.get('content-range'), await between.text()]).toEqual([206, 'bytes 2-5/10', '2345'])
    const last = localResponse(ask('bytes=-3'), file('d.mp4', '0123456789'), 'video/mp4')
    expect([last.status, last.headers.get('content-range'), await last.text()]).toEqual([206, 'bytes 7-9/10', '789'])
    // Past the end: cut at the end, as a player expects.
    const past = localResponse(ask('bytes=8-99'), file('e.mp4', '0123456789'), 'video/mp4')
    expect([past.status, past.headers.get('content-range'), await past.text()]).toEqual([206, 'bytes 8-9/10', '89'])
  })

  it('refuses a part that starts after the end, and closes the file', () => {
    const opened = file('f.mp4', '0123456789')
    const r = localResponse(ask('bytes=10-'), opened, 'video/mp4')
    expect([r.status, r.headers.get('content-range')]).toEqual([416, 'bytes */10'])
    expect(closed(opened.fd)).toBe(true)
  })

  it('closes the file when there is nothing to send: an empty file, or only the headers asked for', () => {
    const empty = file('g.png', '')
    const r = localResponse(ask(), empty, 'image/png')
    expect([r.status, r.headers.get('content-length'), r.body]).toEqual([200, '0', null])
    expect(closed(empty.fd)).toBe(true)
    const head = file('h.pdf', '0123456789')
    const h = localResponse(ask(undefined, 'HEAD'), head, 'application/pdf')
    expect([h.status, h.headers.get('content-length'), h.body]).toEqual([200, '10', null])
    expect(closed(head.fd)).toBe(true)
  })

  it('closes the file once it was read to the end', async () => {
    const opened = file('i.mp4', '0123456789')
    await localResponse(ask(), opened, 'video/mp4').text()
    await new Promise((r) => setTimeout(r, 50))
    expect(closed(opened.fd)).toBe(true)
  })

  it('names what the window shows, and nothing else', () => {
    expect(localType('/a/b.PNG')).toBe('image/png')
    expect(localType('/a/b.pdf')).toBe('application/pdf')
    expect(localType('/a/b.html')).toBe('application/octet-stream')
  })
})
