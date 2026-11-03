import { describe, expect, it } from 'vitest'
import { examples } from 'open-bot-avatar'
import { cleanLook } from '../src/core/agent-look'
import gallery from '../src/renderer/src/assets/bot-avatars.json'

describe('an agent’s color, picture and drawn avatar', () => {
  it('keeps a color and a small picture', () => {
    const look = { customColor: '#FF00aa', picture: 'data:image/jpeg;base64,AAAA' }
    expect(cleanLook(look)).toEqual(look)
  })
  it('drops anything else', () => {
    for (const customColor of ['red', '#fff', '#ff00aa;background:url(x)']) expect(cleanLook({ customColor }).customColor).toBeUndefined()
    for (const picture of ['https://x.com/a.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AA"><script>', `data:image/png;base64,${'A'.repeat(200_001)}`]) expect(cleanLook({ picture }).picture).toBeUndefined()
  })
  it('keeps a drawn avatar that passes its own check (with its path tidied), and drops one that doesn’t', () => {
    for (const avatar of [...examples, ...gallery]) expect(cleanLook({ avatar: avatar as never }).avatar).toMatchObject({ id: avatar.id, eyes: avatar.eyes })
    const cat = gallery[0]!
    for (const avatar of [{ ...cat, body: { path: '<script>' } }, { ...cat, extra: 1 }, { ...cat, version: 2 }, 'cat']) expect(cleanLook({ avatar: avatar as never }).avatar).toBeUndefined()
  })
})
