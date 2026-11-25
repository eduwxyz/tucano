// The map's physics: a wiki big enough used to fling its pages to infinity (the spring's
// pull grows with the distance, and two pages too close oscillate through each other),
// which landed every page on the same spot of the screen. No force may do that.
import { describe, expect, it } from 'vitest'
import { fitLabels, tick, forTheMap, type Body } from '../src/renderer/src/components/Wiki'

type Graph = Parameters<typeof forTheMap>[0]
import { repelGrouped } from '../src/renderer/src/components/wiki-quadtree'

// a dense wiki like the one that broke it: many pages, most of them linked to a few
const settle = (n: number): Body[] => {
  const bodies: Body[] = Array.from({ length: n }, (_, i) => ({ x: Math.cos(i * 2.399963) * 16 * Math.sqrt(i + 1), y: Math.sin(i * 2.399963) * 16 * Math.sqrt(i + 1), vx: 0, vy: 0 }))
  const links: (readonly [number, number])[] = []
  for (let i = 1; i < n; i++) links.push([i, (i * 7) % i] as const)
  const deg = new Uint16Array(n)
  for (const [a, b] of links) deg[a]!++, deg[b]!++
  const iters = n > 250 ? 140 : 300
  for (let it = 0; it < iters; it++) tick(bodies, links, deg, 0.3 + (1 - it / iters))
  return bodies
}

describe('the wiki map settles without flinging pages away', () => {
  it('keeps every page in place at sizes that used to explode, and spreads them out', () => {
    for (const n of [50, 120, 200, 358]) {
      const bodies = settle(n)
      let far = 0
      for (const b of bodies) {
        expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true)
        far = Math.max(far, Math.abs(b.x), Math.abs(b.y))
      }
      // not collapsed on one spot, not flung away: a few hundred units of map
      expect(far).toBeGreaterThan(100)
      expect(far).toBeLessThan(5000)
    }
  })
})

// A wiki of thousands of pages (an imported vault) froze the screen for seconds when the map
// opened: every page was compared with every other, a hundred times. Far pages now push as one.
describe('a big wiki map', () => {
  const spiral = (n: number): Body[] => Array.from({ length: n }, (_, i) => ({ x: Math.cos(i * 2.399963) * 16 * Math.sqrt(i + 1), y: Math.sin(i * 2.399963) * 16 * Math.sqrt(i + 1), vx: 0, vy: 0 }))

  it('pushes the pages about as the exact sum does', () => {
    const exact = spiral(1500)
    const grouped = exact.map((b) => ({ ...b }))
    for (let i = 0; i < exact.length; i++)
      for (let j = i + 1; j < exact.length; j++) {
        const a = exact[i]!
        const b = exact[j]!
        const dx = a.x - b.x
        const dy = a.y - b.y
        const f = 70 / Math.max(dx * dx + dy * dy, 30)
        a.vx += dx * f
        a.vy += dy * f
        b.vx -= dx * f
        b.vy -= dy * f
      }
    repelGrouped(grouped)
    let err = 0
    let size = 0
    for (let i = 0; i < exact.length; i++) {
      err += Math.hypot(exact[i]!.vx - grouped[i]!.vx, exact[i]!.vy - grouped[i]!.vy)
      size += Math.hypot(exact[i]!.vx, exact[i]!.vy)
    }
    expect(err / size).toBeLessThan(0.05)
  })

  // Twenty steps are enough to tell the grouped push from every pair compared, and light enough
  // for a busy CI machine: about 0.2 s against 3 s on a recent laptop.
  it('steps nine thousand pages in a fraction of the time comparing every pair would take, spread out and in place', () => {
    const n = 9000
    const bodies = spiral(n)
    const links: (readonly [number, number])[] = []
    for (let i = 1; i < n; i++) links.push([i, (i * 7) % i] as const)
    const deg = new Uint16Array(n)
    for (const [a, b] of links) deg[a]!++, deg[b]!++
    const t = performance.now()
    for (let it = 0; it < 20; it++) tick(bodies, links, deg, 0.3 + (1 - it / 20))
    expect(performance.now() - t).toBeLessThan(2000) // ~0.2 s here, every pair ~3 s
    let far = 0
    for (const b of bodies) {
      expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true)
      far = Math.max(far, Math.abs(b.x), Math.abs(b.y))
    }
    expect(far).toBeGreaterThan(100)
  }, 20_000)
})

// A big wiki's map was a wall of names on top of each other, and half its dots were notes nobody
// wrote yet. The names drawn now fit without covering each other, and those notes stay off a big map.
describe('a big wiki map stays readable', () => {
  it('leaves the notes nobody wrote yet off a big wiki, and keeps them on a small one', () => {
    const pages = (n: number): Graph['nodes'] => Array.from({ length: n }, (_, i) => ({ title: `p${i}`, kind: 'note', links: 1 }))
    const ghost = { title: 'word', kind: 'note', links: 1, missing: true }
    const small = { nodes: [...pages(10), ghost], edges: [['p0', 'word'], ['p0', 'p1']] as [string, string][] }
    expect(forTheMap(small)).toBe(small)
    const big = { nodes: [...pages(1001), ghost], edges: [['p0', 'word'], ['p0', 'p1']] as [string, string][] }
    const shown = forTheMap(big)
    expect(shown.nodes.some((n) => n.missing)).toBe(false)
    expect(shown.nodes).toHaveLength(1001)
    expect(shown.edges).toEqual([['p0', 'p1']])
  })

  it('draws one dot per title, with one link between two of them', () => {
    const g = { nodes: [{ title: 'Untitled', kind: 'note', links: 1 }, { title: 'a', kind: 'note', links: 2 }, { title: 'Untitled', kind: 'note', links: 3 }], edges: [['Untitled', 'a'], ['a', 'Untitled']] as [string, string][] }
    const shown = forTheMap(g)
    expect(shown.nodes.map((n) => n.title)).toEqual(['Untitled', 'a'])
    expect(shown.nodes[0]!.links).toBe(3)
    expect(shown.edges).toEqual([['Untitled', 'a']])
  })

  it('draws the most linked names that fit, never one over another, and always the one asked for', () => {
    // a pile of names on the same spot, and one far away
    const items = [
      ...Array.from({ length: 50 }, (_, i) => ({ title: `n${i}`, x: 100 + (i % 3), y: 100, w: 80, first: false, links: i })),
      { title: 'far', x: 600, y: 600, w: 80, first: false, links: 0 },
      { title: 'lit', x: 101, y: 101, w: 80, first: true, links: 0 }
    ]
    const named = fitLabels(items)
    expect(named.has('lit')).toBe(true)
    expect(named.has('far')).toBe(true)
    expect([...named].filter((t) => t.startsWith('n'))).toHaveLength(0)
    const apart = fitLabels(items.filter((i) => i.title !== 'lit'))
    expect(apart.has('n49')).toBe(true)
    expect(apart.size).toBe(2)
    expect(fitLabels(Array.from({ length: 1000 }, (_, i) => ({ title: `m${i}`, x: (i % 40) * 200, y: Math.floor(i / 40) * 40, w: 60, first: false, links: 1 })), 220).size).toBe(220)
  })
})
