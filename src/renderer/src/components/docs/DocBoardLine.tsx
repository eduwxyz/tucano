// On a finished card of the board: the file the team delivered, when it is kept in Documentos. One small line
// that opens the document; the card itself keeps opening from the rest of its surface.
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { navigate } from '../../store'
import { FileBadge } from './doc-ui'
import { useDocs, useSavedArtifacts } from './useDocs'

function Line({ docId }: { docId: string }): ReactNode {
  const { tree } = useDocs()
  const doc = tree?.docs.find((d) => d.id === docId && !d.trashedAt)
  if (!doc) return null
  const stop = (e: MouseEvent | KeyboardEvent): void => e.stopPropagation()
  return (
    <button
      className="dc-board-doc"
      title={L('Abrir em Documentos', 'Open in Documents')}
      onClick={(e) => (stop(e), navigate({ kind: 'documents', folder: doc.folderId, doc: doc.id }))}
      onKeyDown={stop}
    >
      <FileBadge kind={doc.kind} size={20} />
      <span>{doc.name}</span>
    </button>
  )
}

// The lookup runs only for a card that has files; a card without any renders nothing and fetches nothing.
function Saved({ artifactIds }: { artifactIds: string[] }): ReactNode {
  const saved = useSavedArtifacts()
  const hit = artifactIds.map((id) => saved[id]).find((x) => !!x)
  return hit ? <Line docId={hit.docId} /> : null
}

export function DocBoardLine({ artifactIds }: { artifactIds: string[] }): ReactNode {
  return artifactIds.length > 0 ? <Saved artifactIds={artifactIds} /> : null
}
