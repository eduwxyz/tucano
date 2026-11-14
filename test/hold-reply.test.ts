// A reply the person put on hold: it keeps its session and waits where nothing of the model's is in
// flight (a tool call about to start, another turn), then goes on when it is let go.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { Hold } from '../src/core/hold'

describe('a reply put on hold', () => {
  it('never waits when nobody asked for a hold', async () => {
    const hold = new Hold()
    expect(hold.held).toBe(false)
    expect(await hold.wait(new AbortController().signal)).toBe(false)
  })

  it('waits where the run reaches it, and goes on when it is let go', async () => {
    const hold = new Hold()
    hold.request()
    expect(hold.held).toBe(true)
    let went = false
    const waiting = hold.wait(new AbortController().signal).then((waited) => {
      went = true
      return waited
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(went).toBe(false) // still held
    hold.release()
    expect(await waiting).toBe(true)
    expect(hold.held).toBe(false)
  })

  it('lets a reply that was let go before reaching it go on without stopping', async () => {
    const hold = new Hold()
    hold.request()
    hold.release()
    expect(await hold.wait(new AbortController().signal)).toBe(false)
  })

  it('wakes on a stop, so a hold nobody lets go of cannot leave the reply waiting for ever', async () => {
    const hold = new Hold()
    hold.request()
    const ctl = new AbortController()
    const waiting = hold.wait(ctl.signal)
    ctl.abort()
    expect(await waiting).toBe(true)
  })

  it('takes a second pause while it waits as the same hold', async () => {
    const hold = new Hold()
    hold.request()
    hold.request()
    const waiting = hold.wait(new AbortController().signal)
    hold.release()
    expect(await waiting).toBe(true)
    expect(hold.held).toBe(false)
  })
})

describe('a hold left behind by an app that closed', () => {
  const save = (db: Db, id: string, status: 'working' | 'paused', held?: boolean): void => {
    db.saveMessage({
      id,
      conversationId: 'd1',
      author: { kind: 'agent', id: 'a1' },
      text: `Partial ${id}`,
      at: Date.now(),
      run: { status, steps: [], ...(held ? { held: true } : {}) }
    })
  }

  it('is closed at boot, while a reply paused at its spending ceiling is left where it stopped', () => {
    const db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-hold-')), 'test.db'))
    db.saveAgent({ id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    save(db, 'held', 'paused', true)
    save(db, 'ceiling', 'paused')
    save(db, 'working', 'working')
    expect(db.interruptStaleRuns()).toBe(2)
    expect(db.message('held')?.run?.status).toBe('interrupted')
    expect(db.message('working')?.run?.status).toBe('interrupted')
    expect(db.message('ceiling')?.run?.status).toBe('paused')
    db.close()
  })
})

describe('pause gate cancellation and parallel calls', () => {
  it('does not wait for an abort that already happened', async () => {
    const hold = new Hold()
    hold.request()
    const ctl = new AbortController()
    ctl.abort()
    let settled = false
    void hold.wait(ctl.signal).then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(true)
  })

  it('resumes every parallel tool call waiting at the gate', async () => {
    const hold = new Hold()
    hold.request()
    const ctl = new AbortController()
    const completed: number[] = []
    const waits = [1, 2, 3].map(id => hold.wait(ctl.signal).then(() => { completed.push(id) }))
    try {
      hold.release()
      await Promise.resolve()
      await Promise.resolve()
      expect([...completed]).toEqual([1, 2, 3])
      await Promise.all(waits)
    } finally {
      ctl.abort()
    }
  })

  it('removes abort listeners after each normal resume', async () => {
    const hold = new Hold()
    const ctl = new AbortController()
    for (let index = 0; index < 12; index++) {
      hold.request()
      const waiting = hold.wait(ctl.signal)
      hold.release()
      await waiting
      expect(getEventListeners(ctl.signal, 'abort')).toHaveLength(0)
    }
  })
})
