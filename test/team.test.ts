import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/types'
import { Db } from '../src/core/db'
import { claudeParser } from '../src/core/engines/claude'
import { report } from '../src/core/report'
import { backup } from '../src/core/team'

const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: 'Engenharia', color: 'sky', instructions: 'Dev do app.', modelId: 'opus', effort: 'high', limit: 10_000_000, used: 0, grants: {}, memory: 'auto', computer: true, archived: false, ...extra
})
const fresh = (): Db => new Db(join(mkdtempSync(join(tmpdir(), 'ad-team-')), 'test.db'))

// The team's .md file is in team-files.test.ts.
describe('backups', () => {
  it('backs up the database to a file', () => {
    const a = fresh()
    a.saveAgent(agent('s', 'staff'))
    const file = backup(a, mkdtempSync(join(tmpdir(), 'bk-')))
    expect(existsSync(file)).toBe(true)
    expect(new Db(file).agents()[0]!.handle).toBe('staff')
  })
})

describe('the report', () => {
  it('rates each agent and skill from what happened', () => {
    const db = fresh()
    db.saveAgent(agent('s', 'staff'))
    db.saveSkill({ id: 'k', name: 'testes-do-core', description: 'x', body: 'y', agents: [], state: 'active', createdAt: 1, updatedAt: 1 })
    const now = new Date(2026, 9, 28, 12).getTime() // a Wednesday
    const reply = (i: number, status: 'done' | 'failed', extra: object = {}) =>
      db.saveMessage({ id: `m${i}`, conversationId: 'c', author: { kind: 'agent', id: 's' }, text: 'x', at: now - i * 60_000, run: { status, steps: [{ id: 's', label: 'Leu a skill', detail: 'testes-do-core', status: 'done' }], receipt: { model: 'opus', inputTokens: 1000, cacheReadTokens: 0, outputTokens: 0, ms: 2000 }, ...extra } })
    db.createConversation({ id: 'c', kind: 'dm', name: 's', members: ['s'] })
    reply(1, 'done')
    reply(2, 'done')
    reply(3, 'failed', { error: 'Parei: repeti a mesma coisa, com o mesmo resultado, 5 vezes. Parecia um loop.' })
    reply(4, 'failed', { error: 'O motor terminou sem resposta.' })
    const r = report(db, now)
    expect(r.agents[0]).toMatchObject({ total: { replies: 4, ok: 2 }, cut: 1, failed: 1, avgTokens: 1000, avgMs: 2000 })
    expect(r.agents[0]!.weeks.at(-1)!.rate).toEqual({ replies: 4, ok: 2 })
    expect(r.agents[0]!.problems.map((p) => [p.kind, p.messageId])).toEqual([
      ['cut', 'm3'],
      ['failed', 'm4']
    ])
    expect(r.skills[0]).toMatchObject({ name: 'testes-do-core', reads: { replies: 4, ok: 2 } })
    expect(new Date(r.since)).toEqual(new Date(2026, 9, 26)) // that week's Monday
    // The week before had nothing.
    expect(report(db, now, new Date(2026, 9, 19).getTime()).agents[0]!.total).toEqual({ replies: 0, ok: 0 })
  })
})

describe('the subscription quota', () => {
  it("is read from Claude Code's rate limit events", () => {
    const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: 1792374000 }, seven_day: { utilization: 0.13, resetsAt: 1792612800 } } } })
    const [ev] = claudeParser().line(line)
    expect(ev).toMatchObject({ type: 'quota', quota: { fiveHour: { utilization: 0.12, resetsAt: 1792374000_000 }, sevenDay: { utilization: 0.13 } } })
  })
})

describe('the starter team', () => {
  it('comes only with a new database, not after someone deletes every agent', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'ad-seed-')), 'test.db')
    const first = new Db(file)
    expect(first.created).toBe(true)
    first.close()
    expect(new Db(file).created).toBe(false)
  })
})
