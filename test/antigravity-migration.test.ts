// Gemini CLI gave way to the Antigravity CLI: what a person had on the "gemini" harness (the
// harness switched on, agents' models and fallbacks, receipts) comes over to "antigravity".
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { Db, MIGRATIONS } from '../src/core/db'
import type { Agent } from '../src/shared/types'

const agent = (id: string, modelId: string, fallbackModelId?: string): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId, ...(fallbackModelId ? { fallbackModelId } : {}), effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })

it('moves what ran on Gemini over to Antigravity, and leaves the rest alone', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ag-mig-')), 'test.db')
  const db0 = new Db(file)
  db0.saveAgent(agent('g1', 'gemini:gemini/gemini-2.5-pro', 'gemini:gemini/gemini-2.5-flash'))
  db0.saveAgent(agent('c1', 'sonnet', 'opencode:openai/gpt-5.5'))
  db0.setSettings({ harnesses: { gemini: true, claude: true } } as never)
  db0.addReceipt({ messageId: 'm1', agentId: 'g1', engine: 'gemini', model: 'gemini:gemini/gemini-2.5-pro', inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, ms: 1, at: 1 } as never)
  db0.close()
  // As a database from before the rename: that migration, and every one after it, not run yet.
  const raw = new DatabaseSync(file)
  raw.exec(`PRAGMA user_version = ${MIGRATIONS.findIndex((m) => m.includes("UPDATE agents SET model = 'antigravity:'"))}`)
  raw.close()

  const db = new Db(file)
  const g1 = db.agents().find((a) => a.id === 'g1')!
  expect(g1.modelId).toBe('antigravity:gemini/gemini-2.5-pro')
  expect(g1.fallbackModelId).toBe('antigravity:gemini/gemini-2.5-flash')
  expect(db.agents().find((a) => a.id === 'c1')).toMatchObject({ modelId: 'sonnet', fallbackModelId: 'opencode:openai/gpt-5.5' })
  expect((db.getSettings({} as never) as unknown as { harnesses: Record<string, boolean> }).harnesses).toEqual({ antigravity: true, claude: true })
  db.close()
  const after = new DatabaseSync(file)
  expect(after.prepare('SELECT engine, model FROM receipts').get()).toEqual({ engine: 'antigravity', model: 'antigravity:gemini/gemini-2.5-pro' })
  after.close()
})
