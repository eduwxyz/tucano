// revealArtifact on a desktop core: only the owner at the computer's own window reveals; a paired
// device or a member would open a Finder on a screen they can't see.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Conversation, Message, Person } from '../src/shared/types'
import { bootCore, type Client, type TestCore } from './helpers/core'

let core: TestCore
let owner: Client
let device: Client
let member: Client
let channel: string
let messageId: string
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)
const opened = (): Record<string, unknown>[] => core.toMain.filter((m) => m['type'] === 'open_local')
const insertArtifact = (id: string, name: string): void => {
  const db = new DatabaseSync(join(core.dataDir, 'tucano.db'))
  db.prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'lia', channel, messageId, 'file', name, name, name, 3, Date.now())
  db.close()
}

beforeAll(async () => {
  core = await bootCore()
  owner = core.connect()
  const { code } = await owner.call<{ code: string }>('createInvite', { role: 'member' })
  const r = await core.ask<{ data: { person?: Person } }>({ type: 'join', code, name: 'Bia' }, 'join-result')
  member = core.connect(r.data.person!.id)
  device = core.connect(undefined, 'device-hash')
  channel = (await owner.call<{ conversations: Conversation[] }>('snapshot')).conversations.find((c) => c.kind === 'channel')!.id
  await owner.call('sendMessage', { conversationId: channel, text: 'oi' })
  await new Promise((r) => setTimeout(r, 300))
  messageId = (await owner.call<{ messages: Message[] }>('snapshot')).messages.find((m) => m.conversationId === channel)!.id
  insertArtifact('art-ok', 'dados.bin')
  mkdirSync(join(core.dataDir, 'artifacts', 'art-ok'), { recursive: true })
  writeFileSync(join(core.dataDir, 'artifacts', 'art-ok', 'dados.bin'), 'abc')
})
afterAll(() => {
  try { rmSync(core.dataDir, { recursive: true, force: true }) } catch {}
})

describe('revealArtifact', () => {
  it('refuses a paired device, even the owner’s, and a member who can see the artifact', async () => {
    expect(await err(device.call('revealArtifact', { id: 'art-ok' }))).not.toBe('ok')
    expect(await err(member.call('revealArtifact', { id: 'art-ok' }))).not.toBe('ok')
    expect(opened()).toEqual([])
  })

  it('reveals for the owner at the computer’s window, never opening', async () => {
    await owner.call('revealArtifact', { id: 'art-ok' })
    expect(opened()).toEqual([{ type: 'open_local', path: join(core.dataDir, 'artifacts', 'art-ok', 'dados.bin'), how: 'reveal' }])
  })

  it('refuses a name that leaves its folder, though the file it points to exists', async () => {
    writeFileSync(join(core.dataDir, 'segredo.txt'), 'x')
    mkdirSync(join(core.dataDir, 'artifacts', 'art-other'), { recursive: true })
    writeFileSync(join(core.dataDir, 'artifacts', 'art-other', 'outro.bin'), 'x')
    for (const [i, name] of ['../../segredo.txt', '../art-other/outro.bin', '..', '/etc/hosts'].entries()) {
      insertArtifact(`art-bad-${i}`, name)
      expect(await err(owner.call('revealArtifact', { id: `art-bad-${i}` })), name).toMatch(/no longer here|não está mais/)
    }
    insertArtifact('..', 'dados.bin')
    expect(await err(owner.call('revealArtifact', { id: '..' }))).not.toBe('ok')
    expect(opened()).toHaveLength(1)
  })

  it('refuses an unknown artifact', async () => {
    expect(await err(owner.call('revealArtifact', { id: 'nao-existe' }))).not.toBe('ok')
    expect(opened()).toHaveLength(1)
  })
})
