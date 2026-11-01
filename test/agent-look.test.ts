import { describe, expect, it } from 'vitest'
import { cleanLook } from '../src/core/agent-look'

describe('an agent’s color and picture', () => {
  it('keeps a color and a small picture', () => {
    const look = { customColor: '#FF00aa', avatar: 'data:image/jpeg;base64,AAAA' }
    expect(cleanLook(look)).toEqual(look)
  })
  it('drops anything else', () => {
    for (const customColor of ['red', '#fff', '#ff00aa;background:url(x)']) expect(cleanLook({ customColor }).customColor).toBeUndefined()
    for (const avatar of ['https://x.com/a.png', 'data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AA"><script>', `data:image/png;base64,${'A'.repeat(200_001)}`]) expect(cleanLook({ avatar }).avatar).toBeUndefined()
  })
})
