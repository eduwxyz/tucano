import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { MAX_MONTHLY_LIMIT, safeLimit } from '../src/shared/limits'
import type { Agent } from '../src/shared/types'

const agent = (limit: number): Agent => ({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit, used: 0, grants: {}, memory: 'read', computer: false, archived: false })

describe('a monthly limit too large to be one', () => {
  it('is kept as no limit, and a real one is kept as it is', () => {
    expect(safeLimit(2_000_000)).toBe(2_000_000)
    expect(safeLimit(1_500_000.4)).toBe(1_500_000)
    expect(safeLimit(MAX_MONTHLY_LIMIT)).toBe(MAX_MONTHLY_LIMIT)
    expect(safeLimit(MAX_MONTHLY_LIMIT + 1_000)).toBe(0)
    expect(safeLimit(999999999999000064)).toBe(0) // the value that stopped a workspace from opening
    expect(safeLimit(Infinity)).toBe(0)
    expect(safeLimit(NaN)).toBe(0)
    expect(safeLimit(-5)).toBe(0)
    expect(safeLimit('abc')).toBe(0)
  })

  it('never reaches the database when an agent is saved', () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-limit-'))
    const db = new Db(join(root, 'core.db'))
    try {
      db.saveAgent(agent(999999999999000064))
      expect(db.agents().map((a) => a.limit)).toEqual([0])
      db.saveAgent(agent(3_000_000))
      expect(db.agent('lia')?.limit).toBe(3_000_000)
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('already in the database, is put right when the workspace opens instead of stopping it', () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-limit-'))
    const path = join(root, 'core.db')
    const first = new Db(path)
    first.saveAgent(agent(1_000_000))
    first.close()
    // As an older version left it: written with no check, by hand here.
    const raw = new DatabaseSync(path)
    raw.exec('UPDATE agents SET limit_tokens = 999999999999000064')
    expect(() => raw.prepare('SELECT * FROM agents').all()).toThrow()
    raw.close()
    const db = new Db(path)
    try {
      expect(db.agents().map((a) => a.limit)).toEqual([0])
    } finally {
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
