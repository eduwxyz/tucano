import { DatabaseSync } from 'node:sqlite'
import { CACHE_READ_WEIGHT, type Agent, type AgentColor, type Approval, type ApprovalState, type Artifact, type ArtifactKind, type Author, type Connector, type ConnectorAuth, type ConnectorTool, type Conversation, type Effort, type LentFolder, type Memory, type MemoryMode, type MemoryState, type Message, type Receipt, type Routine, type RoutineRun, type Run, type Settings, type Skill, type SkillVersion, type ToolClass, type Trigger } from '../shared/types'

// Each entry runs once, in order; PRAGMA user_version records how far we got.
const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    handle TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    limit_tokens INTEGER NOT NULL,
    grants TEXT NOT NULL DEFAULT '{}',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
    name TEXT NOT NULL,
    topic TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE members (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id),
    PRIMARY KEY (conversation_id, agent_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL,
    author_id TEXT,
    text TEXT NOT NULL,
    at INTEGER NOT NULL,
    run TEXT
  );
  CREATE INDEX messages_by_conversation ON messages (conversation_id, at);
  CREATE TABLE receipts (
    id INTEGER PRIMARY KEY,
    message_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    ms INTEGER NOT NULL,
    api_cost_usd REAL,
    at INTEGER NOT NULL
  );
  CREATE INDEX receipts_by_agent ON receipts (agent_id, at);
  `,
  `
  CREATE TABLE connectors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('remote', 'stdio')),
    url TEXT,
    command TEXT,
    args TEXT NOT NULL DEFAULT '[]',
    env_keys TEXT NOT NULL DEFAULT '[]',
    auth TEXT NOT NULL DEFAULT 'none',
    synced INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE connector_tools (
    connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    input_schema TEXT NOT NULL DEFAULT '{}',
    cls TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    high_risk INTEGER NOT NULL DEFAULT 0,
    is_new INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (connector_id, name)
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    connector_name TEXT NOT NULL,
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    why TEXT NOT NULL DEFAULT '',
    high_risk INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'pending',
    reason TEXT,
    outcome TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    decided_at INTEGER
  );
  CREATE INDEX approvals_by_state ON approvals (state, created_at);
  -- Encrypted by the OS keychain (Electron safeStorage) before they get here.
  CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  `
  ALTER TABLE agents ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'auto';
  ALTER TABLE conversations ADD COLUMN summary TEXT;
  ALTER TABLE conversations ADD COLUMN summary_until INTEGER;
  ALTER TABLE conversations ADD COLUMN summary_at INTEGER;
  CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'pending', 'archived', 'forgotten')),
    origin TEXT NOT NULL,
    agent_id TEXT,
    conversation_id TEXT,
    message_ids TEXT NOT NULL DEFAULT '[]',
    replaces TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER NOT NULL
  );
  CREATE INDEX memories_by_scope ON memories (scope, state);
  `,
  `
  ALTER TABLE agents ADD COLUMN computer INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE services (
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    port INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, name)
  );
  `,
  `
  CREATE TABLE routines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    days TEXT NOT NULL,
    time TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    next_at INTEGER,
    last_at INTEGER,
    last_message_id TEXT,
    created_at INTEGER NOT NULL
  );
  ALTER TABLE messages ADD COLUMN routine TEXT;
  `,
  `
  ALTER TABLE routines ADD COLUMN once INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE routines ADD COLUMN created_by TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN folders TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE conversations ADD COLUMN project TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN web INTEGER NOT NULL DEFAULT 1;
  `,
  `
  ALTER TABLE routines ADD COLUMN trigger TEXT;
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    agents TEXT NOT NULL DEFAULT '[]',
    state TEXT NOT NULL CHECK (state IN ('active', 'pending', 'archived')),
    replaces TEXT,
    proposed_by TEXT,
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE skill_versions (
    id INTEGER PRIMARY KEY,
    skill_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX skill_versions_by_skill ON skill_versions (skill_id, at);
  `,
  `
  ALTER TABLE agents ADD COLUMN auto_approve TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE receipts ADD COLUMN work TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN computer_kind TEXT NOT NULL DEFAULT 'linux';
  `,
  `
  ALTER TABLE agents ADD COLUMN browser INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE skills ADD COLUMN source TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN kind TEXT;
  `,
  `
  ALTER TABLE connectors ADD COLUMN execution_target TEXT;
  `
]

