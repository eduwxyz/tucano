// What a person does with one file: open, download, rename, move, send to the trash. The same menu in
// a folder's row and at the top of an open document; the windows it opens live here too.
import { useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { docUrl, type Doc } from '../../../../shared/docs'
import { call } from '../../rpc'
import { toast } from '../../store'
import { message } from '../Invite'
import type { MenuItem } from '../Dialogs'
import { FolderPicker, NameDialog } from './doc-ui'
import { pathText, useDocs } from './useDocs'

// Down to the computer. (The file itself is served at docUrl; the browser or the app saves it.)
export function downloadDoc(doc: Pick<Doc, 'id' | 'name'>): void {
  const a = document.createElement('a')
  a.href = docUrl(doc)
  a.download = doc.name
  a.click()
  toast(L(`Baixando ${doc.name}…`, `Downloading ${doc.name}…`))
}

const extOf = (name: string): string => (name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '')

export function useDocActions(onGone?: (doc: Doc) => void): { items: (doc: Doc, may: boolean, open?: () => void) => MenuItem[]; dialogs: ReactNode } {
  const { tree } = useDocs()
  const [renaming, setRenaming] = useState<Doc | null>(null)
  const [moving, setMoving] = useState<Doc | null>(null)

  const trash = (doc: Doc): void => {
    call('docTrash', { id: doc.id }).then(
      () => {
        toast(L(`${doc.name} foi para a lixeira.`, `${doc.name} went to the trash.`), {
          label: L('Desfazer', 'Undo'),
          run: () =>
            void call('docRestore', { id: doc.id }).then(
              () => toast(L('Arquivo de volta.', 'File back.')),
              (e: unknown) => toast(`${L('Não consegui trazer de volta.', "I couldn't bring it back.")} ${message(e)}`.trim())
            )
        })
        onGone?.(doc)
      },
      (e: unknown) => toast(`${L('Não consegui mandar para a lixeira.', "I couldn't send it to the trash.")} ${message(e)}`.trim())
    )
  }

  const items = (doc: Doc, may: boolean, open?: () => void): MenuItem[] => [
    ...(open ? ([{ label: L('Abrir', 'Open'), icon: 'eye', onClick: open }] as MenuItem[]) : []),
    { label: L('Baixar', 'Download'), icon: 'down', onClick: () => downloadDoc(doc) },
    ...(may
      ? ([
          { label: L('Renomear', 'Rename'), icon: 'edit', onClick: () => setRenaming(doc) },
          { label: L('Mover para outra pasta', 'Move to another folder'), icon: 'folder', onClick: () => setMoving(doc) },
          'separator',
          { label: L('Mandar para a lixeira', 'Send to the trash'), icon: 'trash', danger: true, onClick: () => trash(doc) }
        ] as MenuItem[])
      : [])
  ]

  const dialogs = (
    <>
      {renaming && (
        <NameDialog
          title={L('Renomear arquivo', 'Rename file')}
          label={L('Novo nome', 'New name')}
          initial={renaming.name.slice(0, renaming.name.length - extOf(renaming.name).length)}
          confirm={L('Renomear', 'Rename')}
          onSubmit={async (name) => {
            const ext = extOf(renaming.name)
            await call('docRename', { id: renaming.id, name: ext && name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext })
            toast(L('Nome mudado.', 'Renamed.'))
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {moving && (
        <FolderPicker
          title={L(`Mover ${moving.name}`, `Move ${moving.name}`)}
          confirm={L('Mover para cá', 'Move here')}
          current={moving.folderId}
          onPick={async (folderId) => {
            await call('docMove', { id: moving.id, folderId })
            toast(L(`Movido para ${tree ? pathText(tree, folderId) : L('a pasta', 'the folder')}.`, `Moved to ${tree ? pathText(tree, folderId) : 'the folder'}.`))
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </>
  )
  return { items, dialogs }
}
