import { describe, expect, it } from 'vitest'
import { Followups, replyKey } from '../src/core/followups'

describe('Followups', () => {
  it('keys by agent, conversation and thread', () => {
    expect(replyKey('a', 'c', 't')).toBe('a:c:t')
    expect(replyKey('a', 'c')).toBe('a:c:')
  })

  it('is busy while a reply runs or is reserved', () => {
    const f = new Followups()
    expect(f.busy('k')).toBe(false)
    f.reserve('k')
    expect(f.busy('k')).toBe(true)
    f.start('k', true) // the reservation becomes the running reply
    expect(f.busy('k')).toBe(true)
    f.end('k')
    expect(f.busy('k')).toBe(false)
    f.start('k')
    f.start('k')
    f.end('k')
    expect(f.busy('k')).toBe(true)
    f.end('k')
    expect(f.busy('k')).toBe(false)
  })

  it('keeps the deepest depth and the latest work of what was noted', () => {
    const f = new Followups()
    f.start('k')
    f.add('k', { depth: 3, work: 'A-1' })
    f.add('k', { depth: 2, work: 'A-2' })
    f.add('k', { depth: 2 })
    f.end('k')
    expect(f.take('k')).toEqual({ depth: 3, work: 'A-2' })
  })

  it('hands the follow-up over only once the agent is free, and only once', () => {
    const f = new Followups()
    f.start('k')
    f.start('k')
    f.add('k', { depth: 2 })
    f.end('k')
    expect(f.take('k')).toBeUndefined()
    f.end('k')
    f.reserve('k')
    expect(f.take('k')).toBeUndefined()
    f.start('k', true)
    f.end('k')
    expect(f.take('k')).toEqual({ depth: 2, work: undefined })
    expect(f.take('k')).toBeUndefined()
  })

  it('forgets a key once nothing is left on it', () => {
    const f = new Followups()
    f.start('k')
    f.add('k', { depth: 2 })
    f.end('k')
    f.take('k')
    expect((f as unknown as { slots: Map<string, unknown> }).slots.size).toBe(0)
  })
})
