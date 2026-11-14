// One file's diff, drawn like a code review: green and red lines, the changed words marked, syntax
// colors, line numbers on both sides, unchanged stretches folded. Loaded on its own (React.lazy),
// so the highlighter only comes into the window when someone opens a diff.
import { PatchDiff, Virtualizer } from '@pierre/diffs/react'
import { useMemo, type ReactNode } from 'react'
import { useStore } from '../store'

// Past this many lines a diff draws only the rows in view (and a few around them) as it scrolls:
// drawing every row of a big file is what made it slow to open, not highlighting it.
const VIRTUAL_FROM = 300

export default function DiffView({ patch, split }: { patch: string; split: boolean }): ReactNode {
  const theme = useStore((s) => s.settings.theme)
  const big = useMemo(() => lineCount(patch) > VIRTUAL_FROM, [patch])
  const diff = (
    <PatchDiff
      patch={patch}
      disableWorkerPool
      className="diffview"
      options={{
        // Pierre's WebAssembly highlighter: far faster than Shiki on big files, its lexers built in
        // (no grammar to load per language); a language it doesn't know shows as plain text.
        preferredHighlighter: 'highlights',
        diffStyle: split ? 'split' : 'unified',
        themeType: theme === 'light' || theme === 'dark' ? theme : 'system',
        disableFileHeader: true,
        lineDiffType: 'word',
        hunkSeparators: 'line-info',
        overflow: 'scroll'
      }}
    />
  )
  return big ? <Virtualizer className="diffscroll">{diff}</Virtualizer> : <div className="diffscroll">{diff}</div>
}

function lineCount(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) n++
  return n
}
