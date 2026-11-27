// In the chat's side panel: show is the conversation's, keep is the team's. A file an agent showed can
// be kept in Documentos from here; once kept, the panel says so and opens it there.
import { useState, type ReactNode } from 'react'
import { acceptsDoc } from '../../../../shared/docs'
import { L } from '../../../../shared/lang'
import { call } from '../../rpc'
import { navigate, toast, useStore, type Artifact } from '../../store'
import { Icon } from '../ui'
import { FolderPicker, suggestFolder } from './doc-ui'
import { pathText, useDocs, useSavedArtifacts } from './useDocs'

export function SaveToDocs({ artifact }: { artifact: Artifact }): ReactNode {
  const saved = useSavedArtifacts()[artifact.id]
  const { tree } = useDocs()
  const agents = useStore((s) => s.agents)
  const you = useStore((s) => s.you)
  const [picking, setPicking] = useState(false)
  if (!acceptsDoc(artifact.name)) return null // a video or a file Documentos doesn't take stays in the chat

  if (saved)
    return (
      <>
        <span className="chip chip--ok dc-saved">
          <Icon name="check" size={12} /> {L('Guardado', 'Kept')}
        </span>
        <button className="btn btn--sm" onClick={() => navigate({ kind: 'documents', folder: saved.folderId, doc: saved.docId })}>
          {L('Abrir em Documentos', 'Open in Documents')}
        </button>
      </>
    )
  return (
    <>
      <button className="btn btn--sm btn--primary" onClick={() => setPicking(true)}>
        <Icon name="folder" size={13} /> {L('Guardar em Documentos', 'Keep in Documents')}
      </button>
      {picking && (
        <FolderPicker
          title={L('Guardar em qual pasta?', 'Keep in which folder?')}
          confirm={L('Guardar aqui', 'Keep here')}
          suggest={tree ? suggestFolder(tree, { agents, you }, artifact.agentId) : null}
          onPick={async (folderId) => {
            const doc = await call('docSaveArtifact', { artifactId: artifact.id, folderId })
            const where = tree ? pathText(tree, folderId) : ''
            toast(where ? L(`Guardado em ${where}.`, `Kept in ${where}.`) : L('Guardado em Documentos.', 'Kept in Documents.'), { label: L('Abrir', 'Open'), run: () => navigate({ kind: 'documents', folder: doc.folderId, doc: doc.id }) })
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )
}
