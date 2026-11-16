// The colour theme is a personal setting beside the light/dark mode: each person's own, kept in
// the settings for the owner, copied with a workspace's general settings.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { People } from '../src/core/people'
import { can, PERSONAL_SETTINGS } from '../src/core/policy-people'
import { settingsPatchError } from '../src/core/settings-patch'
import { GENERAL_SETTINGS } from '../src/shared/workspaces'
import { DEFAULT_THEME_ID, THEME_IDS, themeById, themeIdOf } from '../src/shared/themes'
import { Workspaces } from '../src/main/workspaces'

const dirs: string[] = []
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), 'tucano-theme-setting-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

// Starting a workspace: the core reads its saved theme, main keeps it for the window's first paint.
function restart(dbFile: string, registryDir: string): string {
  const db = new Db(dbFile)
  const saved = db.getSettings(base).themeId
  db.close()
  const registry = new Workspaces(registryDir)
  registry.setThemeId(registry.selected().id, saved)
  return themeById(new Workspaces(registryDir).selected().themeId).id
}

const ready = { installed: true, loggedIn: true }
const base: Settings = {
  workspaceName: 'Ana',
  context: '',
  engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready },
  routerModel: 'haiku',
  memoryModel: 'haiku',
  memoryLearning: 'auto',
  defaultLimit: 1000,
  approvalTtlHours: 24,
  theme: 'system',
  language: 'pt',
  onboarding: { done: true }
}

describe('the theme setting', () => {
  it('takes one of the themes there are, or null to go back to Tucano', () => {
    for (const id of THEME_IDS) expect(settingsPatchError({ themeId: id })).toBeUndefined()
    expect(settingsPatchError({ themeId: null })).toBeUndefined()
    expect(settingsPatchError({ themeId: 'nope' })).toBeDefined()
    expect(settingsPatchError({ themeId: 3 })).toBeDefined()
  })

  it("is each person's own and comes along with the general settings", () => {
    expect(PERSONAL_SETTINGS).toContain('themeId')
    expect(GENERAL_SETTINGS).toContain('themeId')
  })

  it("round-trips through the owner's settings", () => {
    const db = new Db(':memory:')
    expect(db.getSettings(base).themeId).toBeUndefined()
    db.setSettings({ themeId: 'acai' })
    expect(db.getSettings(base).themeId).toBe('acai')
  })

  it('a theme cleared to null survives a restart and falls back to Tucano', () => {
    const [dir, registryDir] = [scratch(), scratch()]
    const db = new Db(join(dir, 'tucano.db'))
    db.setSettings({ themeId: 'acai' })
    db.setSettings({ themeId: null as unknown as string })
    db.close()
    expect(() => restart(join(dir, 'tucano.db'), registryDir)).not.toThrow()
    expect(restart(join(dir, 'tucano.db'), registryDir)).toBe(DEFAULT_THEME_ID)
  })

  it('a theme that no longer exists (gone in a later version) falls back to Tucano', () => {
    const [dir, registryDir] = [scratch(), scratch()]
    const db = new Db(join(dir, 'tucano.db'))
    db.setSettings({ themeId: 'gone-in-a-later-version' })
    db.close()
    expect(restart(join(dir, 'tucano.db'), registryDir)).toBe(DEFAULT_THEME_ID)
  })

  it('null, or anything not a string, is no theme', () => {
    expect(themeIdOf(null)).toBeUndefined()
    expect(themeIdOf(3)).toBeUndefined()
    expect(themeIdOf('acai')).toBe('acai')
  })

  it('the registry takes null, or anything not a string, as no theme', () => {
    const registry = new Workspaces(scratch())
    const id = registry.selected().id
    registry.setThemeId(id, 'mata')
    registry.setThemeId(id, null)
    expect(registry.selected().themeId).toBeUndefined()
    registry.setThemeId(id, 7 as unknown as string)
    expect(registry.selected().themeId).toBeUndefined()
  })

  it("a member's pick is kept on them; until they pick they see the owner's", () => {
    const db = new Db(':memory:')
    const people = new People(db)
    const ana = db.owner()
    const r = people.join(people.createInvite(ana, { role: 'member' }).code, 'Bia')
    if (!('person' in r)) throw new Error(r.error)
    const bia = r.person
    expect(can(bia, { kind: 'settings', keys: ['themeId'] })).toBe(true)
    expect(people.settingsFor(bia, { ...base, themeId: 'mata' }).themeId).toBe('mata')
    expect(people.takePrefs(bia, { themeId: 'ipe' })).toEqual({})
    expect(people.settingsFor(bia, { ...base, themeId: 'mata' }).themeId).toBe('ipe')
    expect(people.takePrefs(ana, { themeId: 'rio-negro' })).toEqual({ themeId: 'rio-negro' })
  })
})
