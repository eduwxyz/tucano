import { describe, expect, it, vi } from 'vitest'
import { SessionDrafts } from '../src/main/session-drafts'
import { ComposerDrafts } from '../src/renderer/src/drafts'
import type { ComposerDraft, DraftEntries } from '../src/shared/drafts'

const entries = (text: string): DraftEntries => [['conversation', { text, images: [{ name: 'photo.png', mime: 'image/png', data: 'aGVsbG8=' }] }]]

describe('session-only environment draft storage', () => {
  it('isolates profile and server identity and keeps captured old-page scope on save', () => {
    const store = new SessionDrafts()
    const local = store.open(null), a = store.open('personal', 'server-a'), b = store.open('work', 'server-b')
    expect(store.save(local.session, entries('Local'))).toBe('saved')
    expect(store.save(a.session, entries('Personal'))).toBe('saved')
    expect(store.save(b.session, entries('Work'))).toBe('saved')
    expect(store.open(null).entries).toEqual(entries('Local'))
    expect(store.open('personal', 'server-a').entries).toEqual(entries('Personal'))
    expect(store.open('work', 'server-b').entries).toEqual(entries('Work'))
    expect(store.open('work', 'different-server').entries).toEqual([])
    expect(store.open('different-profile', 'server-a').entries).toEqual([])
    expect(new SessionDrafts().open(null).entries).toEqual([])
  })
  it('keeps the last valid draft on invalid, oversized or unknown-session checkpoints', () => {
    const store = new SessionDrafts(), opened = store.open('personal', 'server-a')
    expect(store.save(opened.session, entries('Keep me'))).toBe('saved')
    for (const bad of [null, {}, [['conversation', { text: 'x'.repeat(1_000_001), images: [] }]],
      [['conversation', { text: '', images: [{ name: 'x', mime: 'image/png', data: 'not base64!' }] }]],
      [...entries('One'), ...entries('Duplicate')]]) expect(store.save(opened.session, bad)).toBe('invalid')
    expect(store.save('unissued-session', entries('Wrong'))).toBe('invalid')
    expect(store.open('personal', 'server-a').entries).toEqual(entries('Keep me'))
  })
  it('strips preview URLs, revokes superseded pages and prevents forgotten draft resurrection', () => {
    const store = new SessionDrafts(), old = store.open('personal', 'server-a')
    const data = entries('Saved')
    Object.assign(data[0]![1].images[0]!, { url: 'untrusted-preview', extra: 'not-kept' })
    store.save(old.session, data)
    const current = store.open('personal', 'server-a')
    expect(current.entries).toEqual(entries('Saved'))
    expect(store.save(old.session, entries('Stale'))).toBe('forgotten')
    store.forget('personal')
    expect(store.save(current.session, entries('Late unload'))).toBe('forgotten')
    expect(store.open('personal', 'server-a').entries).toEqual([])
  })
})

describe('composer checkpoint integration', () => {
  it('captures the live composer on reload, including text and prepared attachments', () => {
    let checkpoint!: () => DraftEntries
    const store = new ComposerDrafts({ read: () => entries('Earlier channel'), onCheckpoint: (read) => { checkpoint = read; return () => {} } })
    let current: ComposerDraft = { text: 'Currently typing', images: entries('')[0]![1].images }
    const leave = store.activate('current', () => current)
    const saved = checkpoint()
    expect(saved).toEqual([...entries('Earlier channel'), ['current', current]])
    const reloaded = new ComposerDrafts({ read: () => saved, onCheckpoint: () => () => {} })
    expect(reloaded.get('current')).toEqual(current)
    current = { text: '', images: [] }; leave()
    expect(checkpoint()).toEqual(entries('Earlier channel'))
  })
  it('does not silently drop images that are still being prepared', () => {
    const store = new ComposerDrafts(), finish = store.preparingAttachment('conversation')
    store.activate('conversation', () => ({ text: 'Draft', images: [] }))
    expect(() => store.checkpoint()).toThrow('Images are still being prepared')
    finish()
    expect(store.checkpoint()).toEqual([['conversation', { text: 'Draft', images: [] }]])
  })
  it('finishes an image in its original conversation after navigation, before unblocking checkpoints', () => {
    const store = new ComposerDrafts()
    const image = entries('')[0]![1].images[0]!
    const leaveA = store.activate('a', () => ({ text: 'Personal draft', images: [] }))
    const finish = store.preparingAttachment('a')
    leaveA()
    const writeB = vi.fn()
    store.activate('b', () => ({ text: 'Work draft', images: [] }), writeB)
    expect(() => store.checkpoint()).toThrow('Images are still being prepared')
    store.appendImages('a', [image])
    expect(writeB).not.toHaveBeenCalled()
    expect(store.get('a')).toEqual({ text: 'Personal draft', images: [image] })
    expect(() => store.checkpoint()).toThrow('Images are still being prepared')
    finish()
    expect(store.checkpoint()).toEqual([['a', { text: 'Personal draft', images: [image] }], ['b', { text: 'Work draft', images: [] }]])
  })
  it('updates a reopened original composer and includes the image in a same-tick checkpoint', () => {
    const store = new ComposerDrafts(), image = entries('')[0]![1].images[0]!
    let draft: ComposerDraft = { text: 'First visit', images: [] }
    const leave = store.activate('a', () => draft)
    const finish = store.preparingAttachment('a')
    leave()
    draft = { text: 'Edited after returning to A', images: [] }
    store.activate('a', () => draft, (next) => { draft = next })
    store.appendImages('a', [image]); finish()
    expect(store.checkpoint()).toEqual([['a', { text: 'Edited after returning to A', images: [image] }]])
    expect(store.preparingState('a')).toBe(0)
  })
  it('preserves whitespace-only drafts and removes sent or explicitly cleared drafts', () => {
    const store = new ComposerDrafts()
    let draft = { text: '  ', images: [] }
    store.activate('conversation', () => draft)
    expect(store.checkpoint()).toEqual([['conversation', draft]])
    draft = { text: '', images: [] }; store.delete('conversation')
    expect(store.checkpoint()).toEqual([])
  })
  it('retains text and attachments after a rejected send without automatically retrying', async () => {
    const store = new ComposerDrafts(), draft = entries('Keep everything')[0]![1]
    store.activate('conversation', () => draft)
    const action = vi.fn(async () => { throw new Error('Server disconnected secret=do-not-echo') })
    await store.send('conversation', draft, action)
    expect(store.sendState('conversation')).toEqual({ pending: false, revision: 0, error: true })
    expect(store.get('conversation')).toEqual(draft)
    expect(store.checkpoint()).toEqual([['conversation', draft]])
    expect(action).toHaveBeenCalledOnce()
    expect(JSON.stringify(store.sendState('conversation'))).not.toContain('secret')
  })
  it('blocks switching and repeated sends until acknowledgment, including after leaving the channel', async () => {
    const store = new ComposerDrafts(), draft = entries('Await acknowledgment')[0]![1]
    let resolve!: () => void
    const action = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const leave = store.activate('conversation', () => draft)
    const pending = store.send('conversation', draft, action)
    expect(store.sendState('conversation').pending).toBe(true)
    expect(() => store.checkpoint()).toThrow('A message is still being sent')
    leave()
    await store.send('conversation', draft, action)
    expect(action).toHaveBeenCalledOnce()
    resolve(); await pending
    expect(store.sendState('conversation')).toEqual({ pending: false, revision: 1, error: false })
    expect(store.get('conversation')).toBeUndefined()
    expect(store.checkpoint()).toEqual([])
  })
})
