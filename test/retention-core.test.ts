import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Retention } from '../src/core/retention'
import type { Agent, Settings } from '../src/shared/types'

const DAY = 86_400_000
const NOW = 1_800_000_000_000

// A workspace with a database of its own, a clock the test moves, and the hooks a sweep runs written down
// instead of done: what a reply cost, and what the person's screens are told.
function world(first: Partial<Settings> = {}) {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'tucano-retention-')), 'tucano.db'))
  const settings = { ...first } as Omit<Settings, 'engines'>
  const calls = { stopped: [] as string[], forgotten: [] as { agentId?: string; conversationId?: string }[], cleared: [] as string[][] }
  let clock = NOW
  const retention = new Retention(
    db,
    () => settings,
    {
      deleted: (ids) => calls.stopped.push(...ids),
      forgetSessions: (of) => calls.forgotten.push(of),
      cleared: (ids) => calls.cleared.push(ids)
    },
    () => clock
  )
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
  const owner = db.ownerId()
  const said = (id: string, conversationId: string, at: number, who: 'me' | string = 'me', extra: Record<string, unknown> = {}): void =>
    db.saveMessage({ id, conversationId, author: who === 'me' ? { kind: 'person', id: owner } : { kind: 'agent', id: who }, text: id, at, ...extra })
  return { db, settings, set: (patch: Partial<Settings>) => Object.assign(settings, patch), retention, calls, agent, said, tick: (ms: number) => (clock += ms), now: () => clock }
}

