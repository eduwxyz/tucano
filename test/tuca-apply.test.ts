// The rules for what the Tuca's proposals apply by themselves and what waits for a click
// (src/core/tuca-apply.ts), and what his prompt says about it.
import { describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, AgentDraft, Proposal, Run } from '../src/shared/types'
import { accessCard, agentStamp, appliesNow, changedSince, decidedCards, keepDecided, splitChange } from '../src/core/tuca-apply'
import { builderGuide } from '../src/core/tuca'

const lia = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Suporte', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, web: true, archived: false } as Agent

describe('what applies at once and what waits', () => {
  it('splits a change to an agent: name, model, effort and web now; connectors and the limit on their own card', () => {
    const p: Proposal = { kind: 'agent', agentId: 'a1', changes: { effort: 'high', web: false, grants: { c1: 'read' }, limit: 5000 }, before: { effort: 'low', web: true, grants: {}, limit: 1000 }, reason: 'Mais' }
    const { inside, access } = splitChange(p as Extract<Proposal, { kind: 'agent' }>)
    expect(inside).toMatchObject({ changes: { effort: 'high', web: false }, before: { effort: 'low', web: true } })
    expect(inside?.changes).not.toHaveProperty('grants')
    expect(access).toEqual({ kind: 'agent', agentId: 'a1', changes: { grants: { c1: 'read' }, limit: 5000 }, before: { grants: {}, limit: 1000 }, reason: 'Mais' })
    // Only access: nothing applies now. Nothing of access: the whole card applies.
    const onlyLimit = { kind: 'agent', agentId: 'a1', changes: { limit: 5000 } } as Extract<Proposal, { kind: 'agent' }>
    expect(splitChange(onlyLimit)).toEqual({ access: onlyLimit })
    const onlyName = { kind: 'agent', agentId: 'a1', changes: { name: 'Bia' } } as Extract<Proposal, { kind: 'agent' }>
    expect(splitChange(onlyName)).toEqual({ inside: onlyName })
  })

  it("a new agent's connectors become a card to confirm, and none makes no card", () => {
    expect(accessCard('a2', { name: 'Rafa', grants: { c1: 'read_write' } })).toMatchObject({ kind: 'agent', agentId: 'a2', changes: { grants: { c1: 'read_write' } }, before: { grants: {} } })
    expect(accessCard('a2', { name: 'Rafa', grants: {} })).toBeUndefined()
  })

  it('is on unless turned off, and never in the introduction', () => {
    expect(appliesNow({})).toBe(true)
    expect(appliesNow({ tucaApplyNow: false })).toBe(false)
    expect(appliesNow({ onboarding: { done: false } })).toBe(false)
    expect(appliesNow({ onboarding: { done: true } })).toBe(true)
  })
})

describe('what Desfazer checks first', () => {
  it('sees a field someone changed since, whatever the order of its keys', () => {
    expect(changedSince({ ...lia, effort: 'high' }, { effort: 'high' })).toEqual([])
    expect(changedSince({ ...lia, effort: 'medium' }, { effort: 'high', name: 'Lia' })).toEqual(['effort'])
    expect(changedSince({ ...lia, web: undefined }, { web: true })).toEqual([]) // unset web is on
    expect(changedSince({ ...lia, grants: { b: 'read', a: 'read' } }, { grants: { a: 'read', b: 'read' } })).toEqual([])
  })

  it("an agent's stamp moves with what someone would lose, not with its connectors or its use", () => {
    const s = agentStamp(lia)
    expect(agentStamp({ ...lia, grants: { c1: 'read' }, used: 500 })).toBe(s)
    expect(agentStamp({ ...lia, instructions: 'y' })).not.toBe(s)
    expect(agentStamp({ ...lia, computer: true })).not.toBe(s)
  })
})

describe('a card settled while its reply still works stays settled', () => {
  const team: Proposal = { id: 'p1', kind: 'team', agents: [] }
  const channel: Proposal = { id: 'p2', kind: 'channel', name: 'ops', members: [] }
  const draft = { id: 'd1', name: 'Rafa' } as AgentDraft
  it("the reply's copy takes what the stored message says of each card, by id, and keeps what it proposed since", () => {
    const mine: Run = { status: 'working', steps: [], proposals: [team, channel], agentDraft: draft }
    const stored: Run = { status: 'working', steps: [], proposals: [{ ...team, state: 'applied', appliedId: 'a1' }], agentDraft: { ...draft, state: 'created', agentId: 'a9' } }
    const kept = keepDecided(mine, stored)
    expect(kept.proposals).toEqual([{ ...team, state: 'applied', appliedId: 'a1' }, channel])
    expect(kept.agentDraft).toMatchObject({ state: 'created', agentId: 'a9' })
    // A card the reply replaced (a new id) is the reply's; nothing stored, nothing changes.
    expect(keepDecided({ status: 'working', steps: [], proposals: [{ ...team, id: 'p3' }] }, stored).proposals).toEqual([{ ...team, id: 'p3' }])
    expect(keepDecided(mine, undefined)).toBe(mine)
  })

  it('tried again, a reply keeps only its settled cards', () => {
    expect(decidedCards({ status: 'failed', steps: [], proposals: [{ ...team, state: 'applied' }, channel], agentDraft: draft })).toEqual({ proposals: [{ ...team, state: 'applied' }] })
    expect(decidedCards(undefined)).toEqual({})
  })
})

describe("the Tuca's prompt says how his proposals go in", () => {
  it('at once with Desfazer, without asking first; as cards when turned off; for a member, agents wait for an admin', () => {
    for (const lang of ['pt', 'en'] as const) {
      setLang(lang)
      const on = builderGuide({ tuca: true, me: 'Edu', applyNow: true, admin: true })
      expect(on).toContain(lang === 'pt' ? 'aplicado assim que sua resposta termina' : 'applied as soon as your reply ends')
      expect(on).toContain(lang === 'pt' ? 'não pergunte se pode' : "don't ask whether you may")
      expect(on).toContain(lang === 'pt' ? 'conectores' : 'connectors')
      expect(builderGuide({ tuca: true, me: 'Edu', applyNow: false })).toContain(lang === 'pt' ? 'nada muda até Edu aplicar' : 'nothing changes until Edu applies it')
      expect(builderGuide({ tuca: true, me: 'Bia', applyNow: true, admin: false })).toContain(lang === 'pt' ? 'não é admin' : "isn't an admin")
      expect(on).not.toContain(lang === 'pt' ? 'não é admin' : "isn't an admin")
    }
    setLang('pt')
  })
})
