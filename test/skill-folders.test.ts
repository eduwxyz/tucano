import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectedFolders, expandFolder, findLocalSkills, skillFolders } from '../src/core/local-skills'

// A harness's own folder is found by where it is, so a home with the folders in it is the whole test.
const HOME_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'AGENTS_HOME', 'PI_HOME', 'HERMES_HOME', 'OPENCODE_CONFIG_DIR']
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(HOME_KEYS.map((k) => [k, process.env[k]]))
  for (const k of HOME_KEYS) delete process.env[k]
})

afterEach(() => {
  for (const k of HOME_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

const recipe = (name: string, description = 'when to use it'): string => `---\nname: ${name}\ndescription: ${description}\n---\n\nDo the thing.\n`

function home(): string {
  const root = mkdtempSync(join(tmpdir(), 'tucano-skill-folders-'))
  for (const [where, name] of [
    ['.claude/skills/core-tests', 'core-tests'],
    ['.codex/skills/ship', 'ship'],
    ['.hermes/skills/lift', 'lift'],
    ['.pi/skills/plan', 'plan'],
    ['.agents/skills/agents-one', 'agents-one']
  ] as [string, string][]) {
    mkdirSync(join(root, where), { recursive: true })
    writeFileSync(join(root, where, 'SKILL.md'), recipe(name))
  }
  return root
}

describe('the folders skills are read from', () => {
  it('finds the folder each harness on this computer keeps, and nothing for one that is not here', () => {
    const root = home()
    const found = detectedFolders(root)
    expect(found.map((f) => f.source)).toEqual(['Claude Code', 'Codex', 'Agents', 'Pi', 'Hermes'])
    expect(found.every((f) => f.detected && f.on)).toBe(true)
    expect(found.find((f) => f.source === 'Claude Code')?.path).toBe(join(root, '.claude', 'skills'))
    // OpenCode, Copilot and Gemini have no folder here: nothing is invented for them.
    expect(found.some((f) => ['OpenCode', 'Copilot', 'Gemini'].includes(f.source))).toBe(false)
  })

  it('counts what is in each folder without reading the recipes', () => {
    const root = home()
    expect(skillFolders(root).map((f) => f.count)).toEqual([1, 1, 1, 1, 1])
  })

  it('mixes every folder that is on into one list, each skill keeping its own origin', () => {
    const root = home()
    const skills = findLocalSkills(root)
    expect(skills.map((s) => s.name).sort()).toEqual(['agents-one', 'core-tests', 'lift', 'plan', 'ship'])
    expect(skills.find((s) => s.name === 'lift')?.origin).toBe('Hermes')
    expect(skills.find((s) => s.name === 'plan')?.origin).toBe('Pi')
  })

  it('leaves a folder out when it is turned off, and the list keeps it', () => {
    const root = home()
    const hermes = join(root, '.hermes', 'skills')
    const folders = skillFolders(root, [], [hermes])
    expect(folders).toHaveLength(5)
    expect(folders.find((f) => f.source === 'Hermes')).toMatchObject({ on: false, detected: true })
    expect(findLocalSkills(root, folders).map((s) => s.name)).not.toContain('lift')
  })

  it('reads a folder added by hand, once, even when it is also one of the harness folders', () => {
    const root = home()
    const own = join(root, 'extra', 'own')
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, 'SKILL.md'), recipe('own'))
    const folders = skillFolders(root, [own, join(root, '.claude', 'skills'), own])
    expect(folders.filter((f) => f.path === own)).toHaveLength(1)
    expect(folders.find((f) => f.path === own)).toMatchObject({ source: 'Added', detected: false, on: true, count: 1 })
    expect(findLocalSkills(root, folders).map((s) => s.name)).toContain('own')
  })

  it('reads a folder that is one skill itself', () => {
    const root = home()
    const single = join(root, 'one-skill')
    mkdirSync(single, { recursive: true })
    writeFileSync(join(single, 'SKILL.md'), recipe('single'))
    const skills = findLocalSkills(root, skillFolders(root, [single]))
    expect(skills.filter((s) => s.name === 'single')).toHaveLength(1)
  })

  it('takes ~ and an absolute path, and refuses anything it cannot place', () => {
    expect(expandFolder('~/skills', homedir())).toBe(join(homedir(), 'skills'))
    expect(expandFolder('~', homedir())).toBe(homedir())
    expect(expandFolder('   ', homedir())).toBeUndefined()
    expect(expandFolder('skills/relative', homedir())).toBeUndefined()
  })

  it('counts a skill the skills CLI linked into two homes once, under the first folder that holds it', () => {
    const root = home()
    symlinkSync(join(root, '.agents', 'skills', 'agents-one'), join(root, '.claude', 'skills', 'agents-one'))
    const found = findLocalSkills(root).filter((s) => s.name === 'agents-one')
    expect(found).toHaveLength(1)
    // Claude Code's folder is read before Agent's, so that is where it came from.
    expect(found[0]?.origin).toBe('Claude Code')
  })

  it('reads both the folder Hermes names and the one in the home, when they are different folders', () => {
    const root = home()
    const install = mkdtempSync(join(tmpdir(), 'tucano-hermes-install-'))
    mkdirSync(join(install, 'skills', 'packaged'), { recursive: true })
    writeFileSync(join(install, 'skills', 'packaged', 'SKILL.md'), recipe('packaged'))
    process.env['HERMES_HOME'] = install
    const folders = skillFolders(root).filter((f) => f.source === 'Hermes')
    expect(folders.map((f) => f.path)).toEqual([join(install, 'skills'), join(root, '.hermes', 'skills')])
    expect(findLocalSkills(root, skillFolders(root)).map((s) => s.name)).toEqual(expect.arrayContaining(['packaged', 'lift']))
  })

  it('follows a harness that points its folder somewhere else', () => {
    const root = home()
    const elsewhere = mkdtempSync(join(tmpdir(), 'tucano-skills-elsewhere-'))
    mkdirSync(join(elsewhere, 'skills', 'moved'), { recursive: true })
    writeFileSync(join(elsewhere, 'skills', 'moved', 'SKILL.md'), recipe('moved'))
    process.env['CLAUDE_CONFIG_DIR'] = elsewhere
    const folders = skillFolders(root)
    expect(folders.find((f) => f.source === 'Claude Code')?.path).toBe(join(elsewhere, 'skills'))
    expect(findLocalSkills(root, folders).map((s) => s.name)).toContain('moved')
  })
})
