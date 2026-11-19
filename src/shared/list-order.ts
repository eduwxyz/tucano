// The person's own order for a list of rows in the sidebar (their DMs, the agents): ids only, the
// same shape the channel layout uses, so it lives in the workspace's settings. A row the order
// doesn't know yet shows last, and one that is gone is forgotten: settings keep whatever was saved,
// and a bad value loses the arrangement, never the list.

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

// The whole list as ids, in the order it is shown: what "Move up" and a drop both start from.
const flat = (items: { id: string }[], order?: string[] | null): string[] => ordered(items, order).map((i) => i.id)

// `id` just before `before`, or last when there is no `before` (or it is `id` itself).
export function moveBefore(items: { id: string }[], order: string[] | null | undefined, id: string, before?: string): string[] {
  const list = flat(items, order)
  if (before === id) return list // dropped on itself: nothing moves
  const rest = list.filter((x) => x !== id)
  if (!before) return [...rest, id]
  const at = rest.indexOf(before)
  return at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)]
}

// One place up or down.
export function nudge(items: { id: string }[], order: string[] | null | undefined, id: string, by: -1 | 1): string[] {
  const list = flat(items, order)
  const at = list.indexOf(id)
  const to = at + by
  if (at < 0 || to < 0 || to >= list.length) return list
  const next = list.slice()
  next[at] = list[to]!
  next[to] = id
  return next
}
