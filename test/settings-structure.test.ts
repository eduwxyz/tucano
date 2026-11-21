import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { PERSONAL_SETTINGS } from '../src/core/policy-people'
import { settingsStructure, settingsTabStructure } from '../src/renderer/src/settings-structure'
import { inspectSettingsPlacement } from '../scripts/lib/settings-placement.mjs'

const all = { admin: true, owner: true, team: true, servers: true }

describe('settings ownership and visibility', () => {
  it('finds every declared section on the page, with one owner for each setting', () => {
    const result = inspectSettingsPlacement(fileURLToPath(new URL('..', import.meta.url)))
    expect(result.sections).toBeGreaterThan(20)
    expect(result.failures).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('gives every section one tab, and every tab only the sections that exist', () => {
    const sections = settingsStructure(all)
    const ids = sections.map(section => section.id)
    expect(new Set(ids).size).toBe(ids.length)
    const tabs = ['geral', 'modelos', 'agentes', 'integracoes', 'pessoas', 'atividade', 'servidores', 'harnesses']
    const listed = tabs.flatMap(tab => settingsTabStructure(tab, sections).map(section => section.id))
    expect(new Set(listed).size).toBe(listed.length)
    for (const section of sections) expect(listed).toContain(section.id)
    expect(settingsTabStructure('modelos', sections).map(section => section.id).slice(0, 2)).toEqual(['models-agents', 'models-runtimes'])
  })

  it('keeps a member to their own preferences, and every personal key on the backend’s list', () => {
    const member = settingsStructure({ admin: false, owner: false, team: true, servers: true })
    const visible = member.filter(section => section.visible)
    // The Agents tab and the servers tab are an admin's; the Harnesses tab is everyone's.
    expect(new Set(visible.map(section => section.page))).toEqual(new Set(['geral', 'pessoas', 'harnesses']))
    expect(visible.map(section => section.id)).not.toContain('models-agents')
    expect(visible.map(section => section.id)).not.toContain('agents-permissions')
    for (const section of visible.filter(section => section.scope === 'personal')) {
      for (const key of section.keys) expect(PERSONAL_SETTINGS).toContain(key)
    }
  })

  it('gates the phone on the owner and the servers on a capable workspace', () => {
    const admin = settingsStructure({ admin: true, owner: false, team: true, servers: false })
    expect(admin.find(section => section.id === 'connections-phone')!.visible).toBe(false)
    expect(admin.find(section => section.id === 'connections-servers')!.visible).toBe(false)
    expect(admin.find(section => section.id === 'workspace-danger')!.visible).toBe(false)
    expect(admin.find(section => section.id === 'workspace-team')!.visible).toBe(true)
  })
})

describe('placement validation rejects a control without a home', () => {
  const fixture = (sections: string, page: string, settings = 'theme') => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-settings-contract-'))
    mkdirSync(join(root, 'src/renderer/src/components'), { recursive: true })
    mkdirSync(join(root, 'src/shared'), { recursive: true })
    writeFileSync(join(root, 'src/renderer/src/settings-structure.ts'), [
      'export function settingsStructure() {',
      '  return [',
      sections,
      '  ] as const',
      '}',
      'const tabSections: Readonly<Record<string, readonly SettingsSectionId[]>> = {',
      '  geral: [\'app-appearance\']',
      '}',
      ''
    ].join('\n'))
    writeFileSync(join(root, 'src/renderer/src/components/Pages.tsx'), page)
    writeFileSync(join(root, 'src/shared/types.ts'), `export interface Settings {\n  ${settings}: 'dark'\n}\n`)
    try {
      return inspectSettingsPlacement(root)
    } finally {
      expect(resolve(root).startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('tucano-settings-contract-')).toBe(true)
      rmSync(root, { recursive: true, force: true })
    }
  }
  const section = (id: string, keys: string) => `    { id: '${id}', page: 'geral', label: 'Appearance', keys: [${keys}], scope: 'personal', visible: true },`

  it('accepts a declared section with its card on the page', () => {
    const result = fixture(section('app-appearance', "'theme'"), 'const a = <Card section="app-appearance" />')
    expect(result.passed).toBe(true)
  })

  it('rejects a section whose card never renders', () => {
    const result = fixture(section('app-appearance', "'theme'"), 'const a = <p>nothing</p>')
    expect(result.passed).toBe(false)
    expect(result.failures).toContain('Section declares no rendered card: app-appearance')
  })

  it('rejects a card that belongs to no section, and a key owned twice', () => {
    const orphan = fixture(section('app-appearance', "'theme'"), 'const a = <Card section="app-appearance" />\nconst b = <Card section="app-typo" />')
    expect(orphan.failures).toContain('app-typo is rendered without a declared home: missing')
    const duplicate = fixture(section('app-appearance', "'theme'") + '\n' + section('app-other', "'theme'"), 'const a = <Card section="app-appearance" />\nconst b = <Card section="app-other" />')
    expect(duplicate.failures).toContain('theme is owned by both app-appearance and app-other')
  })

  it('rejects a section the tab bar never lists, and a key Settings does not have', () => {
    const unlisted = fixture(section('app-missing', "'theme'"), 'const a = <Card section="app-appearance" />\nconst b = <Card section="app-missing" />')
    expect(unlisted.failures).toContain('Section has no tab in tabSections: app-missing')
    const unknown = fixture(section('app-appearance', "'breakingBad'"), 'const a = <Card section="app-appearance" />')
    expect(unknown.failures).toContain('app-appearance owns breakingBad, which Settings does not declare')
  })
})
