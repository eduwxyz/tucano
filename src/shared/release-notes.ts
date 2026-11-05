// What's new in a version, read from CHANGELOG.md: the Portuguese summary at the top of its
// section and, in English, the first sentence of each of its items, without the links to PRs
// and the thanks (the full notes are a link away).
//
// The summary is a list, a topic per item, written as such:
//   > **Em português:**
//   > - **Threads.** Cada resposta…
//   >
//   > Obrigado à Rayanne!
// What isn't in the list is text before it (`intro`; an older summary is all intro) or after it (`outro`).

export interface PtSummary {
  intro?: string
  points: string[]
  outro?: string
}

export interface ReleaseNotes {
  version: string
  date?: string
  pt?: PtSummary
  sections: { kind: string; items: string[] }[] // "Added", "Changed", "Fixed"…
}

const MAX_ITEM = 240

// The lines of the "> **Em português:**" quote, without the "> ".
export function parsePt(lines: string[]): PtSummary | undefined {
  const points: string[] = []
  const before: string[] = []
  const after: string[] = []
  let inTopic = false // inside a topic: an indented line goes on with it, a blank line ends the list
  for (const raw of lines) {
    const line = raw.replace(/^\*\*Em português:\*\*\s*/, '').trim()
    if (/^[-*] /.test(line)) (points.push(line.slice(2).trim()), (inTopic = true))
    else if (!line) inTopic = false
    else if (inTopic && /^\s/.test(raw)) points[points.length - 1] += ` ${line}`
    else (points.length ? after : before).push(line)
  }
  const text = (ls: string[]): string | undefined => {
    const t = ls.join(' ').trim()
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : undefined
  }
  const [intro, outro] = [text(before), text(after)]
  if (!intro && !outro && points.length === 0) return undefined
  return { ...(intro ? { intro } : {}), points, ...(outro ? { outro } : {}) }
}

// 1 when a is newer than b, -1 when older, 0 the same. Plain x.y.z: a pre-release suffix is ignored.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0) ? 1 : -1
  return 0
}

// "**Threads.** Every answer … ([#101](…)). Thanks [@x](…)!" → "**Threads.** Every answer …"
export function shortItem(item: string): string {
  const clean = item
    .replace(/\s*\((\[#\d+\]\([^)]*\)(,\s*)?)+\)/g, '') // ([#101](…), [#99](…))
    .replace(/\s*Thanks? [^.!]*\[@[^\]]+\]\([^)]*\)[^.!]*[.!]/g, '') // Thanks [@rayanneblima](…)!
    .trim()
  const lead = /^\*\*[^*]+\*\*/.exec(clean)?.[0] ?? ''
  const rest = clean.slice(lead.length)
  const end = /[.!?](?=\s|$)/.exec(rest)
  let text = lead + (end ? rest.slice(0, end.index + 1) : rest)
  if (text.length > MAX_ITEM) text = `${text.slice(0, text.lastIndexOf(' ', MAX_ITEM))}…`
  return text.trim()
}

export function parseChangelog(changelog: string): ReleaseNotes[] {
  const out: ReleaseNotes[] = []
  for (const chunk of changelog.split(/^## \[/m).slice(1)) {
    const [head = '', ...lines] = chunk.split('\n')
    const m = /^(\d+\.\d+\.\d+[^\]]*)\](?:\s*-\s*(\S+))?/.exec(head)
    if (!m) continue // [Unreleased]
    const notes: ReleaseNotes = { version: m[1]!, ...(m[2] ? { date: m[2] } : {}), sections: [] }
    const quote: string[] = []
    for (const line of lines) {
      if (/^\[[^\]]+\]: /.test(line)) break // the links at the end of the file
      if (line.startsWith('>')) quote.push(line.replace(/^>\s?/, ''))
      else if (line.startsWith('### ')) notes.sections.push({ kind: line.slice(4).trim(), items: [] })
      else if (line.startsWith('- ') && notes.sections.length) notes.sections.at(-1)!.items.push(shortItem(line.slice(2)))
    }
    const pt = parsePt(quote)
    if (pt) notes.pt = pt
    out.push(notes)
  }
  return out
}

// The versions after `seen` up to the one running (`current`), newest first: three at most.
// Without `seen`, only the one running.
export function newsSince(changelog: string, current: string, seen?: string): ReleaseNotes[] {
  return parseChangelog(changelog)
    .filter((r) => compareVersions(r.version, current) <= 0 && (seen ? compareVersions(r.version, seen) > 0 : compareVersions(r.version, current) === 0))
    .slice(0, 3)
}
