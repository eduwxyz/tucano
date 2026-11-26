// A workspace's picture lives in its own registry entry: the same shape for a backup to carry, with
// no way for another workspace to pick it up. The checks here cover the API the window talks to.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { Workspaces, workspaceId } from '../src/main/workspaces'
import { isWorkspacePicture, validateWorkspacePicture } from '../src/shared/workspace-picture'
import { workspaceParts } from '../src/shared/workspaces'

const dirs: string[] = []
const root = (): string => { const dir = mkdtempSync(join(tmpdir(), 'tucano-wpic-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const SVG = 'data:image/svg+xml;base64,PHN2Zy8+'

it('accepts only the picture shapes the connector flow can store, plus safe https addresses', () => {
  for (const value of [PNG, SVG, 'https://example.com/mark.png', 'https://example.com/a?b=1']) expect(isWorkspacePicture(value), value).toBe(true)
  for (const value of [
    '', 'hello', 'data:text/html,<script>', 'data:image/png;base64,not base64!',
    'http://example.com/mark.png', 'javascript:alert(1)', 'file:///etc/passwd',
    'https://user:pass@example.com/mark.png', 'https://localhost/mark.png',
    'https://127.0.0.1/mark.png', 'https://[::1]/mark.png', 'https://10.1.2.3/mark.png',
    'https://169.254.169.254/latest/meta-data', 'https://example.local/mark.png',
    `data:image/png;base64,${'A'.repeat(32_000)}`
  ]) expect(isWorkspacePicture(value), value).toBe(false)
  expect(() => validateWorkspacePicture('')).not.toThrow()
  expect(() => validateWorkspacePicture('http://example.com/mark.png')).toThrow(/https/)
})

it('round trips one workspace picture through the registry on disk', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  const id = registry.selected().id
  expect(registry.picture(id)).toBeUndefined()
  registry.setPicture(id, PNG)
  expect(registry.picture(id)).toBe(PNG)
  expect(registry.list()[0]!.picture).toBe(PNG)
  const reloaded = new Workspaces(dir)
  expect(reloaded.picture(id)).toBe(PNG)
  expect(JSON.parse(readFileSync(join(dir, 'workspaces.json'), 'utf8')).workspaces[0].picture).toBe(PNG)
  reloaded.setPicture(id, 'https://example.com/mark.png')
  expect(new Workspaces(dir).picture(id)).toBe('https://example.com/mark.png')
})

it('keeps a picture to its own workspace, copies it with General on duplicate, and clears it', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  const first = registry.selected().id
  const second = registry.create('Second').id
  registry.setPicture(first, PNG)
  expect(registry.picture(second)).toBeUndefined()
  expect(registry.list().map((w) => w.picture)).toEqual([PNG, undefined])
  // A fresh workspace starts with the default tile. A duplicate carries the picture only with
  // General; without it, or with no source picture, there is nothing to copy.
  const copy = registry.create('Copy')
  expect(copy.picture).toBeUndefined()
  registry.copyPicture(first, copy.id, workspaceParts({ context: true }))
  expect(registry.picture(copy.id)).toBeUndefined()
  registry.copyPicture(first, copy.id, workspaceParts({ general: true }))
  expect(registry.picture(copy.id)).toBe(PNG)
  registry.copyPicture(first, second) // no parts named: the core copies everything
  expect(registry.picture(second)).toBe(PNG)
  expect(new Workspaces(dir).picture(copy.id)).toBe(PNG)
  registry.setPicture(first, '')
  expect(new Workspaces(dir).picture(first)).toBeUndefined()
  expect(new Workspaces(dir).picture(copy.id)).toBe(PNG)
})

it('refuses a bad picture without changing what is stored', () => {
  const dir = root()
  const registry = new Workspaces(dir)
  const id = registry.selected().id
  registry.setPicture(id, PNG)
  for (const bad of ['http://example.com/x.png', 'javascript:alert(1)', 'https://127.0.0.1/x.png', `data:image/png;base64,${'A'.repeat(32_001)}`]) {
    expect(() => registry.setPicture(id, bad)).toThrow()
    expect(registry.picture(id)).toBe(PNG)
  }
  expect(() => registry.setPicture('not-a-workspace', PNG)).toThrow('Workspace not found')
  expect(new Workspaces(dir).picture(id)).toBe(PNG)
})

it('keeps the keyboard focus accent inside the thumbnail so the scrolling list cannot cut it', () => {
  const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
  const rule = css.match(/\.workspace-manager__pic:focus-visible\s*\{[^}]*\}/)?.[0] ?? ''
  expect(rule).toContain('inset 0 0 0 2px var(--accent)')
  expect(rule).toContain('outline: none')
  expect(rule).not.toContain('outline-offset')
  expect(css).toContain('.workspace-manager__pic:focus-visible .workspace-manager__pic-edit')
})

it('fails closed on a registry carrying an unsafe picture', () => {
  const dir = root()
  const id = workspaceId()
  writeFileSync(join(dir, 'workspaces.json'), JSON.stringify({
    version: 1,
    selected: id,
    workspaces: [{ id, name: 'Workspace', dataDir: dir, webhookPort: 47717, gitPort: 47718, isDefault: true, picture: 'javascript:alert(1)' }]
  }))
  expect(() => new Workspaces(dir)).toThrow(/Invalid workspaces.json/)
})
