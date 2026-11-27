// What a message can carry besides its text: images and files, picked, pasted or dropped. The
// conversation's composer and the Team page's ask box share it, so both take the same things.
import { L } from '../../../shared/lang'
import { withMessage } from '../../../shared/attach'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IMAGE_MIMES, MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE, type FileUpload, type ImageUpload } from '../../../shared/types'
import { Icon } from './ui'

// Images go to the models as they are when small; big ones are scaled down
// (longest side MAX_SIDE) and re-encoded, so any screenshot or photo fits.
export const MAX_SIDE = 2000
export const MAX_RAW = 3_700_000 // base64 under the models' 5 MB

// An image (with what shows it) or, in the app, any other file: `url` empty, its text goes to the agents.
export type Attached = ImageUpload & { url: string; size?: number }
export const isFile = (a: Attached): boolean => !a.url

export const dataUrlOf = (blob: Blob): Promise<string> =>
  new Promise((ok, fail) => {
    const r = new FileReader()
    r.onload = () => ok(String(r.result))
    r.onerror = () => fail(r.error)
    r.readAsDataURL(blob)
  })

export async function prepareFile(file: File): Promise<Attached | string> {
  if (file.size === 0) return L(`${file.name} está vazio.`, `${file.name} is empty.`)
  if (file.size > MAX_FILE_BYTES) return L(`${file.name} passa de ${MAX_FILE_BYTES / 1024 / 1024} MB.`, `${file.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
  try {
    const url = await dataUrlOf(file)
    return { name: file.name || L('arquivo', 'file'), mime: file.type || 'application/octet-stream', data: url.slice(url.indexOf(',') + 1), url: '', size: file.size }
  } catch {
    return L(`Não deu pra abrir ${file.name}.`, `${file.name} couldn't be opened.`)
  }
}

export async function prepareImage(file: File): Promise<Attached | string> {
  if (!file.type.startsWith('image/')) return L(`${file.name} não é imagem.`, `${file.name} isn't an image.`)
  try {
    const src = await dataUrlOf(file) // the page's CSP takes data: images, not blob:
    const img = new Image()
    img.src = src
    await img.decode()
    const side = Math.max(img.naturalWidth, img.naturalHeight)
    let blob: Blob = file
    if (!IMAGE_MIMES.includes(file.type) || side > MAX_SIDE || file.size > MAX_RAW) {
      const k = Math.min(1, MAX_SIDE / side)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.naturalWidth * k)
      canvas.height = Math.round(img.naturalHeight * k)
      canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
      const encode = (type: string, q?: number): Promise<Blob | null> => new Promise((ok) => canvas.toBlob(ok, type, q))
      blob = (file.type === 'image/png' && (await encode('image/png'))) || file
      if (blob === file || blob.size > MAX_RAW) blob = (await encode('image/jpeg', 0.88)) ?? file
    }
    if (blob.size > MAX_RAW) return L(`${file.name} é grande demais.`, `${file.name} is too big.`)
    const url = blob === file ? src : await dataUrlOf(blob)
    return { name: file.name || L('imagem', 'image'), mime: blob.type, data: url.slice(url.indexOf(',') + 1), url }
  } catch {
    return L(`Não deu pra abrir ${file.name}. Tente salvar de novo ou mandar outra imagem.`, `${file.name} couldn't be opened. Try saving it again or send another image.`)
  }
}

// A phone or a tablet: focusing the message field there raises the keyboard over the
// conversation, so it only takes the focus when the person taps it.
export const touchScreen = (): boolean => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches

// What a paste attaches. Copying text from a spreadsheet, a page or a document often brings a
// picture of it too: that pastes as the text, not as an image the person never meant to send.
// A file copied in Finder or Explorer comes with its name as the text, and still attaches.
export function pastedFiles(files: File[], text: string, server: boolean): File[] {
  const usable = files.filter((f) => server || f.type.startsWith('image/'))
  const typed = text.trim()
  if (!usable.length || !typed) return usable
  const names = new Set(files.map((f) => f.name))
  return typed.split(/\r?\n/).every((line) => names.has(line.trim().split('/').pop() ?? '')) ? usable : []
}

// What goes to sendMessage: pictures as they are, files by name and content.
export function uploadsOf(items: Attached[]): { images: ImageUpload[]; files: FileUpload[] } {
  return {
    images: items.filter((a) => !isFile(a)).map(({ name, mime, data }) => ({ name, mime, data })),
    files: items.filter(isFile).map(({ name, data }) => ({ name, data }))
  }
}

