import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

let db: Db
let gateway: Gateway
let settings: Settings

function runner(): Runner {
  const fake = fakeEngine('claude', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude: fake, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'wm-w-')), gateway })
}

// A reply that asked for approval and was left saying so, with its approval in `state`.
function waiting(state: 'pending' | 'approved' | 'refused' | 'expired', outcome?: string): void {
  db.saveMessage({
    id: 'm1',
    conversationId: 'dm',
    author: { kind: 'agent', id: 'lia' },
    text: 'Preciso apagar uma tarefa.',
    at: Date.now(),
    run: { status: 'waiting_approval', steps: [], depth: 1, approvalId: 'ap1' }
  })
  db.createApproval({
    id: 'ap1',
    hash: 'h',
    agentId: 'lia',
    conversationId: 'dm',
    messageId: 'm1',
    connectorId: 'composio',
    connectorName: 'Composio',
    tool: 'delete_task',
    args: {},
    why: 'apagar',
    highRisk: true,
    state,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...(outcome ? { outcome } : {})
  })
  if (outcome) db.setApprovalOutcome('ap1', outcome)
}

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'wm-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false } as Agent)
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('a reply left waiting on a decision', () => {
  it('is closed at the next start when the decision already landed', async () => {
    waiting('approved', 'Executou.')
    expect(await runner().settleDecidedRuns()).toBe(1)
    const m = db.message('m1')!
    expect(m.run).toMatchObject({ status: 'done' })
    expect(m.run!.steps.at(-1)).toMatchObject({ label: 'Aprovado', detail: 'Executou.', status: 'done' })
  })

  it('keeps the outcome it never got to write, rather than inventing one', async () => {
    waiting('refused') // decided while quitting: no outcome was saved
    await runner().settleDecidedRuns()
    const last = db.message('m1')!.run!.steps.at(-1)!
    expect(last.label).toBe('Recusado')
    expect(last.status).toBe('error')
    expect(last.detail).toContain('nunca terminou de ser gravada')
  })

  it('settles an expired one too, which is the same dead end', async () => {
    waiting('expired')
    expect(await runner().settleDecidedRuns()).toBe(1)
    expect(db.message('m1')!.run!.steps.at(-1)).toMatchObject({ label: 'Expirou' })
  })

  it("leaves one still waiting on the person alone", async () => {
    waiting('pending')
    expect(await runner().settleDecidedRuns()).toBe(0)
    expect(db.message('m1')!.run).toMatchObject({ status: 'waiting_approval' })
  })
})
