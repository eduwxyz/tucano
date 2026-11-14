import { describe, expect, it } from 'vitest'
import { skillHarnessName, SKILL_LOCAL, skillGroup, skillOrigin } from '../src/shared/skill-groups'

// The real ones, copied from the store: on Windows the path arrives with backslashes.
const hermesFoundry = 'C:/Users/theap/AppData/Local/hermes/skills/foundry/foundry-macros/SKILL.md'
const hermesFoundryWin = 'C:\\Users\\theap\\AppData\\Local\\hermes\\skills\\foundry\\foundry-macros\\SKILL.md'
const codexWin = 'C:\\Users\\theap\\.codex\\skills\\humanizer\\SKILL.md'
const claudeWin = 'C:\\Users\\theap\\.claude\\skills\\humanizer\\SKILL.md'

describe('grouping the skill library', () => {
  it('groups a Hermes skill by its category folder', () => {
    expect(skillGroup(hermesFoundry)).toBe('foundry')
    expect(skillGroup('C:/Users/theap/AppData/Local/hermes/skills/software-development/github/SKILL.md')).toBe('software-development')
  })

  it('reads a Windows path with backslashes the same way, which is how they are stored here', () => {
    expect(skillGroup(hermesFoundryWin)).toBe('foundry')
    expect(skillOrigin(hermesFoundryWin)).toBe('hermes')
  })

  it('groups a skill with no category by where it came from', () => {
    expect(skillGroup(codexWin)).toBe('codex')
    expect(skillGroup(claudeWin)).toBe('claude')
    expect(skillGroup('/home/me/hermes/skills/loose/SKILL.md')).toBe('hermes')
  })

  it('gives a skill written in the app a group of its own', () => {
    expect(skillGroup(undefined)).toBe(SKILL_LOCAL)
    expect(skillGroup('')).toBe(SKILL_LOCAL)
    expect(skillOrigin(undefined)).toBeUndefined()
  })

  it('names the origin of a Codex skill even on Windows, which the screens got wrong', () => {
    // The tag looked for '/.codex/' in the raw path, so with backslashes it never matched and every
    // linked skill was labelled Claude Code.
    expect(skillOrigin(codexWin)).toBe('codex')
    expect(skillOrigin(claudeWin)).toBe('claude')
  })
})

it.each([
  ['C:\\Users\\Apo\\.hermes\\skills\\tools\\read\\SKILL.md', 'Hermes'],
  ['/home/apo/.config/opencode/skills/read/SKILL.md', 'OpenCode'],
  ['/home/apo/.opencode/skills/read/SKILL.md', 'OpenCode'],
  ['/home/apo/.copilot/skills/read/SKILL.md', 'Copilot'],
  ['/home/apo/.gemini/skills/read/SKILL.md', 'Gemini'],
  ['/home/apo/.codex/skills/read/SKILL.md', 'Codex'],
  ['/home/apo/.pi/skills/read/SKILL.md', 'Pi'],
  ['/home/apo/.agents/skills/read/SKILL.md', 'Agents'],
  ['/home/apo/.claude/skills/read/SKILL.md', 'Claude Code'],
  ['/custom/library/read/SKILL.md', undefined]
])('labels the harness for %s', (source, expected) => {
  expect(skillHarnessName(source)).toBe(expected)
})
it('recognizes a categorized default Hermes library as Hermes', () => {
  expect(skillOrigin('C:\\Users\\Apo\\.hermes\\skills\\tools\\read\\SKILL.md')).toBe('hermes')
})
