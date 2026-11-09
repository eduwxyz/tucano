// A query's rows, kept with its step as a table: read from what the tool answered, only for SQL, never with a secret.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, EngineId, Message, Settings, Step } from '../src/shared/types'
import { formatExec } from '../src/core/computer'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { isSql, resultTable, stdoutOf } from '../src/core/step-text'
import { nextSort, tableCsv, tableMarkdown, viewRows } from '../src/renderer/src/components/ResultTable'
import { transcriptBlocks } from '../src/core/context'

const TOKEN = ['dapi', '0123456789abcdef'.repeat(2)].join('')

describe('reading a result as a table', () => {
  it('reads Databricks’ statement API', () => {
    const t = resultTable(JSON.stringify({ statement_id: 's1', status: { state: 'SUCCEEDED' }, manifest: { schema: { columns: [{ name: 'region' }, { name: 'total' }] }, total_row_count: 2 }, result: { data_array: [['Sul', '120.5'], ['Norte', null]] } }))
    expect(t).toEqual({ columns: ['region', 'total'], numeric: [false, true], rows: [['Sul', '120.5'], ['Norte', null]], total: 2 })
  })

  it('reads a list of objects, with every key as a column', () => {
    const t = resultTable(JSON.stringify([{ a: 1, b: 'x' }, { a: 2, c: true }]))
    expect(t).toMatchObject({ columns: ['a', 'b', 'c'], numeric: [true, false, false], rows: [['1', 'x', null], ['2', null, 'true']] })
  })

  it('reads rows under a key, and the total the answer gives', () => {
    expect(resultTable(JSON.stringify({ rows: [{ n: 1 }], row_count: 500 }))).toMatchObject({ rows: [['1']], total: 500 })
  })

  it('reads a box, Markdown, psql and CSV', () => {
    expect(resultTable('+--------+-------+\n| region | total |\n+--------+-------+\n| Sul    |   120 |\n| Norte  |    80 |\n+--------+-------+')).toMatchObject({ columns: ['region', 'total'], numeric: [false, true], rows: [['Sul', '120'], ['Norte', '80']] })
    expect(resultTable('| a | b |\n|---|--:|\n| x | 1 |')).toMatchObject({ columns: ['a', 'b'], rows: [['x', '1']] })
    expect(resultTable(' region | total \n--------+-------\n Sul    |   120\n(1 row)')).toMatchObject({ columns: ['region', 'total'], rows: [['Sul', '120']] })
    expect(resultTable('name,city\n"Silva, Ana",Rio\nBia,"São ""Paulo"""')).toMatchObject({ columns: ['name', 'city'], rows: [['Silva, Ana', 'Rio'], ['Bia', 'São "Paulo"']] })
    expect(resultTable('a\tb\n1\t2')).toMatchObject({ numeric: [true, true] })
  })

  it('isn’t a table for text, one line, or JSON that isn’t rows', () => {
    expect(resultTable('Done, 3 rows affected')).toBeUndefined()
    expect(resultTable('one,two')).toBeUndefined()
    expect(resultTable(JSON.stringify({ ok: true }))).toBeUndefined()
    expect(resultTable(JSON.stringify([1, 2, 3]))).toBeUndefined()
    expect(resultTable('')).toBeUndefined()
  })

  it('keeps a preview: 100 rows, 30 columns, short cells, and the real total', () => {
    const many = Array.from({ length: 250 }, (_, i) => Object.fromEntries(Array.from({ length: 40 }, (_, c) => [`c${c}`, c === 0 ? 'x'.repeat(500) : i])))
    const t = resultTable(JSON.stringify(many))!
    expect(t.rows).toHaveLength(100)
    expect(t.columns).toHaveLength(30)
    expect(t.total).toBe(250)
    expect(t.rows[0]![0]!.length).toBeLessThanOrEqual(201)
  })

  it('says when the result itself came cut', () => {
    expect(resultTable('a,b\n1,2\n[… result cut: 40 KB of 900 KB]')).toMatchObject({ cut: true, rows: [['1', '2']] })
  })

  it('never keeps a secret', () => {
    const t = resultTable(JSON.stringify([{ name: 'job', conf: `token=${TOKEN}` }]))!
    expect(JSON.stringify(t)).not.toContain(TOKEN)
  })

  it('tells SQL apart, and finds a command’s output', () => {
    expect(isSql('  SELECT * FROM t')).toBe(true)
    expect(isSql('show tables')).toBe(true)
    expect(isSql('list my issues')).toBe(false)
    expect(isSql(undefined)).toBe(false)
    expect(stdoutOf(formatExec({ code: 0, stdout: 'a,b\n1,2', stderr: 'warn' }, 10))).toBe('a,b\n1,2')
  })
})

