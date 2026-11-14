import { describe, expect, it } from 'vitest'
import { bossOf, channelsOf, depthBelow, directReports, loops, MAX_LINE, orgTree, overLine, peersOf, possibleBosses, rankOf, reachOf, reportsOf, type OrgNode } from '../src/shared/org'

const a = (id: string, reportsTo?: string, extra: { archived?: boolean; kind?: 'tuca' } = {}): { id: string; reportsTo?: string; archived?: boolean; kind?: 'tuca' } => ({ id, ...(reportsTo ? { reportsTo } : {}), ...extra })
const ids = (list: { id: string }[]): string[] => list.map((x) => x.id)

// orion ← atlas, bento, clara; bento ← nico, vera; clara ← otto
const team = [a('orion'), a('atlas', 'orion'), a('bento', 'orion'), a('clara', 'orion'), a('nico', 'bento'), a('vera', 'bento'), a('otto', 'clara'), a('solo')]

describe('who answers to whom', () => {
  it('lists those straight below, and everyone below with the nearest first', () => {
    expect(ids(directReports(team, 'orion'))).toEqual(['atlas', 'bento', 'clara'])
    expect(ids(reportsOf(team, 'orion'))).toEqual(['atlas', 'bento', 'clara', 'nico', 'vera', 'otto'])
    expect(ids(reportsOf(team, 'bento'))).toEqual(['nico', 'vera'])
    expect(reportsOf(team, 'solo')).toEqual([])
    expect(depthBelow(team, 'orion')).toBe(2)
    expect(depthBelow(team, 'solo')).toBe(0)
  })

  it('has no tree at all when no one answers to anyone', () => {
    const flat = [a('lia'), a('theo'), a('nina')]
    expect(flat.flatMap((x) => reportsOf(flat, x.id))).toEqual([])
  })

  it('refuses a boss that would close a loop, itself, the Tuca and the archived', () => {
    expect(loops(team, 'orion', 'nico')).toBe(true)
    expect(loops(team, 'orion', 'orion')).toBe(true)
    expect(loops(team, 'nico', 'orion')).toBe(false)
    const withOthers = [...team, a('tuca', undefined, { kind: 'tuca' }), a('old', undefined, { archived: true })]
    // Bento has people below: under Atlas, Clara or Otto its line would be too long (see the next one).
    expect(ids(possibleBosses(withOthers, 'bento'))).toEqual(['orion', 'solo'])
    expect(ids(possibleBosses(withOthers, 'atlas'))).toEqual(['orion', 'bento', 'clara', 'solo'])
  })

  it('keeps a line to three agents from top to bottom', () => {
    expect(MAX_LINE).toBe(3)
    expect([rankOf(team, 'orion'), rankOf(team, 'bento'), rankOf(team, 'nico'), rankOf(team, 'solo'), rankOf(team, 'nobody')]).toEqual([1, 2, 3, 1, 1])
    // Under someone at the bottom of a full line: one too many.
    expect(overLine(team, 'solo', 'nico')).toBe(true)
    expect(overLine(team, 'solo', 'bento')).toBe(false)
    // With someone below, it's the whole branch that has to fit.
    expect(overLine(team, 'bento', 'atlas')).toBe(true)
    expect(overLine(team, 'bento', 'solo')).toBe(false)
    expect(overLine(team, 'orion', 'solo')).toBe(true) // Orion has two levels below already
    // An archived one in the middle doesn't count: whoever answered to it answers to its boss meanwhile.
    const gone = team.map((x) => (x.id === 'bento' ? { ...x, archived: true } : x))
    expect(rankOf(gone, 'nico')).toBe(2)
    expect(overLine(gone, 'solo', 'nico')).toBe(false)
    // A loop left by hand ends the count.
    expect(rankOf([a('x', 'y'), a('y', 'x')], 'x')).toBe(2)
  })

  it('passes over an archived boss: its people answer to the one above it meanwhile', () => {
    const away = team.map((x) => (x.id === 'bento' ? { ...x, archived: true } : x))
    expect(bossOf(away, away.find((x) => x.id === 'nico')!)?.id).toBe('orion')
    expect(ids(reportsOf(away, 'orion'))).toEqual(['atlas', 'clara', 'nico', 'vera', 'otto'])
  })

  it('walks a loop left by hand once', () => {
    const loop = [a('x', 'y'), a('y', 'x')]
    expect(ids(reportsOf(loop, 'x'))).toEqual(['y'])
    expect(depthBelow(loop, 'x')).toBe(1)
  })

  it('draws the tree from those with someone below, and leaves the rest apart', () => {
    const shape = (n: OrgNode<{ id: string }>): unknown => (n.kids.length ? { [n.agent.id]: n.kids.map(shape) } : n.agent.id)
    const { roots, loose } = orgTree(team)
    expect(roots.map(shape)).toEqual([{ orion: ['atlas', { bento: ['nico', 'vera'] }, { clara: ['otto'] }] }])
    expect(ids(loose)).toEqual(['solo'])
    // No one answering to anyone: no tree, everyone apart. A loop left by hand is apart too, never lost.
    expect(orgTree([a('lia'), a('theo')])).toEqual({ roots: [], loose: [a('lia'), a('theo')] })
    expect(ids(orgTree([a('x', 'y'), a('y', 'x'), a('z')]).loose)).toEqual(['x', 'y', 'z'])
    // An archived one is in neither.
    expect(ids(orgTree([a('lia'), a('old', 'lia', { archived: true })]).loose)).toEqual(['lia'])
  })

  it("names an agent's channels, never its DMs", () => {
    const convs = [{ id: 'd', kind: 'dm' as const, members: ['clara'] }, { id: 'c1', kind: 'channel' as const, members: ['clara', 'otto'] }, { id: 'c2', kind: 'channel' as const, members: ['bento'] }, { id: 'c3', kind: 'channel' as const, members: ['clara'] }]
    expect(channelsOf(convs, 'clara').map((c) => c.id)).toEqual(['c1', 'c3'])
  })

  it('makes colleagues of those who answer to the same agent, and of no one else', () => {
    expect(ids(peersOf(team, 'nico'))).toEqual(['vera'])
    expect(ids(peersOf(team, 'bento'))).toEqual(['atlas', 'clara'])
    expect(peersOf(team, 'otto')).toEqual([]) // alone under Clara
    expect(peersOf(team, 'orion')).toEqual([]) // answers to no agent
    expect(peersOf(team, 'solo')).toEqual([])
    // An archived boss is passed over: its reports become colleagues of its own colleagues meanwhile.
    const gone = team.map((x) => (x.id === 'bento' ? { ...x, archived: true } : x))
    expect(ids(peersOf(gone, 'nico'))).toEqual(['atlas', 'clara', 'vera'])
  })

  it('reaches those below first, then colleagues, never up nor across', () => {
    expect(ids(reachOf(team, 'bento'))).toEqual(['nico', 'vera', 'atlas', 'clara'])
    expect(ids(reachOf(team, 'nico'))).toEqual(['vera'])
    expect(ids(reachOf(team, 'orion'))).toEqual(['atlas', 'bento', 'clara', 'nico', 'vera', 'otto'])
    expect(reachOf(team, 'solo')).toEqual([])
  })
})
