// Names and paths for Documentos: what a name may be on disk, and the guard that keeps every path
// inside the documents folder.
import { existsSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'
import { UserError } from '../shared/errors'
import { L } from '../shared/lang'
import { clip } from './wiki'

// A name as a file system takes it: one way of writing its letters (NFC), no separators or control
// characters, no leading dots (a hidden file, `..`), trimmed, at most 120 characters. Empty when nothing is left.
export const cleanName = (name: string): string => clip(name.normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '-').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim())

// The same, for a file: its extension kept (cleaned apart so a long name never eats it).
export function cleanFileName(name: string): string {
  const ext = extname(name)
  const base = cleanName(ext ? name.slice(0, -ext.length) : name)
  return base ? `${base}${ext.replace(/[^\p{L}\p{N}.]/gu, '').slice(0, 12)}` : ''
}

// Text that came from a file (a name, a path), cleaned before an agent reads it inside an instruction: no @, quotes,
// backticks, brackets or braces, no line breaks, single spaces, at most `max` characters.
export const plain = (s: string, max: number): string => s.replace(/[@"`<>[\]{}]/g, '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)

// What tells two names apart on a disk that ignores case and accents' spelling (macOS).
export const sameName = (a: string): string => a.normalize('NFC').toLowerCase()
// A name with the accents and case gone, for finding a folder by what someone typed.
export const looseName = (a: string): string => a.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

// `name`, or `name (2)`, `name (3)`… when `taken` says it's in use.
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name
  const ext = extname(name)
  const base = ext ? name.slice(0, -ext.length) : name
  for (let n = 2; ; n++) {
    const next = `${clip(base, 112)} (${n})${ext}`
    if (!taken(next)) return next
  }
}

export const isInside = (root: string, path: string): boolean => {
  const r = resolve(root)
  const p = resolve(path)
  return p === r || p.startsWith(r + sep)
}

// A path under `root`, or an error when the parts lead out of it.
export function safeJoin(root: string, ...parts: string[]): string {
  const p = resolve(join(root, ...parts))
  if (!isInside(root, p) || p === resolve(root)) throw new UserError(L('Esse caminho não vale.', 'That path is not valid.'))
  return p
}

export const takenOnDisk = (dir: string) => (name: string): boolean => existsSync(join(dir, name))
