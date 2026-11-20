import { describe, expect, it } from 'vitest'
import { askKind, bossOf, entriesOf, entryOf, channelsOf, depthBelow, directReports, headsOf, looseColleaguesOf, loops, orgTree, peersOf, possibleBosses, reachOf, reportsOf, sectorName, sectorOf, type OrgNode } from '../src/shared/org'

const a = (id: string, reportsTo?: string, extra: { archived?: boolean; kind?: 'tuca'; entry?: boolean } = {}): { id: string; reportsTo?: string; archived?: boolean; kind?: 'tuca'; entry?: boolean } => ({ id, ...(reportsTo ? { reportsTo } : {}), ...extra })
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
    // Anyone not below it will do, however long the line gets.
    expect(ids(possibleBosses(withOthers, 'bento'))).toEqual(['orion', 'atlas', 'clara', 'otto', 'solo'])
    expect(ids(possibleBosses(withOthers, 'atlas'))).toEqual(['orion', 'bento', 'clara', 'nico', 'vera', 'otto', 'solo'])
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

  it('reaches those below first, then colleagues, then its own boss and its sector\'s head, never across', () => {
    expect(ids(reachOf(team, 'bento'))).toEqual(['nico', 'vera', 'atlas', 'clara', 'orion'])
    expect(ids(reachOf(team, 'nico'))).toEqual(['vera', 'bento', 'orion']) // its boss, then the head two steps up
    expect(ids(reachOf(team, 'otto'))).toEqual(['clara', 'orion'])
    expect(ids(reachOf(team, 'orion'))).toEqual(['atlas', 'bento', 'clara', 'nico', 'vera', 'otto'])
    expect(reachOf(team, 'solo')).toEqual([])
  })
})

describe('a team nobody drew', () => {
  it('makes colleagues of the agents in no tree, who may ask each other', () => {
    const flat = [a('lia'), a('theo'), a('nina'), a('tuca', undefined, { kind: 'tuca' }), a('old', undefined, { archived: true }), a('porta', undefined, { entry: true })]
    expect(ids(reachOf(flat, 'lia'))).toEqual(['theo', 'nina'])
    expect(ids(reachOf(flat, 'nina'))).toEqual(['lia', 'theo'])
    expect(askKind(flat, 'lia', 'theo')).toBe('peer')
    // The Tuca builds the others, the archived are away, and an entry point the person chose keeps its own ways.
    expect(reachOf(flat, 'tuca')).toEqual([])
    expect(reachOf(flat, 'porta')).toEqual([])
    expect(ids(looseColleaguesOf(flat, 'lia'))).not.toContain('porta')
  })

  it('keeps those in a tree to the tree, and the ones outside it among themselves', () => {
    expect(looseColleaguesOf(team, 'nico')).toEqual([])
    expect(looseColleaguesOf(team, 'orion')).toEqual([])
    expect(reachOf(team, 'solo')).toEqual([]) // the only one outside
    const more = [...team, a('lia')]
    expect(ids(reachOf(more, 'solo'))).toEqual(['lia'])
    expect(ids(reachOf(more, 'orion'))).toEqual(['atlas', 'bento', 'clara', 'nico', 'vera', 'otto'])
  })
})

// Two trees, two sectors: orion's and mira's (mira ← lino ← tito). Solo heads none: no one is below it.
const sectors = [...team, a('mira'), a('lino', 'mira'), a('tito', 'lino'), a('tuca', undefined, { kind: 'tuca' }), a('old', undefined, { archived: true }), a('gil', 'old')]

