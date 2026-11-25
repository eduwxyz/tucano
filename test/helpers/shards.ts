// CI splits the tests across several machines (vitest --shard=i/n). Vitest's own split goes by a hash
// of each file's name, so by how many files: one Windows machine got three times the work of another,
// and a pull request waits for the slowest. This split goes by how long each file takes on that
// system (test/shard-weights.json, written from a CI run by scripts/shard-weights.mjs): the heaviest
// file goes first, each to the machine with the least so far. Inside a machine the heaviest start
// first too, so the longest file is never the last to begin.
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { BaseSequencer, type TestSpecification } from 'vitest/node'

// A file the weights don't have is a quick one (they leave out what takes under a second, and those
// average 0.3 s), or one that is new since they were written.
export const UNKNOWN = 0.3

// Every machine works this out by itself from the same list, so the answer can only depend on the
// names and the weights: ties go by name, and to the first machine.
export function pack(files: string[], weights: Record<string, number>, count: number): string[][] {
  const weight = (f: string): number => weights[f] ?? UNKNOWN
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], load: 0 }))
  for (const f of heaviestFirst(files, weights)) {
    const least = shards.reduce((a, b) => (b.load < a.load ? b : a))
    least.files.push(f)
    least.load += weight(f)
  }
  return shards.map((s) => s.files)
}

export function heaviestFirst(files: string[], weights: Record<string, number>): string[] {
  const weight = (f: string): number => weights[f] ?? UNKNOWN
  return [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0))
}

export class ByWeight extends BaseSequencer {
  private known: Record<string, number> | undefined

  private weights(): Record<string, number> {
    if (!this.known) {
      const all = JSON.parse(readFileSync(join(this.ctx.config.root, 'test', 'shard-weights.json'), 'utf8')) as Record<string, Record<string, number>>
      this.known = all[process.platform] ?? {}
    }
    return this.known
  }

  // test/x.test.ts, on every system.
  private name(spec: TestSpecification): string {
    return relative(this.ctx.config.root, spec.moduleId).replace(/\\/g, '/')
  }

  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const mine = new Set(pack(files.map((f) => this.name(f)), this.weights(), count)[index - 1])
    return files.filter((f) => mine.has(this.name(f)))
  }

  // On my own computer vitest's order is the better one: what failed last time runs first.
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (!process.env['CI']) return super.sort(files)
    const order = new Map(heaviestFirst(files.map((f) => this.name(f)), this.weights()).map((f, i) => [f, i]))
    return [...files].sort((a, b) => order.get(this.name(a))! - order.get(this.name(b))!)
  }
}
