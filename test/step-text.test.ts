import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { keyArg, resultSummary } from '../src/core/step-text'

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
