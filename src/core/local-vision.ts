// Image models that run on this computer, so what a person attaches can go to the agents as text
// instead of as an image: PP-OCRv6 reads the text (of images, and of scanned PDFs), OmniParser v2
// finds what can be clicked on a screen, DEIMv2 names the objects in a photo. All ONNX, through
// onnxruntime: on the CPU, or on a GPU when there is one it can use (CoreML on a Mac, DirectML on
// Windows, CUDA with an NVIDIA driver on Linux), back to the CPU if the GPU doesn't take it.
// The models (≈120 MB) are downloaded once, when the person turns one on, to a folder every
// workspace shares. One attachment is read at a time, in a queue: a model takes a core or the GPU.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { L } from '../shared/lang'
import { LOCAL_MODEL_IDS, localTypeOn, type LocalModelId, type LocalModelPath, type LocalModelsSettings, type LocalModelsStatus } from '../shared/types'
import { decodeImage, fit, resize, sniff, type Rgba } from './images'
import { fetchPinned, type PinnedFile } from './pinned-file'
import { osOf } from './platform'

// ---------- the models ----------

const HF = (repo: string, rev: string, path: string): string => `https://huggingface.co/${repo}/resolve/${rev}/${path}`
const OCR_DET = 'PaddlePaddle/PP-OCRv6_tiny_det_onnx'
const OCR_REC = 'PaddlePaddle/PP-OCRv6_small_rec_onnx'

// Pinned by commit, size and SHA-256: a download that doesn't match is thrown away.
export const LOCAL_MODELS: Record<LocalModelId, { files: Record<string, PinnedFile> }> = {
  ocr: {
    files: {
      // The tiny detector with the small recognizer: as accurate as small + small on text we know (92%
      // of words exact on degraded screenshots, 97.6% on clean), a fifth of the size, faster. The tiny
      // recognizer is what loses words (77% degraded): reading is where accuracy is.
      'ocr-tiny-det.onnx': { url: HF(OCR_DET, '2ba1506c0380b8f0b03dd142459aac66d4421f6c', 'inference.onnx'), bytes: 1_780_590, sha256: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8' },
      'ocr-rec.onnx': { url: HF(OCR_REC, 'b8f84f0b80c529de40b4fbb3544b84fa7233a513', 'inference.onnx'), bytes: 21_159_378, sha256: '5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634' },
      'ocr-rec.yml': { url: HF(OCR_REC, 'b8f84f0b80c529de40b4fbb3544b84fa7233a513', 'inference.yml'), bytes: 150_579, sha256: 'ab078671bb49f06228eadccd34f1bb501e157f7a047095ffb943ba81512c77d1' }
    }
  },
  ui: {
    files: {
      // microsoft/OmniParser-v2.0's icon_detect, exported to ONNX
      'omniparser-v2.onnx': { url: HF('onnx-community/OmniParser-v2.0_icon_detect', 'f0fbccdf5f56c2a689f669b95cb4f67bcf4e12b1', 'onnx/model.onnx'), bytes: 80_305_670, sha256: 'c0d3d261e3368a5e51fe0d632c5d62e4bd4da489ac4b95fbbee450eb640e36fe' }
    }
  },
  objects: {
    files: {
      // DEIMv2-N (HGNetv2), Intellindust's COCO weights unchanged, as LibreYOLO exported them (Apache-2.0)
      'deimv2-n.onnx': { url: HF('LibreYOLO/LibreDEIMv2n', '654e96783419a45fb4cd30d0086fa81c51cbb5fa', 'LibreDEIMv2n.onnx'), bytes: 14_979_540, sha256: 'e58e60f22e35c1eb2e819b963dc800263e853e1f192c23cfbd3a1affb778592b' }
    }
  }
}
// Files an earlier version of a model used (the small OCR detector, YOLO26s): nothing reads them,
// and they go when that model is turned off or removed.
const REPLACED: Record<LocalModelId, string[]> = { ocr: ['ocr-det.onnx'], ui: [], objects: ['yolo26s.onnx'] }
// Which path in the advanced settings stands for each file.
const PATH_OF: Record<string, LocalModelPath> = { 'ocr-tiny-det.onnx': 'ocrDet', 'ocr-rec.onnx': 'ocrRec', 'ocr-rec.yml': 'ocrDict', 'omniparser-v2.onnx': 'ui', 'deimv2-n.onnx': 'objects' }
type Paths = LocalModelsSettings['paths']

export const modelBytes = (id: LocalModelId, models = LOCAL_MODELS): number => Object.values(models[id].files).reduce((n, f) => n + f.bytes, 0)

const MAX_SIDE = 1400 // a bigger image is shrunk to this before it's read: as good for the models, much quicker
const OBJECT_CONFIDENCE = 0.42
const UI_CONFIDENCE = 0.15
const IDLE_MS = 5 * 60_000 // models unused this long give their memory back

// ---------- images ----------

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

// The pixels as a 1×3×h×w tensor: each channel (x/255 − mean)/std, in RGB or BGR order.
function planar(img: Rgba, mean: number[], std: number[], bgr: boolean): Float32Array {
  const n = img.w * img.h
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++)
    for (let c = 0; c < 3; c++) {
      const src = bgr ? 2 - c : c
      out[c * n + i] = (img.data[i * 4 + src]! / 255 - mean[c]!) / std[c]!
    }
  return out
}

