import { expect, it } from 'vitest'
import { isReplyShortcut } from '../src/shared/reply-shortcut'

const key = (over: Partial<Parameters<typeof isReplyShortcut>[0]>): Parameters<typeof isReplyShortcut>[0] => ({
  key: 'l',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over
})

it('replies to a selection with ⌘L on a Mac and Ctrl+L elsewhere', () => {
  expect(isReplyShortcut(key({ metaKey: true }), true)).toBe(true)
  expect(isReplyShortcut(key({ ctrlKey: true }), false)).toBe(true)
  // The other platform's key is not held, and capital L (Shift on) is a different intent.
  expect(isReplyShortcut(key({ ctrlKey: true }), true)).toBe(false)
  expect(isReplyShortcut(key({ metaKey: true }), false)).toBe(false)
  expect(isReplyShortcut(key({ ctrlKey: true, shiftKey: true }), false)).toBe(false)
  expect(isReplyShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
})

it('leaves a key with no modifier, an extra one, or another letter alone', () => {
  expect(isReplyShortcut(key({}), false)).toBe(false)
  expect(isReplyShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false)
  // The app's own shortcuts (⌘K go anywhere, ⌘N new channel, ⌘, settings) keep working.
  for (const other of ['k', 'n', ',', '1']) expect(isReplyShortcut(key({ metaKey: true, key: other }), true)).toBe(false)
})
