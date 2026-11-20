// Sending files into a folder: checks each one before it leaves (type and size, in plain words),
// reads it, and says where it is while it goes. The core checks again; this only spares the wait.
import { useRef, useState } from 'react'
import { L } from '../../../../shared/lang'
import { acceptsDoc, DOC_EXTENSIONS, MAX_DOC_BYTES } from '../../../../shared/docs'
import { call } from '../../rpc'
import { toast } from '../../store'
import { message } from '../Invite'

export const ACCEPT = DOC_EXTENSIONS.join(',') // for the file picker
const MEDIA = /\.(mp4|mov|avi|mkv|webm|m4v|mp3|wav|m4a|aac|flac|ogg)$/i
const MAX_MB = Math.round(MAX_DOC_BYTES / 1024 / 1024)

export interface Sending {
  key: number
  name: string
  folderId: string
}
export interface Refusal {
  key: number
  text: string
}

// Why a file doesn't go in, or null when it does.
export function refusalFor(f: Pick<File, 'name' | 'size'>): string | null {
  if (MEDIA.test(f.name)) return L(`${f.name}: vídeo e áudio não são guardados aqui. Entram PDF, Word, planilha, CSV, texto, página e imagem.`, `${f.name}: video and audio are not kept here. PDF, Word, spreadsheet, CSV, text, page and image files are.`)
  if (!acceptsDoc(f.name)) return L(`${f.name}: esse tipo de arquivo não entra aqui. Entram PDF, Word, planilha, CSV, texto, página e imagem.`, `${f.name}: this kind of file doesn't go in. PDF, Word, spreadsheet, CSV, text, page and image files do.`)
  if (f.size > MAX_DOC_BYTES) return L(`${f.name}: arquivo maior que ${MAX_MB} MB.`, `${f.name}: the file is larger than ${MAX_MB} MB.`)
  if (f.size === 0) return L(`${f.name}: o arquivo está vazio.`, `${f.name}: the file is empty.`)
  return null
}

const base64 = (f: File): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1] ?? '')
    r.onerror = () => rej(r.error ?? new Error('read'))
    r.readAsDataURL(f)
  })

export function useDocUpload(): { sending: Sending[]; refused: Refusal[]; dismiss: (key: number) => void; send: (folderId: string, folderName: string, files: File[]) => Promise<void> } {
  const [sending, setSending] = useState<Sending[]>([])
  const [refused, setRefused] = useState<Refusal[]>([])
  const seq = useRef(0)
  const send = async (folderId: string, folderName: string, files: File[]): Promise<void> => {
    const ok: { f: File; key: number }[] = []
    const no: Refusal[] = []
    for (const f of files) {
      const why = refusalFor(f)
      if (why) no.push({ key: ++seq.current, text: why })
      else ok.push({ f, key: ++seq.current })
    }
    if (no.length) setRefused((r) => [...r, ...no])
    setSending((s) => [...s, ...ok.map(({ f, key }) => ({ key, name: f.name, folderId }))])
    let kept = 0
    for (const { f, key } of ok) {
      try {
        await call('docAdd', { folderId, name: f.name, data: await base64(f) })
        kept++
      } catch (e) {
        setRefused((r) => [...r, { key: ++seq.current, text: `${f.name}: ${message(e)}` }])
      }
      setSending((s) => s.filter((x) => x.key !== key))
    }
    if (kept) toast(kept === 1 ? L(`Guardado em ${folderName}.`, `Kept in ${folderName}.`) : L(`${kept} arquivos guardados em ${folderName}.`, `${kept} files kept in ${folderName}.`))
  }
  return { sending, refused, dismiss: (key) => setRefused((r) => r.filter((x) => x.key !== key)), send }
}

// Files dropped for the Tuca to put away ("Chegada"): no folder chosen, she reads each one and picks. They
// show as sent while they go up; after that the document itself says it is waiting to be put away.
export function useInboxUpload(): { sending: Sending[]; refused: Refusal[]; dismiss: (key: number) => void; send: (files: File[]) => Promise<void> } {
  const [sending, setSending] = useState<Sending[]>([])
  const [refused, setRefused] = useState<Refusal[]>([])
  const seq = useRef(0)
  const send = async (files: File[]): Promise<void> => {
    const ok: { f: File; key: number }[] = []
    const no: Refusal[] = []
    for (const f of files) {
      const why = refusalFor(f)
      if (why) no.push({ key: ++seq.current, text: why })
      else ok.push({ f, key: ++seq.current })
    }
    if (no.length) setRefused((r) => [...r, ...no])
    setSending((s) => [...s, ...ok.map(({ f, key }) => ({ key, name: f.name, folderId: '' }))])
    let sent = 0
    for (const { f, key } of ok) {
      try {
        await call('docInboxAdd', { name: f.name, data: await base64(f) })
        sent++
      } catch (e) {
        setRefused((r) => [...r, { key: ++seq.current, text: `${f.name}: ${message(e)}` }])
      }
      setSending((s) => s.filter((x) => x.key !== key))
    }
    if (sent) toast(sent === 1 ? L('Recebido. A Tuca já está lendo.', 'Received. Tuca is already reading it.') : L(`${sent} arquivos recebidos. A Tuca já está lendo.`, `${sent} files received. Tuca is already reading them.`))
  }
  return { sending, refused, dismiss: (key) => setRefused((r) => r.filter((x) => x.key !== key)), send }
}
