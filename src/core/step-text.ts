// What a reply's step says about a tool call, so its steps read as they go: the argument that tells
// what was asked (the SQL, the path, the search) and the result in a few words ("120 rows").
import { L, locale } from '../shared/lang'

const INPUT_MAX = 4_000 // the step keeps this much of the argument; the row shows a few lines of it
const LINE_MAX = 120

// The arguments that say what a call did, best first. Tools name them in many ways.
const KEYS = ['statement', 'sql', 'query', 'command', 'cmd', 'code', 'path', 'file', 'file_path', 'filename', 'url', 'q', 'search', 'term', 'prompt', 'title', 'name', 'table', 'table_name', 'id']

export function keyArg(args: Record<string, unknown>): string | undefined {
  const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined)
  const lower = new Map(Object.entries(args).map(([k, v]) => [k.toLowerCase(), v]))
  let value: string | undefined
  for (const k of KEYS) if ((value = pick(lower.get(k)))) break
  value ??= Object.entries(args)
    .filter(([k]) => !k.startsWith('_'))
    .map(([, v]) => pick(v))
    .find(Boolean)
  if (!value) return undefined
  return value.length > INPUT_MAX ? `${value.slice(0, INPUT_MAX)}…` : value
}

const n = (x: number): string => x.toLocaleString(locale())
const rows = (x: number): string => (x === 1 ? L('1 linha', '1 row') : L(`${n(x)} linhas`, `${n(x)} rows`))

// Rows in a JSON answer: an array, or the shapes SQL tools answer with (Databricks' statement API among them).
function jsonCount(v: unknown): string | undefined {
  if (Array.isArray(v)) return v.length === 1 ? L('1 item', '1 item') : L(`${n(v.length)} itens`, `${n(v.length)} items`)
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const at = (path: string[]): unknown => path.reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)
  for (const p of [['manifest', 'total_row_count'], ['result', 'row_count'], ['row_count'], ['total_row_count'], ['rowCount']]) {
    const c = at(p)
    if (typeof c === 'number') return rows(c)
  }
  for (const p of [['result', 'data_array'], ['data_array'], ['rows'], ['data'], ['results'], ['items']]) {
    const c = at(p)
    if (Array.isArray(c)) return p.includes('items') ? jsonCount(c) : rows(c.length)
  }
  return undefined
}

// A table in text: CSV, TSV or Markdown, every line with the same separators as the header.
function tableRows(lines: string[]): number | undefined {
  if (lines.length < 2) return undefined
  const markdown = /^\|.*\|$/.test(lines[0]!) && /^\|?[\s:|-]+\|?$/.test(lines[1]!)
  if (markdown) return lines.length - 2
  for (const sep of ['\t', ',', ';', '|']) {
    const count = (l: string): number => l.split(sep).length - 1
    const c = count(lines[0]!)
    if (c > 0 && lines.every((l) => count(l) === c)) return lines.length - 1
  }
  return undefined
}

// A result in a few words: how many rows or items when it's data, how many lines when it's long text,
// the text itself when it's short.
export function resultSummary(text: string): string {
  const t = text.replace(/\n\[… (resultado cortado|result cut)[^\]]*\]$/, '').trim()
  const cut = t.length < text.trim().length ? L(' (cortado)', ' (cut)') : ''
  if (!t) return L('Sem resultado', 'No result')
  if (/^[[{]/.test(t)) {
    try {
      const c = jsonCount(JSON.parse(t))
      if (c) return c + cut
    } catch {
      // not JSON after all
    }
  }
  const lines = t.split(/\r?\n/).filter((l) => l.trim())
  const table = tableRows(lines)
  if (table !== undefined) return rows(table) + cut
  if (lines.length > 3) return L(`${n(lines.length)} linhas de texto`, `${n(lines.length)} lines of text`) + cut
  const one = lines.join(' · ')
  return (one.length > LINE_MAX ? `${one.slice(0, LINE_MAX)}…` : one) + cut
}
