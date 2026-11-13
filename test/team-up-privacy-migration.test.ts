import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { People } from '../src/core/people'
import { teamUpAudiences, UNKNOWN_TEAM_UP_AUDIENCE } from '../src/shared/team-up-privacy'
import type { Conversation, Person } from '../src/shared/types'

const room = (id: string, from: string): Conversation => ({ id, kind: 'channel', name: id, members: [], unread: 0, teamUp: { from, title: from, by: 'agent', at: 1 } })

it('preserves private provenance across legacy chains while keeping public team-ups public', () => {
  const dm: Conversation = { id: 'dm', kind: 'dm', owner: 'bia', name: 'agent', members: [], unread: 0 }
  const publicRoom: Conversation = { id: 'public', kind: 'channel', name: 'public', members: [], unread: 0 }
  const audiences = teamUpAudiences([dm, publicRoom, room('one', 'dm'), room('two', 'one'), room('shared', 'public')], 'ana')
  expect(audiences.get('one')).toBe('bia')
  expect(audiences.get('two')).toBe('bia')
  expect(audiences.get('shared')).toBeUndefined()
})

it('does not guess a private owner when a legacy source disappeared or forms a cycle', () => {
  const audiences = teamUpAudiences([room('orphan', 'gone'), room('a', 'b'), room('b', 'a')], 'ana')
  for (const id of ['orphan', 'a', 'b']) expect(audiences.get(id)).toBe(UNKNOWN_TEAM_UP_AUDIENCE)
})

it('persists the recovered audience before a legacy DM can be deleted', () => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-team-up-privacy-'))
  const file = join(root, 'core.db')
  let db = new Db(file)
  try {
    const owner = db.ownerId()
    db.createConversation({ id: 'dm', kind: 'dm', owner, name: 'agent', members: [] })
    const { unread: _unread, ...old } = room('legacy', 'dm')
    db.createConversation(old)
    db.close()
    db = new Db(file)
    expect(db.conversation('legacy')?.teamUp?.privateTo).toBe(owner)
    const people = new People(db)
    expect(people.canSeeConversation({ id: 'other' } as Person, db.conversation('legacy'))).toBe(false)
    expect(people.canSeeConversation({ id: owner } as Person, db.conversation('legacy'))).toBe(true)
    db.deleteConversation('dm')
    db.close()
    db = new Db(file)
    expect(db.conversation('legacy')?.teamUp?.privateTo).toBe(owner)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
