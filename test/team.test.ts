import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { examples } from 'open-bot-avatar'
import type { Agent } from '../src/shared/types'
import { Db } from '../src/core/db'
import { claudeParser } from '../src/core/engines/claude'
import { report } from '../src/core/report'
import { backup, exportTeam, importTeam } from '../src/core/team'

const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: 'Engenharia', color: 'sky', instructions: 'Dev do app.', modelId: 'opus', effort: 'high', limit: 10_000_000, used: 0, grants: {}, memory: 'auto', computer: true, archived: false, ...extra
})
const fresh = (): Db => new Db(join(mkdtempSync(join(tmpdir(), 'ad-team-')), 'test.db'))

describe('the team as a file', () => {
  it('exports readable Markdown without credentials, and imports it elsewhere with routines off', () => {
    const a = fresh()
    a.saveConnector({ id: 'lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
    a.saveAgent(agent('s', 'staff', { grants: { lin: 'read' } }))
    a.saveAgent(agent('p', 'pm', { role: 'Produto', computer: false, customColor: '#ff00aa', picture: 'data:image/webp;base64,AAAA', avatar: examples[0], team: ['s'] }))
    a.createConversation({ id: 'c1', kind: 'channel', name: 'simula-oab', members: ['s', 'p'] })
    a.saveSkill({ id: 'k', name: 'testes-do-core', description: 'Ao rodar testes', body: 'swift test', agents: ['s'], state: 'active', createdAt: 1, updatedAt: 1 })
    a.saveRoutine({ id: 'r', name: 'Issues novas', agentId: 'p', conversationId: 'c1', prompt: 'Planeje.', schedule: { days: [], time: '' }, trigger: { kind: 'poll', connectorId: 'lin', tool: 'list_issues', args: { label: 'agente' }, everyMinutes: 5 }, enabled: true, createdAt: 1 })
    a.setSecret('connector:lin:oauth', 'segredo')
    const md = exportTeam(a)
    expect(md).toContain('- **Staff** (@staff) · Engenharia · Opus · com computador · acessa Linear')
    expect(md).toContain('- **Issues novas** (@pm, #simula-oab): quando aparece algo novo em Linear · list_issues')
    expect(md).not.toContain('segredo')
    expect(md).toContain('coordena @staff')

    const b = fresh()
    b.saveConnector({ id: 'lin2', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
    expect(importTeam(b, md, 2_000_000)).toBe('Importei 2 agentes, 1 skill, 1 canal, 1 rotina (desligadas).')
    const staff = b.agents().find((x) => x.handle === 'staff')!
    expect(staff).toMatchObject({ modelId: 'opus', grants: { lin2: 'read' }, computer: false })
    // The drawn avatar and the color travel; the picture stays on its computer.
    const pm = b.agents().find((x) => x.handle === 'pm')!
    expect(pm).toMatchObject({ customColor: '#ff00aa', avatar: { id: examples[0]!.id } })
    expect(pm.picture).toBeUndefined()
    // Who it coordinates travels by handle.
    expect(pm.team).toEqual([staff.id])
    expect(b.skills()[0]).toMatchObject({ name: 'testes-do-core', agents: [staff.id] })
    expect(b.routines()[0]).toMatchObject({ enabled: false, trigger: { kind: 'poll', connectorId: 'lin2' } })
    expect(importTeam(b, md, 2_000_000)).toBe('Nada novo: tudo já existia aqui.')
    expect(() => importTeam(b, '# outro arquivo', 1)).toThrow('não é um time exportado')
  })

  it('backs up the database to a file', () => {
    const a = fresh()
    a.saveAgent(agent('s', 'staff'))
    const file = backup(a, mkdtempSync(join(tmpdir(), 'bk-')))
    expect(existsSync(file)).toBe(true)
    expect(new Db(file).agents()[0]!.handle).toBe('staff')
  })

  it("keeps a backup named after the workspace, beside a week of older ones", () => {
    const dir = mkdtempSync(join(tmpdir(), 'bk-'))
    for (let d = 1; d <= 7; d++) writeFileSync(join(dir, `tucano-2026-10-0${d}-09-00.db`), '')
    const file = backup(fresh(), dir, 'Empresa São Paulo')
    expect(file.endsWith('-Empresa-Sao-Paulo.db')).toBe(true)
    expect(existsSync(file)).toBe(true)
    expect(readdirSync(dir)).toHaveLength(7)
    expect(existsSync(join(dir, 'tucano-2026-10-01-09-00.db'))).toBe(false) // the oldest went
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
