import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Author, Message } from '../src/shared/types'
import { Db } from '../src/core/db'

const agent = (id: string, handle: string): Agent => ({
  id, name: handle, handle, role: '', color: 'teal', instructions: '', modelId: 'sonnet', effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false
})

let db: Db
let clock: number
const say = (conversationId: string, text: string, author: Author = { kind: 'person', id: 'p1' }, threadId?: string): Message => {
  const m: Message = { id: `m${clock}`, conversationId, author, text, at: clock++, ...(threadId ? { threadId } : {}) }
  db.saveMessage(m)
  return m
}
const ids = (list: Message[]): string[] => list.map((m) => m.text)

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-history-')), 'test.db'))
  clock = 1_000
  db.saveAgent(agent('a1', 'lia'))
  db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1'], threads: true })
  db.createConversation({ id: 'c2', kind: 'channel', name: 'curto', members: ['a1'] })
})

describe('the messages the window opens with', () => {
  it("brings each conversation's latest, with their threads, and says from when each is whole", () => {
    const old = Array.from({ length: 6 }, (_, i) => say('c1', `c1-${i}`))
    say('c1', 'reply to c1-5', { kind: 'agent', id: 'a1' }, old[5]!.id)
    say('c2', 'c2-0')
    const { messages, since } = db.openingMessages(3)
    expect(ids(messages.filter((m) => m.conversationId === 'c1'))).toEqual(['c1-3', 'c1-4', 'c1-5', 'reply to c1-5'])
    expect(ids(messages.filter((m) => m.conversationId === 'c2'))).toEqual(['c2-0'])
    expect(since).toEqual({ c1: old[3]!.at }) // c2 came whole
  })

  it('keeps a thread still going, wherever it started, and every routine run with its reply', () => {
    const root = say('c1', 'an old question')
    db.saveRoutine({ id: 'r1', name: 'Resumo', agentId: 'a1', conversationId: 'c1', prompt: 'resuma', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 0 })
    say('c1', 'resuma', { kind: 'routine', id: 'r1' })
    say('c1', 'the summary', { kind: 'agent', id: 'a1' })
    for (let i = 0; i < 5; i++) say('c1', `later-${i}`)
    say('c1', 'still answering', { kind: 'agent', id: 'a1' }, root.id)
    const { messages } = db.openingMessages(2)
    expect(ids(messages)).toEqual(['an old question', 'resuma', 'the summary', 'later-3', 'later-4', 'still answering'])
  })
})

describe('older messages, as the scroll gets there', () => {
  it('come a page at a time, with their threads, until there are no more', () => {
    const all = Array.from({ length: 7 }, (_, i) => say('c1', `m-${i}`))
    say('c1', 'reply to m-1', { kind: 'agent', id: 'a1' }, all[1]!.id)
    const first = db.openingMessages(3)
    const page = db.messagesBefore('c1', first.since['c1']!, 3)
    expect(ids(page.messages)).toEqual(['m-1', 'm-2', 'm-3', 'reply to m-1']) // in time order: the reply came last
    expect(page.since).toBe(all[1]!.at)
    const last = db.messagesBefore('c1', page.since, 3)
    expect(ids(last.messages)).toEqual(['m-0'])
    expect(last.since).toBe(0) // all of it is here now
  })

  it('go back to a message to show, however far', () => {
    const all = Array.from({ length: 10 }, (_, i) => say('c1', `m-${i}`))
    const { since } = db.openingMessages(2)
    const back = db.messagesBefore('c1', since['c1']!, 2, all[3]!.at)
    expect(ids(back.messages)).toEqual(['m-3', 'm-4', 'm-5', 'm-6', 'm-7'])
    expect(back.since).toBe(all[3]!.at)
    // Already here: nothing comes, and it stays whole from where it was.
    expect(db.messagesBefore('c1', since['c1']!, 2, all[9]!.at)).toEqual({ messages: [], since: since['c1'] })
  })
})