const iou = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  if (w <= 0 || h <= 0) return 0
  const inter = w * h
  return inter / (a.w * a.h + b.w * b.h - inter)
}

function nms<T extends { box: Box; score: number }>(items: T[], threshold: number): T[] {
  const kept: T[] = []
  for (const it of [...items].sort((a, b) => b.score - a.score)) if (kept.every((k) => iou(k.box, it.box) < threshold)) kept.push(it)
  return kept
}

// ---------- running a model ----------

type Ort = typeof import('onnxruntime-node')
type Device = 'cpu' | 'coreml' | 'dml' | 'cuda'

// The GPU this computer has that onnxruntime can use, if any. On Linux only NVIDIA's (CUDA): an
// AMD or Intel card stays on the CPU, which onnxruntime's Linux build has no provider for.
export function gpuFor(os = osOf(), arch = process.arch, exists: (p: string) => boolean = existsSync): Device | undefined {
  if (os === 'mac') return arch === 'arm64' ? 'coreml' : undefined
  if (os === 'windows') return 'dml'
  return arch === 'x64' && exists('/proc/driver/nvidia/version') ? 'cuda' : undefined
}

export const deviceName = (d: Device): string => ({ cpu: 'CPU', coreml: 'GPU (Core ML)', dml: 'GPU (DirectML)', cuda: 'GPU (CUDA)' })[d]

interface Loaded {
  session: InferenceSession
  device: Device
}

// ---------- reading ----------

export interface TextLine {
  text: string
  box: Box
  score: number
}
export interface Element {
  kind: 'button' | 'icon' | 'card' | 'text' | 'field'
  box: Box
  text: string
  score: number
}
export interface Thing {
  label: string
  box: Box
  score: number
}
export interface ImageRead {
  width: number
  height: number
  text?: TextLine[]
  elements?: Element[]
  objects?: Thing[]
  failed: Partial<Record<LocalModelId, string>> // why a model that was on didn't read it
}

// The recognizer's characters, from its inference.yml (or a .txt with one a line, as PaddleOCR's
// dictionaries): index 0 of its output is CTC's blank, then these, then a space.
export function ocrDictionary(yml: string): string[] {
  const lines = yml.replace(/\r\n/g, '\n').split('\n')
  if (!lines.some((l) => /^\s*character_dict:\s*$/.test(l))) return lines.filter((l, i) => l !== '' || i < lines.length - 1)
  const start = lines.findIndex((l) => /^\s*character_dict:\s*$/.test(l))
  if (start < 0) throw new Error('character_dict not found')
  const out: string[] = []
  for (const l of lines.slice(start + 1)) {
    const m = /^\s*- (.*)$/.exec(l)
    if (!m) break
    const v = m[1]!
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) out.push(v.slice(1, -1).replace(/''/g, "'"))
    else if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) out.push(JSON.parse(v) as string)
    else out.push(v)
  }
  return out
}

