import { describe, expect, it } from 'vitest'
import { INSECURE_CONTEXT_SHIM } from '../src/server/web-shim'

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
