import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { vault } from '../src/server/vault'

describe('the server vault', () => {
  it('opens what it sealed, and nothing sealed with another key', () => {
    const v = vault(randomBytes(32))
    const sealed = v.seal('bot-token:123 ção')
    expect(sealed).not.toContain('bot-token')
    expect(v.open(sealed)).toBe('bot-token:123 ção')
    expect(() => vault(randomBytes(32)).open(sealed)).toThrow()
  })

  it('refuses a tampered secret and a key of the wrong size', () => {
    const v = vault(randomBytes(32))
    const b = Buffer.from(v.seal('x'), 'base64')
    b[b.length - 1]! ^= 1
    expect(() => v.open(b.toString('base64'))).toThrow()
    expect(() => vault(randomBytes(16))).toThrow()
  })
})
