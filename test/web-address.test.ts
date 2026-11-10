import { describe, expect, it } from 'vitest'
import { hashToView, viewToHash } from '../src/renderer/src/address'
import type { View } from '../src/renderer/src/store'

describe('the screen in a browser page address', () => {
  const back: View[] = [
    { kind: 'conversation', id: 'c-1' },
    { kind: 'agent', id: 'ag 2/x' },
    { kind: 'new-agent' },
    { kind: 'settings' },
    { kind: 'approvals' },
    { kind: 'missions' },
    { kind: 'wiki' },
    { kind: 'wiki', tab: 'sources' },
    { kind: 'wiki', title: 'Plano de ação/2026' },
    { kind: 'wiki', source: 'fontes/relatório.pdf' }
  ]
  it.each(back)('comes back from a reload: %o', (view) => {
    expect(hashToView(viewToHash(view)!)).toEqual(view)
  })

  it('keeps out what only this page holds', () => {
    expect(viewToHash({ kind: 'tuca' })).toBeUndefined()
    expect(viewToHash({ kind: 'conversation', id: 'c', message: 'm' })).toBe('#/c/c')
    expect(hashToView(viewToHash({ kind: 'new-agent', fromMessage: 'm' })!)).toEqual({ kind: 'new-agent' })
  })

  it('ignores hashes that are not a screen', () => {
    for (const h of ['', '#', '#wiki/Page', '#abrir/conectores', '#/nope', '#/c', '#/settings/x', '#/c/%E0%A4%A']) expect(hashToView(h)).toBeUndefined()
    expect(hashToView('#/wiki/tab/bogus')).toEqual({ kind: 'wiki' })
  })
})