// Greedy CTC: the likeliest class at each step, repeats and blanks dropped.
export function ctcDecode(probs: Float32Array, steps: number, classes: number, dict: string[]): { text: string; score: number } {
  let text = ''
  let sum = 0
  let n = 0
  let prev = -1
  for (let t = 0; t < steps; t++) {
    let best = 0
    let p = -Infinity
    for (let c = 0; c < classes; c++) {
      const v = probs[t * classes + c]!
      if (v > p) (p = v), (best = c)
    }
    if (best !== 0 && best !== prev) {
      text += best - 1 < dict.length ? dict[best - 1] : ' '
      sum += p
      n++
    }
    prev = best
  }
  return { text: text.trim(), score: n ? sum / n : 0 }
}

// The text regions of the detector's probability map: connected pixels over 0.2, kept when their
// mean is over 0.45, each grown as PP-OCR's unclip does (by area × 1.4 / perimeter).
export function textRegions(map: Float32Array, w: number, h: number, thresh = 0.2, boxThresh = 0.45, unclip = 1.4): Box[] {
  const seen = new Uint8Array(w * h)
  const boxes: Box[] = []
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || map[start]! <= thresh) continue
    let x0 = w
    let y0 = h
    let x1 = -1
    let y1 = -1
    let sum = 0
    let count = 0
    stack.push(start)
    seen[start] = 1
    while (stack.length) {
      const i = stack.pop()!
      const x = i % w
      const y = (i - x) / w
      sum += map[i]!
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !seen[j] && map[j]! > thresh) (seen[j] = 1), stack.push(j)
    }
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    if (Math.min(bw, bh) < 3 || sum / count < boxThresh) continue
    const d = (bw * bh * unclip) / (2 * (bw + bh))
    const x = Math.max(0, x0 - d)
    const y = Math.max(0, y0 - d)
    boxes.push({ x, y, w: Math.min(w, x1 + 1 + d) - x, h: Math.min(h, y1 + 1 + d) - y })
    if (boxes.length >= 3000) break
  }
  return boxes
}

// Reading order: top to bottom, and left to right on a line.
export function readingOrder(lines: TextLine[]): TextLine[][] {
  const rows: TextLine[][] = []
  for (const l of [...lines].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2))) {
    const row = rows.at(-1)
    const mid = l.box.y + l.box.h / 2
    const ref = row?.[0]
    if (row && ref && Math.abs(mid - (ref.box.y + ref.box.h / 2)) < Math.min(l.box.h, ref.box.h) / 2) row.push(l)
    else rows.push([l])
  }
  return rows.map((r) => r.sort((a, b) => a.box.x - b.box.x))
}

const inside = (b: Box, outer: Box): boolean => {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  return cx >= outer.x && cx <= outer.x + outer.w && cy >= outer.y && cy <= outer.y + outer.h
}

// What an element OmniParser found most likely is, from its shape and the text inside it: the model
// itself only says where something clickable is.
export function elementKind(box: Box, texts: TextLine[], image: { width: number; height: number }): Element['kind'] {
  const area = (box.w * box.h) / (image.width * image.height)
  if (texts.length >= 2 && area > 0.02) return 'card'
  if (texts.length === 0) return box.w / box.h > 4 ? 'field' : 'icon'
  if (box.h < image.height * 0.08 && box.w / box.h < 12) return 'button'
  return 'text'
}

// COCO's 80 classes, in the order the detectors give them (DEIMv2, D-FINE, YOLO).
const COCO = 'person,bicycle,car,motorcycle,airplane,bus,train,truck,boat,traffic light,fire hydrant,stop sign,parking meter,bench,bird,cat,dog,horse,sheep,cow,elephant,bear,zebra,giraffe,backpack,umbrella,handbag,tie,suitcase,frisbee,skis,snowboard,sports ball,kite,baseball bat,baseball glove,skateboard,surfboard,tennis racket,bottle,wine glass,cup,fork,knife,spoon,bowl,banana,apple,sandwich,orange,broccoli,carrot,hot dog,pizza,donut,cake,chair,couch,potted plant,bed,dining table,toilet,tv,laptop,mouse,remote,keyboard,cell phone,microwave,oven,toaster,sink,refrigerator,book,clock,vase,scissors,teddy bear,hair drier,toothbrush'.split(',')

