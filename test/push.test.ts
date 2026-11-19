import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Push, pushUrl, type PushTarget } from '../src/core/push'

describe('push targets on device keys', () => {
  it('keeps a handle per device, for the people asked, and forgets it with the device', () => {
    const db = new Db(':memory:')
    const owner = db.ownerId()
    db.addPersonKey('phone', owner, 'iPhone')
    db.addPersonKey('laptop', owner, 'Chrome')
    expect(db.setKeyPush(owner, 'phone', { handle: 'h1', tag: 'srv' })).toBe(true)
    expect(db.setKeyPush('someone-else', 'laptop', { handle: 'x' })).toBe(false)
    expect(db.pushTargets()).toEqual([{ hash: 'phone', personId: owner, handle: 'h1', tag: 'srv' }])
    expect(db.pushTargets([owner])).toHaveLength(1)
    expect(db.pushTargets(['nobody'])).toEqual([])
    db.dropKeyPush('phone')
    expect(db.pushTargets()).toEqual([])
    db.setKeyPush(owner, 'phone', { handle: 'h2' })
    db.removePersonKey(owner, 'phone')
    expect(db.pushTargets()).toEqual([])
  })
})

describe('Push', () => {
  const targets: PushTarget[] = [{ hash: 'a', handle: 'ha', tag: 't1' }, { hash: 'b', handle: 'hb' }]

  it('posts the note with each phone, and forgets the ones Apple dropped', async () => {
    const calls: { url: string; body: unknown }[] = []
    const gone: string[] = []
    const push = new Push({
      url: 'https://relay.example/api/push',
      targets: (to) => (to?.includes('ana') ? targets : []),
      gone: (h) => void gone.push(h),
      fetch: (async (url: string, init: RequestInit) => (calls.push({ url, body: JSON.parse(String(init.body)) }), Response.json({ sent: 1, gone: ['hb'] }))) as typeof fetch
    })
    await push.send({ title: 'Ana', body: 'Posso enviar?', conversationId: 'c1', kind: 'approval' }, ['ana'])
    expect(calls).toEqual([{ url: 'https://relay.example/api/push/send', body: { title: 'Ana', body: 'Posso enviar?', conversationId: 'c1', kind: 'approval', targets: [{ handle: 'ha', tag: 't1' }, { handle: 'hb' }] } }])
    expect(gone).toEqual(['b'])
    await push.send({ title: 'x', body: 'y' }, ['bob'])
    expect(calls).toHaveLength(1) // no phones: nothing sent
  })

  it('off sends nothing, and a relay that fails is only logged', async () => {
    let called = false
    const off = new Push({ url: undefined, targets: () => targets, gone: () => {}, fetch: (async () => ((called = true), new Response())) as unknown as typeof fetch })
    await off.send({ title: 'x', body: 'y' }, undefined)
    expect(called).toBe(false)
    const down = new Push({ url: 'https://r', targets: () => targets, gone: () => {}, fetch: (async () => { throw new Error('down') }) as typeof fetch })
    await expect(down.send({ title: 'x', body: 'y' }, undefined)).resolves.toBeUndefined()
  })

  it('reads the relay from the environment', () => {
    expect(pushUrl({})).toBe('https://tucano.sh/api/push')
    expect(pushUrl({ TUCANO_PUSH_URL: 'https://mine.example/push/' })).toBe('https://mine.example/push')
    expect(pushUrl({ TUCANO_PUSH_URL: 'off' })).toBeUndefined()
  })
})
