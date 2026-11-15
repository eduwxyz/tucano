// Bound both matrix work and the number of per-line DOM nodes. Larger inputs stay readable in full.
export const MAX_DIFF_CELLS = 262_144
export const MAX_DIFF_LINES = 2_000

export type DiffLine = { kind: ' ' | '-' | '+'; text: string }
export type SkillComparison = { kind: 'lines'; lines: DiffLine[] } | { kind: 'full' }

function lineCount(text: string): number {
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++count > MAX_DIFF_LINES) break
  }
  return count
}

export function compareSkill(before: string, after: string): SkillComparison {
  const n = lineCount(before)
  const m = lineCount(after)
  if (n + m > MAX_DIFF_LINES || (n + 1) * (m + 1) > MAX_DIFF_CELLS) return { kind: 'full' }
  const a = before.split('\n')
  const b = after.split('\n')
  // Intern lines once: the bounded inner loop compares integers, not long instruction strings.
  const ids = new Map<string, number>()
  const encode = (lines: string[]): number[] => lines.map(line => {
    const known = ids.get(line)
    if (known !== undefined) return known
    const id = ids.size
    ids.set(line, id)
    return id
  })
  const x = encode(a)
  const y = encode(b)
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) lines.push({ kind: ' ', text: a[i++]! }), j++
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push({ kind: '-', text: a[i++]! })
    else lines.push({ kind: '+', text: b[j++]! })
  }
  return { kind: 'lines', lines }
}