export class LocalVision {
  private sessions = new Map<string, Promise<Loaded>>()
  private dict: { from: string; chars: string[] } | null = null
  private paths: Paths = {}
  private idle: ReturnType<typeof setTimeout> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private waiting = 0
  private abort: AbortController | null = null
  private pending: LocalModelId[] = [] // turned on while another was downloading: next, in order
  progress: { model: LocalModelId; received: number; total: number } | null = null
  error: { model: LocalModelId; message: string } | null = null
  devices: Partial<Record<LocalModelId, string>> = {} // where each model ran last

  constructor(
    private dir: string, // shared by every workspace
    private changed: () => void,
    private fetcher: typeof fetch = fetch,
    private models = LOCAL_MODELS, // tests use small ones
    private gpu: Device | undefined = gpuFor()
  ) {}

  downloaded(): LocalModelId[] {
    return LOCAL_MODEL_IDS.filter((id) => Object.keys(this.models[id].files).every((f) => existsSync(join(this.dir, f))))
  }

  // With anything of it on this computer: all of it, or part (one of its files is new, or an earlier
  // version's file is still here). What turning it off deletes.
  stored(): LocalModelId[] {
    return LOCAL_MODEL_IDS.filter((id) => [...Object.keys(this.models[id].files), ...REPLACED[id]].some((f) => existsSync(join(this.dir, f))))
  }

  // A file of a model: the person's own, when the advanced settings give one, else the app's.
  private file(name: string, paths: Paths = this.paths): string {
    return paths?.[PATH_OF[name]!] || join(this.dir, name)
  }

  ready(paths?: Paths): LocalModelId[] {
    return LOCAL_MODEL_IDS.filter((id) => Object.keys(this.models[id].files).every((f) => existsSync(this.file(f, paths))))
  }

  status(paths?: Paths): LocalModelsStatus {
    return {
      downloaded: this.downloaded(),
      stored: this.stored(),
      ready: this.ready(paths),
      devices: this.devices,
      ...(this.gpu ? { gpu: deviceName(this.gpu) } : {}),
      queued: this.waiting,
      ...(this.pending.length ? { waiting: [...this.pending] } : {}),
      ...(this.progress ? { downloading: this.progress } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }

  // One download at a time, the others waiting their turn (several switches turned on at once).
  // Files already here (from another workspace, or an earlier try) aren't fetched again.
  async download(id: LocalModelId): Promise<void> {
    if (this.progress?.model === id || this.pending.includes(id)) return
    this.pending.push(id)
    this.changed()
    if (this.abort) return // the one going on takes it next
    while (this.pending.length) await this.fetchModel(this.pending.shift()!)
  }

  private async fetchModel(id: LocalModelId): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    this.error = null
    const missing = Object.entries(this.models[id].files).filter(([f]) => !existsSync(join(this.dir, f)))
    const progress = { model: id, received: modelBytes(id, this.models) - missing.reduce((n, [, f]) => n + f.bytes, 0), total: modelBytes(id, this.models) }
    this.progress = progress
    this.changed()
    let last = 0
    try {
      for (const [name, file] of missing)
        await fetchPinned(this.fetcher, file, join(this.dir, name), abort.signal, (n) => {
          progress.received += n
          if (Date.now() - last > 250) (last = Date.now()), this.changed()
        })
    } catch (e) {
      if (!abort.signal.aborted) this.error = { model: id, message: e instanceof Error ? e.message : String(e) }
    } finally {
      if (this.abort === abort) {
        this.abort = null
        this.progress = null
      }
      this.changed()
    }
  }

  // That model's download (waiting or going on); with none named, all of them.
  cancel(id?: LocalModelId): void {
    this.pending = id ? this.pending.filter((p) => p !== id) : []
    if (!id || this.progress?.model === id) this.abort?.abort()
    this.changed()
  }

  // Gone from this computer, so from every workspace (each one sees it as not downloaded).
  remove(id: LocalModelId): void {
    for (const f of [...Object.keys(this.models[id].files), ...REPLACED[id]]) {
      this.sessions.delete(join(this.dir, f))
      rmSync(join(this.dir, f), { force: true })
    }
    if (id === 'ocr') this.dict = null
    this.changed()
  }

  // The models that are both on in these settings and here.
  usable(on: LocalModelsSettings | undefined): LocalModelId[] {
    const here = this.ready(on?.paths)
    return LOCAL_MODEL_IDS.filter((id) => on?.[id] && here.includes(id))
  }

  // In the queue: one image at a time, whichever workspace's chat it came from in this core.
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.waiting++
    this.changed()
    const run = this.queue.then(job, job).finally(() => {
      this.waiting--
      this.changed()
      this.release()
    })
    this.queue = run.catch(() => {})
    return run
  }

