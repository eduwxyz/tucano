// The box at the bottom of the Team page: asks an agent something, with pictures and files if you
// like, without leaving the board. It takes what the conversation's composer takes (Attachments.tsx).
import { L } from '../../../shared/lang'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { askAgent, type Agent } from '../store'
import { AttachButton, AttachedList, DropOverlay, pastedFiles, touchScreen, uploadsOf, useAttachments, useFileDrop } from './Attachments'
import { AgentAvatar, Icon } from './ui'

export function OrgAsk({ agent, busy, sent, onSent, onError }: { agent: Agent; busy: boolean; sent: string | null; onSent: (name: string) => void; onError: (message: string) => void }): ReactNode {
  const [text, setText] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const focusField = useCallback((): void => void (touchScreen() || field.current?.focus()), [])
  const { items, setItems, note, setNote, add, uploading } = useAttachments(focusField, setText)

  // A file dropped anywhere on the page comes here (and never opens in place of the app).
  const dragging = useFileDrop(() => true, (files) => void add(files))

  const send = (): void => {
    const what = text.trim()
    if (uploading || (!what && !items.length)) return
    const sending = items
    const { images, files } = uploadsOf(sending)
    setText('')
    setItems([])
    setNote('')
    askAgent(agent.id, what, images, files).then(
      () => onSent(agent.name),
      // Nothing is lost when it fails: the text is back, and the attachments before whatever was added since.
      (e: unknown) => (setText(what), setItems((cur) => [...sending, ...cur]), onError(e instanceof Error ? e.message : String(e)))
    )
  }

  return (
    <div className="org-ask-wrap">
      {dragging && <DropOverlay who={L(`${agent.name} vê o conteúdo junto com a mensagem.`, `${agent.name} sees the content along with the message.`)} />}
      <AttachedList items={items} onRemove={(i) => setItems(items.filter((_, j) => j !== i))} />
      {note && (
        <span className={`org-ask__note${uploading ? ' org-ask__note--busy' : ''}`} role="status" aria-live="polite">
          {note}
        </span>
      )}
      <form className="org-ask" onSubmit={(e) => (e.preventDefault(), send())}>
        <AgentAvatar agent={agent} size={24} busy={busy} />
        <input
          ref={field}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const files = pastedFiles([...e.clipboardData.files], e.clipboardData.getData('text/plain'), true)
            if (!files.length) return
            e.preventDefault()
            void add(files)
          }}
          placeholder={sent === agent.name ? L(`Enviado a ${sent}. Acompanhe pelas linhas.`, `Sent to ${sent}. Follow it on the lines.`) : L(`Pedir algo a ${agent.name}…`, `Ask ${agent.name} something…`)}
          aria-label={L(`Pedir algo a ${agent.name}`, `Ask ${agent.name} something`)}
        />
        <AttachButton add={(files) => void add(files)} />
        <button className="btn btn--primary btn--sm" disabled={uploading || (!text.trim() && !items.length)} title={L('Enviar na DM dele (Enter)', 'Send in their DM (Enter)')}>
          <Icon name="send" size={14} />
        </button>
      </form>
    </div>
  )
}
