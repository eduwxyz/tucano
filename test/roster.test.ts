// The team an agent can look at (roster.ts): who exists, their handles, and who is already in the room.
// A DM's prompt names only its own agent, so this is how an agent there finds out who it could call in.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '../src/shared/types'
import { EQUIPE, equipeCall } from '../src/core/roster'
import { setLang } from '../src/shared/lang'

const agent = (id: string, name: string, role: string, extra: Partial<Agent> = {}): Agent =>
  ({
    id,
    name,
    handle: id,
    role,
    color: 'sky',
    instructions: '',
    modelId: 'haiku',
    effort: 'medium',
    limit: 1_000_000,
    used: 0,
    web: false,
    created: 0,
    ...extra
  }) as Agent

const team = [
  agent('wrench', 'Wrench', 'PC upkeep'),
  agent('auditor', 'Auditor', 'Security and privacy'),
  agent('tinker', 'Tinker', 'Hermes stack'),
  agent('old', 'Gone', 'Retired', { archived: true }),
  agent('tuca', 'Tuca', 'Helps with Tucano', { kind: 'tuca' })
]

describe('the team an agent looks at', () => {
  beforeEach(() => setLang('en'))
  afterEach(() => setLang('pt'))

  it('lists handles, names and roles, and marks who is in this conversation', () => {
    const r = equipeCall({ agents: team, me: 'wrench', here: ['wrench', 'auditor'] })
    expect(r.count).toBe(2)
    expect(r.text).toContain('- @auditor · Auditor · Security and privacy · here')
    expect(r.text).toContain('- @tinker · Tinker · Hermes stack')
    expect(r.text).not.toContain('@tinker · Tinker · Hermes stack · here')
  })

  it('leaves out the agent asking, the Tuca and the archived ones: none of them can be called in', () => {
    const r = equipeCall({ agents: team, me: 'wrench', here: [] })
    expect(r.text).not.toContain('@wrench')
    expect(r.text).not.toContain('@tuca')
    expect(r.text).not.toContain('@old')
  })

  it('says how one who is not here is called', () => {
    const r = equipeCall({ agents: team, me: 'wrench', here: [] })
    expect(r.text).toContain('@handle')
    expect(r.text).toContain('team-up channel')
  })

  it('narrows by words of the handle, the name or the role, whatever the case', () => {
    const r = equipeCall({ agents: team, me: 'wrench', here: [], busca: 'SECURITY' })
    expect(r.count).toBe(1)
    expect(r.text).toContain('@auditor')
    expect(r.text).not.toContain('@tinker')
    expect(r.text).toContain('matching "SECURITY"')
  })

  it('says nothing matched instead of returning an empty list', () => {
    const r = equipeCall({ agents: team, me: 'wrench', here: [], busca: 'lawyer' })
    expect(r.count).toBe(0)
    expect(r.text).toContain('Nothing matched')
  })

  it('the tool has a name and a description an agent can act on', () => {
    expect(EQUIPE.name).toBe('equipe')
    expect(EQUIPE.description).toContain('handle with @')
  })
})
