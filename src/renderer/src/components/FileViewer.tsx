// What shows a file: the chat's side panel (an artifact) and Documentos (a document) use this one
// viewer. It only draws; where the file lives and how its text is read come in as props.
import { useEffect, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { L } from '../../../shared/lang'
import type { DocKind } from '../../../shared/docs'
import { safeUrl } from '../links'
import type { ArtifactKind } from '../store'
import { Icon } from './ui'

export const bytes = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

export interface ViewerFile {
  url: string
  kind: ArtifactKind | DocKind
  name: string
  title: string
  size: number
  loadText: () => Promise<string | null> // null: the file is gone
  missing?: string // said when the text can't be read
  fallback?: ReactNode // under "no preview", for a kind that has none (a button to show it in the Finder)
  note?: ReactNode // above the text of a Word or Excel file: it is a reading, not the file itself
}

const GONE = (): string => L('(o arquivo não abriu: pode ter sido movido ou apagado. Peça pro agente gerar de novo.)', '(the file didn’t open: it may have been moved or deleted. Ask the agent to make it again.)')

export function FileViewer({ url, kind, name, title, size, loadText, missing, fallback, note }: ViewerFile): ReactNode {
  const [text, setText] = useState<string | null>(null)
  const textual = kind === 'markdown' || kind === 'csv' || kind === 'text' || kind === 'docx' || kind === 'xlsx'
  useEffect(() => {
    setText(null)
    if (!textual) return
    let alive = true
    loadText().then(
      (t) => alive && setText(t ?? missing ?? GONE()),
      () => alive && setText(missing ?? L('Não consegui abrir este arquivo.', "I couldn't open this file."))
    )
    return () => {
      alive = false
    }
    // loadText is rebuilt on every render; what it reads is named by the url
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, textual])

  if (textual && text === null)
    return (
      <div className="dc-state" role="status">
        <span className="dc-spinner" />
        <p>{L('Abrindo o arquivo…', 'Opening the file…')}</p>
      </div>
    )

  switch (kind) {
    case 'image':
      return (
        <div className="side-panel__image">
          <img src={url} alt={title} />
        </div>
      )
    case 'video':
      return (
        <div className="side-panel__image">
          <video src={url} controls preload="metadata" />
        </div>
      )
    case 'html':
      return <iframe src={url} sandbox="allow-scripts allow-popups" title={title} />
    case 'pdf':
      return <iframe src={url} title={title} />
    case 'markdown':
      return <div className="side-panel__doc md">{text !== null && <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]}>{text}</Markdown>}</div>
    case 'csv':
      return <div className="side-panel__doc">{text !== null && <CsvTable text={text} tab={name.endsWith('.tsv')} />}</div>
    case 'text':
      return <pre className="side-panel__text">{text}</pre>
    case 'docx':
    case 'xlsx':
      return (
        <>
          {note && <div className="fv-note">{note}</div>}
          <pre className="side-panel__text fv-reading">{text}</pre>
        </>
      )
    default:
      return (
        <div className="side-panel__empty">
          <div className="empty">
            <Icon name="clip" size={22} />
            <p>{L('Sem visualização pra esse tipo de arquivo', 'No preview for this kind of file')}</p>
            <p className="muted">
              {name} · {bytes(size)}
            </p>
            {fallback}
          </div>
        </div>
      )
  }
}

// Enough CSV for a preview: quoted fields, escaped quotes, first 500 rows.
export function parseCsv(text: string, sep = ','): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length && rows.length < 500; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++
      else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === sep) row.push(field), (field = '')
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field), rows.push(row), (row = []), (field = '')
    } else field += c
  }
  if (field || row.length) row.push(field), rows.push(row)
  return rows
}

function CsvTable({ text, tab }: { text: string; tab: boolean }): ReactNode {
  const [head = [], ...rows] = parseCsv(text, tab ? '\t' : ',')
  return (
    <table className="csv">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={i}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