type Row = Record<string, unknown>

// countedTokens, in SQL: cache reads count CACHE_READ_WEIGHT.
const COUNTED = `input_tokens - cache_read_tokens * ${1 - CACHE_READ_WEIGHT} + output_tokens`
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const monthStart = (now = new Date()): number => new Date(now.getFullYear(), now.getMonth(), 1).getTime()

export class Db {
  private db: DatabaseSync
  // The file was new: the first run, when the starter team goes in. Not merely
  // "no agents", since someone may have deleted them all.
  created = false

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  // A consistent copy of the whole database, while it's in use.
  backupTo(file: string): void {
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }

  private migrate(): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    this.created = user_version === 0
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
  }

  // Nested calls join the outer transaction.
  tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  // ---------- settings ----------

  getSettings(defaults: Omit<Settings, 'engines'>): Omit<Settings, 'engines'> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value) as unknown]))
    return { ...defaults, ...stored }
  }

  setSettings(patch: Partial<Omit<Settings, 'engines'>>): void {
    const stmt = this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    this.tx(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) stmt.run(k, JSON.stringify(v))
    })
  }

  // ---------- agents ----------

  private toAgent(r: Row): Agent {
    return {
      id: str(r['id']),
      name: str(r['name']),
      handle: str(r['handle']),
      role: str(r['role']),
      color: str(r['color']) as AgentColor,
      instructions: str(r['instructions']),
      modelId: str(r['model']),
      effort: str(r['effort']) as Effort,
      limit: Number(r['limit_tokens']),
      used: this.usedThisMonth(str(r['id'])),
      grants: JSON.parse(str(r['grants']) || '{}') as Agent['grants'],
      memory: (str(r['memory_mode']) || 'auto') as MemoryMode,
      computer: r['computer'] === 1,
      computerKind: str(r['computer_kind']) === 'mac' ? 'mac' : 'linux',
      web: r['web'] !== 0,
      browser: r['browser'] === 1,
      autoApprove: JSON.parse(str(r['auto_approve']) || '[]') as string[],
      folders: JSON.parse(str(r['folders']) || '[]') as LentFolder[],
      archived: r['archived'] === 1,
      ...(str(r['kind']) === 'tuca' ? { kind: 'tuca' as const } : {})
    }
  }

  agents(): Agent[] {
    return (this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as Row[]).map((r) => this.toAgent(r))
  }

  agent(id: string): Agent | undefined {
    const r = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined
    return r && this.toAgent(r)
  }

  saveAgent(a: Agent): void {
    this.db
      .prepare(
        `INSERT INTO agents (id, name, handle, role, color, instructions, model, effort, limit_tokens, grants, memory_mode, computer, computer_kind, web, browser, auto_approve, archived, kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, handle = excluded.handle, role = excluded.role,
           color = excluded.color, instructions = excluded.instructions, model = excluded.model, effort = excluded.effort,
           limit_tokens = excluded.limit_tokens, grants = excluded.grants, memory_mode = excluded.memory_mode,
           computer = excluded.computer, computer_kind = excluded.computer_kind, web = excluded.web, browser = excluded.browser, auto_approve = excluded.auto_approve, archived = excluded.archived, kind = COALESCE(excluded.kind, agents.kind)`
      )
      .run(a.id, a.name, a.handle, a.role, a.color, a.instructions, a.modelId, a.effort, a.limit, JSON.stringify(a.grants), a.memory ?? 'auto', a.computer ? 1 : 0, a.computerKind === 'mac' ? 'mac' : 'linux', a.web === false ? 0 : 1, a.browser ? 1 : 0, JSON.stringify(a.autoApprove ?? []), a.archived ? 1 : 0, a.kind ?? null, Date.now())
  }

  // Kept apart from saveAgent: folders change only after the core checks them.
  setFolders(agentId: string, folders: LentFolder[]): void {
    this.db.prepare('UPDATE agents SET folders = ? WHERE id = ?').run(JSON.stringify(folders), agentId)
  }

  usedThisMonth(agentId: string): number {
    const r = this.db
      .prepare(`SELECT COALESCE(ROUND(SUM(${COUNTED})), 0) AS used FROM receipts WHERE agent_id = ? AND at >= ?`)
      .get(agentId, monthStart()) as { used: number }
    return r.used
  }

  // ---------- conversations ----------

  conversations(): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM conversations ORDER BY created_at').all() as Row[]
    const members = this.db.prepare('SELECT conversation_id, agent_id FROM members').all() as { conversation_id: string; agent_id: string }[]
    return rows.map((r) => ({
      id: str(r['id']),
      kind: str(r['kind']) as Conversation['kind'],
      name: str(r['name']),
      topic: r['topic'] ? str(r['topic']) : undefined,
      members: members.filter((m) => m.conversation_id === r['id']).map((m) => m.agent_id),
      summary: r['summary'] ? str(r['summary']) : undefined,
      summaryUntil: r['summary_until'] ? Number(r['summary_until']) : undefined,
      summaryAt: r['summary_at'] ? Number(r['summary_at']) : undefined
    }))
  }

  // `until` is the `at` of the last message the summary covers; leave it out to keep it (a hand edit).
  setSummary(conversationId: string, summary: string, until?: number): void {
    if (until === undefined) this.db.prepare('UPDATE conversations SET summary = ?, summary_at = ? WHERE id = ?').run(summary, Date.now(), conversationId)
    else this.db.prepare('UPDATE conversations SET summary = ?, summary_until = ?, summary_at = ? WHERE id = ?').run(summary, until, Date.now(), conversationId)
  }

  conversation(id: string): Conversation | undefined {
    return this.conversations().find((c) => c.id === id)
  }

  createConversation(c: Omit<Conversation, 'unread'>): void {
    this.tx(() => {
      this.db.prepare('INSERT INTO conversations (id, kind, name, topic, created_at) VALUES (?, ?, ?, ?, ?)').run(c.id, c.kind, c.name, c.topic ?? null, Date.now())
      for (const m of c.members) this.db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(c.id, m)
    })
  }

  renameConversation(id: string, name: string): void {
    this.db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, id)
  }

  setTopic(id: string, topic: string | undefined): void {
    this.db.prepare('UPDATE conversations SET topic = ? WHERE id = ?').run(topic ?? null, id)
  }

  // Exactly these agents in the conversation.
  setMembers(id: string, agentIds: string[]): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM members WHERE conversation_id = ?').run(id)
      for (const a of new Set(agentIds)) this.db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(id, a)
    })
  }

  // Its messages and members go with it (foreign keys).
  deleteConversation(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }

  // Puts the agent in exactly these channels (DMs are untouched).
  setAgentChannels(agentId: string, channelIds: string[]): string[] {
    const changed: string[] = []
    this.tx(() => {
      for (const c of this.conversations()) {
        if (c.kind !== 'channel') continue
        const has = c.members.includes(agentId)
        const want = channelIds.includes(c.id)
        if (has === want) continue
        if (want) this.db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(c.id, agentId)
        else this.db.prepare('DELETE FROM members WHERE conversation_id = ? AND agent_id = ?').run(c.id, agentId)
        changed.push(c.id)
      }
    })
    return changed
  }

  // ---------- messages ----------

  private toMessage(r: Row): Message {
    const kind = str(r['author_kind'])
    const author: Author =
      kind === 'agent' || kind === 'routine' ? { kind, id: str(r['author_id']) } : kind === 'system' ? { kind: 'system' } : { kind: 'me' }
    return {
      id: str(r['id']),
      conversationId: str(r['conversation_id']),
      author,
      text: str(r['text']),
      at: Number(r['at']),
      run: r['run'] ? (JSON.parse(str(r['run'])) as Run) : undefined,
      routine: r['routine'] ? (JSON.parse(str(r['routine'])) as RoutineRun) : undefined
    }
  }

  messages(): Message[] {
    return (this.db.prepare('SELECT * FROM messages ORDER BY at').all() as Row[]).map((r) => this.toMessage(r))
  }

  recentMessages(conversationId: string, limit: number): Message[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY at DESC LIMIT ?').all(conversationId, limit) as Row[]
    return rows.reverse().map((r) => this.toMessage(r))
  }

  // Oldest first.
  messagesAfter(conversationId: string, at: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND at > ? ORDER BY at').all(conversationId, at) as Row[]).map((r) => this.toMessage(r))
  }

  // Where the agent wrote last: while it works, the conversation of its reply.
  lastConversationOf(agentId: string): string | undefined {
    const r = this.db.prepare("SELECT conversation_id FROM messages WHERE author_kind = 'agent' AND author_id = ? ORDER BY at DESC LIMIT 1").get(agentId) as Row | undefined
    return r && str(r['conversation_id'])
  }

  message(id: string): Message | undefined {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined
    return r && this.toMessage(r)
  }

  saveMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, routine) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET text = excluded.text, run = excluded.run`
      )
      .run(
        m.id,
        m.conversationId,
        m.author.kind,
        'id' in m.author ? m.author.id : null,
        m.text,
        m.at,
        m.run ? JSON.stringify(m.run) : null,
        m.routine ? JSON.stringify(m.routine) : null
      )
  }

  // Runs that were working when the app closed can't continue: their CLI process is gone.
  interruptStaleRuns(): number {
    let n = 0
    for (const m of this.messages()) {
      if (m.run?.status !== 'working') continue
      n++
      this.saveMessage({
        ...m,
        run: { ...m.run, status: 'interrupted', steps: m.run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'error' } : s)) }
      })
    }
    return n
  }

  // ---------- receipts ----------

  addReceipt(r: Receipt & { messageId: string; agentId: string; engine: string; at: number; work?: string }): void {
    this.db
      .prepare(
        `INSERT INTO receipts (message_id, agent_id, engine, model, input_tokens, cache_read_tokens, output_tokens, ms, api_cost_usd, at, work)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(r.messageId, r.agentId, r.engine, r.model, r.inputTokens, r.cacheReadTokens, r.outputTokens, r.ms, r.apiCostUsd ?? null, r.at, r.work ?? null)
  }

  // Every receipt since `since`, oldest first: agent replies, and the router's and memory's turns.
  receiptsSince(since: number): (Receipt & { agentId: string; engine: string; messageId: string; at: number })[] {
    return (this.db.prepare('SELECT * FROM receipts WHERE at >= ? ORDER BY at').all(since) as Row[]).map((r) => ({
      agentId: str(r['agent_id']),
      engine: str(r['engine']),
      messageId: str(r['message_id']),
      model: str(r['model']),
      inputTokens: Number(r['input_tokens']),
      cacheReadTokens: Number(r['cache_read_tokens']),
      outputTokens: Number(r['output_tokens']),
      ms: Number(r['ms']),
      apiCostUsd: r['api_cost_usd'] == null ? undefined : Number(r['api_cost_usd']),
      at: Number(r['at'])
    }))
  }

  // Counted tokens per piece of work (an issue like OAB-65) from `since` (to `until`), biggest first.
  costByWork(since: number, until = Number.MAX_SAFE_INTEGER): { work: string; tokens: number; replies: number; agents: string[]; last: number }[] {
    return (
      this.db
        .prepare(
          `SELECT work, ROUND(SUM(${COUNTED})) AS tokens, COUNT(DISTINCT message_id) AS replies, GROUP_CONCAT(DISTINCT agent_id) AS agents, MAX(at) AS last
           FROM receipts WHERE work IS NOT NULL AND at >= ? AND at < ? GROUP BY work ORDER BY tokens DESC`
        )
        .all(since, until) as Row[]
    ).map((r) => ({ work: str(r['work']), tokens: Number(r['tokens']), replies: Number(r['replies']), agents: str(r['agents']).split(','), last: Number(r['last']) }))
  }

  // ---------- connectors ----------

  // Status is runtime state; the manager fills it in.
  connectors(): Omit<Connector, 'status' | 'error'>[] {
    const rows = this.db.prepare('SELECT * FROM connectors ORDER BY created_at').all() as Row[]
    return rows.map((r) => this.toConnector(r))
  }

  connector(id: string): (Omit<Connector, 'status' | 'error'> & { synced: boolean }) | undefined {
    const r = this.db.prepare('SELECT * FROM connectors WHERE id = ?').get(id) as Row | undefined
    return r && { ...this.toConnector(r), synced: r['synced'] === 1 }
  }

  private toConnector(r: Row): Omit<Connector, 'status' | 'error'> {
    const id = str(r['id'])
    return {
      id,
      name: str(r['name']),
      kind: str(r['kind']) as Connector['kind'],
      url: r['url'] ? str(r['url']) : undefined,
      command: r['command'] ? str(r['command']) : undefined,
      args: JSON.parse(str(r['args']) || '[]') as string[],
      executionTarget: r['execution_target'] ? JSON.parse(str(r['execution_target'])) : undefined,
      envKeys: JSON.parse(str(r['env_keys']) || '[]') as string[],
      auth: str(r['auth']) as ConnectorAuth,
      tools: this.tools(id).map(({ inputSchema: _, ...t }) => t)
    }
  }

  saveConnector(c: { id: string; name: string; kind: Connector['kind']; url?: string; command?: string; args?: string[]; envKeys?: string[]; auth: ConnectorAuth; executionTarget?: Connector['executionTarget'] }): void {
    this.db
      .prepare(
        `INSERT INTO connectors (id, name, kind, url, command, args, env_keys, auth, execution_target, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, command = excluded.command,
           args = excluded.args, env_keys = excluded.env_keys, auth = excluded.auth, execution_target = excluded.execution_target`
      )
      .run(c.id, c.name, c.kind, c.url ?? null, c.command ?? null, JSON.stringify(c.args ?? []), JSON.stringify(c.envKeys ?? []), c.auth, c.executionTarget ? JSON.stringify(c.executionTarget) : null, Date.now())
  }

  removeConnector(id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM connectors WHERE id = ?').run(id)
      this.db.prepare("DELETE FROM secrets WHERE key LIKE ?").run(`connector:${id}:%`)
    })
  }

  tools(connectorId: string): (ConnectorTool & { inputSchema: Record<string, unknown> })[] {
    const rows = this.db.prepare('SELECT * FROM connector_tools WHERE connector_id = ? ORDER BY rowid').all(connectorId) as Row[]
    return rows.map((r) => ({
      name: str(r['name']),
      description: str(r['description']),
      inputSchema: JSON.parse(str(r['input_schema']) || '{}') as Record<string, unknown>,
      cls: str(r['cls']) as ToolClass,
      enabled: r['enabled'] === 1,
      highRisk: r['high_risk'] === 1,
      isNew: r['is_new'] === 1
    }))
  }

  // Applies the server's current tool list. On the first sync every tool comes
  // in enabled; afterwards, tools the server adds come in disabled and flagged.
  syncTools(connectorId: string, listed: { name: string; description: string; inputSchema: Record<string, unknown>; cls: ToolClass }[]): void {
    this.tx(() => {
      const first = !(this.db.prepare('SELECT synced FROM connectors WHERE id = ?').get(connectorId) as { synced: number } | undefined)?.synced
      const known = new Set(this.tools(connectorId).map((t) => t.name))
      for (const t of listed) {
        if (known.has(t.name)) {
          this.db.prepare('UPDATE connector_tools SET description = ?, input_schema = ? WHERE connector_id = ? AND name = ?').run(t.description, JSON.stringify(t.inputSchema), connectorId, t.name)
        } else {
          this.db
            .prepare('INSERT INTO connector_tools (connector_id, name, description, input_schema, cls, enabled, high_risk, is_new) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
            .run(connectorId, t.name, t.description, JSON.stringify(t.inputSchema), t.cls, first ? 1 : 0, first ? 0 : 1)
        }
      }
      const names = new Set(listed.map((t) => t.name))
      for (const name of known) if (!names.has(name)) this.db.prepare('DELETE FROM connector_tools WHERE connector_id = ? AND name = ?').run(connectorId, name)
      this.db.prepare('UPDATE connectors SET synced = 1 WHERE id = ?').run(connectorId)
    })
  }

  // Any review clears the "new" flag.
  updateTool(connectorId: string, name: string, patch: Partial<Pick<ConnectorTool, 'cls' | 'enabled' | 'highRisk'>>): void {
    const t = this.tools(connectorId).find((x) => x.name === name)
    if (!t) return
    const next = { ...t, ...patch }
    this.db
      .prepare('UPDATE connector_tools SET cls = ?, enabled = ?, high_risk = ?, is_new = 0 WHERE connector_id = ? AND name = ?')
      .run(next.cls, next.enabled ? 1 : 0, next.highRisk ? 1 : 0, connectorId, name)
  }

  // ---------- secrets (already encrypted by the caller) ----------

  getSecret(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | undefined)?.value
  }

  setSecret(key: string, value: string | undefined): void {
    if (value === undefined) this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key)
    else this.db.prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ---------- approvals ----------

  private toApproval(r: Row): Approval {
    return {
      id: str(r['id']),
      hash: str(r['hash']),
      agentId: str(r['agent_id']),
      conversationId: str(r['conversation_id']),
      messageId: str(r['message_id']),
      connectorId: str(r['connector_id']),
      connectorName: str(r['connector_name']),
      tool: str(r['tool']),
      args: JSON.parse(str(r['args'])) as Record<string, unknown>,
      why: str(r['why']),
      highRisk: r['high_risk'] === 1,
      state: str(r['state']) as ApprovalState,
      reason: r['reason'] ? str(r['reason']) : undefined,
      outcome: r['outcome'] ? str(r['outcome']) : undefined,
      createdAt: Number(r['created_at']),
      expiresAt: Number(r['expires_at']),
      decidedAt: r['decided_at'] ? Number(r['decided_at']) : undefined
    }
  }

  approvals(): Approval[] {
    return (this.db.prepare('SELECT * FROM approvals ORDER BY created_at').all() as Row[]).map((r) => this.toApproval(r))
  }

  approval(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined
    return r && this.toApproval(r)
  }

  createApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, why, high_risk, state, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.id, a.hash, a.agentId, a.conversationId, a.messageId, a.connectorId, a.connectorName, a.tool, JSON.stringify(a.args), a.why, a.highRisk ? 1 : 0, a.state, a.createdAt, a.expiresAt)
  }

  // Only a pending approval can be decided, so the first decision wins.
  decideApproval(id: string, state: Exclude<ApprovalState, 'pending'>, reason?: string): boolean {
    const r = this.db
      .prepare("UPDATE approvals SET state = ?, reason = ?, decided_at = ? WHERE id = ? AND state = 'pending'")
      .run(state, reason ?? null, Date.now(), id)
    return Number(r.changes) === 1
  }

  setApprovalOutcome(id: string, outcome: string): void {
    this.db.prepare('UPDATE approvals SET outcome = ? WHERE id = ?').run(outcome, id)
  }

  expiredApprovals(now = Date.now()): Approval[] {
    return (this.db.prepare("SELECT * FROM approvals WHERE state = 'pending' AND expires_at <= ?").all(now) as Row[]).map((r) => this.toApproval(r))
  }

  receiptTotals(messageId: string): { tokens: number } {
    return this.db
      .prepare(`SELECT COALESCE(ROUND(SUM(${COUNTED})), 0) AS tokens FROM receipts WHERE message_id = ?`)
      .get(messageId) as { tokens: number }
  }

  // ---------- memories ----------

  private toMemory(r: Row): Memory {
    return {
      id: str(r['id']),
      scope: str(r['scope']),
      text: str(r['text']),
      state: str(r['state']) as MemoryState,
      origin: str(r['origin']) as Memory['origin'],
      agentId: r['agent_id'] ? str(r['agent_id']) : undefined,
      conversationId: r['conversation_id'] ? str(r['conversation_id']) : undefined,
      messageIds: JSON.parse(str(r['message_ids']) || '[]') as string[],
      replaces: r['replaces'] ? str(r['replaces']) : undefined,
      reason: r['reason'] ? str(r['reason']) : undefined,
      createdAt: Number(r['created_at']),
      confirmedAt: Number(r['confirmed_at'])
    }
  }

  memories(filter: { scope?: string; state?: MemoryState } = {}): Memory[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.scope) where.push('scope = ?'), args.push(filter.scope)
    if (filter.state) where.push('state = ?'), args.push(filter.state)
    const sql = `SELECT * FROM memories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at`
    return (this.db.prepare(sql).all(...args) as Row[]).map((r) => this.toMemory(r))
  }

  memory(id: string): Memory | undefined {
    const r = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Row | undefined
    return r && this.toMemory(r)
  }

  saveMemory(m: Memory): void {
    this.db
      .prepare(
        `INSERT INTO memories (id, scope, text, state, origin, agent_id, conversation_id, message_ids, replaces, reason, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET text = excluded.text, state = excluded.state, reason = excluded.reason, confirmed_at = excluded.confirmed_at`
      )
      .run(m.id, m.scope, m.text, m.state, m.origin, m.agentId ?? null, m.conversationId ?? null, JSON.stringify(m.messageIds), m.replaces ?? null, m.reason ?? null, m.createdAt, m.confirmedAt)
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  // ---------- artifacts ----------

  artifacts(): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts ORDER BY created_at').all() as Row[]).map((r) => ({
      id: str(r['id']),
      agentId: str(r['agent_id']),
      conversationId: str(r['conversation_id']),
      messageId: str(r['message_id']),
      kind: str(r['kind']) as ArtifactKind,
      name: str(r['name']),
      title: str(r['title']),
      source: str(r['source']),
      size: Number(r['size']),
      createdAt: Number(r['created_at'])
    }))
  }

  saveArtifact(a: Artifact): void {
    this.db
      .prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.agentId, a.conversationId, a.messageId, a.kind, a.name, a.title, a.source, a.size, a.createdAt)
  }

  // ---------- services (what runs on an agent's computer) ----------

  services(agentId: string): { name: string; command: string; port: number; startedAt: number }[] {
    return (this.db.prepare('SELECT * FROM services WHERE agent_id = ? ORDER BY started_at').all(agentId) as Row[]).map((r) => ({
      name: str(r['name']),
      command: str(r['command']),
      port: Number(r['port']),
      startedAt: Number(r['started_at'])
    }))
  }

  saveService(agentId: string, s: { name: string; command: string; port: number; startedAt: number }): void {
    this.db
      .prepare(
        'INSERT INTO services (agent_id, name, command, port, started_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (agent_id, name) DO UPDATE SET command = excluded.command, port = excluded.port, started_at = excluded.started_at'
      )
      .run(agentId, s.name, s.command, s.port, s.startedAt)
  }

  removeServices(agentId: string, name?: string): void {
    if (name) this.db.prepare('DELETE FROM services WHERE agent_id = ? AND name = ?').run(agentId, name)
    else this.db.prepare('DELETE FROM services WHERE agent_id = ?').run(agentId)
  }

  // ---------- routines ----------

  routines(): Routine[] {
    return (this.db.prepare('SELECT * FROM routines ORDER BY created_at').all() as Row[]).map((r) => ({
      id: str(r['id']),
      name: str(r['name']),
      agentId: str(r['agent_id']),
      conversationId: str(r['conversation_id']),
      prompt: str(r['prompt']),
      schedule: { days: JSON.parse(str(r['days']) || '[]') as number[], time: str(r['time']), ...(r['once'] === 1 ? { once: true } : {}) },
      enabled: r['enabled'] === 1,
      nextAt: r['next_at'] == null ? undefined : Number(r['next_at']),
      lastAt: r['last_at'] == null ? undefined : Number(r['last_at']),
      lastMessageId: r['last_message_id'] ? str(r['last_message_id']) : undefined,
      createdBy: r['created_by'] ? str(r['created_by']) : undefined,
      trigger: r['trigger'] ? (JSON.parse(str(r['trigger'])) as Trigger) : undefined,
      createdAt: Number(r['created_at'])
    }))
  }

  routine(id: string): Routine | undefined {
    return this.routines().find((r) => r.id === id)
  }

  saveRoutine(r: Routine): void {
    this.db
      .prepare(
        `INSERT INTO routines (id, name, agent_id, conversation_id, prompt, days, time, once, enabled, next_at, last_at, last_message_id, created_by, created_at, trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, agent_id = excluded.agent_id, conversation_id = excluded.conversation_id, prompt = excluded.prompt,
           days = excluded.days, time = excluded.time, once = excluded.once, enabled = excluded.enabled, next_at = excluded.next_at, last_at = excluded.last_at,
           last_message_id = excluded.last_message_id, trigger = excluded.trigger`
      )
      .run(
        r.id,
        r.name,
        r.agentId,
        r.conversationId,
        r.prompt,
        JSON.stringify(r.schedule.days),
        r.schedule.time,
        r.schedule.once ? 1 : 0,
        r.enabled ? 1 : 0,
        r.nextAt ?? null,
        r.lastAt ?? null,
        r.lastMessageId ?? null,
        r.createdBy ?? null,
        r.createdAt,
        r.trigger ? JSON.stringify(r.trigger) : null
      )
  }

  removeRoutine(id: string): void {
    this.db.prepare('DELETE FROM routines WHERE id = ?').run(id)
  }

  // ---------- skills ----------

  skills(): Skill[] {
    return (this.db.prepare('SELECT * FROM skills ORDER BY name').all() as Row[]).map((r) => ({
      id: str(r['id']),
      name: str(r['name']),
      description: str(r['description']),
      body: str(r['body']),
      agents: JSON.parse(str(r['agents']) || '[]') as string[],
      state: str(r['state']) as Skill['state'],
      replaces: r['replaces'] ? str(r['replaces']) : undefined,
      proposedBy: r['proposed_by'] ? str(r['proposed_by']) : undefined,
      reason: r['reason'] ? str(r['reason']) : undefined,
      source: r['source'] ? str(r['source']) : undefined,
      createdAt: Number(r['created_at']),
      updatedAt: Number(r['updated_at'])
    }))
  }

  skill(id: string): Skill | undefined {
    return this.skills().find((s) => s.id === id)
  }

  saveSkill(k: Skill): void {
    this.db
      .prepare(
        `INSERT INTO skills (id, name, description, body, agents, state, replaces, proposed_by, reason, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, description = excluded.description, body = excluded.body, agents = excluded.agents,
           state = excluded.state, replaces = excluded.replaces, proposed_by = excluded.proposed_by, reason = excluded.reason, source = excluded.source, updated_at = excluded.updated_at`
      )
      .run(k.id, k.name, k.description, k.body, JSON.stringify(k.agents), k.state, k.replaces ?? null, k.proposedBy ?? null, k.reason ?? null, k.source ?? null, k.createdAt, k.updatedAt)
  }

  removeSkill(id: string): void {
    this.db.prepare('DELETE FROM skills WHERE id = ?').run(id)
  }

  // What a skill was before each change, newest first.
  skillVersions(skillId: string): SkillVersion[] {
    return (this.db.prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY at DESC, id DESC').all(skillId) as Row[]).map((r) => ({
      id: Number(r['id']),
      skillId: str(r['skill_id']),
      name: str(r['name']),
      description: str(r['description']),
      body: str(r['body']),
      by: str(r['by']),
      at: Number(r['at'])
    }))
  }

  addSkillVersion(v: Omit<SkillVersion, 'id'>): void {
    this.db.prepare('INSERT INTO skill_versions (skill_id, name, description, body, by, at) VALUES (?, ?, ?, ?, ?, ?)').run(v.skillId, v.name, v.description, v.body, v.by, v.at)
  }
}
