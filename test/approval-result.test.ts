// What the card's receipt is told: "completed" only for a call the app really made and that went
// through. A failed call, one that never ran, a grant, or an app action the agent still has to make
// must not read as completed (src/core/runs.ts, decide).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, Approval, EngineId, Settings } from '../src/shared/types'
import { ACCESS_REQUEST } from '../src/shared/types'
import { COMPUTADOR } from '../src/shared/actions'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { textResult } from '../src/core/gateway'

const ready = { installed: true, loggedIn: true }

let db: Db
let gateway: Gateway
let settings: Settings
let commandFails: boolean
let clickWorks: boolean

function runner(): Runner {
  const fake = fakeEngine('claude', { delayMs: 1 })
  const engines: Record<EngineId, Engine> = { claude: fake, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }
  return new Runner({
    db,
    engines,
    settings: async () => settings,
    emit: () => {},
    workDir: mkdtempSync(join(tmpdir(), 'ar-w-')),
    gateway,
    computers: { call: async () => ({ result: textResult(commandFails ? 'exit 1' : 'ok', commandFails) }) } as never,
    browser: { tools: () => [], call: async () => ({ result: textResult('') }), approved: async () => ({ ok: clickWorks, text: clickWorks ? 'Clicou.' : 'A página mudou.' }) } as never,
    apps: { tools: () => [], call: async () => ({ result: textResult('') }), approved: () => ({ ok: true, text: '' }), lent: () => [] } as never
  })
}

function ask(extra: Partial<Approval>): string {
  const id = `ap${db.approvals().length + 1}`
  db.saveMessage({ id: `m-${id}`, conversationId: 'dm', author: { kind: 'agent', id: 'lia' }, text: 'Pedi.', at: Date.now(), run: { status: 'waiting_approval', steps: [], depth: 1, approvalId: id } })
  db.createApproval({ id, hash: 'h', agentId: 'lia', conversationId: 'dm', messageId: `m-${id}`, connectorId: COMPUTADOR, connectorName: 'Computador', tool: 'bash', args: { command: 'ls' }, why: '', highRisk: false, state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60_000, ...extra })
  return id
}

async function decided(id: string, decision: 'approved' | 'refused' = 'approved'): Promise<Approval> {
  const r = runner()
  await r.decide(id, decision)
  await r.idle()
  return db.approval(id)!
}

beforeEach(async () => {
  commandFails = false
  clickWorks = true
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ar-db-')), 'test.db'))
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: true, browser: true, apps: [{ name: 'Mail', level: 'read_write' }], archived: false } as Agent)
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  gateway = new Gateway()
  await gateway.start()
})
afterEach(() => gateway.stop())

describe('what became of an approved call', () => {
  it('a command that ran and went through is done', async () => {
    expect((await decided(ask({}))).result).toBe('done')
  })

  it('a command that ran and failed is an error, not done', async () => {
    commandFails = true
    expect(await decided(ask({}))).toMatchObject({ state: 'approved', result: 'error' })
  })

  it('a command on a computer that is off never ran', async () => {
    const lia = db.agent('lia')!
    db.saveAgent({ ...lia, computer: false })
    expect((await decided(ask({}))).result).toBe('not_run')
  })

  it('a browser click that did not land is not done', async () => {
    clickWorks = false
    const a = await decided(ask({ connectorId: 'navegador', connectorName: 'Navegador', tool: 'navegador_clicar', args: { alvo: 'Pagar', url: 'https://x.test' } }))
    expect(a.result).toBe('error')
    expect(a.outcome).toContain('A página mudou')
  })

  it("an app's action is only let through: the agent still has to make it", async () => {
    const a = await decided(ask({ connectorId: 'apps', connectorName: 'Apps', tool: 'app_clicar', args: { app: 'Mail', alvo: 'Enviar' } }))
    expect(a.result).toBeUndefined()
    expect(a.outcome).toContain('Liberado')
  })

  it('a grant of access is approved, with no call to report', async () => {
    const a = await decided(ask({ connectorId: 'github', connectorName: 'GitHub', tool: ACCESS_REQUEST, args: { nivel: 'read' } }))
    expect(a.result).toBeUndefined()
    expect(a.outcome).toContain('Acesso liberado')
  })

  it('a refusal is never done', async () => {
    expect((await decided(ask({}), 'refused')).result).toBe('not_run')
  })

  it('a call cut by a quit stops saying it is waiting for the result', async () => {
    const id = ask({})
    db.decideApproval(id, 'approved')
    await runner().settleDecidedRuns()
    const a = db.approval(id)!
    expect(a.result).toBeUndefined()
    expect(a.outcome).toContain('antes de saber o resultado')
  })
})
