import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GifWriter } from 'omggif'
import { PNG } from 'pngjs'
import UTIF from 'utif2'
import { describe, expect, it } from 'vitest'
import { decodeImage, encodeWebp, forAgents, sniff, type Rgba } from '../src/core/images'
import { MAX_IMAGE_BYTES } from '../src/shared/types'

// The formats people attach, read as pixels; what the AI doesn't take goes as a lighter WebP.

const W = 24
const H = 16
// Left half red, right half blue: each format must bring back the same two colors.
const pixels = (): Uint8Array => {
  const d = new Uint8Array(W * H * 4)
  for (let i = 0; i < W * H; i++) d.set(i % W < W / 2 ? [230, 40, 20, 255] : [20, 40, 230, 255], i * 4)
  return d
}
const at = (img: Rgba, x: number, y: number): number[] => [...img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 3)]
const redAndBlue = (img: Rgba): void => {
  expect([img.w, img.h]).toEqual([W, H])
  const [r1, , b1] = at(img, 2, 8)
  const [r2, , b2] = at(img, W - 3, 8)
  expect(r1!).toBeGreaterThan(180)
  expect(b1!).toBeLessThan(80)
  expect(b2!).toBeGreaterThan(180)
  expect(r2!).toBeLessThan(80)
}

const png = (): Buffer => {
  const p = new PNG({ width: W, height: H })
  p.data.set(pixels())
  return PNG.sync.write(p)
}
const bmp = (): Buffer => {
  const stride = Math.ceil((W * 3) / 4) * 4
  const b = Buffer.alloc(54 + stride * H)
  b.write('BM', 0, 'latin1')
  b.writeUInt32LE(b.length, 2)
  b.writeUInt32LE(54, 10)
  b.writeUInt32LE(40, 14)
  b.writeInt32LE(W, 18)
  b.writeInt32LE(H, 22) // bottom-up
  b.writeUInt16LE(1, 26)
  b.writeUInt16LE(24, 28)
  const px = pixels()
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (y * W + x) * 4
      const o = 54 + (H - 1 - y) * stride + x * 3
      ;(b[o] = px[s + 2]!), (b[o + 1] = px[s + 1]!), (b[o + 2] = px[s]!)
    }
  return b
}
const gif = (): Buffer => {
  const buf = Buffer.alloc(4096)
  const g = new GifWriter(buf, W, H, { palette: [0xe62814, 0x1428e6] })
  g.addFrame(0, 0, W, H, Array.from({ length: W * H }, (_, i) => (i % W < W / 2 ? 0 : 1)))
  return buf.subarray(0, g.end())
}
const tiff = (): Buffer => Buffer.from(UTIF.encodeImage(pixels(), W, H))

describe('images in the formats people attach', () => {
  it('knows each format by its bytes, not its name', async () => {
    expect(sniff(png())).toBe('png')
    expect(sniff(bmp())).toBe('bmp')
    expect(sniff(gif())).toBe('gif')
    expect(sniff(tiff())).toBe('tiff')
    expect(sniff(await encodeWebp({ w: W, h: H, data: pixels() }))).toBe('webp')
    expect(sniff(readFileSync(join(__dirname, 'fixtures', 'red-blue.avif')))).toBe('avif')
    expect(sniff(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic'))).toBe('heic')
    expect(sniff(Buffer.from('not an image, just text'))).toBeUndefined()
  })

  it('reads PNG, WebP, AVIF, GIF, BMP and TIFF', async () => {
    redAndBlue(await decodeImage(png()))
    redAndBlue(await decodeImage(await encodeWebp({ w: W, h: H, data: pixels() }, 95)))
    redAndBlue(await decodeImage(readFileSync(join(__dirname, 'fixtures', 'red-blue.avif'))))
    redAndBlue(await decodeImage(gif()))
    redAndBlue(await decodeImage(bmp()))
    redAndBlue(await decodeImage(tiff()))
    await expect(decodeImage(Buffer.from('\0\0\0\x18ftypheic\0\0\0\0mif1heic'))).rejects.toThrow(/PNG, JPEG, WebP/)
  })

  it('sends the AI what it takes as it is, and the rest as WebP', async () => {
    const asIs = await forAgents(png(), 'print.png', 'image/png')
    expect(asIs).toMatchObject({ mime: 'image/png', name: 'print.png' })
    for (const [bytes, name, mime] of [[readFileSync(join(__dirname, 'fixtures', 'red-blue.avif')), 'foto.avif', 'image/avif'], [bmp(), 'tela.bmp', 'image/bmp'], [tiff(), 'scan.tiff', 'image/tiff']] as const) {
      const out = await forAgents(bytes, name, mime)
      expect(out.mime).toBe('image/webp')
      expect(out.name).toBe(name.replace(/\.\w+$/, '.webp'))
      expect(sniff(out.data)).toBe('webp')
      redAndBlue(await decodeImage(out.data))
    }
  })

  it('a PNG over what the AI takes goes lighter, as WebP', { timeout: 60_000 }, async () => {
    // noise doesn't compress: a 1600×1200 PNG of it is over 5 MB
    const big = new PNG({ width: 1600, height: 1200 })
    let seed = 0x9e3779b9
    for (let i = 0; i < big.data.length; i++) {
      seed ^= seed << 13
      seed ^= seed >>> 17
      seed ^= seed << 5
      big.data[i] = i % 4 === 3 ? 255 : seed & 0xff
    }
    const bytes = PNG.sync.write(big)
    expect(bytes.length).toBeGreaterThan(MAX_IMAGE_BYTES)
    const out = await forAgents(bytes, 'ruido.png', 'image/png')
    expect(out.mime).toBe('image/webp')
    expect(out.data.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
  })
})
