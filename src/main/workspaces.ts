import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isTheme, type Workspace } from '../shared/workspaces'
import type { Settings } from '../shared/types'

const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// RFC 9562: 48 bits of milliseconds, version 7, random payload and RFC variant.
export function workspaceId(): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(Date.now(), 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface Registry {
  version: 1
  theme?: Settings['theme']
  selected: string
  workspaces: Workspace[]
}

export class Workspaces {
  private state: Registry
  readonly root: string
  private file: string

  constructor(root: string, private defaultPorts = { webhookPort: 47717, gitPort: 47718 }) {
    mkdirSync(root, { recursive: true })
    this.root = realpathSync(root)
    this.file = join(this.root, 'workspaces.json')
    if (existsSync(this.file)) {
      const state: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      this.validate(state)
      this.state = state
    } else {
      const id = workspaceId()
      this.state = { version: 1, selected: id, workspaces: [{ id, name: 'Workspace', dataDir: this.root, ...this.defaultPorts, isDefault: true }] }
      this.save(this.state)
    }
  }

  private validate(raw: unknown): asserts raw is Registry {
    const fail = (): never => { throw new Error('Invalid workspaces.json. Your data has not been changed; restore the registry from a backup.') }
    if (!raw || typeof raw !== 'object') fail()
    const r = raw as Registry
    if (r.version !== 1 || !Array.isArray(r.workspaces) || !r.workspaces.length) fail()
    if (r.theme !== undefined && !isTheme(r.theme)) fail()
    const managed = join(this.root, 'workspaces')
    if (existsSync(managed) && realpathSync(managed) !== managed) fail()
    const ids = new Set<string>()
    const ports = new Set<number>()
    for (const w of r.workspaces) {
      if (!w || typeof w.id !== 'string' || !UUID7.test(w.id) || ids.has(w.id) || typeof w.name !== 'string' || !w.name.trim() || typeof w.isDefault !== 'boolean') fail()
      ids.add(w.id)
      const expected = w.isDefault ? this.root : join(this.root, 'workspaces', w.id)
      if (w.dataDir !== expected || (existsSync(expected) && realpathSync(expected) !== expected)) fail()
      for (const port of [w.webhookPort, w.gitPort]) {
        if (!Number.isInteger(port) || port < 1024 || port > 65535 || ports.has(port)) fail()
        ports.add(port)
      }
      if (w.isDefault && (w.webhookPort !== this.defaultPorts.webhookPort || w.gitPort !== this.defaultPorts.gitPort)) fail()
    }
    if (r.workspaces.filter((w) => w.isDefault).length !== 1 || !ids.has(r.selected)) fail()
  }

  private save(next: Registry): void {
    this.validate(next)
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    renameSync(temp, this.file)
    this.state = next
  }

  list(): Workspace[] { return this.state.workspaces.map((w) => ({ ...w })) }
  theme(): Settings['theme'] | undefined { return this.state.theme }
  setTheme(theme: Settings['theme']): void {
    if (theme !== this.state.theme) this.save({ ...this.state, theme })
  }
  selected(): Workspace { return this.get(this.state.selected) }
  get(id: string): Workspace {
    const w = this.state.workspaces.find((w) => w.id === id)
    if (!w) throw new Error('Workspace not found')
    return { ...w }
  }

  create(name = 'Workspace'): Workspace {
    // Names come from the existing onboarding, not another workspace wizard.
    const id = workspaceId()
    const used = new Set(this.list().flatMap((w) => [w.webhookPort, w.gitPort]))
    let port = 47719
    while (used.has(port) || used.has(port + 1)) port += 2
    if (port + 1 > 65535) throw new Error('No workspace ports available')
    const workspace: Workspace = { id, name: name.trim() || 'Workspace', dataDir: join(this.root, 'workspaces', id), webhookPort: port, gitPort: port + 1, isDefault: false }
    this.save({ ...this.state, workspaces: [...this.list(), workspace] })
    return workspace
  }

  select(id: string): void {
    this.get(id)
    this.save({ ...this.state, selected: id })
  }

  rename(id: string, name: string): void {
    const clean = name.trim()
    if (!clean || this.get(id).name === clean) return
    this.save({ ...this.state, workspaces: this.list().map((w) => w.id === id ? { ...w, name: clean } : w) })
  }

  // Main must stop the owning core, processes and browser sessions first.
  deleteData(id: string): void {
    this.validate(this.state)
    const workspace = this.get(id)
    if (workspace.isDefault) throw new Error('The default workspace cannot be deleted')
    rmSync(workspace.dataDir, { recursive: true, force: true })
    const kept = this.list().filter((w) => w.id !== id)
    const selected = this.state.selected === id ? kept[0]!.id : this.state.selected
    this.save({ ...this.state, selected, workspaces: kept })
  }
}
