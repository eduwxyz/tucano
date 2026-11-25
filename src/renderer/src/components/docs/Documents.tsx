// Documentos: the team's files in folders that say who sees them. This page picks what to draw (the
// home with its folders and the search, one folder, or one file) and holds what outlives them: the
// data and the files on their way up.
import { useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { DocFolder, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { amAdmin, navigate, toast, useStore, type View } from '../../store'
import type { MenuState } from '../Dialogs'
import { ContextMenu } from '../Dialogs'
import { Icon } from '../ui'
import { AskAnswer, SearchBox, useAsk } from './DocAsk'
import { DocArrivals } from './DocArrivals'
import { DocFolderView } from './DocFolder'
import { DocResults } from './DocResults'
import { DocView } from './DocView'
import { DocsError, DocsLoading, FolderPicker, NameDialog, Sending, menuAt } from './doc-ui'
import { useDocActions } from './DocActions'
import { ACCEPT, useDocUpload, useInboxUpload } from './upload'
import { childFolders, countIn, folderColor, liveDocs, pathText, useAccessWords, useDocs, type AccessWords } from './useDocs'

type Upload = ReturnType<typeof useDocUpload>

export function DocumentsView(): ReactNode {
  const view = useStore((s) => s.view) as Extract<View, { kind: 'documents' }>
  const { tree, loading, error, retry } = useDocs()
  const upload = useDocUpload()
  const words = useAccessWords(tree)

  if (loading) return <DocsLoading />
  if (error && !tree) return <DocsError text={error} onRetry={retry} />
  if (!tree) return null
  const doc = tree.docs.find((d) => d.id === view.doc && !d.trashedAt)
  // An open document brings its own folder: after a move, the page follows the file, not the old link.
  const folder = tree.folders.find((f) => f.id === (doc?.folderId ?? view.folder))
  // A link to something gone, or something this person doesn't see: back to the home, with a word about it.
  if (view.doc && doc && folder) return <DocView key={doc.id} tree={tree} doc={doc} folder={folder} words={words} />
  if (view.folder && folder) return <DocFolderView key={folder.id} tree={tree} folder={folder} words={words} upload={upload} />
  return <Home tree={tree} words={words} upload={upload} q={view.q} lost={!!view.folder || !!view.doc} />
}

// ---------- the home ----------

function Home({ tree, words, upload, q, lost }: { tree: DocsTree; words: AccessWords; upload: Upload; q?: string; lost: boolean }): ReactNode {
  const admin = useStore(amAdmin)
  const [query, setQuery] = useState(q ?? '')
  const [menu, setMenu] = useState<MenuState>(null)
  const [naming, setNaming] = useState(false)
  const [picked, setPicked] = useState<File[] | null>(null)
  const [dropping, setDropping] = useState(0)
  const arrivals = useInboxUpload()
  const asking = useAsk()
  const input = useRef<HTMLInputElement>(null)
  const roots = childFolders(tree, null)
  const empty = liveDocs(tree).length === 0

  const choose = (): void => input.current?.click()
  const newFolder = async (name: string): Promise<void> => {
    const f = await call('docFolderSave', { parentId: null, name, rule: '' })
    toast(L('Pasta criada.', 'Folder created.'))
    navigate({ kind: 'documents', folder: f.id })
  }

  // Files dropped on the background go to Chegada; a folder card takes its own (see FolderCard).
  const drop = {
    onDragEnter: (e: React.DragEvent) => e.dataTransfer.types.includes('Files') && setDropping((n) => n + 1),
    onDragLeave: () => setDropping((n) => Math.max(0, n - 1)),
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropping(0)
      if ((e.target as HTMLElement).closest('.dc-folder')) return
      void arrivals.send([...e.dataTransfer.files])
    }
  }
  const actions = admin ? (
    <button className="btn btn--primary" onClick={(e) => setMenu(menuAt(e, [{ label: L('Nova pasta', 'New folder'), icon: 'folder', onClick: () => setNaming(true) }, { label: L('Enviar arquivo', 'Send a file'), icon: 'clip', onClick: choose }]))}>
      <Icon name="plus" size={14} /> {L('Novo', 'New')}
    </button>
  ) : (
    <button className="btn btn--primary" onClick={choose}>
      <Icon name="clip" size={14} /> {L('Enviar arquivo', 'Send a file')}
    </button>
  )

  return (
    <div className="dc-page dc-dropzone" {...drop}>
      <div className="dc-page__inner">
        <div className="dc-toolbar">
          <SearchBox
            value={query}
            onChange={(v) => (setQuery(v), asking.clear())}
            onAsk={() => asking.ask(query)}
            busy={asking.state.status === 'busy'}
            placeholder={L('Procure um arquivo, ou pergunte algo aos seus documentos', 'Find a file, or ask your documents something')}
            label={L('Procurar arquivo ou perguntar', 'Find a file or ask')}
          />
          {actions}
        </div>
        {lost && <p className="dc-notice">{L('Esse arquivo ou pasta não está mais aqui, ou você não tem acesso a ele.', "That file or folder isn't here anymore, or you don't have access to it.")}</p>}
        <Sending upload={upload} />
        {query.trim() ? (
          <>
            <AskAnswer asking={asking} tree={tree} />
            {!asking.answering && <DocResults tree={tree} query={query.trim()} />}
          </>
        ) : (
          <>
            <DocArrivals tree={tree} upload={arrivals} dropping={dropping > 0} />
            {empty && (
              <div className="dc-empty">
                <span className="dc-empty__ico">
                  <Icon name="folder" size={24} />
                </span>
                <h2>{L('Seus arquivos, cada um na sua pasta', 'Your files, each in its folder')}</h2>
                <p>{L('Nada guardado ainda. Envie um arquivo ou peça a um agente para guardar o que ele fizer.', 'Nothing kept yet. Send a file, or ask an agent to keep what it makes.')}</p>
                {admin && (
                  <div className="dc-empty__actions">
                    <button className="btn" onClick={() => setNaming(true)}>
                      <Icon name="folder" size={14} /> {L('Nova pasta', 'New folder')}
                    </button>
                  </div>
                )}
              </div>
            )}
            {roots.length > 0 && (
              <>
                <h2 className="dc-eyebrow">{L('Pastas', 'Folders')}</h2>
                <div className="dc-folders">
                  {roots.map((f) => (
                    <FolderCard key={f.id} tree={tree} folder={f} words={words} upload={upload} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
      {dropping > 0 && (
        <div className="dc-drop">
          <Icon name="down" size={22} />
          <strong>{L('Solte aqui', 'Drop here')}</strong>
        </div>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (setPicked([...(e.target.files ?? [])]), (e.target.value = ''))} />
      {naming && <NameDialog title={L('Nova pasta', 'New folder')} label={L('Nome da pasta', 'Folder name')} confirm={L('Criar pasta', 'Create folder')} onSubmit={newFolder} onClose={() => setNaming(false)} />}
      {picked && picked.length > 0 && (
        <FolderPicker
          title={L('Onde guardar?', 'Where should it go?')}
          confirm={L('Guardar aqui', 'Keep here')}
          onPick={async (folderId) => {
            const name = pathText(tree, folderId) || L('a pasta', 'the folder')
            navigate({ kind: 'documents', folder: folderId })
            void upload.send(folderId, name, picked, tree.forAll.includes(folderId))
          }}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  )
}

const firstLine = (rule: string): string => rule.trim().split('\n')[0] ?? ''

function FolderCard({ tree, folder, words, upload }: { tree: DocsTree; folder: DocFolder; words: AccessWords; upload: Upload }): ReactNode {
  const n = countIn(tree, folder.id)
  const rule = firstLine(folder.rule)
  return (
    <button
      className="dc-folder"
      style={{ ['--c' as string]: folderColor(tree, folder.id) }}
      onClick={() => navigate({ kind: 'documents', folder: folder.id })}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        // Dropped right on a folder: it is kept in that one, not sent to Chegada.
        e.preventDefault()
        if (tree.can[folder.id] !== 'edit') return toast(L('Você pode ver esta pasta, mas não guardar nela.', 'You can see this folder, but not save to it.'))
        void upload.send(folder.id, folder.name, [...e.dataTransfer.files], tree.forAll.includes(folder.id))
      }}
    >
      <span className="dc-folder__top">
        <span className="dc-folder__ico">
          <Icon name={folder.privateTo ? 'lock' : 'folder'} size={16} />
        </span>
        <strong>{folder.name}</strong>
        <em>{n === 0 ? L('vazia', 'empty') : n === 1 ? L('1 arquivo', '1 file') : L(`${n} arquivos`, `${n} files`)}</em>
      </span>
      <p className={rule ? '' : 'is-muted'}>{rule || L('Sem regra ainda', 'No rule yet')}</p>
      <span className="dc-folder__foot">
        <span className="chip dc-chip">
          <Icon name={folder.privateTo ? 'lock' : 'users'} size={11} /> {words.short(folder.id)}
        </span>
      </span>
    </button>
  )
}
