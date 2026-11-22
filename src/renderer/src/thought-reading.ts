export interface ThoughtLine { offset: number; top: number }

function characterTop(box: HTMLElement, offset: number): number | null {
  const text = box.firstChild
  if (!text || text.nodeType !== 3 || offset < 0 || offset >= (text.textContent?.length ?? 0)) return null
  const range = document.createRange()
  if (!range.getBoundingClientRect) return null
  range.setStart(text, offset)
  range.setEnd(text, offset + 1)
  const rect = range.getBoundingClientRect()
  return rect.height > 0 ? rect.top : null
}

// Store an absolute character position: cache eviction changes the retained text's origin.
export function captureThoughtLine(box: HTMLElement, start: number): ThoughtLine | null {
  const length = box.firstChild?.textContent?.length ?? 0
  if (!length) return null
  const target = box.getBoundingClientRect().top + 1
  let low = 0
  let high = length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    const top = characterTop(box, middle)
    if (top === null) return null
    if (top < target) low = middle + 1
    else high = middle
  }
  const top = characterTop(box, low)
  return top === null ? null : { offset: start + low, top }
}

export function restoreThoughtLine(box: HTMLElement, line: ThoughtLine, start: number): void {
  const offset = line.offset - start
  // An evicted passage cannot be restored; show the earliest text still retained.
  if (offset < 0) {
    box.scrollTop = 0
    const next = captureThoughtLine(box, start)
    if (next) Object.assign(line, next)
    return
  }
  const top = characterTop(box, offset)
  if (top === null) return
  box.scrollTop += top - line.top
  const after = characterTop(box, offset)
  if (after !== null) line.top = after
}
