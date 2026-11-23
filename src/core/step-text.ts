// What a reply's step says about a tool call, so its steps read as they go: the argument that tells
// what was asked (the SQL, the path, the search) and the result in a few words ("120 rows").
// Everything here is for the screen, so it passes through maskSecrets: the agent still gets the real text.
import { L, locale } from '../shared/lang'
import type { ResultTable } from '../shared/types'

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
    .filter(([k]) => !k.startsWith('_') && !SECRET_NAME.test(k))
    .map(([, v]) => pick(v))
    .find(Boolean)
  if (!value) return undefined
  return clipInput(maskSecrets(value))
}

const clipInput = (v: string): string => (v.length > INPUT_MAX ? `${v.slice(0, INPUT_MAX)}…` : v)
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

// A table in text: a box drawn with +---+ (the databricks CLI's, MySQL's), Markdown, or CSV/TSV with
// the same separators on every line as on the header.
function tableRows(lines: string[]): number | undefined {
  if (lines.length < 2) return undefined
  if (/^\+[-+]+\+$/.test(lines[0]!.trim())) {
    const body = lines.filter((l) => /^\|.*\|$/.test(l.trim()))
    return body.length ? body.length - 1 : undefined // the first |…| line is the header
  }
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
  const footer = /\((\d+) rows?\)\s*$/i.exec(t) // psql's "(3 rows)"
  if (footer) return rows(Number(footer[1])) + cut
  const lines = t.split(/\r?\n/).filter((l) => l.trim())
  const table = tableRows(lines)
  if (table !== undefined) return rows(table) + cut
  if (lines.length > 3) return L(`${n(lines.length)} linhas de texto`, `${n(lines.length)} lines of text`) + cut
  const one = maskSecrets(lines.join(' · '))
  return (one.length > LINE_MAX ? `${one.slice(0, LINE_MAX)}…` : one) + cut
}

// ---------- a query's rows, as a table ----------

const TABLE_ROWS = 100
const TABLE_COLUMNS = 30
const CELL_MAX = 200
const NUMBER = /^-?(?:\d+(?:[.,]\d+)*|\d*[.,]\d+)(?:e[-+]?\d+)?$/i

const cell = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = maskSecrets(typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v))
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s
}

function shape(columns: string[], rows: unknown[][], total: number, cut: boolean): ResultTable | undefined {
  if (!columns.length || !rows.length) return undefined
  const cols = columns.slice(0, TABLE_COLUMNS).map((c) => cell(c) ?? '')
  const kept = rows.slice(0, TABLE_ROWS).map((r) => cols.map((_, i) => cell(r[i])))
  const numeric = cols.map((_, i) => {
    const values = kept.map((r) => r[i]).filter((v): v is string => v !== null && v !== '')
    return values.length > 0 && values.every((v) => NUMBER.test(v.trim()))
  })
  return { columns: cols, numeric, rows: kept, total: Math.max(total, rows.length), ...(cut ? { cut: true } : {}) }
}

function fromObjects(list: unknown[], total: number, cut: boolean): ResultTable | undefined {
  const objects = list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
  if (!objects.length || objects.length !== list.length) return undefined
  const columns = [...new Set(objects.slice(0, TABLE_ROWS).flatMap((o) => Object.keys(o)))]
  return shape(columns, objects.map((o) => columns.map((c) => o[c])), total, cut)
}

function fromJson(v: unknown, cut: boolean): ResultTable | undefined {
  if (Array.isArray(v)) return fromObjects(v, v.length, cut)
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const at = (path: string[]): unknown => path.reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o)
  // Databricks' statement API: the columns in the manifest, the rows as arrays.
  const schema = at(['manifest', 'schema', 'columns']) ?? at(['schema', 'columns']) ?? at(['columns'])
  const data = at(['result', 'data_array']) ?? at(['data_array']) ?? at(['rows']) ?? at(['data'])
  const total = [at(['manifest', 'total_row_count']), at(['result', 'row_count']), at(['row_count']), at(['total_row_count'])].find((n): n is number => typeof n === 'number')
  if (Array.isArray(schema) && Array.isArray(data) && data.every(Array.isArray)) {
    const columns = schema.map((c) => (c && typeof c === 'object' ? String((c as Record<string, unknown>)['name'] ?? '') : String(c)))
    return shape(columns, data as unknown[][], total ?? data.length, cut)
  }
  for (const list of [data, at(['results']), at(['items'])]) if (Array.isArray(list)) return fromObjects(list, total ?? list.length, cut)
  return undefined
}

