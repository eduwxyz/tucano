import { expect, it } from 'vitest'
import { agentMayReadFor, agentMayReadRoom, roomVisibleTo } from '../src/shared/room-access'
import type { Conversation } from '../src/shared/types'

const room = (extra: Partial<Conversation> = {}): Conversation => ({ id: 'room', kind: 'channel', name: 'room', members: ['member'], unread: 0, createdBy: 'ana', visibility: 'private', ...extra })

it('keeps a private room visible only to its creator, including against another workspace owner', () => {
  expect(roomVisibleTo(room(), 'ana', 'owner')).toBe(true)
  expect(roomVisibleTo(room(), 'owner', 'owner')).toBe(false)
  expect(roomVisibleTo(room(), 'bia', 'owner')).toBe(false)
})

it('preserves existing shared rooms and explicitly shared rooms', () => {
  expect(roomVisibleTo(room({ visibility: undefined }), 'bia', 'owner')).toBe(true)
  expect(roomVisibleTo(room({ visibility: 'workspace' }), 'bia', 'owner')).toBe(true)
})

it('never makes a DM public through channel settings', () => {
  const dm = room({ kind: 'dm', owner: 'ana', visibility: 'workspace', agentReadAccess: 'all' })
  expect(roomVisibleTo(dm, 'bia', 'owner')).toBe(false)
  expect(agentMayReadRoom(dm, 'outsider')).toBe(false)
})

it('gives members read access and requires an explicit grant for other agents', () => {
  expect(agentMayReadRoom(room(), 'member')).toBe(true)
  expect(agentMayReadRoom(room(), 'outsider')).toBe(false)
  expect(agentMayReadRoom(room({ agentReadAccess: 'selected', agentReaders: ['reader'] }), 'reader')).toBe(true)
  expect(agentMayReadRoom(room({ agentReadAccess: 'selected', agentReaders: ['reader'] }), 'outsider')).toBe(false)
  expect(agentMayReadRoom(room({ agentReadAccess: 'all' }), 'outsider')).toBe(true)
})

it('does not let an agent grant its requester access to someone else’s private room', () => {
  const sharedAgent = { id: 'reader', archived: false }
  const source = room({ agentReadAccess: 'all' })
  expect(agentMayReadFor(source, sharedAgent, 'ana', 'owner')).toBe(true)
  expect(agentMayReadFor(source, sharedAgent, 'bia', 'owner')).toBe(false)
  expect(agentMayReadFor(source, { ...sharedAgent, archived: true }, 'ana', 'owner')).toBe(false)
})