describe('a period no longer keeping what was said', () => {
  it('leaves everything alone at zero, however old it is', () => {
    const w = world({ retentionDays: 0 })
    w.db.saveAgent(w.agent('a1'))
    w.db.createConversation({ id: 'dm', kind: 'dm', name: 'a1', members: ['a1'], owner: w.db.ownerId() })
    w.said('ancient', 'dm', NOW - 400 * DAY, 'a1')
    expect(w.retention.sweep()).toBe(0)
    expect(w.db.message('ancient')).toBeTruthy()
  })

  it('takes what is past the period, once a day, and keeps the receipts', () => {
    const w = world({ retentionDays: 30 })
    w.db.saveAgent(w.agent('a1'))
    w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1'] })
    w.said('old-prompt', 'ch', NOW - 40 * DAY)
    w.said('old-reply', 'ch', NOW - 31 * DAY, 'a1')
    w.said('new-prompt', 'ch', NOW - 2 * DAY)
    w.db.addReceipt({ messageId: 'old-reply', agentId: 'a1', engine: 'claude', model: 'sonnet', inputTokens: 10, cacheReadTokens: 0, outputTokens: 5, ms: 900, at: NOW - 31 * DAY })

    expect(w.retention.due()).toBe(true)
    expect(w.retention.sweep()).toBe(2)
    expect(w.db.message('old-prompt')).toBeUndefined()
    expect(w.db.message('old-reply')).toBeUndefined()
    expect(w.db.message('new-prompt')).toBeTruthy()
    // What the reply spent is what Usage and the monthly limit count: it stays.
    expect(w.db.receiptTotals('old-reply').tokens).toBe(15)
    expect(w.calls.cleared).toEqual([['ch']])
    expect(w.calls.forgotten).toEqual([{ conversationId: 'ch' }])
    // Once for the day, and due again only after another one.
    expect(w.retention.due()).toBe(false)
    expect(w.retention.sweep()).toBe(0)
    w.tick(DAY)
    expect(w.retention.due()).toBe(true)
  })

  it('takes a thread whole when the message that started it goes', () => {
    const w = world({ retentionDays: 30 })
    w.db.saveAgent(w.agent('a1'))
    w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1'], threads: true })
    w.said('root', 'ch', NOW - 40 * DAY)
    w.said('reply-inside', 'ch', NOW - 39 * DAY, 'a1', { threadId: 'root' })
    expect(w.retention.sweep()).toBe(2)
    expect(w.db.message('root')).toBeUndefined()
    expect(w.db.message('reply-inside')).toBeUndefined()
  })

  it('leaves a reply at work alone: its run would write into a row that is gone', () => {
    const w = world({ retentionDays: 30 })
    w.db.saveAgent(w.agent('a1'))
    w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1'] })
    w.said('stuck', 'ch', NOW - 90 * DAY, 'a1', { run: { status: 'working', steps: [] } })
    expect(w.retention.sweep()).toBe(0)
    expect(w.db.message('stuck')).toBeTruthy()
  })

  it('a bot that keeps everything keeps its own words and its own DMs, whatever the Tucano says', () => {
    const w = world({ retentionDays: 30 })
    w.db.saveAgent(w.agent('keeper', { retentionDays: 0 }))
    w.db.saveAgent(w.agent('ordinary'))
    w.db.createConversation({ id: 'dm-keeper', kind: 'dm', name: 'keeper', members: ['keeper'], owner: w.db.ownerId() })
    w.db.createConversation({ id: 'dm-ordinary', kind: 'dm', name: 'ordinary', members: ['ordinary'], owner: w.db.ownerId() })
    w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['keeper', 'ordinary'] })

    w.said('keeper-dm-old', 'dm-keeper', NOW - 60 * DAY, 'keeper')
    w.said('my-prompt-in-their-dm', 'dm-keeper', NOW - 60 * DAY)
    w.said('keeper-in-a-channel', 'ch', NOW - 60 * DAY, 'keeper')
    w.said('ordinary-dm-old', 'dm-ordinary', NOW - 60 * DAY, 'ordinary')
    w.said('my-prompt-elsewhere', 'ch', NOW - 60 * DAY)

    expect(w.retention.sweep()).toBe(2)
    // Everything of the keeper's is still there, including the words in its own DM.
    for (const id of ['keeper-dm-old', 'my-prompt-in-their-dm', 'keeper-in-a-channel']) expect(w.db.message(id)).toBeTruthy()
    // The ordinary bot's DM and the prompt in the channel are not.
    expect(w.db.message('ordinary-dm-old')).toBeUndefined()
    expect(w.db.message('my-prompt-elsewhere')).toBeUndefined()
  })

  it('a bot with a shorter period than the Tucano takes its own sooner', () => {
    const w = world({ retentionDays: 0 })
    w.db.saveAgent(w.agent('brief', { retentionDays: 7 }))
    w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['brief'] })
    w.said('ten-days', 'ch', NOW - 10 * DAY, 'brief')
    w.said('three-days', 'ch', NOW - 3 * DAY, 'brief')
    w.said('my-ten-days', 'ch', NOW - 10 * DAY)
    expect(w.retention.sweep()).toBe(1)
    expect(w.db.message('ten-days')).toBeUndefined()
    expect(w.db.message('three-days')).toBeTruthy()
    // The prompt in a channel is not the bot's to sweep: the Tucano's period is the one that decides.
    expect(w.db.message('my-ten-days')).toBeTruthy()
  })
})

