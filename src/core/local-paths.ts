// What a path cited by an agent may do when clicked. The message only suggests it: here it has to
// exist and be within this agent's reach, and nothing here ever runs what it finds.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, sep } from 'node:path'
import type { LocalInfo } from '../shared/types'

const IMAGES = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp']
const VIDEOS = ['.mp4', '.webm', '.mov', '.m4v']
const NEVER = new Set(['.ssh', '.aws', '.gnupg', '.kube', 'Keychains'])

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
// has checked, and a page in the window can't ask for anything else.
const sign = (key: string, path: string): string => createHmac('sha256', key).update(path).digest('base64url')

// On a desktop the app's tucano: protocol serves it; on a server, its own /local/ path (src/server).
export const localUrl = (key: string, path: string, base = 'tucano://local'): string => `${base}/${sign(key, path)}/${Buffer.from(path).toString('base64url')}`

export function verifyLocalUrl(key: string, url: URL): string | null {
  const [signature = '', encoded = ''] = url.pathname.slice(1).split('/')
  const path = Buffer.from(encoded, 'base64url').toString()
  const want = Buffer.from(sign(key, path))
  const got = Buffer.from(signature)
  return want.length === got.length && timingSafeEqual(want, got) ? path : null
}
