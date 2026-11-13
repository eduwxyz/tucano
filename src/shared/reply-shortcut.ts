// The key that replies to the excerpt I selected: ⌘L on a Mac, Ctrl+L everywhere else, with no
// other modifier held. It is the shortcut people already use to send a selection to the chat in
// AI editors, and it is free in Tucano. Whether it does anything is the person's setting
// (Settings › General), read where the key is handled.
export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function isReplyShortcut(e: KeyLike, mac: boolean): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l'
}
