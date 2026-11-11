// How the person arranged the channels in the sidebar. Only names and order, so it lives in the
// workspace's settings. A channel it doesn't know yet shows last, and one that's gone is forgotten.
export interface ChannelGroup {
  id: string
  name: string
  channels: string[]
}

export interface ChannelLayout {
  groups: ChannelGroup[]
  loose: string[] // the channels in no group, shown first
}

export const EMPTY_LAYOUT: ChannelLayout = { groups: [], loose: [] }

// Settings keep whatever was saved: a bad value loses the arrangement, not the sidebar.
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
function readable(saved: ChannelLayout | null | undefined): ChannelLayout {
  if (!saved || typeof saved !== 'object') return EMPTY_LAYOUT
  const groups = Array.isArray(saved.groups) ? saved.groups.filter((g) => g && typeof g.id === 'string' && typeof g.name === 'string') : []
  return { loose: ids(saved.loose), groups: groups.map((g) => ({ ...g, channels: ids(g.channels) })) }
}

export function arrange<T extends { id: string }>(channels: T[], saved?: ChannelLayout | null): { loose: T[]; groups: (Omit<ChannelGroup, 'channels'> & { channels: T[] })[] } {
  const layout = readable(saved)
  const byId = new Map(channels.map((c) => [c.id, c]))
  const placed = new Set<string>()
  const take = (ids: string[]): T[] =>
    ids.flatMap((id) => {
      const c = byId.get(id)
      if (!c || placed.has(id)) return []
      placed.add(id)
      return [c]
    })
  const groups = layout.groups.map((g) => ({ ...g, channels: take(g.channels) }))
  const loose = take(layout.loose)
  return { loose: [...loose, ...channels.filter((c) => !placed.has(c.id))], groups }
}

const without = (layout: ChannelLayout, channelId: string): ChannelLayout => ({
  loose: layout.loose.filter((id) => id !== channelId),
  groups: layout.groups.map((g) => ({ ...g, channels: g.channels.filter((id) => id !== channelId) }))
})

const inserted = (list: string[], id: string, before?: string): string[] => {
  const at = before ? list.indexOf(before) : -1
  return at < 0 ? [...list, id] : [...list.slice(0, at), id, ...list.slice(at)]
}

// Puts a channel in a group (or in none), before another channel or last. Starts from every
// channel, so the order of those never moved stays what the person sees.
export function moveChannel(channels: { id: string }[], layout: ChannelLayout | undefined, channelId: string, to: { group?: string; before?: string }): ChannelLayout {
  const now = arrange(channels, layout)
  const full: ChannelLayout = { loose: now.loose.map((c) => c.id), groups: now.groups.map((g) => ({ ...g, channels: g.channels.map((c) => c.id) })) }
  if (to.before === channelId) return full
  const rest = without(full, channelId)
  if (!to.group) return { ...rest, loose: inserted(rest.loose, channelId, to.before) }
  return { ...rest, groups: rest.groups.map((g) => (g.id === to.group ? { ...g, channels: inserted(g.channels, channelId, to.before) } : g)) }
}

// Where a picked-up channel was let go: a channel row (before it, inside that channel's own group),
// a group's name (into the group, last), or the end of the loose list or of a group. The value is
// what the row carries in `data-order-id`; one place decides, so the sidebar keeps no mapping.
export function moveChannelTo(
  channels: { id: string }[],
  layout: ChannelLayout | undefined,
  channelId: string,
  at: string
): ChannelLayout | null {
  const now = arrange(channels, layout)
  if (at.startsWith('end:')) {
    const where = at.slice(4)
    return moveChannel(channels, layout, channelId, where === 'loose' ? {} : { group: where })
  }
  if (at.startsWith('grp:')) return moveChannel(channels, layout, channelId, { group: at.slice(4) })
  if (at === channelId) return null
  const group = now.groups.find((g) => g.channels.some((c) => c.id === at))
  const loose = now.loose.some((c) => c.id === at)
  if (!group && !loose) return null
  return moveChannel(channels, layout, channelId, { ...(group ? { group: group.id } : {}), before: at })
}

// One place up or down, among its neighbors.
export function nudgeChannel(channels: { id: string }[], layout: ChannelLayout | undefined, channelId: string, by: -1 | 1): ChannelLayout {
  const now = arrange(channels, layout)
  const group = now.groups.find((g) => g.channels.some((c) => c.id === channelId))
  const list = (group?.channels ?? now.loose).map((c) => c.id)
  const at = list.indexOf(channelId)
  const neighbor = list[at + by]
  if (!neighbor) return moveChannel(channels, layout, channelId, { group: group?.id, before: list[at + 1] })
  return moveChannel(channels, layout, channelId, { group: group?.id, before: by < 0 ? neighbor : list[at + 2] })
}

export const addGroup = (layout: ChannelLayout = EMPTY_LAYOUT, group: { id: string; name: string }): ChannelLayout => ({ ...layout, groups: [...layout.groups, { ...group, channels: [] }] })

export const renameGroup = (layout: ChannelLayout, id: string, name: string): ChannelLayout => ({ ...layout, groups: layout.groups.map((g) => (g.id === id ? { ...g, name } : g)) })

// Its channels go back to the loose ones: deleting a group deletes no channel.
export const removeGroup = (layout: ChannelLayout, id: string): ChannelLayout => ({
  groups: layout.groups.filter((g) => g.id !== id),
  loose: [...layout.loose, ...(layout.groups.find((g) => g.id === id)?.channels ?? [])]
})