describe('copying a table', () => {
  const t = { columns: ['name', 'n'], numeric: [false, true], rows: [['Silva, Ana', '1'], ['a|b', null]], total: 2 }
  it('as CSV, quoting what needs it', () => {
    expect(tableCsv(t)).toBe('name,n\n"Silva, Ana",1\na|b,')
  })
  it('as Markdown, with numbers to the right and NULL said', () => {
    expect(tableMarkdown(t)).toBe('| name | n |\n| --- | ---: |\n| Silva, Ana | 1 |\n| a\\|b | NULL |')
  })
})

describe('sorting and filtering a table', () => {
  const t = { columns: ['state', 'buyer', 'total'], numeric: [false, false, true], rows: [['SP', 'Ana', '1,200.5'], ['RJ', 'bia', '90'], ['MG', null, '1000'], ['sp', 'Caio', null]], total: 4 }

  it('goes up, down, then back to how it came', () => {
    expect(nextSort(null, 2)).toEqual({ column: 2, dir: 'asc' })
    expect(nextSort({ column: 2, dir: 'asc' }, 2)).toEqual({ column: 2, dir: 'desc' })
    expect(nextSort({ column: 2, dir: 'desc' }, 2)).toBeNull()
    expect(nextSort({ column: 2, dir: 'desc' }, 0)).toEqual({ column: 0, dir: 'asc' })
  })

  it('sorts numbers as numbers, and nulls last either way', () => {
    expect(viewRows(t, { column: 2, dir: 'asc' }, '').map((r) => r[2])).toEqual(['90', '1000', '1,200.5', null])
    expect(viewRows(t, { column: 2, dir: 'desc' }, '').map((r) => r[2])).toEqual(['1,200.5', '1000', '90', null])
  })

  it('sorts text ignoring case', () => {
    expect(viewRows(t, { column: 1, dir: 'asc' }, '').map((r) => r[1])).toEqual(['Ana', 'bia', 'Caio', null])
  })

  it('filters on any cell, ignoring case, and keeps the order picked', () => {
    expect(viewRows(t, null, 'sp').map((r) => r[1])).toEqual(['Ana', 'Caio'])
    expect(viewRows(t, { column: 1, dir: 'desc' }, 'sp').map((r) => r[1])).toEqual(['Caio', 'Ana'])
    expect(viewRows(t, null, 'nada')).toEqual([])
    expect(viewRows(t, null, '  ')).toHaveLength(4)
  })

  it('leaves the table it was given as it was', () => {
    viewRows(t, { column: 0, dir: 'asc' }, '')
    expect(t.rows[0]![0]).toBe('SP')
  })
})

describe('a later question about the rows', () => {
  it('sees which query they came from, and is told to build on it', () => {
    const agent = { id: 'theo', name: 'Theo', handle: 'theo', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1, used: 0, grants: {}, memory: 'read', computer: false, archived: false } as Agent
    const reply: Message = { id: 'r', conversationId: 'dm', author: { kind: 'agent', id: 'theo' }, text: 'O Sul lidera.', at: 2, run: { status: 'done', steps: [{ id: 's', label: 'Looked up', status: 'done', input: 'select state, buyer, total from sales', table: { columns: ['state', 'buyer', 'total'], numeric: [false, false, true], rows: [['SP', 'Ana', '1']], total: 5000 } }] } }
    const text = transcriptBlocks({ agent, conversation: { id: 'dm', kind: 'dm', name: 'theo', members: ['theo'] }, messages: [reply], agents: [agent], me: 'Edu' } as Parameters<typeof transcriptBlocks>[0]).blocks.join('\n')
    expect(text).toContain('select state, buyer, total from sales')
    expect(text).toContain('columns state, buyer, total; 5000 rows')
    expect(text).toContain('run a new query built from this one')
    expect(text).not.toContain('Ana')
  })
})

