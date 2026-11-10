// A picture right-clicked in a conversation can leave the app two ways — saved where you say, or into
// the clipboard — or come back in as an attachment to the next message. The menu that offers them
// lives outside every screen: one instance, opened from wherever the picture was.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { toast } from '../store'
import { closeImageMenu, imageActions, imageFileName, toPromptImage, useImageMenu, type ImageAction } from '../image-menu'
import { attachToComposer } from '../composer-attach'
import { Icon } from './ui'

const LABEL = (): Record<ImageAction, string> => ({
  save: L('Salvar como…', 'Save as…'),
  clipboard: L('Copiar para a área de transferência', 'Copy to clipboard'),
  prompt: L('Copiar para o campo de mensagem', 'Copy to prompt')
})

const ICON: Record<ImageAction, 'down' | 'copy' | 'edit'> = { save: 'down', clipboard: 'copy', prompt: 'edit' }

const SAVED = (path: string): string => L(`Salvo em ${path}`, `Saved to ${path}`)
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
  const actions = imageActions(target.surface)

  const run = async (action: ImageAction): Promise<void> => {
    closeImageMenu()
    if (action === 'save') {
      const api = window.tucano?.image
      if (!api) return void saveInBrowser(target.url, target.title)
      const done = await api.save(target.url, target.title)
      if (done.result === 'saved') toast(SAVED(done.path))
      else if (done.result === 'failed') toast(FAILED_SAVE())
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
          <span>{LABEL()[action]}</span>
        </button>
      ))}
    </div>
  )
}