  // Whether these bytes are a type the person keeps for the local models (by what the file is).
  accepts(bytes: Buffer, settings: LocalModelsSettings | undefined): boolean {
    return localTypeOn(settings?.types, bytes.subarray(0, 5).toString('latin1') === '%PDF-' ? 'pdf' : sniff(bytes))
  }

  // An image, read by the models on. `null` when none could, or it's a type left out: the image goes
  // to the AI as it is.
  read(bytes: Buffer, settings: LocalModelsSettings | undefined): Promise<ImageRead | null> {
    const on = this.usable(settings)
    if (on.length === 0 || !this.accepts(bytes, settings)) return Promise.resolve(null)
    return this.enqueue(async () => {
      this.paths = settings?.paths ?? {}
      const original = await decodeImage(bytes)
      return this.readImage(original, on)
    }).catch(() => null)
  }

  // The images a scanned PDF's pages hold, read as text, page by page. `null` when no text came out.
  readPdf(bytes: Buffer, settings: LocalModelsSettings | undefined): Promise<string | null> {
    if (!this.usable(settings).includes('ocr') || !this.accepts(bytes, settings)) return Promise.resolve(null)
    return this.enqueue(async () => {
      this.paths = settings?.paths ?? {}
      const { extractImages, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(new Uint8Array(bytes))
      const pages: string[] = []
      for (let p = 1; p <= Math.min(pdf.numPages, 50); p++) {
        const imgs = await extractImages(pdf, p).catch(() => [])
        const text: string[] = []
        for (const im of imgs) {
          if (im.width < 32 || im.height < 32) continue
          const r = await this.readImage({ w: im.width, h: im.height, data: im.data }, ['ocr']) // unpdf gives RGBA
          if (r.text?.length) text.push(readingOrder(r.text).map((row) => row.map((l) => l.text).join('  ')).join('\n'))
        }
        if (text.length) pages.push(`${L('Página', 'Page')} ${p}\n\n${text.join('\n\n')}`)
      }
      return pages.length ? pages.join('\n\n') : null
    }).catch(() => null)
  }

  private async readImage(original: Rgba, on: LocalModelId[]): Promise<ImageRead> {
    const img = fit(original, MAX_SIDE)
    const back = original.w / img.w // to the original's pixels, which is what the agent knows
    // In the original's pixels, inside the image.
    const scale = (b: Box): Box => {
      const x = Math.max(0, Math.round(b.x * back))
      const y = Math.max(0, Math.round(b.y * back))
      return { x, y, w: Math.min(original.w, Math.round((b.x + b.w) * back)) - x, h: Math.min(original.h, Math.round((b.y + b.h) * back)) - y }
    }
    const out: ImageRead = { width: original.w, height: original.h, failed: {} }
    const attempt = async <T>(id: LocalModelId, f: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await f()
      } catch (e) {
        out.failed[id] = e instanceof Error ? e.message : String(e)
        return undefined
      }
    }
    // The text first: OmniParser's elements are told apart by the text in them.
    const wantsText = on.includes('ocr') || on.includes('ui')
    const text = wantsText && this.ready(this.paths).includes('ocr') ? await attempt('ocr', () => this.ocr(img)) : undefined
    if (on.includes('ocr') && text) out.text = text.map((l) => ({ ...l, box: scale(l.box) }))
    if (on.includes('ui')) {
      const els = await attempt('ui', () => this.elements(img, text ?? []))
      if (els) out.elements = els.map((e) => ({ ...e, box: scale(e.box) }))
    }
    if (on.includes('objects')) {
      const things = await attempt('objects', () => this.objects(img))
      if (things) out.objects = things.map((t) => ({ ...t, box: scale(t.box) }))
    }
    return out
  }

