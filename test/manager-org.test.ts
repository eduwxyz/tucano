// An agent that organizes the team (Agent.manager), and the Tuca, propose the org chart: whom each
// agent answers to, as a card the person applies, also when proposing new agents and teams.
import { describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/types'
import { Db } from '../src/core/db'
import { setLang } from '../src/shared/lang'
import { proposalFrom } from '../src/core/tuca-help'
import { agentFromDraft, bossArg, builderSection, draftFrom, notOrganizerGuide, orgLines, PROPOR_TIME, teamFrom, withoutBoss } from '../src/core/tuca'
import { PROPOR_AJUSTE } from '../src/core/tuca-help'

setLang('pt')
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'medium', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const lia = agent('a1', 'lia')
const theo = agent('a2', 'theo', { reportsTo: 'a1' })
const nina = agent('a3', 'nina')
const team = [lia, theo, nina]
const ctx = { agents: team, conversations: [], connectors: [], usable: () => true }
const base = { usable: () => true, fallbackModel: 'sonnet', connectors: [] }
const one = (nome: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ nome, funcao: 'Dados', instrucoes: 'Faz.', ...extra })

describe('propor_ajuste with responde_a', () => {
  it('is only for the Tuca and an agent that organizes the team', () => {
    // A refusal it passes on (the person hears how to allow it), not a failure to retry.
    const r = proposalFrom('propor_ajuste', { agente: 'nina', responde_a: 'lia' }, { ...ctx, me: 'Edu' })
    expect(r).toMatchObject({ denied: true })
    expect(r.error).toContain('Você não tem permissão pra mudar o organograma')
    expect(r.error).toContain('Não tente de novo')
    expect(r.error).toContain('Diga a Edu')
    expect(r.error).toContain('**Organiza o time**')
  })

  it('becomes a change of boss, with who it answered to before', () => {
    const r = proposalFrom('propor_ajuste', { agente: 'nina', responde_a: '@lia', motivo: 'A Lia coordena.' }, { ...ctx, organizes: true })
    expect(r.proposal).toMatchObject({ kind: 'agent', agentId: 'a3', changes: { reportsTo: 'a1' }, before: { reportsTo: '' } })
  })

  it('"ninguém" takes the boss away, and the same boss changes nothing', () => {
    expect(proposalFrom('propor_ajuste', { agente: 'theo', responde_a: 'ninguém' }, { ...ctx, organizes: true }).proposal).toMatchObject({ changes: { reportsTo: '' }, before: { reportsTo: 'a1' } })
    expect(proposalFrom('propor_ajuste', { agente: 'theo', responde_a: 'lia' }, { ...ctx, organizes: true }).error).toContain('Nada mudaria')
  })

  it('refuses a loop, a line past three, and an agent that does not exist', () => {
    expect(bossArg('theo', team, 'a1').error).toContain('ciclo')
    const deep = [agent('t', 'top'), agent('m', 'mid', { reportsTo: 't' }), agent('b', 'bot', { reportsTo: 'm' }), agent('n', 'new')]
    expect(bossArg('bot', deep, 'n').error).toContain('3 agentes')
    expect(bossArg('mid', deep, 'n').id).toBe('m')
    expect(bossArg('zeca', team, 'a3').error).toContain('Não existe o agente "zeca"')
  })
})

describe('proposing new agents in the chart', () => {
  it('a new agent may answer to one that exists, and is made with it', () => {
    const r = draftFrom(one('Duda', { responde_a: 'lia' }), { ...base, agents: team, organizes: true })
    expect(r.draft?.reportsTo).toBe('a1')
    expect(agentFromDraft(r.draft!, [], 1000).reportsTo).toBe('a1')
    expect(draftFrom(one('Duda', { responde_a: 'lia' }), { ...base, agents: team })).toMatchObject({ denied: true })
    expect(teamFrom({ agentes: [one('Duda', { responde_a: 'lia' }), one('Caio')] }, { ...base, agents: team, channels: [] })).toMatchObject({ denied: true })
  })

  it('a team may put one of its own agents over another, and the tree is checked', () => {
    const r = teamFrom({ agentes: [one('Duda', { responde_a: 'lia' }), one('Caio', { responde_a: 'Duda' })] }, { ...base, agents: team, organizes: true, channels: [] })
    expect(r.proposal).toMatchObject({ kind: 'team', agents: [{ name: 'Duda', reportsTo: 'a1' }, { name: 'Caio', reportsToName: 'Duda' }] })
    const loop = teamFrom({ agentes: [one('Duda', { responde_a: 'Caio' }), one('Caio', { responde_a: 'Duda' })] }, { ...base, agents: team, organizes: true, channels: [] })
    expect(loop.error).toContain('ciclo')
    // Theo is already under Lia: Duda under Theo, and Caio under Duda, makes four in a line.
    const long = teamFrom({ agentes: [one('Duda', { responde_a: 'theo' }), one('Caio', { responde_a: 'Duda' })] }, { ...base, agents: team, organizes: true, channels: [] })
    expect(long.error).toContain('3 agentes')
    expect(teamFrom({ agentes: [one('Duda', { responde_a: 'Zeca' }), one('Caio')] }, { ...base, agents: team, organizes: true, channels: [] }).error).toContain('não existe "Zeca"')
  })
})

describe('what an organizer reads', () => {
  it('the chart: who answers to whom, and who organizes', () => {
    const lines = orgLines([...team, agent('t', 'tuca', { kind: 'tuca' }), { ...nina, id: 'a4', handle: 'bia', name: 'Bia', manager: true }])
    expect(lines).toContain('- Theo (@theo) → responde a @lia')
    expect(lines).toContain('- Lia (@lia) → responde só à pessoa')
    expect(lines).toContain('· organiza o time')
    expect(lines).not.toContain('tuca')
    const s = { engines: {} } as Parameters<typeof builderSection>[0]
    expect(builderSection(s, { models: [], connectors: [], team, own: 'sonnet', organizes: true })).toContain('O organograma hoje')
    expect(builderSection(s, { models: [], connectors: [], team, own: 'sonnet' })).not.toContain('O organograma hoje')
  })
})

describe('the flag is kept', () => {
  it('an agent that organizes the team stays so, and stops when turned off', () => {
    const db = new Db(':memory:')
    db.saveAgent({ ...lia, manager: true })
    expect(db.agent('a1')?.manager).toBe(true)
    db.saveAgent({ ...db.agent('a1')!, manager: undefined })
    expect(db.agent('a1')?.manager).toBeUndefined()
    db.close()
  })
})

describe('an agent that does not organize the team', () => {
  it("isn't offered responde_a, in a change or in a team's agents, and is told to say how to allow it", () => {
    expect(Object.keys(PROPOR_AJUSTE.inputSchema.properties!)).toContain('responde_a')
    expect(Object.keys(withoutBoss(PROPOR_AJUSTE).inputSchema.properties!)).not.toContain('responde_a')
    const each = (t: typeof PROPOR_TIME): string[] => Object.keys((t.inputSchema.properties!['agentes'] as { items: { properties: Record<string, unknown> } }).items.properties)
    expect(each(PROPOR_TIME)).toContain('responde_a')
    expect(each(withoutBoss(PROPOR_TIME))).not.toContain('responde_a')
    expect(withoutBoss(PROPOR_AJUSTE).name).toBe('propor_ajuste')
    expect(notOrganizerGuide('Edu')).toContain('não tente')
  })
})
