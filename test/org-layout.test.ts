import { describe, expect, it } from 'vitest'
import { orgTree } from '../src/shared/org'
import { above, BOARD as B, boundsOf, curve, fitView, layoutOrg, MAX_K, ME, MIN_K, ORG_SIZES as S, pathBetween, spotsOf, tidyBoard, toBoard, under, zoomAt } from '../src/shared/org-layout'

const a = (id: string, reportsTo?: string): { id: string; reportsTo?: string } => ({ id, ...(reportsTo ? { reportsTo } : {}) })
const at = (l: ReturnType<typeof layoutOrg>, id: string): { x: number; y: number } => l.nodes.find((n) => n.id === id)!
const mid = (l: ReturnType<typeof layoutOrg>, id: string): number => at(l, id).x + S.w / 2

describe('where the organogram puts each card', () => {
  it('is me alone when no one answers to anyone', () => {
    const l = layoutOrg(orgTree([a('lia'), a('theo')]).roots)
    expect(l.nodes).toEqual([{ id: ME, x: 0, y: 0 }])
    expect(l.edges).toEqual([])
    expect(l).toMatchObject({ width: S.w, height: S.h })
  })

  it('stacks those with no one below under their boss, to its right', () => {
    const l = layoutOrg(orgTree([a('lia'), a('theo', 'lia'), a('nina', 'lia')]).roots)
    // Me over Lia, both in the same column.
    expect(at(l, ME).x).toBe(at(l, 'lia').x)
    expect(at(l, 'lia').y).toBe(S.h + S.gapY)
    expect(at(l, 'theo')).toMatchObject({ x: at(l, 'lia').x + S.indent, y: at(l, 'lia').y + S.h + S.stackGap })
    expect(at(l, 'nina')).toMatchObject({ x: at(l, 'theo').x, y: at(l, 'theo').y + S.h + S.stackGap })
    expect(l.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['lia>theo', 'lia>nina', 'me>lia'])
    expect(l.width).toBe(S.indent + S.w)
    expect(l.height).toBe(at(l, 'nina').y + S.h)
  })

  it('spreads a level that goes on sideways, each boss centered over its own', () => {
    // orion ← bento (← nico, vera), clara (← otto), atlas
    const l = layoutOrg(orgTree([a('orion'), a('bento', 'orion'), a('clara', 'orion'), a('atlas', 'orion'), a('nico', 'bento'), a('vera', 'bento'), a('otto', 'clara')]).roots)
    const row = at(l, 'bento').y
    expect([at(l, 'clara').y, at(l, 'atlas').y]).toEqual([row, row])
    // Left to right as they were made, never overlapping.
    expect(at(l, 'clara').x).toBeGreaterThanOrEqual(at(l, 'bento').x + S.indent + S.w + S.gapX)
    expect(at(l, 'atlas').x).toBeGreaterThanOrEqual(at(l, 'clara').x + S.indent + S.w + S.gapX)
    // Orion sits halfway between its first and its last, and me right over Orion.
    expect(mid(l, 'orion')).toBeCloseTo((mid(l, 'bento') + mid(l, 'atlas')) / 2)
    expect(mid(l, ME)).toBeCloseTo(mid(l, 'orion'))
    // Nothing off the canvas, and no two cards on top of each other.
    for (const n of l.nodes) expect(n.x).toBeGreaterThanOrEqual(0)
    const boxes = l.nodes.map((n) => `${Math.round(n.x)},${n.y}`)
    expect(new Set(boxes).size).toBe(boxes.length)
    for (const p of l.nodes) for (const q of l.nodes) if (p !== q && p.y === q.y) expect(Math.abs(p.x - q.x)).toBeGreaterThanOrEqual(S.w)
    expect(l.width).toBeCloseTo(Math.max(...l.nodes.map((n) => n.x)) + S.w)
  })

  it('draws every line from the boss down to the one below', () => {
    const l = layoutOrg(orgTree([a('orion'), a('bento', 'orion'), a('clara', 'orion'), a('nico', 'bento')]).roots)
    const line = (from: string, to: string): string => l.edges.find((e) => e.from === from && e.to === to)!.d
    // Straight down where one is right under the other; an elbow where it isn't.
    expect(line(ME, 'orion')).toBe(`M${mid(l, ME)} ${S.h}V${at(l, 'orion').y}`)
    expect(line('orion', 'clara')).toMatch(new RegExp(`^M${mid(l, 'orion')} ${at(l, 'orion').y + S.h}V.*V${at(l, 'clara').y}$`))
    // A stacked one is reached from the side, at its middle.
    expect(line('bento', 'nico')).toMatch(new RegExp(`H${at(l, 'nico').x}$`))
  })
})

