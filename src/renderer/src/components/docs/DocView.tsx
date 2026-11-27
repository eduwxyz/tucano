// One file, open: the whole panel. The file in the middle (the same viewer the chat uses), what is
// behind it on the right. Older versions can be looked at without changing anything.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { docUrl, type Doc, type DocFolder, type DocKind, type DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { navigate, useStore } from '../../store'
import { message } from '../Invite'
import { ContextMenu, type MenuState } from '../Dialogs'
import { FileViewer } from '../FileViewer'
import { ago, Icon } from '../ui'
import { DocAbout, type History } from './DocAbout'
import { DocAskPanel } from './DocAsk'
import { DocStatusBanner } from './DocStatus'
import { downloadDoc, useDocActions } from './DocActions'
import { menuAt, WhoAvatar } from './doc-ui'
import { kindWords, mayEdit, useActors, type AccessWords } from './useDocs'

// Files you look at (a PDF, a picture, a page) use the whole width; files you read keep the narrow column.
const WIDE: ReadonlySet<DocKind> = new Set<DocKind>(['pdf', 'image', 'html', 'csv'])

// The details column (where it came from, versions, who sees it) starts open, as it always was: who sees
// a file should be in sight without a click. Closing it is remembered per viewer; storage can be blocked,
// so it is never required.
const DETAILS_KEY = 'tucano.docs.details'
export const readDetails = (): boolean => {
  try {
    return localStorage.getItem(DETAILS_KEY) !== '0'
  } catch {
    return true
  }
}
const saveDetails = (open: boolean): void => {
  try {
    localStorage.setItem(DETAILS_KEY, open ? '1' : '0')
  } catch {
    /* the choice just isn't remembered */
  }
}

export function DocView({ tree, doc, folder, words }: { tree: DocsTree; doc: Doc; folder: DocFolder; words: AccessWords }): ReactNode {
  const rev = useStore((s) => s.docsRev)
  const who = useActors()(doc.updatedBy)
  const may = mayEdit(tree, folder.id)
  const [viewing, setViewing] = useState<number | null>(null)
  const [history, setHistory] = useState<History | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [menu, setMenu] = useState<MenuState>(null)
  const [details, setDetails] = useState(readDetails)
  // Lives here, and DocView remounts for every file, so another file never opens in full screen.
  const [full, setFull] = useState(false)
  const fullButton = useRef<HTMLButtonElement>(null)
  const wasFull = useRef(false)
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
  // Escape leaves full screen; the listener only exists while it is open.
  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])
  // Closing full screen, either way, gives focus back to the button that opened it (not on first mount).
  useEffect(() => {
    if (full) wasFull.current = true
    else if (wasFull.current) fullButton.current?.focus()
  }, [full])
  // A new version came in while an old one was open: the open one is no longer news.
  useEffect(() => setViewing(null), [doc.version])

  const older = viewing && viewing !== doc.version ? viewing : null
  const shown = older ? history?.versions.find((v) => v.n === older) : undefined
  const title = doc.name.replace(/\.[^.]+$/, '')
  const word = doc.kind === 'docx' || doc.kind === 'xlsx'
  const wide = WIDE.has(doc.kind)
  const viewer = (
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
  )
  const toggleDetails = (): void => {
    saveDetails(!details)
    setDetails(!details)
  }
  // The version link only opens the details column; it never closes it.
  const openDetails = (): void => {
    if (details) return
    saveDetails(true)
    setDetails(true)
  }

  return (
    <div className="dc-doc">
      <div className="dc-doc__main">
        <div className="dc-doc__bar">
          <button className="dc-back" onClick={() => navigate({ kind: 'documents', folder: folder.id })}>
            <Icon name="back" size={15} /> {folder.name}
          </button>
          <span className="grow" />
          <button className={`btn btn--sm ${details ? 'is-on' : ''}`} aria-pressed={details} onClick={toggleDetails}>
            <Icon name="panel" size={13} /> {L('Detalhes', 'Details')}
          </button>
          <button ref={fullButton} className="btn btn--sm" onClick={() => setFull(true)}>
            <Icon name="expand" size={13} /> {L('Tela cheia', 'Full screen')}
          </button>
          <button className="btn btn--sm" onClick={() => downloadDoc(doc)}>
            <Icon name="down" size={13} /> {L('Baixar', 'Download')}
          </button>
          <button className="icon-btn" title={L('Mais opções', 'More options')} aria-label={L('Mais opções', 'More options')} onClick={(e) => setMenu(menuAt(e, actions.items(doc, may)))}>
            <Icon name="more" size={16} />
          </button>
        </div>
        <div className="dc-doc__scroll">
          <article className={`dc-paper ${wide ? 'dc-paper--wide' : ''}`}>
            <h1>{title}</h1>
            <div className={`dc-meta ${doc.summary ? 'has-summary' : ''}`}>
              <span>{kindWords(doc.kind)}</span>
              <span className="dc-meta__who">
                <WhoAvatar who={who} size={18} /> {who.name}
              </span>
              <span>{ago(doc.updatedAt)}</span>
              <button type="button" className="dc-meta__link" title={L('Ver versões e quem vê', 'See versions and who sees it')} onClick={openDetails}>
                {L(`versão ${doc.version}`, `version ${doc.version}`)}
              </button>
            </div>
            {doc.summary && <p className="dc-summary">{doc.summary}</p>}
            {older && (
              <div className="dc-older" role="status">
                <Icon name="clock" size={14} />
                <span>{L(`Você está vendo a versão ${older}`, `You are looking at version ${older}`)}{shown ? ` · ${ago(shown.at)}` : ''}.</span>
                <button className="btn btn--sm" onClick={() => setViewing(null)}>
                  {L('Ver a atual', 'See the current one')}
                </button>
              </div>
            )}
            <DocStatusBanner doc={doc} tree={tree} />
            <div className="dc-viewer">{!full && viewer}</div>
            <DocAskPanel key={doc.id} doc={doc} />
          </article>
        </div>
      </div>
      {details && <DocAbout doc={doc} folder={folder} tree={tree} words={words} may={may} history={history} historyError={historyError} viewing={older} onView={setViewing} onClose={toggleDetails} />}
      {full && (
        <div className="dc-full" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
          <div className="dc-full__bar">
            <strong>{title}</strong>
            <span className="grow" />
            {/* pdf and html are iframes, which keep the keyboard: there Esc is not heard, so the hint would lie */}
            {doc.kind !== 'pdf' && doc.kind !== 'html' && (
              <span className="dc-full__hint">
                <kbd>Esc</kbd> {L('para sair', 'to leave')}
              </span>
            )}
            <button className="btn btn--sm" autoFocus onClick={() => setFull(false)}>
              <Icon name="shrink" size={13} /> {L('Sair da tela cheia', 'Leave full screen')}
            </button>
          </div>
          <div className={`dc-full__body ${wide ? '' : 'is-read'}`}>{viewer}</div>
        </div>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {actions.dialogs}
    </div>
  )
}
