// Images in the formats people attach, as pixels, and back as a lighter file. PNG, JPEG, WebP, AVIF,
// GIF (its first frame), BMP and TIFF are read; what the AI doesn't take (AVIF, BMP, TIFF), or a file
// over its size, goes as WebP. All in JS and WebAssembly (jSquash's codecs, from Squoosh): nothing
// native, the same on every system.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { L } from '../shared/lang'
import { IMAGE_MIMES, MAX_IMAGE_BYTES } from '../shared/types'

export interface Rgba {
  w: number
  h: number
  data: Uint8Array // 4 bytes a pixel
}

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif' | 'bmp' | 'tiff' | 'heic'

const ascii = (b: Buffer, from: number, to: number): string => b.subarray(from, to).toString('latin1')

// What the bytes are, whatever the name or the type that came with them says.
export function sniff(b: Buffer): ImageFormat | undefined {
  if (b.length < 12) return undefined
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp'
  if (ascii(b, 0, 4) === 'GIF8') return 'gif'
  if (ascii(b, 0, 2) === 'BM') return 'bmp'
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*') return 'tiff'
  if (ascii(b, 4, 8) === 'ftyp') {
    const brands = ascii(b, 8, Math.min(b.length, 8 + Math.max(8, b.readUInt32BE(0) - 8)))
    if (/avi[fs]/.test(brands)) return 'avif'
    if (/hei[cxms]|hev[cx]|mif1|msf1/.test(brands)) return 'heic'
  }
  return undefined
}

export const MIME: Record<ImageFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp', tiff: 'image/tiff', heic: 'image/heic' }

// ---------- the WebAssembly codecs ----------

type Emscripten = { decode?: (b: ArrayBuffer | Uint8Array, bitDepth?: number) => { data: Uint8ClampedArray; width: number; height: number } | null; encode?: (data: Uint8ClampedArray, w: number, h: number, opts: Record<string, number>) => Uint8Array | null }
const req = createRequire(import.meta.url)
// The codecs make an ImageData, which Node doesn't have: a plain one does.
const g = globalThis as { ImageData?: unknown }
g.ImageData ??= class {
  constructor(
    public data: Uint8ClampedArray,
    public width: number,
    public height: number
  ) {}
}

const codecs = new Map<string, Promise<Emscripten>>()
// Each codec's module, instantiated once from its .wasm beside it (by path: the packaged app has no fetch for it).
function codec(js: string, wasm: string): Promise<Emscripten> {
  let c = codecs.get(js)
  if (!c) {
    c = (async () => {
      const factory = ((await import(/* @vite-ignore */ req.resolve(js))) as { default: (o: object) => Promise<Emscripten> }).default
      const mod = await WebAssembly.compile(readFileSync(req.resolve(wasm)))
      return factory({
        noInitialRun: true,
        instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => {
          const instance = new WebAssembly.Instance(mod, imports)
          done(instance)
          return instance.exports
        }
      })
    })()
    c.catch(() => codecs.delete(js))
    codecs.set(js, c)
  }
  return c
}
const webpDecoder = () => codec('@jsquash/webp/codec/dec/webp_dec.js', '@jsquash/webp/codec/dec/webp_dec.wasm')
const webpEncoder = () => codec('@jsquash/webp/codec/enc/webp_enc.js', '@jsquash/webp/codec/enc/webp_enc.wasm')
const avifDecoder = () => codec('@jsquash/avif/codec/dec/avif_dec.js', '@jsquash/avif/codec/dec/avif_dec.wasm')

const rgba = (d: { data: Uint8ClampedArray | Uint8Array; width: number; height: number }): Rgba => ({ w: d.width, h: d.height, data: new Uint8Array(d.data.buffer, d.data.byteOffset, d.data.length) })

// ---------- BMP, small enough to read here ----------

// Uncompressed (or BITFIELDS) 24- and 32-bit, and 8-bit with a palette: what screenshots and exports make.
export function decodeBmp(b: Buffer): Rgba {
  const offset = b.readUInt32LE(10)
  const header = b.readUInt32LE(14)
  const w = b.readInt32LE(18)
  const rawH = b.readInt32LE(22)
  const bpp = b.readUInt16LE(28)
  const compression = b.readUInt32LE(30)
  if (w <= 0 || rawH === 0 || w * Math.abs(rawH) > 100_000_000) throw new Error('bmp size')
  if (![0, 3].includes(compression) || ![8, 24, 32].includes(bpp)) throw new Error(L('Esse BMP é comprimido de um jeito que não leio.', "This BMP is compressed in a way I can't read."))
  const h = Math.abs(rawH)
  const stride = Math.ceil((w * bpp) / 32) * 4
  const palette = 14 + header
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const row = offset + (rawH > 0 ? h - 1 - y : y) * stride
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (bpp === 8) {
        const p = palette + b[row + x]! * 4
        ;(out[o] = b[p + 2]!), (out[o + 1] = b[p + 1]!), (out[o + 2] = b[p]!), (out[o + 3] = 255)
      } else {
        const p = row + x * (bpp / 8)
        ;(out[o] = b[p + 2]!), (out[o + 1] = b[p + 1]!), (out[o + 2] = b[p]!), (out[o + 3] = bpp === 32 ? b[p + 3]! || 255 : 255)
      }
    }
  }
  return { w, h, data: out }
}

