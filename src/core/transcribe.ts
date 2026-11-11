// Dictation: audio from the window, turned into text on this machine with whisper-cli. The
// program comes inside the app (scripts/whisper.mjs); the model, hundreds of MB, is downloaded
// when the person turns dictation on. One already installed (Homebrew, a path in Settings) is
// used as is. The audio leaves no file behind.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { L } from '../shared/lang'
import type { VoiceModelId, VoiceSettings, VoiceStatus } from '../shared/types'
import { encodeWav } from '../shared/wav'
import { fetchPinned } from './pinned-file'
import { executableNames, isWin, killTree } from './platform'

export const MAX_AUDIO_BASE64 = 30_000_000 // about 15 minutes of 16 kHz mono
const TIMEOUT_MS = 5 * 60_000

// The two the app offers. Pinned by size and SHA-256: a download that doesn't match is thrown away.
export const VOICE_MODELS: Record<VoiceModelId, { file: string; bytes: number; sha256: string }> = {
  recommended: { file: 'ggml-large-v3-turbo-q5_0.bin', bytes: 574_041_195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
  light: { file: 'ggml-small-q5_1.bin', bytes: 190_085_487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' }
}
const MODEL_URL = (file: string): string => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const MODEL_DIRS = (home: string): string[] => [join(home, '.cache', 'whisper-cpp'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp']

export interface VoicePlaces {
  bundled?: string // the folder with the whisper-cli that came with the app
  models: string // where the app keeps the models it downloads: one folder every workspace shares
  legacy?: string // this workspace's own folder, where they went before: one there is still used
}

const findBin = (path: string | undefined, bundled?: string): string | undefined =>
  [...(bundled ? [bundled] : []), ...(path ?? '').split(delimiter).filter(Boolean), ...BIN_DIRS].flatMap((d) => executableNames('whisper-cli').map((name) => join(d, name))).find((f) => existsSync(f))

const modelsIn = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => /^ggml-.*\.bin$/.test(f)).map((f) => join(dir, f))
  } catch {
    return []
  }
}

// The best one there: the app's own first, and turbo before the rest, since it's what's fast enough to dictate with.
function findModel(home: string, own?: string, legacy?: string): string | undefined {
  const mine = [...(own ? modelsIn(own) : []), ...(legacy ? modelsIn(legacy) : [])]
  const all = [...mine, ...MODEL_DIRS(home).flatMap(modelsIn)]
  return all.find((f) => f.includes('turbo')) ?? all.sort().at(-1)
}

// Which of the app's models is downloaded, if any.
export const downloaded = (...dirs: string[]): VoiceModelId[] => (Object.keys(VOICE_MODELS) as VoiceModelId[]).filter((id) => dirs.some((dir) => existsSync(join(dir, VOICE_MODELS[id].file))))

export function voiceStatus(voice: VoiceSettings | undefined, env: NodeJS.ProcessEnv = process.env, home = homedir(), places?: VoicePlaces): VoiceStatus {
  const bin = voice?.bin ? (existsSync(voice.bin) ? voice.bin : undefined) : findBin(env['PATH'] ?? env['Path'], places?.bundled)
  const model = voice?.model ? (existsSync(voice.model) ? voice.model : undefined) : findModel(home, places?.models, places?.legacy)
  const own = places ? [places.models, ...(places.legacy ? [places.legacy] : [])] : []
  const ownModel = (Object.keys(VOICE_MODELS) as VoiceModelId[]).find((id) => own.some((dir) => model === join(dir, VOICE_MODELS[id].file)))
  return { bin, model, ready: !!bin && !!model, ...(ownModel ? { ownModel } : {}), ...(places ? { downloaded: downloaded(...own) } : {}) }
}

// The model, fetched once: to a .part file, hashed on the way, and moved into place only if it's
// the file it should be. One download at a time; a new one replaces what's going on.
export class ModelDownload {
  progress: { model: VoiceModelId; received: number; total: number } | null = null
  error: string | null = null
  private abort: AbortController | null = null

  constructor(
    private dir: string,
    private changed: () => void,
    private fetcher: typeof fetch = fetch,
    private models: Record<VoiceModelId, { file: string; bytes: number; sha256: string }> = VOICE_MODELS, // tests use small ones
    private downloaded: () => void = () => {},
    private legacy?: string
  ) {}

  async start(id: VoiceModelId): Promise<void> {
    const m = this.models[id]
    this.cancel()
    const abort = new AbortController()
    this.abort = abort
    this.error = null
    const progress = { model: id, received: 0, total: m.bytes }
    this.progress = progress
    this.changed()
    let last = 0
    try {
      await fetchPinned(this.fetcher, { url: MODEL_URL(m.file), bytes: m.bytes, sha256: m.sha256 }, join(this.dir, m.file), abort.signal, (n) => {
        progress.received += n
        // a few updates a second are enough for a bar
        if (Date.now() - last > 250) (last = Date.now()), this.changed()
      })
      this.downloaded()
    } catch (e) {
      if (!abort.signal.aborted) this.error = e instanceof Error ? e.message : String(e)
    } finally {
      if (this.abort === abort) {
        this.abort = null
        this.progress = null
      }
      this.changed()
    }
  }

  cancel(): void {
    this.abort?.abort()
  }

  // A model the app downloaded, gone (from the shared folder, and from this workspace's own, where
  // the app used to keep them); one installed some other way isn't the app's to delete.
  remove(id: VoiceModelId): void {
    for (const dir of [this.dir, ...(this.legacy ? [this.legacy] : [])]) rmSync(join(dir, this.models[id].file), { force: true })
    this.changed()
  }
}

// What whisper prints for silence, not words.
const NOT_SPEECH = /^[[(][^\])]*[\])]$/
export const cleanTranscript = (out: string): string =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOT_SPEECH.test(l))
    .join(' ')