// ---------- through a reply ----------

const ready = { installed: true, loggedIn: true }
const STATEMENT = JSON.stringify({ manifest: { schema: { columns: [{ name: 'region' }, { name: 'total' }] }, total_row_count: 2 }, result: { data_array: [['Sul', '120'], ['Norte', '80']] } })
let db: Db
let gateway: Gateway
let settings: Settings
let answers: string[]

function scripted(id: EngineId, calls: [string, Record<string, unknown>][]): Engine {
  return {
    id,
    async *run(turn) {
      if (turn.mcpUrl) for (const [name, args] of calls) answers.push(JSON.stringify(await callTool(turn.mcpUrl, name, args)))
      yield { type: 'text', delta: 'feito' }
      yield { type: 'done', text: 'feito', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 } }
    }
  }
}

async function reply(calls: [string, Record<string, unknown>][], extra: Partial<Agent> = {}): Promise<Step[]> {
  db.saveAgent({ id: 'theo', name: 'Theo', handle: 'theo', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: { dbx: 'read' }, memory: 'read', computer: false, archived: false, ...extra })
  db.createConversation({ id: 'dm', kind: 'dm', name: 'theo', members: ['theo'] })
  db.saveConnector({ id: 'dbx', name: 'Databricks', kind: 'remote', url: 'https://example.invalid/mcp', auth: 'none' })
  db.syncTools('dbx', [
    { name: 'execute_sql', description: '', inputSchema: { type: 'object', properties: { statement: { type: 'string' } } }, cls: 'read' },
    { name: 'list_jobs', description: '', inputSchema: { type: 'object', properties: {} }, cls: 'read' }
  ])
  const engines = Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'gemini', 'cursor', 'grok'] as EngineId[]).map((e) => [e, e === 'claude' ? scripted(e, calls) : fakeEngine(e)])) as Record<EngineId, Engine>
  const connectors = {
    list: () => db.connectors().map((c) => ({ ...c, status: 'connected' as const })),
    call: async (_id: string, name: string) => textResult(name === 'execute_sql' ? STATEMENT : JSON.stringify([{ job_id: 1, name: 'vendas' }]))
  }
  const computers = { call: async () => ({ result: textResult(formatExec({ code: 0, stdout: '+--------+-------+\n| region | total |\n+--------+-------+\n| Sul    |   120 |\n+--------+-------+', stderr: '' }, 50)) }) }
  const runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'rt-w-')), gateway, connectors, computers })
  await runner.send('dm', 'quanto vendemos?')
  await runner.idle()
  return db.messages().filter((m: Message) => m.author.kind === 'agent').at(-1)!.run!.steps
}

beforeAll(() => setLang('en'))
afterAll(() => setLang('pt'))
beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'rt-db-')), 'test.db'))
  answers = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('a query in a reply', () => {
  it('keeps the rows a connector’s SQL brought back, and tells the agent they show', async () => {
    const steps = await reply([['databricks__execute_sql', { statement: 'select region, total from sales' }]])
    const step = steps.find((s) => s.table)!
    expect(step).toMatchObject({ input: 'select region, total from sales', output: '2 rows', table: { columns: ['region', 'total'], rows: [['Sul', '120'], ['Norte', '80']], total: 2 } })
    expect(answers[0]).toContain('These rows show in a table below your reply')
  })

  it('keeps none for a call that isn’t a query, and says nothing about a table', async () => {
    const steps = await reply([['databricks__list_jobs', {}]])
    expect(steps.some((s) => s.table)).toBe(false)
    expect(answers[0]).not.toContain('These rows show')
  })

  it('keeps the rows of SQL run from a command', async () => {
    const steps = await reply([['bash', { command: 'databricks api post /api/2.0/sql/statements --json \'{"statement": "select region, total from sales"}\'' }]], { computer: true, computerKind: 'mac' })
    expect(steps.find((s) => s.table)?.table).toMatchObject({ columns: ['region', 'total'], rows: [['Sul', '120']] })
    expect(answers[0]).toContain('These rows show in a table below your reply')
  })

  it('keeps none for a command that isn’t SQL', async () => {
    const steps = await reply([['bash', { command: 'cat report.txt' }]], { computer: true, computerKind: 'mac' })
    expect(steps.some((s) => s.table)).toBe(false)
  })
})
