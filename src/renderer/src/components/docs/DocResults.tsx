// What the search finds as you type: the files with the matching words, in all folders or in one.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { DocHit, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate, useStore } from '../../store'
import { message } from '../Invite'
import { ContextMenu, type MenuState } from '../Dialogs'
import { Icon } from '../ui'
import { useDocActions } from './DocActions'
import { DocRow, DocsError, DocsLoading, menuAt } from './doc-ui'
import { pathText } from './useDocs'

export function DocResults({ tree, query, folderId }: { tree: DocsTree; query: string; folderId?: string }): ReactNode {
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
      call('docSearch', { q: query, ...(folderId ? { folderId } : {}) }).then(
        (h) => mine === seq.current && (setHits(h.filter((x) => !x.doc.trashedAt)), setError('')),
        (e: unknown) => mine === seq.current && (setError(message(e)), setHits(null))
      )
    }, 250)
    return () => clearTimeout(t)
  }, [query, rev, again, folderId])
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
