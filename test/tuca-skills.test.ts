// The whole list of skills a bot follows, as a proposal carries it: what a bot keeps and what it
// drops, how "everyone" is written, the two cases the app can't express, and what the Tuca sees
// before proposing (ver_estado's skills area). The unit half is pure; the last part drives the real
// core with the fake engine, so the card is applied the way the screen applies it.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Agent, Message, Skill } from '../src/shared/types'
import { proposalsOf } from '../src/shared/types'
import { assignSkills, EVERYONE, skillList, skillsOf } from '../src/core/skills'
import { proposalFrom, workspaceState, type ProposalCtx, type StateInput } from '../src/core/tuca-help'
import { setLang } from '../src/shared/lang'
import { bootCore, type Client, type TestCore } from './helpers/core'

const skill = (id: string, name: string, agents: string[] = []): Skill => ({ id, name, description: `when ${name}`, body: 'recipe', agents, state: 'active', createdAt: 1, updatedAt: 1 })
const agent = (id: string, handle: string): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: 'You triage tickets.', modelId: 'sonnet', effort: 'low', limit: 100_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })

const lia = agent('a1', 'lia')
const theo = agent('a2', 'theo')
const nina = agent('a3', 'nina')
const team = [lia, theo, nina]
// One skill of Nina's own, one shared by Lia and Theo, one everyone's, one archived.
const skills: Skill[] = [
  skill('s1', 'nina-only', ['a3']),
  skill('s2', 'shared-pair', ['a1', 'a2']),
  skill('s3', 'everyones'),
  { ...skill('s4', 'old-one'), state: 'archived' }
]
const ctx = { agents: team, conversations: [], connectors: [], usable: () => true, skills } as unknown as ProposalCtx

describe('what a bot follows, written as a whole list', () => {
  it('reads back as the names it follows, or "*" when that is every active skill', () => {
    expect(skillsOf(skills, 'a2')).toEqual(['everyones', 'shared-pair'])
    expect(skillList(skills, 'a2')).toEqual(['everyones', 'shared-pair'])
    expect(skillList(skills, 'a3')).toEqual(['everyones', 'nina-only'])
    // Every active one, said by name, is the same as "*".
    expect(skillList(skills, 'a1')).not.toEqual([EVERYONE])
    const all = skills.filter((k) => k.state === 'active')
    // Lia follows two of the three: the whole list by name adds the third, and takes nothing away.
    const forAll = assignSkills(skills, 'a1', ['a1', 'a2', 'a3'], all.map((k) => k.name))
    expect(forAll.writes).toHaveLength(1)
    expect(forAll.writes[0]!.id).toBe('s1')
    expect([...forAll.writes[0]!.agents].sort()).toEqual(['a1', 'a3'])
    // Said with "*", the same thing happens.
    const starred = assignSkills(skills, 'a1', ['a1', 'a2', 'a3'], [EVERYONE]).writes
    expect(starred.map((w) => [w.id, [...w.agents].sort()])).toEqual([['s1', ['a1', 'a3']]])
  })

  it('adds one and takes one away on the skills themselves, never on the agent', () => {
    // Theo keeps only "nina-only": the shared pair loses him, Nina's own skill gains him.
    const r = assignSkills(skills, 'a2', ['a1', 'a2', 'a3'], ['nina-only'])
    expect(r.writes).toEqual([
      { id: 's1', agents: ['a3', 'a2'] },
      { id: 's2', agents: ['a1'] },
      { id: 's3', agents: ['a1', 'a3'] }
    ])
    expect(r.unknown).toEqual([])
  })

  it('a skill everyone has, taken from one: the others are written out by name', () => {
    const r = assignSkills(skills, 'a2', ['a1', 'a2', 'a3'], ['shared-pair', 'nina-only'])
    expect(r.writes).toEqual([
      { id: 's1', agents: ['a3', 'a2'] },
      { id: 's3', agents: ['a1', 'a3'] }
    ])
  })

  it('a list that leaves every agent on a skill collapses back to "everyone", not to three names', () => {
    const onlyTwo = [skill('x', 'two-of-them', ['a1', 'a2']), skill('y', 'all', [])]
    const r = assignSkills(onlyTwo, 'a3', ['a1', 'a2', 'a3'], ['two-of-them', 'all'])
    expect(r.writes).toEqual([{ id: 'x', agents: [] }])
  })

  it('"*" is every active skill, archived ones aside', () => {
    const r = assignSkills(skills, 'a2', ['a1', 'a2', 'a3'], [EVERYONE])
    expect(r.writes.map((w) => w.id)).toEqual(['s1'])
  })

  it('says what it cannot do: a name that is not an active skill, and a skill left with nobody', () => {
    expect(assignSkills(skills, 'a2', ['a1', 'a2', 'a3'], ['old-one']).unknown).toEqual(['old-one'])
    // A team of one: everyone's skill Zé follows can't be taken from him, because [] means everyone.
    const alone = assignSkills([skill('z', 'everyones')], 'a1', ['a1'], [])
    expect(alone.alone).toBe('everyones')
  })
})