  private async ort(): Promise<Ort> {
    return (await import('onnxruntime-node')) as Ort
  }

  // A model's session, on the GPU when there is one that takes it, else on the CPU.
  private session(file: string, id: LocalModelId, cpuOnly = false): Promise<Loaded> {
    const path = this.file(file)
    const key = cpuOnly ? `${path}#cpu` : path
    let s = this.sessions.get(key)
    if (!s) {
      s = (async () => {
        const ort = await this.ort()
        if (this.gpu && !cpuOnly)
          try {
            return { session: await ort.InferenceSession.create(path, { executionProviders: [this.gpu, 'cpu'] }), device: this.gpu }
          } catch {
            // no driver, no provider library (the app leaves CUDA's out), a model the GPU can't take
          }
        return { session: await ort.InferenceSession.create(path, { executionProviders: ['cpu'] }), device: 'cpu' as const }
      })()
      s.catch(() => this.sessions.delete(key))
      this.sessions.set(key, s)
    }
    return s.then((l) => ((this.devices[id] = deviceName(l.device)), l))
  }

  // A run that fails on the GPU is run again on the CPU, and the model stays there.
  private async run(file: string, id: LocalModelId, feeds: Record<string, Tensor>): Promise<InferenceSession.OnnxValueMapType> {
    const loaded = await this.session(file, id)
    try {
      return await loaded.session.run(feeds)
    } catch (e) {
      if (loaded.device === 'cpu') throw e
      const cpu = await this.session(file, id, true)
      this.sessions.set(this.file(file), Promise.resolve(cpu))
      return cpu.session.run(feeds)
    }
  }

  private async ocr(img: Rgba): Promise<TextLine[]> {
    const ort = await this.ort()
    const from = this.file('ocr-rec.yml')
    if (this.dict?.from !== from) this.dict = { from, chars: ocrDictionary(readFileSync(from, 'utf8')) }
    const dict = this.dict.chars
    // Detection, on the image brought to multiples of 32 (no side over 960).
    const k = Math.min(1, 960 / Math.max(img.w, img.h))
    const dw = Math.max(32, Math.round((img.w * k) / 32) * 32)
    const dh = Math.max(32, Math.round((img.h * k) / 32) * 32)
    const det = await this.run('ocr-tiny-det.onnx', 'ocr', { x: new ort.Tensor('float32', planar(resize(img, dw, dh), [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], true), [1, 3, dh, dw]) })
    const map = Object.values(det)[0]!.data as Float32Array
    const regions = textRegions(map, dw, dh).map((b) => ({ x: (b.x * img.w) / dw, y: (b.y * img.h) / dh, w: (b.w * img.w) / dw, h: (b.h * img.h) / dh }))
    // Recognition, region by region, each brought to 48 px high.
    const lines: TextLine[] = []
    for (const box of regions) {
      if (box.w < 2 || box.h < 2) continue
      const rw = Math.min(3200, Math.max(16, Math.round((48 * box.w) / box.h)))
      const crop = resize(img, rw, 48, box)
      const rec = await this.run('ocr-rec.onnx', 'ocr', { x: new ort.Tensor('float32', planar(crop, [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], true), [1, 3, 48, rw]) })
      const t = Object.values(rec)[0]!
      const [, steps, classes] = t.dims as number[]
      const r = ctcDecode(t.data as Float32Array, steps!, classes!, dict)
      if (r.text && r.score >= 0.5) lines.push({ text: r.text, box, score: r.score })
    }
    return lines
  }

