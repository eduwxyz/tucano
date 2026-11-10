import { expect, it } from 'vitest'
import { readThreadPanelWidth, saveThreadPanelWidth, threadPanelWidthForDrag } from '../src/renderer/src/thread-panel-size'

const storage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: (key: string) => values.get(key)
  }
}

it('restores a saved panel width and ignores invalid storage values', () => {
  expect(readThreadPanelWidth(storage({ 'tucano.threadPanelWidth': '480' }))).toBe(480)
  expect(readThreadPanelWidth(storage({ 'tucano.threadPanelWidth': 'not-a-width' }))).toBeNull()
  expect(readThreadPanelWidth(storage({ 'tucano.threadPanelWidth': '200' }))).toBeNull()
})

it('saves the width within the panel bounds', () => {
  const store = storage()
  saveThreadPanelWidth(store, 900)
  expect(store.value('tucano.threadPanelWidth')).toBe('760')
})

it('derives a bounded width from dragging the panel edge', () => {
  expect(threadPanelWidthForDrag(1200, 700, 360, 1200)).toBe(500)
  expect(threadPanelWidthForDrag(1200, 0, 360, 760)).toBe(760)
  expect(threadPanelWidthForDrag(1200, 1100, 360, 760)).toBe(360)
})
