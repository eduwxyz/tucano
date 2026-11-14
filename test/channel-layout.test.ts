import { describe, expect, it } from 'vitest'
import { addGroup, arrange, EMPTY_LAYOUT, moveChannel, moveChannelTo, nudgeChannel, removeGroup, renameGroup, type ChannelLayout } from '../src/shared/channel-layout'

const channels = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
const ids = (l: { id: string }[]): string[] => l.map((c) => c.id)

describe('arrange', () => {
  it('with nothing set, keeps the order they came in', () => {
    expect(ids(arrange(channels).loose)).toEqual(['a', 'b', 'c', 'd'])
    expect(arrange(channels).groups).toEqual([])
  })
  it('shows a new channel last, and forgets one that is gone', () => {
    const layout: ChannelLayout = { loose: ['b', 'sumiu'], groups: [{ id: 'g', name: 'G', channels: ['c', 'sumiu'] }] }
    const r = arrange(channels, layout)
    expect(ids(r.loose)).toEqual(['b', 'a', 'd'])
    expect(ids(r.groups[0]!.channels)).toEqual(['c'])
  })
  it('survives a bad saved value, showing every channel', () => {
    for (const bad of [null, {}, { groups: 'x' }, { groups: [{ id: 'g' }], loose: 3 }, { groups: [{ id: 'g', name: 'G' }] }]) {
      expect(ids(arrange(channels, bad as never).loose)).toEqual(['a', 'b', 'c', 'd'])
    }
  })
  it('shows a channel listed twice only once', () => {
    const r = arrange(channels, { loose: ['a'], groups: [{ id: 'g', name: 'G', channels: ['a', 'b'] }] })
    expect(ids(r.groups[0]!.channels)).toEqual(['a', 'b'])
    expect(ids(r.loose)).toEqual(['c', 'd'])
  })
})

describe('moving', () => {
  it('moves before another, keeping the rest as seen', () => {
    expect(moveChannel(channels, undefined, 'd', { before: 'b' }).loose).toEqual(['a', 'd', 'b', 'c'])
    expect(moveChannel(channels, undefined, 'a', {}).loose).toEqual(['b', 'c', 'd', 'a'])
    expect(moveChannel(channels, undefined, 'b', { before: 'b' }).loose).toEqual(['a', 'b', 'c', 'd'])
  })
  it('into a group and out of it', () => {
    const grouped = addGroup(EMPTY_LAYOUT, { id: 'g', name: 'Clientes' })
    const inside = moveChannel(channels, grouped, 'b', { group: 'g' })
    expect(inside.groups[0]!.channels).toEqual(['b'])
    expect(inside.loose).toEqual(['a', 'c', 'd'])
    const out = moveChannel(channels, inside, 'b', { before: 'c' })
    expect(out.groups[0]!.channels).toEqual([])
    expect(out.loose).toEqual(['a', 'b', 'c', 'd'])
  })
  it('one up or down, stopping at the ends, inside its group', () => {
    expect(arrange(channels, nudgeChannel(channels, undefined, 'c', -1)).loose.map((c) => c.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(arrange(channels, nudgeChannel(channels, undefined, 'b', 1)).loose.map((c) => c.id)).toEqual(['a', 'c', 'b', 'd'])
    expect(arrange(channels, nudgeChannel(channels, undefined, 'a', -1)).loose.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(arrange(channels, nudgeChannel(channels, undefined, 'd', 1)).loose.map((c) => c.id)).toEqual(['a', 'b', 'c', 'd'])
    const g: ChannelLayout = { loose: [], groups: [{ id: 'g', name: 'G', channels: ['a', 'b', 'c'] }] }
    expect(arrange(channels, nudgeChannel(channels, g, 'c', -1)).groups[0]!.channels.map((c) => c.id)).toEqual(['a', 'c', 'b'])
  })
  it('renaming a group and removing it keeps its channels', () => {
    const g: ChannelLayout = { loose: ['a'], groups: [{ id: 'g', name: 'G', channels: ['b', 'c'] }] }
    expect(renameGroup(g, 'g', 'Novo').groups[0]!.name).toBe('Novo')
    expect(removeGroup(g, 'g')).toEqual({ groups: [], loose: ['a', 'b', 'c'] })
  })
})

// The same hold-and-drop the DMs and agents use, read for channels: the value is whatever the row
// the channel was let go on carries in `data-order-id`.
describe('moveChannelTo', () => {
  const layout: ChannelLayout = {
    loose: ['a'],
    groups: [
      { id: 'g1', name: 'One', channels: ['b', 'c'] },
      { id: 'g2', name: 'Two', channels: ['d'] }
    ]
  }

  it('drops a channel before the row it was let go on, inside that row group', () => {
    const r = moveChannelTo(channels, layout, 'a', 'c')!
    expect(r.groups[0]!.channels).toEqual(['b', 'a', 'c'])
    expect(r.loose).toEqual([])
  })

  it('drops on a loose row and stays loose', () => {
    const r = moveChannelTo(channels, layout, 'c', 'a')!
    expect(r.loose).toEqual(['c', 'a'])
    expect(r.groups[0]!.channels).toEqual(['b'])
  })

  it('drops on a group name to join it last', () => {
    const r = moveChannelTo(channels, layout, 'a', 'grp:g2')!
    expect(r.groups[1]!.channels).toEqual(['d', 'a'])
    expect(r.loose).toEqual([])
  })

  it('drops on the end of the loose list, or of a group, to go last there', () => {
    expect(moveChannelTo(channels, layout, 'c', 'end:loose')!.loose).toEqual(['a', 'c'])
    expect(moveChannelTo(channels, layout, 'a', 'end:g1')!.groups[0]!.channels).toEqual(['b', 'c', 'a'])
  })

  it('says nothing changed when the row was let go on itself or on nothing it knows', () => {
    expect(moveChannelTo(channels, layout, 'a', 'a')).toBeNull()
    expect(moveChannelTo(channels, layout, 'a', 'whatever')).toBeNull()
  })
})
