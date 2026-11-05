// Issue #146: a routine missed while the app was closed (or due as it opens) fires on the first
// tick, which used to be before the stdio connectors finished connecting. The agent then ran
// without its tools.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message, Routine } from '../src/shared/types'
import { Db } from '../src/core/db'
import { Routines } from '../src/core/routines'

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

describe('routines and connectors that are still connecting', () => {
  let db: Db
  let clock: number
  let log: string[]
  let warn: ReturnType<typeof vi.spyOn>
  let release: () => void
  let connectorsReady: () => Promise<void> | undefined

  const agent: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }
  const build = (extra: { connectorsReady?: () => Promise<void> | undefined; connectorsWaitMs?: number } = {}): Routines =>
    new Routines({
      db,
      runner: {
        runRoutine: async (_r, when) => {
          log.push(when.late ? 'ran-late' : 'ran')
          return undefined as Message | undefined
        }
      },
      emit: () => {},
      now: () => clock,
      ...extra
    })
  const create = (routines: Routines): Routine =>
    routines.save({ name: 'Morning', agentId: 'a1', conversationId: 'c1', prompt: 'Summarize what is open.', schedule: { days: [1, 2, 3, 4, 5], time: '09:00' }, enabled: true })

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-routines-conn-')), 'test.db'))
    db.saveAgent(agent)
    db.createConversation({ id: 'c1', kind: 'channel', name: 'eng', members: ['a1'] })
    clock = at(2026, 10, 19, 8, 0) // a Monday
    log = []
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const gate = new Promise<void>((resolve) => (release = resolve))
    connectorsReady = async () => {
      log.push('waiting-for-connectors')
      await gate
      log.push('connectors-ready')
    }
  })
  afterEach(() => warn.mockRestore())

  it('a late routine waits for the connectors, then runs with them connected', async () => {
    const routines = build({ connectorsReady })
    create(routines)
    clock = at(2026, 10, 19, 9, 40) // the app was closed at 9:00
    routines.tick()
    await new Promise((r) => setTimeout(r, 20))
    expect(log).not.toContain('ran-late') // still connecting: nothing ran yet
    release()
    await routines.idle()
    expect(log).toEqual(['waiting-for-connectors', 'connectors-ready', 'ran-late'])
  })

  it('a connector that never connects does not hold the routine back: it runs after the timeout, with a warning', async () => {
    const never = (): Promise<void> => new Promise(() => {})
    const routines = build({ connectorsReady: never, connectorsWaitMs: 30 })
    create(routines)
    clock = at(2026, 10, 19, 9, 40)
    routines.tick()
    await routines.idle()
    expect(log).toEqual(['ran-late'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('[routines]')
  })

  it('a routine due right as the app opens waits too, not only a late one', async () => {
    const routines = build({ connectorsReady })
    create(routines)
    clock = at(2026, 10, 19, 9, 0) + 10_000 // on time (under two minutes)
    routines.tick()
    await new Promise((r) => setTimeout(r, 20))
    expect(log).not.toContain('ran')
    release()
    await routines.idle()
    expect(log).toEqual(['waiting-for-connectors', 'connectors-ready', 'ran'])
  })

  it('with every connector connected, a routine runs at once', async () => {
    const routines = build({ connectorsReady: () => undefined }) // none connecting
    create(routines)
    clock = at(2026, 10, 19, 9, 0) + 10_000
    routines.tick()
    await routines.idle()
    expect(log).toEqual(['ran'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a late routine with no connector manager wired runs at once, without a warning', async () => {
    const routines = build()
    create(routines)
    clock = at(2026, 10, 19, 9, 40)
    routines.tick()
    await routines.idle()
    expect(log).toEqual(['ran-late'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('with nothing missed, a tick runs nothing and waits for nothing', async () => {
    const routines = build({ connectorsReady })
    create(routines)
    routines.tick() // 8:00, due at 9:00
    await routines.idle()
    expect(log).toEqual([])
  })
})
