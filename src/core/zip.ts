// Reads a .zip without a library: the central directory for the list, then only the entries asked for,
// stored or deflated. Nothing is written to disk (extractZip, below, is the one that does). Each entry has a cap, checked before inflating, so a
// small file that claims to unpack into gigabytes is refused. No ZIP64 (files over 4 GB), no encryption.
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { L } from '../shared/lang'

export interface ZipEntry {
  name: string
  size: number // uncompressed
  compressed: number
  method: number // 0 stored, 8 deflate
  offset: number // of its local header
}

export interface Zip {
  entries: Map<string, ZipEntry>
  // The entry's bytes; undefined when it isn't there. Throws over `max` bytes.
  read(name: string, max: number): Buffer | undefined
  close(): void
}

type At = (offset: number, length: number) => Buffer

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const MAX_ENTRIES = 100_000

const broken = (): Error => new Error(L('Esse arquivo .zip está corrompido ou não é um .zip.', "That .zip file is corrupted or isn't a .zip."))

function open(size: number, at: At, close: () => void): Zip {
  // The end record is in the last 22 bytes, or before a comment of up to 64 KB.
  const tail = Math.min(size, 22 + 0xffff)
  const end = at(size - tail, tail)
  let e = -1
  for (let i = end.length - 22; i >= 0; i--) if (end.readUInt32LE(i) === EOCD) { e = i; break }
  if (e < 0) throw broken()
  const count = end.readUInt16LE(e + 10)
  const dirSize = end.readUInt32LE(e + 12)
  const dirOffset = end.readUInt32LE(e + 16)
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error(L('Esse .zip é grande demais (ZIP64), e o Tucano ainda não lê esse tipo.', "That .zip is too big (ZIP64), and Tucano doesn't read that kind yet."))
  if (count > MAX_ENTRIES || dirOffset + dirSize > size) throw broken()
  const dir = at(dirOffset, dirSize)
  const entries = new Map<string, ZipEntry>()
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || dir.readUInt32LE(p) !== CENTRAL) throw broken()
    const flags = dir.readUInt16LE(p + 8)
    const method = dir.readUInt16LE(p + 10)
    const compressed = dir.readUInt32LE(p + 20)
    const usize = dir.readUInt32LE(p + 24)
    const nameLen = dir.readUInt16LE(p + 28)
    const extraLen = dir.readUInt16LE(p + 30)
    const commentLen = dir.readUInt16LE(p + 32)
    const offset = dir.readUInt32LE(p + 42)
    const name = dir.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1')
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1) continue // encrypted: never read
    if (!name.endsWith('/')) entries.set(name, { name, size: usize, compressed, method, offset })
  }
  return {
    entries,
    read(name, max) {
      const z = entries.get(name)
      if (!z) return undefined
      if (z.size > max) throw new Error(L(`"${name}" passa do tamanho que o Tucano lê.`, `"${name}" is over the size Tucano reads.`))
      const head = at(z.offset, 30)
      if (head.readUInt32LE(0) !== LOCAL) throw broken()
      const start = z.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
      if (start + z.compressed > size) throw broken()
      const raw = at(start, z.compressed)
      if (z.method === 0) return raw
      if (z.method !== 8) throw new Error(L(`"${name}" usa uma compressão que o Tucano não lê.`, `"${name}" uses a compression Tucano doesn't read.`))
      try {
        return inflateRawSync(raw, { maxOutputLength: Math.max(1, z.size) })
      } catch {
        throw broken()
      }
    },
    close
  }
}

export function zipFromBuffer(buf: Buffer): Zip {
  return open(buf.length, (o, n) => buf.subarray(o, o + n), () => {})
}

// Reads only the parts it needs, so a big export (with the agents' files) isn't loaded whole.
export function zipFromFile(path: string): Zip {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const at: At = (o, n) => {
      const b = Buffer.alloc(n)
      let got = 0
      while (got < n) {
        const r = readSync(fd, b, got, n - got, o + got)
        if (r === 0) break
        got += r
      }
      return b.subarray(0, got)
    }
    return open(size, at, () => closeSync(fd))
  } catch (e) {
    closeSync(fd)
    throw e
  }
}

// A whole .zip into a folder (a vault sent from another computer): only plain relative paths
// (never absolute, never "..", never macOS's __MACOSX copies), each file and the total capped.
// A single folder at the top, as zipping a folder makes, becomes the root. Returns that root.
export function extractZip(zip: Zip, to: string, caps = { file: 50 * 1024 * 1024, total: 1024 * 1024 * 1024 }): string {
  let total = 0
  const tops = new Set<string>()
  for (const e of zip.entries.values()) {
    const name = e.name.replace(/\\/g, '/')
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue
    const parts = name.split('/')
    if (isAbsolute(name) || /^[A-Za-z]:/.test(name) || parts.some((p) => p === '..' || p === '')) throw new Error(L(`O .zip tem um caminho que não pode: ${name}`, `The .zip has a path it can't: ${name}`))
    total += e.size
    if (total > caps.total) throw new Error(L('O .zip é grande demais (mais de 1 GB descompactado).', 'The .zip is too big (over 1 GB unpacked).'))
    const data = zip.read(e.name, caps.file)
    if (!data) continue
    const file = join(to, ...parts)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, data)
    tops.add(parts.length > 1 ? parts[0]! : '')
  }
  return tops.size === 1 && !tops.has('') ? join(to, [...tops][0]!) : to
}
