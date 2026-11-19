// Tucano Team v1, sixth round: what the real core answers each person over its API (fake engines).
// One core for the whole file: the describes run in order and build on each other.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Artifact, Conversation, Message, Person } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
let bia: Client // a member
const crashes: unknown[] = []
const onCrash = (e: unknown): void => void crashes.push(e)
const until = async (ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
type Snap = { you: string; agents: Agent[]; conversations: Conversation[]; messages: Message[]; artifacts: Artifact[]; demoServer?: unknown }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

let geral: string
let old: Message[] // #geral before Bia: the owner's alone
const ART = 'art-heritage-0001'

beforeAll(async () => {
  process.on('unhandledRejection', onCrash)
  process.on('uncaughtException', onCrash)
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  geral = (await ana.call<Snap>('snapshot')).conversations.find((c) => c.kind === 'channel')!.id
}, 30_000)
afterAll(() => {
  process.off('unhandledRejection', onCrash)
  process.off('uncaughtException', onCrash)
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {} // Windows: still open
  expect(crashes).toEqual([])
})

describe('A. the heritage reaches no member through any message path', () => {
  it('(setup) alone, Ana talks in #geral and an agent shows a file there; solo, she reaches it all', async () => {
    await ana.call('sendMessage', { conversationId: geral, text: 'ANTIGA: plano secreto da Ana' })
    await until(async () => (await ana.call<Snap>('snapshot')).messages.some((m) => m.conversationId === geral && m.text.startsWith('ANTIGA')))
    old = (await ana.call<Snap>('snapshot')).messages.filter((m) => m.conversationId === geral)
    const msg = old.find((m) => m.text.startsWith('ANTIGA'))!
    // An agent's file shown in that message (as show_file saves one).
    const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
    db.prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(ART, 'lia', geral, msg.id, 'text', 'plano.md', 'Plano', 'plano.md', 20, msg.at)
    db.close()
    mkdirSync(join(core.dataDir, 'artifacts', ART), { recursive: true })
    writeFileSync(join(core.dataDir, 'artifacts', ART, 'plano.md'), 'ANTIGA: o plano todo')
    expect((await ana.call<Snap>('snapshot')).artifacts.map((a) => a.id)).toContain(ART)
    expect(await ana.call('artifactText', { id: ART })).toBe('ANTIGA: o plano todo')
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'member' })
    const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
    bia = core.connect(r.data.person!.id)
    await ana.call('sendMessage', { conversationId: geral, text: 'NOVA: depois da Bia' })
    await until(async () => (await bia.call<Snap>('snapshot')).messages.some((m) => m.text.startsWith('NOVA')))
  })

  it("Bia's snapshot and events carry no message or file from before; Ana's carry them", async () => {
    const snap = await bia.call<Snap>('snapshot')
    const ids = new Set(old.map((m) => m.id))
    expect(snap.messages.filter((m) => ids.has(m.id))).toEqual([])
    expect(snap.artifacts.map((a) => a.id)).not.toContain(ART)
    const seen = bia.events.flatMap((e: CoreEvent) => (e.type === 'message' ? [e.message.id] : e.type === 'artifact' ? [e.artifact.id] : []))
    expect(seen.filter((id) => ids.has(id) || id === ART)).toEqual([])
    const ours = await ana.call<Snap>('snapshot')
    expect(ours.messages.filter((m) => ids.has(m.id)).length).toBe(old.length)
    expect(ours.artifacts.map((a) => a.id)).toContain(ART)
  })

  it('the file from before: its text is not Bia’s, still Ana’s', async () => {
    expect(await bia.call('artifactText', { id: ART })).toBeNull()
    expect(await ana.call('artifactText', { id: ART })).toBe('ANTIGA: o plano todo')
  })

  it('every call that takes a message id refuses Bia one from before', async () => {
    for (const m of old) {
      for (const [method, params] of [
        ['wikiKeepMessage', { messageId: m.id }],
        ['localPath', { messageId: m.id, path: '/etc/hosts' }],
        ['openLocal', { messageId: m.id, path: '/etc/hosts', how: 'reveal' }],
        ['retryRun', { messageId: m.id }],
        ['continueRun', { messageId: m.id }],
        ['stopRun', { messageId: m.id }],
        ['settleDraft', { messageId: m.id }],
        ['applyProposal', { messageId: m.id }],
        ['dismissProposal', { messageId: m.id }],
        ['editThreadSummary', { rootId: m.id, text: 'x' }],
        ['summarizeThreadNow', { rootId: m.id }]
      ] as const) {
        expect(await err(bia.call(method, params)), `${method} ${m.text.slice(0, 20)}`).not.toBe('ok')
      }
    }
  })

  it('the wiki got nothing from it', async () => {
    const data = await ana.call<{ pages: { title: string; summary?: string }[] }>('wiki')
    expect(JSON.stringify(data)).not.toMatch(/ANTIGA|plano secreto/)
  })
})

describe("B. the demo connector's path on the owner's machine is the owner's", () => {
  it('Ana gets demoServer; Bia, a member, and an admin do not', async () => {
    expect((await ana.call<Snap>('snapshot')).demoServer).toBeTruthy()
    expect((await bia.call<Snap>('snapshot')).demoServer).toBeUndefined()
    const { code } = await ana.call<{ code: string }>('createInvite', { role: 'admin' })
    const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Caio' }, 'join-result')
    const caio = core.connect(r.data.person!.id)
    expect((await caio.call<Snap>('snapshot')).demoServer).toBeUndefined()
  })
})
