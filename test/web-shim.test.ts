import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACCESS_SHIM, INSECURE_CONTEXT_SHIM } from '../src/server/web-shim'

// Runs the page's shim against a stand-in browser that is not a secure context: no
// crypto.randomUUID, no navigator.clipboard.
function insecure(copied: { ok: boolean } = { ok: true }): { crypto: Record<string, unknown>; navigator: Record<string, unknown>; texts: string[] } {
  const texts: string[] = []
  const crypto = { getRandomValues: (a: Uint8Array) => (a.forEach((_, i) => (a[i] = (i * 37 + 11) & 255)), a) } as Record<string, unknown>
  const navigator: Record<string, unknown> = {}
  const document = {
    createElement: () => ({ setAttribute() {}, style: {}, value: '', select() {} }),
    body: { appendChild: (e: { value: string }) => texts.push(e.value), removeChild() {} },
    execCommand: () => copied.ok
  }
  new Function('crypto', 'navigator', 'document', 'Uint8Array', INSECURE_CONTEXT_SHIM)(crypto, navigator, document, Uint8Array)
  return { crypto, navigator, texts }
}

describe('the page shim for a browser outside a secure context', () => {
  it('can be followed by another script that starts with a parenthesis', () => {
    const ran: string[] = []
    const crypto = { randomUUID: () => 'x', getRandomValues: (a: Uint8Array) => a }
    new Function('crypto', 'navigator', 'document', 'Uint8Array', 'ran', `${INSECURE_CONTEXT_SHIM}(() => { ran.push('next') })()`)(crypto, { clipboard: {} }, {}, Uint8Array, ran)
    expect(ran).toEqual(['next'])
  })

  it('gives crypto.randomUUID, as a version 4 UUID', () => {
    const { crypto } = insecure()
    const id = (crypto['randomUUID'] as () => string)()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('gives different ids when the random bytes differ', () => {
    let n = 0
    const crypto = { getRandomValues: (a: Uint8Array) => (a.forEach((_, i) => (a[i] = (i + ++n) & 255)), a) } as Record<string, unknown>
    new Function('crypto', 'navigator', 'document', 'Uint8Array', INSECURE_CONTEXT_SHIM)(crypto, {}, {}, Uint8Array)
    const f = crypto['randomUUID'] as () => string
    expect(f()).not.toBe(f())
  })

  it('leaves the browser’s own randomUUID and clipboard alone', () => {
    const own = () => 'own'
    const clipboard = { writeText: () => Promise.resolve() }
    const crypto = { randomUUID: own, getRandomValues: (a: Uint8Array) => a } as Record<string, unknown>
    const navigator: Record<string, unknown> = { clipboard }
    new Function('crypto', 'navigator', 'document', 'Uint8Array', INSECURE_CONTEXT_SHIM)(crypto, navigator, {}, Uint8Array)
    expect(crypto['randomUUID']).toBe(own)
    expect(navigator['clipboard']).toBe(clipboard)
  })

  it('copies text through a textarea when there is no clipboard', async () => {
    const { navigator, texts } = insecure()
    await (navigator['clipboard'] as { writeText: (t: string) => Promise<void> }).writeText('hello')
    expect(texts).toEqual(['hello'])
  })

  it('says so when the browser refuses the copy', async () => {
    const { navigator } = insecure({ ok: false })
    await expect((navigator['clipboard'] as { writeText: (t: string) => Promise<void> }).writeText('x')).rejects.toThrow()
  })
})

// A page whose person was removed (or whose key stopped opening anything): the server answers 401.
// The page says so plainly and stops, instead of keeping what it showed and dropping what's sent.
type Node = { tag: string; textContent: string; style: { cssText: string }; children: Node[]; append: (...n: Node[]) => void }
function page(lang: string, answer: () => Promise<{ status: number }>): { access: { gone: boolean; answer: (s: number) => boolean; check: () => Promise<boolean> }; body: Node[]; asked: string[] } {
  const body: Node[] = []
  const asked: string[] = []
  const el = (tag: string): Node => {
    const n: Node = { tag, textContent: '', style: { cssText: '' }, children: [], append: (...c) => void n.children.push(...c) }
    return n
  }
  const document = { documentElement: { lang }, title: 'Tucano', createElement: el, body: { replaceChildren: (...n: Node[]) => void body.splice(0, body.length, ...n) } }
  const fetch = (url: string) => (asked.push(url), answer())
  const access = new Function('document', 'fetch', `${ACCESS_SHIM}; return access`)(document, fetch)
  return { access, body, asked }
}
const text = (n: Node): string => [n.textContent, ...n.children.map(text)].join(' ')

describe('the page when its access ends', () => {
  it('a 401 replaces the page with "you no longer have access", in the app’s language', () => {
    const pt = page('pt-BR', async () => ({ status: 200 }))
    expect(pt.access.answer(200)).toBe(false)
    expect(pt.body).toEqual([])
    expect(pt.access.answer(401)).toBe(true)
    expect(pt.access.gone).toBe(true)
    expect(text(pt.body[0]!)).toContain('Você não tem mais acesso a este Tucano')
    const en = page('en', async () => ({ status: 200 }))
    en.access.answer(401)
    expect(text(en.body[0]!)).toContain('You no longer have access to this Tucano')
  })

  it('a dropped line asks the server whether it still gets in; a network error is not a refusal', async () => {
    const out = page('pt', async () => ({ status: 401 }))
    expect(await out.access.check()).toBe(true)
    expect(out.asked).toHaveLength(1)
    const down = page('pt', () => Promise.reject(new Error('offline')))
    expect(await down.access.check()).toBe(false)
    expect(down.body).toEqual([])
    const fine = page('pt', async () => ({ status: 200 }))
    expect(await fine.access.check()).toBe(false)
  })

  it('the bridge uses it: a refused send, a line closed for good, and no reload once access is gone', () => {
    const server = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'index.ts'), 'utf8')
    const web = server.slice(server.indexOf('const WEB = `'))
    expect(web).toContain('${ACCESS_SHIM}')
    expect(web).toMatch(/if \(access\.answer\(r\.status\)\) return/)
    expect(web).toMatch(/es\.onerror = /)
    expect(web).toMatch(/const restart = \(\) => \{\n\s+if \(access\.gone\) return/)
  })
})

describe('the bridge script the server sends', () => {
  it('is JavaScript a browser can run, with the shims in it', () => {
    const server = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'index.ts'), 'utf8')
    const start = server.indexOf('const WEB = `') + 'const WEB = `'.length
    // The template as JS reads it (its escapes, its two shims and the server's version), then the script it makes.
    const web = new Function('INSECURE_CONTEXT_SHIM', 'ACCESS_SHIM', 'version', 'return `' + server.slice(start, server.indexOf('\n`\n', start)) + '`')(INSECURE_CONTEXT_SHIM, ACCESS_SHIM, '0.0.0') as string
    expect(web).toContain(`updateState: async () => ({ version: "0.0.0", status: 'off' })`)
    expect(() => new Function(web)).not.toThrow()
  })
})
