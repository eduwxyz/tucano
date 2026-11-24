// #102: a Hermes skills library is not flat. It is "<skills>/<category>/<name>/SKILL.md", with the
// category repeated in the frontmatter, a version, and the facets a big library is navigated by under
// metadata.hermes.tags. Read as a flat folder, a library of 16 categories reads as 16 skills and 330
// misses. These tests build a library in a temp home, so none of them depends on this machine.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { detectedFolders, findLocalSkills, frontmatter, readLinked, skillsIn } from '../src/core/local-skills'

const put = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

// The harnesses' folders are found by where they are: a HERMES_HOME set on the machine would put the
// real library in these results.
const HARNESS_ENV = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AGENTS_HOME', 'PI_HOME', 'HERMES_HOME', 'OPENCODE_CONFIG_DIR']
for (const k of HARNESS_ENV) delete process.env[k]

const HERMES = `---
name: agent-model-evaluation
category: hermes
description: Refresh benchmarks, discover subscribed releases, qualify trials…
version: 4.0.0
metadata:
  hermes:
    tags: [agent, evaluation, benchmarks, routing, subscriptions, "family:model-routing", "tool:api", "risk:cost"]
---
# Agent model evaluation

Read references/tables.md before proposing a pool.
`

let home: string
beforeEach(() => {
  for (const k of HARNESS_ENV) delete process.env[k]
  home = mkdtempSync(join(tmpdir(), 'hermes-skills-'))
  put(join(home, '.hermes/skills/hermes/agent-model-evaluation/SKILL.md'), HERMES)
  put(join(home, '.hermes/skills/hermes/agent-model-evaluation/references/tables.md'), '| model | score |\n|---|---|\n')
  put(join(home, '.hermes/skills/loose/SKILL.md'), '---\nname: loose\ndescription: A skill with no category\n---\nCorpo.')
  put(join(home, '.hermes/skills/notes/NOTES.md'), 'Not a skill: no SKILL.md here.')
  put(join(home, '.hermes/skills/hermes/deep/inner/SKILL.md'), '---\nname: inner\n---\nThree levels down is not a skill.')
})

describe('a Hermes library in its own layout', () => {
  it('reads the category, the version and the facets of the frontmatter', () => {
    expect(frontmatter(HERMES)).toMatchObject({ name: 'agent-model-evaluation', category: 'hermes', version: '4.0.0' })
    expect(frontmatter(HERMES).tags).toEqual(['agent', 'evaluation', 'benchmarks', 'routing', 'subscriptions', 'family:model-routing', 'tool:api', 'risk:cost'])
    // the "|" and ">" blocks still hold, and a skill with none of the new fields reads as before
    expect(frontmatter('---\nname: a\ndescription: |\n  um\n  dois\nlicense: MIT\n---\ncorpo')).toEqual({ name: 'a', description: 'um dois', body: 'corpo' })
  })

  it('takes the tags as a "- a" list too, and a plain Agent Skills file keeps its version under metadata', () => {
    expect(frontmatter('---\nname: t\nmetadata:\n  hermes:\n    tags:\n      - agent\n      - "family:model-routing"\n---\nx').tags).toEqual(['agent', 'family:model-routing'])
    expect(frontmatter('---\nname: t\nmetadata:\n  version: 2.1.0\n---\nx').version).toBe('2.1.0')
    expect(frontmatter('---\nname: t\n---\nx').tags).toBeUndefined()
    expect(frontmatter('---\nname: t\n---\nx').version).toBeUndefined()
  })

  it('finds <category>/<name>/SKILL.md, one level deep, and leaves a folder without a SKILL.md alone', () => {
    const folder = join(home, '.hermes/skills')
    expect(skillsIn(folder, 'Hermes').map((k) => k.name).sort()).toEqual(['agent-model-evaluation', 'loose'])
    // the three-level one, and the folder with no SKILL.md, are not skills
    expect(skillsIn(folder, 'Hermes').some((k) => k.name === 'inner')).toBe(false)
  })

  it('hooks the category to the skill, and its support files to the skill', () => {
    const found = findLocalSkills(home)
    const evaluations = found.find((k) => k.name === 'agent-model-evaluation')!
    expect(evaluations).toMatchObject({ origin: 'Hermes', category: 'hermes', version: '4.0.0', scripts: false })
    expect(evaluations.files).toEqual(['references/tables.md'])
    expect(evaluations.description).toBe('Refresh benchmarks, discover subscribed releases, qualify trials…')
    // a flat skill in the same library keeps working, with no category to show
    expect(found.find((k) => k.name === 'loose')?.category).toBeUndefined()
    // and a category's support files can be read like any other skill's
    expect(readLinked(evaluations.source, 'references/tables.md')).toContain('| model | score |')
  })

  it("counts the library the way the one folder it lives in is counted", () => {
    const hermes = detectedFolders(home).find((f) => f.source === 'Hermes')!
    expect(hermes.path).toBe(join(home, '.hermes/skills'))
    expect(hermes.count).toBe(2) // not 3: the folder with no SKILL.md is not a skill, and "inner" is too deep
    expect(hermes.on).toBe(true)
  })
})
