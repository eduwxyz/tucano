// Each agent's own tables: a small SQLite file the agent creates, reads and changes with SQL, for
// what a routine writes on every run and reads back later (a price history, what it already
// reported). Memories and the wiki hold text; this holds rows. One file per agent, apart from
// tucano.db, so an agent can only ever reach its own.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { L } from '../shared/lang'
import type { AgentRows, AgentTable } from '../shared/types'
import type { ToolDef } from './gateway'

export const DADOS = 'dados' // the "connector" of approvals for SQL that destroys data

export const MAX_DB_MB = 100
const PAGE_SIZE = 4096
const MAX_ROWS = 200 // a query brings this many rows at most; the agent pages with LIMIT/OFFSET
const MAX_RESULT = 24_000 // characters of rows a query brings at most
const MAX_SQL = 20_000
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/

// The first words a statement may start with, per tool. Anything else is refused before SQLite sees it.
const READS = new Set(['select', 'with', 'explain'])
const WRITES = new Set(['create', 'insert', 'replace', 'update', 'delete', 'drop', 'alter'])
// Never, in either tool: reaching other files, changing how SQLite runs, or loops with no end
// (the core runs SQLite on its own thread, and a recursive query that never stops would hold every agent).
const FORBIDDEN = /\b(attach|detach|pragma|vacuum|load_extension|recursive)\b/i

export const DADOS_TABELAS: ToolDef = {
  name: 'dados_tabelas',
  get description() {
    return L(
      'Mostra as suas tabelas: o nome, as colunas e quantas linhas cada uma tem. Comece por aqui antes de consultar ou alterar.',
      'Shows your tables: their names, columns and how many rows each has. Start here before querying or changing them.'
    )
  },
  get inputSchema() {
    return { type: 'object' as const, properties: {} }
  }
}

export const DADOS_CONSULTAR: ToolDef = {
  name: 'dados_consultar',
  get description() {
    return L(
      `Lê das suas tabelas com uma consulta SQL (SQLite): só SELECT ou WITH … SELECT, uma por chamada. Traz até ${MAX_ROWS} linhas; pra mais, pagine com LIMIT/OFFSET ou agregue (COUNT, AVG, MIN, MAX). Use "parametros" pros valores, com ? no SQL.`,
      `Reads from your tables with a SQL query (SQLite): only SELECT or WITH … SELECT, one per call. Brings up to ${MAX_ROWS} rows; for more, page with LIMIT/OFFSET or aggregate (COUNT, AVG, MIN, MAX). Use "parametros" for the values, with ? in the SQL.`
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: L('A consulta, ex.: SELECT * FROM precos WHERE trecho = ? ORDER BY data DESC LIMIT 20', 'The query, e.g. SELECT * FROM prices WHERE route = ? ORDER BY date DESC LIMIT 20') },
        parametros: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, description: L('Os valores dos ?, na ordem.', 'The values for the ?, in order.') }
      },
      required: ['sql']
    }
  }
}

export const DADOS_ALTERAR: ToolDef = {
  name: 'dados_alterar',
  get description() {
    return L(
      `Muda as suas tabelas com um comando SQL (SQLite), um por chamada: CREATE TABLE/INDEX/VIEW, INSERT, UPDATE, DELETE, ALTER TABLE, DROP. Os dados ficam guardados entre conversas e rotinas, só pra você, até ${MAX_DB_MB} MB. Use "parametros" pros valores, com ? no SQL. Apagar de vez (DROP, ALTER … DROP, DELETE ou UPDATE sem WHERE) segue a sua regra de apagar: pode pedir aprovação antes.`,
      `Changes your tables with a SQL command (SQLite), one per call: CREATE TABLE/INDEX/VIEW, INSERT, UPDATE, DELETE, ALTER TABLE, DROP. The data is kept across conversations and routines, for you only, up to ${MAX_DB_MB} MB. Use "parametros" for the values, with ? in the SQL. Destroying data (DROP, ALTER … DROP, DELETE or UPDATE without WHERE) follows your delete rule: it may ask for approval first.`
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        sql: { type: 'string', description: L('O comando, ex.: INSERT INTO precos (trecho, data, preco) VALUES (?, ?, ?)', 'The command, e.g. INSERT INTO prices (route, date, price) VALUES (?, ?, ?)') },
        parametros: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] }, description: L('Os valores dos ?, na ordem.', 'The values for the ?, in order.') }
      },
      required: ['sql']
    }
  }
}