// The attached things of one message, the warning about them, and how to add more. `focus` returns
// the caret to the field after an add; `onText` lets an upload to a server write where the file went.
export function useAttachments(focus: () => void, onText: (update: (text: string) => string) => void, initial: Attached[] = []) {
  const [items, setItems] = useState<Attached[]>(initial)
  const [note, setNote] = useState('')
  const [uploading, setUploading] = useState(false)
  const held = useRef(items)
  held.current = items
  const add = useCallback(
    async (all: File[]): Promise<void> => {
      if (!all.length) return
      // On a server too, a file goes with the message, and its text to the agents. Only one too big for
      // that (or for what a browser's request holds) goes up to the server (~/Enviados) and the message
      // says where: an agent with a computer opens it there, and the link brings it back down.
      const upload = window.tucano?.upload
      const bytes = held.current.filter(isFile).reduce((n, a) => n + (a.size ?? 0), 0)
      const goes = upload ? withMessage(all, bytes) : all.map(() => true)
      const files = all.filter((_, i) => goes[i])
      const others = all.filter((_, i) => !goes[i])
      if (others.length && upload) {
        setNote(L(`Enviando ${others.length === 1 ? others[0]!.name : `${others.length} arquivos`}…`, `Sending ${others.length === 1 ? others[0]!.name : `${others.length} files`}…`))
        setUploading(true)
        const sent = await Promise.allSettled(others.map((f) => upload(f, 'message'))).finally(() => setUploading(false))
        const paths = sent.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
        if (paths.length) onText((t) => `${t.trim() ? `${t.trimEnd()}\n` : ''}${paths.map((p) => L(`Arquivo enviado: \`${p}\``, `File sent: \`${p}\``)).join('\n')}`)
        const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        setNote(failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '')
        if (!files.length) return void focus()
      }
      if (!files.length) return
      // In the app, a file that isn't an image goes with the message, and its text to the agents.
      const done = await Promise.all(files.map((f) => (f.type.startsWith('image/') ? prepareImage(f) : prepareFile(f))))
      const ok = done.filter((d): d is Attached => typeof d !== 'string')
      const errors = done.filter((d): d is string => typeof d === 'string')
      let over = ''
      setItems((cur) => {
        const all = [...cur, ...ok]
        const pics = all.filter((a) => !isFile(a))
        const docs = all.filter(isFile)
        over = pics.length > MAX_IMAGES_PER_MESSAGE ? L(`Até ${MAX_IMAGES_PER_MESSAGE} imagens por mensagem.`, `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`) : docs.length > MAX_FILES_PER_MESSAGE ? L(`Até ${MAX_FILES_PER_MESSAGE} arquivos por mensagem.`, `Up to ${MAX_FILES_PER_MESSAGE} files per message.`) : ''
        return [...pics.slice(0, MAX_IMAGES_PER_MESSAGE), ...docs.slice(0, MAX_FILES_PER_MESSAGE)]
      })
      setNote([...errors, over].filter(Boolean).join(' '))
      focus()
    },
    [focus, onText]
  )
  return { items, setItems, note, setNote, add, uploading }
}

// A file dragged over the window shows the overlay, and one dropped where `claim` says comes to
// `onFiles` (anywhere else it's only kept from opening in place of the app). True while dragging.
export function useFileDrop(claim: (e: DragEvent) => boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const latest = useRef({ claim, onFiles })
  latest.current = { claim, onFiles }
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
      if (latest.current.claim(e)) latest.current.onFiles([...(e.dataTransfer?.files ?? [])])
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
  }, [])
  return dragging
}

// What covers the window while a file is dragged over it: where it goes, and who sees it.
export function DropOverlay({ who }: { who: string }): ReactNode {
  return createPortal(
    <div className="drop-overlay">
      <div className="drop-overlay__card">
        <Icon name="image" size={28} />
        <strong>{L('Solte pra anexar', 'Drop to attach')}</strong>
        <span className="muted">{who}</span>
      </div>
    </div>,
    document.body
  )
}

// The clip, and the system's file picker it opens.
export function AttachButton({ add }: { add: (files: File[]) => void }): ReactNode {
  const picker = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="icon-btn" title={L('Anexar arquivo ou imagem (ou arraste e solte, ou cole)', 'Attach a file or an image (or drag and drop, or paste)')} onClick={() => picker.current?.click()}>
        <Icon name="clip" size={15} />
      </button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add([...(e.target.files ?? [])])
          e.target.value = ''
        }}
      />
    </>
  )
}

// The chips above a field: a picture with its thumbnail, a file with its name, each with a way to take it off.
export function AttachedList({ items, onRemove }: { items: Attached[]; onRemove: (index: number) => void }): ReactNode {
  if (!items.length) return null
  return (
    <div className="composer__images">
      {items.map((img, i) =>
        isFile(img) ? (
          <div key={i} className="composer__file" title={img.name}>
            <Icon name="clip" size={13} />
            <span className="composer__file-name">{img.name}</span>
            <button type="button" className="composer__file-x" title={L('Tirar', 'Remove')} onClick={() => onRemove(i)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ) : (
          <div key={i} className="composer__image" title={img.name}>
            <img src={img.url} alt={img.name} />
            <button type="button" className="composer__image-x" title={L('Tirar', 'Remove')} onClick={() => onRemove(i)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      )}
    </div>
  )
}
