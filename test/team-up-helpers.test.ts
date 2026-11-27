// The rules of a team-up room, with their numbers and units: 22 characters in the sidebar, 24
// carried messages, 12,000 characters, six hours of reuse, seven quiet days. No clock sleeps here.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import { TEAM_UP_CHARS, TEAM_UP_DAYS, TEAM_UP_MESSAGES, TEAM_UP_NAME_MAX, TEAM_UP_REUSE_MS, TEAM_UP_WITNESSES, type Agent, type Delegation } from '../src/shared/types'
import { carriedText, fitTeamUpName, inheritedAudience, pickCarried, reusable, staleTeamUps, teamUpDays, teamUpName, TEAM_UP_LINE } from '../src/core/team-up'
import { parseWitnesses } from '../src/core/delegations'

const HOUR = 3_600_000 // milliseconds in an hour
const DAY = 86_400_000 // milliseconds in a quiet day

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'haiku', effort: 'low',
  limit: 1_000_000, used: 0, grants: {}, memory: 'auto', archived: false, computer: false, ...extra
})

describe('team-up rules', () => {
  beforeEach(() => setLang('en'))
  afterEach(() => setLang('pt'))

  it('fits the sidebar beside an unread badge at 22 characters', () => {
    expect(TEAM_UP_NAME_MAX).toBe(22) // characters, measured with the sidebar's 14 px font
    expect(fitTeamUpName('retry-path-audit')).toBe('retry-path-audit')
    expect(fitTeamUpName('audit-of-the-retry-path')).toBe('audit-of-the-retry')
    expect(fitTeamUpName('  Ação  de Retry!! ')).toBe('acao-de-retry')
    const base = teamUpName([{ handle: 'tinker' }], () => false, 'audit-of-the-retry-path-end')
    expect(base.length).toBeLessThanOrEqual(TEAM_UP_NAME_MAX)
    const taken = new Set([base])
    const next = teamUpName([{ handle: 'tinker' }], (n) => taken.has(n), 'audit-of-the-retry-path-end')
    expect(next.length).toBeLessThanOrEqual(TEAM_UP_NAME_MAX)
    expect(next.startsWith('audit-of-the-')).toBe(true)
  })

  it('carries the newest 24 messages inside 12,000 characters', () => {
    expect(TEAM_UP_MESSAGES).toBe(24) // messages
    expect(TEAM_UP_CHARS).toBe(12_000) // characters
    const messages = Array.from({ length: 40 }, (_, i) => ({ name: 'Ana', text: `message ${i}`, at: i }))
    const { kept, left, chars } = pickCarried(messages)
    expect(kept.map((m) => m.text)).toEqual(messages.slice(16).map((m) => m.text))
    expect(left).toBe(16) // messages left in the source room
    expect(chars).toBeLessThanOrEqual(TEAM_UP_CHARS)
    const long = [{ name: 'Ana', text: 'x'.repeat(2_000), at: 0 }]
    expect(pickCarried(long).kept[0]!.text).toHaveLength(TEAM_UP_LINE + 1) // 900 characters and an ellipsis
  })

  it('clips a whole handoff at the character ceiling', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ name: 'Ana', text: 'y'.repeat(800), at: i }))
    const text = carriedText({ by: 'Wrench', guests: ['@bento'], source: '#ops', messages: many })
    expect(text.length).toBeLessThan(TEAM_UP_CHARS)
    expect(text).toMatch(/and \d+ messages before these/) // what stayed in the source room
  })

  it('reuses the same room for six hours and not one millisecond more', () => {
    expect(TEAM_UP_REUSE_MS).toBe(6 * HOUR)
    const up = { from: 'dm', by: 'wrench', title: 'audit', at: 1_000, guests: ['wrench', 'bento'], privateTo: undefined }
    expect(reusable(up, 'dm', 'wrench', ['bento', 'wrench'], 1_000 + 6 * HOUR)).toBe(true)
    expect(reusable(up, 'dm', 'wrench', ['bento', 'wrench'], 1_000 + 6 * HOUR + 1)).toBe(false)
    expect(reusable(up, 'other', 'wrench', ['bento', 'wrench'], 2_000)).toBe(false)
    expect(reusable(up, 'dm', 'wrench', ['bento'], 2_000)).toBe(false)
  })

  it('closes after seven quiet days, and zero keeps every room', () => {
    expect(TEAM_UP_DAYS).toBe(7) // days
    expect(teamUpDays(undefined)).toBe(7)
    expect(teamUpDays(0)).toBe(0)
    expect(teamUpDays(-3)).toBe(0)
    const rooms = [{ id: 'room', teamUp: { at: 0 } }]
    expect(staleTeamUps(rooms, () => 0, { days: 7, now: 7 * DAY - 1 })).toEqual([])
    expect(staleTeamUps(rooms, () => 0, { days: 7, now: 7 * DAY })).toEqual(['room'])
    expect(staleTeamUps(rooms, () => 0, { days: 7, now: 30 * DAY })).toEqual(['room'])
    expect(staleTeamUps(rooms, () => 0, { days: 0, now: 30 * DAY })).toEqual([])
  })

  it('passes a private audience through nested rooms', () => {
    expect(inheritedAudience({ kind: 'dm', owner: 'ana' }, 'owner')).toBe('ana')
    expect(inheritedAudience({ kind: 'dm' }, 'owner')).toBe('owner')
    expect(inheritedAudience({ kind: 'channel' }, 'owner')).toBeUndefined()
    expect(inheritedAudience({ kind: 'channel', teamUp: { from: 'x', title: 'x', by: 'a', at: 0, guests: [], privateTo: 'ana' } }, 'owner')).toBe('ana')
  })

  it('refuses a hidden, archived, tuca, asking, doer or waiting witness', () => {
    expect(TEAM_UP_WITNESSES).toBe(3) // witnesses per request
    const from = agent('wrench')
    const to = agent('bento')
    const reachable = [from, to, agent('beto'), agent('tuca', { kind: 'tuca' }), agent('old', { archived: true })]
    expect(parseWitnesses({ observadores: ['@beto'] }, reachable, from, to, [])).toEqual({ witnesses: [reachable[2]] })
    expect(parseWitnesses({ observadores: ['@hidden'] }, reachable.filter((a) => a.id !== 'beto'), from, to, [])).toHaveProperty('error')
    expect(parseWitnesses({ observadores: ['@wrench'] }, reachable, from, to, [])).toHaveProperty('error')
    expect(parseWitnesses({ observadores: ['@bento'] }, reachable, from, to, [])).toHaveProperty('error')
    expect(parseWitnesses({ observadores: ['@tuca'] }, reachable, from, to, [])).toHaveProperty('error')
    expect(parseWitnesses({ observadores: ['@old'] }, reachable, from, to, [])).toHaveProperty('error')
    const waiting: Delegation[] = [{ id: 'd', from: 'beto', to: 'x', conversationId: 'c', rootId: 'r', originConversationId: 'c', originMessageId: 'm', requestedBy: 'ana', text: 'x', state: 'open', createdAt: 0 }]
    expect(parseWitnesses({ observadores: ['@beto'] }, reachable, from, to, waiting)).toHaveProperty('error')
    expect(parseWitnesses({ observadores: ['a', 'b', 'c', 'd'] }, [...reachable, agent('c'), agent('d')], from, to, [])).toHaveProperty('error')
  })
})
