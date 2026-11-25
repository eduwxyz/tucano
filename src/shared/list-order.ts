// The person's own order for a list of rows in the sidebar (the items at the top, the agents, the
// sectors): ids only, the same shape the channel layout uses, so it lives in their settings. A row
// the order doesn't know yet shows last, and one that is gone is forgotten: a bad value loses the
// arrangement, never the list.

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

// The list as the person left it: what the order names, in that order, then everything it doesn't.
export function ordered<T extends { id: string }>(items: T[], order?: string[] | null): T[] {
  const saved = ids(order)
  if (!saved.length) return items
  const byId = new Map(items.map((i) => [i.id, i]))
  const placed = new Set<string>()
  const out: T[] = []
  for (const id of saved) {
    const item = byId.get(id)
    if (!item || placed.has(id)) continue
    placed.add(id)
    out.push(item)
  }
  for (const item of items) if (!placed.has(item.id)) out.push(item)
  return out
}

// The whole list as ids, in the order it is shown: what a drop and a step both start from.
const flat = (items: { id: string }[], order?: string[] | null): string[] => ordered(items, order).map((i) => i.id)

// `id` just before `before`, or last when there is no `before`. Dropped on itself, nothing moves.
export function moveBefore(items: { id: string }[], order: string[] | null | undefined, id: string, before?: string): string[] {
  const list = flat(items, order)
  if (before === id) return list
  const rest = list.filter((x) => x !== id)
  if (!before) return [...rest, id]
  const at = rest.indexOf(before)
  return at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]
}

// One place up or down among the rows that show next to it (`near`: the same sector, what isn't
// hidden), so a step always moves something the person can see. The rest keep their places.
export function nudge(items: { id: string }[], order: string[] | null | undefined, id: string, by: -1 | 1, near: (id: string) => boolean = () => true): string[] {
  const list = flat(items, order)
  const shown = list.filter((x) => x === id || near(x))
  const at = shown.indexOf(id)
  const other = shown[at + by]
  if (at < 0 || !other) return list
  if (by < 0) return moveBefore(items, list, id, other)
  // Down: just after the next one, that is before whatever follows it in the whole list.
  const rest = list.filter((x) => x !== id)
  return moveBefore(items, list, id, rest[rest.indexOf(other) + 1])
}
