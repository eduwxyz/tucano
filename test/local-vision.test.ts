import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { decodeImage, fit } from '../src/core/images'
import { ctcDecode, describeRead, elementKind, gpuFor, LOCAL_MODELS, LocalVision, ocrDictionary, readingOrder, textRegions, type ImageRead } from '../src/core/local-vision'
import { Runner } from '../src/core/runs'
import { localModelsRefusal } from '../src/shared/voice'
import type { Agent, EngineId, Settings } from '../src/shared/types'

// The image models on this computer: what an image I attach says goes to the agent as text, in the
// image's place; when they can't read it, the image goes as always and nothing waits.

const pngOf = (w: number, h: number): Buffer => {
  const p = new PNG({ width: w, height: h })
  p.data.fill(200)
  return PNG.sync.write(p)
}

describe('reading the image', () => {
  it('decodes PNG, refuses what it does not read, and shrinks a big image to 1400 px', async () => {
    const img = await decodeImage(pngOf(3000, 1500))
    expect([img.w, img.h]).toEqual([3000, 1500])
    const small = fit(img, 1400)
    expect([small.w, small.h]).toEqual([1400, 700])
    expect(fit({ w: 800, h: 600, data: new Uint8Array(800 * 600 * 4) }, 1400).w).toBe(800) // small ones stay
    await expect(decodeImage(Buffer.from('not an image at all'))).rejects.toThrow(/PNG/)
  })

  it("reads the recognizer's characters from its inference.yml, or a .txt", () => {
    const yml = "PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - '!'\n  - ''''\n  - a\n  - 中\nPreProcess:\n  - x\n"
    expect(ocrDictionary(yml)).toEqual(['!', "'", 'a', '中'])
    expect(ocrDictionary('a\nb\nc\n')).toEqual(['a', 'b', 'c'])
  })

  it('decodes CTC: repeats and blanks dropped, the last class a space', () => {
    const dict = ['o', 'i']
    // steps: o o blank i space i  → "oi i"
    const steps = [1, 1, 0, 2, 3, 2]
    const probs = new Float32Array(steps.length * 4)
    steps.forEach((c, t) => (probs[t * 4 + c] = 0.9))
    expect(ctcDecode(probs, steps.length, 4, dict)).toEqual({ text: 'oi i', score: expect.closeTo(0.9, 5) })
  })

  it('finds text regions in the detector map, and keeps lines in reading order', () => {
    const w = 40
    const h = 20
    const map = new Float32Array(w * h)
    for (let y = 4; y < 9; y++) for (let x = 2; x < 18; x++) map[y * w + x] = 0.9 // a word
    for (let y = 4; y < 9; y++) for (let x = 24; x < 36; x++) map[y * w + x] = 0.9 // another, same line
    for (let y = 14; y < 16; y++) for (let x = 2; x < 4; x++) map[y * w + x] = 0.9 // too small: noise
    const boxes = textRegions(map, w, h)
    expect(boxes).toHaveLength(2)
    expect(boxes[0]!.x).toBeLessThan(2) // grown, as PP-OCR's unclip
    const line = (text: string, x: number, y: number) => ({ text, box: { x, y, w: 10, h: 10 }, score: 1 })
    expect(readingOrder([line('b', 50, 2), line('c', 0, 40), line('a', 0, 0)]).map((r) => r.map((l) => l.text))).toEqual([['a', 'b'], ['c']])
  })

  it('tells an element apart by its shape and the text in it', () => {
    const image = { width: 1000, height: 800 }
    const t = (text: string, y: number) => ({ text, box: { x: 110, y, w: 50, h: 10 }, score: 1 })
    expect(elementKind({ x: 100, y: 100, w: 80, h: 30 }, [t('Enviar', 105)], image)).toBe('button')
    expect(elementKind({ x: 100, y: 100, w: 300, h: 200 }, [t('Plano Pro', 120), t('R$ 20', 160)], image)).toBe('card')
    expect(elementKind({ x: 100, y: 100, w: 24, h: 24 }, [], image)).toBe('icon')
    expect(elementKind({ x: 100, y: 100, w: 400, h: 30 }, [], image)).toBe('field')
  })

  it('uses the GPU there is one for, and the CPU otherwise', () => {
    expect(gpuFor('mac', 'arm64')).toBe('coreml')
    expect(gpuFor('mac', 'x64')).toBeUndefined()
    expect(gpuFor('windows', 'x64')).toBe('dml')
    expect(gpuFor('linux', 'x64', (p) => p === '/proc/driver/nvidia/version')).toBe('cuda')
    expect(gpuFor('linux', 'x64', () => false)).toBeUndefined() // AMD, Intel, none: CPU
  })

  it('what the agent gets: the text, the elements and the objects; nothing useful, no text at all', () => {
    const read: ImageRead = {
      width: 1440,
      height: 900,
      text: [{ text: 'Pagamento recusado', box: { x: 10, y: 10, w: 200, h: 20 }, score: 0.99 }],
      elements: [{ kind: 'button', text: 'Tentar de novo', box: { x: 20, y: 50, w: 120, h: 32 }, score: 0.8 }],
      objects: [
        { label: 'cup', box: { x: 0, y: 0, w: 1, h: 1 }, score: 0.91 },
        { label: 'cup', box: { x: 0, y: 0, w: 1, h: 1 }, score: 0.5 }
      ],
      failed: {}
    }
    const text = describeRead('erro.png', read)!
    expect(text).toContain('erro.png, 1440×900')
    expect(text).toContain('Pagamento recusado')
    expect(text).toMatch(/"Tentar de novo" \(x 20, y 50, 120×32\)/)
    expect(text).toMatch(/2 × cup \(91%, 50%\)/)
    expect(text).not.toContain('ver_imagem') // said at the turn, only when the tool is there
    expect(describeRead('x.png', null)).toBeNull()
    expect(describeRead('x.png', { width: 1, height: 1, failed: { ocr: 'boom' } })).toBeNull()
    // a logo: only boxes without words, which say less than the image
    expect(describeRead('logo.png', { width: 1, height: 1, elements: [{ kind: 'icon', text: '', box: { x: 0, y: 0, w: 1, h: 1 }, score: 1 }], failed: {} })).toBeNull()
  })

  it('takes only absolute paths to a model of your own', () => {
    expect(localModelsRefusal({ paths: { ui: '/m/icon_detect.onnx', ocrDict: '/m/inference.yml' } })).toBeNull()
    expect(localModelsRefusal({ paths: { ui: 'icon_detect.onnx' } })).toMatch(/onnx/)
    expect(localModelsRefusal({ paths: { objects: '/m/yolo.pt' } })).toMatch(/onnx/)
    expect(localModelsRefusal({ paths: { ocrDict: '/m/dict.json' } })).toMatch(/yml|txt/)
  })
})

