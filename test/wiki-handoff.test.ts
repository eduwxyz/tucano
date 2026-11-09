// A finding in the wiki's review that nobody has written yet goes to an agent: a page the wiki
// links to and doesn't have, or pages nothing links to. The message that agent gets is built here,
// away from the window, so it says the same thing every time and can be read in a test.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Wiki } from '../src/core/wiki'
import { canHandOff, handOffText } from '../src/core/wiki-handoff'
import type { WikiFinding } from '../src/shared/types'

const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  return w
}
const by = { by: 'me', byName: 'Ana' }
const finding = (over: Partial<WikiFinding>): WikiFinding => ({ id: 'f1', at: 1, kind: 'missing', pages: [], text: '', ...over })

describe('which findings can be handed to an agent', () => {
  it('takes the two that want a page, and nothing else', () => {
    expect(['broken', 'missing'].every((k) => canHandOff(k as WikiFinding['kind']))).toBe(true)
    for (const kind of ['contradiction', 'stale', 'duplicate', 'link', 'log', 'git'] as const) expect(canHandOff(kind)).toBe(false)
  })
})

describe('the message a missing page gets', () => {
  it('names the exact title and brings the lines that mention it, so the links start working', () => {
    const w = fresh()
    w.save({ title: 'Campaign agent Keeper', kind: 'Decisão', body: 'O Keeper cuida da campanha.\n\nVer [[On Nov]] para o resto.', ...by })
    const f = finding({ kind: 'missing', name: 'On Nov', pages: ['Campaign agent Keeper'] })
    const text = handOffText(f, (t) => w.page(t))
    expect(text).toContain('[[On Nov]]')
    expect(text).toContain('Campaign agent Keeper')
    expect(text).toContain('Ver [[On Nov]] para o resto.')
    expect(text).toContain('wiki_escrever')
    expect(text).toMatch(/título tem que ser exatamente|title has to be exactly/)
  })

  it('says which pages to read when it could not open them, instead of nothing', () => {
    const f = finding({ kind: 'broken', name: 'Steward', pages: ['Campaign agent Keeper'] })
    const text = handOffText(f, () => undefined)
    expect(text).toContain('[[Steward]]')
    expect(text).toContain('[[Campaign agent Keeper]]')
    expect(text).toContain('wiki_ler')
  })

  it('takes the name from the first page when the finding carries none', () => {
    const w = fresh()
    w.save({ title: 'Founder Foundry agent', kind: 'Decisão', body: 'Cuida do Foundry. Ver [[Engineer full-stack agent]].', ...by })
    const text = handOffText(finding({ kind: 'missing', name: undefined, pages: ['Founder Foundry agent'] }), (t) => w.page(t))
    expect(text).toContain('[[Founder Foundry agent]]')
  })

  it('keeps a long line short instead of sending the whole page', () => {
    const w = fresh()
    w.save({ title: 'Longa', kind: 'Assunto', body: `Começo. [[Alvo]] ${'palavra '.repeat(200)}`, ...by })
    const text = handOffText(finding({ kind: 'missing', name: 'Alvo', pages: ['Longa'] }), (t) => w.page(t))
    expect(text).toContain('Começo.')
    expect(text.length).toBeLessThan(1400)
  })
})
