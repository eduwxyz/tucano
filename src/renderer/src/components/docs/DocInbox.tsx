// The documents' part of "Pra você": files waiting for my yes, and dates found in files that are coming up.
// Same card look as the approvals beside them; one clear answer per card.
import { useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { InboxDoc, InboxDocDate } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate, toast } from '../../store'
import { message } from '../Invite'
import { ago, Icon } from '../ui'
import { FileBadge } from './doc-ui'
import { DecideRow } from './DocStatus'
import { useActors } from './useDocs'

const where = (path: string[]): string => path.join(' › ')

function WaitingDoc({ item }: { item: InboxDoc }): ReactNode {
  const { doc, folderPath } = item
  const who = useActors()(doc.updatedBy)
  const open = (): void => navigate({ kind: 'documents', folder: doc.folderId, doc: doc.id })
  return (
    <div className="approval dc-ib">
      <div className="approval__head">
        <span className="approval__badge">
          <Icon name="clock" size={12} /> {L('Espera você', 'Waits for you')}
        </span>
        <span className="small muted">
          {L(`${who.name} guardou`, `${who.name} saved it`)} · {ago(doc.updatedAt)}
        </span>
      </div>
      <div className="dc-ib__file">
        <FileBadge kind={doc.kind} size={32} />
        <div>
          <div className="approval__title">{doc.name}</div>
          {folderPath.length > 0 && <div className="small muted">{L(`em ${where(folderPath)}`, `in ${where(folderPath)}`)}</div>}
        </div>
      </div>
      {doc.summary && <p className="approval__why">{doc.summary}</p>}
      <DecideRow
        doc={doc}
        bare
        extra={
          <button className="btn btn--sm" onClick={open}>
            {L('Abrir', 'Open')}
          </button>
        }
      />
    </div>
  )
}

// "12/03/2027" (pt) or "03/12/2027" (en), from the YYYY-MM-DD the file carries.
function dateText(iso: string): string {
  const [y, m, d] = iso.split('-')
  return L(`${d}/${m}/${y}`, `${m}/${d}/${y}`)
}

const leftText = (days: number): string =>
  days === 0 ? L('hoje', 'today') : days === 1 ? L('amanhã', 'tomorrow') : days > 1 ? L(`em ${days} dias`, `in ${days} days`) : days === -1 ? L('venceu ontem', 'was due yesterday') : L(`venceu há ${-days} dias`, `was due ${-days} days ago`)

function DateCard({ item }: { item: InboxDocDate }): ReactNode {
  const { date, doc, folderPath, daysLeft } = item
  const [busy, setBusy] = useState<'remind' | 'dismiss' | null>(null)
  const open = (): void => navigate({ kind: 'documents', folder: doc.folderId, doc: doc.id })
  const remind = (): void => {
    setBusy('remind')
    call('docRemind', { id: date.id }).then(
      () => (toast(L('Lembrete criado. Você recebe o aviso antes da data.', 'Reminder created. You get the notice before the date.')), setBusy(null)),
      (e: unknown) => (toast(`${L('Não consegui criar o lembrete.', "I couldn't create the reminder.")} ${message(e)}`.trim()), setBusy(null))
    )
  }
  const dismiss = (): void => {
    setBusy('dismiss')
    call('docDateDismiss', { id: date.id }).then(
      () => (toast(L('Ignorado. Este prazo não aparece mais.', 'Ignored. This date will not show again.')), setBusy(null)),
      (e: unknown) => (toast(`${L('Não consegui ignorar.', "I couldn't ignore it.")} ${message(e)}`.trim()), setBusy(null))
    )
  }
  return (
    <div className="approval dc-ib">
      <div className="approval__head">
        <span className="approval__badge">
          <Icon name="clock" size={12} /> {leftText(daysLeft)}
        </span>
      </div>
      <div className="approval__title">
        {date.what}: {dateText(date.date)}
      </div>
      <div className="dc-ib__file">
        <FileBadge kind={doc.kind} size={26} />
        <div className="small muted">
          {doc.name}
          {folderPath.length > 0 && ` · ${where(folderPath)}`}
        </div>
      </div>
      <div className="dc-decide__acts dc-ib__acts">
        <button className="btn btn--sm btn--primary" disabled={busy !== null} onClick={remind}>
          {busy === 'remind' ? L('Criando…', 'Creating…') : L('Criar lembrete', 'Create reminder')}
        </button>
        <button className="btn btn--sm" onClick={open}>
          {L('Abrir', 'Open')}
        </button>
        <button className="btn btn--sm btn--ghost" disabled={busy !== null} onClick={dismiss}>
          {L('Ignorar', 'Ignore')}
        </button>
      </div>
    </div>
  )
}

export function DocInboxSections({ docs, dates }: { docs: InboxDoc[]; dates: InboxDocDate[] }): ReactNode {
  return (
    <>
      {docs.length > 0 && (
        <>
          <div className="caps-title">{L(`Documentos esperando você · ${docs.length}`, `Documents waiting for you · ${docs.length}`)}</div>
          <div className="stack-list">
            {docs.map((x) => (
              <WaitingDoc key={x.doc.id} item={x} />
            ))}
          </div>
        </>
      )}
      {dates.length > 0 && (
        <>
          <div className="caps-title">{L(`Prazos nos documentos · ${dates.length}`, `Dates in documents · ${dates.length}`)}</div>
          <div className="stack-list">
            {dates.map((x) => (
              <DateCard key={x.date.id} item={x} />
            ))}
          </div>
        </>
      )}
    </>
  )
}
