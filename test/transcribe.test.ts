import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executableNames } from '../src/core/platform'
import { cleanTranscript, ModelDownload, Transcriber, voiceStatus } from '../src/core/transcribe'
import { voiceRefusal } from '../src/shared/voice'
import { encodeWav } from '../src/shared/wav'

const script = (dir: string, body: string): string => {
  const file = join(dir, 'whisper-cli')
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}
const leftovers = (): string[] => readdirSync(tmpdir()).filter((f) => f.startsWith('tucano-voz-'))

const unix = process.platform !== 'win32' // the fake binary is a shell script

describe.runIf(unix)('finding whisper', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ad-voice-'))
  })

  it('finds the binary on the PATH and prefers the turbo model', () => {
    const bin = script(dir, 'exit 0')
    const models = join(dir, '.cache', 'whisper-cpp')
    mkdirSync(models, { recursive: true })
    for (const m of ['ggml-tiny.bin', 'ggml-large-v3-turbo.bin', 'outro.txt']) writeFileSync(join(models, m), '')
    expect(voiceStatus(undefined, { PATH: dir }, dir)).toEqual({ bin, model: join(models, 'ggml-large-v3-turbo.bin'), ready: true })
  })

  it('looks in the folder every workspace shares, then in the workspace’s own', () => {
    const bin = script(dir, 'exit 0')
    const shared = join(dir, 'voice')
    const own = join(dir, 'workspaces', 'w1', 'voice')
    const file = 'ggml-large-v3-turbo-q5_0.bin'
    mkdirSync(shared, { recursive: true })
    mkdirSync(own, { recursive: true })
    const places = { models: shared, own }
    // Downloaded before the folder was shared: found where it is, nothing to download again.
    writeFileSync(join(own, file), '')
    expect(voiceStatus(undefined, { PATH: dir }, dir, places)).toEqual({ bin, model: join(own, file), ready: true, ownModel: 'recommended', downloaded: ['recommended'] })
    // In the shared folder: that one, first.
    writeFileSync(join(shared, file), '')
    expect(voiceStatus(undefined, { PATH: dir }, dir, places)).toMatchObject({ model: join(shared, file), ownModel: 'recommended', downloaded: ['recommended'] })
    // A new workspace, with nothing of its own, uses the shared one.
    expect(voiceStatus(undefined, { PATH: dir }, dir, { models: shared, own: join(dir, 'workspaces', 'w2', 'voice') })).toMatchObject({ model: join(shared, file), ready: true })
  })

  it('a path set by the person wins, and one that is gone is not ready', () => {
    const bin = script(dir, 'exit 0')
    const model = join(dir, 'meu.bin')
    writeFileSync(model, '')
    expect(voiceStatus({ bin, model }, { PATH: '' }, dir)).toEqual({ bin, model, ready: true })
    expect(voiceStatus({ bin: join(dir, 'whisper-sumiu'), model }, { PATH: '' }, dir).ready).toBe(false)
  })

  it('only takes a whisper binary and a .bin model, as full paths', () => {
    expect(voiceRefusal({ bin: '/bin/sh' })).toMatch(/whisper-cli/)
    expect(voiceRefusal({ bin: 'whisper-cli' })).toMatch(/whisper-cli/)
    expect(voiceRefusal({ model: '/tmp/x.txt' })).toMatch(/\.bin/)
    expect(voiceRefusal({ bin: '/opt/homebrew/bin/whisper-cli', model: '/tmp/x.bin' })).toBeNull()
    expect(voiceRefusal(undefined)).toBeNull()
  })
})

