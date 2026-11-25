// The Tuca's screen in the full app: what sits beside his conversation (the team, or the proposal of an
// agent), and what the team's rows say of the request in hand.
import { beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { Agent, Approval, Delegation, Message } from '../src/shared/types'
import { latestAsk, requestOf, subjectOf, teamLine, teamRows, tucaStage } from '../src/renderer/src/tuca-screen'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', ...extra }) as Agent
const tuca = agent('tuca', { kind: 'tuca' })
const duda = agent('duda', { role: 'Atendimento' })
const theo = agent('theo', { role: 'Dados' })
const person = (id: string, at: number, threadId?: string): Message => ({ id, conversationId: 'c1', author: { kind: 'person', id: 'ana' }, text: id, at, ...(threadId ? { threadId } : {}) }) as Message
const draft = (id: string, at: number, state?: 'created' | 'dismissed' | 'undone'): Message => ({ id, conversationId: 'c1', author: { kind: 'agent', id: 'tuca' }, text: '', at, run: { status: 'done', steps: [], agentDraft: { name: 'Léo', ...(state ? { state } : {}) } } }) as unknown as Message
const part = (id: string, to: string, state: Delegation['state'], extra: Partial<Delegation> = {}): Delegation =>
  ({ id, from: 'tuca', to, conversationId: `dm-${to}`, rootId: `r-${id}`, originConversationId: 'c1', originThreadId: 'p1', originMessageId: 'a1', requestedBy: 'ana', text: `faça ${id}`, state, createdAt: Number(id.slice(1)), ...extra }) as Delegation
const s = (p: { agents?: Agent[]; delegations?: Delegation[]; approvals?: Approval[] } = {}) => ({ agents: [tuca, duda, theo], delegations: [], approvals: [], ...p })

beforeEach(() => setLang('pt'))

describe('what the request in hand is', () => {
  it('the latest thing the person asked out of a thread, and what he passed on for it', () => {
    const messages = [person('p1', 5), person('answer', 7, 'p1'), person('p2', 9)]
    expect(latestAsk(messages)!.id).toBe('p2')
    expect(latestAsk([person('p1', 5), person('answer', 7, 'p1')])!.id).toBe('p1') // a card's answer is not a new ask
    const all = [part('d2', 'theo', 'open'), part('d1', 'duda', 'done'), part('d3', 'duda', 'open', { originThreadId: 'p2' }), part('d4', 'duda', 'open', { originConversationId: 'other' }), part('d5', 'duda', 'open', { from: 'lia' })]
    expect(requestOf(s({ delegations: all }), 'tuca', 'c1', person('p1', 5)).map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(requestOf(s({ delegations: all }), 'tuca', 'c1', undefined)).toEqual([])
  })
})

describe('what sits beside the conversation', () => {
  it('the team, once there is one and nothing is being built', () => {
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5)])).toBe('team')
    expect(subjectOf(s(), 'tuca', 'c1', [])).toBe('team')
  })

  it('the proposal: with no one on the team, with one to decide, and right after its agent was made', () => {
    expect(subjectOf(s({ agents: [tuca] }), 'tuca', 'c1', [])).toBe('build')
    expect(subjectOf(s({ agents: [tuca, agent('old', { archived: true })] }), 'tuca', 'c1', [])).toBe('build')
    expect(tucaStage(draft('m1', 10))).toBe('proposal')
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5), draft('m1', 10)])).toBe('build')
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5), draft('m1', 10, 'created')])).toBe('build')
    // ...until the person asks for something else, or closes the card.
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5), draft('m1', 10, 'created'), person('p2', 20)])).toBe('team')
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5), draft('m1', 10, 'created')], { closed: 'm1' })).toBe('team')
    // A proposal discarded or taken back is a conversation again.
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5), draft('m1', 10, 'dismissed')])).toBe('team')
    expect(subjectOf(s(), 'tuca', 'c1', [person('p1', 5), draft('m1', 10, 'undone')])).toBe('team')
  })

  it('"to make an agent" holds until something asked after that is passed on', () => {
    const asked = s({ delegations: [part('d1', 'duda', 'done')] })
    // Opened to make one, before the conversation is known; then with what was asked last at that moment.
    expect(subjectOf(asked, 'tuca', 'c1', [person('p1', 5)], { build: {} })).toBe('build')
    expect(subjectOf(asked, 'tuca', 'c1', [person('p1', 5)], { build: { asked: 'p1' } })).toBe('build')
    // Something new that he answers himself: still building.
    expect(subjectOf(asked, 'tuca', 'c1', [person('p1', 5), person('p2', 9)], { build: { asked: 'p1' } })).toBe('build')
    // Something new that he passes on: the team is the subject again.
    expect(subjectOf(s({ delegations: [part('d2', 'duda', 'open', { originThreadId: 'p2' })] }), 'tuca', 'c1', [person('p1', 5), person('p2', 9)], { build: { asked: 'p1' } })).toBe('team')
    expect(subjectOf(s(), 'tuca', 'c1', [], { build: { asked: '' } })).toBe('build')
  })
})