// ---------- in and out ----------

export async function decodeImage(bytes: Buffer): Promise<Rgba> {
  const format = sniff(bytes)
  switch (format) {
    case 'png': {
      const { PNG } = await import('pngjs')
      const png = PNG.sync.read(bytes)
      return { w: png.width, h: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) }
    }
    case 'jpeg': {
      const jpeg = await import('jpeg-js')
      const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 200 })
      return { w: img.width, h: img.height, data: img.data }
    }
    case 'webp':
    case 'avif': {
      const m = await (format === 'webp' ? webpDecoder() : avifDecoder())
      const r = format === 'webp' ? m.decode!(new Uint8Array(bytes)) : m.decode!(new Uint8Array(bytes), 8)
      if (!r) throw new Error(L('Não consegui abrir essa imagem.', "I couldn't open this image."))
      return rgba(r)
    }
    case 'gif': {
      const { GifReader } = await import('omggif')
      const gif = new GifReader(new Uint8Array(bytes))
      const data = new Uint8Array(gif.width * gif.height * 4)
      gif.decodeAndBlitFrameRGBA(0, data)
      return { w: gif.width, h: gif.height, data }
    }
    case 'bmp':
      return decodeBmp(bytes)
    case 'tiff': {
      const UTIF = (await import('utif2')).default
      const ifds = UTIF.decode(bytes)
      const first = ifds[0]
      if (!first) throw new Error('tiff')
      UTIF.decodeImage(bytes, first)
      return { w: first.width, h: first.height, data: UTIF.toRGBA8(first) }
    }
    default:
      throw new Error(L('Não leio esse formato de imagem (use PNG, JPEG, WebP, AVIF, GIF, BMP ou TIFF).', "I can't read this image format (use PNG, JPEG, WebP, AVIF, GIF, BMP or TIFF)."))
  }
}

export async function encodeWebp(img: Rgba, quality = 82): Promise<Buffer> {
  const m = await webpEncoder()
  const { defaultOptions } = (await import(/* @vite-ignore */ req.resolve('@jsquash/webp/meta.js'))) as { defaultOptions: Record<string, number> }
  const out = m.encode!(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.w, img.h, { ...defaultOptions, quality })
  if (!out) throw new Error('webp')
  return Buffer.from(out)
}

// Bilinear, from a part of the image (all of it by default) to w×h.
export function resize(img: Rgba, w: number, h: number, from: { x: number; y: number; w: number; h: number } = { x: 0, y: 0, w: img.w, h: img.h }): Rgba {
  const out = new Uint8Array(w * h * 4)
  const sx = from.w / w
  const sy = from.h / h
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.h - 1, Math.max(0, from.y + (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(img.h - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.w - 1, Math.max(0, from.x + (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(img.w - 1, x0 + 1)
      const tx = fx - x0
      for (let c = 0; c < 4; c++) {
        const a = img.data[(y0 * img.w + x0) * 4 + c]!
        const b = img.data[(y0 * img.w + x1) * 4 + c]!
        const d = img.data[(y1 * img.w + x0) * 4 + c]!
        const e = img.data[(y1 * img.w + x1) * 4 + c]!
        out[(y * w + x) * 4 + c] = Math.round((a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty)
      }
    }
  }
  return { w, h, data: out }
}

// No side over `max`, the proportions kept.
export function fit(img: Rgba, max: number): Rgba {
  const side = Math.max(img.w, img.h)
  if (side <= max) return img
  const k = max / side
  return resize(img, Math.max(1, Math.round(img.w * k)), Math.max(1, Math.round(img.h * k)))
}

export const MAX_IMAGE_INPUT_BYTES = 30 * 1024 * 1024 // what may come in to be converted
const AI_SIDE = 2000 // the models shrink anything bigger themselves

// An attached image as the AI takes it: as it came when it's a type the AI reads and within its
// size; else as a WebP (smaller, and at most 2000 px), lighter the more it needs to be.
export async function forAgents(bytes: Buffer, name: string, mime: string): Promise<{ data: Buffer; mime: string; name: string }> {
  if (IMAGE_MIMES.includes(mime) && bytes.length <= MAX_IMAGE_BYTES) return { data: bytes, mime, name }
  const img = fit(await decodeImage(bytes), AI_SIDE)
  const base = name.replace(/\.[a-z0-9]+$/i, '')
  for (const [q, side] of [[82, AI_SIDE], [70, 1600], [60, 1200]] as const) {
    const data = await encodeWebp(fit(img, side), q)
    if (data.length <= MAX_IMAGE_BYTES) return { data, mime: 'image/webp', name: `${base}.webp` }
  }
  throw new Error(L('Essa imagem é grande demais.', 'This image is too big.'))
}
