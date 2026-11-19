// What an agent's browser downloads (spec §24): a folder of its own in the app's data, so a bill it
// fetched can go to the chat (navegador_anexar) and nothing lands in the person's own Downloads.
// Chrome (core/chrome.ts) and the Electron fallback (main/browser.ts) both write into a hidden
// .partial folder first and move the file out only when it's whole: what sits in the folder is done.
// A small log beside the files says where each came from and what was refused (too big), for the
// agent to be told; both processes write it, so it's a file and not a message.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { MAX_FILE_BYTES } from '../shared/types'

export const DOWNLOADS_DIR = 'browser-downloads'
const PARTIAL = '.partial'
const LOG = '.log'

export const downloadsFolder = (dataDir: string, agentId: string): string => join(dataDir, DOWNLOADS_DIR, agentId)
export const partialFolder = (folder: string): string => join(folder, PARTIAL)

export interface Downloaded {
  name: string
  size: number
  at: number
  url?: string // where it came from, without the query (a signed link's token stays out of the chat)
}

type Note = { name: string; size: number; at: number; url?: string; refused?: 'too-big' }

// A name to save under: no folders, nothing hidden, nothing a system refuses, not too long.
export function safeName(suggested: string): string {
  const base = (suggested.split(/[/\\]/).pop() ?? '')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '')
    .replace(/^[.\s]+/, '')
    .trim()
  if (!base) return 'download'
  if (base.length <= 120) return base
  const ext = extname(base).slice(0, 12)
  return base.slice(0, 120 - ext.length) + ext
}

// "fatura.pdf", then "fatura (2).pdf": a second bill never replaces the first.
export function freeName(folder: string, name: string): string {
  if (!existsSync(join(folder, name))) return name
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 2; ; i++) {
    const next = `${stem} (${i})${ext}`
    if (!existsSync(join(folder, next))) return next
  }
}

const bareUrl = (url?: string): string | undefined => {
  if (!url) return undefined
  try {
    const u = new URL(url)
    return u.protocol === 'data:' ? undefined : `${u.origin}${u.pathname}`.slice(0, 300)
  } catch {
    return undefined
  }
}

function note(folder: string, n: Note): void {
  try {
    mkdirSync(folder, { recursive: true })
    appendFileSync(join(folder, LOG), JSON.stringify(n) + '\n')
  } catch {}
}

function notes(folder: string): Note[] {
  try {
    return readFileSync(join(folder, LOG), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Note)
  } catch {
    return []
  }
}

// A download that grew past the limit: cancelled by the browser, said to the agent.
export function refuse(folder: string, suggested: string, size: number): void {
  note(folder, { name: safeName(suggested), size, at: Date.now(), refused: 'too-big' })
}

// A finished download, moved from .partial into the folder under its own name (or refused, too big).
export function land(folder: string, from: string, suggested: string, url?: string, cap = MAX_FILE_BYTES): Downloaded | { refused: 'too-big'; name: string; size: number } {
  const name = safeName(suggested)
  let size = 0
  try {
    size = statSync(from).size
  } catch {}
  if (size > cap) {
    rmSync(from, { force: true })
    refuse(folder, name, size)
    return { refused: 'too-big', name, size }
  }
  mkdirSync(folder, { recursive: true })
  const final = freeName(folder, name)
  renameSync(from, join(folder, final))
  const done: Downloaded = { name: final, size, at: Date.now(), ...(bareUrl(url) ? { url: bareUrl(url) } : {}) }
  note(folder, done)
  return done
}

// What's in the folder, newest first: plain files only, never a link out of it.
export function listDownloads(folder: string): Downloaded[] {
  let entries: string[]
  try {
    entries = readdirSync(folder)
  } catch {
    return []
  }
  const from = new Map(notes(folder).filter((n) => !n.refused && n.url).map((n) => [n.name, n.url]))
  const out: Downloaded[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    try {
      const s = lstatSync(join(folder, name))
      if (s.isFile()) out.push({ name, size: s.size, at: s.mtimeMs, ...(from.get(name) ? { url: from.get(name) } : {}) })
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at)
}

// Downloads still under way.
export function pendingDownloads(folder: string): number {
  try {
    return readdirSync(partialFolder(folder)).length
  } catch {
    return 0
  }
}

// What landed or was refused since a moment: what the agent's last action downloaded.
export function downloadsSince(folder: string, since: number): Note[] {
  return notes(folder).filter((n) => n.at >= since)
}

// A file of this folder by its name as listed, or why not: only a plain file right in it, never a
// path, a hidden file, a link or anything outside (no ../, no symlink to elsewhere), and not too big.
export function downloaded(folder: string, name: string, cap = MAX_FILE_BYTES): { path: string; size: number } | { error: 'missing' | 'outside' | 'too-big' } {
  if (!name || name !== basename(name) || /[/\\]/.test(name) || name.startsWith('.') || name.includes('\0')) return { error: 'outside' }
  const path = join(folder, name)
  try {
    const s = lstatSync(path)
    if (!s.isFile()) return { error: s.isSymbolicLink() ? 'outside' : 'missing' }
    if (dirname(realpathSync(path)) !== realpathSync(folder)) return { error: 'outside' }
    if (s.size > cap) return { error: 'too-big' }
    return { path, size: s.size }
  } catch {
    return { error: 'missing' }
  }
}