describe('the lines a request travels', () => {
  const boss = (id: string): string | undefined => ({ nico: 'bento', bento: 'orion', clara: 'orion' })[id]
  it('goes from whoever asked to whoever does it, by way of everyone between', () => {
    expect(pathBetween(boss, 'orion', 'nico')).toEqual([['orion', 'bento'], ['bento', 'nico']])
    expect(pathBetween(boss, 'bento', 'nico')).toEqual([['bento', 'nico']])
    expect(pathBetween(boss, 'orion', 'clara')).toEqual([['orion', 'clara']])
  })
  it('is none when the one doing it is no longer below', () => {
    expect(pathBetween(boss, 'clara', 'nico')).toEqual([])
    expect(pathBetween(() => undefined, 'orion', 'nico')).toEqual([])
  })
})

describe('the board', () => {
  const tree = orgTree([a('lia'), a('theo', 'lia'), a('nina', 'lia'), a('duda'), a('otto')])
  const tidy = tidyBoard(tree.roots, tree.loose)

  it('lays the tree out sideways, me over the top, and those on their own in a row under it', () => {
    expect(tidy[ME]!.y).toBe(0)
    expect(tidy.lia!.y).toBe(B.h + B.gapY)
    // No stacking here: the two that answer to Lia are side by side, and she is centered over them.
    expect(tidy.theo!.y).toBe(tidy.nina!.y)
    expect(tidy.nina!.x - tidy.theo!.x).toBe(B.w + B.gapX)
    expect(tidy.lia!.x + B.w / 2).toBe((tidy.theo!.x + tidy.nina!.x + B.w) / 2)
    expect(tidy[ME]!.x).toBe(tidy.lia!.x)
    expect(tidy.duda!.y).toBe(tidy.theo!.y + B.h + B.gapY)
    expect(tidy.otto).toEqual({ x: tidy.duda!.x + B.w + B.gapX, y: tidy.duda!.y })
  })

  it('centers the tree over a row of loose ones that is wider than it', () => {
    const lone = orgTree([a('lia'), a('theo', 'lia'), a('x'), a('y'), a('z')])
    const t = tidyBoard(lone.roots, lone.loose)
    expect(t.x!.x).toBe(0)
    expect(t.lia!.x + B.w / 2).toBe(t.y!.x + B.w / 2)
  })

  it('keeps what was placed by hand, and puts whoever came after under everything', () => {
    const ids = [ME, 'lia', 'theo', 'nina', 'duda', 'otto']
    expect(spotsOf(ids, tidy, undefined)).toBe(tidy)
    expect(spotsOf(ids, tidy, { gone: { x: 1, y: 1 } })).toBe(tidy) // nothing of this board
    const spots = spotsOf(ids, tidy, { [ME]: { x: 0, y: 0 }, lia: { x: 400, y: 100 }, theo: { x: -50, y: 300 }, bad: { x: NaN, y: 0 } })
    expect(spots.lia).toEqual({ x: 400, y: 100 })
    expect(spots.theo).toEqual({ x: -50, y: 300 })
    expect(spots.nina).toEqual({ x: -50, y: 300 + B.h + B.gapY })
    expect(spots.duda).toEqual({ x: -50 + B.w + B.gapX, y: spots.nina!.y })
    expect(Object.keys(spots).sort()).toEqual([...ids].sort())
  })

  it('fits everything in the room there is, never larger than life', () => {
    const box = boundsOf([{ x: 100, y: 50 }, { x: 900, y: 450 }])
    expect(box).toEqual({ x: 100, y: 50, w: 800 + B.w, h: 400 + B.h })
    const small = fitView(box, { w: 600, h: 500 })
    expect(small.k).toBeCloseTo((600 - 112) / box.w)
    // Centered: as much room to the left of the box as to its right.
    expect(Math.abs(small.x + box.x * small.k - (600 - (small.x + (box.x + box.w) * small.k)))).toBeLessThanOrEqual(1)
    expect(fitView(box, { w: 4000, h: 3000 }).k).toBe(1)
    expect(fitView(box, { w: 50, h: 50 }).k).toBe(MIN_K)
    expect(boundsOf([])).toMatchObject({ w: B.w, h: B.h })
  })

  it('zooms around a point, within limits', () => {
    const view = { x: 100, y: 40, k: 1 }
    const at = { x: 300, y: 200 }
    const z = zoomAt(view, at, 1.5)
    expect(toBoard(z, at)).toEqual(toBoard(view, at)) // what was under the pointer still is
    expect(zoomAt(view, at, 99).k).toBe(MAX_K)
    expect(zoomAt(view, at, 0).k).toBe(MIN_K)
  })

  it('draws a line from under one card to above another, upright at both ends', () => {
    const from = under({ x: 0, y: 0 })
    const to = above({ x: 300, y: 200 })
    expect(from).toEqual({ x: B.w / 2, y: B.h })
    expect(to).toEqual({ x: 300 + B.w / 2, y: 200 })
    const d = curve(from, to)
    expect(d.startsWith(`M${from.x} ${from.y}C${from.x} `)).toBe(true)
    expect(d.endsWith(` ${to.x} ${to.y}`)).toBe(true)
    // The second handle is straight above the end, so the line arrives from above even when the card is higher.
    expect(curve({ x: 0, y: 300 }, { x: 200, y: 0 })).toBe('M0 300C0 450 200 -150 200 0')
  })
})
