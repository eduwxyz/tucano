import { describe, expect, it } from 'vitest'
import { isOpRef, opMessage, resolveOpRefs } from '../src/core/onepassword'

describe('1Password references', () => {
  it('tells a reference from a value', () => {
    expect(isOpRef('op://Dev/GitHub/token')).toBe(true)
    expect(isOpRef(' op://Dev/AWS Keys/secret ')).toBe(true)
    expect(isOpRef('op://Dev/GitHub/section/token')).toBe(true)
    expect(isOpRef('op://Dev')).toBe(false)
    expect(isOpRef('github_pat_op://x/y/z')).toBe(false)
    expect(isOpRef(undefined)).toBe(false)
  })

  it('reads the references and leaves the other values as they are', async () => {
    const env = await resolveOpRefs({ AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: 'op://Dev/AWS/secret' }, async (ref) => `<${ref}>`)
    expect(env).toEqual({ AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: '<op://Dev/AWS/secret>' })
  })

  it('says what to do when op fails', () => {
    expect(opMessage({ code: 'ENOENT' }, '', 'op://a/b/c')).toMatch(/1Password CLI|op\)/)
    expect(opMessage({ killed: true }, '', 'op://a/b/c')).toMatch(/desbloqueado|unlocked/)
    expect(opMessage({ code: 1 }, '[ERROR] 2026/11/05 10:00:00 "GitHub" isn\'t an item in the "Dev" vault.', 'op://Dev/GitHub/token')).toMatch(/op:\/\/Dev\/GitHub\/token/)
    expect(opMessage({ code: 1 }, '[ERROR] 2026/11/05 10:00:00 You are not currently signed in.', 'op://a/b/c')).toMatch(/op signin/)
  })
})
