import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { workspacePorts } from '../src/core/ports'
import { Memories } from '../src/core/memory'
import { fakeEngine } from '../src/core/engines/fake'
import { initializeWorkspace } from '../src/core/seed'
import type { Agent, Message, Settings } from '../src/shared/types'

const defaults: Omit<Settings, 'engines'> = { workspaceName: 'Test', context: '', routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'en' }

const dirs: string[] = []
const dbs: Db[] = []
const open = (file: string): Db => { const db = new Db(file); dbs.push(db); return db }
afterEach(() => {
  for (const db of dbs.splice(0)) db.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('uses legacy ports by default and validates per-workspace ports', () => {
  expect(workspacePorts({})).toEqual({ webhook: 47717, git: 47718 })
  expect(workspacePorts({ TUCANO_WEBHOOK_PORT: '49001', TUCANO_GIT_PORT: '49002' })).toEqual({ webhook: 49001, git: 49002 })
  for (const port of ['0', 'NaN', '65536', '47718', '4000.1']) expect(() => workspacePorts({ TUCANO_WEBHOOK_PORT: port })).toThrow()
})

it('starts newly created workspaces with onboarding, even when the original install uses demo seeds', () => {
  const original = open(':memory:')
  const env = { TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1' }
  initializeWorkspace(original, env)
  expect(original.agents().length).toBeGreaterThan(0)
  for (const seed of [undefined, '0', '1']) {
    const workspace = open(':memory:')
    initializeWorkspace(workspace, { ...env, TUCANO_DEFAULT_WORKSPACE: '0', TUCANO_SEED: seed })
    expect(workspace.getSettings(defaults)).toMatchObject({ onboarding: { done: false } })
    expect(workspace.agents()).toEqual([])
    expect(workspace.conversations()).toEqual([])
    expect(workspace.memories()).toEqual([])
    expect(workspace.routines()).toEqual([])
  }
})

it('preserves existing agents and onboarding state on restart, independently in each workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-workspace-agents-'))
  dirs.push(dir)
  const agent: Agent = { id: 'same-agent', name: 'Aurora Company', handle: 'aurora', role: '', color: 'sky', instructions: 'Company only', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  const work = new Db(join(dir, 'work.db'))
  const personal = new Db(join(dir, 'personal.db'))
  initializeWorkspace(work, { TUCANO_DEFAULT_WORKSPACE: '0' })
  initializeWorkspace(personal, { TUCANO_DEFAULT_WORKSPACE: '0' })
  work.saveAgent(agent)
  personal.saveAgent({ ...agent, name: 'Boreal Personal', handle: 'boreal', instructions: 'Personal only' })
  work.setSettings({ onboarding: { done: true } })
  personal.setSettings({ onboarding: { done: true } })
  work.close()
  personal.close()
  const reopenedWork = open(join(dir, 'work.db'))
  const reopenedPersonal = open(join(dir, 'personal.db'))
  for (const db of [reopenedWork, reopenedPersonal]) initializeWorkspace(db, { TUCANO_DEFAULT_WORKSPACE: '0', TUCANO_FAKE_ENGINES: '1', TUCANO_SEED: '1' })
  expect(reopenedWork.agents().map((a) => a.name)).toEqual(['Aurora Company'])
  expect(reopenedPersonal.agents().map((a) => a.name)).toEqual(['Boreal Personal'])
  expect(reopenedWork.agent(agent.id)?.instructions).toBe('Company only')
  expect(reopenedPersonal.agent(agent.id)?.instructions).toBe('Personal only')
  expect(reopenedWork.getSettings(defaults)).toMatchObject({ onboarding: { done: true } })
  expect(reopenedPersonal.getSettings(defaults)).toMatchObject({ onboarding: { done: true } })
})

it('keeps unread counts and memory data in the owning database with identical IDs', () => {
  const a = open(':memory:')
  const b = open(':memory:')
  for (const db of [a, b]) db.createConversation({ id: 'same-channel', kind: 'channel', name: 'project', members: [] })
  const message: Message = { id: 'same-message', conversationId: 'same-channel', author: { kind: 'agent', id: 'agent' }, text: '', at: 1, run: { status: 'working', steps: [] } }
  for (const db of [a, b]) db.saveMessage(message)
  a.recordActivity(message, null)
  a.recordActivity(message, null)
  expect(a.conversation('same-channel')?.unread).toBe(1)
  expect(b.conversation('same-channel')?.unread).toBe(0)
  a.markRead('same-channel')
  const completed: Message = { ...message, text: 'Company result', run: { status: 'done', steps: [] } }
  a.saveMessage(completed)
  a.recordActivity(completed, null)
  a.recordActivity(completed, null)
  expect(a.conversation('same-channel')?.unread).toBe(1)
  b.recordActivity(completed, 'same-channel')
  expect(b.conversation('same-channel')?.unread).toBe(0)
  a.saveMemory({ id: 'memory', scope: 'me', text: 'Only in A', state: 'active', origin: 'me', messageIds: [], createdAt: 1, confirmedAt: 1 })
  expect(a.memories().map((m) => m.text)).toEqual(['Only in A'])
  expect(b.memories()).toEqual([])
  const agent: Agent = { id: 'same-agent', name: 'Agent', handle: 'agent', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  const memory = (db: Db): Memories => new Memories({ db, engines: { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini') }, settings: async () => { throw new Error('Prompt lookup must not invoke a model') }, emit: () => {}, workDir: '' })
  expect(memory(a).forPrompt(agent).aboutMe.map((m) => m.text)).toEqual(['Only in A'])
  expect(memory(b).forPrompt(agent).aboutMe).toEqual([])
  a.deleteConversation('same-channel')
  expect(a.conversations()).toEqual([])
})

it('migrates every opened workspace and backs up older schemas before changing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-migrations-'))
  dirs.push(dir)
  const file = join(dir, 'tucano.db')
  const first = new Db(file)
  first.createConversation({ id: 'kept', name: 'kept', kind: 'channel', members: [] })
  first.close()
  const raw = new DatabaseSync(file)
  const version = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  raw.exec(`DROP TABLE message_notifications; PRAGMA user_version = ${version - 1}`)
  raw.close()
  const migrated = open(file)
  expect(migrated.conversation('kept')?.unread).toBe(0)
  const backups = readdirSync(join(dir, 'backups'))
  expect(backups).toHaveLength(1)
  const before = new DatabaseSync(join(dir, 'backups', backups[0]!))
  expect(before.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: version - 1 })
  before.close()
  const again = open(file)
  expect(again.conversation('kept')?.name).toBe('kept')
  expect(readdirSync(join(dir, 'backups'))).toEqual(backups)
})

it('upgrades the earlier workspace schema without skipping upstream agent columns or losing unread state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-preview-migration-'))
  dirs.push(dir)
  const file = join(dir, 'tucano.db')
  const first = new Db(file)
  first.createConversation({ id: 'kept', name: 'kept', kind: 'channel', members: [] })
  const message: Message = { id: 'kept-message', conversationId: 'kept', author: { kind: 'me' }, text: 'keep me', at: 1 }
  first.saveMessage(message)
  first.recordActivity(message, null)
  const unread = first.conversation('kept')?.unread
  first.close()
  const raw = new DatabaseSync(file)
  const version = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  for (const column of ['fallback_model', 'account', 'fallback_account', 'max_routines', 'custom_color', 'picture', 'avatar']) raw.exec(`ALTER TABLE agents DROP COLUMN ${column}`)
  raw.exec(`PRAGMA user_version = ${version - 6}`)
  raw.close()
  const migrated = open(file)
  expect(migrated.messages().map((m) => m.text)).toEqual(['keep me'])
  expect(migrated.conversation('kept')?.unread).toBe(unread)
  const check = new DatabaseSync(file)
  expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: version })
  const columns = (check.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((column) => column.name)
  expect(columns).toEqual(expect.arrayContaining(['fallback_model', 'account', 'fallback_account', 'max_routines', 'custom_color', 'picture', 'avatar']))
  check.close()
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
})

