import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { Db, MIGRATIONS } from '../src/core/db'
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
  const memory = (db: Db): Memories => new Memories({ db, engines: { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }, settings: async () => { throw new Error('Prompt lookup must not invoke a model') }, emit: () => {}, workDir: '' })
  expect(memory(a).forPrompt(agent).aboutMe.map((m) => m.text)).toEqual(['Only in A'])
  expect(memory(b).forPrompt(agent).aboutMe).toEqual([])
  a.deleteConversation('same-channel')
  expect(a.conversations()).toEqual([])
})

it('migrates every opened workspace and backs up older schemas before changing them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-migrations-'))
  dirs.push(dir)
  const file = join(dir, 'tucano.db')
  // A database from before the unread table (two migrations back: people came after it).
  const version = MIGRATIONS.length - 1
  const raw = new DatabaseSync(file)
  for (const m of MIGRATIONS.slice(0, version - 1)) raw.exec(m)
  raw.exec(`INSERT INTO conversations (id, kind, name, created_at) VALUES ('kept', 'channel', 'kept', 1); PRAGMA user_version = ${version - 1}`)
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

it('duplicates configuration and credentials without copying history or mutating the source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-duplicate-'))
  dirs.push(dir)
  const sourceFile = join(dir, 'source.db')
  const source = open(sourceFile)
  source.setSettings({ ...defaults, workspaceName: 'Company', context: 'Workspace instructions', routerModel: 'sonnet', onboarding: { done: true, checklistHidden: true, workspaceManagerSeen: true } })
  source.saveAgent({ id: 'agent', name: 'Aurora', handle: 'aurora', role: 'Research', color: 'sky', instructions: 'Agent instructions', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: { connector: 'read_write' }, memory: 'auto', computer: false, archived: false, accountId: 'work', fallbackAccountId: 'work' })
  source.setSettings({ accounts: [{ id: 'work', engine: 'claude', name: 'Work' }] })
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
  expect(copy.getSettings(defaults)).toMatchObject({ workspaceName: 'Company', workspaceLabel: 'Company (copy)', context: 'Workspace instructions', routerModel: 'sonnet', onboarding: { done: true } })
  expect(copy.getSettings(defaults).onboarding?.workspaceManagerSeen).toBeUndefined()
  expect(copy.getSettings(defaults).onboarding?.checklistHidden).toBe(true)
  expect(copy.agents().map((a) => a.name)).toEqual(['Aurora'])
  expect(copy.agent('agent')?.grants).toEqual({ connector: 'read_write' })
  // The extra login's folder is the source's: the copy's agent uses the usual one.
  expect(copy.getSettings(defaults).accounts).toBeUndefined()
  expect(copy.agent('agent')?.accountId).toBeUndefined()
  expect(copy.agent('agent')?.fallbackAccountId).toBeUndefined()
  expect(source.agent('agent')?.accountId).toBe('work')
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