describe("the team's rows", () => {
  it('whoever has a part comes first, in the order asked, with how it stands; the rest are at rest', () => {
    const rows = teamRows(s({ delegations: [part('d2', 'duda', 'failed'), part('d1', 'theo', 'open')] }), 'tuca', 'c1', [person('p1', 5)])
    expect(rows.map((r) => `${r.agent.name}:${r.asked?.label ?? '-'}:${r.asked?.tone ?? '-'}`)).toEqual(['Theo:trabalhando:live', 'Duda:não terminou:warn'])
    expect(rows[0]!.asked).toMatchObject({ text: 'faça d1', conversationId: 'dm-theo', open: 'r-d1' })
    expect(teamLine(rows)).toBe('2 neste pedido · 1 trabalhando')
    const rest = teamRows(s(), 'tuca', 'c1', [person('p1', 5)])
    expect(rest.map((r) => `${r.agent.name}:${r.asked ? 'x' : '-'}`)).toEqual(['Duda:-', 'Theo:-'])
    expect(teamLine(rest)).toBe('Quem faz o que você pede')
  })

  it('each way a part can stand, and the newest when one was asked twice', () => {
    const one = (d: Delegation, approvals: Approval[] = []): string => teamRows(s({ delegations: [d], approvals }), 'tuca', 'c1', [person('p1', 5)])[0]!.asked!.label
    expect(one(part('d1', 'duda', 'done'))).toBe('concluído')
    expect(one(part('d1', 'duda', 'cancelled'))).toBe('cancelado')
    expect(one(part('d1', 'duda', 'open', { asking: 'm9' }))).toBe('com uma dúvida')
    expect(one(part('d1', 'duda', 'open', { approval: 'ap1' }), [{ id: 'ap1', state: 'pending' } as Approval])).toBe('espera sua aprovação')
    expect(one(part('d1', 'duda', 'open', { approval: 'ap1' }), [{ id: 'ap1', state: 'approved' } as Approval])).toBe('trabalhando')
    const twice = teamRows(s({ delegations: [part('d1', 'duda', 'done'), part('d2', 'duda', 'open')] }), 'tuca', 'c1', [person('p1', 5)])
    expect(twice.filter((r) => r.asked).map((r) => r.asked!.text)).toEqual(['faça d2'])
    expect(teamLine(teamRows(s({ delegations: [part('d1', 'duda', 'failed'), part('d2', 'theo', 'done')] }), 'tuca', 'c1', [person('p1', 5)]))).toBe('2 neste pedido · 1 pede atenção')
    expect(teamLine(teamRows(s({ delegations: [part('d1', 'duda', 'done')] }), 'tuca', 'c1', [person('p1', 5)]))).toBe('1 neste pedido · tudo de volta')
  })

  it('a part from a thread with no origin thread falls back on when it was asked', () => {
    const d = part('d9', 'duda', 'open', { originThreadId: undefined, createdAt: 9 })
    expect(requestOf(s({ delegations: [d] }), 'tuca', 'c1', person('p1', 5)).map((x) => x.id)).toEqual(['d9'])
    expect(requestOf(s({ delegations: [d] }), 'tuca', 'c1', person('p1', 50))).toEqual([])
  })
})