  // Letterboxed into 640×640, as YOLO is trained: the proportions kept, the rest gray.
  private letterbox(img: Rgba): { data: Float32Array; k: number } {
    const k = 640 / Math.max(img.w, img.h)
    const inner = resize(img, Math.max(1, Math.round(img.w * k)), Math.max(1, Math.round(img.h * k)))
    const n = 640 * 640
    const data = new Float32Array(3 * n).fill(114 / 255)
    for (let y = 0; y < inner.h; y++)
      for (let x = 0; x < inner.w; x++) for (let c = 0; c < 3; c++) data[c * n + y * 640 + x] = inner.data[(y * inner.w + x) * 4 + c]! / 255
    return { data, k }
  }

  private async elements(img: Rgba, text: TextLine[]): Promise<Element[]> {
    const ort = await this.ort()
    const { data, k } = this.letterbox(img)
    const loaded = await this.session('omniparser-v2.onnx', 'ui')
    const res = await this.run('omniparser-v2.onnx', 'ui', { [loaded.session.inputNames[0]!]: new ort.Tensor('float32', data, [1, 3, 640, 640]) })
    const t = Object.values(res)[0]!
    const out = t.data as Float32Array
    const n = (t.dims as number[])[2]!
    const found: { box: Box; score: number }[] = []
    for (let i = 0; i < n; i++) {
      const score = out[4 * n + i]!
      if (score < UI_CONFIDENCE) continue
      const w = out[2 * n + i]! / k
      const h = out[3 * n + i]! / k
      found.push({ box: { x: out[i]! / k - w / 2, y: out[n + i]! / k - h / 2, w, h }, score })
    }
    const image = { width: img.w, height: img.h }
    return nms(found, 0.3)
      .slice(0, 200)
      .map(({ box, score }) => {
        const mine = text.filter((l) => inside(l.box, box))
        return { kind: elementKind(box, mine, image), box, score, text: readingOrder(mine).map((r) => r.map((l) => l.text).join(' ')).join(' / ') }
      })
      .sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)
  }

  // A DETR-style detector (DEIMv2, D-FINE, RT-DETR, or YOLO26 as onnx-community exports it):
  // logits (or pred_logits) and boxes, 0–1, on the image stretched to 640, pixels just /255. Or a
  // YOLO of one's own as Ultralytics exports it: end to end (300 × x1 y1 x2 y2 score class) or with
  // the classes per anchor (4 + classes × 8400, NMS here), both letterboxed.
  private async objects(img: Rgba): Promise<Thing[]> {
    const ort = await this.ort()
    const { session } = await this.session('deimv2-n.onnx', 'objects')
    const input = session.inputNames[0]!
    const things: Thing[] = []
    const label = (c: number): string => COCO[c] ?? `class ${c}`
    const detr = ['logits', 'pred_logits'].find((n) => session.outputNames.includes(n))
    if (detr && session.outputNames.includes('pred_boxes')) {
      const res = await this.run('deimv2-n.onnx', 'objects', { [input]: new ort.Tensor('float32', planar(resize(img, 640, 640), [0, 0, 0], [1, 1, 1], false), [1, 3, 640, 640]) })
      const logits = res[detr]!.data as Float32Array
      const boxes = res['pred_boxes']!.data as Float32Array
      const [, queries, classes] = res[detr]!.dims as number[]
      for (let q = 0; q < queries!; q++) {
        let best = 0
        let p = -Infinity
        for (let c = 0; c < classes!; c++) if (logits[q * classes! + c]! > p) (p = logits[q * classes! + c]!), (best = c)
        const score = 1 / (1 + Math.exp(-p))
        if (score < OBJECT_CONFIDENCE) continue
        const [cx, cy, w, h] = [boxes[q * 4]!, boxes[q * 4 + 1]!, boxes[q * 4 + 2]!, boxes[q * 4 + 3]!]
        things.push({ label: label(best), score, box: { x: (cx - w / 2) * img.w, y: (cy - h / 2) * img.h, w: w * img.w, h: h * img.h } })
      }
    } else {
      const { data, k } = this.letterbox(img)
      const res = await this.run('deimv2-n.onnx', 'objects', { [input]: new ort.Tensor('float32', data, [1, 3, 640, 640]) })
      const t = Object.values(res)[0]!
      const out = t.data as Float32Array
      const [, a, b] = t.dims as number[]
      if (b === 6) {
        for (let q = 0; q < a!; q++) {
          const [x1, y1, x2, y2, score, c] = Array.from(out.subarray(q * 6, q * 6 + 6))
          if (score! >= OBJECT_CONFIDENCE) things.push({ label: label(Math.round(c!)), score: score!, box: { x: x1! / k, y: y1! / k, w: (x2! - x1!) / k, h: (y2! - y1!) / k } })
        }
      } else {
        const n = b!
        for (let i = 0; i < n; i++) {
          let best = 0
          let score = 0
          for (let c = 0; c < a! - 4; c++) if (out[(4 + c) * n + i]! > score) (score = out[(4 + c) * n + i]!), (best = c)
          if (score < OBJECT_CONFIDENCE) continue
          const w = out[2 * n + i]! / k
          const h = out[3 * n + i]! / k
          things.push({ label: label(best), score, box: { x: out[i]! / k - w / 2, y: out[n + i]! / k - h / 2, w, h } })
        }
      }
    }
    return nms(things, 0.7).sort((x, y) => y.score - x.score)
  }

  // Unused for a while: the models' memory goes back to the computer; the next image loads them again.
  private release(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (this.waiting) return
      const all = [...this.sessions.values()]
      this.sessions.clear()
      for (const s of all) void s.then((l) => l.session.release()).catch(() => {})
    }, IDLE_MS)
    this.idle.unref?.()
  }
}

