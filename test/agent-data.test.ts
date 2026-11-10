import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { AgentData, checkSql, codeOf } from '../src/core/agent-data'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

describe('checking the SQL', () => {
  it('a query only reads, and a change only writes', () => {
    expect(checkSql('SELECT * FROM precos', 'read')).toEqual({ ok: true, destructive: false })
    expect(checkSql('WITH t AS (SELECT 1 AS n) SELECT n FROM t', 'read')).toMatchObject({ ok: true })
    expect(checkSql('INSERT INTO precos VALUES (1)', 'read')).toMatchObject({ ok: false })
    expect(checkSql('SELECT 1', 'write')).toMatchObject({ ok: false, error: expect.stringContaining('dados_consultar') })
    expect(checkSql('CREATE TABLE precos (trecho TEXT, preco REAL)', 'write')).toEqual({ ok: true, destructive: false })
  })

  it('one statement per call, but a ; inside a value is fine', () => {
    expect(checkSql('SELECT 1; DROP TABLE precos', 'read')).toMatchObject({ ok: false })
    expect(checkSql('SELECT 1;', 'read')).toMatchObject({ ok: true })
    expect(checkSql("INSERT INTO notas VALUES ('a; b')", 'write')).toMatchObject({ ok: true })
  })

  it('never reaches other files or changes how SQLite runs', () => {
    for (const sql of ["ATTACH DATABASE '/tmp/x.db' AS x", 'PRAGMA writable_schema = 1', "VACUUM INTO '/tmp/copy.db'", "SELECT load_extension('x')", 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT i FROM n'])
      expect(checkSql(sql, sql.startsWith('SELECT') || sql.startsWith('WITH') ? 'read' : 'write')).toMatchObject({ ok: false })
    // The same words as values are only values.
    expect(checkSql("SELECT * FROM notas WHERE texto = 'pragma attach'", 'read')).toMatchObject({ ok: true })
  })

  it('knows what destroys data: DROP, ALTER … DROP, and DELETE or UPDATE without WHERE', () => {
    expect(checkSql('DROP TABLE precos', 'write')).toEqual({ ok: true, destructive: true })
    expect(checkSql('ALTER TABLE precos DROP COLUMN fonte', 'write')).toEqual({ ok: true, destructive: true })
    expect(checkSql('DELETE FROM precos', 'write')).toEqual({ ok: true, destructive: true })
    expect(checkSql('UPDATE precos SET preco = 0', 'write')).toEqual({ ok: true, destructive: true })
    expect(checkSql('DELETE FROM precos WHERE trecho = ?', 'write')).toEqual({ ok: true, destructive: false })
    expect(checkSql("UPDATE precos SET fonte = 'drop' WHERE id = 1", 'write')).toEqual({ ok: true, destructive: false })
    expect(checkSql('ALTER TABLE precos ADD COLUMN fonte TEXT', 'write')).toEqual({ ok: true, destructive: false })
    // A WHERE in a comment or a value doesn't count.
    expect(checkSql("DELETE FROM precos -- WHERE trecho = 'x'", 'write')).toEqual({ ok: true, destructive: true })
  })

  it('blanks values, quoted names and comments', () => {
    expect(codeOf(`SELECT 'it''s; drop' AS "x;y" /* ; */ FROM t -- ;`)).not.toContain(';')
  })
})

describe('the tables', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ad-data-'))
  })

  it('keep what was written across opens, each agent in its own file', () => {
    const data = new AgentData(join(dir, 'data'))
    expect(data.tables('a1')).toEqual([])
    expect(data.query('a1', 'SELECT 1 AS n')).toEqual({ rows: [{ n: 1 }], truncated: false })
    expect(() => data.query('a1', 'SELECT * FROM precos')).toThrow(/no such table/) // nothing yet, and reading makes no file
    expect(existsSync(data.file('a1'))).toBe(false)
    data.execute('a1', 'CREATE TABLE precos (trecho TEXT, preco REAL)')
    expect(data.execute('a1', 'INSERT INTO precos VALUES (?, ?), (?, ?)', ['GRU-EZE', 1016, 'GIG-EZE', 820])).toEqual({ changes: 2 })

    const again = new AgentData(join(dir, 'data'))
    expect(again.query('a1', 'SELECT trecho, preco FROM precos WHERE preco < ? ORDER BY preco', [1000]).rows).toEqual([{ trecho: 'GIG-EZE', preco: 820 }])
    expect(again.tables('a1')).toEqual([{ name: 'precos', type: 'table', columns: [{ name: 'trecho', type: 'TEXT' }, { name: 'preco', type: 'REAL' }], rows: 2 }])
    expect(again.tables('a2')).toEqual([])
  })

  it('a query runs on a read-only connection: it can never write', () => {
    const data = new AgentData(dir)
    data.execute('a1', 'CREATE TABLE t (n INTEGER)')
    expect(() => data.query('a1', 'INSERT INTO t VALUES (1)')).toThrow(/readonly/i)
    expect(data.query('a1', 'SELECT COUNT(*) AS n FROM t').rows).toEqual([{ n: 0 }])
  })

  it('a query stops at 200 rows and says so', () => {
    const data = new AgentData(dir)
    data.execute('a1', 'CREATE TABLE t (n INTEGER)')
    for (let i = 0; i < 250; i++) data.execute('a1', 'INSERT INTO t VALUES (?)', [i])
    const r = data.query('a1', 'SELECT n FROM t')
    expect(r.rows).toHaveLength(200)
    expect(r.truncated).toBe(true)
  })

  it('refuses an id that could leave its folder', () => {
    const data = new AgentData(dir)
    expect(() => data.file('../tucano')).toThrow()
  })
})