describe("the Tuca's proposal to change a bot's skills", () => {
  it('carries the whole list, and the before with it', () => {
    const r = proposalFrom('propor_ajuste', { agente: 'theo', skills: ['nina-only'] }, ctx)
    expect(r.proposal).toMatchObject({ kind: 'agent', agentId: 'a2', changes: { skills: ['nina-only'] }, before: { skills: ['everyones', 'shared-pair'] } })
  })

  it('takes "*" for every skill, and the names in any case', () => {
    expect(proposalFrom('propor_ajuste', { agente: 'theo', skills: ['*'] }, ctx).proposal).toMatchObject({ changes: { skills: [EVERYONE] } })
    expect(proposalFrom('propor_ajuste', { agente: 'theo', skills: ['NINA-ONLY', 'Everyones'] }, ctx).proposal).toMatchObject({ changes: { skills: ['everyones', 'nina-only'] } })
    // Nina already follows nina-only and everyones: nothing to do.
    expect(proposalFrom('propor_ajuste', { agente: 'nina', skills: ['everyones', 'nina-only'] }, ctx).error).toContain('Nada mudaria')
  })

  it('refuses a name that is not an active skill, and a list that is not a list', () => {
    expect(proposalFrom('propor_ajuste', { agente: 'theo', skills: ['no-such-skill'] }, ctx).error).toContain('no-such-skill')
    expect(proposalFrom('propor_ajuste', { agente: 'theo', skills: 'nina-only' }, ctx).error).toContain('lista')
  })

  it('says why a skill everyone has cannot be taken from one agent of a team of one', () => {
    const one = { agents: [theo], conversations: [], connectors: [], usable: () => true, skills: [skill('z', 'everyones', ['a2'])] } as unknown as ProposalCtx
    expect(proposalFrom('propor_ajuste', { agente: 'theo', skills: [] }, one).error).toContain('everyones')
  })
})

describe('what the Tuca sees: ver_estado, the skills area', () => {
  const state = (busca?: string): string =>
    workspaceState('skills', { settings: { workspaceName: 'Edu' }, connectors: [], agents: team, conversations: [], routines: [], approvals: [], failures: [], skills, now: Date.now() } as unknown as StateInput, busca)

  it('says how many there are, which ones have owners and who, and which are everyone’s', () => {
    setLang('en')
    const out = state()
    expect(out).toContain('3 of 3 active skills · 2 with some agents · 1 with everyone')
    expect(out).toContain('nina-only → Nina')
    expect(out).toContain('shared-pair → Lia, Theo')
    expect(out).toContain('with everyone: everyones')
  })

  it('narrows to what the person is looking for, with when to use it', () => {
    setLang('en')
    const out = state('pair')
    expect(out).toContain('shared-pair: when shared-pair')
    expect(out).not.toContain('nina-only:')
  })

  it('an agent line says how many it follows and which ones are its own', () => {
    setLang('en')
    const out = workspaceState('agentes', { settings: { workspaceName: 'Edu' }, connectors: [], agents: team, conversations: [], routines: [], approvals: [], failures: [], skills, now: Date.now() } as unknown as StateInput)
    expect(out).toContain('Nina (@nina)')
    expect(out).toMatch(/@lia.*2 skill\(s\), its own: shared-pair/)
    expect(out).toMatch(/@theo.*2 skill\(s\), its own: shared-pair/)
    // An agent with only everyone's skills has none of its own to name.
    expect(out).toMatch(/@nina.*2 skill\(s\), its own: nina-only/)
  })
})

