// The trash of one folder: what was sent there, each with a way back. Kept small and out of the way.
import { useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc } from '../../../../shared/docs'
import { call } from '../../rpc'
import { toast } from '../../store'
import { message } from '../Invite'
import { DocRow } from './doc-ui'

export function DocTrash({ docs, may }: { docs: Doc[]; may: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  if (!docs.length) return null
  const restore = (d: Doc): void => {
    setBusy(d.id)
    call('docRestore', { id: d.id }).then(
      () => (toast(L(`${d.name} voltou para a pasta.`, `${d.name} is back in the folder.`)), setBusy(null)),
      (e: unknown) => (toast(`${L('Não consegui trazer de volta.', "I couldn't bring it back.")} ${message(e)}`), setBusy(null))
    )
  }
  return (
    <section className="dc-trash">
      <button className="text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? L('Esconder a lixeira', 'Hide the trash') : L(`Lixeira (${docs.length})`, `Trash (${docs.length})`)}
      </button>
      {open && (
        <div className="dc-trash__list">
          {docs.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              trailing={
                may && (
                  <button className="btn btn--sm" disabled={busy === d.id} onClick={() => restore(d)}>
                    {busy === d.id ? L('Restaurando…', 'Restoring…') : L('Restaurar', 'Restore')}
                  </button>
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}