describe('in a reply', () => {
  const ready = { installed: true, loggedIn: true }
  const agent: Agent = { id: 'a1', name: 'Logistica', handle: 'logistica', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }
  let db: Db
  let data: AgentData
  let gateway: Gateway
  let settings: Settings
  let replies: string[]

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-data-run-'))
    db = new Db(join(dir, 'test.db'))
    data = new AgentData(join(dir, 'data'))
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', autonomy: 'careful' }
    replies = []
    gateway = new Gateway()
    await gateway.start()
    db.saveAgent(agent)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
  })

  afterEach(async () => {
    await gateway.stop()
  })

  // The agent makes these calls in its first turn, and nothing in the next ones.
  const runner = (calls: [string, Record<string, unknown>][]): Runner => {
    let first = true
    const claude: Engine = {
      id: 'claude',
      async *run(turn) {
        if (first) {
          first = false
          for (const [name, args] of calls) {
            const r = (await callTool(turn.mcpUrl!, name, args)) as { content: { text: string }[] }
            replies.push(r.content[0]!.text)
          }
        }
        yield { type: 'done', text: 'feito', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline') }
    return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, data })
  }
  const steps = (): string[] => db.messages().find((m) => m.author.kind === 'agent')!.run!.steps.map((s) => `${s.label}: ${s.detail}`)

  it('the agent creates a table, writes to it and reads it back, without asking even on careful', async () => {
    const r = runner([
      ['dados_alterar', { sql: 'CREATE TABLE precos (trecho TEXT, preco REAL)' }],
      ['dados_alterar', { sql: 'INSERT INTO precos VALUES (?, ?)', parametros: ['GRU-EZE', 1016] }],
      ['dados_consultar', { sql: 'SELECT MIN(preco) AS minimo FROM precos WHERE trecho = ?', parametros: ['GRU-EZE'] }],
      ['dados_tabelas', {}]
    ])
    await r.send('d1', 'grava o preço')
    await r.idle()

    expect(replies[1]).toBe('Feito: 1 linha afetada.')
    expect(JSON.parse(replies[2]!)).toEqual([{ minimo: 1016 }])
    expect(replies[3]).toBe('- precos: trecho TEXT, preco REAL · 1 linha')
    expect(db.approvals()).toEqual([])
    expect(steps()).toEqual(expect.arrayContaining(['Alterou os dados: INSERT INTO precos VALUES (?, ?) · 1 linha afetada', 'Viu as tabelas: 1 tabela']))
  })

  it('a SQL error comes back to the agent as an error, nothing more', async () => {
    const r = runner([['dados_consultar', { sql: 'SELECT * FROM nao_existe' }]])
    await r.send('d1', 'consulta')
    await r.idle()
    expect(replies[0]).toContain('no such table: nao_existe')
  })

  it('destroying data asks first on careful, and approving runs exactly that SQL', async () => {
    data.execute('a1', 'CREATE TABLE precos (trecho TEXT)')
    data.execute('a1', "INSERT INTO precos VALUES ('GRU-EZE')")
    const r = runner([['dados_alterar', { sql: 'DELETE FROM precos', _motivo: 'recomeçar o histórico' }]])
    await r.send('d1', 'limpa a tabela')
    await r.idle()

    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', connectorId: 'dados', tool: 'dados_alterar', args: { sql: 'DELETE FROM precos' }, why: 'recomeçar o histórico', highRisk: true })
    expect(replies[0]).toContain('NÃO rodou')
    expect(data.query('a1', 'SELECT COUNT(*) AS n FROM precos').rows).toEqual([{ n: 1 }])

    await r.decide(ap!.id, 'approved')
    await r.idle()
    expect(db.approval(ap!.id)).toMatchObject({ state: 'approved', outcome: 'Executou.' })
    expect(data.query('a1', 'SELECT COUNT(*) AS n FROM precos').rows).toEqual([{ n: 0 }])
  })

  it('refusing deletes nothing', async () => {
    data.execute('a1', 'CREATE TABLE precos (trecho TEXT)')
    const r = runner([['dados_alterar', { sql: 'DROP TABLE precos' }]])
    await r.send('d1', 'apaga a tabela')
    await r.idle()
    const ap = db.approvals()[0]!
    await r.decide(ap.id, 'refused', 'ainda uso')
    await r.idle()
    expect(db.approval(ap.id)).toMatchObject({ state: 'refused', outcome: 'Nada foi apagado.' })
    expect(data.tables('a1').map((t) => t.name)).toEqual(['precos'])
  })

  it('with deleting set to run on its own, destroying data runs right away', async () => {
    db.saveAgent({ ...agent, actionRules: { delete: 'auto' } })
    data.execute('a1', 'CREATE TABLE precos (trecho TEXT)')
    const r = runner([['dados_alterar', { sql: 'DROP TABLE precos' }]])
    await r.send('d1', 'apaga a tabela')
    await r.idle()
    expect(db.approvals()).toEqual([])
    expect(data.tables('a1')).toEqual([])
  })
})