describe('the two wipes a person asks for', () => {
  function twoBots() {
    const w = world({ retentionDays: 0 })
    w.db.saveAgent(w.agent('a1'))
    w.db.saveAgent(w.agent('a2'))
    w.db.createConversation({ id: 'dm-a1', kind: 'dm', name: 'a1', members: ['a1'], owner: w.db.ownerId() })
    w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1', 'a2'] })
    w.said('my-prompt-in-their-dm', 'dm-a1', NOW - DAY)
    w.said('a1-in-its-dm', 'dm-a1', NOW - DAY, 'a1')
    w.said('my-prompt-in-the-channel', 'ch', NOW - DAY)
    w.said('a1-in-the-channel', 'ch', NOW - DAY, 'a1')
    w.said('a2-in-the-channel', 'ch', NOW - DAY, 'a2')
    w.said('a2-old', 'ch', NOW - 400 * DAY, 'a2')
    return w
  }

  it("one bot's history is what it wrote anywhere and every word of its own DMs", () => {
    const w = twoBots()
    expect(w.retention.wipe('a1')).toBe(3)
    expect(w.db.message('my-prompt-in-their-dm')).toBeUndefined()
    expect(w.db.message('a1-in-its-dm')).toBeUndefined()
    expect(w.db.message('a1-in-the-channel')).toBeUndefined()
    // The channel keeps what the person and the other bot said, at any age.
    expect(w.db.message('my-prompt-in-the-channel')).toBeTruthy()
    expect(w.db.message('a2-in-the-channel')).toBeTruthy()
    expect(w.db.message('a2-old')).toBeTruthy()
    // Its sessions go whole, and only the conversations that lost something are read again.
    expect(w.calls.forgotten).toContainEqual({ agentId: 'a1' })
    expect(w.calls.cleared).toEqual([expect.arrayContaining(['dm-a1', 'ch'])])
  })

  it('every bot is every message, whatever the period says, and the rooms and agents stay', () => {
    const w = twoBots()
    expect(w.retention.wipe()).toBe(6)
    expect(w.db.messages()).toHaveLength(0)
    expect(w.db.conversations().map((c) => c.id).sort()).toEqual(['ch', 'dm-a1'])
    expect(w.db.agents().map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('a reply at work is stopped first, then taken', () => {
    const w = twoBots()
    w.db.saveMessage({ id: 'a1-working', conversationId: 'ch', author: { kind: 'agent', id: 'a1' }, text: 'x', at: NOW, run: { status: 'working', steps: [] } })
    expect(w.retention.wipe('a1')).toBe(4)
    expect(w.calls.stopped).toContain('a1-working')
    expect(w.db.message('a1-working')).toBeUndefined()
  })
})


it.each(['working', 'waiting_approval', 'waiting_input'] as const)('keeps an old root while a descendant is %s', (status) => {
  const w = world({ retentionDays: 30 })
  w.db.saveAgent(w.agent('a1'))
  w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1'], threads: true })
  w.said('old-root', 'ch', NOW - 40 * DAY)
  w.said('live-child', 'ch', NOW, 'a1', { threadId: 'old-root', run: { status, steps: [] } })
  expect(w.retention.sweep()).toBe(0)
  expect(w.db.message('old-root')).toBeTruthy()
  expect(w.db.message('live-child')).toBeTruthy()
})

it("does not bypass a bot's keep-forever override by sweeping its thread root", () => {
  const w = world({ retentionDays: 30 })
  w.db.saveAgent(w.agent('keeper', { retentionDays: 0 }))
  w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['keeper'], threads: true })
  w.said('old-root', 'ch', NOW - 40 * DAY)
  w.said('kept-child', 'ch', NOW - 39 * DAY, 'keeper', { threadId: 'old-root' })
  expect(w.retention.sweep()).toBe(0)
  expect(w.db.message('old-root')).toBeTruthy()
  expect(w.db.message('kept-child')).toBeTruthy()
})


it('keeps recent descendants and their ancestors, but still sweeps an eligible sibling', () => {
  const w = world({ retentionDays: 30 })
  w.db.saveAgent(w.agent('a1'))
  w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1'], threads: true })
  w.said('root', 'ch', NOW - 40 * DAY)
  w.said('middle', 'ch', NOW - 39 * DAY, 'a1', { threadId: 'root' })
  w.said('recent', 'ch', NOW - DAY, 'a1', { threadId: 'middle' })
  w.said('old-sibling', 'ch', NOW - 39 * DAY, 'a1', { threadId: 'root' })
  expect(w.retention.sweep()).toBe(1)
  for (const id of ['root', 'middle', 'recent']) expect(w.db.message(id)).toBeTruthy()
  expect(w.db.message('old-sibling')).toBeUndefined()
})

it('keeps an old reply awaiting a person even without a thread', () => {
  const w = world({ retentionDays: 30 })
  w.db.saveAgent(w.agent('a1'))
  w.db.createConversation({ id: 'ch', kind: 'channel', name: 'ch', members: ['a1'] })
  w.said('waiting', 'ch', NOW - 40 * DAY, 'a1', { run: { status: 'waiting_input', steps: [] } })
  expect(w.retention.sweep()).toBe(0)
  expect(w.db.message('waiting')).toBeTruthy()
})
