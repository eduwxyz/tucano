// An open document shows its details column (where it came from, versions, who sees it) unless this
// viewer closed it before; blocked storage never hides it.
import { afterEach, describe, expect, it, vi } from 'vitest'

const { readDetails } = await import('../src/renderer/src/components/docs/DocView')
const storage = (get: (k: string) => string | null): void => void vi.stubGlobal('localStorage', { getItem: get, setItem: () => {} })

afterEach(() => vi.unstubAllGlobals())

describe('the details column of an open document', () => {
  it('starts open when nothing was saved', () => {
    storage(() => null)
    expect(readDetails()).toBe(true)
  })
  it('stays closed once this viewer closed it, and open once reopened', () => {
    storage(() => '0')
    expect(readDetails()).toBe(false)
    storage(() => '1')
    expect(readDetails()).toBe(true)
  })
  it('starts open when storage is blocked', () => {
    storage(() => {
      throw new Error('blocked')
    })
    expect(readDetails()).toBe(true)
  })
})