describe('sectors', () => {
  it('makes a sector of each tree, headed by its top, the Tuca and the lone aside', () => {
    expect(ids(headsOf(sectors))).toEqual(['orion', 'mira'])
    expect(sectorOf(sectors, 'nico')?.id).toBe('orion')
    expect(sectorOf(sectors, 'tito')?.id).toBe('mira')
    expect(sectorOf(sectors, 'mira')?.id).toBe('mira')
    expect(sectorOf(sectors, 'solo')).toBeUndefined()
    expect(sectorOf(sectors, 'gil')).toBeUndefined() // its boss is archived and it heads no one
  })

  it('lets only heads reach another sector, and only its head', () => {
    expect(ids(reachOf(sectors, 'orion'))).toEqual(['atlas', 'bento', 'clara', 'nico', 'vera', 'otto', 'mira'])
    expect(ids(reachOf(sectors, 'mira'))).toEqual(['lino', 'tito', 'orion'])
    expect(ids(reachOf(sectors, 'lino'))).toEqual(['tito', 'mira']) // up to its head, not across
    expect(ids(reachOf(sectors, 'tito'))).toEqual(['lino', 'mira']) // straight to its sector's head, past Lino
  })

  it('makes an agent the person chose the entry point, over the sectors and in none', () => {
    // Nothing is read off the tree: Orion over Bento's and Clara's teams heads one deep sector until chosen.
    expect(entriesOf(team)).toEqual([])
    expect(ids(headsOf(team))).toEqual(['orion'])
    // Chosen: orion ← atlas, bento, clara; bento ← nico, vera; clara ← otto. Mira's tree stays a sector beside it.
    const chosen = sectors.map((x) => (x.id === 'orion' ? { ...x, entry: true } : x))
    expect(entryOf(chosen)?.id).toBe('orion')
    expect(ids(headsOf(chosen))).toEqual(['bento', 'clara', 'mira'])
    expect(sectorOf(chosen, 'nico')?.id).toBe('bento')
    expect(sectorOf(chosen, 'orion')).toBeUndefined() // over the sectors, in none
    expect(sectorOf(chosen, 'atlas')).toBeUndefined() // answers to the entry point, with no team of its own
    // Heads ask each other as sectors, pass up to the entry point, and it hands down to them.
    expect(askKind(chosen, 'bento', 'clara')).toBe('sector')
    expect(askKind(chosen, 'bento', 'mira')).toBe('sector')
    expect(askKind(chosen, 'bento', 'orion')).toBe('up')
    expect(askKind(chosen, 'orion', 'bento')).toBe('down')
    expect(askKind(chosen, 'orion', 'mira')).toBe('sector') // a sector beside it, not below
    expect(askKind(chosen, 'nico', 'bento')).toBe('up')
    expect(askKind(chosen, 'bento', 'bento')).toBe('peer')
    // A member reaches its sector's head, not the entry point past it; the entry point reaches every head.
    expect(ids(reachOf(chosen, 'nico'))).toEqual(['vera', 'bento'])
    expect(ids(reachOf(chosen, 'bento'))).toEqual(['nico', 'vera', 'atlas', 'clara', 'orion', 'mira'])
    expect(ids(reachOf(chosen, 'orion'))).toEqual(['atlas', 'bento', 'clara', 'nico', 'vera', 'otto', 'mira'])
    // Alone, chosen, with no one below: an entry point all the same. Under someone, archived or the Tuca: not one.
    expect(ids(entriesOf([a('solo', undefined, { entry: true }), a('x'), a('y', 'x', { entry: true }), a('old', undefined, { entry: true, archived: true })]))).toEqual(['solo'])
  })

  it('tells how a request goes', () => {
    expect(askKind(sectors, 'orion', 'nico')).toBe('down')
    expect(askKind(sectors, 'nico', 'vera')).toBe('peer')
    expect(askKind(sectors, 'tito', 'lino')).toBe('up')
    expect(askKind(sectors, 'tito', 'mira')).toBe('up') // the sector's head, two steps up
    expect(askKind(sectors, 'mira', 'orion')).toBe('sector')
  })

  it('names a sector by what it was given, or by its head', () => {
    expect(sectorName({ name: 'Rafa', sectorName: ' Técnico ' })).toBe('Técnico')
    expect(sectorName({ name: 'Teo' })).toBe('Setor de Teo')
    expect(sectorName({ name: 'Teo', sectorName: '  ' }, 'Sector of')).toBe('Sector of Teo')
  })
})
