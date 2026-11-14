// The guide is the app's own manual, and it is written twice: Portuguese in src/core/guide/ and
// English in src/core/guide/en/. What the Tuca's prompt carries, and what ler_guia hands him, is the
// page in the language of the workspace — never the other language, which a model would copy into an
// answer. Dates in the prompts that write the wiki go through locale(), like every other date.
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { GUIDE, guideIndex, readGuide } from '../src/core/guide'

afterEach(() => setLang('pt'))

describe("the guide in the Tuca's prompt", () => {
  it('lists every page, one line each, in the language of the workspace', () => {
    const pt = guideIndex().split('\n')
    expect(pt).toHaveLength(GUIDE.length)
    expect(pt[0]).toMatch(/^- agentes: Agentes\. /)
    expect(pt.every((l) => l.startsWith('- ') && l.includes(': '))).toBe(true)

    setLang('en')
    const en = guideIndex().split('\n')
    expect(en).toHaveLength(GUIDE.length)
    expect(en[0]).toMatch(/^- agentes: Agents\. /)
  })

  it('hands over the page itself in the language of the workspace', () => {
    setLang('en')
    const english = readGuide('aprovacoes').text
    expect(english.split('\n')[0]).toBe('# Approvals')
    expect(english).toContain('Nothing sensitive happens without you')
    expect(english).not.toContain('Aprovações')

    setLang('pt')
    const portuguese = readGuide('aprovacoes').text
    expect(portuguese.split('\n')[0]).toBe('# Aprovações')
    expect(portuguese).toContain('Nada sensível acontece sem você')
    expect(portuguese).not.toContain('Nothing sensitive happens')
  })

  it('answers a page that does not exist in the right language too', () => {
    setLang('en')
    expect(readGuide('nope').text).toContain("There's no such page")
    setLang('pt')
    expect(readGuide('nope').text).toContain('Não existe essa página')
  })
})
