// A bitmap that is small enough as a file can still become a data URL too long for a connector or a
// workspace picture. The picker redraws it at smaller ceilings before it gives up, so a noisy mark
// gets stored and neither picker needs to tell the person about a failure that did not happen.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLang } from '../src/shared/lang'
import { ICON_PX_STEPS, iconFromFile } from '../src/renderer/src/connector-icon'

const drawn: number[] = []
let bytesPerPixel = 350
let closed = 0

const bitmap = (width: number, height: number): ImageBitmap => ({ width, height, close: () => { closed += 1 } }) as unknown as ImageBitmap
const image = (type: string, size = 1_000): File => ({ type, size, text: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }) as unknown as File

beforeEach(() => {
  setLang('en')
  drawn.length = 0
  closed = 0
  bytesPerPixel = 350
  vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap(500, 400)))
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({ drawImage: vi.fn() }),
        toDataURL: () => {
          drawn.push(Math.max(canvas.width, canvas.height))
          return `data:image/png;base64,${'A'.repeat(Math.max(canvas.width, canvas.height) * bytesPerPixel)}`
        }
      }
      return canvas
    }
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('an oversized bitmap for a connector or a workspace', () => {
  it('redraws at smaller ceilings until the PNG fits, and closes the bitmap once', async () => {
    expect(ICON_PX_STEPS).toEqual([96, 80, 64, 48, 32, 16])
    const data = await iconFromFile(image('image/png'))
    expect(drawn).toEqual([96, 80])
    expect(data.startsWith('data:image/png;base64,')).toBe(true)
    expect(data.length).toBeLessThanOrEqual(32_000)
    expect(closed).toBe(1)
  })

  it('keeps the first 96 px pass when it already fits', async () => {
    bytesPerPixel = 100
    const data = await iconFromFile(image('image/webp'))
    expect(drawn).toEqual([96])
    expect(data.length).toBeLessThanOrEqual(32_000)
  })

  it('tries every ceiling and rejects a bitmap that never fits', async () => {
    bytesPerPixel = 1_000_000
    await expect(iconFromFile(image('image/png'))).rejects.toThrow(/too big for an icon/)
    expect(drawn).toEqual([96, 80, 64, 48, 32, 16])
    expect(closed).toBe(1)
  })

  it('still refuses an unreadable file, a file over 4 MB and an unsafe SVG', async () => {
    vi.mocked(createImageBitmap).mockRejectedValueOnce(new Error('broken'))
    await expect(iconFromFile(image('image/png'))).rejects.toThrow(/couldn't read/)
    await expect(iconFromFile(image('image/png', 4 * 1024 * 1024 + 1))).rejects.toThrow(/4 MB/)
    await expect(iconFromFile(image('text/plain'))).rejects.toThrow(/image file/)
    const svg = { type: 'image/svg+xml', size: 100, text: async () => '<svg><script>alert(1)</script></svg>' } as unknown as File
    await expect(iconFromFile(svg)).rejects.toThrow(/script or HTML/)
    expect(drawn).toEqual([])
  })

  it('keeps a safe SVG untouched', async () => {
    const svg = { type: 'image/svg+xml', size: 100, text: async () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>' } as unknown as File
    expect(await iconFromFile(svg)).toBe('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg==')
    expect(drawn).toEqual([])
  })
})
