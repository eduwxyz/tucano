// What a path cited by an agent may do when clicked. The message only suggests it: here it has to
// exist and be within this agent's reach, and nothing here ever runs what it finds.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, sep } from 'node:path'
import type { LocalInfo } from '../shared/types'

const IMAGES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']
const VIDEOS = ['.mp4', '.webm', '.mov', '.m4v']
// Folders that hold keys and credentials: never reached by name, wherever they are (also a node's file tools).
export const NEVER = new Set(['.ssh', '.aws', '.gnupg', '.kube', 'Keychains'])

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep)
// The native call, so the name comes back as it is on disk: on a Mac "~/.SSH" is "~/.ssh", and
// the checks below compare names.
const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

export interface LocalReach {
  agentId: string
  own: string // the agent's folder
  limited: boolean // only its own files: an agent on this Mac isn't
  dataRoot: string // the app's data: other agents' files, the database
  tmp?: string[] // where a harness keeps its scratchpad
}

// Only an agent on this computer reaches what its commands do: with no computer or on Linux, its own files.
export const isLimited = (agent: { computer?: boolean; computerKind?: string }): boolean => !(agent.computer && agent.computerKind === 'mac')

// The harness's own scratch folder for this agent, which carries the agent's id in its name.
const isScratch = (path: string, agentId: string, tmp: string[]): boolean =>
  tmp.some((t) => inside(path, t)) && new RegExp(`(^|[-/\\\\])agents-${agentId.replace(/[^\w-]/g, '')}([/\\\\]|$)`).test(path)

export function resolveLocal(raw: string, reach: LocalReach, home = homedir()): { path: string; kind: LocalInfo['kind'] } | null {
  const asked = raw === '~' || raw.startsWith('~/') ? join(home, raw.slice(2)) : raw
  if (!isAbsolute(asked) || asked.includes('\0')) return null
  let path: string
  let isFolder: boolean
  try {
    path = realpathSync.native(asked)
    isFolder = statSync(path).isDirectory()
  } catch {
    return null
  }
  if (path.split(sep).some((part) => NEVER.has(part))) return null
  const own = inside(path, real(reach.own))
  const scratch = isScratch(path, reach.agentId, reach.tmp ?? ['/private/tmp', '/tmp', real(tmpdir())])
  if (!own && !scratch) {
    if (inside(path, real(reach.dataRoot))) return null
    if (reach.limited) return null
  }
  const ext = extname(path).toLowerCase()
  if (isFolder) return { path, kind: ext ? 'file' : 'folder' } // a .app is a folder that would run: it only gets shown
  if (IMAGES.includes(ext)) return { path, kind: 'image' }
  if (VIDEOS.includes(ext)) return { path, kind: 'video' }
  return { path, kind: ext === '.pdf' ? 'pdf' : 'file' }
}

// An address for the window to load a file by. Signed, so the protocol serves only what the core
// has checked, and a page in the window can't ask for anything else. On a server it's signed for
// one person too: an address someone passes on opens nothing for anyone else.
// The signature also carries the file's identity (device and inode): the agent's folder is
// writable from its container, and a name checked now can be a link to the server's key later.
// The two forms (for someone, for the window) are kept apart so neither can stand for the other.
const sign = (key: string, path: string, id: string, person?: string): string =>
  createHmac('sha256', key)
    .update(person === undefined ? `v2|-|${JSON.stringify([id, path])}` : `v2|p|${JSON.stringify([person, id, path])}`)
    .digest('base64url')

// The file a path names right now, without following a link at its end. '-' matches nothing.
export function fileId(path: string): string {
  try {
    const s = lstatSync(path, { bigint: true })
    return s.isFile() ? `${s.dev}-${s.ino}` : '-'
  } catch {
    return '-'
  }
}

// On a desktop the app's tucano: protocol serves it; on a server, its own /local/ path (src/server).
export const localUrl = (key: string, path: string, base = 'tucano://local', person?: string): string => {
  const id = fileId(path)
  return `${base}/${sign(key, path, id, person)}/${Buffer.from(path).toString('base64url')}/${id}${person ? `/${Buffer.from(person).toString('base64url')}` : ''}`
}

export interface SignedLocal {
  path: string
  id: string // device-inode of the file that was checked
  person?: string
}

// The path an address opens and, when it was signed for someone, whom.
export function verifyLocal(key: string, url: URL): SignedLocal | null {
  const [signature = '', encoded = '', id = '', whose = ''] = url.pathname.slice(1).split('/')
  if (!/^(\d+-\d+|-)$/.test(id)) return null
  const path = Buffer.from(encoded, 'base64url').toString()
  const person = whose ? Buffer.from(whose, 'base64url').toString() : undefined
  const want = Buffer.from(sign(key, path, id, person))
  const got = Buffer.from(signature)
  return want.length === got.length && timingSafeEqual(want, got) ? { path, id, ...(person !== undefined ? { person } : {}) } : null
}

export function verifyLocalUrl(key: string, url: URL): SignedLocal | null {
  const v = verifyLocal(key, url)
  return v && v.person === undefined ? v : null
}

// On a server: an address signed for someone opens only for them; an unsigned one, for the owner.
export const signedFor = (signed: SignedLocal, person: string | undefined, owner: boolean): boolean =>
  signed.person !== undefined ? person !== undefined && signed.person === person : owner

// Opens what a signed address names, only if it is still the very file the core checked: no link
// at its end (O_NOFOLLOW), a regular file, the same device and inode. Read through the descriptor,
// so nothing can be swapped in between the check and the read. null: serve nothing (404).
export function openSigned(signed: SignedLocal): { fd: number; size: number } | null {
  // A link anywhere along the way changes the name it resolves to: the core signed a real path.
  if (real(signed.path) !== signed.path) return null
  let fd: number
  try {
    // NONBLOCK: a fifo put in the file's place doesn't hang the open (it fails the checks below).
    fd = openSync(signed.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  } catch {
    return null
  }
  try {
    const s = fstatSync(fd, { bigint: true })
    if (s.isFile() && `${s.dev}-${s.ino}` === signed.id) return { fd, size: Number(s.size) }
  } catch {}
  closeSync(fd)
  return null
}
