import { describe, expect, it } from 'vitest'
import { GALLERY_MAX, galleryHeight, galleryLayout } from '../src/renderer/src/gallery'

// The pictures of one reply, laid out as an album: one large and the rest beside it, the golden
// section. What is tested here is the arithmetic — how many cells, which one is large, how many
// rows it covers and how many pictures are left over — not the CSS that draws them.

describe('the album of one reply', () => {
  it('is not an album with one picture or none', () => {
    expect(galleryLayout(0)).toEqual([])
    expect(galleryLayout(1)).toEqual([])
  })

  it('with two: one large and one beside it, side by side and full height', () => {
    const cells = galleryLayout(2)
    expect(cells).toEqual([
      { index: 0, hero: true, rowSpan: 1 },
      { index: 1, hero: false, rowSpan: 1 }
    ])
  })

  it('with three: the large one covers both rows the other two split', () => {
    const cells = galleryLayout(3)
    expect(cells).toEqual([
      { index: 0, hero: true, rowSpan: 2 },
      { index: 1, hero: false, rowSpan: 1 },
      { index: 2, hero: false, rowSpan: 1 }
    ])
  })

  it('with four, and with more: three beside it at most, the last one counting what is left', () => {
    expect(galleryLayout(4)).toEqual([
      { index: 0, hero: true, rowSpan: 3 },
      { index: 1, hero: false, rowSpan: 1 },
      { index: 2, hero: false, rowSpan: 1 },
      { index: 3, hero: false, rowSpan: 1 }
    ])
    for (const n of [5, 6, 9, 40]) {
      const cells = galleryLayout(n)
      expect(cells).toHaveLength(GALLERY_MAX)
      expect(cells[0]).toEqual({ index: 0, hero: true, rowSpan: 3 })
      expect(cells.at(-1)).toEqual({ index: GALLERY_MAX - 1, hero: false, rowSpan: 1, more: n - GALLERY_MAX })
      expect(cells.filter((c) => c.more)).toHaveLength(1) // only the last cell counts
    }
  })

  it('shows every picture once, in order, and the large one is always the first', () => {
    for (let n = 2; n <= 12; n++) {
      const cells = galleryLayout(n)
      expect(cells.map((c) => c.index)).toEqual(cells.map((c, i) => i))
      expect(cells.filter((c) => c.hero)).toHaveLength(1)
      expect(cells[0]!.rowSpan).toBe(cells.length - 1) // the rows the column beside it needs
    }
  })

  it('keeps the golden section in the height of the box', () => {
    expect(galleryHeight(420)).toBe(260)
    expect(galleryHeight(210)).toBe(130)
    expect(Math.abs(galleryHeight(420) / 420 - 0.618)).toBeLessThan(0.01)
  })
})
