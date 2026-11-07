import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { examples } from 'open-bot-avatar'
import type { Agent, Settings, TeamChoice, TeamUpdate } from '../src/shared/types'
import { Db } from '../src/core/db'
import { parseTeam, TeamFiles } from '../src/core/team-files'

const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: 'Engenharia', color: 'sky', instructions: 'Dev do app.', modelId: 'opus', effort: 'high', limit: 10_000_000, used: 0, grants: {}, memory: 'auto', computer: true, archived: false, ...extra
})
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p))
const context = (db: Db): string => db.getSettings({} as Omit<Settings, 'engines'>).context ?? ''

// One person's app: its database and the teams it knows.
function app(): { db: Db; teams: TeamFiles } {
  const dir = tmp('tf-app-')
  const db = new Db(join(dir, 'test.db'))
  const teams = new TeamFiles({ db, dir: join(dir, 'teams'), defaultLimit: () => 2_000_000, context: () => context(db), name: () => 'Simulados' })
  return { db, teams }
}

// The author's team: two agents, a channel, a skill, a routine on a connector, the workspace's context.
function author(): { db: Db; teams: TeamFiles } {
  const a = app()
  a.db.saveConnector({ id: 'lin', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
  a.db.saveAgent(agent('s', 'staff', { grants: { lin: 'read' } }))
  a.db.saveAgent(agent('p', 'pm', { role: 'Produto', computer: false, instructions: 'Planeja o produto.', customColor: '#ff00aa', picture: 'data:image/webp;base64,AAAA', avatar: examples[0] }))
  a.db.createConversation({ id: 'c1', kind: 'channel', name: 'produto', topic: 'O app', members: ['s', 'p'] })
  a.db.saveSkill({ id: 'k', name: 'testes-do-core', description: 'Ao rodar testes', body: 'swift test', agents: ['s'], state: 'active', createdAt: 1, updatedAt: 1 })
  a.db.saveRoutine({ id: 'r', name: 'Issues novas', agentId: 'p', conversationId: 'c1', prompt: 'Planeje.', schedule: { days: [], time: '' }, trigger: { kind: 'poll', connectorId: 'lin', tool: 'list_issues', args: { label: 'agente' }, everyMinutes: 5 }, enabled: true, createdAt: 1 })
  a.db.setSettings({ context: 'Somos a equipe do app de simulados.' })
  a.db.setSecret('connector:lin:oauth', 'segredo')
  return a
}

const all = (u: TeamUpdate, choice: TeamChoice = 'package'): Record<string, TeamChoice> => Object.fromEntries(u.changes.map((c) => [c.key, choice]))
const byHandle = (db: Db, h: string): Agent => db.agents().find((a) => a.handle === h)!
const importAll = (to: { teams: TeamFiles }, md: string): TeamUpdate => {
  const u = to.teams.preview(md)
  to.teams.apply(md, all(u))
  return u
}

describe("the team's .md file", () => {
  it('is readable Markdown with the instructions, and no credentials', () => {
    const md = author().teams.export()
    expect(md).toContain('# Time de Simulados')
    expect(md).toContain('### Staff (@staff)')
    expect(md).toContain('Engenharia · Opus · com computador · acessa Linear')
    expect(md).toContain('> Dev do app.')
    expect(md).toContain('- **Issues novas** (@pm, #produto): quando aparece algo novo em Linear · list_issues')
    expect(md).toContain('- **Linear** · https://mcp.linear.app/mcp')
    expect(md).toContain('> Somos a equipe do app de simulados.')
    expect(md).not.toContain('segredo')
    expect(md).not.toContain('10000000') // the monthly limit is each person's
    expect(md).not.toContain('AAAA') // the picture stays on its computer
    const team = parseTeam(md)
    expect(team).toMatchObject({ name: 'Time de Simulados', revision: 1 })
    expect(team.items.map((it) => it.kind)).toEqual(['connector', 'agent', 'agent', 'channel', 'skill', 'routine', 'context'])
    expect(() => parseTeam('# outro arquivo')).toThrow('não é um time exportado')
  })

  it('imported on another computer brings everything in, routines off, connectors waiting for a sign-in', () => {
    const md = author().teams.export()
    const b = app()
    const first = b.teams.preview(md)
    expect(first.seen).toBe(0)
    expect(first.changes.map((c) => [c.kind, c.status])).toEqual([
      ['connector', 'new'],
      ['agent', 'new'],
      ['agent', 'new'],
      ['channel', 'new'],
      ['skill', 'new'],
      ['routine', 'new'],
      ['context', 'update'] // there's always one here, empty or not
    ])
    expect(b.db.agents()).toHaveLength(0) // nothing changes before applying
    const r = b.teams.apply(md, all(first))
    expect(r.note).toBe('Time importado: adicionei 6, atualizei 1. Entre nos conectores novos com a sua conta, em Conectores.')
    const lin = b.db.connectors().find((c) => c.name === 'Linear')!
    expect(r.connectors).toEqual([lin.id])
    expect(b.db.getSecret(`connector:${lin.id}:oauth`)).toBeUndefined()
    const staff = byHandle(b.db, 'staff')
    expect(staff).toMatchObject({ grants: { [lin.id]: 'read' }, computer: false, limit: 2_000_000, instructions: 'Dev do app.' })
    expect(byHandle(b.db, 'pm')).toMatchObject({ customColor: '#ff00aa', avatar: { id: examples[0]!.id } })
    expect(byHandle(b.db, 'pm').picture).toBeUndefined()
    expect(b.db.conversations().find((c) => c.name === 'produto')!.members.sort()).toEqual([byHandle(b.db, 'pm').id, staff.id].sort())
    expect(b.db.skills()[0]).toMatchObject({ name: 'testes-do-core', agents: [staff.id] })
    expect(b.db.routines()[0]).toMatchObject({ enabled: false, trigger: { kind: 'poll', connectorId: lin.id } })
    expect(context(b.db)).toBe('Somos a equipe do app de simulados.')
    // The same file again: nothing new, and Windows line endings don't count as a change.
    expect(b.teams.preview(md)).toMatchObject({ seen: 1, changes: [] })
    expect(b.teams.preview(md.replace(/\n/g, '\r\n')).changes).toEqual([])
    expect(b.teams.list()).toMatchObject([{ name: 'Time de Simulados', revision: 1, changedHere: [] }])
  })

  it('imported again when newer, offers each change with a diff and never overwrites a local change in silence', () => {
    const a = author()
    const b = app()
    const md1 = a.teams.export()
    importAll(b, md1)

    // Here: staff's role and pm's instructions change, and a routine gets turned on.
    b.db.saveAgent({ ...byHandle(b.db, 'staff'), role: 'Backend' })
    b.db.saveAgent({ ...byHandle(b.db, 'pm'), instructions: 'Planeja do meu jeito.' })
    b.db.saveRoutine({ ...b.db.routines()[0]!, enabled: true })
    expect(b.teams.list()[0]!.changedHere.map((x) => x.title).sort()).toEqual(['Pm (@pm)', 'Staff (@staff)'])

    // The author: new instructions for staff and pm, a new skill, a routine gone.
    a.db.saveAgent({ ...a.db.agent('s')!, instructions: 'Dev do app, com testes.' })
    a.db.saveAgent({ ...a.db.agent('p')!, instructions: 'Planeja o produto e escreve as specs.' })
    a.db.saveSkill({ id: 'k2', name: 'release', description: 'Ao lançar', body: 'npm run release', agents: [], state: 'active', createdAt: 2, updatedAt: 2 })
    a.db.removeRoutine('r')
    const md2 = a.teams.export()
    expect(parseTeam(md2).revision).toBe(2)

    const u = b.teams.preview(md2)
    expect(u).toMatchObject({ seen: 1, revision: 2 })
    const by = Object.fromEntries(u.changes.map((c) => [c.title, c]))
    expect(by['Staff (@staff)']).toMatchObject({ status: 'update', fields: [{ name: 'instructions', mine: 'Dev do app.', theirs: 'Dev do app, com testes.', conflict: false }] })
    expect(by['Pm (@pm)']).toMatchObject({ status: 'conflict', fields: [{ name: 'instructions', mine: 'Planeja do meu jeito.', theirs: 'Planeja o produto e escreve as specs.', conflict: true }] })
    expect(by['release']).toMatchObject({ status: 'new' })
    expect(by['Issues novas (@pm)']).toMatchObject({ status: 'removed' })

    const choices = Object.fromEntries(u.changes.map((c) => [c.key, (c.status === 'conflict' ? 'mine' : c.status === 'removed' ? 'later' : 'package') as TeamChoice]))
    expect(b.teams.apply(md2, choices).note).toBe('Time importado: adicionei 1, atualizei 2. 1 ficou pra depois: importe o arquivo de novo pra ver.')
    expect(byHandle(b.db, 'staff')).toMatchObject({ instructions: 'Dev do app, com testes.', role: 'Backend' }) // theirs + mine
    expect(byHandle(b.db, 'pm').instructions).toBe('Planeja do meu jeito.') // kept, as chosen
    expect(b.db.skills().map((k) => k.name).sort()).toEqual(['release', 'testes-do-core'])
    expect(b.db.routines()[0]).toMatchObject({ enabled: true }) // removal left for later; and on/off is mine

    // Kept-mine isn't offered again; the removal still is.
    const again = b.teams.preview(md2)
    expect(again.changes.map((c) => c.status)).toEqual(['removed'])
    b.teams.apply(md2, { [again.changes[0]!.key]: 'package' })
    expect(b.db.routines()).toHaveLength(0)
    // The first file again: it says it's older, and what was taken out doesn't come back.
    const old = b.teams.preview(md1)
    expect(old).toMatchObject({ revision: 1, seen: 2 })
    expect(old.changes.map((c) => c.kind)).not.toContain('routine')
  })

  it('goes back and forth: each side merges the other one’s file with what it changed meanwhile', () => {
    const a = author()
    const b = app()
    importAll(b, a.teams.export())

    // Both change different things after the same file.
    a.db.saveAgent({ ...a.db.agent('s')!, effort: 'medium' })
    b.db.saveAgent({ ...byHandle(b.db, 'pm'), role: 'Produto e design' })
    const fromB = b.teams.export()
    expect(parseTeam(fromB).id).toBe(parseTeam(a.teams.export()).id) // the same team

    // The author gets b's change and keeps their own.
    const u = a.teams.preview(fromB)
    expect(u.changes.map((c) => [c.title, c.status, c.fields.map((f) => f.name)])).toEqual([['Pm (@pm)', 'update', ['role']]])
    a.teams.apply(fromB, all(u))
    expect(a.db.agent('p')!.role).toBe('Produto e design')
    expect(a.db.agent('s')!.effort).toBe('medium')
  })

  it('links what already exists by handle, so the file comes as an update instead of a duplicate', () => {
    const md = author().teams.export()
    const b = app()
    b.db.saveAgent(agent('mine', 'staff', { instructions: 'Minha versão.' }))
    const u = b.teams.preview(md)
    const staff = u.changes.find((c) => c.title === 'Staff (@staff)')!
    expect(staff.status).toBe('update')
    expect(staff.fields.map((f) => f.name)).toContain('instructions')
    b.teams.apply(md, { [staff.key]: 'package' })
    expect(b.db.agents().filter((x) => x.handle === 'staff')).toHaveLength(1)
    expect(b.db.agent('mine')!.instructions).toBe('Dev do app.')
  })

  it('declining a new item keeps it out for good, and forgetting the team leaves everything here', () => {
    const md = author().teams.export()
    const b = app()
    const u = b.teams.preview(md)
    // No pm here, nor the routine it runs.
    const no = u.changes.filter((c) => c.title === 'Pm (@pm)' || c.kind === 'routine').map((c) => c.key)
    b.teams.apply(md, { ...all(u), ...Object.fromEntries(no.map((k) => [k, 'mine' as const])) })
    expect(b.db.agents().map((x) => x.handle)).toEqual(['staff'])
    expect(b.teams.preview(md).changes).toEqual([])
    // Exporting keeps what I said no to as the team has it: passing my file on loses nothing.
    expect(parseTeam(b.teams.export()).items.map((it) => it.kind).sort()).toEqual(['agent', 'agent', 'channel', 'connector', 'context', 'routine', 'skill'])
    b.teams.forget(u.packageId)
    expect(b.teams.list()).toEqual([])
    expect(b.db.agents()).toHaveLength(1)
  })

  it('reads a team exported before teams had ids', () => {
    const old = [
      '# Time do Tucano',
      '```json tucano-team',
      JSON.stringify({
        version: 1,
        agents: [{ handle: 'staff', name: 'Staff', role: 'Engenharia', color: 'sky', instructions: 'Dev do app.', model: 'opus', effort: 'high', limit: 10_000_000, web: true, computer: true, grants: { Linear: 'read' } }],
        skills: [],
        channels: [{ name: 'produto', members: ['staff'] }],
        routines: [{ name: 'Issues novas', agent: 'staff', where: '#produto', prompt: 'Planeje.', schedule: { days: [], time: '' }, trigger: { kind: 'poll', connector: 'Linear', tool: 'list_issues', args: {}, everyMinutes: 5 } }]
      }),
      '```'
    ].join('\n')
    const b = app()
    b.db.saveConnector({ id: 'lin2', name: 'Linear', kind: 'remote', url: 'https://mcp.linear.app/mcp', auth: 'oauth' })
    const u = b.teams.preview(old)
    expect(u.changes.map((c) => c.kind)).toEqual(['agent', 'channel', 'routine'])
    b.teams.apply(old, all(u))
    expect(byHandle(b.db, 'staff')).toMatchObject({ grants: { lin2: 'read' }, limit: 2_000_000 })
    expect(b.db.routines()[0]).toMatchObject({ enabled: false, trigger: { connectorId: 'lin2' } })
    expect(b.teams.preview(old).changes).toEqual([])
  })
})
