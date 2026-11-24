// Executions through the real core: who may ask, and what each person gets back.
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { weekStart } from '../src/core/report'
import type { Agent, ExecutionPage, ExecutionStep, Report } from '../src/shared/types'
import { bootCore, type Client } from './helpers/core'

let owner: Client
let admin: Client
let member: Client
const agent: Agent = { id: 'exec-a', name: 'Exec', handle: 'exec-a', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, grants: {} } as unknown as Agent

beforeAll(async () => {
  const core = await bootCore({ server: true })
  const db = new Db(join(core.dataDir, 'tucano.db'))
  db.addPerson({ id: 'exec-admin', name: 'Ana', role: 'admin', about: '' })
  db.addPerson({ id: 'exec-member', name: 'Bia', role: 'member', about: '' })
  db.saveAgent(agent)
  db.createConversation({ id: 'exec-channel', kind: 'channel', name: 'exec-geral', members: [agent.id] })
  db.createConversation({ id: 'exec-owner-dm', kind: 'dm', name: agent.id, members: [agent.id], owner: db.ownerId() })
  const reply = (id: string, conversationId: string, tool: string, ago = 1000): void =>
    db.saveMessage({ id, conversationId, author: { kind: 'agent', id: agent.id }, text: `texto ${id}`, at: Date.now() - ago, run: { status: 'done', endedAt: Date.now(), steps: [{ id: `${id}-s`, label: 'Rodou', tool, status: 'done', ms: 10 }], receipt: { model: 'opus', inputTokens: 1, cacheReadTokens: 0, outputTokens: 1, ms: 500 } } })
  reply('exec-public', 'exec-channel', 'tool_public')
  reply('exec-private', 'exec-owner-dm', 'tool_private')
  db.saveMessage({ id: 'exec-private-failed', conversationId: 'exec-owner-dm', author: { kind: 'agent', id: agent.id }, text: '', at: Date.now() - 2000, run: { status: 'failed', error: 'segredo da DM do dono', steps: [] } })
  db.setMeta('heritageAt', String(Date.now() - 60_000)) // what the channel held before the Tucano had more people is the owner's
  reply('exec-heritage', 'exec-channel', 'tool_heritage', 120_000)
  owner = core.connect()
  admin = core.connect('exec-admin')
  member = core.connect('exec-member')
}, 30_000)

const ids = async (c: Client): Promise<string[]> => (await c.call<ExecutionPage>('executions', { days: 1, agentId: agent.id })).rows.map((r) => r.id)

describe('executions through the core', () => {
  it('gives each admin only what they may read', async () => {
    expect((await ids(owner)).sort()).toEqual(['exec-heritage', 'exec-private', 'exec-private-failed', 'exec-public'])
    expect(await ids(admin)).toEqual(['exec-public'])
  })

  it('opens a reply into its steps only for someone who may read it', async () => {
    expect(await owner.call<ExecutionStep[]>('executionSteps', { messageId: 'exec-private' })).toHaveLength(1)
    await expect(admin.call('executionSteps', { messageId: 'exec-private' })).rejects.toThrow()
    await expect(admin.call('executionSteps', { messageId: 'exec-heritage' })).rejects.toThrow()
  })

  it('refuses a member, for the list and for the steps', async () => {
    await expect(member.call('executions', { days: 1 })).rejects.toThrow()
    await expect(member.call('executionSteps', { messageId: 'exec-public' })).rejects.toThrow()
  })

  it('takes only the periods the page offers', async () => {
    await expect(owner.call('executions', { days: 3650 })).rejects.toThrow()
  })

  it('puts in the Report’s Tools what the viewer may read', async () => {
    const tools = async (c: Client): Promise<string[]> => (await c.call<Report>('report', { week: weekStart(Date.now()) })).tools.map((t) => t.tool).sort()
    expect(await tools(owner)).toEqual(['tool_heritage', 'tool_private', 'tool_public'])
    expect(await tools(admin)).toEqual(['tool_public'])
  })

  it('lists in the Report’s problems only what the viewer may read', async () => {
    const problems = async (c: Client): Promise<string[]> => (await c.call<Report>('report', { week: weekStart(Date.now()) })).agents.find((a) => a.agentId === agent.id)!.problems.flatMap((p) => p.detail ?? [])
    expect(await problems(owner)).toEqual(['segredo da DM do dono'])
    expect(await problems(admin)).toEqual([])
  })
})
