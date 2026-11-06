import { describe, expect, it } from 'vitest'
import { chirpOf } from '../src/shared/types'

describe('the toucan’s chirp', () => {
  it('knocks when an agent needs me and plays two notes when the work is done', () => {
    expect(chirpOf('approval', undefined)).toBe('chama')
    expect(chirpOf('question', true)).toBe('chama')
    expect(chirpOf('done', true)).toBe('pronto')
    expect(chirpOf(undefined, undefined)).toBe('pronto')
  })

  it('stays quiet when the sounds are off', () => {
    for (const kind of ['approval', 'question', 'done', undefined] as const) expect(chirpOf(kind, false)).toBeNull()
  })
})
