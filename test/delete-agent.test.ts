import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import type { Agent, Message } from '../src/shared/types'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id.toUpperCase(), handle: id, role: '', color: 'sky', instructions: 'do things', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: { k: 'read' }, memory: 'auto', computer: false, archived: false, ...extra })
const msg = (id: string, conversationId: string, author: string): Message => ({ id, conversationId, author: { kind: 'agent', id: author }, text: id, at: 1 })

function seeded(): Db {
  const db = new Db(':memory:')
  db.saveAgent(agent('ana', { archived: true }))
  db.saveAgent(agent('bia', { reportsTo: 'ana' }))
  db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['ana', 'bia'] })
  db.createConversation({ id: 'd1', kind: 'dm', name: 'ana', members: ['ana'] })
  db.saveMessage(msg('m1', 'c1', 'ana'))
  db.saveMessage(msg('m2', 'd1', 'ana'))
  return db
}

describe('an agent deleted for good', () => {
  it('stays as a tombstone: its name and look for the messages it wrote, and nothing else', () => {
    const db = seeded()
    db.retireAgent('ana')
    const a = db.agent('ana')!
    expect(a).toMatchObject({ name: 'ANA', color: 'sky', deleted: true, archived: true, instructions: '', grants: {} })
    expect(a.handle).not.toBe('ana') // the handle is free for a new agent
    expect(db.message('m1')?.author).toEqual({ kind: 'agent', id: 'ana' })
    expect(db.message('m2')).toBeDefined() // the DM's history stays readable
  })

  it('leaves its channels, and whoever reported to it reports to no one', () => {
    const db = seeded()
    db.retireAgent('ana')
    expect(db.conversation('c1')?.members).toEqual(['bia'])
    expect(db.conversation('d1')?.members).toEqual(['ana']) // its DM still reads as the one with it
    expect(db.agent('bia')?.reportsTo).toBeUndefined()
  })

  it('frees its handle for a new agent', () => {
    const db = seeded()
    db.retireAgent('ana')
    expect(() => db.saveAgent(agent('ana2', { handle: 'ana' }))).not.toThrow()
  })

  it('drops its own memories, routines and services', () => {
    const db = seeded()
    db.saveMemory({ id: 'mem1', scope: 'ana', text: 'x', state: 'active', origin: 'agent', agentId: 'ana', messageIds: [], createdAt: 1, confirmedAt: 1 })
    db.saveService('ana', { name: 'web', command: 'npm start', port: 3000, startedAt: 1 })
    db.retireAgent('ana')
    expect(db.memories({ scope: 'ana' })).toEqual([])
    expect(db.services('ana')).toEqual([])
  })

  it('is taken off the Cofre’s keys it was given; the keys stay for the others', () => {
    const db = seeded()
    const key = (id: string, agents: string[]) => ({ id, name: id.toUpperCase(), agents, approve: false, hint: '••••', createdAt: 1, updatedAt: 1 })
    db.saveVaultKey(key('k1', ['ana', 'bia']))
    db.saveVaultKey(key('k2', ['ana']))
    db.saveVaultKey(key('k3', ['bia']))
    db.retireAgent('ana')
    expect(Object.fromEntries(db.vaultKeys().map((k) => [k.id, k.agents]))).toEqual({ k1: ['bia'], k2: [], k3: ['bia'] })
    db.saveVaultLogin({ id: 'l1', origin: 'https://a.com', username: 'u', agents: ['bia'], createdAt: 1, updatedAt: 1 })
    db.saveVaultLogin({ id: 'l2', origin: 'https://b.com', username: 'u', agents: ['bia', 'ana'], createdAt: 1, updatedAt: 1 })
    db.retireAgent('bia')
    expect(Object.fromEntries(db.vaultLogins().map((l) => [l.id, l.agents]))).toEqual({ l1: [], l2: ['ana'] })
  })

  it('an agent not deleted reads as before', () => {
    const db = seeded()
    expect(db.agent('bia')?.deleted).toBeUndefined()
  })
})
