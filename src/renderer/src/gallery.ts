// The images of one reply, laid out the way Telegram lays out an album: one large picture on the
// left, the others in a column beside it, the large one and the column in the golden section
// (61.8% of the width against 38.2%). Kept apart from React so the arithmetic can be tested alone.
//
// One image is not a gallery: it stays the picture it always was. Past four, the fourth cell says
// how many are left and a press opens them in the window, which still goes through all of them.

export const GALLERY_HERO = 1.618 // the large cell's share of the width against the column's 1
export const GALLERY_MAX = 4 // what fits before the last cell starts counting

export interface GalleryCell {
  index: number // which image of the reply it shows
  hero: boolean
  rowSpan: number // how many of the column's rows it covers
  more?: number // images left out, on the last cell
}

// The cells to draw, in order, for `count` images. Empty: not a gallery (draw them as they are).
export function galleryLayout(count: number): GalleryCell[] {
  if (count < 2) return []
  const beside = Math.min(count - 1, GALLERY_MAX - 1) // the column: one to three pictures
  const left = count - 1 - beside
  const cells: GalleryCell[] = [{ index: 0, hero: true, rowSpan: beside }, ...Array.from({ length: beside }, (_, i) => ({ index: i + 1, hero: false, rowSpan: 1 }))]
  if (left > 0) cells[cells.length - 1]!.more = left
  return cells
}

// The container's height for its width: the golden section, so the large cell and the column keep
// their proportion at any size (and past 420 px the width stops growing, as a single picture did).
export const galleryHeight = (width: number): number => Math.round(width / GALLERY_HERO)
