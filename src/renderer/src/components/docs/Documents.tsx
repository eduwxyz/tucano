// Documentos: the team's files in folders that say who sees them. This page picks what to draw (the
// home with its folders and the search, one folder, or one file) and holds what outlives them: the
// data and the files on their way up.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { DocFolder, DocHit, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { amAdmin, navigate, toast, useStore, type View } from '../../store'
import { message } from '../Invite'
import type { MenuState } from '../Dialogs'
import { ContextMenu } from '../Dialogs'
import { Icon } from '../ui'
import { DocFolderView } from './DocFolder'
import { DocView } from './DocView'
import { DocRow, DocsError, DocsLoading, FolderPicker, NameDialog, Sending, menuAt } from './doc-ui'
import { useDocActions } from './DocActions'
import { ACCEPT, useDocUpload } from './upload'
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
  const input = useRef<HTMLInputElement>(null)
  const roots = childFolders(tree, null)
  const empty = liveDocs(tree).length === 0

  const choose = (): void => input.current?.click()
  const newFolder = async (name: string): Promise<void> => {
    const f = await call('docFolderSave', { parentId: null, name, rule: '' })
    toast(L('Pasta criada.', 'Folder created.'))
    navigate({ kind: 'documents', folder: f.id })
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
    <div className="dc-page">
      <div className="dc-page__inner">
        <div className="dc-toolbar">
          <label className="dc-search">
            <Icon name="search" size={16} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={L('Procure um arquivo pelo nome ou pelo que está escrito nele', 'Find a file by its name or by what is written in it')} aria-label={L('Procurar arquivo', 'Find a file')} maxLength={300} />
            {query && (
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setQuery('')}>
                {L('Limpar', 'Clear')}
              </button>
            )}
          </label>
          {actions}
        </div>
        {lost && <p className="dc-notice">{L('Esse arquivo ou pasta não está mais aqui, ou você não tem acesso a ele.', "That file or folder isn't here anymore, or you don't have access to it.")}</p>}
        <Sending upload={upload} />
        {query.trim() ? (
          <Results tree={tree} query={query.trim()} />
        ) : (
          <>
            {empty && (
              <div className="dc-empty">
                <span className="dc-empty__ico">
                  <Icon name="folder" size={24} />
                </span>
                <h2>{L('Seus arquivos, cada um na sua pasta', 'Your files, each in its folder')}</h2>
                <p>{L('Nada guardado ainda. Envie um arquivo ou peça a um agente para guardar o que ele fizer.', 'Nothing kept yet. Send a file, or ask an agent to keep what it makes.')}</p>
                <div className="dc-empty__actions">
                  <button className="btn btn--primary" onClick={choose}>
                    <Icon name="clip" size={14} /> {L('Enviar arquivo', 'Send a file')}
                  </button>
                  {admin && (
                    <button className="btn" onClick={() => setNaming(true)}>
                      <Icon name="folder" size={14} /> {L('Nova pasta', 'New folder')}
                    </button>
                  )}
                </div>
              </div>
            )}
            {roots.length > 0 && (
              <>
                <h2 className="dc-eyebrow">{L('Pastas', 'Folders')}</h2>
                <div className="dc-folders">
                  {roots.map((f) => (
                    <FolderCard key={f.id} tree={tree} folder={f} words={words} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
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
            void upload.send(folderId, name, picked)
          }}
          onClose={() => setPicked(null)}
        />
      )}
    </div>
  )
}

const firstLine = (rule: string): string => rule.trim().split('\n')[0] ?? ''

function FolderCard({ tree, folder, words }: { tree: DocsTree; folder: DocFolder; words: AccessWords }): ReactNode {
  const n = countIn(tree, folder.id)
  const rule = firstLine(folder.rule)
  return (
    <button className="dc-folder" style={{ ['--c' as string]: folderColor(tree, folder.id) }} onClick={() => navigate({ kind: 'documents', folder: folder.id })}>
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

// ---------- the search ----------

function Results({ tree, query }: { tree: DocsTree; query: string }): ReactNode {
  const [hits, setHits] = useState<DocHit[] | null>(null)
  const [error, setError] = useState('')
  const [again, setAgain] = useState(0)
  const seq = useRef(0)
  const rev = useStore((s) => s.docsRev)
  const actions = useDocActions()
  const [menu, setMenu] = useState<MenuState>(null)
  useEffect(() => {
    const mine = ++seq.current
    const t = setTimeout(() => {
      call('docSearch', { q: query }).then(
        (h) => mine === seq.current && (setHits(h.filter((x) => !x.doc.trashedAt)), setError('')),
        (e: unknown) => mine === seq.current && (setError(message(e)), setHits(null))
      )
    }, 250)
    return () => clearTimeout(t)
  }, [query, rev, again])
  useEffect(() => setHits(null), [query])

  if (error) return <DocsError title={L('Não consegui procurar agora.', "I couldn't search right now.")} text={error} onRetry={() => (setError(''), setAgain((n) => n + 1))} />
  if (!hits) return <DocsLoading label={L('Procurando…', 'Searching…')} />
  if (!hits.length)
    return (
      <div className="dc-state">
        <Icon name="search" size={22} />
        <p className="dc-state__title">{L(`Não achei nenhum arquivo com “${query}”`, `I found no file with “${query}”`)}</p>
        <p>{L('Tente outra palavra, ou uma parte do nome do arquivo.', 'Try another word, or part of the file name.')}</p>
      </div>
    )
  return (
    <>
      <h2 className="dc-eyebrow">{hits.length === 1 ? L('1 arquivo', '1 file') : L(`${hits.length} arquivos`, `${hits.length} files`)}</h2>
      <div className="dc-list">
        {hits.map(({ doc, snippet }) => (
          <DocRow key={doc.id} doc={doc} snippet={snippet} folderPath={pathText(tree, doc.folderId)} onOpen={() => navigate({ kind: 'documents', folder: doc.folderId, doc: doc.id })} onMenu={(e) => setMenu(menuAt(e, actions.items(doc, tree.can[doc.folderId] === 'edit', () => navigate({ kind: 'documents', folder: doc.folderId, doc: doc.id }))))} />
        ))}
      </div>
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {actions.dialogs}
    </>
  )
}