// ---------- what the agent gets ----------

const KIND = (k: Element['kind']): string =>
  ({ button: L('botão ou link', 'button or link'), icon: L('ícone', 'icon'), card: L('cartão', 'card'), text: L('texto', 'text'), field: L('campo', 'field') })[k]
const at = (b: Box): string => `(x ${b.x}, y ${b.y}, ${b.w}×${b.h})`
const pct = (n: number): string => `${Math.round(n * 100)}%`

// The read, as the text that goes to the agent in the image's place. `null` when there's nothing
// in it (every model failed, found nothing, or only shapes with no words): then the image itself goes.
export function describeRead(name: string, r: ImageRead | null): string | null {
  if (!r) return null
  const parts: string[] = []
  if (r.text?.length)
    parts.push(`${L('Texto na imagem (OCR, PP-OCRv6):', 'Text in the image (OCR, PP-OCRv6):')}\n${readingOrder(r.text).map((row) => row.map((l) => l.text).join('  ')).join('\n')}`)
  if (r.elements?.length)
    parts.push(
      `${L('Elementos da tela (OmniParser v2; o tipo é uma estimativa pela forma e o texto; posições em pixels):', 'Screen elements (OmniParser v2; the kind is a guess from shape and text; positions in pixels):')}\n${r.elements.map((e) => `- ${KIND(e.kind)}${e.text ? ` "${e.text}"` : ''} ${at(e.box)}`).join('\n')}`
    )
  if (r.objects?.length) {
    const counts = new Map<string, number[]>()
    for (const o of r.objects) counts.set(o.label, [...(counts.get(o.label) ?? []), o.score])
    parts.push(
      `${L(`Objetos (DEIMv2, confiança de ${pct(OBJECT_CONFIDENCE)} pra cima, nomes em inglês):`, `Objects (DEIMv2, confidence ${pct(OBJECT_CONFIDENCE)} and up):`)}\n${[...counts].map(([label, s]) => `- ${s.length > 1 ? `${s.length} × ` : ''}${label} (${s.map(pct).join(', ')})`).join('\n')}`
    )
  }
  // Only boxes without words (a logo, a drawing): that says nothing the image wouldn't, so it goes instead.
  if (!r.text?.length && !r.objects?.length && !r.elements?.some((e) => e.text)) return null
  const head = L(
    `[imagem anexada: ${name}, ${r.width}×${r.height}. Lida neste computador pelos modelos locais: a imagem em si não veio pra você.]`,
    `[attached image: ${name}, ${r.width}×${r.height}. Read on this computer by the local models: the image itself didn't come to you.]`
  )
  return `${head}\n${parts.join('\n\n')}\n${L(`[fim de ${name}]`, `[end of ${name}]`)}`
}
