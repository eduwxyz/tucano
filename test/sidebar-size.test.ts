import { expect, it } from 'vitest'
import { clampPanelWidth, clampSidebarWidth, PANEL_MIN, readPanelWidth, readSidebarWidth, savePanelWidth, saveSidebarWidth, SIDEBAR_MAX, SIDEBAR_MIN } from '../src/renderer/src/sidebar-size'

const storage = (): Storage => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Storage
}

it('keeps the dragged width between the limits, and under half the window', () => {
  expect(clampSidebarWidth(320.4, 1440)).toBe(320)
  expect(clampSidebarWidth(40, 1440)).toBe(SIDEBAR_MIN)
  expect(clampSidebarWidth(900, 1440)).toBe(SIDEBAR_MAX)
  expect(clampSidebarWidth(460, 800)).toBe(400) // half of a small window
  expect(clampSidebarWidth(460, 300)).toBe(SIDEBAR_MIN) // never under the minimum
})

it('remembers the width, and forgets it on a reset', () => {
  const s = storage()
  expect(readSidebarWidth(s)).toBeNull()
  saveSidebarWidth(s, 312.6)
  expect(readSidebarWidth(s)).toBe(313)
  saveSidebarWidth(s, null)
  expect(readSidebarWidth(s)).toBeNull()
  s.setItem('tucano.sidebar-width', 'wide')
  expect(readSidebarWidth(s)).toBeNull()
})

it("keeps the panel on the right between its minimum and what leaves room for the conversation", () => {
  expect(clampPanelWidth(500, 1000)).toBe(500)
  expect(clampPanelWidth(100, 1000)).toBe(PANEL_MIN)
  expect(clampPanelWidth(900, 1000)).toBe(680) // 320 stay for the conversation
  expect(clampPanelWidth(900, 500)).toBe(PANEL_MIN) // a narrow window: the minimum
  const s = storage()
  savePanelWidth(s, 512.2)
  expect(readPanelWidth(s)).toBe(512)
  expect(readSidebarWidth(s)).toBeNull() // each keeps its own
  savePanelWidth(s, null)
  expect(readPanelWidth(s)).toBeNull()
})
