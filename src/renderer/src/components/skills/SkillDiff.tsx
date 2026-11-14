import type { ReactNode } from 'react'

export function Diff({ before, after }: { before: string; after: string }): ReactNode {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence, enough for recipes of a few hundred lines.
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const lines: { kind: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    // Removed lines before the ones that replace them.
    if (i < n && j < m && a[i] === b[j]) lines.push({ kind: ' ', text: a[i++]! }), j++
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push({ kind: '-', text: a[i++]! })
    else lines.push({ kind: '+', text: b[j++]! })
  }
  return (
    <pre className="diff">
      {lines.map((l, k) => (
        <div key={k} className={l.kind === '+' ? 'diff__add' : l.kind === '-' ? 'diff__del' : 'diff__same'}>
          {l.kind} {l.text}
        </div>
      ))}
    </pre>
  )
}
