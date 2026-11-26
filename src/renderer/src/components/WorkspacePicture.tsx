// The workspace's own picture: a thumbnail in Manage workspaces, and the window that sets it. A
// picked or pasted bitmap goes through the connector's own shrink-and-check path, so a workspace tile
// and a connector tile hold the same small, safe picture. A remote address is kept as an address.
import { useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { WorkspaceSummary } from '../../../shared/workspaces'
import { iconFromFile, imageFromClipboard } from '../connector-icon'
import { toast } from '../store'
import { Icon } from './ui'
import { Modal } from './Modal'

type Subject = Pick<WorkspaceSummary, 'id' | 'name' | 'picture'>

// The edit glyph rides on the thumbnail itself: one 40 px button for a mouse or a keyboard, with no
// new gray rectangle on the row's existing buttons.
export function WorkspaceThumbnail({ workspace, onEdit }: { workspace: Subject; onEdit: () => void }): ReactNode {
  const label = L(`Alterar imagem de ${workspace.name}`, `Change picture for ${workspace.name}`)
  return (
    <button type="button" className="workspace-manager__pic" title={label} aria-label={label} onClick={onEdit}>
      {workspace.picture
        ? <img src={workspace.picture} alt="" />
        : <span className="workspace-manager__pic-empty" aria-hidden><Icon name="image" size={18} /></span>}
      <span className="workspace-manager__pic-edit" aria-hidden><Icon name="edit" size={15} /></span>
    </button>
  )
}

export function WorkspacePictureModal({ workspace, onClose }: { workspace: Subject; onClose: () => void }): ReactNode {
  const api = window.tucano.workspaces
  const [picture, setPicture] = useState(workspace.picture ?? '')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  // The connector picker says why a picture failed in a toast: the window stays open with the old
  // picture and whatever address was typed, so nothing is lost while the person reads the reason.
  // A main-process error arrives with Electron's `Error invoking remote method …` wrapper; the person
  // needs the reason, not the transport it came on.
  const notice = (e: unknown): void => {
    const raw = e instanceof Error && e.message ? e.message : ''
    const reason = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    toast(reason || L('Não consegui usar essa imagem.', "I couldn't use that image."))
  }
  const save = async (value: Promise<string> | string): Promise<void> => {
    if (!api) return
    setBusy(true)
    try {
      const next = await value
      await api.setPicture(workspace.id, next)
      setPicture(next)
      if (!next.startsWith('data:')) setUrl('')
    } catch (e) {
      notice(e)
    } finally {
      setBusy(false)
    }
  }
  const pasted = (file: File | null): void => {
    if (!file) return notice(L('Não há imagem na área de transferência.', 'There is no image on the clipboard.'))
    void save(iconFromFile(file))
  }
  return (
    <Modal title={L('Imagem do workspace', 'Workspace picture')} onClose={onClose} className="workspace-picture">
      <div
        className="workspace-picture__body"
        onPaste={(e) => {
          const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'))
          const dropped = item?.getAsFile?.()
          if (dropped) {
            e.preventDefault()
            pasted(dropped)
          }
        }}
      >
        <div className="workspace-picture__placeholder">
          {picture
            ? <img src={picture} alt={L(`Imagem de ${workspace.name}`, `${workspace.name}'s picture`)} />
            : <>
              <Icon name="image" size={28} />
              <span className="muted small">{L('Sem imagem', 'No picture yet')}</span>
            </>}
        </div>
        <label className="field">
          <span className="field__label">{L('Endereço da imagem', 'Image address')}</span>
          <div className="workspace-picture__url-row">
            <input className="workspace-picture__url" type="text" value={url} spellCheck={false} placeholder="https://…" aria-label={L('Endereço da imagem', 'Image address')} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && url.trim() && !busy) { e.preventDefault(); void save(url.trim()) } }} />
            <button type="button" className="btn btn--sm" disabled={busy || !url.trim()} onClick={() => void save(url.trim())}>{L('Adicionar', 'Add')}</button>
          </div>
        </label>
        <div className="workspace-picture__actions">
          <input
            ref={file}
            className="workspace-picture__file"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            hidden
            onChange={(e) => {
              const picked = e.target.files?.[0]
              e.target.value = '' // the same file again still counts as a choice
              if (picked) void save(iconFromFile(picked))
            }}
          />
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => file.current?.click()}>{L('Escolher imagem', 'Choose image')}</button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void imageFromClipboard().then(pasted, notice)}>{L('Colar imagem', 'Paste image')}</button>
          {picture && <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void save('')}>{L('Usar o padrão', 'Use the default')}</button>}
        </div>
        <p className="small muted">{L('PNG, JPEG, WebP, GIF ou SVG, escolhidos ou colados. Um endereço https também serve. A imagem fica só neste workspace.', 'PNG, JPEG, WebP, GIF or SVG, picked or pasted. An https address works too. The picture stays with this workspace.')}</p>
      </div>
    </Modal>
  )
}
