// What the app changes in an extension after unpacking it, so an agent gets the mode it needs rather than
// the one a person's browser is left with (shared/addons.ts carries the edits and the reasons). Three
// things have to hold: the vendor's line is replaced, a second start changes nothing, and a store build
// that has moved the line is left alone and says so — an extension half set up looks set up and is not.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { TUNE, TUNE_REVISION } from '../src/shared/addons'
import { tune } from '../src/core/chrome-addons'
import { assistFlags } from '../src/core/chrome'
import { setLang } from '../src/shared/lang'

const STAMP = '.tucano-tuned'

// A folder as the store hands it over, holding only the files the edits name, with the vendor's own lines.
const unpacked = (key: 'ads' | 'popups' | 'clutter'): string => {
  const dir = mkdtempSync(join(tmpdir(), `tune-${key}-`))
  // Every edit of one file lands in that file (PopUpOFF has four in its background.js), then the next.
  const byFile = new Map<string, string[]>()
  for (const edit of TUNE[key] ?? []) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit.from])
  for (const [name, lines] of byFile) {
    const file = join(dir, name)
    mkdirSync(join(file, '..'), { recursive: true })
    // Each vendor line as it is, with something around it so a replacement has to be exact.
    writeFileSync(file, `before\n${lines.join('\nafter\nbefore\n')}\nafter\n`)
  }
  return dir
}

const stampOf = (dir: string): string => {
  try {
    return readFileSync(join(dir, STAMP), 'utf8')
  } catch {
    return ''
  }
}

beforeEach(() => setLang('en'))

describe('setting an extension up for an agent', () => {
  it('replaces the line the vendor ships, and says nothing about it', () => {
    const dir = unpacked('popups')
    expect(tune(dir, 'popups')).toBeUndefined()
    const text = readFileSync(join(dir, 'background', 'background.js'), 'utf8')
    // Armed on every site, and no tutorial tab: both are edits, and neither leaves the vendor's wording.
    expect(text).toContain('curAutoMode: "easyModeActive",')
    expect(text).toContain('\t\t\tvoid 0')
    expect(text).not.toContain('whitelist')
    expect(text).not.toContain('popupoff.org/tutorial')
    expect(stampOf(dir)).toBe(String(TUNE_REVISION))
  })

  it('changes nothing the second time, so every start is free', () => {
    const dir = unpacked('clutter')
    tune(dir, 'clutter')
    const once = readFileSync(join(dir, 'background', 'metrics.js'), 'utf8')
    // The app does not edit a folder it has already edited: the stamp is what it reads instead.
    expect(once).toContain('return void 0;')
    expect(tune(dir, 'clutter')).toBeUndefined()
    expect(readFileSync(join(dir, 'background', 'metrics.js'), 'utf8')).toBe(once)
  })

  it('leaves a store build that moved the line as it is, and says which file', () => {
    const dir = unpacked('ads')
    // What a store update looks like from here: the anchor went away.
    writeFileSync(join(dir, 'js', 'mode-manager.js'), 'const modes = {\n    everything: [],\n}\n')
    const note = tune(dir, 'ads')
    expect(note).toContain('js/mode-manager.js')
    expect(note).toContain('Left as the store ships it')
    // Nothing half-written, and no stamp: the next start tries again rather than believing a lie.
    expect(readFileSync(join(dir, 'js', 'mode-manager.js'), 'utf8')).toContain('everything: [],')
    expect(stampOf(dir)).toBe('')
  })

  it('names the file that went missing too, instead of failing the download', () => {
    const dir = unpacked('clutter')
    writeFileSync(join(dir, 'background', 'sentry.js'), '// this build reports nothing\n')
    const note = tune(dir, 'clutter')
    expect(note).toContain('background/sentry.js')
  })

  it('finishes setting up a folder an earlier revision already touched, without a word', () => {
    // Revision 1 wrote the ad blocker's complete list but left its optimal list naming every url, so the
    // mode it reads first kept winning. A folder in that state has the second edit's result and not its
    // line: it is set up, not broken, and says nothing to the person.
    const dir = mkdtempSync(join(tmpdir(), 'tune-ads-rev1-'))
    mkdirSync(join(dir, 'js'), { recursive: true })
    // The vendor file as revision 1 left it: both lists naming every url.
    const modes = `export const defaultFilteringModes = {
    none: [],
    basic: [],
    optimal: [ 'all-urls' ],
    complete: [ 'all-urls' ],
};
`
    writeFileSync(join(dir, 'js', 'mode-manager.js'), modes)
    expect(tune(dir, 'ads')).toBeUndefined()
    const text = readFileSync(join(dir, 'js', 'mode-manager.js'), 'utf8')
    // Complete is the only list naming every url: that is the mode its own lookup answers with.
    expect(text).toContain('    optimal: [],')
    expect(text).toContain("    complete: [ 'all-urls' ],")
    expect(stampOf(dir)).toBe(String(TUNE_REVISION))
  })

  it('stamps an extension with no edits, so its folder is not looked at again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tune-cookies-'))
    expect(tune(dir, 'cookies')).toBeUndefined()
    expect(stampOf(dir)).toBe(String(TUNE_REVISION))
  })
})

describe('the two Chrome switches behind Additional accessibility', () => {
  it('is one switch, and off it is no switch at all', () => {
    expect(assistFlags(undefined)).toEqual([])
    expect(assistFlags(false)).toEqual([])
  })

  it('asks pages for less motion and waits for a press before playing, both from Chrome itself', () => {
    expect(assistFlags(true)).toEqual(['--force-prefers-reduced-motion', '--autoplay-policy=user-gesture-required'])
  })
})