export const DATA_TOOLS = [DADOS_TABELAS, DADOS_CONSULTAR, DADOS_ALTERAR]
export const DATA_TOOL_NAMES = new Set(DATA_TOOLS.map((t) => t.name))

// The SQL with its string literals, quoted names and comments blanked out: what's left is only
// keywords and names, so a word inside a value ("drop shipping") never counts as a command.
export function codeOf(sql: string): string {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      i = end < 0 ? sql.length : end
      out += ' '
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? sql.length : end + 2
      out += ' '
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) j += 2 // '' inside a string is a quote
          else break
        } else j++
      }
      out += c === "'" ? "''" : ' x '
      i = j + 1
    } else {
      out += c
      i++
    }
  }
  return out
}

export type Checked = { ok: true; destructive: boolean } | { ok: false; error: string }

// Whether a statement may run through this tool, and whether it destroys data.
export function checkSql(sql: string, mode: 'read' | 'write'): Checked {
  if (!sql.trim()) return { ok: false, error: L('Faltou o SQL.', 'Missing the SQL.') }
  if (sql.length > MAX_SQL) return { ok: false, error: L(`O SQL passa de ${MAX_SQL} caracteres: divida em partes.`, `The SQL is over ${MAX_SQL} characters: split it.`) }
  const code = codeOf(sql).trim().replace(/;\s*$/, '')
  if (code.includes(';')) return { ok: false, error: L('Um comando por chamada: tire o ; do meio e mande o resto noutra chamada.', 'One statement per call: remove the ; in the middle and send the rest in another call.') }
  const banned = code.match(FORBIDDEN)
  if (banned) return { ok: false, error: L(`${banned[0].toUpperCase()} não é permitido aqui.`, `${banned[0].toUpperCase()} isn't allowed here.`) }
  const first = (code.match(/^\s*([a-z]+)/i)?.[1] ?? '').toLowerCase()
  if (mode === 'read' && !READS.has(first))
    return { ok: false, error: L('dados_consultar só lê (SELECT ou WITH … SELECT). Pra mudar, use dados_alterar.', 'dados_consultar only reads (SELECT or WITH … SELECT). To change data, use dados_alterar.') }
  if (mode === 'write' && !WRITES.has(first))
    return { ok: false, error: READS.has(first) ? L('Isso é uma consulta: use dados_consultar.', "That's a query: use dados_consultar.") : L(`"${first.toUpperCase()}" não é um comando aceito aqui.`, `"${first.toUpperCase()}" isn't an accepted command here.`) }
  return { ok: true, destructive: mode === 'write' && destroys(code, first) }
}

// DROP of anything, ALTER … DROP, and a DELETE or UPDATE that reaches every row.
function destroys(code: string, first: string): boolean {
  if (first === 'drop') return true
  if (first === 'alter') return /\bdrop\b/i.test(code)
  if (first === 'delete' || first === 'update') return !/\bwhere\b/i.test(code)
  return false
}

export type Params = SQLInputValue[]

export function paramsOf(raw: unknown): Params | { error: string } {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) return { error: L('"parametros" é uma lista de valores.', '"parametros" is a list of values.') }
  const out: Params = []
  for (const v of raw) {
    if (v === null || typeof v === 'string' || typeof v === 'number') out.push(v)
    else if (typeof v === 'boolean') out.push(v ? 1 : 0)
    else return { error: L('Cada parâmetro é texto, número, verdadeiro/falso ou null.', 'Each parameter is text, a number, true/false or null.') }
  }
  return out
}

const cell = (v: unknown): unknown => (v instanceof Uint8Array ? `<blob ${v.byteLength} bytes>` : typeof v === 'bigint' ? Number(v) : v)

