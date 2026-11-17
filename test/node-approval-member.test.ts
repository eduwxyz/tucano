// A lent computer on a team server: what runs on it is its person's alone to allow, over the API each
// person's page calls (the real core, fake engines). A member decides on their own computer even when the
// agent is the team's (not theirs); an admin, the owner and the agent's person don't.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Approval, Conversation, Person } from '../src/shared/types'
import { nodeUrl } from '../src/shared/node-link'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner, whose agent it is
let bia: Client // a member, whose computer it is
let dani: Client // an admin
let biaId: string
let agentId: string
let geral: string
type Snap = { agents: Agent[]; conversations: Conversation[] }
type Inbox = { approvals: Approval[] }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

const join1 = async (name: string, role: 'member' | 'admin'): Promise<Person> => {
  const { code } = await ana.call<{ code: string }>('createInvite', { role })
  const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name }, 'join-result')
  return r.data.person!
}

// What an agent of Ana's, working for Bia in #geral, leaves when it asks to run a command on Bia's computer.
function ask(id: string): void {
  const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
  const now = Date.now()
  db.prepare('INSERT OR IGNORE INTO connectors (id, name, kind, url, created_at) VALUES (?, ?, ?, ?, ?)').run('node-bia', 'MacBook da Bia', 'remote', nodeUrl('mac-bia', biaId), now)
  db.prepare(
    'INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, why, created_at, expires_at, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, id, agentId, geral, 'm-' + id, 'node-bia', 'MacBook da Bia', 'node_bash', JSON.stringify({ command: 'git push' }), '', now, now + 3_600_000, biaId)
  db.close()
}
const state = (id: string): string | undefined => {
  const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
  const r = db.prepare('SELECT state FROM approvals WHERE id = ?').get(id) as { state: string } | undefined
  db.close()
  return r?.state
}

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const snap = await ana.call<Snap>('snapshot')
  geral = snap.conversations.find((c) => c.kind === 'channel')!.id
  agentId = snap.agents.find((a) => a.kind !== 'tuca')!.id // the owner's: not Bia's
  const bp = await join1('Bia', 'member')
  biaId = bp.id
  bia = core.connect(bp.id)
  dani = core.connect((await join1('Dani', 'admin')).id)
}, 30_000)
afterAll(() => {
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
})

describe("a command on a member's lent computer, asked by an agent that isn't hers", () => {
  it('is in her inbox, and she approves it over the API', async () => {
    ask('ap-1')
    expect((await bia.call<Inbox>('inbox')).approvals.map((a) => a.id)).toContain('ap-1')
    expect(await err(bia.call('decideApproval', { id: 'ap-1', decision: 'approved' }))).toBe('ok')
    await vi.waitFor(async () => expect(state('ap-1')).toBe('approved'))
  })

  it('she refuses one too', async () => {
    ask('ap-2')
    expect(await err(bia.call('decideApproval', { id: 'ap-2', decision: 'refused' }))).toBe('ok')
    await vi.waitFor(async () => expect(state('ap-2')).toBe('refused'))
  })

  it("an admin, and the owner whose agent it is, can't decide it; it stays waiting on her", async () => {
    ask('ap-3')
    expect(await err(dani.call('decideApproval', { id: 'ap-3', decision: 'approved' }))).toMatch(/só ela decide|only they decide/)
    expect(await err(ana.call('decideApproval', { id: 'ap-3', decision: 'approved' }))).toMatch(/só ela decide|only they decide/)
    expect(state('ap-3')).toBe('pending')
    expect((await dani.call<Inbox>('inbox')).approvals.map((a) => a.id)).not.toContain('ap-3')
  })

  it('says whose computer it is, so her page shows her the buttons and theirs do not', async () => {
    const a = (await bia.call<Inbox>('inbox')).approvals.find((x) => x.id === 'ap-3')
    expect(a?.computerOwner).toBe(biaId)
  })
})

describe('one of her devices signed out', () => {
  it("only that key stops working, and the server hears it (it ends her computers' lines; test/node-link.test.ts)", async () => {
    const mac = await core.ask<{ data: { key?: string } }>({ type: 'device-key', person: biaId, label: 'MacBook' }, 'device-key-result')
    const phone = await core.ask<{ data: { key?: string } }>({ type: 'device-key', person: biaId, label: 'iPhone' }, 'device-key-result')
    const id = (await bia.call<{ id: string; label: string }[]>('myDevices')).find((d) => d.label === 'MacBook')!.id
    const before = core.toMain.length
    await bia.call('removeDevice', { id })
    const signIn = async (key: string): Promise<boolean> => !!(await core.ask<{ person?: Person }>({ type: 'auth', key }, 'auth-result')).person
    expect(await signIn(mac.data.key!)).toBe(false)
    expect(await signIn(phone.data.key!)).toBe(true)
    expect(core.toMain.slice(before)).toContainEqual(expect.objectContaining({ type: 'person-changed', id: biaId }))
  })
})
