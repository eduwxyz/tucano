import { describe, expect, it, vi } from 'vitest'
import { ThoughtCache } from '../src/renderer/src/thoughts'

describe('temporary reasoning retention', () => {
  it('tracks the absolute origin across repeated trims, including identical retained text', () => {
    const cache = new ThoughtCache(() => {}, 2, 6)
    cache.append('a', 'xxxxxx')
    const first = cache.snapshot('a')
    expect(first).toEqual({ text: 'xxxxxx', start: 0 })
    expect(cache.snapshot('a')).toBe(first)
    cache.append('a', 'xxx')
    expect(cache.snapshot('a')).toEqual({ text: 'xxxxxx', start: 3 })
    cache.append('a', 'xx')
    expect(cache.snapshot('a')).toEqual({ text: 'xxxxxx', start: 5 })
    cache.clear()
    cache.append('a', 'new')
    expect(cache.snapshot('a')).toEqual({ text: 'new', start: 0 })
  })

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
