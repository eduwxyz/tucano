// A picture right-clicked in a conversation can leave the app two ways — saved where you say, or into
// the clipboard — or come back in as an attachment to the next message. The menu that offers them
// lives outside every screen: one instance, opened from wherever the picture was.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { getState, toast, updateSettings } from '../store'
import { closeImageMenu, folderLabel, imageActions, imageFileName, toPromptImage, useImageMenu, type ImageAction } from '../image-menu'
import { attachToComposer } from '../composer-attach'
import { Icon, type IconName } from './ui'

const LABEL = (folder: string): Record<ImageAction, string> => ({
  'save-here': folder ? L(`Salvar em ${folder}`, `Save to ${folder}`) : L('Salvar', 'Save'),
  save: L('Salvar como…', 'Save as…'),
  clipboard: L('Copiar para a área de transferência', 'Copy to clipboard'),
  prompt: L('Enviar para o campo de mensagem', 'Send to prompt')
})

const ICON: Record<ImageAction, IconName> = { 'save-here': 'folder', save: 'down', clipboard: 'copy', prompt: 'send' }

const SAVED = (path: string): string => L(`Salvo em ${path}`, `Saved to ${path}`)
const SAVED_HERE = (folder: string): string => L(`Salvo em ${folder}`, `Saved to ${folder}`)
const FOLDER_GONE = (folder: string): string => L(`A pasta ${folder} não está mais lá — escolha onde salvar.`, `${folder} isn't there any more — choose where to save it.`)

const FAILED_SAVE = (): string => L('Não consegui salvar a imagem.', "Couldn't save the image.")
const COPIED = (): string => L('Imagem copiada.', 'Image copied.')
const FAILED_COPY = (): string => L('Não consegui copiar a imagem.', "Couldn't copy the image.")
const ATTACHED = (): string => L('Imagem anexada à sua mensagem.', 'Image attached to your message.')
const FAILED_ATTACH = (): string => L('Não consegui anexar a imagem.', "Couldn't attach the image.")

// In a browser (Tucano as a server) there is no main process to hand the bytes to: the page takes the
// picture for a download, and the clipboard takes it as a blob.
async function saveInBrowser(url: string, title: string): Promise<void> {
  const a = document.createElement('a')
  a.href = url
  a.download = imageFileName(title, url)
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
}

async function copyInBrowser(url: string): Promise<boolean> {
  try {
    const blob = await (await fetch(url)).blob()
    const write = navigator.clipboard as Clipboard & { write?: (items: ClipboardItem[]) => Promise<void> }
    if (!write.write) return false
    await write.write([new ClipboardItem({ [blob.type || 'image/png']: blob })])
    return true
  } catch {
    return false
  }
}

export function ImageMenu(): ReactNode {
  const menu = useImageMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ left: number; top: number } | null>(null)
  // The folder a first save goes into, from the system: the menu names it and saves there in one
  // click, so even the very first picture needs no dialog. Saving anywhere else replaces it.
  const [fallback, setFallback] = useState('')
  useEffect(() => {
    const api = window.tucano?.image
    if (!api?.folder) return
    let live = true
    void api
      .folder()
      .then((r) => {
        if (live && r?.folder) setFallback(r.folder)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  // Where the menu goes: at the pointer, unless that would put it off the window, then inside.
  useLayoutEffect(() => {
    if (!menu) return setAt(null)
    const el = ref.current
    const w = el?.offsetWidth ?? 260
    const h = el?.offsetHeight ?? 120
    const left = Math.min(menu.x, Math.max(0, window.innerWidth - w - 8))
    const top = menu.y + h > window.innerHeight - 8 ? Math.max(8, menu.y - h) : menu.y
    setAt({ left: Math.max(8, left), top })
  }, [menu])

  // Anything that would leave the menu over the wrong thing closes it: a click elsewhere, a key,
  // a scroll, the window losing focus, another right-click.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeImageMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeImageMenu()
      }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', closeImageMenu)
    window.addEventListener('blur', closeImageMenu)
    window.addEventListener('wheel', closeImageMenu, { passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', closeImageMenu)
      window.removeEventListener('blur', closeImageMenu)
      window.removeEventListener('wheel', closeImageMenu)
    }
  }, [menu])

  // The arrow keys walk the items, so the menu works without a mouse once it's open — and only once
  // it is placed: an element that is still hidden can't take focus.
  useEffect(() => {
    if (!menu || !at || !ref.current) return
    ref.current.querySelector<HTMLButtonElement>('button')?.focus()
  }, [menu, at])

  if (!menu) return null
  const { target } = menu
  // Where the picture goes in one click, named as the folder is called: the folder the last one went
  // to, or the system's downloads folder until the person saves one somewhere else.
  const remembered = getState().settings.lastImageFolder ?? ''
  const savedTo = remembered || fallback
  const folder = folderLabel(savedTo)
  const actions = imageActions(target.surface, !!savedTo)

  const run = async (action: ImageAction): Promise<void> => {
    closeImageMenu()
    if (action === 'save-here' || action === 'save') {
      const api = window.tucano?.image
      if (!api) return void saveInBrowser(target.url, target.title)
      const oneClick = action === 'save-here'
      let done = oneClick
        ? await api.save(target.url, target.title, { dir: savedTo })
        : await api.save(target.url, target.title, { dir: remembered, dialog: true })
      // The folder is gone — deleted, a drive unplugged, a share down. Say it, and let the person
      // pick somewhere instead of the click doing nothing.
      let fellBack = false
      if (done.result === 'missing_folder') {
        fellBack = true
        toast(FOLDER_GONE(folderLabel(done.folder) || done.folder))
        done = await api.save(target.url, target.title, { dialog: true })
      }
      if (done.result === 'saved') {
        // Wherever it landed is where the next one goes in one click.
        if (done.folder && done.folder !== remembered) updateSettings({ lastImageFolder: done.folder })
        toast(oneClick && !fellBack ? SAVED_HERE(folderLabel(done.folder)) : SAVED(done.path))
      } else if (done.result === 'failed') toast(FAILED_SAVE())
      return
    }
    if (action === 'clipboard') {
      const api = window.tucano?.image
      const ok = api ? await api.copy(target.url) : await copyInBrowser(target.url)
      toast(ok ? COPIED() : FAILED_COPY())
      return
    }
    const image = await toPromptImage(target.url, target.title)
    if (!image || !attachToComposer(target.conversationId ?? '', [image])) return void toast(FAILED_ATTACH())
    toast(ATTACHED())
  }

  return (
    <div className="image-menu" role="menu" aria-label={L('Imagem', 'Image')} ref={ref} style={at ? { left: `${at.left}px`, top: `${at.top}px` } : { visibility: 'hidden' }} onContextMenu={(e) => e.preventDefault()}>
      {actions.map((action) => (
        <button key={action} role="menuitem" className="image-menu__item" onClick={() => void run(action)}>
          <Icon name={ICON[action]} size={15} />
          <span>{LABEL(folder)[action]}</span>
        </button>
      ))}
    </div>
  )
}
