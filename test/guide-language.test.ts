// The guide is the app's own manual, and it is written in Portuguese only. In an English workspace
// the Tuca's prompt carries it, so the model has to be told where that Portuguese comes from — and
// dates in the prompts that write the wiki go through locale(), like every other date the app shows.
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { guideIndex, GUIDE } from '../src/core/guide'

afterEach(() => setLang('pt'))

describe("the guide in the Tuca's prompt", () => {
  it('lists every page, one line each', () => {
    const lines = guideIndex().split('\n')
    expect(lines).toHaveLength(GUIDE.length)
    expect(lines[0]).toMatch(/^- agentes: /)
    expect(lines.every((l) => l.startsWith('- ') && l.includes(': '))).toBe(true)
  })

  it('says in an English workspace that the pages are Portuguese, and not to copy their labels', () => {
    setLang('en')
    const text = guideIndex()
    expect(text).toContain('written in Portuguese')
    expect(text).toContain('never copy its Portuguese labels')
    // Still every page, after the note.
    expect(text.split('\n')).toHaveLength(GUIDE.length + 1)
  })

  it('says nothing about it in a Portuguese workspace: there the guide is simply the guide', () => {
    setLang('pt')
    expect(guideIndex()).not.toContain('Portuguese')
    expect(guideIndex().split('\n')).toHaveLength(GUIDE.length)
  })

  it('keeps the pages themselves Portuguese: this is the list, not a translation', () => {
    setLang('en')
    const page = GUIDE.find((p) => p.slug === 'aprovacoes')!
    expect(page.title).toBe('Aprovações')
    expect(page.body.length).toBeGreaterThan(100)
  })
})
