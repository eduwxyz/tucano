import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { Workspaces, workspaceId } from '../src/main/workspaces'
import { suggestWorkspaceCopyName, workspaceCreatedAt } from '../src/shared/workspaces'

const dirs: string[] = []
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'tucano-workspaces-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('suggests the current name with the next available duplicate count', () => {
  expect(suggestWorkspaceCopyName('Company', ['Company'])).toBe('Company (2)')
  expect(suggestWorkspaceCopyName('Company', ['Company', 'Company (2)', 'Company (3)'])).toBe('Company (4)')
  expect(suggestWorkspaceCopyName('Company', ['Company', 'Company (3)'])).toBe('Company (2)')
  expect(suggestWorkspaceCopyName('A'.repeat(120), [])).toHaveLength(120)
})

it('uses unique UUIDv7 identities', () => {
  const ids = Array.from({ length: 1000 }, workspaceId)
  expect(new Set(ids).size).toBe(ids.length)
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  const before = Date.now()
  expect(workspaceCreatedAt(workspaceId())).toBeGreaterThanOrEqual(before) // the time in it, to the millisecond
  expect(workspaceCreatedAt(workspaceId())).toBeLessThanOrEqual(Date.now())
})

it('persists one app theme across workspace selection, creation and removal', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  // Older registries can adopt the default workspace's theme on first start.
  expect(registry.theme()).toBeUndefined()
  registry.setTheme('dark')
  const workspace = registry.create()
  registry.select(workspace.id)
  expect(new Workspaces(dir).theme()).toBe('dark')
  registry.setTheme('light')
  registry.deleteData(workspace.id)
  expect(new Workspaces(dir).theme()).toBe('light')
  registry.setTheme('system')
  expect(new Workspaces(dir).theme()).toBe('system')
})

it('adopts the existing folder without moving its data and persists selection', () => {
  const dir = root()
  writeFileSync(join(dir, 'tucano.db'), 'existing data')
  const registry = new Workspaces(dir)
  const original = registry.selected()
  const a = registry.create()
  const b = registry.create()
  registry.select(a.id)
  registry.rename(a.id, 'Company')
  const loaded = new Workspaces(dir)
  expect(loaded.selected()).toEqual({ ...a, name: 'Company' })
  expect(loaded.get(original.id).dataDir).toBe(realpathSync(dir))
  expect(readFileSync(join(dir, 'tucano.db'), 'utf8')).toBe('existing data')
  expect(a.dataDir).toBe(join(realpathSync(dir), 'workspaces', a.id))
  expect(new Set(loaded.list().flatMap((w) => [w.gitPort, w.webhookPort])).size).toBe(6)
  expect(b.isDefault).toBe(false)
  expect(() => registry.select('../outside')).toThrow('Workspace not found')
})

it.skipIf(process.platform === 'win32')('adopts a symlinked root using canonical paths without moving its data', () => {
  const dir = root()
  const alias = join(root(), 'alias')
  symlinkSync(dir, alias)
  writeFileSync(join(alias, 'tucano.db'), 'existing data')
  const registry = new Workspaces(alias)
  const original = registry.selected()
  const workspace = registry.create()
  registry.select(workspace.id)
  const loaded = new Workspaces(alias)
  expect(loaded.get(original.id).dataDir).toBe(realpathSync(dir))
  expect(loaded.selected()).toEqual(workspace)
  expect(workspace.dataDir).toBe(join(realpathSync(dir), 'workspaces', workspace.id))
  expect(new Workspaces(dir).list()).toEqual(loaded.list())
  expect(readFileSync(join(alias, 'tucano.db'), 'utf8')).toBe('existing data')
})

it('refuses invalid registries without overwriting them', () => {
  const dir = root()
  new Workspaces(dir)
  const file = join(dir, 'workspaces.json')
  const good = JSON.parse(readFileSync(file, 'utf8'))
  for (const mutate of [
    (s: typeof good) => { s.version = 2 },
    (s: typeof good) => { s.theme = 'invalid' },
    (s: typeof good) => { s.workspaces[0].dataDir = '/' },
    (s: typeof good) => { s.workspaces[0].gitPort = s.workspaces[0].webhookPort },
    (s: typeof good) => { s.selected = workspaceId() }
  ]) {
    const bad = structuredClone(good)
    mutate(bad)
    const text = JSON.stringify(bad)
    writeFileSync(file, text)
    expect(() => new Workspaces(dir)).toThrow()
    expect(readFileSync(file, 'utf8')).toBe(text)
  }
})

it.skipIf(process.platform === 'win32')('rejects a managed workspace aliased to another folder', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  const a = registry.create()
  mkdirSync(join(dir, 'workspaces'))
  symlinkSync(root(), a.dataDir)
  expect(() => new Workspaces(dir)).toThrow('Invalid workspaces.json')
})

it('deletes only non-default data and protects the default and sibling workspaces', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  const original = registry.selected()
  const a = registry.create()
  const b = registry.create()
  for (const w of [original, a, b]) {
    mkdirSync(w.dataDir, { recursive: true })
    writeFileSync(join(w.dataDir, 'tucano.db'), w.id)
  }
  const external = root()
  writeFileSync(join(external, 'project.txt'), 'keep me')
  writeFileSync(join(dir, 'application-metadata'), 'keep this too')
  registry.select(a.id)
  registry.deleteData(a.id)
  expect(existsSync(a.dataDir)).toBe(false)
  expect(() => registry.get(a.id)).toThrow()
  const before = readFileSync(join(dir, 'workspaces.json'), 'utf8')
  expect(() => registry.deleteData(original.id)).toThrow('default workspace cannot be deleted')
  expect(readFileSync(join(dir, 'workspaces.json'), 'utf8')).toBe(before)
  expect(readFileSync(join(b.dataDir, 'tucano.db'), 'utf8')).toBe(b.id)
  expect(readFileSync(join(dir, 'tucano.db'), 'utf8')).toBe(original.id)
  expect(readFileSync(join(dir, 'application-metadata'), 'utf8')).toBe('keep this too')
  expect(readFileSync(join(external, 'project.txt'), 'utf8')).toBe('keep me')
  const loaded = new Workspaces(dir)
  expect(loaded.list()).toHaveLength(2)
  expect(loaded.list().find((w) => w.isDefault)?.id).toBe(original.id)
  expect(loaded.get(b.id)).toEqual(b)
})

it('refuses to delete the only workspace and keeps its identity and selection', () => {
  const registry = new Workspaces(root())
  const old = registry.selected()
  expect(() => registry.deleteData(old.id)).toThrow('default workspace cannot be deleted')
  expect(registry.list()).toHaveLength(1)
  expect(registry.selected().id).toBe(old.id)
  expect(registry.selected().dataDir).toBe(old.dataDir)
})

it.skipIf(process.platform === 'win32')('rejects a symlinked workspace parent before creating folders outside the root', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  symlinkSync(root(), join(dir, 'workspaces'))
  expect(() => registry.create()).toThrow('Invalid workspaces.json')
})
