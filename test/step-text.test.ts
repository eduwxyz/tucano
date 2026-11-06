import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { commandStep, execSummary, keyArg, maskSecrets, resultSummary, sqlIn } from '../src/core/step-text'

beforeAll(() => setLang('en'))
afterAll(() => setLang('pt'))

describe('keyArg: the argument that says what a call did', () => {
  it('picks the SQL, the path or the search over the rest', () => {
    expect(keyArg({ warehouse_id: 'abc', statement: 'select 1' })).toBe('select 1')
    expect(keyArg({ limit: 10, Query: 'tucano' })).toBe('tucano')
    expect(keyArg({ path: '/tmp/a.csv', encoding: 'utf8' })).toBe('/tmp/a.csv')
  })
  it('falls back to the first text argument, never the reason the agent gave', () => {
    expect(keyArg({ _motivo: 'because', catalog: 'main' })).toBe('main')
    expect(keyArg({ flag: true })).toBeUndefined()
  })
  it('keeps a long statement whole up to a cap', () => {
    expect(keyArg({ sql: 'x'.repeat(5000) })!.length).toBe(4001)
  })
})

describe('resultSummary: a result in a few words', () => {
  it('counts rows of CSV, TSV and Markdown tables', () => {
    expect(resultSummary('region,total\nSul,120\nSudeste,340')).toBe('2 rows')
    expect(resultSummary('a\tb\n1\t2')).toBe('1 row')
    expect(resultSummary('| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |')).toBe('3 rows')
  })
  it('counts rows of SQL answers in JSON, Databricks shapes included', () => {
    expect(resultSummary(JSON.stringify({ manifest: { total_row_count: 1200 }, result: { data_array: [[1]] } }))).toBe('1,200 rows')
    expect(resultSummary(JSON.stringify({ result: { data_array: [[1], [2], [3]] } }))).toBe('3 rows')
    expect(resultSummary(JSON.stringify([{ id: 1 }, { id: 2 }]))).toBe('2 items')
  })
  it('says how long a long text is, and shows a short one', () => {
    expect(resultSummary('a\nb\nc\nd\ne')).toBe('5 lines of text')
    expect(resultSummary('Created issue ENG-12')).toBe('Created issue ENG-12')
    expect(resultSummary('   ')).toBe('No result')
  })
  it('says when the result was cut', () => {
    expect(resultSummary('id,name\n1,a\n2,b\n[… result cut at 40 KB: the rest didn\'t come through.]')).toBe('2 rows (cut)')
  })
})

// Made-up tokens, built so secret scanners don't take them for real ones.
const DAPI = ['dapi', '0123456789abcdef'.repeat(2)].join('')

describe('maskSecrets: a step never shows a secret', () => {
  const masked = (t: string): string => maskSecrets(t)
  it('masks token and password flags, headers and variables', () => {
    expect(masked(`databricks api get /api/2.0/clusters/list --token ${DAPI}`)).toBe('databricks api get /api/2.0/clusters/list --token ••••')
    expect(masked('psql --password="hunter2" -h db')).toBe('psql --password=•••• -h db')
    expect(masked('curl -H "Authorization: Bearer abc.def.ghi" https://x.cloud.databricks.com')).toBe('curl -H "Authorization: Bearer ••••" https://x.cloud.databricks.com')
    expect(masked('DATABRICKS_TOKEN=dapiXYZ databricks fs ls')).toBe('DATABRICKS_TOKEN=•••• databricks fs ls')
    expect(masked('export AWS_SECRET_ACCESS_KEY="abc/def"')).toBe('export AWS_SECRET_ACCESS_KEY=••••')
    expect(masked('mysql -u root -phunter2 -e "select 1"')).toBe('mysql -u root -p•••• -e "select 1"')
    expect(masked('psql postgres://app:s3cret@db:5432/main')).toBe('psql postgres://app:••••@db:5432/main')
  })
  it('masks tokens by their shape and in JSON or YAML output', () => {
    expect(masked(`using ${DAPI}-2 now`)).toBe('using •••• now')
    expect(masked('ghp_' + 'a'.repeat(36))).toBe('••••')
    expect(masked('{"host": "x", "token": "abc123"}')).toBe('{"host": "x", "token": "••••"}')
    expect(masked('password: abc123')).toBe('password: ••••')
  })
  it('leaves ordinary commands alone', () => {
    for (const c of ['mkdir -p /tmp/out', 'databricks -p prod fs ls dbfs:/', 'ssh -p 2222 host', 'echo $max_tokens', 'select author from books']) expect(masked(c)).toBe(c)
  })

  // The core waits while a step is masked: a long run of word characters (base64, a hash, a minified
  // line) used to take seconds on 40 KB.
  it('masks a long text in a blink, whatever it is made of', () => {
    for (const s of ['a'.repeat(40_000), 'QUJD'.repeat(10_000), 'a.'.repeat(20_000), 'a-'.repeat(20_000), 'mysql '.repeat(7000), 'x://a:'.repeat(7000)]) {
      const t0 = performance.now()
      maskSecrets(s)
      expect(performance.now() - t0).toBeLessThan(250)
    }
  })
})

describe('sqlIn and commandStep: the SQL inside a command', () => {
  it('finds it after --statement, -e, -c, in --json, and in a heredoc', () => {
    expect(sqlIn('databricks sql execute --warehouse-id abc --statement "select * from main.sales.orders limit 10"')).toBe('select * from main.sales.orders limit 10')
    expect(sqlIn(`psql -h db -c 'SELECT count(*) FROM t'`)).toBe('SELECT count(*) FROM t')
    expect(sqlIn(`databricks api post /api/2.0/sql/statements --json '{"warehouse_id": "w1", "statement": "select 1 as \\"x\\""}'`)).toBe('select 1 as "x"')
    expect(sqlIn("databricks-query <<'SQL'\nselect region, sum(total)\nfrom main.sales.daily\ngroup by 1\nSQL")).toBe('select region, sum(total)\nfrom main.sales.daily\ngroup by 1')
    expect(sqlIn('python -c "print(1)"')).toBeUndefined()
    expect(sqlIn('ls -la')).toBeUndefined()
  })
  it('shows the SQL, masked, with the command line as the detail; or the whole command', () => {
    expect(commandStep('DATABRICKS_TOKEN=dapiX databricks sql execute --statement "select 1"')).toEqual({ sql: true, input: 'select 1', detail: 'DATABRICKS_TOKEN=•••• databricks sql execute --statement "…"' })
    expect(commandStep('cat a.csv | wc -l')).toEqual({ sql: false, input: 'cat a.csv | wc -l', detail: '' })
  })
})

describe('execSummary: how a command ended', () => {
  it('counts the rows a CLI printed, or says it printed nothing', () => {
    const box = '+--------+-------+\n| region | total |\n+--------+-------+\n| Sul    |   120 |\n| Norte  |    80 |\n+--------+-------+'
    expect(execSummary(`exit code 0\n--- stdout ---\n${box}`, false)).toEqual({ output: '2 rows' })
    expect(execSummary('exit code 0\n--- stdout ---\nid,name\n1,a', false)).toEqual({ output: '1 row' })
    expect(execSummary('exit code 0\n(no output)', false)).toEqual({ output: 'No output' })
  })
  it('gives the exit code and the end of stderr on failure, masked', () => {
    expect(execSummary(`exit code 1\n--- stderr ---\nretrying...\nError: Invalid access token ${DAPI}`, true)).toEqual({
      error: 'exit code 1: retrying...\nError: Invalid access token ••••'
    })
  })
})
