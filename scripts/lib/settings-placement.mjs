import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

// A settings control's home is declared once, in settings-structure.ts: the section it belongs to,
// the keys that section owns, and the tab whose strip lists it. This checks that declaration against
// what the page renders, so a control cannot be written in a card that claims another section, a
// section cannot lose its card without a word, and two sections cannot own the same key. It reads
// literal text, so a control built at runtime still needs the review the docs describe.
export function inspectSettingsPlacement(workspace) {
  const root = resolve(workspace)
  const structurePath = join(root, 'src/renderer/src/settings-structure.ts')
  const pagePath = join(root, 'src/renderer/src/components/Pages.tsx')
  const typesPath = join(root, 'src/shared/types.ts')
  for (const file of [structurePath, pagePath, typesPath]) {
    if (!existsSync(file)) throw new Error(`Missing ${file}`)
  }
  const source = readFileSync(structurePath, 'utf8')
  const page = readFileSync(pagePath, 'utf8')
  const failures = []

  // One section per line, as the module declares them.
  const sections = []
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s*\{ id: '([a-z0-9-]+)', page: '([a-z]+)', .*keys: \[(.*?)\], scope: '([a-z]+)', visible: (true|false|.+?) \},?$/.exec(line)
    if (!match) continue
    const keys = match[3].trim() === '' ? [] : match[3].split(',').map(part => part.trim().replace(/^'|'$/g, ''))
    sections.push({ id: match[1], page: match[2], keys, scope: match[4] })
  }
  if (sections.length === 0) throw new Error('settings-structure.ts declares no sections in the checked shape')

  // The tab bar's own order, as the module maps it.
  const tabBlock = /const tabSections: Readonly<Record<string, readonly SettingsSectionId\[\]>> = \{([\s\S]*?)\n\}/.exec(source)
  if (!tabBlock) throw new Error('settings-structure.ts must declare tabSections')
  const tabs = new Map()
  for (const line of tabBlock[1].split(/\r?\n/)) {
    const match = /^\s*([a-z]+): \[(.*?)\],?$/.exec(line)
    if (!match) continue
    tabs.set(match[1], match[2].trim() === '' ? [] : [...match[2].matchAll(/'([a-z0-9-]+)'/g)].map(item => item[1]))
  }

  // What the page draws: a card's own `section` and the anchors a part of the page carries.
  const drawn = new Map()
  for (const match of page.matchAll(/section="([a-z0-9-]+)"/g)) drawn.set(match[1], (drawn.get(match[1]) ?? 0) + 1)
  for (const match of page.matchAll(/<SectionAnchor id="([a-z0-9-]+)"/g)) drawn.set(match[1], (drawn.get(match[1]) ?? 0) + 1)

  const owners = new Map()
  const declared = new Set()
  const listed = new Set()
  for (const section of sections) {
    if (declared.has(section.id)) failures.push(`Duplicate section: ${section.id}`)
    declared.add(section.id)
    for (const key of section.keys) {
      if (owners.has(key)) failures.push(`${key} is owned by both ${owners.get(key)} and ${section.id}`)
      owners.set(key, section.id)
    }
  }
  for (const [tab, ids] of tabs) {
    for (const id of ids) {
      if (!declared.has(id)) failures.push(`${tab} lists ${id}, which no section declares`)
      if (listed.has(id)) failures.push(`${id} is listed by ${tab} and by another tab`)
      listed.add(id)
    }
  }
  for (const section of sections) {
    if (!listed.has(section.id)) failures.push(`Section has no tab in tabSections: ${section.id}`)
    if (!drawn.has(section.id)) failures.push(`Section declares no rendered card: ${section.id}`)
  }
  for (const id of drawn.keys()) {
    if (!declared.has(id)) failures.push(`${id} is rendered without a declared home: missing`)
  }

  // Every owned key has to exist, or the declaration has already outlived the setting.
  const types = readFileSync(typesPath, 'utf8')
  const block = /export interface Settings \{([\s\S]*?)\n\}/.exec(types)
  if (!block) throw new Error('src/shared/types.ts must declare Settings')
  const known = new Set([...block[1].matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(match => match[1]))
  for (const [key, section] of owners) {
    if (!known.has(key)) failures.push(`${section} owns ${key}, which Settings does not declare`)
  }

  return {
    sections: sections.length,
    ownedKeys: owners.size,
    renderedSections: drawn.size,
    tabs: tabs.size,
    failures,
    passed: failures.length === 0
  }
}
