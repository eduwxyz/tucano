// Attaching to a message, in one place: what a picture or a file becomes, the limits, what a server
// takes instead, the warning each one gets, and the strip that shows them. The conversation's
// composer and the box at the bottom of the Team board both use this, so the two cannot drift apart.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../shared/lang'
import { IMAGE_MIMES, MAX_FILE_BYTES, MAX_FILES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE, type FileUpload, type ImageUpload } from '../../shared/types'
import { Icon } from './components/ui'

// Images go to the models as they are when small; big ones are scaled down
// (longest side MAX_SIDE) and re-encoded, so any screenshot or photo fits.
const MAX_SIDE = 2000
const MAX_RAW = 3_700_000 // base64 under the models' 5 MB

// An image (with what shows it) or, in the app, any other file: `url` empty, its text goes to the agents.
export type Attached = ImageUpload & { url: string; size?: number }
export const isFile = (a: Attached): boolean => !a.url

// What goes to a message: the pictures, and the files whose text the agents read.
export const picturesOf = (all: Attached[]): ImageUpload[] => all.filter((a) => !isFile(a)).map(({ name, mime, data }) => ({ name, mime, data }))
export const docsOf = (all: Attached[]): FileUpload[] => all.filter(isFile).map(({ name, data }) => ({ name, data }))

// A phone's keyboard covers the field: it isn't focused there, since that would scroll the page to it.
export const touchScreen = (): boolean => typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches

const dataUrlOf = (blob: Blob): Promise<string> =>
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

// The files a paste brings, if it brings any: the field attaches them and doesn't paste the text.
export const pasteHandler =
  (add: (files: File[]) => void) =>
  (e: { clipboardData: DataTransfer | null; preventDefault: () => void }): void => {
    if (!e.clipboardData) return
    const files = pastedFiles([...e.clipboardData.files], e.clipboardData.getData('text/plain'), true)
    if (!files.length) return
    e.preventDefault()
    add(files)
  }

export interface Attachments {
  attached: Attached[]
  setAttached: (next: Attached[] | ((cur: Attached[]) => Attached[])) => void
  note: string // what to warn about: too big, too many, couldn't open
  setNote: (note: string) => void
  add: (files: File[]) => Promise<void>
  remove: (index: number) => void
  clear: () => void
}

// `append`: where a file sent up to a server says where it landed (`~/Enviados`), in the message's own
// words. `focus`: the field to put the cursor back in once the files are in.
export function useAttachments({ append, focus, initial = [] }: { append: (text: string) => void; focus?: () => void; initial?: Attached[] }): Attachments {
  const [attached, setAttached] = useState<Attached[]>(initial)
  const [note, setNote] = useState('')
  const keep = useRef({ append, focus })
  keep.current = { append, focus }

  const add = async (all: File[]): Promise<void> => {
    if (!all.length) return
    const settle = (): void => {
      if (!touchScreen()) keep.current.focus?.()
    }
    // On a server, a file that isn't an image goes up to it (~/Enviados) and the message says where:
    // an agent on that computer opens it there, and the link brings it back down.
    const upload = window.tucano?.upload
    const files = upload ? all.filter((f) => IMAGE_MIMES.includes(f.type)) : all
    const others = upload ? all.filter((f) => !IMAGE_MIMES.includes(f.type)) : []
    if (others.length && upload) {
      setNote(L(`Enviando ${others.length === 1 ? others[0]!.name : `${others.length} arquivos`}…`, `Sending ${others.length === 1 ? others[0]!.name : `${others.length} files`}…`))
      const sent = await Promise.allSettled(others.map((f) => upload(f, 'message')))
      const paths = sent.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      if (paths.length) keep.current.append(paths.map((p) => L(`Arquivo enviado: \`${p}\``, `File sent: \`${p}\``)).join('\n'))
      const failed = sent.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      setNote(failed ? String(failed.reason instanceof Error ? failed.reason.message : failed.reason) : '')
      if (!files.length) return settle()
    }
    if (!files.length) return
    // In the app, a file that isn't an image goes with the message, and its text to the agents.
    const done = await Promise.all(files.map((f) => (f.type.startsWith('image/') ? prepareImage(f) : prepareFile(f))))
    const ok = done.filter((d): d is Attached => typeof d !== 'string')
    const errors = done.filter((d): d is string => typeof d === 'string')
    let over = ''
    setAttached((cur) => {
      const all = [...cur, ...ok]
      const pics = all.filter((a) => !isFile(a))
      const docs = all.filter(isFile)
      over = pics.length > MAX_IMAGES_PER_MESSAGE ? L(`Até ${MAX_IMAGES_PER_MESSAGE} imagens por mensagem.`, `Up to ${MAX_IMAGES_PER_MESSAGE} images per message.`) : docs.length > MAX_FILES_PER_MESSAGE ? L(`Até ${MAX_FILES_PER_MESSAGE} arquivos por mensagem.`, `Up to ${MAX_FILES_PER_MESSAGE} files per message.`) : ''
      return [...pics.slice(0, MAX_IMAGES_PER_MESSAGE), ...docs.slice(0, MAX_FILES_PER_MESSAGE)]
    })
    setNote([...errors, over].filter(Boolean).join(' '))
    settle()
  }

  return {
    attached,
    setAttached,
    note,
    setNote,
    add,
    remove: (index) => setAttached((cur) => cur.filter((_, j) => j !== index)),
    clear: () => (setAttached([]), setNote(''))
  }
}

// What's attached, above the field: the picture itself or the file's name, each with a way to take it
// off before sending.
export function AttachedList({ attached, onRemove }: { attached: Attached[]; onRemove: (index: number) => void }): ReactNode {
  if (!attached.length) return null
  return (
    <div className="composer__images">
      {attached.map((a, i) =>
        isFile(a) ? (
          <div key={i} className="composer__file" title={a.name}>
            <Icon name="clip" size={13} />
            <span className="composer__file-name">{a.name}</span>
            <button type="button" className="composer__file-x" title={L('Tirar', 'Remove')} onClick={() => onRemove(i)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        ) : (
          <div key={i} className="composer__image" title={a.name}>
            <img src={a.url} alt={a.name} />
            <button type="button" className="composer__image-x" title={L('Tirar', 'Remove')} onClick={() => onRemove(i)}>
              <Icon name="x" size={11} />
            </button>
          </div>
        )
      )}
    </div>
  )
}

// The clip button and the picker behind it.
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

// A file dropped anywhere in the window comes to the field that claims it (and never opens in place of
// the app). `claim` says which of two fields gets this drop, when both are on screen.
export function useFileDrop(claim: (e: DragEvent) => boolean, onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const mine = useRef(claim)
  mine.current = claim
  const take = useRef(onFiles)
  take.current = onFiles
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
      if (mine.current(e)) take.current([...(e.dataTransfer?.files ?? [])])
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

// Shown while a file is over the window.
export function DropOverlay(): ReactNode {
  return (
    <div className="drop-overlay">
      <div className="drop-overlay__card">
        <Icon name="image" size={28} />
        <strong>{L('Solte pra anexar', 'Drop to attach')}</strong>
        <span className="muted">{L('Os agentes veem o conteúdo junto com a mensagem.', 'Agents see the content along with the message.')}</span>
      </div>
    </div>
  )
}
