// A path an agent cited, as a link if the core says it can be one. What a click does comes from what
// the core found there, never from the text.
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { LOCAL_LINK } from '../../../shared/path-text'
import { localPath, openLightbox, openLocal, useStore, type LocalInfo } from '../store'
import { WikiLink } from './Wiki'

const known = new Map<string, Promise<LocalInfo | null>>()
const lookUp = (messageId: string, path: string): Promise<LocalInfo | null> => {
  const key = `${messageId}\n${path}`
  let found = known.get(key)
  if (!found) {
    found = localPath(messageId, path).catch(() => null)
    known.set(key, found)
  }
  return found
}

function LocalLink({ messageId, path, children }: { messageId: string; path: string; children: ReactNode }): ReactNode {
  const [info, setInfo] = useState<LocalInfo | null>(null)
  const onMac = useStore((s) => s.platform) === 'mac'
  useEffect(() => {
    let alive = true
    void lookUp(messageId, path).then((r) => alive && setInfo(r))
    return () => {
      alive = false
    }
  }, [messageId, path])
  if (!info) return <>{children}</>
  const title = path.split('/').filter(Boolean).pop() ?? path
  const open = (e: MouseEvent<HTMLButtonElement>): void => {
    if (info.url) {
      // The others cited in this message, so the arrows go through them.
      const here = [...(e.currentTarget.closest('.md')?.querySelectorAll<HTMLElement>('[data-media-url]') ?? [])]
      const items = here.map((el) => ({ url: el.dataset['mediaUrl']!, title: el.dataset['mediaTitle']!, video: el.dataset['mediaVideo'] === '1' }))
      const unique = items.filter((x, i) => items.findIndex((y) => y.url === x.url) === i)
      openLightbox(unique, Math.max(0, unique.findIndex((x) => x.url === info.url)))
    } else openLocal(messageId, path, info.kind === 'folder' || info.kind === 'pdf' ? 'open' : 'reveal')
  }
  return (
    <button
      type="button"
      className="local-link"
      title={
        info.url ? L(`Abrir aqui (botão direito: mostrar ${onMac ? 'no Finder' : 'na pasta'})`, `Open here (right click: show ${onMac ? 'in Finder' : 'in its folder'})`)
        : info.kind === 'file' ? L(`Mostrar ${onMac ? 'no Finder' : 'na pasta'}`, `Show ${onMac ? 'in Finder' : 'in its folder'}`)
        : L('Abrir (botão direito: mostrar onde está)', 'Open (right click: show where it is)')
      }
      data-media-url={info.url}
      data-media-title={info.url ? title : undefined}
      data-media-video={info.kind === 'video' ? '1' : undefined}
      onClick={open}
      onContextMenu={(e) => {
        e.preventDefault()
        openLocal(messageId, path, 'reveal')
      }}
    >
      {children}
    </button>
  )
}

// An agent can write this address by hand, malformed.
const decoded = (text: string): string | undefined => {
  try {
    return decodeURIComponent(text)
  } catch {
    return undefined
  }
}

// react-markdown's `a`, for a message of an agent: its own links stay plain.
export const localLinkFor = (messageId: string) =>
  function MessageLink({ href, children, node: _node, ...rest }: { href?: string; children?: ReactNode; node?: unknown }): ReactNode {
    const path = href?.startsWith(LOCAL_LINK) ? decoded(href.slice(LOCAL_LINK.length)) : undefined
    if (path) return <LocalLink messageId={messageId} path={path}>{children}</LocalLink>
    if (href?.startsWith(LOCAL_LINK)) return <>{children}</>
    if (href?.startsWith('#wiki/') || href?.startsWith('#abrir/')) return <WikiLink href={href}>{children}</WikiLink> // a [[page]] of the wiki, or one of the app's screens
    return <a href={href} {...rest}>{children}</a>
  }
