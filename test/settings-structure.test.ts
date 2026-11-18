import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'
import { settingsDestination, settingsStructure } from '../src/renderer/src/settings-structure'
import { inspectSettingsPlacement } from '../scripts/lib/settings-placement.mjs'

describe('settings ownership and visibility', () => {
  it('gives each rendered setting a declared home inside its own section', () => {
    const result = inspectSettingsPlacement(fileURLToPath(new URL('..', import.meta.url)))
    expect(result.checkedWrites).toBeGreaterThan(15)
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('keeps personal writes within the backend permission list and administrative panes private', () => {
    const member = settingsStructure({ admin: false, owner: false, team: true, servers: true })
    const visible = member.filter(section => section.visible)
    expect(new Set(visible.map(section => section.page))).toEqual(new Set(['geral', 'pessoas']))
    expect(visible.find(section => section.id === 'pessoas-people')).toBeDefined()
    expect(visible.find(section => section.id === 'atividade-activity')).toBeUndefined()
    expect(visible.find(section => section.id === 'integracoes-phone')).toBeUndefined()
    expect(visible.find(section => section.id === 'modelos-agents')).toBeUndefined()
    for (const section of visible.filter(section => section.scope === 'personal')) {
      for (const key of section.keys) expect(PERSONAL_SETTINGS).toContain(key)
    }
  })

  it('keeps owner-only controls and capability-dependent server setup out of an admin’s destinations', () => {
    const admin = settingsStructure({ admin: true, owner: false, team: true, servers: false })
    expect(admin.find(section => section.id === 'geral-danger')!.visible).toBe(false) // admins manage retention; deletion stays owner-guarded within the component
    expect(admin.find(section => section.id === 'integracoes-phone')!.visible).toBe(false)
    expect(admin.find(section => section.id === 'servidores-cards')!.visible).toBe(false)
    const available = settingsStructure({ admin: true, owner: true, team: true, servers: true })
    expect(settingsDestination('servidores', available).section).toBe('servidores-cards')
    expect(settingsDestination('pessoas', available).section).toBe('pessoas-people')
    expect(settingsDestination('servidores', admin).section).not.toBe('servidores-cards')
  })

  it('resolves a section to the pane that holds it and keeps every section in one pane', () => {
    const all = settingsStructure({ admin: true, owner: true, team: true, servers: true })
    expect(settingsDestination('agentes-browser', all)).toEqual({ page: 'agentes', section: 'agentes-browser', explicit: true })
    expect(settingsDestination('geral-backups', all)).toEqual({ page: 'geral', section: 'geral-backups', explicit: true })
    expect(settingsDestination(undefined, all).page).toBe('geral')
    const ids = all.map(section => section.id)
    expect(new Set(ids).size).toBe(ids.length)
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
    const result = fixture("{id:'geral-appearance',keys:['theme']}", "'geral-appearance': <Shared update={updateSettings} />")
    expect(result.checkedWrites).toBe(1)
    expect(result.passed).toBe(true)
  })
  it('rejects a declared setting rendered in the wrong section', () => {
    const result = fixture("{id:'geral-appearance',keys:['theme']},{id:'agentes-limits',keys:[]}", "'geral-appearance': <p>Appearance</p>, 'agentes-limits': <Shared update={updateSettings} />")
    expect(result.passed).toBe(false)
    expect(result.failures.some(message => message.includes('theme is written in agentes-limits; declared home: geral-appearance'))).toBe(true)
  })
  it('rejects undeclared settings, duplicate owners and missing section content', () => {
    const unknown = fixture("{id:'geral-appearance',keys:[]}", "'geral-appearance': <Shared update={updateSettings} />")
    expect(unknown.failures.some(message => message.includes('declared home: missing'))).toBe(true)
    const duplicate = fixture("{id:'geral-appearance',keys:['theme']},{id:'outra-aparencia',keys:['theme']}", "'geral-appearance': <p>Settings</p>")
    expect(duplicate.failures).toContain('theme is owned by both geral-appearance and outra-aparencia')
    expect(duplicate.failures).toContain('Section has no rendering slot: outra-aparencia')
  })
})