it('brings only what was picked to a new workspace, and what depends on it comes without what stayed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tucano-parts-'))
  dirs.push(dir)
  const source = open(join(dir, 'source.db'))
  source.setSettings({ ...defaults, workspaceName: 'Edu', context: 'SECRET CONTEXT', routerModel: 'sonnet', defaultLimit: 4242, wikiDir: '/vault', channelLayout: { order: [] } as unknown as Settings['channelLayout'], onboarding: { done: true } })
  source.saveAgent({ id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: 'Lia instructions', modelId: 'sonnet', effort: 'low', limit: 1000, used: 0, grants: { linear: 'read_write' }, autoApprove: ['linear:create'], memory: 'auto', computer: false, archived: false })
  source.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  source.createConversation({ id: 'eng', kind: 'channel', name: 'eng', members: ['lia'] })
  source.saveConnector({ id: 'linear', name: 'Linear', kind: 'remote', url: 'https://example.com/mcp', auth: 'token' })
  source.setSecret('connector:linear:token', 'encrypted')
  source.setSecret('github:token', 'encrypted-github')
  source.setSecret('typesafe:key', 'encrypted-jev')
  source.saveSkill({ id: 'all', name: 'For all', description: 'x', body: 'y', agents: [], state: 'active', createdAt: 1, updatedAt: 1 })
  source.saveSkill({ id: 'own', name: 'For Lia', description: 'x', body: 'y', agents: ['lia'], state: 'active', createdAt: 1, updatedAt: 1 })
  source.saveRoutine({ id: 'daily', name: 'Daily', agentId: 'lia', conversationId: 'eng', prompt: 'p', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 })
  source.saveRoutine({ id: 'poll', name: 'Poll', agentId: 'lia', conversationId: 'dm', prompt: 'p', schedule: { days: [], time: '09:00' }, enabled: true, createdAt: 1, trigger: { kind: 'poll', connectorId: 'linear', tool: 'list', args: {}, everyMinutes: 5 } })
  const none = { general: false, context: false, wiki: false, agents: false, channels: false, skills: false, connectors: false, routines: false }

  // The general settings only: an empty workspace whose introduction starts from them.
  source.duplicateTo(join(dir, 'general.db'), 'General', { ...none, general: true })
  const general = open(join(dir, 'general.db'))
  const g = general.getSettings(defaults)
  expect(g).toMatchObject({ workspaceName: 'Edu', workspaceLabel: 'General', routerModel: 'sonnet', defaultLimit: 4242, context: '', onboarding: { done: false, carried: true } })
  expect(g.wikiDir).toBeUndefined()
  expect(g.channelLayout).toBeUndefined()
  expect([general.agents(), general.conversations(), general.connectors(), general.skills(), general.routines()].map((x) => x.length)).toEqual([0, 0, 0, 0, 0])
  expect(general.getSecret('typesafe:key')).toBe('encrypted-jev')
  expect(general.getSecret('github:token')).toBeUndefined()

  // Agents and their routines, no connectors: no grants, and the routine that polls one stays behind.
  source.duplicateTo(join(dir, 'agents.db'), 'Agents', { ...none, agents: true, channels: true, skills: true, routines: true })
  const agents = open(join(dir, 'agents.db'))
  expect(agents.agent('lia')).toMatchObject({ instructions: 'Lia instructions', grants: {}, autoApprove: [] })
  expect(agents.conversations().map((c) => c.id).sort()).toEqual(['dm', 'eng'])
  expect(agents.routines().map((r) => r.id)).toEqual(['daily'])
  expect(agents.connectors()).toEqual([])
  for (const key of ['connector:linear:token', 'github:token', 'typesafe:key']) expect(agents.getSecret(key)).toBeUndefined()
  expect(agents.getSettings(defaults)).toMatchObject({ routerModel: 'haiku', context: '', onboarding: { done: true } }) // defaults: the general settings stayed

  // Skills and connectors without agents: a skill of agents left behind comes archived.
  source.duplicateTo(join(dir, 'skills.db'), 'Skills', { ...none, skills: true, connectors: true })
  const skills = open(join(dir, 'skills.db'))
  expect(skills.skills().map((k) => [k.id, k.state]).sort()).toEqual([['all', 'active'], ['own', 'archived']])
  expect(skills.connectors().map((c) => c.id)).toEqual(['linear'])
  expect(skills.getSecret('connector:linear:token')).toBe('encrypted')
  expect(skills.agents()).toEqual([])
  expect(skills.routines()).toEqual([])
  expect(skills.getSettings(defaults).onboarding).toEqual({ done: false })

  // The wiki: the same folder as the source's (its own one, inside its data, here).
  source.duplicateTo(join(dir, 'wiki.db'), 'Wiki', { ...none, wiki: true }, join(dir, 'source-wiki'))
  expect(open(join(dir, 'wiki.db')).getSettings(defaults).wikiDir).toBe(join(dir, 'source-wiki'))

  // Everything: the duplicate, as before (context and the wiki folder too).
  source.duplicateTo(join(dir, 'all.db'), 'All')
  const all = open(join(dir, 'all.db'))
  expect(all.getSettings(defaults)).toMatchObject({ context: 'SECRET CONTEXT', wikiDir: '/vault', onboarding: { done: true } })
  expect(all.routines().map((r) => r.id).sort()).toEqual(['daily', 'poll'])
  expect(source.agents()).toHaveLength(1) // the source is untouched
  expect(source.getSecret('github:token')).toBe('encrypted-github')
})
