import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compareVersions, newsPages, newsSince, parseChangelog, parsePt, shortItem, type ReleaseNotes } from '../src/shared/release-notes'

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')

const sample = `# Changelog

## [Unreleased]

### Fixed

- **Not out yet.** Still on main.

## [0.3.1] - 2026-12-02

> **Em português:**
> - **Uma correção.** Funciona agora.
>   Com mais detalhe.
>
> Obrigado à Ana!

### Fixed

- **A fix.** It works now. More detail here.

## [0.3.0] - 2026-12-01

> **Em português:** novidades grandes.

### Added

- **Something new.** It does a thing. Thanks [@ana](https://github.com/ana)! ([#7](https://github.com/x/y/pull/7), [#8](https://github.com/x/y/pull/8))
  - A detail that stays in the full notes.

### Changed

- The **old way** changed: now it's like this.

## [0.2.0] - 2026-11-01

### Added

- **Old.** From before.

[0.3.1]: https://github.com/x/y/releases/tag/v0.3.1
`

describe('release notes', () => {
  it('reads each version: its Portuguese summary and the first sentence of each item, without links or thanks', () => {
    const [latest, previous, old] = parseChangelog(sample)
    expect(latest).toEqual({
      version: '0.3.1',
      date: '2026-12-02',
      pt: { points: ['**Uma correção.** Funciona agora. Com mais detalhe.'], outro: 'Obrigado à Ana!' },
      sections: [{ kind: 'Fixed', items: ['**A fix.** It works now.'] }]
    })
    expect(previous!.pt).toEqual({ intro: 'Novidades grandes.', points: [] }) // an older summary, a paragraph: shown whole
    expect(previous!.sections).toEqual([
      { kind: 'Added', items: ['**Something new.** It does a thing.'] },
      { kind: 'Changed', items: ["The **old way** changed: now it's like this."] }
    ])
    expect(old!.pt).toBeUndefined()
  })

  it('shows what came after the version seen, up to the one running; without one seen, the one running only', () => {
    expect(newsSince(sample, '0.3.1', '0.2.0').map((r) => r.version)).toEqual(['0.3.1', '0.3.0'])
    expect(newsSince(sample, '0.3.0', '0.2.0').map((r) => r.version)).toEqual(['0.3.0']) // 0.3.1 isn't running yet
    expect(newsSince(sample, '0.3.1').map((r) => r.version)).toEqual(['0.3.1'])
    expect(newsSince(sample, '0.3.1', '0.3.1')).toEqual([])
    expect(newsSince(sample, '0.9.0')).toEqual([]) // a version with no section: nothing to show
  })

  it('takes the Portuguese topics as written: never splits a paragraph into sentences', () => {
    expect(parsePt(['**Em português:** chegaram as threads. Na conversa aparecem as que abriram uma.'])).toEqual({ intro: 'Chegaram as threads. Na conversa aparecem as que abriram uma.', points: [] })
    expect(parsePt(['**Em português:**', 'Nesta versão:', '- **A.** Um.', '- **B.** Dois.'])).toEqual({ intro: 'Nesta versão:', points: ['**A.** Um.', '**B.** Dois.'] })
    expect(parsePt(['**Em português:**'])).toBeUndefined()
  })

  it('turns the news into pages of a few topics, the summary text on its version’s first and last page', () => {
    const big: ReleaseNotes = { version: '1.0.0', pt: { intro: 'Antes.', points: ['a', 'b', 'c', 'd', 'e', 'f'], outro: 'Obrigado!' }, sections: [{ kind: 'Added', items: ['x', 'y'] }, { kind: 'Fixed', items: ['z'] }] }
    const small: ReleaseNotes = { version: '0.9.0', pt: { points: ['g'] }, sections: [{ kind: 'Fixed', items: ['w'] }] }
    const pt = newsPages([big, small], true, 4)
    expect(pt.map((p) => [p.release.version, p.groups.flatMap((g) => g.items), p.intro, p.outro])).toEqual([
      ['1.0.0', ['a', 'b', 'c', 'd'], 'Antes.', undefined],
      ['1.0.0', ['e', 'f'], undefined, 'Obrigado!'],
      ['0.9.0', ['g'], undefined, undefined]
    ])
    // In English, each section's items, still under their section, across pages.
    expect(newsPages([big], false, 2).map((p) => p.groups)).toEqual([[{ kind: 'Added', items: ['x', 'y'] }], [{ kind: 'Fixed', items: ['z'] }]])
    // An old summary that is all text: one page with it.
    expect(newsPages([{ version: '0.1.0', pt: { intro: 'Tudo.', points: [] }, sections: [] }], true)).toEqual([{ release: expect.anything(), intro: 'Tudo.', groups: [] }])
  })

  it('compares versions by number, not as text', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBe(1)
    expect(compareVersions('v0.2.9', '0.2.10')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('cuts a long first sentence on a word', () => {
    const long = shortItem(`**Lead.** ${'word '.repeat(80)}end.`)
    expect(long.length).toBeLessThanOrEqual(241)
    expect(long.endsWith('…')).toBe(true)
  })

  it('every released version in CHANGELOG.md has something to show', () => {
    const all = parseChangelog(changelog)
    expect(all.length).toBeGreaterThan(10)
    for (const r of all) expect(r.sections.some((s) => s.items.length > 0), r.version).toBe(true)
    const latest = all.find((r) => r.version === '0.2.10')!.pt!
    expect(latest.points[0]).toMatch(/^\*\*Threads\.\*\* Cada resposta/)
    expect(latest.points.at(-1)).toMatch(/^\*\*Correções\.\*\*/)
    expect(latest.outro).toMatch(/^Obrigado à Rayanne/)
  })
})
