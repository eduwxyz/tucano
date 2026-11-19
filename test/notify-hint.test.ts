import { describe, expect, it } from 'vitest'
import { notifyHint } from '../src/renderer/src/components/Pages'

describe('Settings › General › Notifications', () => {
  it('says a browser shows none without HTTPS, and where to be told instead', () => {
    const hint = notifyHint('insecure', true)!
    expect(hint).toMatch(/HTTPS/)
    expect(hint).toMatch(/Telegram/)
    expect(hint).toMatch(/iPhone/)
  })

  it('points a Mac to its notification settings and Focus when one was sent', () => {
    expect(notifyHint('shown', true)).toMatch(/Notifica(ções|tions) › Tucano/)
    expect(notifyHint('shown', true)).toMatch(/Foco|Focus/)
    expect(notifyHint('blocked', false)).toMatch(/Telegram/)
    expect(notifyHint('on', true)).toBeNull()
    expect(notifyHint('ask', false)).toBeNull()
  })
})