describe('the models: downloaded once, for every workspace', () => {
  const body = Buffer.from('onnx bytes, for a test')
  const sha = createHash('sha256').update(body).digest('hex')
  const file = { url: 'https://huggingface.co/x/resolve/abc/model.onnx', bytes: body.length, sha256: sha }
  const models = { ...LOCAL_MODELS, objects: { files: { 'deimv2-n.onnx': file } } }
  const serve = (calls: string[]) => (async (url: string) => (calls.push(url), new Response(body))) as unknown as typeof fetch

  it("one workspace downloads; another sees it there and doesn't fetch it again; removing it is for all", async () => {
    const shared = mkdtempSync(join(tmpdir(), 'models-'))
    const calls: string[] = []
    const one = new LocalVision(shared, () => {}, serve(calls), models, undefined)
    await one.download('objects')
    expect(calls).toEqual([file.url])
    expect(readdirSync(shared)).toEqual(['deimv2-n.onnx'])
    expect(one.status()).toMatchObject({ downloaded: ['objects'], stored: ['objects'], ready: ['objects'], queued: 0 })

    const other = new LocalVision(shared, () => {}, serve(calls), models, undefined)
    expect(other.downloaded()).toEqual(['objects'])
    await other.download('objects') // already here: nothing fetched
    expect(calls).toHaveLength(1)
    // on in one workspace's settings, off in another's: each turns on its own
    expect(other.usable({ objects: true })).toEqual(['objects'])
    expect(other.usable({ ocr: true })).toEqual([])
    expect(other.usable(undefined)).toEqual([])

    one.remove('objects')
    expect(other.downloaded()).toEqual([])
  })

  it('a model with only part of it here (a new file, an old one left) still counts as stored, and removing it takes all', () => {
    const shared = mkdtempSync(join(tmpdir(), 'models-'))
    const ocr = { 'ocr-tiny-det.onnx': file, 'ocr-rec.onnx': file, 'ocr-rec.yml': file }
    const v = new LocalVision(shared, () => {}, serve([]), { ...models, ocr: { files: ocr } }, undefined)
    writeFileSync(join(shared, 'ocr-rec.onnx'), body) // the recognizer, from before
    writeFileSync(join(shared, 'ocr-rec.yml'), body)
    writeFileSync(join(shared, 'ocr-det.onnx'), body) // the small detector it used to have
    writeFileSync(join(shared, 'yolo26s.onnx'), body) // the objects model it used to have
    expect(v.downloaded()).toEqual([]) // the tiny detector is missing
    expect(v.stored()).toEqual(['ocr', 'objects'])
    v.remove('ocr')
    v.remove('objects')
    expect(readdirSync(shared)).toEqual([])
    expect(v.stored()).toEqual([])
  })

  it('a model of your own counts as there without downloading', () => {
    const v = new LocalVision(mkdtempSync(join(tmpdir(), 'models-')), () => {}, serve([]), models, undefined)
    const own = join(mkdtempSync(join(tmpdir(), 'own-')), 'mine.onnx')
    expect(v.usable({ objects: true, paths: { objects: own } })).toEqual([]) // not a file yet
    writeFileSync(own, 'x')
    expect(v.usable({ objects: true, paths: { objects: own } })).toEqual(['objects'])
  })

  it("a file that isn't the one expected is thrown away, and the error says which model", async () => {
    const shared = mkdtempSync(join(tmpdir(), 'models-'))
    const bad = { ...models, objects: { files: { 'deimv2-n.onnx': { ...file, sha256: '0'.repeat(64) } } } }
    const v = new LocalVision(shared, () => {}, serve([]), bad, undefined)
    await v.download('objects')
    expect(readdirSync(shared)).toEqual([])
    expect(v.status().error).toMatchObject({ model: 'objects', message: expect.stringMatching(/esperado|expected/) })
  })

  it("with nothing on, or an image it can't decode, it reads nothing and the image goes as it is", async () => {
    const v = new LocalVision(mkdtempSync(join(tmpdir(), 'models-')), () => {}, serve([]), models, undefined)
    expect(await v.read(pngOf(10, 10), {})).toBeNull()
    expect(await v.read(Buffer.from('GIF89a'), { objects: true })).toBeNull()
    expect(v.status().queued).toBe(0)
  })
})

