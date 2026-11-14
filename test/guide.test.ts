import { describe, expect, it } from 'vitest'

// The guide the Tuca reads to orient people about Tucano: one page per topic, its title on the first
// line and a one-line summary on the second (the index is built from those two lines). Each page is
// written twice — Portuguese in src/core/guide/, English in src/core/guide/en/ — so a page without
// its twin is a workspace that reads the other language.
const pt = import.meta.glob('../src/core/guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const en = import.meta.glob('../src/core/guide/en/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const slugOf = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '')

describe('the guide', () => {
  it('has pages', () => {
    expect(Object.keys(pt).length).toBeGreaterThan(10)
  })

  it('opens each page with a title and a one-line summary, in both languages', () => {
    for (const [path, text] of [...Object.entries(pt), ...Object.entries(en)]) {
      const [title = '', summary = ''] = text.split('\n')
      expect(title, path).toMatch(/^# \S/)
      expect(summary, path).toMatch(/^> \S/)
    }
  })

  it('names pages with unique, plain ascii slugs', () => {
    const slugs = Object.keys(pt).map(slugOf)
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('keeps each page short enough to read in one call, in both languages', () => {
    for (const [path, text] of [...Object.entries(pt), ...Object.entries(en)]) expect(text.split(/\s+/).filter(Boolean).length, path).toBeLessThan(600)
  })

  it('has the same pages in both languages, with no page left on one side', () => {
    const ptSlugs = Object.keys(pt).map(slugOf).sort()
    const enSlugs = Object.keys(en).map(slugOf).sort()
    expect(enSlugs).toEqual(ptSlugs)
  })
})
