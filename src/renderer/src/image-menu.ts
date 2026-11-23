// A right-click on a picture in the conversation: the small menu it opens, and what each kind of
// picture offers. Kept apart from the drawing so the choices can be checked without a window.
import { useSyncExternalStore } from 'react'

// Where the picture was right-clicked. The album (the fullscreen view) is for looking at a picture,
// so it offers the two ways out of the app; a picture in a reply also offers going back in, attached
// to what you're about to ask.
export type ImageSurface = 'reply' | 'gallery'
// `save-here` is the one click: into the folder the last picture went to, or the system's downloads
// folder before anything has been saved, no dialog either way. It sits under the dialog entry, which
// is the way to choose somewhere else.
export type ImageAction = 'save-here' | 'save' | 'clipboard' | 'prompt'

export interface MenuTarget {
  url: string
  title: string
  surface: ImageSurface
  conversationId?: string // where the prompt below lives, for `prompt`
}

export interface OpenImageMenu {
  target: MenuTarget
  x: number
  y: number
}

export const imageActions = (surface: ImageSurface, hasFolder = false): ImageAction[] => {
  // The dialog first and the one click under it: choosing somewhere else comes before repeating the
  // last place, which is the order a person looks for them in.
  const saving: ImageAction[] = hasFolder ? ['save', 'save-here'] : ['save']
  return surface === 'gallery' ? [...saving, 'clipboard'] : [...saving, 'clipboard', 'prompt']
}

// The folder as a menu entry says it: its own name, capitalised — `C:\Users\theap\Downloads` reads
// `Downloads`, a folder called `shots` reads `Shots`. A drive on its own has no name of its own, so
// it says what Windows calls it.
export function folderLabel(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  const last = trimmed.split(/[\\/]/).pop() ?? ''
  if (!last) return ''
  if (/^[A-Za-z]:$/.test(last)) return `Local Disk (${last.toUpperCase()})`
  return last.charAt(0).toUpperCase() + last.slice(1)
}

// What the save dialog is offered as a name: the title, and the extension the picture already has.
export function imageFileName(title: string, url: string): string {
  const asked = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '') // a title that starts with dots stays a name, not a hidden file
    .slice(0, 80)
  const ext = (/\.(png|jpe?g|gif|webp|avif|svg)$/i.exec(url.split('?')[0] ?? '')?.[0] ?? '.png').toLowerCase()
  // One extension, not two: a picture whose title already says "pic.png" is saved as "pic.png".
  const named = asked || 'image'
  const stem = named.toLowerCase().endsWith(ext) ? named.slice(0, -ext.length) : named
  return `${stem || 'image'}${ext}`
}

// ---------- the menu's state ----------

let current: OpenImageMenu | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((cb) => cb())

export const openImageMenu = (target: MenuTarget, at: { x: number; y: number }): void => {
  current = { target, x: at.x, y: at.y }
  emit()
}

export const closeImageMenu = (): void => {
  if (!current) return
  current = null
  emit()
}

export const imageMenuState = (): OpenImageMenu | null => current

export const subscribeImageMenu = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

export const useImageMenu = (): OpenImageMenu | null => useSyncExternalStore(subscribeImageMenu, imageMenuState, () => null)

// An image as the composer holds it, on its way to a message.
export interface PromptImage {
  name: string
  mime: string
  data: string // base64, no data: prefix
  url: string
}

// The picture at `url`, read in this page, as something the composer can carry. A picture it can't
// read comes back as null, and the menu says so instead of attaching nothing.
export async function toPromptImage(url: string, title: string): Promise<PromptImage | null> {
  // In the app the page can't fetch a tucano:// picture (the protocol's pages are file://), so the
  // main process hands the bytes over, read the same way the save and clipboard paths read them.
  const desktop = window.tucano?.image
  if (desktop) {
    const got = await desktop.read(url).catch(() => null)
    if (!got?.data) return null
    return { name: imageFileName(title, url), mime: got.mime, data: got.data, url }
  }
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    if (!blob.size || !blob.type.startsWith('image/')) return null
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const s = String(reader.result)
        resolve(s.slice(s.indexOf(',') + 1))
      }
      reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
      reader.readAsDataURL(blob)
    })
    return { name: imageFileName(title, url), mime: blob.type, data, url }
  } catch {
    return null
  }
}