// ---------- in a conversation ----------

const ready = { installed: true, loggedIn: true }
const agent: Agent = { id: 'a1', name: 'lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
let db: Db
let turns: Turn[]
const settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as Settings

function runner(vision?: ConstructorParameters<typeof Runner>[0]['vision'], using = settings): { r: Runner; data: string } {
  const claude = fakeEngine('claude', { delayMs: 1 })
  const recorded: Engine = { ...claude, run: (t) => (turns.push(t), claude.run(t)) }
  const engines = { claude: recorded, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') } as Record<EngineId, Engine>
  const data = mkdtempSync(join(tmpdir(), 'lv-data-'))
  return { r: new Runner({ db, engines, settings: async () => using, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'lv-work-')), dataDir: data, ...(vision ? { vision } : {}) }), data }
}

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'lv-db-')), 'test.db'))
  turns = []
  db.saveAgent(agent)
  db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
})

const shot = { name: 'erro.png', mime: 'image/png', data: pngOf(4, 4).toString('base64') }

describe('an attached image, with the image models on', () => {
  it('goes to the agent as what the models read, not as an image', async () => {
    const seen: string[] = []
    const { r } = runner({ image: async (name) => (seen.push(name), `[imagem anexada: ${name}, lida aqui]\nTexto na imagem (OCR, PP-OCRv6):\nPagamento recusado`), pdf: async () => null })
    await r.send('d1', 'o que houve?', [shot])
    await r.idle()
    expect(seen).toEqual(['erro.png'])
    const turn = turns.at(-1)!
    expect(turn.images ?? []).toEqual([])
    expect(turn.prompt).toContain('Pagamento recusado')
    expect(db.recentMessages('d1', 5).at(-1)!.run!.steps.some((st) => /Leu no computador/.test(st.label))).toBe(true)
  })

  it("goes as an image when the models can't read it, or fail, and the reply still comes", async () => {
    for (const image of [async () => null, async () => Promise.reject(new Error('onnxruntime crashed'))]) {
      turns = []
      const { r } = runner({ image, pdf: async () => null })
      await r.send('d1', 'e esse?', [shot])
      await r.idle()
      expect(turns.at(-1)!.images).toHaveLength(1)
      expect(db.recentMessages('d1', 5).at(-1)!.author.kind).toBe('agent')
    }
  })

  it('with "never send images to the AI" on, no image goes, even one the models can\'t read', async () => {
    const only = { ...settings, localModels: { objects: true, offline: true } } as Settings
    for (const image of [async () => null, async () => Promise.reject(new Error('onnxruntime crashed'))]) {
      turns = []
      const { r } = runner({ image, pdf: async () => null }, only)
      await r.send('d1', 'e esse?', [shot])
      await r.idle()
      const turn = turns.at(-1)!
      expect(turn.images ?? []).toEqual([])
      expect(turn.prompt).toContain('não vão para a IA')
    }
  })

  it('"never send" with no model on does nothing: the image goes as always', async () => {
    const { r } = runner({ image: async () => null, pdf: async () => null }, { ...settings, localModels: { offline: true } } as Settings)
    await r.send('d1', 'e esse?', [shot])
    await r.idle()
    expect(turns.at(-1)!.images).toHaveLength(1)
  })

  it('a scanned PDF (no text in it) is read by the OCR', async () => {
    const { r, data } = runner({ image: async () => null, pdf: async () => 'Página 1\n\nNota fiscal 123' })
    // no text layer at all: what a scan looks like to the text extractor
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF')
    await r.send('d1', 'lê isso', [], undefined, undefined, { files: [{ name: 'scan.pdf', data: pdf.toString('base64') }] })
    await r.idle()
    const kept = db.artifacts().find((a) => a.name === 'scan.pdf')!
    expect(JSON.parse(readFileSync(join(data, 'artifacts', kept.id, '.texto.json'), 'utf8'))).toEqual({ text: 'Página 1\n\nNota fiscal 123' })
    expect(turns.at(-1)!.prompt).toContain('Nota fiscal 123')
  })
})