// The first run of whisper on a Mac builds its GPU programs, which takes a while (14 s here);
// the system keeps them after that. Done once with a second of silence, right after the model
// arrives, so the person's first dictation is as quick as the rest.
export async function warmUp(transcriber: Transcriber, status: VoiceStatus): Promise<void> {
  if (!status.ready) return
  const silence = Buffer.from(encodeWav(new Float32Array(16_000), 16_000)).toString('base64')
  await transcriber.transcribe(`warm-${Date.now()}`, silence, status, 'en').catch(() => {})
}

export class Transcriber {
  private running = new Map<string, { proc: ChildProcess; cancelled: boolean }>()

  async transcribe(id: string, base64: string, status: VoiceStatus, language: string | undefined): Promise<string> {
    if (!status.bin || !status.model) throw new Error(L('O ditado ainda não está ativado. Veja em Configurações › Modelos › Modelos locais.', "Dictation isn't turned on yet. See Settings › Models › Local models."))
    if (base64.length > MAX_AUDIO_BASE64) throw new Error(L('Esse áudio é longo demais.', 'That recording is too long.'))
    const dir = mkdtempSync(join(tmpdir(), 'tucano-voz-'))
    try {
      const file = join(dir, 'audio.wav')
      writeFileSync(file, Buffer.from(base64, 'base64'), { mode: 0o600 })
      return cleanTranscript(await this.run(id, status.bin, ['-m', status.model, '-f', file, '-nt', '-np', '-l', language ?? 'auto']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  cancel(id: string): void {
    const r = this.running.get(id)
    if (!r) return
    r.cancelled = true
    if (r.proc.pid) killTree(r.proc.pid)
  }

  private run(id: string, bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: !isWin })
      const entry = { proc, cancelled: false }
      this.running.set(id, entry)
      const timer = setTimeout(() => this.cancel(id), TIMEOUT_MS)
      let out = ''
      let err = ''
      proc.stdout.on('data', (d: Buffer) => (out += d.toString()))
      proc.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-500)))
      proc.on('error', (e) => done(e))
      proc.on('close', (code) => done(code === 0 && !entry.cancelled ? undefined : new Error(entry.cancelled ? L('Cancelado.', 'Cancelled.') : L(`O whisper-cli falhou: ${err.trim().split('\n').at(-1) ?? code}`, `whisper-cli failed: ${err.trim().split('\n').at(-1) ?? code}`))))
      const done = (e?: Error): void => {
        clearTimeout(timer)
        this.running.delete(id)
        if (e) reject(e)
        else resolve(out)
      }
    })
  }
}
