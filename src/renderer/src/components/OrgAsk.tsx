// The box at the bottom of the Team page: asks an agent something, with pictures and files if you
// like, without leaving the board. It takes what the conversation's composer takes (Attachments.tsx).
import { L } from '../../../shared/lang'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { askAgent, type Agent } from '../store'
import { AttachedList, pastedFiles, touchScreen, uploadsOf, useAttachments } from './Attachments'
import { AgentAvatar, Icon } from './ui'

export function OrgAsk({ agent, busy, sent, onSent, onError }: { agent: Agent; busy: boolean; sent: string | null; onSent: (name: string) => void; onError: (message: string) => void }): ReactNode {
  const [text, setText] = useState('')
  const [dragging, setDragging] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const focusField = useCallback((): void => void (touchScreen() || field.current?.focus()), [])
  const { items, setItems, note, setNote, add, uploading } = useAttachments(focusField, setText)

  // A file dropped anywhere on the page comes here (and never opens in place of the app).
  useEffect(() => {
    let depth = 0
    const files = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent): void => {
      if (!files(e)) return
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent): void => {
      if (files(e)) e.preventDefault()
    }
    const leave = (e: DragEvent): void => {
      if (files(e) && --depth <= 0) (depth = 0), setDragging(false)
    }
    const drop = (e: DragEvent): void => {
      if (!files(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void add([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [add])

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
      {dragging &&
        createPortal(
          <div className="drop-overlay">
            <div className="drop-overlay__card">
              <Icon name="image" size={28} />
              <strong>{L('Solte pra anexar', 'Drop to attach')}</strong>
              <span className="muted">{L(`${agent.name} vê o conteúdo junto com a mensagem.`, `${agent.name} sees the content along with the message.`)}</span>
            </div>
          </div>,
          document.body
        )}
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
        <button type="button" className="icon-btn" title={L('Anexar arquivo ou imagem (ou arraste e solte, ou cole)', 'Attach a file or an image (or drag and drop, or paste)')} onClick={() => picker.current?.click()}>
          <Icon name="clip" size={15} />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void add([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <button className="btn btn--primary btn--sm" disabled={uploading || (!text.trim() && !items.length)} title={L('Enviar na DM dele (Enter)', 'Send in their DM (Enter)')}>
          <Icon name="send" size={14} />
        </button>
      </form>
    </div>
  )
}
