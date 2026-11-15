// Reasoning is temporary renderer data, with a bound on both each reply and the whole window.
export class ThoughtCache {
  private readonly values = new Map<string, string>()

  constructor(private readonly changed: (id: string) => void, private readonly replies = 200, private readonly characters = 20_000) {
    if (![replies, characters].every((value) => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Reasoning cache limits must be positive integers')
  }

  get(id: string): string | undefined {
    return this.values.get(id)
  }

  append(id: string, text: string): void {
    const all = (this.values.get(id) ?? '') + text
    // A reply still receiving deltas stays recent; reads alone do not prolong retention.
    this.values.delete(id)
    this.values.set(id, all.slice(-this.characters))
    while (this.values.size > this.replies) this.forget(this.values.keys().next().value!)
    this.changed(id)
  }

  clear(ids: Iterable<string> = this.values.keys()): void {
    for (const id of ids) this.forget(id)
  }

  private forget(id: string): void {
    if (this.values.delete(id)) this.changed(id)
  }
}