// With the real models downloaded (TUCANO_LOCAL_MODELS=<folder with them>), on the repo's own
// screenshot: what the person sees working. Skipped otherwise: they're 120 MB.
const real = process.env['TUCANO_LOCAL_MODELS']
describe.skipIf(!real || !existsSync(join(real, 'ocr-tiny-det.onnx')))('the real models, on a screenshot', () => {
  it('reads its text and finds what can be clicked', { timeout: 120_000 }, async () => {
    const v = new LocalVision(real!, () => {})
    const r = await v.read(readFileSync(join(__dirname, '..', 'docs', 'images', 'conversation.png')), { ocr: true, ui: true, objects: true })
    const text = describeRead('conversation.png', r)!
    console.log(`${text}\n\nran on: ${JSON.stringify(v.devices)}`)
    expect(text).toContain('Approvals')
    expect(r!.elements!.some((e) => e.kind === 'button' && /Summary/.test(e.text))).toBe(true)
    expect(r!.failed.objects).toBeUndefined() // DEIMv2 ran (pred_logits, not logits)
  })
})

describe('several models turned on at once', () => {
  it('download one after another, none cancelling the other; a waiting one can be cancelled', async () => {
    const body = Buffer.from('onnx bytes, for a test')
    const sha = createHash('sha256').update(body).digest('hex')
    const one = (url: string) => ({ url, bytes: body.length, sha256: sha })
    const models = { ocr: { files: { 'ocr-tiny-det.onnx': one('d'), 'ocr-rec.onnx': one('r'), 'ocr-rec.yml': one('y') } }, ui: { files: { 'omniparser-v2.onnx': one('u') } }, objects: { files: { 'deimv2-n.onnx': one('o') } } }
    const calls: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const fetcher = (async (url: string) => (calls.push(url), url === 'd' && (await gate), new Response(body))) as unknown as typeof fetch
    const v = new LocalVision(mkdtempSync(join(tmpdir(), 'models-')), () => {}, fetcher, models, undefined)
    const first = v.download('ocr')
    void v.download('ui')
    void v.download('objects')
    void v.download('ui') // twice: once
    await new Promise((r) => setTimeout(r, 10))
    expect(v.status()).toMatchObject({ downloading: { model: 'ocr' }, waiting: ['ui', 'objects'] })
    v.cancel('objects')
    expect(v.status().waiting).toEqual(['ui'])
    release()
    await first
    expect(v.downloaded()).toEqual(['ocr', 'ui'])
    expect(calls).toEqual(['d', 'r', 'y', 'u'])
    expect(v.status().waiting).toBeUndefined()
  })
})

