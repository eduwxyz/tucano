import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { executions, executionSteps, type CanRead } from '../src/core/executions'
import { report, weekStart } from '../src/core/report'
import type { Agent, ExecutionCursor, Message, Run, RunStatus } from '../src/shared/types'

const HOUR = 3_600_000
const NOW = new Date(2026, 10, 20, 12).getTime()
const agent = (id: string): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, grants: {} }) as unknown as Agent

let db: Db
const anyone = (): boolean => true

// A finished reply `hoursAgo`, that took `ms`.
function reply(id: string, hoursAgo: number, status: RunStatus = 'done', ms: number | null = 1000, run: Partial<Run> = {}, by = 'lia', conversationId = 'c1'): void {
  const at = NOW - hoursAgo * HOUR
  const message: Message = {
    id,
    conversationId,
    author: { kind: 'agent', id: by },
    text: `resposta ${id}`,
    at,
    run: { status, steps: [], endedAt: at + (ms ?? 0), ...(ms !== null ? { receipt: { model: 'opus', inputTokens: 100, cacheReadTokens: 0, outputTokens: 10, ms } } : {}), ...run }
  }
  db.saveMessage(message)
}

beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-exec-')), 'test.db'))
  for (const id of ['lia', 'theo']) db.saveAgent(agent(id))
  db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['lia', 'theo'] })
})

describe('the tools of a week', () => {
  const tools = (canRead: CanRead = anyone) => report(db, NOW, weekStart(NOW), canRead).tools

  it('gives each tool its uses, p95 and error rate, slowest first', () => {
    reply('a', 1, 'done', 1000, {
      steps: [
        { id: '1', label: 'Rodou', tool: 'bash', status: 'done', ms: 1000 },
        { id: '2', label: 'Rodou', tool: 'bash', status: 'error', ms: 9000 },
        { id: '3', label: 'Leu', tool: 'read_file', status: 'done', ms: 50 }
      ]
    })
    reply('b', 2, 'done', 1000, { steps: [{ id: '4', label: 'Rodou', tool: 'bash', status: 'done', ms: 2000 }, { id: '5', label: 'Rodou', tool: 'bash', status: 'done', ms: 3000 }] })

    expect(tools()).toEqual([
      { tool: 'bash', uses: 4, p95: 9000, errorRate: 0.25 },
      { tool: 'read_file', uses: 1, p95: 50, errorRate: 0 }
    ])
  })

  it('leaves out old steps with no tool, thinking, what a person steered, other weeks and what the viewer may not read', () => {
    db.createConversation({ id: 'private', kind: 'dm', name: 'theo', members: ['theo'] })
    reply('old-style', 1, 'done', 1000, { steps: [{ id: '1', label: 'Rodou', status: 'done', ms: 10 }, { id: '2', label: 'Você', status: 'done', kind: 'steer' }] })
    reply('last-week', 24 * 8, 'done', 1000, { steps: [{ id: '3', label: 'Rodou', tool: 'bash', status: 'done', ms: 10 }] })
    reply('hidden', 1, 'done', 1000, { steps: [{ id: '4', label: 'Rodou', tool: 'bash', status: 'done', ms: 10 }] }, 'theo', 'private')

    expect(tools((r) => r.conversationId !== 'private')).toEqual([])
  })

  it('counts a call that never came back as a use, with no time and not as the tool failing', () => {
    reply('stopped', 1, 'stopped', 1000, { steps: [{ id: '1', label: 'Parado', tool: 'bash', status: 'error' }] })

    expect(tools()).toEqual([{ tool: 'bash', uses: 1, errorRate: 0 }])
  })

  it('leaves out the Tuca, which is the app’s own', () => {
    db.saveAgent({ ...agent('tuca'), kind: 'tuca' } as Agent)
    reply('tuca-built', 1, 'failed', 1000, { steps: [{ id: '1', label: 'Rodou', tool: 'bash', status: 'error', ms: 10 }] }, 'tuca')

    expect(tools()).toEqual([])
    expect(executions(db, anyone, { days: 1 }, NOW).count).toBe(0)
  })

  it('counts a step left running as a use, with no time', () => {
    reply('cut', 1, 'interrupted', 1000, { steps: [{ id: '1', label: 'Rodou', tool: 'bash', status: 'running' }] })

    const [stat] = tools()
    expect(stat).toMatchObject({ tool: 'bash', uses: 1, errorRate: 0 })
    expect(stat!.p95).toBeUndefined()
  })
})

