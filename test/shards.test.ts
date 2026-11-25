import { describe, expect, it } from 'vitest'
import { heaviestFirst, pack, UNKNOWN } from './helpers/shards'

// How CI's machines share the test files (vitest.config.ts): by how long each takes.
describe('the tests split across machines', () => {
  const weights = { 'test/a.test.ts': 160, 'test/b.test.ts': 90, 'test/c.test.ts': 80, 'test/d.test.ts': 60, 'test/e.test.ts': 10 }
  const files = [...Object.keys(weights), 'test/new-1.test.ts', 'test/new-2.test.ts', 'test/new-3.test.ts']
  const load = (shard: string[]): number => shard.reduce((sum, f) => sum + ((weights as Record<string, number>)[f] ?? UNKNOWN), 0)

  it('gives every file to exactly one machine', () => {
    for (const count of [1, 2, 3, 6]) {
      const shards = pack(files, weights, count)
      expect(shards).toHaveLength(count)
      expect(shards.flat().sort()).toEqual([...files].sort())
    }
  })

  it('goes by how long the files take, not by how many there are', () => {
    const [first, second] = pack(files, weights, 2)
    expect(first).toEqual(['test/a.test.ts', 'test/d.test.ts']) // two files, 220 s
    expect(second).toHaveLength(6) // six files, 183 s
    expect(Math.abs(load(first!) - load(second!))).toBeLessThan(60) // by count, four and four in this order, it would be 390 s against 13
  })

  it('is the same split whatever order the files were found in', () => {
    expect(pack([...files].reverse(), weights, 3)).toEqual(pack(files, weights, 3))
  })

  it('starts the heaviest first, and a file it has no time for among the light ones', () => {
    expect(heaviestFirst(['test/new-1.test.ts', 'test/e.test.ts', 'test/a.test.ts'], weights)).toEqual(['test/a.test.ts', 'test/e.test.ts', 'test/new-1.test.ts'])
  })
})