describe.runIf(unix)('transcribing', () => {
  let dir = ''
  let model = ''
  const systemTmp = process.env['TMPDIR']
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ad-voice-'))
    model = join(dir, 'm.bin')
    writeFileSync(model, '')
    // Its own temp folder: `leftovers` reads it whole, and a machine's can hold hundreds of thousands of entries.
    process.env['TMPDIR'] = dir
  })
  afterEach(() => {
    if (systemTmp === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = systemTmp
  })
  const status = (bin: string) => ({ bin, model, ready: true })
  const audio = Buffer.from('RIFF').toString('base64')

  it('gets the text, with the language and the audio, and leaves no file', async () => {
    const before = leftovers().length
    const bin = script(dir, 'echo "args: $*" > "$(dirname "$0")/args"; cat "$4" > "$(dirname "$0")/ouvido"; echo " Revisar o post do blog. "')
    expect(await new Transcriber().transcribe('a', audio, status(bin), 'pt')).toBe('Revisar o post do blog.')
    const args = (await import('node:fs')).readFileSync(join(dir, 'args'), 'utf8')
    expect(args).toContain('-l pt')
    expect(args).toContain(`-m ${model}`)
    expect((await import('node:fs')).readFileSync(join(dir, 'ouvido'), 'utf8')).toBe('RIFF')
    expect(leftovers()).toHaveLength(before)
  })

  it('an error says so and leaves no file', async () => {
    const before = leftovers().length
    const bin = script(dir, 'echo "modelo invalido" >&2; exit 3')
    await expect(new Transcriber().transcribe('a', audio, status(bin), 'pt')).rejects.toThrow(/modelo invalido/)
    expect(leftovers()).toHaveLength(before)
  })

  it('cancelling stops the process and leaves no file', async () => {
    const before = leftovers().length
    const bin = script(dir, 'sleep 30; echo tarde')
    const t = new Transcriber()
    const going = t.transcribe('a', audio, status(bin), 'pt')
    await new Promise((r) => setTimeout(r, 100))
    t.cancel('a')
    await expect(going).rejects.toThrow(/Cancelado/)
    expect(leftovers()).toHaveLength(before)
  })

  it('refuses without a binary, or with too much audio', async () => {
    await expect(new Transcriber().transcribe('a', audio, { ready: false }, 'pt')).rejects.toThrow(/Configurações/)
    await expect(new Transcriber().transcribe('a', 'x'.repeat(30_000_001), status(script(dir, 'exit 0')), 'pt')).rejects.toThrow(/longo/)
    expect(existsSync(join(dir, 'args'))).toBe(false)
  })

  it('drops what whisper prints for silence', () => {
    expect(cleanTranscript('[BLANK_AUDIO]\n (Música) \n')).toBe('')
    expect(cleanTranscript(' Primeira linha\n [inaudível]\n segunda linha\n')).toBe('Primeira linha segunda linha')
    // Sounds whisper names between asterisks, on a line or in the middle of one, are not words either.
    expect(cleanTranscript(" Hi, I'm talking here, etc. All right. *Loud noise*\n")).toBe("Hi, I'm talking here, etc. All right.")
    expect(cleanTranscript(' *risos*\n')).toBe('')
    expect(cleanTranscript(' Bom dia [BLANK_AUDIO] tudo bem?\n')).toBe('Bom dia tudo bem?')
    // What is said is kept as said: a word in parentheses or a multiplication isn't a sound.
    expect(cleanTranscript(' Custa 2 * 3 reais (mais ou menos).\n')).toBe('Custa 2 * 3 reais (mais ou menos).')
  })
})

describe('encodeWav', () => {
  it('writes a 16 kHz mono PCM header and clamps the samples', () => {
    const wav = encodeWav(new Float32Array([0, 1, -2]), 16_000)
    const v = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(v.getUint16(22, true)).toBe(1)
    expect(v.getUint32(24, true)).toBe(16_000)
    expect(v.getUint32(40, true)).toBe(6)
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 0x7fff, -0x7fff])
  })
})

describe('turning dictation on: the model download', () => {
  const body = Buffer.from('ggml model bytes, for a test')
  const sha = createHash('sha256').update(body).digest('hex')
  const models = { recommended: { file: 'ggml-test-turbo.bin', bytes: body.length, sha256: sha }, light: { file: 'ggml-test-small.bin', bytes: body.length, sha256: '0'.repeat(64) } }
  const serve = (bytes: Buffer, status = 200) =>
    (async () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(bytes.subarray(0, 10))), c.enqueue(new Uint8Array(bytes.subarray(10))), c.close()) }), { status })) as unknown as typeof fetch

  it('downloads, checks the hash, and the status finds it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-'))
    const changes: number[] = []
    const d = new ModelDownload(dir, () => changes.push(d.progress?.received ?? -1), serve(body), models)
    await d.start('recommended')
    expect(existsSync(join(dir, 'ggml-test-turbo.bin'))).toBe(true)
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([])
    expect(d.progress).toBeNull()
    expect(d.error).toBeNull()
    expect(changes.at(-1)).toBe(-1) // the last word: done
    // the app's bundled program and its own model folder come first
    const bundled = join(dir, 'bin')
    mkdirSync(bundled)
    writeFileSync(join(bundled, executableNames('whisper-cli')[0]!), '')
    const st = voiceStatus(undefined, { PATH: '' }, join(dir, 'nohome'), { bundled, models: dir })
    expect(st).toMatchObject({ ready: true, bin: join(bundled, executableNames('whisper-cli')[0]!), model: join(dir, 'ggml-test-turbo.bin') })
  })

  it("throws away a file that isn't the one expected, and says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-'))
    const d = new ModelDownload(dir, () => {}, serve(body), models)
    await d.start('light') // its hash doesn't match
    expect(readdirSync(dir)).toEqual([])
    expect(d.error).toMatch(/esperado|expected/)
    const d2 = new ModelDownload(dir, () => {}, serve(body, 404), models)
    await d2.start('recommended')
    expect(d2.error).toMatch(/404/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a cancelled download leaves nothing behind and no error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-'))
    const never = (async (_u: string, init: RequestInit) =>
      new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(body.subarray(0, 5))), init.signal!.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))) }))) as unknown as typeof fetch
    const d = new ModelDownload(dir, () => {}, never, models)
    const going = d.start('recommended')
    await new Promise((r) => setTimeout(r, 20))
    expect(d.progress).toMatchObject({ model: 'recommended', received: 5 })
    d.cancel()
    await going
    expect(d.error).toBeNull()
    expect(d.progress).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })
})