const MAX_CSV_ROWS = 100_000
const quoteName = (name: string): string => `"${name.replace(/"/g, '""')}"`
const csvField = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export class AgentData {
  constructor(private readonly dir: string) {}

  file(agentId: string): string {
    if (!SAFE_ID.test(agentId)) throw new Error(`invalid agent id: ${agentId}`)
    return join(this.dir, `${agentId}.db`)
  }

  // Opened per call: a write shows up for the next read at once, and nothing stays locked between turns.
  private open(agentId: string, readOnly: boolean): DatabaseSync {
    const file = this.file(agentId)
    // Nothing written yet: an empty database answers, so a read makes no file and a wrong name still says "no such table".
    if (readOnly && !existsSync(file)) return new DatabaseSync(':memory:')
    if (!readOnly) mkdirSync(this.dir, { recursive: true })
    const db = new DatabaseSync(file, { readOnly, allowExtension: false })
    // The cap holds per connection, so every writer sets it. The default journal (not WAL) keeps the
    // folder at one file per agent and lets a read-only connection open it with nothing else around.
    if (!readOnly) db.exec(`PRAGMA max_page_count = ${(MAX_DB_MB * 1024 * 1024) / PAGE_SIZE};`)
    return db
  }

  tables(agentId: string): AgentTable[] {
    const db = this.open(agentId, true)
    try {
      return this.listed(db)
    } finally {
      db.close()
    }
  }

  private listed(db: DatabaseSync): AgentTable[] {
    const names = db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; type: 'table' | 'view' }[]
    return names.map(({ name, type }) => {
      const columns = (db.prepare('SELECT name, type FROM pragma_table_info(?)').all(name) as { name: string; type: string }[]).map((c) => ({ name: c.name, type: c.type }))
      const rows = Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quoteName(name)}`).get() as { n: number }).n)
      return { name, type, columns, rows }
    })
  }

  // For the agent's page: one table's newest rows (a table keeps them in the order they came; a view as it gives them).
  rows(agentId: string, table: string, limit = 100): AgentRows {
    const db = this.open(agentId, true)
    try {
      const t = this.listed(db).find((x) => x.name === table)
      if (!t) throw new Error(L(`Não há tabela ${table}.`, `There's no table ${table}.`))
      const columns = t.columns.map((c) => c.name)
      const order = t.type === 'table' ? ' ORDER BY rowid DESC' : ''
      const got = db.prepare(`SELECT * FROM ${quoteName(table)}${order} LIMIT ?`).all(Math.max(1, Math.min(limit, 500))) as Record<string, unknown>[]
      return { columns, rows: got.map((r) => columns.map((c) => cell(r[c]))), total: t.rows }
    } finally {
      db.close()
    }
  }

  // The whole table as CSV, oldest first, for the person to open in a spreadsheet.
  csv(agentId: string, table: string): string {
    const db = this.open(agentId, true)
    try {
      const t = this.listed(db).find((x) => x.name === table)
      if (!t) throw new Error(L(`Não há tabela ${table}.`, `There's no table ${table}.`))
      const columns = t.columns.map((c) => c.name)
      const order = t.type === 'table' ? ' ORDER BY rowid' : ''
      const lines = [columns.map(csvField).join(',')]
      for (const r of db.prepare(`SELECT * FROM ${quoteName(table)}${order} LIMIT ${MAX_CSV_ROWS}`).iterate() as Iterable<Record<string, unknown>>) lines.push(columns.map((c) => csvField(cell(r[c]))).join(','))
      return `${lines.join('\r\n')}\r\n`
    } finally {
      db.close()
    }
  }

  // A read, on a read-only connection: even a statement that slipped past checkSql can't write.
  query(agentId: string, sql: string, params: Params = []): { rows: Record<string, unknown>[]; truncated: boolean } {
    const db = this.open(agentId, true)
    try {
      const rows: Record<string, unknown>[] = []
      let chars = 0
      let truncated = false
      for (const r of db.prepare(sql).iterate(...params) as Iterable<Record<string, unknown>>) {
        const row = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))
        const size = JSON.stringify(row).length
        if (rows.length >= MAX_ROWS || chars + size > MAX_RESULT) {
          truncated = true
          break
        }
        rows.push(row)
        chars += size
      }
      return { rows, truncated }
    } finally {
      db.close()
    }
  }

  execute(agentId: string, sql: string, params: Params = []): { changes: number } {
    const db = this.open(agentId, false)
    try {
      const r = db.prepare(sql).run(...params)
      return { changes: Number(r.changes) }
    } finally {
      db.close()
    }
  }
}

