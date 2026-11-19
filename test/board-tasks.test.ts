// The board's to-dos (Quadro): each person's own list, and starting one posts it to its agent.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Conversation, Message, Person, Task } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bia: Client // a member
let lia: string // an agent's id
type Snap = { agents: { id: string; handle: string }[]; conversations: Conversation[]; messages: Message[] }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const until = async (ok: () => Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  lia = (await ana.call<Snap>('snapshot')).agents.find((a) => a.handle === 'lia')!.id
  const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
  const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
  bia = core.connect(r.data.person!.id)
}, 30_000)
afterAll(() => {
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
})

describe('the board’s to-dos', () => {
  it('a new one goes on top; edits keep what they leave out; text is trimmed and capped', async () => {
    const a = await ana.call<Task>('saveTask', { task: { title: '  Revisar   o contrato ' } })
    const b = await ana.call<Task>('saveTask', { task: { title: 'Levantar os clientes', agentId: lia, notes: 'dos últimos 30 dias' } })
    expect(a.title).toBe('Revisar o contrato')
    expect((await ana.call<Task[]>('tasks')).map((t) => t.id)).toEqual([b.id, a.id])
    const edited = await ana.call<Task>('saveTask', { task: { id: b.id, title: 'Levantar os clientes parados' } })
    expect(edited).toMatchObject({ agentId: lia, notes: 'dos últimos 30 dias', position: b.position })
    expect((await ana.call<Task>('saveTask', { task: { id: b.id, title: edited.title, agentId: '' } })).agentId).toBeUndefined()
    expect((await ana.call<Task>('saveTask', { task: { title: 'x'.repeat(1000) } })).title).toHaveLength(300)
    expect(await err(ana.call('saveTask', { task: { title: '   ' } }))).toMatch(/Escreva|Write/)
  })

  it('moving one sets its place', async () => {
    const [first, second] = await ana.call<Task[]>('tasks')
    await ana.call('saveTask', { task: { id: first!.id, title: first!.title, position: second!.position + 1 } })
    expect((await ana.call<Task[]>('tasks'))[0]!.id).toBe(second!.id)
  })

  it("each sees only their own, and can't change or start someone else's", async () => {
    const mine = (await ana.call<Task[]>('tasks'))[0]!
    expect(await bia.call<Task[]>('tasks')).toEqual([])
    expect(await err(bia.call('saveTask', { task: { id: mine.id, title: 'da Bia' } }))).toMatch(/não existe|no longer/)
    expect(await err(bia.call('startTask', { id: mine.id }))).toMatch(/não existe|no longer/)
    await bia.call('removeTask', { id: mine.id })
    expect((await ana.call<Task[]>('tasks')).some((t) => t.id === mine.id)).toBe(true)
  })

  it('a channel only when the agent is in it', async () => {
    const snap = await ana.call<Snap>('snapshot')
    const dm = snap.conversations.find((c) => c.kind === 'dm')
    if (dm) expect(await err(ana.call('saveTask', { task: { title: 'na DM', conversationId: dm.id } }))).toMatch(/canal|channel/)
    const other = snap.conversations.find((c) => c.kind === 'channel' && !c.members.includes(lia))
    if (other) expect(await err(ana.call('saveTask', { task: { title: 'fora', agentId: lia, conversationId: other.id } }))).toMatch(/não está|isn’t/)
  })

  it('starting needs an agent; then it posts as my message in its DM and leaves the list', async () => {
    const t = await ana.call<Task>('saveTask', { task: { title: 'Escrever o post 4242', notes: 'Tom leve.' } })
    expect(await err(ana.call('startTask', { id: t.id }))).toMatch(/quem faz|who does/)
    await ana.call('saveTask', { task: { id: t.id, title: t.title, agentId: lia } })
    const { conversationId } = await ana.call<{ conversationId: string }>('startTask', { id: t.id })
    expect((await ana.call<Task[]>('tasks')).some((x) => x.id === t.id)).toBe(false)
    await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.conversationId === conversationId && m.author.kind === 'person' && m.text === 'Escrever o post 4242\n\nTom leve.'))
    const conv = (await ana.call<Snap>('snapshot')).conversations.find((c) => c.id === conversationId)!
    expect(conv).toMatchObject({ kind: 'dm', name: lia })
    expect(await bia.call<Snap>('snapshot').then((s) => s.messages.some((m) => m.text.includes('4242')))).toBe(false)
  })

  it('removing one', async () => {
    const t = await ana.call<Task>('saveTask', { task: { title: 'Apagar' } })
    await ana.call('removeTask', { id: t.id })
    expect((await ana.call<Task[]>('tasks')).some((x) => x.id === t.id)).toBe(false)
  })
})
