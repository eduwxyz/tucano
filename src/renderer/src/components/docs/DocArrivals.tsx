// "Chegada": drop any file and the Tuca reads it and keeps it in the right folder. While she reads, the file is
// listed as "Guardando…"; once kept, it stays a day under "Guardados agora" with a way to move it or take it
// back. A file she could not place says why and asks for a folder. Quiet when there is nothing to show.
import { useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate, toast, useStore } from '../../store'
import { message } from '../Invite'
import { ContextMenu, type MenuState } from '../Dialogs'
import { Icon } from '../ui'
import { FileBadge, FolderPicker, Sending, menuAt } from './doc-ui'
import { ACCEPT, type useInboxUpload } from './upload'
import { folderOf, pathText } from './useDocs'

const DAY = 24 * 60 * 60 * 1000

type Arrivals = { pending: Doc[]; filed: Doc[]; kept: Doc[] }

// My files that went through Chegada: waiting, put away in the last day, and the ones left in Só meus with a reason.
function arrivalsOf(tree: DocsTree, me: string): Arrivals {
  const now = Date.now()
  const mine = tree.docs.filter((d) => !d.trashedAt && d.filing?.by === me)
  const recent = (d: Doc): boolean => now - Math.max(d.filing!.at, d.updatedAt) < DAY
  const byNew = (a: Doc, b: Doc): number => b.updatedAt - a.updatedAt
  return {
    pending: mine.filter((d) => d.filing!.state === 'pending').sort(byNew),
    filed: mine.filter((d) => d.filing!.state === 'filed' && recent(d)).sort(byNew),
    // Still in my personal folder: once it is moved out, the question is answered.
    kept: mine.filter((d) => d.filing!.state === 'kept' && !!d.filing!.note && recent(d) && folderOf(tree, d.folderId)?.privateTo === me).sort(byNew)
  }
}

export function DocArrivals({ tree, upload, dropping }: { tree: DocsTree; upload: ReturnType<typeof useInboxUpload>; dropping: boolean }): ReactNode {
  const me = useStore((s) => s.you)
  const input = useRef<HTMLInputElement>(null)
  const [moving, setMoving] = useState<{ doc: Doc; choose: boolean } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [menu, setMenu] = useState<MenuState>(null)
  const [all, setAll] = useState(false)
  const { pending, filed, kept } = arrivalsOf(tree, me)
  // Three kept files show at most; the rest wait behind "Ver mais".
  const rows = [...filed.map((d) => ({ d, keep: false })), ...kept.map((d) => ({ d, keep: true }))]
  const shown = all ? rows : rows.slice(0, 3)
  const open = (d: Doc): void => navigate({ kind: 'documents', folder: d.folderId, doc: d.id })
  const undo = (d: Doc): void => {
    setBusy(d.id)
    call('docUnfile', { id: d.id }).then(
      () => (toast(L('Voltou para Só meus.', 'Back in Only mine.')), setBusy(null)),
      (e: unknown) => (toast(`${L('Não consegui desfazer.', "I couldn't undo it.")} ${message(e)}`.trim()), setBusy(null))
    )
  }
  const pick = (): void => input.current?.click()

  return (
    <>
      <div
        className={`dc-arrival ${dropping ? 'is-over' : ''}`}
        role="button"
        tabIndex={0}
        aria-label={L('Chegada: escolher arquivos para a Tuca guardar', 'Arrivals: choose files for Tuca to keep')}
        onClick={pick}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), pick())}
      >
        <span className="dc-arrival__ico">
          <Icon name="down" size={18} />
        </span>
        <span className="dc-arrival__text">
          <strong>{L('Chegada', 'Arrivals')}</strong>
          <span>{L('Solte qualquer arquivo aqui. A Tuca lê e guarda na pasta certa.', 'Drop any file here. Tuca reads it and files it in the right folder.')}</span>
        </span>
        <span className="btn btn--ghost btn--sm">{L('Escolher arquivos', 'Choose files')}</span>
      </div>
      <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (void upload.send([...(e.target.files ?? [])]), (e.target.value = ''))} />
      <Sending upload={upload} />

      {(pending.length > 0 || filed.length > 0 || kept.length > 0) && (
        <section className="dc-arrivals" aria-live="polite">
          {pending.length > 0 && (
            <>
              <h2 className="dc-eyebrow">{L('Guardando…', 'Keeping…')}</h2>
              {pending.map((d) => (
                <div key={d.id} className="dc-arr">
                  <span className="dc-spinner" />
                  <span className="dc-arr__name">{d.name}</span>
                  <span className="dc-arr__sub">{L('A Tuca está lendo', 'Tuca is reading it')}</span>
                </div>
              ))}
            </>
          )}
          {rows.length > 0 && (
            <>
              <h2 className="dc-eyebrow">{L('Guardados agora', 'Just kept')}</h2>
              {shown.map(({ d, keep }) =>
                keep ? (
                  <div key={d.id} className="dc-arr">
                    <FileBadge kind={d.kind} size={28} />
                    <span className="dc-arr__name">
                      {d.name}: <em>{d.filing?.note}</em>
                    </span>
                    <span className="dc-arr__acts">
                      <button className="btn btn--sm" onClick={() => setMoving({ doc: d, choose: true })}>
                        {L('Escolher pasta', 'Choose a folder')}
                      </button>
                    </span>
                  </div>
                ) : (
                  <div key={d.id} className="dc-arr">
                    <FileBadge kind={d.kind} size={28} />
                    <span className="dc-arr__name">
                      {d.name} <em>→ {pathText(tree, d.folderId)}</em>
                    </span>
                    <span className="dc-arr__acts">
                      <button className="btn btn--sm" onClick={() => open(d)}>
                        {L('Abrir', 'Open')}
                      </button>
                      <button
                        className="icon-btn"
                        title={L('Mais opções', 'More options')}
                        aria-label={L('Mais opções', 'More options')}
                        disabled={busy === d.id}
                        onClick={(e) =>
                          setMenu(
                            menuAt(e, [
                              { label: L('Mover', 'Move'), icon: 'folder', onClick: () => setMoving({ doc: d, choose: false }) },
                              { label: L('Tirar daqui', 'Take back'), onClick: () => undo(d) }
                            ])
                          )
                        }
                      >
                        <Icon name="more" size={16} />
                      </button>
                    </span>
                  </div>
                )
              )}
              {!all && rows.length > 3 && (
                <button className="text-btn" onClick={() => setAll(true)}>
                  {L(`Ver mais ${rows.length - 3}`, `See ${rows.length - 3} more`)}
                </button>
              )}
            </>
          )}
        </section>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {moving && (
        <FolderPicker
          title={moving.choose ? L('Em que pasta guardar?', 'Which folder should it go in?') : L('Mover para onde?', 'Move it where?')}
          confirm={moving.choose ? L('Guardar aqui', 'Keep here') : L('Mover para cá', 'Move here')}
          current={moving.doc.folderId}
          onPick={async (folderId) => {
            await call('docMove', { id: moving.doc.id, folderId })
            toast(L(`Guardado em ${pathText(tree, folderId) || 'a pasta'}.`, `Kept in ${pathText(tree, folderId) || 'the folder'}.`))
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </>
  )
}
