// What the cards read from the core, and when they read it again: what waits on me changes as
// someone approves elsewhere or an agent asks something, and how the cards are set changes when the
// person edits Settings. The window is short-lived and light: it never holds the app's whole state.
import { setLang } from '../../../shared/lang'
import { call, connect } from '../rpc'
import type { CoreEvent } from '../../../shared/rpc'
import type { NoticeFeed } from '../../../shared/notice'

// What makes a card's words or buttons change: a decision waiting, a setting, an agent's name (or
// its new face), a channel's name, and who's on the team.
const MATTERS = new Set<CoreEvent['type']>(['inbox', 'settings', 'agent', 'people', 'conversation', 'conversation_removed'])

// The core's port, asked for once per page: the cards listen to it, and the page that draws the
// rectangle needs the settings. A second ask would open a second port for nothing.
const hearing = new Set<(e: CoreEvent) => void>()
let linking: Promise<void> | null = null
export const link = (): Promise<void> => (linking ??= connect((e) => { for (const hear of hearing) hear(e) }))

export function startFeed(on: (feed: NoticeFeed) => void): () => void {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async (): Promise<void> => {
    try {
      const feed = await call('noticeFeed')
      if (closed) return
      // The cards speak the app's language, whatever the system had said first.
      setLang(feed.language)
      on(feed)
    } catch {
      // The core is starting, or the app is quitting: the last feed stands.
    }
  }
  const again = (): void => {
    if (timer) clearTimeout(timer)
    // A burst of changes (an agent's steps, mostly) reads once.
    timer = setTimeout(() => void read(), 120)
  }
  hearing.add((e) => {
    if (MATTERS.has(e.type)) again()
  })
  void link().then(() => void read())
  return () => {
    closed = true
    if (timer) clearTimeout(timer)
  }
}
