// The map's physics: a wiki big enough used to fling its pages to infinity (the spring's
// pull grows with the distance, and two pages too close oscillate through each other),
// which landed every page on the same spot of the screen. No force may do that.
import { describe, expect, it } from 'vitest'
import { tick, type Body } from '../src/renderer/src/components/Wiki'

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
