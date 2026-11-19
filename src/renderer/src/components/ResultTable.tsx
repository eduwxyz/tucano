// What a query brought back, under the reply: a preview of its rows, to sort, filter and copy.
import { useMemo, useState, type ReactNode } from 'react'
import { L, locale } from '../../../shared/lang'
import type { ResultTable, Step } from '../../../shared/types'
import { Icon, duration } from './ui'

const csvCell = (v: string | null): string => (v === null ? '' : /[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const mdCell = (v: string | null): string => (v === null ? 'NULL' : v.replace(/\|/g, '\\|').replace(/\n/g, ' '))

export const tableCsv = (t: Pick<ResultTable, 'columns' | 'rows'>): string => [t.columns, ...t.rows].map((r) => r.map(csvCell).join(',')).join('\n')
export const tableMarkdown = (t: Pick<ResultTable, 'columns' | 'rows' | 'numeric'>): string =>
  [`| ${t.columns.map(mdCell).join(' | ')} |`, `| ${t.columns.map((_, i) => (t.numeric[i] ? '---:' : '---')).join(' | ')} |`, ...t.rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n')

export type Sort = { column: number; dir: 'asc' | 'desc' } | null

// Ascending, then descending, then as it came.
export const nextSort = (sort: Sort, column: number): Sort => (sort?.column !== column ? { column, dir: 'asc' } : sort.dir === 'asc' ? { column, dir: 'desc' } : null)

const asNumber = (v: string): number => Number(v.replace(/,(?=\d{3}\b)/g, '').replace(',', '.'))

// The rows as shown: those with the filter in any cell, in the order asked. Numbers sort as numbers,
// text as the language sorts it, and nulls always last.
export function viewRows(t: Pick<ResultTable, 'rows' | 'numeric'>, sort: Sort, filter: string): (string | null)[][] {
  const q = filter.trim().toLocaleLowerCase(locale())
  const rows = q ? t.rows.filter((r) => r.some((v) => v !== null && v.toLocaleLowerCase(locale()).includes(q))) : t.rows
  if (!sort) return rows
  const { column: c, dir } = sort
  const collator = new Intl.Collator(locale(), { numeric: true, sensitivity: 'base' })
  return [...rows].sort((a, b) => {
    const x = a[c] ?? null
    const y = b[c] ?? null
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    const d = t.numeric[c] ? asNumber(x) - asNumber(y) : collator.compare(x, y)
    return dir === 'asc' ? d : -d
  })
}

export function ResultTableCard({ step }: { step: Step }): ReactNode {
  const [copied, setCopied] = useState<'csv' | 'md' | null>(null)
  const [sqlOpen, setSqlOpen] = useState(false)
  const [sort, setSort] = useState<Sort>(null)
  const [filter, setFilter] = useState('')
  const t = step.table
  const rows = useMemo(() => (t ? viewRows(t, sort, filter) : []), [t, sort, filter])
  if (!t) return null
  const n = (x: number): string => x.toLocaleString(locale())
  // What's copied is what's shown: filtered and in the order picked.
  const copy = (kind: 'csv' | 'md'): void => {
    const view = { ...t, rows }
    void navigator.clipboard.writeText(kind === 'csv' ? tableCsv(view) : tableMarkdown(view)).then(() => {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    })
  }
  const partial = t.rows.length < t.total || !!t.cut
  return (
    <div className="result-card">
      <div className="result-card__head">
        <Icon name="table" size={14} />
        <strong>{L('Resultado da consulta', 'Query result')}</strong>
        <span className="muted small">
          {L(`${n(t.total)} ${t.total === 1 ? 'linha' : 'linhas'}`, `${n(t.total)} ${t.total === 1 ? 'row' : 'rows'}`)} · {L(`${n(t.columns.length)} colunas`, `${n(t.columns.length)} columns`)}
          {step.ms ? ` · ${duration(step.ms)}` : ''}
        </span>
        {t.rows.length > 1 && (
          <input className="result-card__filter" type="search" value={filter} placeholder={L('Filtrar linhas', 'Filter rows')} aria-label={L('Filtrar linhas', 'Filter rows')} onChange={(e) => setFilter(e.target.value)} />
        )}
      </div>
      {step.input && (
        <button className={`result-card__sql ${sqlOpen ? 'is-open' : ''}`} onClick={() => setSqlOpen(!sqlOpen)} title={sqlOpen ? undefined : step.input}>
          {step.input}
        </button>
      )}
      <div className="result-card__scroll">
        <table className="result-card__table">
          <thead>
            <tr>
              {t.columns.map((c, i) => {
                const on = sort?.column === i ? sort.dir : undefined
                return (
                  <th key={i} className={t.numeric[i] ? 'is-number' : ''} aria-sort={on === 'asc' ? 'ascending' : on === 'desc' ? 'descending' : 'none'}>
                    <button className={`result-card__sort ${on ? 'is-on' : ''}`} onClick={() => setSort(nextSort(sort, i))} title={L('Ordenar por esta coluna', 'Sort by this column')}>
                      {c}
                      <span className="result-card__arrow" aria-hidden>
                        {on === 'asc' ? '↑' : on === 'desc' ? '↓' : '↕'}
                      </span>
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((v, ci) => (
                  <td key={ci} className={v === null ? 'is-null' : t.numeric[ci] ? 'is-number' : ''} title={v && v.length > 40 ? v : undefined}>
                    {v ?? 'null'}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="result-card__empty" colSpan={t.columns.length}>
                  {L('Nenhuma linha com esse filtro.', 'No rows with that filter.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="result-card__foot">
        <button className="btn btn--xs btn--ghost" onClick={() => copy('csv')}>
          {copied === 'csv' ? L('Copiado', 'Copied') : L('Copiar CSV', 'Copy CSV')}
        </button>
        <button className="btn btn--xs btn--ghost" onClick={() => copy('md')}>
          {copied === 'md' ? L('Copiado', 'Copied') : L('Copiar Markdown', 'Copy Markdown')}
        </button>
        <span className="muted small result-card__count">
          {filter.trim()
            ? L(`${n(rows.length)} de ${n(t.rows.length)} linhas com o filtro`, `${n(rows.length)} of ${n(t.rows.length)} rows match`)
            : partial
              ? L(`Mostrando ${n(t.rows.length)} de ${t.cut ? 'mais de ' : ''}${n(t.total)} linhas`, `Showing ${n(t.rows.length)} of ${t.cut ? 'over ' : ''}${n(t.total)} rows`)
              : L(`Todas as ${n(t.rows.length)} linhas`, `All ${n(t.rows.length)} rows`)}
          {partial && (sort || filter.trim()) ? L(' · ordena e filtra só as mostradas', ' · sorts and filters only those shown') : ''}
        </span>
      </div>
    </div>
  )
}
