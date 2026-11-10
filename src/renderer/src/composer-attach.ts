// The one place the composer's pictures are added to from outside it: "copy to prompt" on a picture
// in a reply puts it in the field below, exactly as if it had been dropped there. The composer keeps
// the draft; this only says when something arrived.
export interface PromptImage {
  name: string
  mime: string
  data: string // base64, no data: prefix
  url: string
  size?: number
}

type Listener = (images: PromptImage[]) => void
const listeners = new Map<string, Set<Listener>>()

// Every field showing that conversation listens; `key` is a conversation's id, or a thread's when a
// reply is written inside one.
export const onComposerImages = (key: string, cb: Listener): (() => void) => {
  const set = listeners.get(key) ?? new Set<Listener>()
  set.add(cb)
  listeners.set(key, set)
  return () => {
    set.delete(cb)
    if (!set.size) listeners.delete(key)
  }
}

// How many fields took it: none means the picture would go nowhere, and the caller says so.
export const attachToComposer = (key: string, images: PromptImage[]): number => {
  const set = listeners.get(key)
  if (!key || !set?.size || !images.length) return 0
  set.forEach((cb) => cb(images))
  return set.size
}

export const composerListenerCount = (key: string): number => listeners.get(key)?.size ?? 0