// A line of CSV: commas or another separator, with fields in quotes.
function splitLine(line: string, sep: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') (cur += '"'), i++
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"' && !cur) quoted = true
    else if (ch === sep) out.push(cur), (cur = '')
    else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

const bars = (line: string): string[] => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim())

function fromText(lines: string[], cut: boolean): ResultTable | undefined {
  if (lines.length < 2) return undefined
  // A box: +---+ / | a | b | / +---+, as the databricks CLI and MySQL draw it.
  if (/^\+[-+]+\+$/.test(lines[0]!.trim())) {
    const body = lines.filter((l) => /^\|.*\|$/.test(l.trim())).map(bars)
    return body.length > 1 ? shape(body[0]!, body.slice(1), body.length - 1, cut) : undefined
  }
  // Markdown: | a | b | / |---|---|
  if (/^\|.*\|$/.test(lines[0]!.trim()) && /^\|?[\s:|-]+\|?$/.test(lines[1]!.trim())) {
    const body = lines.slice(2).map(bars)
    return shape(bars(lines[0]!), body, body.length, cut)
  }
  // psql: a | b / ---+--- / (3 rows)
  if (/^[-+]+$/.test(lines[1]!.trim()) && lines[0]!.includes('|')) {
    const body = lines.slice(2).filter((l) => !/^\(\d+ rows?\)$/i.test(l.trim())).map((l) => l.split('|').map((s) => s.trim()))
    return shape(lines[0]!.split('|').map((s) => s.trim()), body, body.length, cut)
  }
  for (const sep of ['\t', ',', ';']) {
    const head = splitLine(lines[0]!, sep)
    if (head.length < 2) continue
    const body = lines.slice(1).map((l) => splitLine(l, sep))
    if (body.every((r) => r.length === head.length)) return shape(head, body, body.length, cut)
  }
  return undefined
}

