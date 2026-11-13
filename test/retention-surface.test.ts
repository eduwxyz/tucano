import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import type { Agent } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

let owner: Client
let member: Client
let db: Db

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  handle: id,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'high',
  limit: 0,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false,
  ...extra
})

beforeAll(async () => {
  const core = await bootCore({ server: true })
  owner = core.connect()
  db = new Db(join(core.dataDir, 'tucano.db'))
  db.addPerson({ id: 'member', name: 'Pessoa', role: 'member', about: '' })
  member = core.connect('member')
}, 30_000)

describe('a period and a wipe, through the API a page uses', () => {
  it('keeps the period in the settings, and refuses one that is not a number of days', async () => {
    await owner.call('updateSettings', { patch: { retentionDays: 30 } })
    expect(db.getSettings({} as never).retentionDays).toBe(30)
    await owner.call('updateSettings', { patch: { retentionDays: 0 } })
    expect(db.getSettings({} as never).retentionDays).toBe(0)
    await expect(owner.call('updateSettings', { patch: { retentionDays: -3 } })).rejects.toThrow()
    await expect(owner.call('updateSettings', { patch: { retentionDays: '30' } })).rejects.toThrow()
    await owner.call('updateSettings', { patch: { retentionDays: null } })
    expect(db.getSettings({} as never).retentionDays ?? 0).toBe(0)
    // Only an admin changes it: it decides for everyone's conversations.
    await expect(member.call('updateSettings', { patch: { retentionDays: 7 } })).rejects.toThrow()
  })

  it("keeps a bot's own period on its page, and follows the Tucano again when it's left out", async () => {
    await owner.call('saveAgent', { agent: agent('kept', { retentionDays: 0 }), channelIds: [] })
    expect(db.agent('kept')?.retentionDays).toBe(0)
    await owner.call('saveAgent', { agent: agent('kept', { retentionDays: 12 }), channelIds: [] })
    expect(db.agent('kept')?.retentionDays).toBe(12)
    await owner.call('saveAgent', { agent: agent('kept'), channelIds: [] })
    expect(db.agent('kept')?.retentionDays).toBeUndefined()
  })

  it("wipes one bot's history and tells the screens which conversations to read again", async () => {
    db.saveAgent(agent('wiped'))
    db.saveAgent(agent('other'))
    db.createConversation({ id: 'dm-wiped', kind: 'dm', name: 'wiped', members: ['wiped'], owner: db.ownerId() })
    db.createConversation({ id: 'room', kind: 'channel', name: 'room', members: ['wiped', 'other'] })
    db.saveMessage({ id: 'its-reply', conversationId: 'room', author: { kind: 'agent', id: 'wiped' }, text: 'segredo', at: Date.now() })
    db.saveMessage({ id: 'in-its-dm', conversationId: 'dm-wiped', author: { kind: 'person', id: db.ownerId() }, text: 'segredo', at: Date.now() })
    db.saveMessage({ id: 'mine', conversationId: 'room', author: { kind: 'person', id: db.ownerId() }, text: 'meu', at: Date.now() })
    owner.events.length = 0

    expect(await owner.call('wipeHistory', { agentId: 'wiped' })).toBe(2)
    expect(db.message('its-reply')).toBeUndefined()
    expect(db.message('in-its-dm')).toBeUndefined()
    expect(db.message('mine')).toBeTruthy()
    const heard = owner.events.filter((e) => e.type === 'history_wiped')
    expect(heard).toHaveLength(1)
    expect(heard[0]).toMatchObject({ type: 'history_wiped', conversationIds: expect.arrayContaining(['dm-wiped', 'room']) })

    await expect(owner.call('wipeHistory', { agentId: 'no-such-bot' })).rejects.toThrow()
  })

  it('wipes every history at once, and leaves the rooms, the agents and the receipts', async () => {
    db.saveAgent(agent('w1'))
    db.createConversation({ id: 'all-dm', kind: 'dm', name: 'w1', members: ['w1'], owner: db.ownerId() })
    db.saveMessage({ id: 'one', conversationId: 'all-dm', author: { kind: 'agent', id: 'w1' }, text: 'a', at: Date.now() })
    db.saveMessage({ id: 'two', conversationId: 'all-dm', author: { kind: 'person', id: db.ownerId() }, text: 'b', at: Date.now() })
    db.addReceipt({ messageId: 'one', agentId: 'w1', engine: 'claude', model: 'sonnet', inputTokens: 7, cacheReadTokens: 0, outputTokens: 3, ms: 100, at: Date.now() })
    const totals = db.receiptTotals('one').tokens

    expect(await owner.call('wipeHistory', {})).toBeGreaterThanOrEqual(2)
    expect(db.message('one')).toBeUndefined()
    expect(db.message('two')).toBeUndefined()
    expect(db.conversation('all-dm')).toBeTruthy()
    expect(db.agent('w1')).toBeTruthy()
    expect(db.receiptTotals('one').tokens).toBe(totals)
  })

  it('is an admin’s: a member does not wipe anyone’s history', async () => {
    db.saveAgent(agent('safe'))
    db.saveMessage({ id: 'keep-me', conversationId: 'room', author: { kind: 'agent', id: 'safe' }, text: 'x', at: Date.now() })
    await expect(member.call('wipeHistory', { agentId: 'safe' })).rejects.toThrow()
    await expect(member.call('wipeHistory', {})).rejects.toThrow()
    expect(db.message('keep-me')).toBeTruthy()
  })
})
