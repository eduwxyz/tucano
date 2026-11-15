import { describe, expect, it, vi } from 'vitest'
import { ThoughtCache } from '../src/renderer/src/thoughts'

describe('temporary reasoning retention', () => {
  it('bounds the number of retained replies while keeping currently streamed replies recent', () => {
    const changed = vi.fn()
    const cache = new ThoughtCache(changed, 2, 10)
    cache.append('active', 'first')
    cache.append('old', 'second')
    cache.append('active', 'new')
    cache.append('recent', 'third')
    expect(cache.get('old')).toBeUndefined()
    expect(cache.get('active')).toBe('firstnew')
    expect(cache.get('recent')).toBe('third')
    expect(changed).toHaveBeenCalledWith('old')
  })

  it('bounds a single delta and accumulated deltas without mixing replies', () => {
    const cache = new ThoughtCache(() => {}, 2, 6)
    cache.append('a', '123456789')
    cache.append('b', 'other')
    cache.append('a', 'abc')
    expect(cache.get('a')).toBe('789abc')
    expect(cache.get('b')).toBe('other')
  })

  it('notifies subscribers when selected replies or the whole cache are forgotten', () => {
    const changed = vi.fn()
    const cache = new ThoughtCache(changed)
    cache.append('a', 'private')
    cache.append('b', 'retained')
    changed.mockClear()
    cache.clear(['a', 'absent'])
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe('retained')
    expect(changed.mock.calls).toEqual([['a']])
    cache.clear()
    expect(cache.get('b')).toBeUndefined()
    expect(changed.mock.calls).toEqual([['a'], ['b']])
  })
})
