import type { Agent, Conversation } from './types'

type Room = Pick<Conversation, 'kind' | 'owner' | 'createdBy' | 'members' | 'visibility' | 'agentReadAccess' | 'agentReaders'>

export function roomVisibleTo(room: Room, personId: string, ownerId: string): boolean {
  if (room.kind === 'dm') return personId === (room.owner ?? ownerId)
  if (room.visibility !== 'private') return true // Existing channels keep their established audience.
  return personId === (room.createdBy ?? ownerId)
}

export function agentMayReadRoom(room: Room, agentId: string): boolean {
  if (room.members.includes(agentId)) return true
  if (room.kind === 'dm') return false
  if (room.agentReadAccess === 'all') return true
  return room.agentReadAccess === 'selected' && !!room.agentReaders?.includes(agentId)
}

export function agentMayReadFor(room: Room, agent: Pick<Agent, 'id' | 'archived'>, personId: string, ownerId: string): boolean {
  return !agent.archived && roomVisibleTo(room, personId, ownerId) && agentMayReadRoom(room, agent.id)
}
