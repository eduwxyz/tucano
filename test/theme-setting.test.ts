// The colour theme is a personal setting beside the light/dark mode: each person's own, kept in
// the settings for the owner, copied with a workspace's general settings.
import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { People } from '../src/core/people'
import { can, PERSONAL_SETTINGS } from '../src/core/policy-people'
import { settingsPatchError } from '../src/core/settings-patch'
import { GENERAL_SETTINGS } from '../src/shared/workspaces'
import { THEME_IDS } from '../src/shared/themes'

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