describe('the file types the person keeps for the local models', () => {
  const v = new LocalVision(mkdtempSync(join(tmpdir(), 'models-')), () => {}, fetch, LOCAL_MODELS, undefined)
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1])
  const pdf = Buffer.from('%PDF-1.4\n...')
  const gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;')
  const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(52)])

  it('always reads JPG, PNG, WebP and PDF, by what the file is, even with nothing added', () => {
    for (const types of [undefined, [], ['gif']]) {
      expect(v.accepts(pngOf(2, 2), { types })).toBe(true)
      expect(v.accepts(jpeg, { types })).toBe(true)
      expect(v.accepts(pdf, { types })).toBe(true)
    }
    expect(v.accepts(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), {})).toBe(false) // not one the models read
  })

  it('reads the others only once added; one not added goes straight to the AI', async () => {
    expect(v.accepts(gif, {})).toBe(false)
    expect(v.accepts(bmp, { types: ['gif'] })).toBe(false)
    expect(v.accepts(gif, { types: ['gif'] })).toBe(true)
    expect(v.accepts(bmp, { types: ['gif', 'bmp'] })).toBe(true)
    expect(await v.read(gif, { ocr: true })).toBeNull()
    expect(v.status().queued).toBe(0) // nothing waited in the queue for it
  })

  it('takes only types the models read', () => {
    expect(localModelsRefusal({ types: ['gif', 'tif', 'avif'] })).toBeNull()
    expect(localModelsRefusal({ types: ['heic'] })).toMatch(/heic/)
    expect(localModelsRefusal({ types: ['svg', 'png'] })).toMatch(/svg/)
    expect(localModelsRefusal({ types: 'png' as unknown as string[] })).toMatch(/inválida|Invalid/)
  })
})
