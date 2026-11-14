import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'
import { settingsDestination, settingsStructure } from '../src/renderer/src/settings-structure'
import { inspectSettingsPlacement } from '../scripts/lib/settings-placement.mjs'

describe('settings ownership and visibility', () => {
  it('gives each rendered setting a declared home, including shared controls and Wiki parts', () => {
    const result = inspectSettingsPlacement(fileURLToPath(new URL('..', import.meta.url)))
    expect(result.checkedWrites).toBeGreaterThan(15)
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('keeps personal writes within the backend permission list and administrative pages private', () => {
    const member = settingsStructure({ admin: false, owner: false, team: true, servers: true })
    const visible = member.filter(section => section.visible)
    expect(new Set(visible.map(section => section.page))).toEqual(new Set(['app', 'workspace']))
    expect(visible.find(section => section.id === 'workspace-people')).toBeDefined()
    expect(visible.find(section => section.id === 'workspace-activity')).toBeUndefined()
    expect(visible.find(section => section.id === 'connections-phone')).toBeUndefined()
    for (const section of visible.filter(section => section.scope === 'personal')) {
      for (const key of section.keys) expect(PERSONAL_SETTINGS).toContain(key)
    }
  })

  it('keeps owner-only controls and capability-dependent server setup out of an admin’s destinations', () => {
    const admin = settingsStructure({ admin: true, owner: false, team: true, servers: false })
    expect(admin.find(section => section.id === 'workspace-backups')!.visible).toBe(false)
    expect(admin.find(section => section.id === 'workspace-danger')!.visible).toBe(false) // admins manage retention; deletion stays owner-guarded within the component
    expect(admin.find(section => section.id === 'connections-servers')!.visible).toBe(false)
    expect(settingsDestination('servidores', admin).page).toBe('app')
    const available = settingsStructure({ admin: true, owner: true, team: true, servers: true })
    expect(settingsDestination('servidores', available).section).toBe('connections-servers')
    expect(settingsDestination('pessoas', available).section).toBe('workspace-people')
  })
})

describe('placement validation rejects misplaced future controls', () => {
  const fixture = (sections: string, slots: string) => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-settings-contract-'))
    mkdirSync(join(root, 'src/renderer/src/components'), { recursive: true })
    writeFileSync(join(root, 'src/renderer/src/settings-structure.ts'), `function settingsStructure() { return [${sections}] }`)
    writeFileSync(join(root, 'src/renderer/src/components/Pages.tsx'), `function Shared({ update }) { return <button onClick={() => update({ theme: 'dark' })} /> } function SettingsPage() { const content = { ${slots} }; return null }`)
    try { return inspectSettingsPlacement(root) }
    finally {
      expect(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('tucano-settings-contract-')).toBe(true)
      rmSync(root, { recursive: true, force: true })
    }
  }
  it('follows a shared component’s Settings update alias', () => {
    const result = fixture("{id:'app-basic',keys:['theme']}", "'app-basic': <Shared update={updateSettings} />")
    expect(result.checkedWrites).toBe(1)
    expect(result.passed).toBe(true)
  })
  it('rejects a declared setting rendered in the wrong section', () => {
    const result = fixture("{id:'app-basic',keys:['theme']},{id:'agents-basic',keys:[]}", "'app-basic': <p>Appearance</p>, 'agents-basic': <Shared update={updateSettings} />")
    expect(result.passed).toBe(false)
    expect(result.failures.some(message => message.includes('theme is written in agents-basic; declared home: app-basic'))).toBe(true)
  })
  it('rejects undeclared settings, duplicate owners and missing section content', () => {
    const unknown = fixture("{id:'app-basic',keys:[]}", "'app-basic': <Shared update={updateSettings} />")
    expect(unknown.failures.some(message => message.includes('declared home: missing'))).toBe(true)
    const duplicate = fixture("{id:'app-basic',keys:['theme']},{id:'other-basic',keys:['theme']}", "'app-basic': <p>Settings</p>")
    expect(duplicate.failures).toContain('theme is owned by both app-basic and other-basic')
    expect(duplicate.failures).toContain('Section has no rendering slot: other-basic')
  })
})
