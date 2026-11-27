// The trash of one folder: what was sent there, each with a way back. Kept small and out of the way.
import { useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc } from '../../../../shared/docs'
import { call } from '../../rpc'
import { toast } from '../../store'
import { confirmDialog } from '../Dialogs'
import { message } from '../Invite'
import { DocRow } from './doc-ui'

// `forGood`: this person may delete what is here for good (the owner or an admin; in a personal folder, its person).
export function DocTrash({ docs, may, forGood }: { docs: Doc[]; may: boolean; forGood: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  if (!docs.length) return null
  const purge = async (d: Doc): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Apagar "${d.name}" de vez?`, `Delete "${d.name}" for good?`),
      body: L('O arquivo e as versões antigas dele saem do Tucano. Não dá para desfazer.', 'The file and its older versions leave Tucano. This cannot be undone.'),
      confirm: L('Apagar de vez', 'Delete for good'),
      danger: true
    })
    if (!ok) return
    setBusy(d.id)
    call('docPurge', { id: d.id }).then(
      () => (toast(L(`${d.name} foi apagado de vez.`, `${d.name} was deleted for good.`)), setBusy(null)),
      (e: unknown) => (toast(`${L('Não consegui apagar.', "I couldn't delete it.")} ${message(e)}`.trim()), setBusy(null))
    )
  }
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
                  <>
                    {forGood && (
                      <button className="btn btn--ghost btn--sm dc-trash__purge" disabled={busy === d.id} onClick={() => void purge(d)}>
                        {L('Apagar de vez', 'Delete for good')}
                      </button>
                    )}
                    <button className="btn btn--sm" disabled={busy === d.id} onClick={() => restore(d)}>
                      {L('Restaurar', 'Restore')}
                    </button>
                  </>
                )
              }
            />
          ))}
        </div>
      )}
    </section>
  )
}
