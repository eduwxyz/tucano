import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { findHermesSkills, findSkills, skillMeta } from '../src/core/local-skills'
import { tagFacets } from '../src/shared/skill-tags'

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

  it('falls back to a top-level tags list when metadata.hermes.tags is absent', () => {
    expect(skillMeta('---\nname: a\ntags: [family:ops, env:prod]\n---\n').tags).toEqual(['family:ops', 'env:prod'])
    expect(skillMeta('---\nname: a\ntags:\n  - family:ops\n---\n').tags).toEqual(['family:ops'])
  })

  it('prefers metadata.hermes.tags over the top-level tags', () => {
    expect(skillMeta('---\nname: a\ntags: [x]\nmetadata:\n  hermes:\n    tags: [family:ops]\n---\n').tags).toEqual(['family:ops'])
  })

  it('has no tags when metadata has no hermes', () => {
    expect(skillMeta('---\nmetadata:\n  version: 1\n  other:\n    tags: [x]\n---\n').tags).toEqual([])
  })

  it('reads the frontmatter of a file that starts with a UTF-8 byte order mark', () => {
    const m = skillMeta('\uFEFF---\ncategory: ops\nversion: 2\ntags: [family:ops]\n---\nx')
    expect(m).toMatchObject({ category: 'ops', version: '2', tags: ['family:ops'] })
  })

  it('has no tags when there is no frontmatter', () => {
    expect(skillMeta('# just text')).toEqual({ tags: [] })
  })
})

describe('findHermesSkills (byte order mark)', () => {
  it('keeps name, description and category of a SKILL.md saved with a BOM', () => {
    put(join(root, 'ops/b/SKILL.md'), '\uFEFF---\nname: b\ndescription: With BOM\ncategory: media\n---\nbody')
    expect(findHermesSkills(root, 'H')[0]).toMatchObject({ name: 'b', description: 'With BOM', category: 'media' })
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

  it('names the skill by its folder when the frontmatter name differs', () => {
    put(join(root, 'ops/folder-name/SKILL.md'), '---\nname: other-name\n---\n')
    put(join(root, 'flat-folder/SKILL.md'), '---\nname: flat-other\n---\n')
    expect(findHermesSkills(root, 'H').map((s) => s.name).sort()).toEqual(['flat-folder', 'folder-name'])
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

  it('does not take scripts/ or references/ of a category folder without a SKILL.md for skills', () => {
    put(join(root, 'cat/scripts/SKILL.md'), '---\nname: vendored\n---\n')
    put(join(root, 'cat/references/SKILL.md'), '---\nname: ref\n---\n')
    put(join(root, 'cat/real/SKILL.md'), '---\nname: real\n---\n')
    expect(findHermesSkills(root, 'H').map((s) => s.name)).toEqual(['real'])
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

describe('findSkills (same folder, different case)', () => {
  it.skipIf(process.platform !== 'win32')('lists a skill once when Windows reaches it by paths that differ only in case', () => {
    const saved = process.env['CODEX_HOME']
    delete process.env['CODEX_HOME']
    try {
      put(join(home, '.codex/skills/casey/SKILL.md'), '---\nname: casey\n---\nx')
      const found = findSkills(home, join(home, '.codex', 'skills').toUpperCase())
      expect(found.filter((s) => s.name === 'casey')).toHaveLength(1)
    } finally {
      if (saved !== undefined) process.env['CODEX_HOME'] = saved
    }
  })
})

describe('tagFacets', () => {
  it('groups family:/env:/tool: tags by facet, in a fixed order, keeping the values', () => {
    expect(tagFacets(['tool:git', 'family:ops', 'env:wsl', 'family:seo'])).toEqual([
      { facet: 'family', values: ['ops', 'seo'] },
      { facet: 'env', values: ['wsl'] },
      { facet: 'tool', values: ['git'] }
    ])
  })

  it('puts tags with no known facet in one group without a facet', () => {
    expect(tagFacets(['family:ops', 'plain', 'unknown:x'])).toEqual([
      { facet: 'family', values: ['ops'] },
      { facet: undefined, values: ['plain', 'unknown:x'] }
    ])
  })

  it('keeps colons inside the value and drops an empty value', () => {
    expect(tagFacets(['risk:high:prod', 'role:'])).toEqual([
      { facet: 'risk', values: ['high:prod'] },
      { facet: undefined, values: ['role:'] }
    ])
  })

  it('is empty for no tags', () => {
    expect(tagFacets([])).toEqual([])
  })
})

describe('allowedTools', () => {
  it('reaches the skill found in the extra directory', () => {
    put(join(root, 'ops', 'a', 'SKILL.md'), '---\nname: a\nallowed-tools: Read, Bash\n---\nx')
    expect(findSkills(home, root).find((s) => s.name === 'a')?.allowedTools).toBe('Read, Bash')
  })
})

describe('allowed-tools forms', () => {
  it('reads a block list, as 73 real Hermes skills write it, skipping comments', () => {
    const m = skillMeta('---\nname: a\nallowed-tools:\n  # group\n  - WebFetch\n  - "Bash"\nuser-invocable: true\n---\nx')
    expect(m.allowedTools).toBe('WebFetch, Bash')
  })

  it('reads a flow list', () => {
    expect(skillMeta('---\nname: a\nallowed-tools: [Read, Bash]\n---\nx').allowedTools).toBe('Read, Bash')
  })

  it('has none for an empty block', () => {
    expect(skillMeta('---\nname: a\nallowed-tools:\nversion: 1\n---\nx').allowedTools).toBeUndefined()
  })
})

describe('findSkills (~ in the extra directory)', () => {
  it('expands a leading ~ to the home folder', () => {
    put(join(home, 'mine/ops/tilde-skill/SKILL.md'), '---\n' + 'name: tilde-skill' + '\n---\n')
    expect(findSkills(home, '~/mine').map((s) => s.name)).toContain('tilde-skill')
    expect(findSkills(home, '~\\mine').map((s) => s.name)).toContain('tilde-skill')
    expect(findSkills(home, '  ~/mine  ').map((s) => s.name)).toContain('tilde-skill')
  })
})
