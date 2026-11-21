import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { bootCore, type Client } from './helpers/core'

let owner: Client
let member: Client
let db: Db

beforeAll(async () => {
  const core = await bootCore({ server: true })
  owner = core.connect()
  db = new Db(join(core.dataDir, 'tucano.db'))
  db.addPerson({ id: 'member', name: 'Pessoa', role: 'member', about: '' })
  member = core.connect('member')
}, 30_000)

describe('the file, through the API a page uses', () => {
  it('says its size and that it reads back sound', async () => {
    const health = (await owner.call('dbHealth')) as { bytes: number; free: number; sound: boolean; said: string }
    expect(health.bytes).toBeGreaterThan(0)
    expect(health.free).toBeGreaterThanOrEqual(0)
    expect(health.sound).toBe(true)
    expect(health.said).toBe('ok')
  })

  it('rebuilds it on a press, and says what went', async () => {
    // Some history, then the room it was in: the pages are free and the file keeps them.
    db.createConversation({ id: 'room', kind: 'channel', name: 'room', members: [] })
    for (let i = 0; i < 30; i++) db.saveMessage({ id: `m${i}`, conversationId: 'room', author: { kind: 'person', id: db.ownerId() }, text: `${i} `.padEnd(60_000, 'z'), at: Date.now() - i })
    db.deleteConversation('room')
    const before = (await owner.call('dbHealth')) as { bytes: number; free: number }
    expect(before.free).toBeGreaterThan(1_000_000)

    const done = (await owner.call('optimizeDb')) as { before: number; after: number; free: number; sound: boolean; said: string }
    expect(done.after).toBeLessThan(before.bytes)
    expect(done.free).toBe(0)
    expect(done.sound).toBe(true)
    // The file as it is now agrees with what the call answered.
    expect(((await owner.call('dbHealth')) as { bytes: number }).bytes).toBe(done.after)
  })

  it('waits for the reply that is writing', async () => {
    db.createConversation({ id: 'busy', kind: 'channel', name: 'busy', members: [] })
    db.saveMessage({ id: 'writing', conversationId: 'busy', author: { kind: 'agent', id: db.agents()[0]!.id }, text: 'working on it', at: Date.now(), run: { status: 'working', steps: [] } })
    await expect(owner.call('optimizeDb')).rejects.toThrow(/at work|trabalhando/)
    // And it is free to run the moment nothing is.
    db.saveMessage({ id: 'writing', conversationId: 'busy', author: { kind: 'agent', id: db.agents()[0]!.id }, text: 'done', at: Date.now(), run: { status: 'done', steps: [] } })
    await expect(owner.call('optimizeDb')).resolves.toMatchObject({ sound: true })
  })

  it('leaves the activity log saying what it did', async () => {
    const kinds = db.activity({ limit: 20 }).map((a) => a.kind)
    expect(kinds).toContain('db.optimized')
  })

  it('is an admin’s, both the numbers and the press', async () => {
    await expect(member.call('dbHealth')).rejects.toThrow()
    await expect(member.call('optimizeDb')).rejects.toThrow()
  })
})
