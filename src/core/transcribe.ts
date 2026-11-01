// Dictation: audio from the window, turned into text on this machine with whisper-cli. Nothing is
// bundled or downloaded (a model is hundreds of MB), and the audio leaves no file behind.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { L } from '../shared/lang'
import type { VoiceSettings, VoiceStatus } from '../shared/types'
import { executableNames, isWin, killTree } from './platform'

export const MAX_AUDIO_BASE64 = 30_000_000 // about 15 minutes of 16 kHz mono
const TIMEOUT_MS = 5 * 60_000

const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin']
const MODEL_DIRS = (home: string): string[] => [join(home, '.cache', 'whisper-cpp'), '/opt/homebrew/share/whisper-cpp', '/usr/local/share/whisper-cpp']

const findBin = (path: string | undefined): string | undefined =>
  [...(path ?? '').split(delimiter).filter(Boolean), ...BIN_DIRS].flatMap((d) => executableNames('whisper-cli').map((name) => join(d, name))).find((f) => existsSync(f))

// The best one there: turbo is what's fast enough to dictate with.
function findModel(home: string): string | undefined {
  const all = MODEL_DIRS(home).flatMap((dir) => {
    try {
      return readdirSync(dir).filter((f) => /^ggml-.*\.bin$/.test(f)).map((f) => join(dir, f))
    } catch {
      return []
    }
  })
  return all.find((f) => f.includes('turbo')) ?? all.sort().at(-1)
}

export function voiceStatus(voice: VoiceSettings | undefined, env: NodeJS.ProcessEnv = process.env, home = homedir()): VoiceStatus {
  const bin = voice?.bin ? (existsSync(voice.bin) ? voice.bin : undefined) : findBin(env['PATH'] ?? env['Path'])
  const model = voice?.model ? (existsSync(voice.model) ? voice.model : undefined) : findModel(home)
  return { bin, model, ready: !!bin && !!model }
}

// What whisper prints for silence, not words.
const NOT_SPEECH = /^[[(][^\])]*[\])]$/
export const cleanTranscript = (out: string): string =>
  out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !NOT_SPEECH.test(l))
    .join(' ')

export class Transcriber {
  private running = new Map<string, { proc: ChildProcess; cancelled: boolean }>()

  async transcribe(id: string, base64: string, status: VoiceStatus, language: string | undefined): Promise<string> {
    if (!status.bin || !status.model) throw new Error(L('O whisper-cli ou o modelo não foi encontrado. Veja em Configurações.', "whisper-cli or its model wasn't found. See Settings."))
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
