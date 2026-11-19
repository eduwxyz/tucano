import type { Conversation } from './types'

type Room = Pick<Conversation, 'id' | 'kind' | 'owner' | 'teamUp'>
export const UNKNOWN_TEAM_UP_AUDIENCE = '__team_up_source_unavailable__'

// Recover the original audience before a legacy room can outlive its private source.
export function teamUpAudiences(rooms: Room[], ownerId: string): Map<string, string | undefined> {
  const byId = new Map(rooms.map((room) => [room.id, room]))
  const audiences = new Map<string, string | undefined>()
  const visiting = new Set<string>()
  const audience = (id: string): string | undefined => {
    if (audiences.has(id)) return audiences.get(id)
    const room = byId.get(id)
    if (!room || visiting.has(id)) return UNKNOWN_TEAM_UP_AUDIENCE
    if (room.kind === 'dm') return room.owner ?? ownerId
    if (!room.teamUp) return undefined
    visiting.add(id)
    const saved = room.teamUp.privateTo
    const person = saved && saved !== UNKNOWN_TEAM_UP_AUDIENCE ? saved : audience(room.teamUp.from)
    visiting.delete(id)
    audiences.set(id, person)
    return person
  }
  for (const room of rooms) if (room.teamUp) audience(room.id)
  return audiences
}