describe('the list of executions', () => {
  it('lists finished agent replies, newest first, with one that failed before any receipt, and nothing else', () => {
    reply('older', 5)
    reply('newer', 1)
    reply('no-receipt', 3, 'failed', null, { endedAt: NOW - 3 * HOUR + 4000 })
    reply('working', 0.5, 'working', null, { endedAt: undefined })
    db.saveMessage({ id: 'person', conversationId: 'c1', author: { kind: 'person', id: db.ownerId() }, text: 'oi', at: NOW - 2 * HOUR })
    db.saveMessage({ id: 'handed', conversationId: 'c1', author: { kind: 'agent', id: 'lia' }, text: '@theo, vê isso', at: NOW - 2 * HOUR, run: { status: 'done', steps: [], endedAt: NOW - 2 * HOUR, delegation: { id: 'd1', kind: 'handoff' } as never } })
    for (const app of ['router', 'memory']) db.addReceipt({ messageId: `${app}-turn`, agentId: app, engine: 'claude', at: NOW - HOUR, model: 'haiku', inputTokens: 10, cacheReadTokens: 0, outputTokens: 1, ms: 5 })

    const page = executions(db, anyone, { days: 1 }, NOW)

    expect(page.rows.map((r) => r.id)).toEqual(['newer', 'no-receipt', 'older'])
    expect(page.rows[1]).toMatchObject({ status: 'failed', ms: 4000, agentId: 'lia', conversationId: 'c1' })
    expect(page.rows[1]!.tokens).toBeUndefined()
    expect(page.rows[0]).toMatchObject({ model: 'opus', ms: 1000, preview: 'resposta newer' })
  })

  it('narrows by period, agent and status, and counts only what is selected', () => {
    reply('today-ok', 2, 'done', 1000)
    reply('today-asks', 3, 'waiting_input', 2000)
    reply('today-failed', 4, 'failed', 3000)
    reply('today-stopped', 5, 'stopped', 4000)
    reply('today-limit', 6, 'limit_reached', 5000)
    reply('theo-ok', 7, 'done', 6000, {}, 'theo')
    reply('last-week', 24 * 5, 'failed', 7000)
    reply('last-month', 24 * 20, 'done', 8000)
    const ids = (q: Parameters<typeof executions>[2]): string[] => executions(db, anyone, q, NOW).rows.map((r) => r.id)

    expect(ids({ days: 1 })).toHaveLength(6)
    expect(ids({ days: 7 })).toHaveLength(7)
    expect(ids({ days: 30 })).toHaveLength(8)
    expect(ids({ days: 1, agentId: 'theo' })).toEqual(['theo-ok'])
    expect(ids({ days: 1, status: 'ok' })).toEqual(['today-ok', 'today-asks', 'theo-ok'])
    expect(ids({ days: 1, status: 'failed' })).toEqual(['today-failed'])
    expect(ids({ days: 1, status: 'stopped' })).toEqual(['today-stopped', 'today-limit'])
    expect(executions(db, anyone, { days: 1, agentId: 'lia' }, NOW)).toMatchObject({ count: 5, errorRate: 0.2 })
  })

  it('reads p50 and p95 from the slow end, not an average', () => {
    for (let i = 1; i <= 20; i++) reply(`r${i}`, i / 10, 'done', i * 1000)

    expect(executions(db, anyone, { days: 1 }, NOW)).toMatchObject({ count: 20, p50: 10_000, p95: 19_000, errorRate: 0 })
  })

  it('pages through every execution exactly once, even when a new one lands or two share a moment', () => {
    for (let i = 0; i < 120; i++) reply(`r${String(i).padStart(3, '0')}`, Math.floor(i / 2) / 10) // pairs in the same instant

    const seen: string[] = []
    let before = undefined as ExecutionCursor | undefined
    let pages = 0
    do {
      const page = executions(db, anyone, { days: 1, ...(before ? { beforeAt: before.at, beforeId: before.id } : {}) }, NOW)
      expect(page.count).toBe(pages === 0 ? 120 : 121) // the numbers are of the whole selection, not the page
      seen.push(...page.rows.map((r) => r.id))
      before = page.next
      if (pages++ === 0) reply('arrived-meanwhile', 0)
    } while (before)

    expect(pages).toBe(3)
    expect(seen).toHaveLength(120)
    expect(new Set(seen).size).toBe(120)
    expect(seen).not.toContain('arrived-meanwhile')
  })

  it('times a retried reply from its last attempt, not from when the message was first written', () => {
    const at = NOW - 5 * HOUR
    reply('retried', 5, 'failed', null, { startedAt: at + 3 * HOUR, endedAt: at + 3 * HOUR + 2500 })

    expect(executions(db, anyone, { days: 1 }, NOW).rows[0]!.ms).toBe(2500)
  })

  it('previews a reply by its first line, without Markdown', () => {
    reply('marked', 1)
    db.saveMessage({ ...db.message('marked')!, text: '---\n\n## Veja [o PR](https://x.y/1) de a > b\nsegunda linha' })

    expect(executions(db, anyone, { days: 1 }, NOW).rows[0]!.preview).toBe('Veja o PR de a > b')
  })

  it('counts the tool calls of a reply, and not its thinking rows or what a person steered', () => {
    reply('busy', 1, 'done', 1000, {
      steps: [
        { id: 's1', label: 'Pensou', status: 'done' },
        { id: 's2', label: 'Rodou', tool: 'bash', status: 'done', ms: 40 },
        { id: 's3', label: 'Leu', tool: 'read_file', status: 'error', ms: 10 },
        { id: 's4', label: 'Você', status: 'done', kind: 'steer' }
      ]
    })

    expect(executions(db, anyone, { days: 1 }, NOW).rows[0]!.tools).toBe(2)
  })

  it('leaves out, from the list and the numbers, what the viewer may not read', () => {
    db.createConversation({ id: 'private', kind: 'dm', name: 'theo', members: ['theo'] })
    reply('visible', 1, 'done', 1000)
    reply('hidden', 2, 'failed', 9000, {}, 'theo', 'private')

    const page = executions(db, (r) => r.conversationId !== 'private', { days: 1 }, NOW)

    expect(page.rows.map((r) => r.id)).toEqual(['visible'])
    expect(page).toMatchObject({ count: 1, p95: 1000, errorRate: 0 })
  })

  it('opens a reply into its steps with time, status and error, without what the agent said or got back', () => {
    reply('busy', 1, 'failed', 1000, {
      steps: [
        { id: 's1', label: 'Pensou', status: 'done', ms: 5 },
        { id: 's2', label: 'Rodou', detail: 'npm test', tool: 'bash', status: 'error', ms: 40, error: 'exit code 1', note: 'o que o agente disse', output: 'saída' },
        { id: 's3', label: 'Você', status: 'done', kind: 'steer', detail: 'faz outra coisa' }
      ]
    })

    expect(executionSteps(db, 'busy')).toEqual([
      { id: 's1', label: 'Pensou', status: 'done', ms: 5 },
      { id: 's2', label: 'Rodou', detail: 'npm test', tool: 'bash', status: 'error', ms: 40, error: 'exit code 1' }
    ])
    expect(executionSteps(db, 'nobody')).toBeUndefined()
  })

  it('takes one execution as both percentiles, and has no numbers for none', () => {
    reply('only', 1, 'failed', 4200)

    expect(executions(db, anyone, { days: 1 }, NOW)).toMatchObject({ count: 1, p50: 4200, p95: 4200, errorRate: 1 })
    const none = executions(db, anyone, { days: 1, agentId: 'theo' }, NOW)
    expect(none.count).toBe(0)
    expect(none.p50).toBeUndefined()
    expect(none.p95).toBeUndefined()
    expect(none.errorRate).toBeUndefined()
  })
})
