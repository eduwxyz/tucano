import { describe, expect, it } from 'vitest'

// The guide the Tuca reads to orient people about Tucano: one page per topic, its title on the first
// line and a one-line summary on the second (the index is built from those two lines).
const pages = import.meta.glob('../src/core/guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
const slugOf = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '')

describe('the guide', () => {
  it('has pages', () => {
    expect(Object.keys(pages).length).toBeGreaterThan(10)
  })

  it('opens each page with a title and a one-line summary', () => {
    for (const [path, text] of Object.entries(pages)) {
      const [title = '', summary = ''] = text.split('\n')
      expect(title, path).toMatch(/^# \S/)
      expect(summary, path).toMatch(/^> \S/)
    }
  })

  it('names pages with unique, plain ascii slugs', () => {
    const slugs = Object.keys(pages).map(slugOf)
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/)
    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('keeps each page short enough to read in one call', () => {
    for (const [path, text] of Object.entries(pages)) expect(text.split(/\s+/).filter(Boolean).length, path).toBeLessThan(600)
  })
})
