const KEY = 'tucano.threadPanelWidth'
const MIN = 360
const MAX = 760

export function readThreadPanelWidth(storage: Pick<Storage, 'getItem'>): number | null {
  try {
    const width = Number(storage.getItem(KEY))
    return Number.isFinite(width) && width >= MIN && width <= MAX ? Math.round(width) : null
  } catch {
    return null
  }
}

export function saveThreadPanelWidth(storage: Pick<Storage, 'setItem'>, width: number): void {
  try {
    storage.setItem(KEY, String(Math.round(Math.max(MIN, Math.min(MAX, width)))))
  } catch {}
}

export function threadPanelWidthForDrag(right: number, pointerX: number, minWidth: number, maxWidth = MAX): number {
  return Math.round(Math.max(minWidth, Math.min(Math.max(minWidth, maxWidth), right - pointerX)))
}