// What the agent reads back, and the step its reply shows.
export type DataResult = { text: string; error?: boolean; step: { label: string; detail: string } }

const snip = (s: string, n = 120): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n)}…` : one
}

export function tablesCall(data: Pick<AgentData, 'tables'>, agentId: string): DataResult {
  const tables = data.tables(agentId)
  const step = { label: L('Viu as tabelas', 'Looked at the tables'), detail: tables.length === 1 ? L('1 tabela', '1 table') : L(`${tables.length} tabelas`, `${tables.length} tables`) }
  if (!tables.length) return { text: L('Você ainda não tem tabelas. Crie uma com dados_alterar (CREATE TABLE …).', "You don't have tables yet. Create one with dados_alterar (CREATE TABLE …)."), step }
  return {
    text: tables.map((t) => `- ${t.name}${t.type === 'view' ? ' (view)' : ''}: ${t.columns.map((c) => (c.type ? `${c.name} ${c.type}` : c.name)).join(', ')} · ${t.rows === 1 ? L('1 linha', '1 row') : L(`${t.rows} linhas`, `${t.rows} rows`)}`).join('\n'),
    step
  }
}

export function queryCall(data: Pick<AgentData, 'query'>, agentId: string, args: Record<string, unknown>): DataResult {
  const sql = typeof args['sql'] === 'string' ? args['sql'] : ''
  const step = (detail: string): DataResult['step'] => ({ label: L('Consultou', 'Queried'), detail })
  const checked = checkSql(sql, 'read')
  if (!checked.ok) return { text: checked.error, error: true, step: step(snip(sql)) }
  const params = paramsOf(args['parametros'])
  if ('error' in params) return { text: params.error, error: true, step: step(snip(sql)) }
  try {
    const { rows, truncated } = data.query(agentId, sql, params)
    const count = rows.length === 1 ? L('1 linha', '1 row') : L(`${rows.length} linhas`, `${rows.length} rows`)
    const more = truncated ? `\n${L(`(parou em ${rows.length} linhas: pagine com LIMIT/OFFSET ou agregue)`, `(stopped at ${rows.length} rows: page with LIMIT/OFFSET or aggregate)`)}` : ''
    return { text: rows.length ? `${JSON.stringify(rows)}${more}` : L('Nenhuma linha.', 'No rows.'), step: step(`${snip(sql, 80)} · ${count}${truncated ? '+' : ''}`) }
  } catch (e) {
    return { text: sqlError(e), error: true, step: step(snip(sql)) }
  }
}

export function executeCall(data: Pick<AgentData, 'execute'>, agentId: string, sql: string, params: Params): DataResult {
  const step = (detail: string): DataResult['step'] => ({ label: L('Gravou', 'Wrote'), detail })
  try {
    const { changes } = data.execute(agentId, sql, params)
    // CREATE, DROP and ALTER touch no rows: a count of 0 there would read as "nothing happened".
    if (/^\s*(create|drop|alter)\b/i.test(codeOf(sql))) return { text: L('Feito.', 'Done.'), step: step(snip(sql, 80)) }
    const done = changes === 1 ? L('1 linha afetada', '1 row affected') : L(`${changes} linhas afetadas`, `${changes} rows affected`)
    return { text: L(`Feito: ${done}.`, `Done: ${done}.`), step: step(`${snip(sql, 80)} · ${done}`) }
  } catch (e) {
    return { text: sqlError(e), error: true, step: step(snip(sql)) }
  }
}

function sqlError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/database or disk is full/i.test(msg)) return L(`Seus dados chegaram ao limite de ${MAX_DB_MB} MB: apague o que não precisa mais antes de gravar.`, `Your data reached the ${MAX_DB_MB} MB limit: delete what you no longer need before writing.`)
  return L(`Erro do SQLite: ${msg}`, `SQLite error: ${msg}`)
}
