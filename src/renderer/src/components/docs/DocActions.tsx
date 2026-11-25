// What a person does with one file: open, download, rename, move, send to the trash. The same menu in
// a folder's row and at the top of an open document; the windows it opens live here too.
import { useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { docUrl, type Doc } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate, toast } from '../../store'
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

// A document sent on to the wiki, from where it already is: the curator reads it and writes it into the
// pages, as with a file dropped there. Only from a folder everyone sees (the server checks; `forAll` is
// the same answer, known here, so the reason is said without a round trip).
export function sendToWiki(doc: Pick<Doc, 'id' | 'name' | 'status'>, forAll: boolean): void {
  if (!forAll) return toast(L('Só vai para a Wiki um documento que o time todo vê. Este está numa pasta que nem todos veem.', 'Only a document the whole team sees goes to the Wiki. This one is in a folder not everyone sees.'))
  if (doc.status === 'review' || doc.status === 'draft') return toast(L('Este documento ainda espera aprovação. Ele vai para a Wiki depois de aprovado.', 'This document is still waiting for approval. It goes to the Wiki once approved.'))
  call('docToWiki', { id: doc.id }).then(
    () => toast(L(`O curador está lendo ${doc.name} e vai escrever nas páginas da Wiki.`, `The curator is reading ${doc.name} and will write it into the Wiki's pages.`), { label: L('Abrir a Wiki', 'Open the Wiki'), run: () => navigate({ kind: 'wiki' }) }),
    (e: unknown) => toast(`${L('Não consegui mandar para a Wiki.', "I couldn't send it to the Wiki.")} ${message(e)}`.trim())
  )
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
    ...(doc.trashedAt ? [] : ([{ label: L('Mandar para a Wiki', 'Send to the Wiki'), icon: 'book', onClick: () => sendToWiki(doc, !!tree?.forAll.includes(doc.folderId)) }] as MenuItem[])),
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
