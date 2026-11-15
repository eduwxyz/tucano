// The files of WhatsApp messages, kept under <data folder>/whatsapp-media/<number id>/. Every name
// is made here from the message's id, never taken from the other side, and nothing outside this
// folder is ever read or deleted through these functions. Nothing here throws at a caller for a
// failed conversion: that is an `undefined`.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { MEDIA_IN_MAX, MEDIA_NUMBER_MAX } from '../../shared/whatsapp'
import { findOnPath, spawnable } from '../platform'

const WAV_TIMEOUT_MS = 60_000
const WAV_MAX = 30 * 1024 * 1024 // 16 kHz mono PCM16 is 32 KB a second: 15 minutes of it is about 29 MB, the most the transcriber takes

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/zip': 'zip',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
}

// The other way round, for a file an agent sends: its name says what it is.
const MIME_BY_EXT: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT_BY_MIME).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg',
  opus: 'audio/ogg',
  oga: 'audio/ogg',
  htm: 'text/html',
  html: 'text/html'
}

const safe = (v: string): string => v.replace(/[^A-Za-z0-9_-]/g, '_')

// What kind of WhatsApp message a file goes as.
export function kindOf(mime: string): 'image' | 'audio' | 'video' | 'document' {
  const m = mime.toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('video/')) return 'video'
  return 'document'
}

// The extension (no dot) a saved file gets: from its type when known, else from its name when that looks like one.
export function extOf(mime: string, fileName?: string): string {
  const bare = (mime.split(';')[0] ?? '').trim().toLowerCase()
  const byMime = EXT_BY_MIME[bare]
  if (byMime) return byMime
  const named = /\.([A-Za-z0-9]{1,8})$/.exec(fileName ?? '')?.[1]?.toLowerCase()
  return named ?? 'bin'
}

// The type of a file by its name; unknown names go as plain bytes.
export function mimeOfFile(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase()
  return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream'
}

export class WhatsAppMedia {
  private root: string
  private used = new Map<string, number>() // bytes kept per number's folder, as far as this run knows: `trim` reads the real figure
  private trimming = new Map<string, boolean>() // folders being read now; true when a file arrived meanwhile

  constructor(dataDir: string, private limit = MEDIA_NUMBER_MAX) {
    this.root = resolve(dataDir, 'whatsapp-media')
  }

  // A path that stays inside the folder, whatever string it is given: undefined for anything else.
  private inside(rel: string): string | undefined {
    if (!rel || rel.includes('\0')) return undefined
    const full = resolve(this.root, rel)
    const r = relative(this.root, full)
    return r && !r.startsWith('..') && !isAbsolute(r) ? full : undefined
  }

  // Saves a file and returns its path inside the media folder. The name is the message id made safe
  // (plus a short hash when making it safe changed it, so two ids never share a file). With the chat given, the
  // chat's hash comes first: the sender picks the id, so the same id in two chats of one number is two files.
  async save(numberId: string, messageId: string, data: Buffer, mime: string, fileName?: string, chat?: string): Promise<string> {
    const base = safe(messageId).slice(0, 80) || 'file'
    const unique = base === messageId ? base : `${base}-${createHash('sha1').update(messageId).digest('hex').slice(0, 8)}`
    const inChat = chat ? `${createHash('sha256').update(chat).digest('hex').slice(0, 8)}-` : ''
    const rel = `${safe(numberId).slice(0, 80) || 'number'}/${inChat}${unique}.${extOf(mime, fileName)}`
    const full = this.inside(rel)
    if (!full) throw new UserError(L('Não consegui guardar esse arquivo.', "I couldn't keep that file."))
    try {
      await mkdir(join(full, '..'), { recursive: true, mode: 0o700 })
      await writeFile(full, data, { mode: 0o600 })
      await chmod(full, 0o600).catch(() => {}) // a file that already existed keeps its old mode otherwise
      await this.count(join(full, '..'), data.length)
    } catch (e) {
      console.error('[whatsapp]', e instanceof Error ? e.message : e)
      throw new UserError(L('Não consegui guardar esse arquivo no computador.', "I couldn't save that file on this computer."))
    }
    return rel
  }