describe('applied the way the screen applies it', () => {
  let core: TestCore
  let ana: Client
  type Snap = { agents: Agent[]; skills: Skill[]; messages: Message[] }
  type Tuca = { agentId: string; conversationId: string }

  beforeAll(async () => {
    core = await bootCore({ server: true })
    ana = core.connect()
    await ana.call('setMyName', { name: 'Ana' })
  }, 30_000)
  afterAll(() => {
    try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {}
  })

  it('a card changes the skills and nothing else, and the agent keeps running', async () => {
    await ana.call<Skill>('saveSkill', { skill: { name: 'tucano-ops', description: 'When running the harness.', body: 'Steps.', agents: [] } })
    await ana.call<Skill>('saveSkill', { skill: { name: 'other-one', description: 'When doing the other thing.', body: 'Steps.', agents: [] } })
    const tuca = await ana.call<Tuca>('ensureTuca', {})
    const snapshots = async (): Promise<Snap> => ana.call<Snap>('snapshot')
    const answered = async (since: number): Promise<Message | undefined> =>
      (await snapshots()).messages.find((m) => m.at > since && m.conversationId === tuca.conversationId && m.author.kind === 'agent' && m.run?.status === 'done')
    const until = async (ok: () => Promise<unknown>): Promise<void> => {
      const end = Date.now() + 30_000
      while (!(await ok())) {
        if (Date.now() > end) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    // The first turn after a boot can't reach the gateway yet: one plain exchange, then the ask.
    await ana.call('sendMessage', { conversationId: tuca.conversationId, text: 'oi' })
    await until(async () => answered(Date.now() - 60_000))
    await ana.call('sendMessage', { conversationId: tuca.conversationId, text: 'Deixa o Theo só a skill tucano-ops, por favor.' })
    let card: Message | undefined
    await until(async () => {
      card = (await snapshots()).messages.find((m) => m.conversationId === tuca.conversationId && m.run?.status === 'done' && proposalsOf(m.run).length > 0)
      return card
    })
    const p = proposalsOf(card!.run)[0]!
    expect(p).toMatchObject({ kind: 'agent', changes: { skills: ['tucano-ops'] } })
    // Nothing has changed yet: both skills are still everyone's.
    let snap = await snapshots()
    expect(snap.skills.map((k) => k.name).sort()).toEqual(['other-one', 'tucano-ops'])
    expect(snap.skills.every((k) => k.agents.length === 0)).toBe(true)
    await ana.call('applyProposal', { messageId: card!.id, index: 0 })
    snap = await snapshots()
    const theo = snap.agents.find((a) => a.handle === 'theo')!
    const kept = snap.skills.find((k) => k.name === 'tucano-ops')!
    const gone = snap.skills.find((k) => k.name === 'other-one')!
    expect(kept.agents).toEqual([]) // everyone already has it: nothing to write
    expect(gone.agents).not.toContain(theo.id)
    expect(gone.agents).toContain(snap.agents.find((a) => a.handle === 'lia')!.id)
    expect(proposalsOf((await snapshots()).messages.find((m) => m.id === card!.id)?.run)[0]!.state).toBe('applied')
    await expect(ana.call('applyProposal', { messageId: card!.id, index: 0 })).rejects.toThrow(/já foi aplicada/)
    // Theo is still a working agent: its DM answers.
    const dm = await ana.call<{ id?: string }>('openDm', { agentId: theo.id })
    expect(dm?.id ?? dm).toBeTruthy()
  }, 90_000)
})
