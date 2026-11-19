// One file, open: the whole panel. The file in the middle (the same viewer the chat uses), what is
// behind it on the right. Older versions can be looked at without changing anything.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { docUrl, type Doc, type DocFolder, type DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate, useStore } from '../../store'
import { message } from '../Invite'
import { ContextMenu, type MenuState } from '../Dialogs'
import { FileViewer } from '../FileViewer'
import { ago, Icon } from '../ui'
import { DocAbout, type History } from './DocAbout'
import { downloadDoc, useDocActions } from './DocActions'
import { menuAt, WhoAvatar } from './doc-ui'
import { kindWords, mayEdit, useActors, type AccessWords } from './useDocs'

export function DocView({ tree, doc, folder, words }: { tree: DocsTree; doc: Doc; folder: DocFolder; words: AccessWords }): ReactNode {
  const rev = useStore((s) => s.docsRev)
  const who = useActors()(doc.updatedBy)
  const may = mayEdit(tree, folder.id)
  const [viewing, setViewing] = useState<number | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [menu, setMenu] = useState<MenuState>(null)
  const actions = useDocActions(() => navigate({ kind: 'documents', folder: folder.id }))

  useEffect(() => {
    let alive = true
    call('docHistory', { id: doc.id }).then(
      (h) => alive && (setHistory(h), setHistoryError('')),
      (e: unknown) => alive && setHistoryError(message(e))
    )
    return () => {
      alive = false
    }
  }, [doc.id, doc.version, rev])
  // A new version came in while an old one was open: the open one is no longer news.
  useEffect(() => setViewing(null), [doc.version])

  const older = viewing && viewing !== doc.version ? viewing : null
  const shown = older ? history?.versions.find((v) => v.n === older) : undefined
  const title = doc.name.replace(/\.[^.]+$/, '')
  const word = doc.kind === 'docx' || doc.kind === 'xlsx'

  return (
    <div className="dc-doc">
      <div className="dc-doc__main">
        <div className="dc-doc__bar">
          <button className="dc-back" onClick={() => navigate({ kind: 'documents', folder: folder.id })}>
            <Icon name="back" size={15} /> {folder.name}
          </button>
          <span className="grow" />
          <button className="btn btn--sm" onClick={() => downloadDoc(doc)}>
            <Icon name="down" size={13} /> {L('Baixar', 'Download')}
          </button>
          <button className="icon-btn" title={L('Mais opções', 'More options')} aria-label={L('Mais opções', 'More options')} onClick={(e) => setMenu(menuAt(e, actions.items(doc, may)))}>
            <Icon name="more" size={16} />
          </button>
        </div>
        <div className="dc-doc__scroll">
          <article className="dc-paper">
            <h1>{title}</h1>
            <div className="dc-meta">
              <span>{kindWords(doc.kind)}</span>
              <span className="dc-meta__who">
                <WhoAvatar who={who} size={18} /> {who.name}
              </span>
              <span>{ago(doc.updatedAt)}</span>
              <span>{L(`versão ${doc.version}`, `version ${doc.version}`)}</span>
            </div>
            {older && (
              <div className="dc-older" role="status">
                <Icon name="clock" size={14} />
                <span>{L(`Você está vendo a versão ${older}`, `You are looking at version ${older}`)}{shown ? ` · ${ago(shown.at)}` : ''}.</span>
                <button className="btn btn--sm" onClick={() => setViewing(null)}>
                  {L('Ver a atual', 'See the current one')}
                </button>
              </div>
            )}
            <div className="dc-viewer">
              <FileViewer
                key={`${doc.id}-${doc.version}-${older ?? 'now'}-${doc.name}`}
                url={docUrl(doc, older ?? undefined)}
                kind={doc.kind}
                name={doc.name}
                title={title}
                size={doc.size}
                loadText={() => call('docText', { id: doc.id, ...(older ? { version: older } : {}) }).then((r) => r.text)}
                missing={L('(não consegui ler este arquivo agora. Tente baixar.)', "(I couldn't read this file right now. Try downloading it.)")}
                note={
                  word && (
                    <>
                      <span>{L('Esta é a leitura do texto do arquivo. Para ver com a formatação original, baixe.', 'This is a reading of the file’s text. To see it with its original formatting, download it.')}</span>
                      <button className="btn btn--sm" onClick={() => downloadDoc(doc)}>
                        <Icon name="down" size={13} /> {L('Baixar', 'Download')}
                      </button>
                    </>
                  )
                }
              />
            </div>
          </article>
        </div>
      </div>
      <DocAbout doc={doc} folder={folder} tree={tree} words={words} may={may} history={history} historyError={historyError} viewing={older} onView={setViewing} />
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {actions.dialogs}
    </div>
  )
}