  // A number's files never pass the limit (MEDIA_NUMBER_MAX): past it the oldest go until a fifth of the room is free again, so
  // a number that gets files all day can't fill the disk. A message whose file went says so when someone asks for it.
  private async count(dir: string, added: number): Promise<void> {
    const known = this.used.get(dir)
    if (known !== undefined && known + added <= this.limit) {
      this.used.set(dir, known + added)
      return
    }
    if (this.trimming.has(dir)) {
      this.trimming.set(dir, true)
      return
    }
    this.trimming.set(dir, false)
    try {
      const files: { path: string; size: number; at: number }[] = []
      for (const name of await readdir(dir)) {
        const path = join(dir, name)
        const s = await stat(path).catch(() => undefined)
        if (s?.isFile()) files.push({ path, size: s.size, at: s.mtimeMs })
      }
      let total = files.reduce((sum, f) => sum + f.size, 0)
      if (total > this.limit) {
        for (const f of files.sort((a, b) => a.at - b.at)) {
          if (total <= this.limit * 0.8) break
          await unlink(f.path).catch(() => {})
          total -= f.size
        }
      }
      // A file that arrived during the reading isn't in this figure: the next save reads the folder again.
      if (this.trimming.get(dir)) this.used.delete(dir)
      else this.used.set(dir, total)
    } catch (e) {
      console.error('[whatsapp]', e instanceof Error ? e.message : e) // the file itself was saved: counting it is what failed
    } finally {
      this.trimming.delete(dir)
    }
  }

  // The bytes of a saved file. Refuses a path that leads outside the folder (also through a link).
  async read(rel: string): Promise<Buffer> {
    const full = this.inside(rel)
    const gone = new UserError(L('Esse arquivo não está mais guardado no computador.', 'That file is no longer kept on this computer.'))
    if (!full) throw gone
    try {
      const [real, root] = await Promise.all([realpath(full), realpath(this.root)])
      const r = relative(root, real)
      if (!r || r.startsWith('..') || isAbsolute(r)) throw gone
      if ((await stat(real)).size > MEDIA_IN_MAX) throw gone
      return await readFile(real)
    } catch (e) {
      throw e instanceof UserError ? e : gone
    }
  }

  // Deletes files; one that is already gone, or a path outside the folder, is skipped.
  async remove(rels: readonly string[]): Promise<void> {
    for (const rel of rels) {
      const full = this.inside(rel)
      if (full) await unlink(full).catch(() => {})
    }
  }

  async removeNumber(numberId: string): Promise<void> {
    const full = this.inside(safe(numberId).slice(0, 80) || 'number')
    if (!full) return
    await rm(full, { recursive: true, force: true }).catch(() => {})
    this.used.delete(full)
  }
}

// ffmpeg writes a WAV to a pipe without knowing its length, so both sizes in the header are left as
// "unknown". Readers that trust the header need the real ones.
function fixWavHeader(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return wav
  wav.writeUInt32LE(Math.min(wav.length - 8, 0xffffffff), 4)
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = wav.toString('ascii', at, at + 4)
    if (id === 'data') {
      wav.writeUInt32LE(wav.length - at - 8, at + 4)
      break
    }
    at += 8 + wav.readUInt32LE(at + 4) + (wav.readUInt32LE(at + 4) % 2)
  }
  return wav
}

// 16 kHz mono PCM16 WAV (what dictation takes) from any audio, through the ffmpeg found on PATH.
// undefined when ffmpeg is not installed, the audio can't be read or it takes too long.
export function toWav(data: Buffer): Promise<Buffer | undefined> {
  return new Promise((resolveWav) => {
    let done = false
    const finish = (out: Buffer | undefined): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolveWav(out)
    }
    const bin = findOnPath('ffmpeg')
    const timer = setTimeout(() => {
      child?.kill()
      finish(undefined)
    }, WAV_TIMEOUT_MS)
    timer.unref()
    let child: ReturnType<typeof spawn> | undefined
    if (!bin || data.length === 0) return finish(undefined)
    try {
      // The bytes come from strangers: ffmpeg may read only the pipe, never a file or an address the audio names. Output is capped at 15 minutes.
      const run = spawnable(bin, ['-v', 'error', '-nostdin', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-t', '900', '-f', 'wav', 'pipe:1'])
      child = spawn(run.file, run.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, windowsVerbatimArguments: run.verbatim })
      const parts: Buffer[] = []
      let size = 0
      child.stdout?.on('data', (chunk: Buffer) => {
        if (size > WAV_MAX) return // over the cap already: what is left of the output is not read
        size += chunk.length
        if (size > WAV_MAX) {
          child?.stdout?.destroy() // stop reading, and ffmpeg is killed too
          child?.kill()
          finish(undefined)
          return
        }
        parts.push(chunk)
      })
      child.on('error', () => finish(undefined))
      child.on('close', (code) => finish(code === 0 && size > 44 ? fixWavHeader(Buffer.concat(parts)) : undefined))
      // ffmpeg may stop reading early (a broken file): that closes the pipe, which is not our error.
      child.stdin?.on('error', () => {})
      child.stdin?.end(data)
    } catch {
      finish(undefined)
    }
  })
}
