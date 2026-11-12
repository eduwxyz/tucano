// Writes a .zip that zip.ts reads back: each entry stored or deflated, whole in memory one at a time,
// with the sizes and CRC in its local header. No ZIP64: the whole file stays under 4 GB.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'

const LIMIT = 0xffffffff

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

interface Written {
  name: Buffer
  crc: number
  size: number
  compressed: number
  method: number
  offset: number
}

export class ZipWriter {
  private fd: number
  private at = 0
  private written: Written[] = []

  constructor(path: string) {
    this.fd = openSync(path, 'w', 0o600)
  }

  // Bytes so far: what the next entry would start at.
  get size(): number {
    return this.at
  }

  private write(b: Buffer): void {
    writeSync(this.fd, b, 0, b.length, this.at)
    this.at += b.length
  }

  addFile(name: string, path: string, compress = true): void {
    this.add(name, readFileSync(path), compress)
  }

  add(name: string, data: Buffer, compress = true): void {
    const deflated = compress ? deflateRawSync(data) : undefined
    // Deflating what's already packed (a picture, a video) can grow it: those go stored.
    const method = deflated && deflated.length < data.length ? 8 : 0
    const body = method === 8 ? deflated! : data
    const nameBytes = Buffer.from(name, 'utf8')
    if (this.at + 30 + nameBytes.length + body.length + 46 + nameBytes.length + 22 > LIMIT) throw new Error('zip too big')
    const crc = crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4) // version needed
    head.writeUInt16LE(0x800, 6) // the name is UTF-8
    head.writeUInt16LE(method, 8)
    head.writeUInt32LE(0, 10) // time and date: none
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBytes.length, 26)
    head.writeUInt16LE(0, 28)
    const offset = this.at
    this.write(head)
    this.write(nameBytes)
    this.write(body)
    this.written.push({ name: nameBytes, crc, size: data.length, compressed: body.length, method, offset })
  }

  close(): void {
    const start = this.at
    for (const w of this.written) {
      const c = Buffer.alloc(46)
      c.writeUInt32LE(0x02014b50, 0)
      c.writeUInt16LE(20, 4) // made by
      c.writeUInt16LE(20, 6) // needed
      c.writeUInt16LE(0x800, 8)
      c.writeUInt16LE(w.method, 10)
      c.writeUInt32LE(0, 12)
      c.writeUInt32LE(w.crc, 16)
      c.writeUInt32LE(w.compressed, 20)
      c.writeUInt32LE(w.size, 24)
      c.writeUInt16LE(w.name.length, 28)
      c.writeUInt32LE(w.offset, 42)
      this.write(c)
      this.write(w.name)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.written.length, 8)
    end.writeUInt16LE(this.written.length, 10)
    end.writeUInt32LE(this.at - start, 12)
    end.writeUInt32LE(start, 16)
    this.write(end)
    closeSync(this.fd)
  }

  abort(): void {
    closeSync(this.fd)
  }
}