// What a query brought back, when it reads as a table: rows of JSON (Databricks' statement API among
// them), a box, Markdown, psql's output, or CSV/TSV. Undefined for anything else.
export function resultTable(text: string): ResultTable | undefined {
  const t = text.replace(/\n\[… (resultado cortado|result cut)[^\]]*\]$/, '').trim()
  const cut = t.length < text.trim().length
  if (!t) return undefined
  if (/^[[{]/.test(t)) {
    try {
      return fromJson(JSON.parse(t), cut)
    } catch {
      // not JSON after all
    }
  }
  return fromText(t.split(/\r?\n/).filter((l) => l.trim()), cut)
}

// A tool argument or a command that reads like SQL.
export const isSql = (text: string | undefined): boolean => !!text && SQLISH.test(text)

// The stdout of the computer's "exit code N / --- stdout --- / --- stderr ---" text.
export const stdoutOf = (text: string): string => /--- stdout ---\n([\s\S]*?)(?=\n--- stderr ---\n|$)/.exec(text)?.[1]?.trim() ?? ''

// ---------- secrets ----------

// What a step shows never carries a secret: commands and outputs pass through here first. The agent
// still gets the real text; only what the screen (and whoever looks over the shoulder) sees is masked.
export const MASK = '••••'
const SECRET_WORDS = String.raw`(?:token|secret|password|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)`
const SECRET_NAME = new RegExp(`${SECRET_WORDS}|auth|^pat$`, 'i')
const QUOTED_OR_WORD = String.raw`("[^"]*"|'[^']*'|[^\s;&|'"]+)`
const TOKEN_SHAPES = [
  /\bdapi[0-9a-f]{32}(?:-\d+)?\b/g, // Databricks personal access token
  /\bdose[0-9a-f]{32}(?:-\d+)?\b/g, // Databricks OAuth secret
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g // a JWT
]
const RULES: [RegExp, string | ((...m: string[]) => string)][] = [
  // Authorization: Bearer xyz / Basic xyz, in curl's headers and the like
  [/\b(authorization\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s"',}]+/gi, (_m, head, kind) => `${head}${kind ? `${kind} ` : ''}${MASK}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // --token xyz, --password=xyz, --client-secret "xyz"
  [new RegExp(String.raw`(--?[\w-]{0,40}${SECRET_WORDS})(\s+|=)${QUOTED_OR_WORD}`, 'gi'), `$1$2${MASK}`],
  // DATABRICKS_TOKEN=xyz, export API_KEY="xyz", password=xyz in a connection string
  [new RegExp(String.raw`\b([A-Za-z_][\w.-]{0,40}?${SECRET_WORDS})(\s*=\s*)${QUOTED_OR_WORD}`, 'gi'), `$1$2${MASK}`],
  // "token": "xyz" in JSON, token: xyz in YAML
  [new RegExp(String.raw`(["']?[\w-]{0,40}${SECRET_WORDS}["']?\s*:\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)`, 'gi'), (_m, head, v) => `${head}${v!.startsWith('"') ? `"${MASK}"` : v!.startsWith("'") ? `'${MASK}'` : MASK}`],
  // https://user:password@host
  [/(\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  // -p is a password only for these (for mkdir, ssh or the databricks CLI it's something else)
  [/\b(mysql|mariadb|mysqldump|mysqladmin|sshpass)\b([^\n|;&]{0,300}?\s)-p(?:\s+|=)?(?![\s-])\S+/g, `$1$2-p${MASK}`]
]

// The rules' prefixes are bounded ({0,40} and the like): unbounded, a long run of word characters (base64, a hash)
// made each rule scan to the end from every position, seconds on 40 KB with the core waiting.
export function maskSecrets(text: string): string {
  let t = text
  for (const [re, to] of RULES) t = t.replace(re, to as never)
  for (const shape of TOKEN_SHAPES) t = t.replace(shape, MASK)
  return t
}

// ---------- shell commands ----------

// The SQL a command runs, when it carries one: --statement, -e/--execute, -c/--command, -q/--query/--sql
// (databricks, psql, mysql, bq, snowsql…), a "statement" in --json, or a heredoc that reads like SQL.
const SQLISH = /^\s*(select|with|insert|update|delete|merge|create|drop|alter|describe|desc|show|explain|optimize|vacuum|copy|truncate|use|refresh|analyze)\b/i
const QUOTED = String.raw`("(?:[^"\\]|\\.)*"|'[^']*'|\$'(?:[^'\\]|\\.)*')`
const SQL_FLAG = new RegExp(String.raw`(?:^|\s)(?:--statement|--sql|--query|--execute|--command|-e|-c|-q)(?:\s+|=)` + QUOTED, 'g')

function unquote(v: string): string {
  if (v.startsWith("$'")) return v.slice(2, -1).replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')
  if (v.startsWith('"')) return v.slice(1, -1).replace(/\\(["\\$`])/g, '$1')
  return v.slice(1, -1)
}

export function sqlIn(command: string): string | undefined {
  for (const m of command.matchAll(SQL_FLAG)) {
    const v = unquote(m[1]!).trim()
    if (SQLISH.test(v)) return v
  }
  const json = /"statement"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(command)
  if (json) {
    try {
      return (JSON.parse(`"${json[1]}"`) as string).trim()
    } catch {
      return json[1]!.trim()
    }
  }
  const heredoc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/.exec(command)
  if (heredoc && SQLISH.test(heredoc[3]!)) return heredoc[3]!.trim()
  return undefined
}

// What a shell command step shows: the SQL it runs when it has one (with the command's first line as the
// detail), the whole command otherwise. Masked.
export function commandStep(command: string): { sql: boolean; input: string; detail: string } {
  const masked = maskSecrets(command.trim())
  const sql = sqlIn(command)
  if (!sql) return { sql: false, input: clipInput(masked), detail: '' }
  // The command's first line with the SQL left out ("--statement "…""): the SQL shows below it.
  const first = (masked.replace(sql, '…').split('\n')[0] ?? '').trim()
  return { sql: true, input: clipInput(maskSecrets(sql)), detail: first.length > LINE_MAX ? `${first.slice(0, LINE_MAX)}…` : first }
}

// The end of a command, from the computer's "exit code N / --- stdout --- / --- stderr ---" text:
// what came out in a few words, or why it failed (the exit code and the last lines of stderr).
export function execSummary(text: string, failed: boolean): { output?: string; error?: string } {
  const code = /^exit code (-?\d+)/m.exec(text)?.[1]
  const part = (name: string): string => new RegExp(String.raw`--- ${name} ---\n([\s\S]*?)(?=\n--- (?:stdout|stderr) ---\n|$)`).exec(text)?.[1]?.trim() ?? ''
  const stdout = part('stdout')
  const stderr = part('stderr')
  if (!failed) return { output: stdout ? resultSummary(stdout) : L('Sem saída', 'No output') }
  if (code === undefined) return { error: maskSecrets(text.trim().split('\n').slice(0, 3).join('\n')) || L('Falhou sem mensagem', 'Failed with no message') }
  const why = maskSecrets((stderr || stdout).split('\n').filter((l) => l.trim()).slice(-3).join('\n'))
  return { error: `exit code ${code}${why ? `: ${why}` : ''}` }
}
