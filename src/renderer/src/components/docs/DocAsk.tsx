// Asking the documents: the box that also searches, the answer (with the files it came from) and the
// small panel at the bottom of an open file. The answer cites its files as numbered chips; a chip
// takes you to its file. Editing the text drops the answer; an error shows the sentence it came with.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc, DocAnswer, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate } from '../../store'
import { message } from '../Invite'
import { Icon } from '../ui'
import { DocRow } from './doc-ui'
import { pathText } from './useDocs'

// Three words or a question mark: it reads like a question, so the button to ask shows up.
export const askable = (q: string): boolean => {
  const t = q.trim()
  return t.endsWith('?') || t.split(/\s+/).filter(Boolean).length >= 3
}

type AskState = { status: 'idle' } | { status: 'busy' } | { status: 'done'; answer: DocAnswer } | { status: 'error'; text: string }
const IDLE: AskState = { status: 'idle' }

export interface Asking {
  state: AskState
  // True while the question is being read and while its answer shows: the file results below hide then.
  answering: boolean
  ask: (q: string) => void
  retry: () => void
  clear: () => void
}

// `scope`: ask in one folder (and under it) or about one file; nothing: every file I see.
export function useAsk(scope: { folderId?: string; docId?: string } = {}): Asking {
  const [state, setState] = useState<AskState>(IDLE)
  const seq = useRef(0)
  const last = useRef('')
  const ask = (q: string): void => {
    const text = q.trim()
    if (!text) return
    last.current = text
    const mine = ++seq.current
    setState({ status: 'busy' })
    call('docAsk', { q: text, ...(scope.folderId ? { folderId: scope.folderId } : {}), ...(scope.docId ? { docId: scope.docId } : {}) }).then(
      (answer) => mine === seq.current && setState({ status: 'done', answer }),
      (e: unknown) => mine === seq.current && setState({ status: 'error', text: message(e) })
    )
  }
  const clear = (): void => {
    seq.current++
    setState((s) => (s.status === 'idle' ? s : IDLE))
  }
  const answering = state.status === 'busy' || state.status === 'done'
  return { state, answering, ask, retry: () => ask(last.current), clear }
}

// ---------- the box ----------

export function SearchBox({ value, onChange, onAsk, busy, placeholder, label, always }: { value: string; onChange: (v: string) => void; onAsk: () => void; busy: boolean; placeholder: string; label: string; always?: boolean }): ReactNode {
  const canAsk = !!value.trim() && (always || askable(value))
  const field = useRef<HTMLInputElement>(null)
  return (
    <label className="dc-search">
      <Icon name="search" size={16} />
      <input
        ref={field}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter asks only when the text reads as a question; otherwise the live file results already answer it.
          if (e.key === 'Enter' && canAsk && !busy && !e.nativeEvent.isComposing) (e.preventDefault(), onAsk())
        }}
        placeholder={placeholder}
        aria-label={label}
        maxLength={300}
      />
      {value && (
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => (onChange(''), field.current?.focus())}>
          {L('Limpar', 'Clear')}
        </button>
      )}
      {canAsk && (
        <button type="button" className="btn btn--sm dc-ask-btn" disabled={busy} onClick={onAsk}>
          <Icon name="spark" size={13} /> {always ? L('Perguntar', 'Ask') : L('Perguntar aos documentos', 'Ask the documents')}
        </button>
      )}
    </label>
  )
}

// ---------- the answer ----------

// The answer's paragraphs, each [n] as a small numbered chip. `onChip` undefined: the marks are dropped (no files to point to).
function AnswerText({ text, known, onChip }: { text: string; known: Set<number>; onChip?: (n: number) => void }): ReactNode {
  return (
    <>
      {text
        .split(/\n{2,}/)
        .filter((p) => p.trim())
        .map((p, i) => (
          <p key={i}>
            {p.split(/(\[\d+\])/).map((part, j) => {
              const n = /^\[(\d+)\]$/.exec(part)?.[1]
              if (n === undefined) return part
              if (!onChip || !known.has(Number(n))) return null
              return (
                <button key={j} className="dc-cite" title={L(`Ver o arquivo ${n}`, `See file ${n}`)} aria-label={L(`Ver o arquivo ${n}`, `See file ${n}`)} onClick={() => onChip(Number(n))}>
                  {n}
                </button>
              )
            })}
          </p>
        ))}
    </>
  )
}

export function AskAnswer({ asking, tree, withFiles = true }: { asking: Asking; tree?: DocsTree; withFiles?: boolean }): ReactNode {
  const [lit, setLit] = useState<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const { state } = asking
  if (state.status === 'idle') return null
  if (state.status === 'busy')
    return (
      <div className="dc-reading" role="status">
        <span className="dc-spinner" />
        <span>{L('Lendo os arquivos…', 'Reading the files…')}</span>
      </div>
    )
  if (state.status === 'error')
    return (
      <>
        <p className="note note--error" role="alert">
          {state.text}
        </p>
        <button className="btn btn--sm btn--ghost" onClick={asking.retry}>
          {L('Tentar de novo', 'Try again')}
        </button>
      </>
    )
  const { answer } = state
  if (!answer.found)
    return (
      <div className="dc-answer is-muted" role="status">
        <AnswerText text={answer.answer} known={new Set()} />
      </div>
    )
  const sources = withFiles ? answer.sources : []
  const files = new Set(sources.map((s) => s.doc.id)).size
  const goTo = (n: number): void => {
    document.getElementById(`dc-src-${n}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    setLit(n)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setLit((x) => (x === n ? null : x)), 1800)
  }
  const open = (d: Doc): void => navigate({ kind: 'documents', folder: d.folderId, doc: d.id })
  return (
    <>
      <div className="dc-answer" role="status">
        <div className="dc-answer__q">{L('Resposta', 'Answer')}</div>
        <AnswerText text={answer.answer} known={new Set(sources.map((s) => s.n))} {...(sources.length ? { onChip: goTo } : {})} />
      </div>
      {sources.length > 0 && (
        <>
          <h2 className="dc-eyebrow">{files === 1 ? L('Tirei a resposta deste arquivo', 'I took the answer from this file') : L(`Tirei a resposta destes ${files} arquivos`, `I took the answer from these ${files} files`)}</h2>
          <div className="dc-list">
            {sources.map((s) => (
              <div key={s.n} id={`dc-src-${s.n}`} className={`dc-src ${lit === s.n ? 'is-lit' : ''}`}>
                <span className="dc-src__n">{s.n}</span>
                <DocRow doc={s.doc} snippet={s.snippet} {...(tree ? { folderPath: pathText(tree, s.doc.folderId) } : {})} onOpen={() => open(s.doc)} />
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}

// ---------- at the bottom of an open file ----------

export function DocAskPanel({ doc }: { doc: Doc }): ReactNode {
  const [q, setQ] = useState('')
  const asking = useAsk({ docId: doc.id })
  return (
    <section className="dc-askdoc">
      <h2 className="dc-eyebrow">{L('Pergunte a este documento', 'Ask this document')}</h2>
      <AskAnswer asking={asking} withFiles={false} />
      <SearchBox
        value={q}
        onChange={(v) => (setQ(v), asking.clear())}
        onAsk={() => asking.ask(q)}
        busy={asking.state.status === 'busy'}
        placeholder={L('Ex.: qual é o prazo? quanto custa?', 'E.g. what is the deadline? how much does it cost?')}
        label={L('Pergunte a este documento', 'Ask this document')}
        always
      />
    </section>
  )
}