it('adds upstream avatars to the previous workspace schema without losing unread state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-avatar-migration-'))
  dirs.push(dir)
  const file = join(dir, 'tucano.db')
  const first = new Db(file)
  first.createConversation({ id: 'kept', name: 'kept', kind: 'channel', members: [] })
  const message: Message = { id: 'message', conversationId: 'kept', author: { kind: 'agent', id: 'agent' }, text: 'keep me', at: 1 }
  first.saveMessage(message)
  first.recordActivity(message, null)
  expect(first.conversation('kept')?.unread).toBe(1)
  first.close()
  const raw = new DatabaseSync(file)
  const version = (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  raw.exec(`ALTER TABLE agents DROP COLUMN avatar; PRAGMA user_version = ${version - 1}`)
  raw.close()
  const migrated = open(file)
  expect(migrated.messages().map((m) => m.text)).toEqual(['keep me'])
  expect(migrated.conversation('kept')?.unread).toBe(1)
  const check = new DatabaseSync(file)
  expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: version })
  expect((check.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).map((column) => column.name)).toContain('avatar')
  check.close()
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
  expect(open(file).conversation('kept')?.unread).toBe(1)
  expect(readdirSync(join(dir, 'backups'))).toHaveLength(1)
})

it('duplicates configuration and credentials without copying history or mutating the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-duplicate-'))
  dirs.push(dir)
  const sourceFile = join(dir, 'source.db')
  const source = open(sourceFile)
  source.setSettings({ ...defaults, workspaceName: 'Company', context: 'Workspace instructions', routerModel: 'sonnet', onboarding: { done: true, checklistHidden: true, workspaceManagerSeen: true } })
  source.saveAgent({ id: 'agent', name: 'Aurora', handle: 'aurora', role: 'Research', color: 'sky', instructions: 'Agent instructions', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: { connector: 'read_write' }, memory: 'auto', computer: false, archived: false })
  source.createConversation({ id: 'channel', kind: 'channel', name: 'company', members: ['agent'], topic: 'Channel configuration' })
  source.saveConnector({ id: 'connector', name: 'Company tool', kind: 'remote', url: 'https://example.com/mcp', auth: 'token' })
  source.setSecret('connector:token', 'encrypted-connector-credential')
  source.setSecret('telegram:token', 'default-only-token')
  source.setSecret('github:proxy-key', 'old-proxy-key')
  source.setSecret('connector:oauth_verifier', 'pending-oauth')
  const message: Message = { id: 'message', conversationId: 'channel', author: { kind: 'agent', id: 'agent' }, text: 'PRIVATE_MESSAGE_NOT_FOR_COPY', at: 1 }
  source.saveMessage(message)
  source.recordActivity(message, null)
  source.setSummary('channel', 'PRIVATE_SUMMARY_NOT_FOR_COPY', 1)
  source.saveMemory({ id: 'memory', scope: 'me', text: 'PRIVATE_MEMORY_NOT_FOR_COPY', state: 'active', origin: 'me', messageIds: ['message'], createdAt: 1, confirmedAt: 1 })
  source.addReceipt({ messageId: 'message', agentId: 'agent', engine: 'claude', model: 'sonnet', inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, ms: 1, at: 1 })
  source.saveService('agent', { name: 'web', command: 'npm start', port: 3000, startedAt: 1 })
  source.saveSkill({ id: 'skill', name: 'Review', description: 'Review code', body: 'Check tests', agents: ['agent'], state: 'active', createdAt: 1, updatedAt: 1 })
  source.saveRoutine({ id: 'routine', name: 'Daily', agentId: 'agent', conversationId: 'channel', prompt: 'Daily task', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, enabled: true, nextAt: 1, lastAt: 1, lastMessageId: 'message', createdAt: 1 })
  source.saveRoutine({ ...source.routine('routine')!, id: 'hook', trigger: { kind: 'webhook', token: 'old-webhook-token' } })
  const raw = new DatabaseSync(sourceFile)
  raw.exec(`INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, created_at, expires_at) VALUES ('approval', 'hash', 'agent', 'channel', 'message', 'connector', 'Tool', 'send', '{}', 1, 2)`)
  raw.close()
  const file = join(dir, 'copy.db')
  source.duplicateTo(file, 'Company (copy)')
  const copy = open(file)
  expect(copy.getSettings(defaults)).toMatchObject({ workspaceName: 'Company (copy)', context: 'Workspace instructions', routerModel: 'sonnet', onboarding: { done: true } })
  expect(copy.getSettings(defaults).onboarding?.workspaceManagerSeen).toBeUndefined()
  expect(copy.getSettings(defaults).onboarding?.checklistHidden).toBe(true)
  expect(copy.agents().map((a) => a.name)).toEqual(['Aurora'])
  expect(copy.agent('agent')?.grants).toEqual({ connector: 'read_write' })
  expect(copy.conversation('channel')).toMatchObject({ members: ['agent'], topic: 'Channel configuration', summary: undefined, unread: 0 })
  expect(copy.connectors().map((c) => c.name)).toEqual(['Company tool'])
  expect(copy.getSecret('connector:token')).toBe('encrypted-connector-credential')
  for (const key of ['telegram:token', 'github:proxy-key', 'connector:oauth_verifier']) expect(copy.getSecret(key)).toBeUndefined()
  expect(copy.skills().map((s) => s.name)).toEqual(['Review'])
  expect(copy.routine('routine')).toMatchObject({ enabled: true, lastAt: undefined, lastMessageId: undefined })
  expect(copy.routine('routine')!.nextAt).toBeGreaterThan(Date.now() - 1000)
  expect(copy.routine('hook')?.trigger).not.toEqual(source.routine('hook')?.trigger)
  expect(copy.messages()).toEqual([])
  expect(copy.memories()).toEqual([])
  expect(copy.approvals()).toEqual([])
  expect(copy.artifacts()).toEqual([])
  expect(copy.receiptsSince(0)).toEqual([])
  expect(copy.services('agent')).toEqual([])
  const bytes = readFileSync(file).toString('utf8')
  for (const marker of ['PRIVATE_MESSAGE_NOT_FOR_COPY', 'PRIVATE_MEMORY_NOT_FOR_COPY', 'PRIVATE_SUMMARY_NOT_FOR_COPY']) expect(bytes).not.toContain(marker)
  expect(existsSync(`${file}.preparing`)).toBe(false)
  expect(source.messages()).toHaveLength(1)
  expect(source.memories()).toHaveLength(1)
  expect(source.routine('routine')?.lastMessageId).toBe('message')
  expect(() => source.duplicateTo(file, 'overwrite')).toThrow('already exists')
  source.setSettings({ onboarding: { done: false } })
  const unfinished = join(dir, 'unfinished.db')
  source.duplicateTo(unfinished, 'Unfinished')
  expect(open(unfinished).getSettings(defaults).onboarding?.done).toBe(false)
})
