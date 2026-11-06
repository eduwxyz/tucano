import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { findHermesSkills, findSkills, skillMeta } from '../src/core/local-skills'

const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

let root: string
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hs-home-'))
  root = mkdtempSync(join(tmpdir(), 'hs-skills-'))
})

describe('skillMeta', () => {
  it('reads category and top-level version, with allowed-tools', () => {
    const m = skillMeta('---\nname: a\ncategory: ops\nversion: 1.2.0\nallowed-tools: Read, Bash\n---\nx')
    expect(m).toMatchObject({ category: 'ops', version: '1.2.0', allowedTools: 'Read, Bash', tags: [] })
  })

  it('has no version and no tags when the frontmatter is simple', () => {
    const m = skillMeta('---\nname: a\ndescription: b\n---\nx')
    expect(m.version).toBeUndefined()
    expect(m.category).toBeUndefined()
    expect(m.tags).toEqual([])
  })

  it('falls back to metadata.version', () => {
    expect(skillMeta('---\nname: a\nmetadata:\n  version: "2.0"\n---\n').version).toBe('2.0')
  })

  it('prefers the top-level version over metadata.version', () => {
    expect(skillMeta('---\nversion: 1\nmetadata:\n  version: 2\n---\n').version).toBe('1')
  })

  it('reads metadata.hermes.tags as a flow list, with quotes and colons', () => {
    const m = skillMeta("---\nname: a\nmetadata:\n  hermes:\n    tags: ['family:ops', \"env:vps\", plain]\n---\n")
    expect(m.tags).toEqual(['family:ops', 'env:vps', 'plain'])
  })

  it('reads metadata.hermes.tags as a block list', () => {
    const m = skillMeta('---\nmetadata:\n  hermes:\n    tags:\n      - "risk:high"\n      - locale:pt-BR\n    other: x\n---\n')
    expect(m.tags).toEqual(['risk:high', 'locale:pt-BR'])
  })

  it('has no tags when metadata has no hermes', () => {
    expect(skillMeta('---\nmetadata:\n  version: 1\n  other:\n    tags: [x]\n---\n').tags).toEqual([])
  })

  it('has no tags when there is no frontmatter', () => {
    expect(skillMeta('# just text')).toEqual({ tags: [] })
  })
})

describe('findHermesSkills', () => {
  it('finds <category>/<name>/SKILL.md and the flat <name>/SKILL.md', () => {
    put(join(root, 'ops/deploy/SKILL.md'), '---\nname: deploy\ndescription: Ship it\nversion: 1.0\n---\nbody')
    put(join(root, 'flat/SKILL.md'), '---\nname: flat\ndescription: Old layout\n---\nbody')
    const found = findHermesSkills(root, 'Hermes')
    expect(found.map((s) => s.name).sort()).toEqual(['deploy', 'flat'])
    const d = found.find((s) => s.name === 'deploy')!
    expect(d).toMatchObject({ category: 'ops', version: '1.0', origin: 'Hermes', description: 'Ship it' })
    expect(found.find((s) => s.name === 'flat')!.category).toBeUndefined()
  })

  it('uses the frontmatter name when it differs from the folder', () => {
    put(join(root, 'ops/folder-name/SKILL.md'), '---\nname: other-name\n---\n')
    expect(findHermesSkills(root, 'H').map((s) => s.name)).toEqual(['other-name'])
  })

  it('lets a declared category win over the folder', () => {
    put(join(root, 'ops/x/SKILL.md'), '---\nname: x\ncategory: media\n---\n')
    expect(findHermesSkills(root, 'H')[0]!.category).toBe('media')
  })

  it('uses the folder as the category when none is declared', () => {
    put(join(root, 'ops/x/SKILL.md'), '---\nname: x\n---\n')
    expect(findHermesSkills(root, 'H')[0]!.category).toBe('ops')
  })

  it('skips dot-folders and node_modules', () => {
    put(join(root, '.archive/old/SKILL.md'), '---\nname: old\n---\n')
    put(join(root, 'ops/.git/SKILL.md'), '---\nname: gitone\n---\n')
    put(join(root, 'ops/.hidden/SKILL.md'), '---\nname: hid\n---\n')
    put(join(root, 'node_modules/pkg/SKILL.md'), '---\nname: nm\n---\n')
    put(join(root, 'ops/ok/SKILL.md'), '---\nname: ok\n---\n')
    expect(findHermesSkills(root, 'H').map((s) => s.name)).toEqual(['ok'])
  })

  it('does not take scripts/ or references/ inside a skill for categories', () => {
    put(join(root, 'ops/x/SKILL.md'), '---\nname: x\n---\n')
    put(join(root, 'ops/x/scripts/y/SKILL.md'), '---\nname: nested\n---\n')
    put(join(root, 'solo/SKILL.md'), '---\nname: solo\n---\n')
    put(join(root, 'solo/references/z/SKILL.md'), '---\nname: nested2\n---\n')
    expect(findHermesSkills(root, 'H').map((s) => s.name).sort()).toEqual(['solo', 'x'])
  })

  it('works on a SKILL.md without metadata.hermes', () => {
    put(join(root, 'ops/x/SKILL.md'), '---\nname: x\ndescription: d\nallowed-tools: Read\n---\n')
    expect(findHermesSkills(root, 'H')[0]!.tags ?? []).toEqual([])
  })

  it('lists the same name in two categories, both', () => {
    put(join(root, 'a/same/SKILL.md'), '---\nname: same\n---\n')
    put(join(root, 'b/same/SKILL.md'), '---\nname: same\n---\n')
    expect(findHermesSkills(root, 'H').map((s) => s.category).sort()).toEqual(['a', 'b'])
  })

  it('returns nothing for a directory that does not exist', () => {
    expect(findHermesSkills(join(root, 'nope'), 'H')).toEqual([])
  })
})

describe('findSkills (extra directory)', () => {
  beforeEach(() => {
    put(join(home, '.codex/skills/imediato/SKILL.md'), '---\nname: imediato\ndescription: Já\n---\nCorpo.')
  })

  it('is the same as the usual list when the extra directory is unset, empty or missing', () => {
    const base = findSkills(home).map((s) => s.source)
    expect(base).toHaveLength(1)
    expect(findSkills(home, '').map((s) => s.source)).toEqual(base)
    expect(findSkills(home, undefined).map((s) => s.source)).toEqual(base)
    expect(findSkills(home, join(root, 'nope')).map((s) => s.source)).toEqual(base)
  })

  it('adds the categorized skills of the extra directory', () => {
    put(join(root, 'ops/deploy/SKILL.md'), '---\nname: deploy\n---\n')
    const all = findSkills(home, root)
    expect(all.map((s) => s.name).sort()).toEqual(['deploy', 'imediato'])
    expect(all.find((s) => s.name === 'deploy')!.origin).toBe('Hermes')
  })

  it('lists a skill reached twice (link and extra directory) once', () => {
    put(join(root, 'ops/deploy/SKILL.md'), '---\nname: deploy\n---\n')
    try {
      symlinkSync(join(root, 'ops/deploy'), join(home, '.codex/skills/deploy'), 'junction')
    } catch {
      return // no permission to link here: the case can't run
    }
    expect(findSkills(home, root).filter((s) => s.name === 'deploy')).toHaveLength(1)
  })
})
