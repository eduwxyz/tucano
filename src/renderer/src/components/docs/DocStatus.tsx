// Where a file stands when its folder asks for approval: the one chip a row shows, the calm banner on
// an open file, and the two answers a person gives ("Aprovar" or "Pedir ajuste"). The same buttons sit on
// the cards of "Pra você".
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { toast } from '../../store'
import { message } from '../Invite'
import { Icon, type IconName } from '../ui'
import { useActors, useDocs, useMayApprove, useRoutineOf } from './useDocs'

// ---------- the chip ----------

function Pill({ tone, icon, children }: { tone: 'neutral' | 'warn' | 'ok' | 'accent'; icon?: IconName; children: ReactNode }): ReactNode {
  return (
    <span className={`chip dc-pill dc-pill--${tone}`}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  )
}

// Only a file waiting for a yes needs to know who I am, so only that one reads the folders.
function ReviewChip({ doc }: { doc: Doc }): ReactNode {
  const { tree } = useDocs()
  const may = useMayApprove(tree, doc.folderId)
  // Nothing until the tree is here: a guess would flash the wrong word.
  if (!tree) return null
  return <Pill tone="warn">{may ? L('Espera você', 'Waits for you') : L('Esperando aprovação', 'Waiting for approval')}</Pill>
}

// One chip at most: waiting or draft come first, then "Vivo" (kept up to date by a routine that still runs), then "Oficial".
export function StatusChip({ doc }: { doc: Doc }): ReactNode {
  const routine = useRoutineOf(doc.routineId)
  if (doc.status === 'review') return <ReviewChip doc={doc} />
  if (doc.status === 'draft') return <Pill tone="neutral">{L('Rascunho', 'Draft')}</Pill>
  if (doc.routineId && routine?.enabled) return <Pill tone="accent" icon="clock">{L('Vivo', 'Live')}</Pill>
  if (doc.status === 'official') return <Pill tone="ok" icon="check">{L('Oficial', 'Official')}</Pill>
  return null
}

// ---------- the two answers ----------

// A line to say what must change. Enter sends, Shift+Enter breaks the line, Esc gives up.
function AskChanges({ busy, onSend, onCancel }: { busy: boolean; onSend: (note: string) => void; onCancel: () => void }): ReactNode {
  const [note, setNote] = useState('')
  const ready = !!note.trim() && !busy
  return (
    <div className="dc-ask-changes">
      <textarea
        autoFocus
        rows={2}
        maxLength={1000}
        value={note}
        placeholder={L('O que precisa mudar?', 'What needs to change?')}
        aria-label={L('O que precisa mudar?', 'What needs to change?')}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && ready) (e.preventDefault(), onSend(note.trim()))
        }}
      />
      <div className="dc-ask-changes__acts">
        <button className="btn btn--sm btn--ghost" onClick={onCancel}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--sm btn--primary" disabled={!ready} onClick={() => onSend(note.trim())}>
          {busy ? L('Enviando…', 'Sending…') : L('Enviar pedido', 'Send request')}
        </button>
      </div>
    </div>
  )
}

// "Pedir ajuste" and "Aprovar" for one file, with the note field opening under them. `lead` is the sentence beside
// the buttons (the banner); `extra` goes before them (the card's "Abrir").
export function DecideRow({ doc, lead, extra, bare }: { doc: Doc; lead?: ReactNode; extra?: ReactNode; bare?: boolean }): ReactNode {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const askBtn = useRef<HTMLButtonElement>(null)
  const back = useRef(false)
  // Closing the note (Cancel, Esc or a sent request) gives the focus back to "Pedir ajuste".
  useEffect(() => {
    if (!asking && back.current) (back.current = false, askBtn.current?.focus())
  }, [asking])
  const approve = (): void => {
    setBusy(true)
    call('docDecide', { id: doc.id, ok: true, version: doc.version }).then(
      () => (toast(L('Aprovado. Agora é a versão oficial.', 'Approved. This is now the official version.')), setBusy(false)),
      (e: unknown) => (toast(`${L('Não consegui aprovar.', "I couldn't approve it.")} ${message(e)}`.trim()), setBusy(false))
    )
  }
  const askChanges = (note: string): void => {
    setBusy(true)
    call('docDecide', { id: doc.id, ok: false, note, version: doc.version }).then(
      () => (toast(doc.origin.conversationId ? L('Pedido enviado ao agente.', 'Request sent to the agent.') : L('Ajuste anotado.', 'Change noted.')), (back.current = true, setAsking(false)), setBusy(false)),
      (e: unknown) => (toast(`${L('Não consegui enviar o pedido.', "I couldn't send the request.")} ${message(e)}`.trim()), setBusy(false))
    )
  }
  return (
    <div className={`dc-decide ${bare ? 'dc-decide--bare' : ''}`}>
      <div className="dc-decide__row">
        {lead && <p>{lead}</p>}
        <span className="dc-decide__acts">
          {extra}
          {!asking && (
            <button ref={askBtn} className="btn btn--sm btn--ghost" disabled={busy} onClick={() => setAsking(true)}>
              {L('Pedir ajuste', 'Ask for changes')}
            </button>
          )}
          {!asking && (
            <button className="btn btn--sm btn--primary" disabled={busy} onClick={approve}>
              <Icon name="check" size={13} /> {busy ? L('Aprovando…', 'Approving…') : L('Aprovar', 'Approve')}
            </button>
          )}
        </span>
      </div>
      {asking && <AskChanges busy={busy} onSend={askChanges} onCancel={() => (back.current = true, setAsking(false))} />}
    </div>
  )
}

// ---------- the banner ----------

// Between the open file's notices and the file itself: one calm line saying where it stands, and what to do.
export function DocStatusBanner({ doc, tree }: { doc: Doc; tree: DocsTree }): ReactNode {
  const may = useMayApprove(tree, doc.folderId)
  const who = useActors()(doc.updatedBy)
  const [busy, setBusy] = useState(false)
  const official = (): void => {
    setBusy(true)
    call('docMakeOfficial', { id: doc.id }).then(
      () => (toast(L('Agora é a versão oficial.', 'This is now the official version.')), setBusy(false)),
      (e: unknown) => (toast(`${L('Não consegui marcar como oficial.', "I couldn't mark it as official.")} ${message(e)}`.trim()), setBusy(false))
    )
  }
  if (doc.status === 'review') {
    if (may)
      return (
        <DecideRow
          doc={doc}
          lead={
            <>
              <b>{L('Falta o seu sim.', 'It needs your yes.')}</b> {L(`${who.name} guardou.`, `${who.name} saved it.`)}
            </>
          }
        />
      )
    return (
      <div className="dc-decide dc-decide--quiet" role="status">
        <div className="dc-decide__row">
          <p>
            <b>{L('Esperando aprovação.', 'Waiting for approval.')}</b>
          </p>
        </div>
      </div>
    )
  }
  if (doc.status === 'draft') {
    return (
      <div className="dc-decide dc-decide--quiet" role="status">
        <div className="dc-decide__row">
          <p>
            <b>{L('Rascunho.', 'Draft.')}</b>
            {doc.statusNote.trim() && ` ${L('Ajuste pedido:', 'Change asked:')} ${doc.statusNote.trim()}`}
          </p>
          {may && (
            <button className="btn btn--sm btn--ghost" disabled={busy} onClick={official}>
              {L('Marcar como oficial', 'Mark as official')}
            </button>
          )}
        </div>
      </div>
    )
  }
  return null
}
