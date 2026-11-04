// A lead hands a task to another agent, and that agent reaches an action that matters: it's
// still the person who decides, in the conversation where the work happens, and the lead
// waits. On a task, the strictest rule of everyone in the chain counts.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ActionRules } from '../src/shared/actions'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import type { Computers } from '../src/core/computer'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway, textResult } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return { id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }
}

let db: Db
let gateway: Gateway
let turns: Turn[]
let notes: { title: string; kind?: string }[]
let settings: Settings
let ran: { agent: string; command: string }[]

// A computer that only says what it ran.
const computers = {
  call: async (a: Agent, name: string, args: Record<string, unknown>) => {
    if (name !== 'bash') return { result: textResult(`ok: ${name}`) }
    ran.push({ agent: a.id, command: String(args['command']) })
    return { result: textResult(`exit 0\n[rodou] ${String(args['command'])}`) }
  }
} as unknown as Computers

function runner(): Runner {
  turns = []
  const fake = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), fake.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex', { delayMs: 1 }), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'da-work-')), gateway, computers, notify: (title, _body, _conv, kind) => notes.push({ title, kind }) })
}

const said = (conversationId: string): Message[] => db.messages().filter((m) => m.conversationId === conversationId && m.author.kind === 'agent')
const pair = (a: string, b: string): string => db.conversations().find((c) => c.kind === 'agents' && c.members.includes(a) && c.members.includes(b))!.id
const turnsOf = (id: string): Turn[] => turns.filter((t) => t.system.startsWith(`Você é ${id} (@${id})`))
const rules = (id: string, actionRules: ActionRules): void => db.saveAgent({ ...db.agent(id)!, actionRules })

beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'da-db-')), 'test.db'))
  notes = []
  ran = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  db.saveAgent(agent('chefe', { role: 'Manager', team: ['dev'] }))
  db.saveAgent(agent('dev', { role: 'Engenharia', computer: true }))
  db.createConversation({ id: 'dm', kind: 'dm', name: 'chefe', members: ['chefe'] })
  gateway = new Gateway()
  await gateway.start()
  return () => gateway.stop()
})

describe('a delegated task that reaches an action that matters', () => {
  it('waits for the person in the DM between the agents, and the lead waits too', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: rode `git commit -m wip`')
    await r.idle()

    const withDev = pair('chefe', 'dev')
    const [ap] = db.approvals()
    expect(ap).toMatchObject({ state: 'pending', agentId: 'dev', conversationId: withDev, connectorId: 'computador', args: { command: 'git commit -m wip' } })
    expect(said(withDev).at(-1)!.run).toMatchObject({ status: 'waiting_approval', approvalId: ap!.id, delegation: { by: 'chefe' } })
    expect(ran).toEqual([])
    expect(notes).toContainEqual({ title: 'dev quer fazer commit', kind: 'approval' })
    // The lead hasn't heard back: one message of its own, the one that delegated.
    expect(said('dm')).toHaveLength(1)
    expect(turnsOf('chefe')).toHaveLength(1)

    await r.decide(ap!.id, 'approved')
    await r.idle()

    expect(ran).toEqual([{ agent: 'dev', command: 'git commit -m wip' }])
    // The delegate goes on with its task, told what ran; then the lead gets the results.
    expect(turnsOf('dev').at(-1)!.prompt).toContain('Edu aprovou rodar `git commit -m wip`')
    expect(turnsOf('dev').at(-1)!.prompt).toContain('<tarefa>\nrode `git commit -m wip`\n</tarefa>')
    expect(said('dm')).toHaveLength(2)
    expect(turnsOf('chefe').at(-1)!.prompt).toContain('Voltou o que você delegou')
  })

  it('refused: nothing runs, and the lead still gets the task back', async () => {
    const r = runner()
    await r.send('dm', 'delegue a @dev: rode `git push origin main`')
    await r.idle()
    await r.decide(db.approvals()[0]!.id, 'refused', 'ainda não')
    await r.idle()
    expect(ran).toEqual([])
    expect(turnsOf('dev').at(-1)!.prompt).toContain('recusou rodar `git push origin main`: "ainda não"')
    expect(said('dm')).toHaveLength(2)
  })
})

describe('the strictest rule in the chain', () => {
  it("a lead can't get done by delegating what its own rules hold back", async () => {
    rules('chefe', { push: 'off' })
    rules('dev', { push: 'auto' })
    const r = runner()
    await r.send('dm', 'delegue a @dev: rode `git push origin main`')
    await r.idle()
    expect(ran).toEqual([])
    expect(db.approvals()).toEqual([])
    const reply = said(pair('chefe', 'dev')).at(-1)!
    expect(reply.text).toContain('subir commits (push) está desligado pra você nesta tarefa, pelas regras de quem te passou ela')
    expect(said('dm')).toHaveLength(2) // the lead gets that back
  })

  it("the lead's \"ask\" makes the delegate ask, even when it would do it alone", async () => {
    rules('dev', { commit: 'auto' })
    const r = runner()
    await r.send('dm', 'delegue a @dev: rode `git commit -m x`')
    await r.idle()
    expect(ran).toEqual([])
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', agentId: 'dev' })
  })

  it("the delegate's own \"ask\" still counts when the lead does it alone", async () => {
    settings = { ...settings, actionRules: { commit: 'auto' } }
    rules('dev', { commit: 'ask' })
    const r = runner()
    await r.send('dm', 'delegue a @dev: rode `git commit -m x`')
    await r.idle()
    expect(db.approvals()[0]).toMatchObject({ state: 'pending', agentId: 'dev' })
  })

  it('when everyone in the chain does it alone, it runs right away', async () => {
    settings = { ...settings, actionRules: { commit: 'auto' } }
    const r = runner()
    await r.send('dm', 'delegue a @dev: rode `git commit -m x`')
    await r.idle()
    expect(ran).toEqual([{ agent: 'dev', command: 'git commit -m x' }])
    expect(db.approvals()).toEqual([])
  })

  it('outside a task, only its own rules count', async () => {
    rules('chefe', { commit: 'off' })
    rules('dev', { commit: 'auto' })
    db.createConversation({ id: 'dm-dev', kind: 'dm', name: 'dev', members: ['dev'] })
    const r = runner()
    await r.send('dm-dev', 'rode `git commit -m x`')
    await r.idle()
    expect(ran).toEqual([{ agent: 'dev', command: 'git commit -m x' }])
  })
})
