import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Approval, Message, Routine, Settings } from '../src/shared/types'
import { deleteAgent, type AgentDeleteDeps } from '../src/core/agent-delete'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Memories } from '../src/core/memory'
import { Runner } from '../src/core/runs'
import { Skills } from '../src/core/skills'
import { NEEDS } from '../src/core/policy-people'

const agent = (id: string, handle: string, more: Partial<Agent> = {}): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: 'Revisa', color: 'sky', instructions: 'Seja breve', modelId: 'sonnet', accountId: 'conta-1', effort: 'low', limit: 1_000_000, used: 0, grants: { c1: 'read_write' }, memory: 'auto', computer: true, computerKind: 'mac', browser: true, apps: [{ name: 'Notas', level: 'read' }], autoApprove: ['c1:merge'], archived: false, ...more
})
const routine = (id: string, agentId: string, conversationId: string): Routine => ({ id, name: id, agentId, conversationId, prompt: 'x', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 })
const approval = (id: string, agentId: string): Approval => ({ id, hash: id, agentId, conversationId: 'general', messageId: 'm', connectorId: 'c1', connectorName: 'GitLab', tool: 'merge', args: {}, why: '', highRisk: false, state: 'pending', createdAt: 1, expiresAt: Date.now() + 60_000 })
const running = (id: string, conversationId: string, author: Message['author']): Message => ({ id, conversationId, author, text: '', at: 1, run: { status: 'working', steps: [] } as unknown as Message['run'] })

let db: Db
let workDir: string
let memory: Memories
let skills: Skills
let events: CoreEvent[]
let stopped: string[]
let erased: Agent[]
let browsers: string[]
let deps: AgentDeleteDeps

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'ad-delete-'))
  db = new Db(join(dir, 'test.db'))
  workDir = join(dir, 'agents')
  events = []
  stopped = []
  erased = []
  browsers = []
  const emit = (e: CoreEvent): void => void events.push(e)
  memory = new Memories({ db, engines: {} as never, settings: (async () => ({})) as never, emit, workDir })
  skills = new Skills({ db, emit, notify: () => {} })
  deps = {
    db,
    emit,
    emitConversations: (ids) => void events.push({ type: 'conversation', conversation: db.conversation(ids[0]!)! }),
    workDir,
    stopRun: (id) => void stopped.push(id),
    forgetSessions: () => {},
    removeRoutine: (id) => db.removeRoutine(id),
    deleteConversation: (id) => db.deleteConversation(id),
    forgetMemories: (id) => memory.forgetAgent(id),
    forgetSkills: (id) => skills.forgetAgent(id),
    eraseComputer: async (a) => void erased.push(a),
    eraseBrowser: async (a) => void browsers.push(a.id)
  }
  db.saveAgent(agent('a1', 'leo'))
  db.saveAgent(agent('a2', 'iris'))
  db.createConversation({ id: 'general', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
  db.createConversation({ id: 'dm1', kind: 'dm', name: 'a1', members: ['a1'] })
  db.createConversation({ id: 'dm2', kind: 'dm', name: 'a2', members: ['a2'] })
})

