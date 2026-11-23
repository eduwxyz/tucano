// The person's order for a sidebar list: what it names first, the rest after, and a step that always
// moves something they can see.
import { describe, expect, it } from 'vitest'
import { moveBefore, nudge, ordered } from '../src/shared/list-order'

const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
const ids = (list: { id: string }[]): string[] => list.map((i) => i.id)

describe('a sidebar list in the order the person left it', () => {
  it('shows what the order names first, then the rest as they come, and forgets what is gone', () => {
    expect(ids(ordered(items, ['c', 'gone', 'a', 'c']))).toEqual(['c', 'a', 'b', 'd'])
    expect(ids(ordered(items, undefined))).toEqual(['a', 'b', 'c', 'd'])
    expect(ids(ordered(items, 'bad' as unknown as string[]))).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves a row before another, or last, and leaves it be when dropped on itself', () => {
    expect(moveBefore(items, null, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveBefore(items, null, 'a', undefined)).toEqual(['b', 'c', 'd', 'a'])
    expect(moveBefore(items, ['b', 'a'], 'c', 'c')).toEqual(['b', 'a', 'c', 'd'])
  })

  it('steps a row up or down, and not past either end', () => {
    expect(nudge(items, null, 'c', -1)).toEqual(['a', 'c', 'b', 'd'])
    expect(nudge(items, null, 'c', 1)).toEqual(['a', 'b', 'd', 'c'])
    expect(nudge(items, null, 'a', -1)).toEqual(['a', 'b', 'c', 'd'])
    expect(nudge(items, null, 'd', 1)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('steps over the rows that are not shown next to it (hidden, another sector), which keep their places', () => {
    const near = (id: string): boolean => id !== 'b' // b is hidden
    expect(nudge(items, null, 'c', -1, near)).toEqual(['c', 'a', 'b', 'd'])
    expect(nudge(items, null, 'a', 1, near)).toEqual(['b', 'c', 'a', 'd'])
    expect(nudge(items, null, 'c', 1, near)).toEqual(['a', 'b', 'd', 'c'])
    expect(nudge(items, null, 'd', 1, near)).toEqual(['a', 'b', 'c', 'd'])
  })
})