describe('deleting an agent', () => {
  it('what was its own goes, and its messages in channels stay under its name', async () => {
    db.saveMessage({ id: 'old', conversationId: 'general', author: { kind: 'agent', id: 'a1' }, text: 'achei o erro', at: 1 })
    db.saveMessage({ id: 'private', conversationId: 'dm1', author: { kind: 'agent', id: 'a1' }, text: 'só nós', at: 2 })
    db.saveRoutine(routine('r1', 'a1', 'general'))
    db.saveRoutine(routine('r2', 'a2', 'general'))
    db.setFolders('a1', [{ path: 'C:/projeto', mode: 'read' }] as never)

    await deleteAgent('a1', deps)

    expect(db.conversation('dm1')).toBeUndefined()
    expect(db.message('private')).toBeUndefined()
    expect(db.conversation('dm2')).toBeDefined()
    expect(db.conversation('general')!.members).toEqual(['a2'])
    expect(db.message('old')!.text).toBe('achei o erro')
    expect(db.routines().map((r) => r.id)).toEqual(['r2'])

    const left = db.agent('a1')!
    expect(left).toMatchObject({ name: 'Leo', color: 'sky', archived: true, kind: 'removed', instructions: '', role: '', grants: {}, computer: false, browser: false, apps: [], autoApprove: [] })
    expect(left.accountId).toBeUndefined()
    expect(left.folders).toEqual([])
    expect(events).toContainEqual({ type: 'agent', agent: left })
  })

  it('frees the handle for a new agent', async () => {
    await deleteAgent('a1', deps)
    expect(() => db.saveAgent(agent('a3', 'leo'))).not.toThrow()
    expect(db.agent('a3')!.handle).toBe('leo')
  })

  it("keeps the receipts, so the month's totals don't change", async () => {
    db.addReceipt({ model: 'sonnet', inputTokens: 700, cacheReadTokens: 0, outputTokens: 0, ms: 1, messageId: 'private', agentId: 'a1', engine: 'claude', at: Date.now() })
    const before = db.usedThisMonth('a1')
    expect(before).toBeGreaterThan(0)
    await deleteAgent('a1', deps)
    expect(db.usedThisMonth('a1')).toBe(before)
  })

  it('stops its replies, also those of its routines, and leaves the others running', async () => {
    db.saveRoutine(routine('r1', 'a1', 'general'))
    db.saveMessage(running('mine', 'general', { kind: 'agent', id: 'a1' }))
    db.saveMessage(running('by-routine', 'general', { kind: 'routine', id: 'r1' }))
    db.saveMessage(running('other', 'general', { kind: 'agent', id: 'a2' }))
    await deleteAgent('a1', deps)
    expect(stopped.sort()).toEqual(['by-routine', 'mine'])
  })

  it('expires only its own pending approvals', async () => {
    db.createApproval(approval('p1', 'a1'))
    db.createApproval(approval('p2', 'a2'))
    await deleteAgent('a1', deps)
    const state = (id: string): string | undefined => db.approvals().find((a) => a.id === id)?.state
    expect(state('p1')).toBe('expired')
    expect(state('p2')).toBe('pending')
  })

  it('forgets the memories that are its own, and keeps the ones about the person', async () => {
    memory.add('a1', 'prefere testes curtos')
    memory.add('me', 'trabalha em São Paulo')
    expect(db.memories({ scope: 'a1' })).toHaveLength(1)
    await deleteAgent('a1', deps)
    expect(db.memories({ scope: 'a1' })).toEqual([])
    expect(db.memories({ scope: 'me' }).map((m) => m.text)).toEqual(['trabalha em São Paulo'])
  })

  it("a skill only it used is archived, never left applying to everyone; a shared one loses only this agent", async () => {
    const recipe = { description: 'quando', body: 'como' }
    const own = skills.save({ ...recipe, name: 'so-dele', agents: ['a1'] })
    const shared = skills.save({ ...recipe, name: 'dos-dois', agents: ['a1', 'a2'] })
    const everyone = skills.save({ ...recipe, name: 'de-todos', agents: [] })
    const proposal = skills.propose(db.agent('a1')!, { nome: 'proposta', quando_usar: 'x', receita: 'y' }).skill!

    await deleteAgent('a1', deps)

    expect(db.skill(own.id)!.state).toBe('archived')
    expect(skills.forAgent('a2').map((k) => k.name).sort()).toEqual(['de-todos', 'dos-dois'])
    expect(db.skill(shared.id)!.agents).toEqual(['a2'])
    expect(db.skill(everyone.id)!.agents).toEqual([])
    expect(db.skill(proposal.id)).toBeUndefined()
  })

  it('erases the computer and browser as they were, and its working folder', async () => {
    const folder = join(workDir, 'a1')
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'sobra.txt'), 'x')
    await deleteAgent('a1', deps)
    expect(erased[0]).toMatchObject({ id: 'a1', computer: true, computerKind: 'mac' })
    expect(browsers).toEqual(['a1'])
    expect(existsSync(folder)).toBe(false)
    expect(existsSync(workDir)).toBe(true)
  })

  it('still finishes when the computer or the browser fail', async () => {
    deps.eraseComputer = async () => {
      throw new Error('docker is down')
    }
    deps.eraseBrowser = async () => {
      throw new Error('no chrome')
    }
    await expect(deleteAgent('a1', deps)).resolves.toBeUndefined()
    expect(db.agent('a1')!.kind).toBe('removed')
  })

  it('only an admin may delete an agent, as only an admin may archive one', () => {
    expect(NEEDS.deleteAgent).toBe('admin')
    expect(NEEDS.deleteAgent).toBe(NEEDS.archiveAgent)
  })

  it("won't delete the Tuca, and changes nothing trying", () => {
    db.saveAgent(agent('t', 'tuca', { kind: 'tuca' }))
    db.createConversation({ id: 'dmt', kind: 'dm', name: 't', members: ['t'] })
    expect(() => deleteAgent('t', deps)).toThrow('Tuca')
    expect(db.agent('t')!.archived).toBe(false)
    expect(db.conversation('dmt')).toBeDefined()
  })

  it('deleting twice, or an agent that never was, does nothing', async () => {
    await deleteAgent('a1', deps)
    const n = events.length
    await deleteAgent('a1', deps)
    await deleteAgent('nobody', deps)
    expect(events).toHaveLength(n)
    expect(erased).toHaveLength(1)
  })

  it('a reply still queued or retried does not start once the agent is gone', async () => {
    const turns: unknown[] = []
    const base = fakeEngine('claude', { delayMs: 1 })
    const engine: Engine = { ...base, run: (turn, ...rest) => (turns.push(turn), base.run(turn, ...rest)) }
    const ready = { installed: true, loggedIn: true }
    const settings = { workspaceName: 'Edu', context: '', engines: { claude: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as unknown as Settings
    const runner = new Runner({ db, engines: { claude: engine } as never, settings: async () => settings, emit: () => {}, workDir })
    const failed = (id: string, agentId: string): Message => ({ id, conversationId: 'general', author: { kind: 'agent', id: agentId }, text: '', at: 1, run: { status: 'failed', steps: [] } as unknown as Message['run'] })
    db.saveMessage(failed('gone', 'a1'))
    db.saveMessage(failed('kept', 'a2'))
    await deleteAgent('a1', deps)

    runner.retry('gone')
    await runner.idle()
    expect(turns).toEqual([])
    expect(db.message('gone')!.run!.status).toBe('failed')
    expect(existsSync(join(workDir, 'a1'))).toBe(false)

    runner.retry('kept') // the same retry does run for an agent still on the team
    await runner.idle()
    expect(turns).toHaveLength(1)
    expect(db.message('kept')!.run!.status).toBe('done')
  })
})
