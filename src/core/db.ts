import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { cleanRules, isAutonomy } from '../shared/actions'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { ALL_PARTS, GENERAL_SETTINGS, WORKSPACE_PARTS, type WorkspaceParts } from '../shared/workspaces'
import { dirname, join } from 'node:path'
import {
  CACHE_READ_WEIGHT,
  nextRun,
  routineCap,
  type Agent,
  type AgentApp,
  type AgentColor,
  type Approval,
  type ApprovalState,
  type Artifact,
  type ArtifactKind,
  type Author,
  type Connector,
  type ConnectorAuth,
  type ConnectorTool,
  type Conversation,
  type Effort,
  type Invite,
  type LentFolder,
  type Memory,
  type MemoryMode,
  type MemoryState,
  type Message,
  type Person,
  type Question,
  type ActivityEntry,
  type Receipt,
  type Role,
  type Routine,
  type RoutineRun,
  type Run,
  type Settings,
  type Skill,
  type SkillVersion,
  type ThreadSummary,
  type ToolClass,
  type Trigger
} from '../shared/types'

const JEV_KEY = 'typesafe:key' // jev.ts's JEV_SECRET: the router's key goes with the general settings

// Each entry runs once, in order; PRAGMA user_version records how far we got.
export const MIGRATIONS = [
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
  ALTER TABLE agents ADD COLUMN apps TEXT NOT NULL DEFAULT '[]';
  `,
  `
  ALTER TABLE agents ADD COLUMN fallback_model TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN account TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN fallback_account TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN max_routines INTEGER NOT NULL DEFAULT 10;
  `,
  `
  ALTER TABLE agents ADD COLUMN custom_color TEXT;
  ALTER TABLE agents ADD COLUMN picture TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN avatar TEXT;
  `,
  `
  ALTER TABLE agents ADD COLUMN wiki TEXT;
  `,
  `
  ALTER TABLE conversations ADD COLUMN wiki_capture INTEGER;
  `,
  `
  ALTER TABLE messages ADD COLUMN thread_id TEXT;
  CREATE INDEX messages_by_thread ON messages (conversation_id, thread_id, at);
  `,
  `
  ALTER TABLE messages ADD COLUMN thread_summary TEXT;
  `,
  `
  ALTER TABLE conversations ADD COLUMN threads INTEGER;
  `,
  `
  CREATE TABLE IF NOT EXISTS message_notifications (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    unread INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (message_id, phase)
  );
  INSERT OR IGNORE INTO message_notifications (message_id, phase)
    SELECT id, COALESCE(json_extract(run, '$.status'), 'message') FROM messages;
  CREATE INDEX IF NOT EXISTS message_notifications_unread ON message_notifications (message_id) WHERE unread = 1;
  `,
  // People (Tucano Team): what was "me" becomes the owner, a person like any other. The owner's
  // name comes from the settings (empty on a new install: the core fills it in), and named = 0 so a
  // server asks it once. Unread moves to read_state, per person: `seen` is the last notification
  // row (message_notifications' rowid) they had seen; the owner keeps what was unread until now.
  `
  CREATE TABLE people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    about TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    removed_at INTEGER,
    delegate_to TEXT,
    delegate_until INTEGER,
    named INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX people_one_owner ON people (role) WHERE role = 'owner';
  INSERT INTO people (id, name, role, created_at, named)
    VALUES (lower(hex(randomblob(16))), COALESCE((SELECT json_extract(value, '$') FROM settings WHERE key = 'workspaceName'), ''), 'owner', 0, 0);
  CREATE TABLE person_keys (
    hash TEXT PRIMARY KEY,
    person_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  CREATE INDEX person_keys_by_person ON person_keys (person_id);
  CREATE TABLE invites (
    hash TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    about TEXT NOT NULL DEFAULT '',
    restore TEXT,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  );
  UPDATE messages SET author_kind = 'person', author_id = (SELECT id FROM people WHERE role = 'owner') WHERE author_kind = 'me';
  ALTER TABLE conversations ADD COLUMN owner TEXT;
  UPDATE conversations SET owner = (SELECT id FROM people WHERE role = 'owner') WHERE kind = 'dm';
  ALTER TABLE agents ADD COLUMN owner TEXT;
  UPDATE agents SET owner = (SELECT id FROM people WHERE role = 'owner');
  ALTER TABLE approvals ADD COLUMN requested_by TEXT;
  ALTER TABLE approvals ADD COLUMN decided_by TEXT;
  UPDATE approvals SET requested_by = (SELECT id FROM people WHERE role = 'owner');
  UPDATE approvals SET decided_by = (SELECT id FROM people WHERE role = 'owner') WHERE state IN ('approved', 'refused');
  UPDATE memories SET scope = 'person:' || (SELECT id FROM people WHERE role = 'owner') WHERE scope = 'me';
  CREATE TABLE read_state (
    person_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    read_at INTEGER NOT NULL,
    seen INTEGER NOT NULL,
    PRIMARY KEY (person_id, conversation_id)
  );
  INSERT INTO read_state (person_id, conversation_id, read_at, seen)
    SELECT (SELECT id FROM people WHERE role = 'owner'), c.id, 0,
      COALESCE(
        (SELECT MIN(n.rowid) - 1 FROM message_notifications n JOIN messages m ON m.id = n.message_id WHERE m.conversation_id = c.id AND n.unread = 1),
        (SELECT MAX(rowid) FROM message_notifications), 0)
    FROM conversations c;
  `,
  // Team roles (Tucano Team, steps 3–5): a question an agent asked someone, the team's activity
  // log, routines that are a person's or the team's (existing ones are the owner's own), what a
  // service's or an approval's run was for, and when a removed person's DMs were purged.
  `
  ALTER TABLE approvals ADD COLUMN behalf TEXT;
  ALTER TABLE services ADD COLUMN conversation_id TEXT;
  ALTER TABLE routines ADD COLUMN scope TEXT NOT NULL DEFAULT 'me' CHECK (scope IN ('me', 'channel'));
  ALTER TABLE routines ADD COLUMN owner TEXT;
  UPDATE routines SET owner = (SELECT id FROM people WHERE role = 'owner');
  CREATE TABLE routine_watchers (
    routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    person_id TEXT NOT NULL,
    PRIMARY KEY (routine_id, person_id)
  );
  ALTER TABLE people ADD COLUMN purged_at INTEGER;
  CREATE TABLE questions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    thread_id TEXT,
    agent_id TEXT NOT NULL,
    text TEXT NOT NULL,
    asked_to TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    confirm_state TEXT CHECK (confirm_state IN ('pending', 'yes', 'no')),
    state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'answered', 'closed')),
    deadline_at INTEGER NOT NULL,
    told_at INTEGER,
    answered_by TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX questions_open ON questions (state) WHERE state = 'open';
  CREATE TABLE activity (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    person_id TEXT,
    kind TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE INDEX activity_by_time ON activity (at);
  `,
  // How the app looks to each person (theme, sounds, sidebar, language…): their own, so one person
  // changing it on a server doesn't change it for everyone. The owner's stay in the settings.
  `
  ALTER TABLE people ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
  `,
  // Who made each channel (they and the admins rename it and pick its agents; the ones from before
  // are the owner's). An agent's note from a DM is that DM's person's alone. Unread goes back to
  // the rule it always had (a reply counts once, its completion again only if read meanwhile),
  // now kept per person: a row for each notification still unread for them. What was unread stays:
  // the owner's exactly as the old flags said (what main showed); others', from when they last read.
  `
  ALTER TABLE conversations ADD COLUMN created_by TEXT;
  UPDATE conversations SET created_by = (SELECT id FROM people WHERE role = 'owner') WHERE kind = 'channel';
  ALTER TABLE memories ADD COLUMN private_to TEXT;
  UPDATE memories SET private_to = (SELECT COALESCE(c.owner, (SELECT id FROM people WHERE role = 'owner')) FROM conversations c WHERE c.id = memories.conversation_id)
    WHERE scope NOT LIKE 'person:%' AND conversation_id IN (SELECT id FROM conversations WHERE kind = 'dm');
  CREATE TABLE unread (
    person_id TEXT NOT NULL,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    PRIMARY KEY (person_id, message_id, phase)
  );
  CREATE INDEX unread_by_message ON unread (message_id);
  INSERT OR IGNORE INTO unread (person_id, message_id, phase)
    SELECT (SELECT id FROM people WHERE role = 'owner'), n.message_id, n.phase
    FROM message_notifications n
    WHERE n.unread = 1;
  INSERT OR IGNORE INTO unread (person_id, message_id, phase)
    SELECT p.id, n.message_id, MIN(n.phase)
    FROM people p
    JOIN conversations c ON c.kind <> 'dm' OR COALESCE(c.owner, (SELECT id FROM people WHERE role = 'owner')) = p.id
    JOIN messages m ON m.conversation_id = c.id
    JOIN message_notifications n ON n.message_id = m.id
    LEFT JOIN read_state r ON r.person_id = p.id AND r.conversation_id = c.id
    WHERE p.removed_at IS NULL AND p.role <> 'owner' AND n.rowid > COALESCE(r.seen, 0)
    GROUP BY p.id, n.message_id;
  DELETE FROM read_state WHERE conversation_id IN (SELECT id FROM conversations c WHERE c.kind = 'dm' AND COALESCE(c.owner, (SELECT id FROM people WHERE role = 'owner')) <> read_state.person_id);
  `,
  // What a person said in a DM stays there: a memory about them learned in one (or from nowhere
  // known any more) comes only into their own DMs once the Tucano has more than one person.
  // What they wrote on the Memória page, or said in a channel, goes where they are.
  `
  UPDATE memories SET private_to = substr(scope, 8)
    WHERE scope LIKE 'person:%' AND private_to IS NULL AND origin <> 'me'
      AND (conversation_id IS NULL OR conversation_id NOT IN (SELECT id FROM conversations WHERE kind <> 'dm'));
  `,
  // A removed person's routines in their DM stay theirs, off while they're away (held: whether it
  // was on), and come back with them. The ones handed to the owner before go back to their person
  // (whether they were on is lost: they come back off).
  `
  ALTER TABLE routines ADD COLUMN held INTEGER;
  CREATE TABLE removed_keys (hash TEXT PRIMARY KEY, person_id TEXT NOT NULL, removed_at INTEGER NOT NULL);
  ALTER TABLE questions ADD COLUMN answered_at INTEGER;
  UPDATE routines SET owner = (SELECT c.owner FROM conversations c WHERE c.id = routines.conversation_id), held = 0
    WHERE conversation_id IN (SELECT c.id FROM conversations c JOIN people p ON p.id = c.owner WHERE c.kind = 'dm' AND p.removed_at IS NOT NULL);
  `,
  // What the core keeps for itself and no screen reads (unlike settings): when the Tucano got its
  // second person, say.
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // What reads by thread (the quiet-thread sweep, every minute), by author (where an agent wrote
  // last) and a reply's receipts used to scan the whole table.
  `
  CREATE INDEX IF NOT EXISTS messages_by_thread_id ON messages (thread_id, at);
  CREATE INDEX IF NOT EXISTS messages_by_author ON messages (author_id, at);
  CREATE INDEX IF NOT EXISTS receipts_by_message ON receipts (message_id);
  `,
  // The class the rules gave a tool at its last sync: a class equal to it is still automatic and
  // follows the rules when they change; any other was chosen by hand and stays. Empty until the first
  // sync after this, which tells the two apart with the rules from before.
  `
  ALTER TABLE connector_tools ADD COLUMN cls_auto TEXT;
  `,
  // Gemini CLI was replaced by the Antigravity CLI: what ran on the "gemini" harness now runs on
  // "antigravity", the same login and models (its own engine maps the old model names).
  `
  UPDATE settings SET value = REPLACE(value, '"gemini"', '"antigravity"') WHERE key = 'harnesses';
  UPDATE settings SET value = REPLACE(value, '"gemini:', '"antigravity:') WHERE value LIKE '%"gemini:%';
  UPDATE agents SET model = 'antigravity:' || substr(model, 8) WHERE model LIKE 'gemini:%';
  UPDATE agents SET fallback_model = 'antigravity:' || substr(fallback_model, 8) WHERE fallback_model LIKE 'gemini:%';
  UPDATE receipts SET engine = 'antigravity' WHERE engine = 'gemini';
  UPDATE receipts SET model = 'antigravity:' || substr(model, 8) WHERE model LIKE 'gemini:%';
  `
]

// Columns checked by name on every start, after MIGRATIONS ([table, column, type]): one a build of
// another branch already added (approvals by rule did) is left as it is instead of failing the start.
// How far each agent goes on its own: a rule per kind of action, its level, the outside-content guard
// (src/shared/actions.ts). Empty: Settings decide, which out of the box is how Tucano always worked.
const COLUMNS: [string, string, string][] = [
  ['agents', 'action_rules', "TEXT NOT NULL DEFAULT '{}'"],
  ['agents', 'autonomy', 'TEXT'],
  ['agents', 'outside_guard', 'INTEGER'],
  // A phone's push handle (src/core/push.ts), on its device key: {"handle", "tag"} as JSON.
  ['person_keys', 'push', 'TEXT'],
  // A routine on a date ("2026-11-17", once) or on a day of every month (1–31).
  ['routines', 'date', 'TEXT'],
  ['routines', 'month_day', 'INTEGER']
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

  constructor(private file: string) {
    this.db = new DatabaseSync(file)
    this.keepStatements()
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    try { this.migrate(file) }
    catch (error) { this.db.close(); throw error }
  }

  close(): void {
    this.db.close()
  }

  // Each query is compiled once and kept: the same few dozen run many times a turn. node:sqlite
  // resets a statement after every get/all/run, so a kept one holds no lock between uses.
  private keepStatements(): void {
    const prepare = this.db.prepare.bind(this.db)
    const kept = new Map<string, StatementSync>()
    this.db.prepare = (sql, options) => {
      if (options) return prepare(sql, options)
      let stmt = kept.get(sql)
      if (!stmt) kept.set(sql, (stmt = prepare(sql)))
      return stmt
    }
  }

  // A consistent copy of the whole database, while it's in use.
  backupTo(file: string): void {
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`)
  }

  // Snapshot the live DB, then sanitize only the copy. Publish it only after
  // VACUUM removes deleted history from its pages; no engine/browser files copy.
  // The extra Claude Code and Codex logins stay too (their folders, and the Mac's keychain,
  // are the source's): the copy's agents use the usual login.
  // `wikiDir`: the source's wiki folder, which the copy uses too when the wiki comes along.
  duplicateTo(file: string, name: string, parts: WorkspaceParts = ALL_PARTS, wikiDir?: string): void {
    if (existsSync(file)) throw new Error('Workspace destination already exists')
    // Keep the unsanitized snapshot with its source, not in the new workspace.
    // A crash before sanitizing must not leave source memories in the copy.
    const stagingDir = this.file === ':memory:' ? dirname(file) : join(dirname(this.file), 'backups')
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
    const staging = join(stagingDir, `.workspace-copy-${randomUUID()}.preparing`)
    let copy: Db | undefined
    try {
      this.backupTo(staging)
      copy = new Db(staging)
      const target = copy
      target.db.exec('PRAGMA secure_delete = ON')
      target.tx(() => {
        target.db.exec(`
          DELETE FROM messages;
          DELETE FROM memories;
          DELETE FROM approvals;
          DELETE FROM receipts;
          DELETE FROM artifacts;
          DELETE FROM services;
          UPDATE conversations SET summary = NULL, summary_until = NULL, summary_at = NULL;
          DELETE FROM settings WHERE key IN ('quota', 'telegram', 'accounts');
          UPDATE agents SET account = NULL, fallback_account = NULL;
          DELETE FROM secrets WHERE key LIKE 'telegram:%' OR key = 'github:proxy-key' OR key LIKE '%:oauth_verifier';
          DELETE FROM person_keys;
          DELETE FROM removed_keys;
          DELETE FROM invites;
          DELETE FROM read_state;
          DELETE FROM conversations WHERE kind = 'dm' AND owner IS NOT NULL AND owner <> (SELECT id FROM people WHERE role = 'owner');
          DELETE FROM people WHERE role <> 'owner';
          UPDATE agents SET owner = (SELECT id FROM people WHERE role = 'owner');
          UPDATE routines SET owner = (SELECT id FROM people WHERE role = 'owner');
          UPDATE people SET delegate_to = NULL, delegate_until = NULL;
          DELETE FROM routine_watchers;
          DELETE FROM questions;
          DELETE FROM activity;
        `)
        target.keepOnly(parts)
        if (!parts.wiki) target.db.prepare("DELETE FROM settings WHERE key = 'wikiDir'").run() // its own, empty
        else if (wikiDir) target.setSettings({ wikiDir })
        const setup = target.db.prepare("SELECT value FROM settings WHERE key = 'onboarding'").get() as { value: string } | undefined
        const onboarding = setup ? JSON.parse(setup.value) as Settings['onboarding'] : undefined
        // With its agents, a set-up workspace needs no introduction; without, it starts from what came.
        const done = parts.agents && onboarding?.done !== false
        target.setSettings({ workspaceLabel: name, onboarding: done ? { ...onboarding, done: true, workspaceManagerSeen: undefined } : { done: false, ...(parts.general ? { carried: true } : {}) } })
        for (const r of target.routines()) {
          const trigger: Trigger | undefined = r.trigger?.kind === 'webhook' ? { kind: 'webhook', token: randomUUID().replaceAll('-', '') }
            : r.trigger?.kind === 'poll' ? { kind: 'poll', connectorId: r.trigger.connectorId, tool: r.trigger.tool, args: r.trigger.args, everyMinutes: r.trigger.everyMinutes } : undefined
          target.saveRoutine({ ...r, lastAt: undefined, lastMessageId: undefined, trigger, nextAt: r.enabled && !trigger ? nextRun(r.schedule, Date.now()) : undefined })
        }
      })
      target.db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE)')
      target.close()
      copy = undefined
      renameSync(staging, file)
    } finally {
      copy?.close()
      for (const path of [staging, `${staging}-wal`, `${staging}-shm`]) rmSync(path, { force: true })
    }
  }

  // A copy keeps only what was picked to come along; what depends on something left behind goes,
  // or comes without it: agents without connectors have no grants, a skill of agents left behind
  // comes archived (with no agents it would apply to everyone), a routine needs its agent and place.
  private keepOnly(parts: WorkspaceParts): void {
    if (WORKSPACE_PARTS.every((p) => parts[p])) return
    const kept = new Set(['seenVersion', 'theme', 'onboarding', ...(parts.general ? GENERAL_SETTINGS : []), ...(parts.context ? ['context'] : []), ...(parts.channels ? ['channelLayout', 'folded'] : [])])
    for (const { key } of this.db.prepare('SELECT key FROM settings').all() as { key: string }[]) if (!kept.has(key)) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key)
    if (!parts.general) this.db.prepare('DELETE FROM secrets WHERE key = ?').run(JEV_KEY)
    if (!parts.connectors) {
      this.db.exec('DELETE FROM connectors; UPDATE agents SET grants = \'{}\', auto_approve = \'[]\'')
      this.db.prepare('DELETE FROM secrets WHERE key <> ?').run(JEV_KEY) // the connectors' keys and logins, and GitHub's
    }
    if (!parts.agents) this.db.exec("DELETE FROM members; DELETE FROM conversations WHERE kind = 'dm'; DELETE FROM agents")
    if (!parts.channels) this.db.exec("DELETE FROM conversations WHERE kind <> 'dm'")
    if (!parts.skills) this.db.exec('DELETE FROM skill_versions; DELETE FROM skills')
    else if (!parts.agents) this.db.exec("UPDATE skills SET state = 'archived' WHERE agents <> '[]'")
    if (!parts.routines) this.db.exec('DELETE FROM routines')
    const connectors = new Set(this.connectors().map((c) => c.id))
    for (const r of this.routines())
      if (!this.agent(r.agentId) || !this.conversation(r.conversationId) || (r.trigger?.kind === 'poll' && !connectors.has(r.trigger.connectorId))) this.removeRoutine(r.id)
  }

  private migrate(file: string): void {
    const { user_version } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    this.created = user_version === 0
    // A copy from before the update, among the daily ones (and pruned with them).
    if (user_version > 0 && user_version < MIGRATIONS.length && file !== ':memory:') {
      const backups = join(dirname(file), 'backups')
      mkdirSync(backups, { recursive: true })
      this.backupTo(join(backups, `tucano-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-schema-${user_version}.db`))
    }
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })
    }
    for (const [table, column, type] of COLUMNS) {
      const has = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)
      if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
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

  // A backup from another computer just became this database (restore.ts). What only worked there
  // goes: its secrets (sealed with that computer's key), its devices and invites, its extra logins,
  // the agents' use of that computer (its desktop, apps and folders), and routines run there until
  // someone turns them on here. What this server had of its own stays, from `previous` (its
  // database before the swap): the owner's devices (so whoever restored stays signed in), the
  // secrets, the harnesses picked and Telegram. Returns how many routines were turned off.
  adoptRestore(previous?: string): number {
    const routines = Number((this.db.prepare('SELECT count(*) AS n FROM routines WHERE enabled = 1').get() as Row)['n'] ?? 0)
    this.tx(() => {
      this.db.exec(`
        DELETE FROM secrets;
        DELETE FROM person_keys;
        DELETE FROM removed_keys;
        DELETE FROM invites;
        DELETE FROM settings WHERE key IN ('quota', 'telegram', 'accounts', 'wikiDir', 'harnesses');
        UPDATE agents SET account = NULL, fallback_account = NULL, apps = '[]', folders = '[]', computer = CASE WHEN computer_kind = 'mac' THEN 0 ELSE computer END;
        UPDATE routines SET enabled = 0;
      `)
    })
    this.ownerCache = ''
    if (previous) {
      this.db.prepare('ATTACH DATABASE ? AS old').run(previous)
      try {
        this.tx(() => {
          const owner = this.ownerId()
          const was = (sql: string): void => {
            try {
              this.db.exec(sql)
            } catch (e) {
              console.warn('[restore] kept less of the server:', e instanceof Error ? e.message : e)
            }
          }
          was('INSERT OR REPLACE INTO secrets (key, value) SELECT key, value FROM old.secrets')
          this.db
            .prepare("INSERT OR IGNORE INTO person_keys (hash, person_id, label, created_at, last_seen) SELECT hash, ?, label, created_at, last_seen FROM old.person_keys WHERE person_id = (SELECT id FROM old.people WHERE role = 'owner')")
            .run(owner)
          was("INSERT OR REPLACE INTO settings (key, value) SELECT key, value FROM old.settings WHERE key IN ('harnesses', 'telegram')")
        })
      } finally {
        this.db.exec('DETACH DATABASE old')
      }
    }
    return routines
  }

  // ---------- the core's own notes ----------

  meta(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined
    return r ? str(r['value']) : undefined
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
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
      ...(str(r['account']) ? { accountId: str(r['account']) } : {}),
      ...(str(r['fallback_model']) ? { fallbackModelId: str(r['fallback_model']) } : {}),
      ...(str(r['fallback_account']) ? { fallbackAccountId: str(r['fallback_account']) } : {}),
      effort: str(r['effort']) as Effort,
      limit: Number(r['limit_tokens']),
      maxRoutines: routineCap(Number(r['max_routines'])),
      used: this.usedThisMonth(str(r['id'])),
      grants: JSON.parse(str(r['grants']) || '{}') as Agent['grants'],
      memory: (str(r['memory_mode']) || 'auto') as MemoryMode,
      computer: r['computer'] === 1,
      computerKind: str(r['computer_kind']) === 'mac' ? 'mac' : 'linux',
      web: r['web'] !== 0,
      browser: r['browser'] === 1,
      apps: JSON.parse(str(r['apps']) || '[]') as AgentApp[],
      ...(r['custom_color'] ? { customColor: str(r['custom_color']) } : {}),
      ...(r['picture'] ? { picture: str(r['picture']) } : {}),
      ...(r['avatar'] ? { avatar: JSON.parse(str(r['avatar'])) as Agent['avatar'] } : {}),
      ...(r['wiki'] === 'none' || r['wiki'] === 'read' ? { wiki: r['wiki'] } : {}),
      autoApprove: JSON.parse(str(r['auto_approve']) || '[]') as string[],
      ...(str(r['action_rules']) && str(r['action_rules']) !== '{}' ? { actionRules: cleanRules(JSON.parse(str(r['action_rules']))) } : {}),
      ...(isAutonomy(r['autonomy']) ? { autonomy: r['autonomy'] } : {}),
      ...(r['outside_guard'] === 0 || r['outside_guard'] === 1 ? { outsideGuard: r['outside_guard'] === 1 } : {}),
      folders: JSON.parse(str(r['folders']) || '[]') as LentFolder[],
      archived: r['archived'] === 1,
      ...(str(r['kind']) === 'tuca' ? { kind: 'tuca' as const } : {}),
      // One with no owner (put there by another tool, after the people came) is the Tucano owner's.
      owner: r['owner'] ? str(r['owner']) : this.ownerId()
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
        `INSERT INTO agents (id, name, handle, role, color, instructions, model, fallback_model, fallback_account, account, effort, limit_tokens, max_routines, grants, memory_mode, computer, computer_kind, web, browser, apps, auto_approve, action_rules, autonomy, outside_guard, archived, kind, custom_color, picture, avatar, wiki, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, handle = excluded.handle, role = excluded.role,
           color = excluded.color, instructions = excluded.instructions, model = excluded.model, fallback_model = excluded.fallback_model, fallback_account = excluded.fallback_account, account = excluded.account, effort = excluded.effort,
           limit_tokens = excluded.limit_tokens, max_routines = excluded.max_routines, grants = excluded.grants, memory_mode = excluded.memory_mode,
           computer = excluded.computer, computer_kind = excluded.computer_kind, web = excluded.web, browser = excluded.browser, apps = excluded.apps, auto_approve = excluded.auto_approve, action_rules = excluded.action_rules, autonomy = excluded.autonomy, outside_guard = excluded.outside_guard, archived = excluded.archived, kind = COALESCE(excluded.kind, agents.kind), custom_color = excluded.custom_color, picture = excluded.picture, avatar = excluded.avatar, wiki = excluded.wiki`
      )
      .run(a.id, a.name, a.handle, a.role, a.color, a.instructions, a.modelId, a.fallbackModelId || null, a.fallbackAccountId || null, a.accountId || null, a.effort, a.limit, routineCap(a.maxRoutines), JSON.stringify(a.grants), a.memory ?? 'auto', a.computer ? 1 : 0, a.computerKind === 'mac' ? 'mac' : 'linux', a.web === false ? 0 : 1, a.browser ? 1 : 0, JSON.stringify(a.apps ?? []), JSON.stringify(a.autoApprove ?? []), JSON.stringify(cleanRules(a.actionRules)), isAutonomy(a.autonomy) ? a.autonomy : null, a.outsideGuard === undefined ? null : a.outsideGuard ? 1 : 0, a.archived ? 1 : 0, a.kind ?? null, a.customColor ?? null, a.picture ?? null, a.avatar ? JSON.stringify(a.avatar) : null, a.wiki ?? null, Date.now())
    // An agent made without one belongs to the Tucano's owner; a save that doesn't say keeps it.
    this.db.prepare('UPDATE agents SET owner = COALESCE(?, owner, (SELECT id FROM people WHERE role = ?)) WHERE id = ?').run(a.owner ?? null, 'owner', a.id)
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

  // `unread` is the given person's (the owner's when left out): their notifications still unread
  // (only those rows are read, not the history).
  conversations(personId = this.ownerId()): Conversation[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, COALESCE(u.n, 0) AS unread FROM conversations c
         LEFT JOIN (SELECT m.conversation_id AS id, COUNT(*) AS n FROM unread x JOIN messages m ON m.id = x.message_id WHERE x.person_id = ? GROUP BY m.conversation_id) u ON u.id = c.id
         ORDER BY c.created_at`
      )
      .all(personId) as Row[]
    const members = this.db.prepare('SELECT conversation_id, agent_id FROM members').all() as { conversation_id: string; agent_id: string }[]
    return rows.map((r) => this.toConversation(r, members.filter((m) => m.conversation_id === r['id']).map((m) => m.agent_id)))
  }

  private toConversation(r: Row, members: string[]): Conversation {
    return {
      id: str(r['id']),
      kind: str(r['kind']) as Conversation['kind'],
      name: str(r['name']),
      topic: r['topic'] ? str(r['topic']) : undefined,
      members,
      summary: r['summary'] ? str(r['summary']) : undefined,
      summaryUntil: r['summary_until'] ? Number(r['summary_until']) : undefined,
      summaryAt: r['summary_at'] ? Number(r['summary_at']) : undefined,
      ...(r['wiki_capture'] === 0 ? { wikiCapture: false } : {}),
      ...(r['threads'] === 1 ? { threads: true } : {}),
      ...(r['owner'] ? { owner: str(r['owner']) } : {}),
      ...(r['created_by'] ? { createdBy: str(r['created_by']) } : {}),
      unread: Number(r['unread'])
    }
  }

  // `until` is the `at` of the last message the summary covers; leave it out to keep it (a hand edit).
  setSummary(conversationId: string, summary: string, until?: number): void {
    if (until === undefined) this.db.prepare('UPDATE conversations SET summary = ?, summary_at = ? WHERE id = ?').run(summary, Date.now(), conversationId)
    else this.db.prepare('UPDATE conversations SET summary = ?, summary_until = ?, summary_at = ? WHERE id = ?').run(summary, until, Date.now(), conversationId)
  }

  // Just that one: it's read several times a turn, and the full list grows with every DM.
  conversation(id: string, personId = this.ownerId()): Conversation | undefined {
    const r = this.db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM unread x JOIN messages m ON m.id = x.message_id WHERE x.person_id = ? AND m.conversation_id = c.id) AS unread
         FROM conversations c WHERE c.id = ?`
      )
      .get(personId, id) as Row | undefined
    if (!r) return undefined
    const members = (this.db.prepare('SELECT agent_id FROM members WHERE conversation_id = ? ORDER BY rowid').all(id) as { agent_id: string }[]).map((m) => m.agent_id)
    return this.toConversation(r, members)
  }

  // Only whose a conversation is, for checks on every event (no counts, no members).
  conversationOwner(id: string): Pick<Conversation, 'kind' | 'owner'> | undefined {
    const r = this.db.prepare('SELECT kind, owner FROM conversations WHERE id = ?').get(id) as Row | undefined
    return r && { kind: str(r['kind']) as Conversation['kind'], ...(r['owner'] ? { owner: str(r['owner']) } : {}) }
  }

  // The conversation a message is in, without reading the message.
  messageConversation(id: string): string | undefined {
    const r = this.db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(id) as Row | undefined
    return r && str(r['conversation_id'])
  }

  // A DM without an owner is the Tucano owner's (made before people, or by code that doesn't say).
  createConversation(c: Omit<Conversation, 'unread'>): void {
    this.tx(() => {
      const owner = c.kind === 'dm' ? (c.owner ?? this.ownerId()) : null
      // A channel is whoever made it (the owner when the code doesn't say).
      const by = c.kind === 'channel' ? (c.createdBy ?? this.ownerId()) : null
      this.db.prepare('INSERT INTO conversations (id, kind, name, topic, threads, owner, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(c.id, c.kind, c.name, c.topic ?? null, c.threads ? 1 : null, owner, by, Date.now())
      for (const m of c.members) this.db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(c.id, m)
    })
  }

  renameConversation(id: string, name: string): void {
    this.db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, id)
  }

  // Off: the wiki's curator leaves the conversation out. On is the default (stored as null).
  setWikiCapture(id: string, on: boolean): void {
    this.db.prepare('UPDATE conversations SET wiki_capture = ? WHERE id = ?').run(on ? null : 0, id)
  }

  // On: answers go in threads. Off, in the conversation, is the default (stored as null).
  setThreads(id: string, on: boolean): void {
    this.db.prepare('UPDATE conversations SET threads = ? WHERE id = ?').run(on ? 1 : null, id)
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

  // Everything here so far is read, for this person (the owner when left out).
  markRead(conversationId: string, personId = this.ownerId()): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM unread WHERE person_id = ? AND message_id IN (SELECT id FROM messages WHERE conversation_id = ?)').run(personId, conversationId)
      this.db
        .prepare('INSERT INTO read_state (person_id, conversation_id, read_at, seen) VALUES (?, ?, ?, 0) ON CONFLICT (person_id, conversation_id) DO UPDATE SET read_at = excluded.read_at')
        .run(personId, conversationId, Date.now())
    })
  }

  // This person's unread notifications, in one conversation or in all of them (the owner's when left out).
  unread(conversationId?: string, personId = this.ownerId()): number {
    const sql = 'SELECT COUNT(*) AS n FROM unread x JOIN messages m ON m.id = x.message_id WHERE x.person_id = ?'
    const row = (conversationId ? this.db.prepare(`${sql} AND m.conversation_id = ?`).get(personId, conversationId) : this.db.prepare(sql).get(personId)) as { n: number }
    return Number(row.n)
  }

  // Who reads a conversation: a DM's person; a channel's, everyone with access.
  private readers(conversationId: string): string[] {
    const c = this.conversationOwner(conversationId)
    if (!c) return []
    const all = (this.db.prepare('SELECT id FROM people WHERE removed_at IS NULL').all() as Row[]).map((r) => str(r['id']))
    if (c.kind !== 'dm') return all
    const dm = c.owner ?? this.ownerId()
    return all.includes(dm) ? [dm] : []
  }

  // True when this made someone's unread count go up: a new reply, or a running one that finished.
  // A running reply counts once. If it was read while running, its completion is new content, but
  // repeated terminal events and deltas must not count again. The rule is applied for each person
  // who reads the conversation and isn't looking at it. `viewing`: the owner's open conversation
  // (a desktop), or each person's.
  recordActivity(message: Message, viewing: string | null | Map<string, string | null>): boolean {
    if (message.author.kind !== 'agent' && message.author.kind !== 'routine') return false
    const phase = message.run?.status ?? 'message'
    if (phase !== 'message' && !['working', 'done', 'failed', 'limit_reached', 'waiting_input', 'waiting_approval'].includes(phase)) return false
    return this.tx(() => {
      const r = this.db.prepare('INSERT OR IGNORE INTO message_notifications (message_id, phase) VALUES (?, ?)').run(message.id, phase)
      if (Number(r.changes) === 0) return false
      const owner = this.ownerId()
      let more = false
      for (const p of this.readers(message.conversationId)) {
        const open = viewing instanceof Map ? viewing.get(p) : p === owner ? viewing : null
        if (open === message.conversationId) continue
        if (phase !== 'working' && phase !== 'message' && this.unread(message.conversationId, p) > 0) continue
        this.db.prepare('INSERT OR IGNORE INTO unread (person_id, message_id, phase) VALUES (?, ?, ?)').run(p, message.id, phase)
        more = true
      }
      return more
    })
  }

  private toMessage(r: Row): Message {
    const kind = str(r['author_kind'])
    // A row from before people ('me') is the owner's.
    const author: Author =
      kind === 'agent' || kind === 'routine' ? { kind, id: str(r['author_id']) } : kind === 'system' ? { kind: 'system' } : { kind: 'person', id: kind === 'person' && r['author_id'] ? str(r['author_id']) : this.ownerId() }
    return {
      id: str(r['id']),
      conversationId: str(r['conversation_id']),
      author,
      text: str(r['text']),
      at: Number(r['at']),
      run: r['run'] ? (JSON.parse(str(r['run'])) as Run) : undefined,
      routine: r['routine'] ? (JSON.parse(str(r['routine'])) as RoutineRun) : undefined,
      threadId: r['thread_id'] ? str(r['thread_id']) : undefined,
      ...(r['thread_summary'] ? { threadSummary: JSON.parse(str(r['thread_summary'])) as ThreadSummary } : {})
    }
  }

  messages(): Message[] {
    return (this.db.prepare('SELECT * FROM messages ORDER BY at').all() as Row[]).map((r) => this.toMessage(r))
  }

  // The latest question waiting for me, however much was said after it. `threadId`: in that thread; null: outside threads.
  waitingQuestion(conversationId: string, threadId: string | null): Message | undefined {
    const where = threadId === null ? 'thread_id IS NULL' : 'thread_id = ?'
    const args = threadId === null ? [conversationId] : [conversationId, threadId]
    const row = this.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND ${where} AND json_extract(run, '$.status') = 'waiting_input' ORDER BY at DESC LIMIT 1`).get(...args) as Row | undefined
    return row ? this.toMessage(row) : undefined
  }

  // `threadId`: only that thread's replies; null: only what's outside threads; left out: everything.
  // `before`: only those from before that moment.
  recentMessages(conversationId: string, limit: number, threadId?: string | null, before?: number): Message[] {
    const where = (threadId === undefined ? '' : threadId === null ? ' AND thread_id IS NULL' : ' AND thread_id = ?') + (before === undefined ? '' : ' AND at < ?')
    const args = [conversationId, ...(typeof threadId === 'string' ? [threadId] : []), ...(before === undefined ? [] : [before]), limit]
    const rows = this.db.prepare(`SELECT * FROM messages WHERE conversation_id = ?${where} ORDER BY at DESC LIMIT ?`).all(...args) as Row[]
    return rows.reverse().map((r) => this.toMessage(r))
  }

  // A thread's summary, on its first message; leave `until` out to keep it (a hand edit).
  setThreadSummary(rootId: string, text: string, until?: number): void {
    const kept = until ?? this.message(rootId)?.threadSummary?.until ?? 0
    this.db.prepare('UPDATE messages SET thread_summary = ? WHERE id = ?').run(JSON.stringify({ text, until: kept, at: Date.now() } satisfies ThreadSummary), rootId)
  }

  // The messages of a conversation that carry a thread's summary.
  summarizedThreads(conversationId: string): string[] {
    return (this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND thread_summary IS NOT NULL').all(conversationId) as Row[]).map((r) => str(r['id']))
  }

  // The messages that started a thread with replies in it.
  threadRoots(conversationId: string): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT thread_id FROM messages WHERE conversation_id = ? AND thread_id IS NOT NULL').all(conversationId) as Row[]
    return new Set(rows.map((r) => str(r['thread_id'])))
  }

  // Threads quiet since `before`, active after `since`, with something said after their summary.
  // From the replies (the thread index), then each one's first message: not every message, every minute.
  quietThreads(before: number, since: number): { id: string; conversationId: string; last: number }[] {
    const rows = this.db
      .prepare(
        `SELECT r.id, r.conversation_id, t.last, COALESCE(json_extract(r.thread_summary, '$.until'), 0) AS until
         FROM (SELECT thread_id, MAX(at) AS last FROM messages WHERE thread_id IS NOT NULL AND author_kind != 'system' GROUP BY thread_id) t
         CROSS JOIN messages r ON r.id = t.thread_id
         WHERE r.thread_id IS NULL AND t.last < ? AND t.last > ? AND t.last > until ORDER BY t.last`
      )
      .all(before, since) as Row[]
    return rows.map((r) => ({ id: str(r['id']), conversationId: str(r['conversation_id']), last: Number(r['last']) }))
  }

  // Oldest first.
  messagesAfter(conversationId: string, at: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND at > ? ORDER BY at').all(conversationId, at) as Row[]).map((r) => this.toMessage(r))
  }

  // What was said after `at`: a reply counts from when it ended (saidAt), so one that started before `at` is still here.
  messagesSaidAfter(conversationId: string, at: number): Message[] {
    return (this.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND COALESCE(json_extract(run, '$.endedAt'), at) > ? ORDER BY at`).all(conversationId, at) as Row[]).map((r) => this.toMessage(r))
  }

  // What the window opens with: each conversation's latest `n` messages outside threads, the threads
  // still going wherever they started, and every routine's request with its reply (Routines draws what
  // ran), each with all its replies. `since`: per conversation with older ones left, from when it's whole.
  openingMessages(n: number): { messages: Message[]; since: Record<string, number> } {
    const ranked = 'ranked AS (SELECT id, conversation_id, thread_id, at, ROW_NUMBER() OVER (PARTITION BY conversation_id, thread_id IS NULL ORDER BY at DESC) AS n FROM messages)'
    const rows = this.db
      .prepare(
        `WITH ${ranked},
         asks AS (SELECT a.id, a.conversation_id, a.at, x.agent_id FROM messages a LEFT JOIN routines x ON x.id = a.author_id WHERE a.author_kind = 'routine'),
         roots AS (
           SELECT id FROM ranked WHERE thread_id IS NULL AND n <= ?
           UNION SELECT thread_id FROM ranked WHERE thread_id IS NOT NULL AND n <= ?
           UNION SELECT id FROM asks
           UNION SELECT (SELECT r.id FROM messages r WHERE r.conversation_id = asks.conversation_id AND r.author_kind = 'agent' AND r.at > asks.at AND (asks.agent_id IS NULL OR r.author_id = asks.agent_id) ORDER BY r.at LIMIT 1) FROM asks
         )
         SELECT * FROM messages WHERE id IN (SELECT id FROM roots) OR thread_id IN (SELECT id FROM roots) ORDER BY at`
      )
      .all(n, n) as Row[]
    const cut = this.db
      .prepare(`WITH ${ranked} SELECT conversation_id, at FROM ranked WHERE thread_id IS NULL AND n = ? AND conversation_id IN (SELECT conversation_id FROM ranked WHERE thread_id IS NULL AND n = ?)`)
      .all(n, n + 1) as Row[]
    return { messages: rows.map((r) => this.toMessage(r)), since: Object.fromEntries(cut.map((r) => [str(r['conversation_id']), Number(r['at'])])) }
  }

  // Further back, a page at a time: the `n` messages outside threads before `before` (all of them back
  // to `from`, when given), with their replies. `since`: from when it's whole now, 0 once all of it is.
  messagesBefore(conversationId: string, before: number, n: number, from?: number): { messages: Message[]; since: number } {
    const page = (
      from === undefined
        ? this.db.prepare('SELECT id, at FROM messages WHERE conversation_id = ? AND thread_id IS NULL AND at < ? ORDER BY at DESC LIMIT ?').all(conversationId, before, n)
        : this.db.prepare('SELECT id, at FROM messages WHERE conversation_id = ? AND thread_id IS NULL AND at < ? AND at >= ? ORDER BY at DESC').all(conversationId, before, from)
    ) as Row[]
    const oldest = page.length ? Number(page.at(-1)!['at']) : Math.min(before, from ?? before)
    const more = !!this.db.prepare('SELECT 1 FROM messages WHERE conversation_id = ? AND thread_id IS NULL AND at < ? LIMIT 1').get(conversationId, oldest)
    const since = more ? oldest : 0
    if (!page.length) return { messages: [], since }
    const ids = JSON.stringify(page.map((r) => str(r['id'])))
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? AND (id IN (SELECT value FROM json_each(?)) OR thread_id IN (SELECT value FROM json_each(?))) ORDER BY at')
      .all(conversationId, ids, ids) as Row[]
    return { messages: rows.map((r) => this.toMessage(r)), since }
  }

  // The connector tools an agent called in its replies since `since`, most used first, as each step
  // names them ("Linear · list_issues"), with how many times.
  toolsUsedBy(agentId: string, since: number, replies = 200): { detail: string; count: number }[] {
    const rows = this.db.prepare("SELECT run FROM messages WHERE author_kind = 'agent' AND author_id = ? AND at > ? AND run IS NOT NULL ORDER BY at DESC LIMIT ?").all(agentId, since, replies) as Row[]
    const counts = new Map<string, number>()
    for (const r of rows) {
      const steps = (JSON.parse(str(r['run'])) as { steps?: { detail?: unknown }[] }).steps ?? []
      for (const s of steps) if (typeof s.detail === 'string' && s.detail.includes(' · ')) counts.set(s.detail, (counts.get(s.detail) ?? 0) + 1)
    }
    return [...counts].map(([detail, count]) => ({ detail, count })).sort((a, b) => b.count - a.count)
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
        `INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run, routine, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        m.routine ? JSON.stringify(m.routine) : null,
        m.threadId ?? null
      )
  }

  // The replies whose run is in one of these states, oldest first. Found in SQL: the rest of
  // the messages are never parsed.
  messagesWithRun(statuses: Run['status'][]): Message[] {
    if (!statuses.length) return []
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE run IS NOT NULL AND json_extract(run, '$.status') IN (${statuses.map(() => '?').join(', ')}) ORDER BY at`)
      .all(...statuses) as Row[]
    return rows.map((r) => this.toMessage(r))
  }

  // The approval a reply is waiting on, newest first: one reply asks one thing at a time.
  approvalForMessage(messageId: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE message_id = ? ORDER BY created_at DESC LIMIT 1').get(messageId) as Row | undefined
    return r ? this.toApproval(r) : undefined
  }

  // Runs that were working when the app closed can't continue: their CLI process is gone.
  interruptStaleRuns(): number {
    let n = 0
    for (const m of this.messagesWithRun(['working'])) {
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
      envKeys: JSON.parse(str(r['env_keys']) || '[]') as string[],
      auth: str(r['auth']) as ConnectorAuth,
      tools: this.tools(id).map(({ inputSchema: _, ...t }) => t)
    }
  }

  saveConnector(c: { id: string; name: string; kind: Connector['kind']; url?: string; command?: string; args?: string[]; envKeys?: string[]; auth: ConnectorAuth }): void {
    this.db
      .prepare(
        `INSERT INTO connectors (id, name, kind, url, command, args, env_keys, auth, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, command = excluded.command,
           args = excluded.args, env_keys = excluded.env_keys, auth = excluded.auth`
      )
      .run(c.id, c.name, c.kind, c.url ?? null, c.command ?? null, JSON.stringify(c.args ?? []), JSON.stringify(c.envKeys ?? []), c.auth, Date.now())
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
  // `cls`: the class the rules give the tool now; `legacyCls`, the one the rules before outbound verbs
  // gave it, which tells an automatic class from a hand-picked one on a tool synced before cls_auto.
  // A class still automatic follows the rules; one chosen by hand stays.
  syncTools(connectorId: string, listed: { name: string; description: string; inputSchema: Record<string, unknown>; cls: ToolClass; legacyCls?: ToolClass }[]): void {
    this.tx(() => {
      const first = !(this.db.prepare('SELECT synced FROM connectors WHERE id = ?').get(connectorId) as { synced: number } | undefined)?.synced
      const stored = new Map((this.db.prepare('SELECT name, cls, cls_auto FROM connector_tools WHERE connector_id = ?').all(connectorId) as Row[]).map((r) => [str(r['name']), { cls: str(r['cls']), auto: r['cls_auto'] == null ? undefined : str(r['cls_auto']) }]))
      for (const t of listed) {
        const was = stored.get(t.name)
        if (was) {
          const automatic = was.cls === (was.auto ?? t.legacyCls ?? t.cls)
          this.db
            .prepare('UPDATE connector_tools SET description = ?, input_schema = ?, cls = ?, cls_auto = ? WHERE connector_id = ? AND name = ?')
            .run(t.description, JSON.stringify(t.inputSchema), automatic ? t.cls : was.cls, t.cls, connectorId, t.name)
        } else {
          this.db
            .prepare('INSERT INTO connector_tools (connector_id, name, description, input_schema, cls, cls_auto, enabled, high_risk, is_new) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
            .run(connectorId, t.name, t.description, JSON.stringify(t.inputSchema), t.cls, t.cls, first ? 1 : 0, first ? 0 : 1)
        }
      }
      const known = stored.keys()
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
      decidedAt: r['decided_at'] ? Number(r['decided_at']) : undefined,
      ...(r['requested_by'] ? { requestedBy: str(r['requested_by']) } : {}),
      ...(r['decided_by'] ? { decidedBy: str(r['decided_by']) } : {}),
      ...(r['behalf'] ? { behalf: str(r['behalf']) } : {})
    }
  }

  // The latest replies that ended badly, newest first: what went wrong, never what was said.
  recentFailures(since: number, limit = 10): { agentId: string; conversationId: string; at: number; status: string; error?: string }[] {
    const rows = this.db
      .prepare(
        `SELECT author_id, conversation_id, at, json_extract(run, '$.status') AS status, json_extract(run, '$.error') AS error FROM messages
         WHERE author_kind = 'agent' AND at >= ? AND json_extract(run, '$.status') IN ('failed', 'limit_reached', 'interrupted')
         ORDER BY at DESC LIMIT ?`
      )
      .all(since, limit) as Row[]
    return rows.map((r) => ({ agentId: str(r['author_id']), conversationId: str(r['conversation_id']), at: Number(r['at']), status: str(r['status']), ...(r['error'] ? { error: str(r['error']) } : {}) }))
  }

  approvals(): Approval[] {
    return (this.db.prepare('SELECT * FROM approvals ORDER BY created_at').all() as Row[]).map((r) => this.toApproval(r))
  }

  // What the workspace switcher counts, often: only the pending ones, from their index.
  pendingApprovals(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE state = 'pending'").get() as { n: number }).n)
  }

  approval(id: string): Approval | undefined {
    const r = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Row | undefined
    return r && this.toApproval(r)
  }

  createApproval(a: Approval): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, hash, agent_id, conversation_id, message_id, connector_id, connector_name, tool, args, why, high_risk, state, created_at, expires_at, requested_by, behalf)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(a.id, a.hash, a.agentId, a.conversationId, a.messageId, a.connectorId, a.connectorName, a.tool, JSON.stringify(a.args), a.why, a.highRisk ? 1 : 0, a.state, a.createdAt, a.expiresAt, a.requestedBy ?? null, a.behalf ?? null)
  }

  // Only a pending approval can be decided, so the first decision wins. `by`: who decided (none when it expired).
  decideApproval(id: string, state: Exclude<ApprovalState, 'pending'>, reason?: string, by?: string): boolean {
    const r = this.db
      .prepare("UPDATE approvals SET state = ?, reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND state = 'pending'")
      .run(state, reason ?? null, Date.now(), by ?? null, id)
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
      ...(r['private_to'] ? { privateTo: str(r['private_to']) } : {}),
      createdAt: Number(r['created_at']),
      confirmedAt: Number(r['confirmed_at'])
    }
  }

  // 'me', the scope from before people, is the owner's own.
  private scopeOf(scope: string): string {
    return scope === 'me' ? `person:${this.ownerId()}` : scope
  }

  memories(filter: { scope?: string; state?: MemoryState } = {}): Memory[] {
    const where: string[] = []
    const args: string[] = []
    if (filter.scope) where.push('scope = ?'), args.push(this.scopeOf(filter.scope))
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
        `INSERT INTO memories (id, scope, text, state, origin, agent_id, conversation_id, message_ids, replaces, reason, private_to, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET text = excluded.text, state = excluded.state, reason = excluded.reason, private_to = excluded.private_to, confirmed_at = excluded.confirmed_at`
      )
      .run(m.id, this.scopeOf(m.scope), m.text, m.state, m.origin, m.agentId ?? null, m.conversationId ?? null, JSON.stringify(m.messageIds), m.replaces ?? null, m.reason ?? null, m.privateTo ?? null, m.createdAt, m.confirmedAt)
  }

  deleteMemory(id: string): void {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id)
  }

  // ---------- artifacts ----------

  artifacts(): Artifact[] {
    return (this.db.prepare('SELECT * FROM artifacts ORDER BY created_at').all() as Row[]).map((r) => this.toArtifact(r))
  }

  artifact(id: string): Artifact | undefined {
    const r = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Row | undefined
    return r && this.toArtifact(r)
  }

  private toArtifact(r: Row): Artifact {
    return {
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
    }
  }

  saveArtifact(a: Artifact): void {
    this.db
      .prepare('INSERT INTO artifacts (id, agent_id, conversation_id, message_id, kind, name, title, source, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(a.id, a.agentId, a.conversationId, a.messageId, a.kind, a.name, a.title, a.source, a.size, a.createdAt)
  }

  // ---------- services (what runs on an agent's computer) ----------

  // `conversationId`: where the reply that started it was (what it shows is for who sees that one).
  services(agentId: string): { name: string; command: string; port: number; startedAt: number; conversationId?: string }[] {
    return (this.db.prepare('SELECT * FROM services WHERE agent_id = ? ORDER BY started_at').all(agentId) as Row[]).map((r) => ({
      name: str(r['name']),
      command: str(r['command']),
      port: Number(r['port']),
      startedAt: Number(r['started_at']),
      ...(r['conversation_id'] ? { conversationId: str(r['conversation_id']) } : {})
    }))
  }

  saveService(agentId: string, s: { name: string; command: string; port: number; startedAt: number; conversationId?: string }): void {
    this.db
      .prepare(
        'INSERT INTO services (agent_id, name, command, port, started_at, conversation_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id, name) DO UPDATE SET command = excluded.command, port = excluded.port, started_at = excluded.started_at, conversation_id = excluded.conversation_id'
      )
      .run(agentId, s.name, s.command, s.port, s.startedAt, s.conversationId ?? null)
  }


  removeServices(agentId: string, name?: string): void {
    if (name) this.db.prepare('DELETE FROM services WHERE agent_id = ? AND name = ?').run(agentId, name)
    else this.db.prepare('DELETE FROM services WHERE agent_id = ?').run(agentId)
  }

  // ---------- routines ----------

  routines(): Routine[] {
    const watchers = new Map<string, string[]>()
    for (const w of this.db.prepare('SELECT routine_id, person_id FROM routine_watchers').all() as Row[]) watchers.set(str(w['routine_id']), [...(watchers.get(str(w['routine_id'])) ?? []), str(w['person_id'])])
    return (this.db.prepare('SELECT * FROM routines ORDER BY created_at').all() as Row[]).map((r) => ({
      id: str(r['id']),
      name: str(r['name']),
      agentId: str(r['agent_id']),
      conversationId: str(r['conversation_id']),
      prompt: str(r['prompt']),
      schedule: {
        days: JSON.parse(str(r['days']) || '[]') as number[],
        time: str(r['time']),
        ...(r['once'] === 1 ? { once: true } : {}),
        ...(r['date'] ? { date: str(r['date']) } : {}),
        ...(r['month_day'] != null ? { monthDay: Number(r['month_day']) } : {})
      },
      enabled: r['enabled'] === 1,
      nextAt: r['next_at'] == null ? undefined : Number(r['next_at']),
      lastAt: r['last_at'] == null ? undefined : Number(r['last_at']),
      lastMessageId: r['last_message_id'] ? str(r['last_message_id']) : undefined,
      createdBy: r['created_by'] ? str(r['created_by']) : undefined,
      trigger: r['trigger'] ? (JSON.parse(str(r['trigger'])) as Trigger) : undefined,
      createdAt: Number(r['created_at']),
      ...(str(r['scope']) === 'channel' ? { scope: 'channel' as const } : {}),
      ...(r['owner'] ? { owner: str(r['owner']) } : {}),
      ...(watchers.has(str(r['id'])) ? { watchers: watchers.get(str(r['id']))! } : {})
    }))
  }

  // Who asked to be told of a routine's runs; `on` false stops it.
  watchRoutine(routineId: string, personId: string, on: boolean): void {
    if (on) this.db.prepare('INSERT OR IGNORE INTO routine_watchers (routine_id, person_id) VALUES (?, ?)').run(routineId, personId)
    else this.db.prepare('DELETE FROM routine_watchers WHERE routine_id = ? AND person_id = ?').run(routineId, personId)
  }

  routine(id: string): Routine | undefined {
    return this.routines().find((r) => r.id === id)
  }

  saveRoutine(r: Routine): void {
    this.db
      .prepare(
        `INSERT INTO routines (id, name, agent_id, conversation_id, prompt, days, time, once, date, month_day, enabled, next_at, last_at, last_message_id, created_by, created_at, trigger)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, agent_id = excluded.agent_id, conversation_id = excluded.conversation_id, prompt = excluded.prompt,
           days = excluded.days, time = excluded.time, once = excluded.once, date = excluded.date, month_day = excluded.month_day, enabled = excluded.enabled, next_at = excluded.next_at, last_at = excluded.last_at,
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
        r.schedule.date ?? null,
        r.schedule.monthDay ?? null,
        r.enabled ? 1 : 0,
        r.nextAt ?? null,
        r.lastAt ?? null,
        r.lastMessageId ?? null,
        r.createdBy ?? null,
        r.createdAt,
        r.trigger ? JSON.stringify(r.trigger) : null
      )
    // A routine nobody says is the team's is a person's own: the Tucano owner's when no one is named.
    this.db.prepare('UPDATE routines SET scope = ?, owner = COALESCE(?, owner, (SELECT id FROM people WHERE role = ?)) WHERE id = ?').run(r.scope === 'channel' ? 'channel' : 'me', r.owner ?? null, 'owner', r.id)
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

  // ---------- people ----------

  private toPerson(r: Row): Person {
    const until = r['delegate_until'] == null ? undefined : Number(r['delegate_until'])
    return { id: str(r['id']), name: str(r['name']), role: str(r['role']) as Role, about: str(r['about']), ...(r['delegate_to'] && until ? { delegateTo: str(r['delegate_to']), delegateUntil: until } : {}) }
  }

  // The one owner, from the migration on; read once (every legacy message row asks).
  private ownerCache = ''
  ownerId(): string {
    return (this.ownerCache ||= str((this.db.prepare("SELECT id FROM people WHERE role = 'owner'").get() as Row | undefined)?.['id']))
  }

  owner(): Person {
    return this.toPerson(this.db.prepare("SELECT * FROM people WHERE role = 'owner'").get() as Row)
  }

  // Whether the owner has said their name (a server asks once).
  ownerNamed(): boolean {
    return (this.db.prepare("SELECT named FROM people WHERE role = 'owner'").get() as Row | undefined)?.['named'] === 1
  }

  // Who has access now; `removed`: also those whose access ended (kept for 30 days). With when each
  // was last seen and on how many devices (their keys), for the people screen.
  people(opts: { removed?: boolean } = {}): Person[] {
    const sql = `SELECT p.*, (SELECT MAX(last_seen) FROM person_keys k WHERE k.person_id = p.id) AS seen_at, (SELECT COUNT(*) FROM person_keys k WHERE k.person_id = p.id) AS devices
      FROM people p${opts.removed ? '' : ' WHERE p.removed_at IS NULL'} ORDER BY p.created_at, p.name`
    return (this.db.prepare(sql).all() as Row[]).map((r) => ({ ...this.toPerson(r), ...(r['seen_at'] ? { seenAt: Number(r['seen_at']) } : {}), ...(Number(r['devices']) ? { devices: Number(r['devices']) } : {}) }))
  }

  // A team's privacy from the moment it stops being one person's: its first invite (the heritage,
  // which happens once and stays: see inherit in index.ts) or a second person. A DM's memories and
  // pages are its person's alone from then on, even before anyone joined.
  teamMode(): boolean {
    return this.people().length > 1 || !!this.meta('heritageAt')
  }

  // A person's own display preferences (the owner's are the settings themselves).
  prefs(id: string): Partial<Settings> {
    const r = this.db.prepare('SELECT prefs FROM people WHERE id = ?').get(id) as Row | undefined
    try {
      const v = JSON.parse(str(r?.['prefs']) || '{}') as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<Settings>) : {}
    } catch {
      return {}
    }
  }

  setPrefs(id: string, patch: Partial<Settings>): void {
    this.db.prepare('UPDATE people SET prefs = ? WHERE id = ?').run(JSON.stringify({ ...this.prefs(id), ...patch }), id)
  }

  // Someone with access now (not a removed person).
  person(id: string): Person | undefined {
    const r = this.db.prepare('SELECT * FROM people WHERE id = ? AND removed_at IS NULL').get(id) as Row | undefined
    return r && this.toPerson(r)
  }

  // Everyone who had access and left (purged too): only their names, for what they wrote before.
  formerPeople(): Pick<Person, 'id' | 'name'>[] {
    return (this.db.prepare('SELECT id, name FROM people WHERE removed_at IS NOT NULL ORDER BY created_at').all() as Row[]).map((r) => ({ id: str(r['id']), name: str(r['name']) }))
  }

  // Those removed whose DMs and memories are still kept (an invite can bring them back).
  removedPeople(): (Person & { removedAt: number })[] {
    return (this.db.prepare('SELECT * FROM people WHERE removed_at IS NOT NULL AND purged_at IS NULL ORDER BY removed_at DESC').all() as Row[]).map((r) => ({ ...this.toPerson(r), removedAt: Number(r['removed_at']) }))
  }

  removedPerson(id: string): (Person & { removedAt: number; purgedAt?: number }) | undefined {
    const r = this.db.prepare('SELECT * FROM people WHERE id = ? AND removed_at IS NOT NULL').get(id) as Row | undefined
    return r && { ...this.toPerson(r), removedAt: Number(r['removed_at']), ...(r['purged_at'] ? { purgedAt: Number(r['purged_at']) } : {}) }
  }

  // A new person reads from now on: nothing from before is unread for them.
  addPerson(p: Person): void {
    this.db.prepare('INSERT INTO people (id, name, role, about, created_at, named) VALUES (?, ?, ?, ?, ?, 1)').run(p.id, p.name, p.role, p.about, Date.now())
  }

  // A removed person back (re-invited): their DMs and memories are still theirs. One whose data
  // was purged can't come back as themselves (the caller refuses it); the sweep counts from a new removal.
  // Their DM routines come back on or off as they were (the caller schedules the ones on); returns those.
  restorePerson(id: string, patch: { name: string; role: Exclude<Role, 'owner'>; about: string }): string[] {
    this.db.prepare('UPDATE people SET removed_at = NULL, purged_at = NULL, name = ?, role = ?, about = ? WHERE id = ? AND purged_at IS NULL').run(patch.name, patch.role, patch.about, id)
    const on = (this.db.prepare('SELECT id FROM routines WHERE owner = ? AND held = 1').all(id) as Row[]).map((r) => str(r['id']))
    this.db.prepare('UPDATE routines SET enabled = COALESCE(held, enabled), held = NULL WHERE owner = ? AND held IS NOT NULL').run(id)
    return on
  }

  // `named`: they said it themselves (filling in the owner's from the settings isn't that).
  renamePerson(id: string, name: string, named = true): void {
    this.db.prepare(`UPDATE people SET name = ?${named ? ', named = 1' : ''} WHERE id = ?`).run(name, id)
  }

  // Their access ends: keys go now; what they own is handed over by the caller.
  removePerson(id: string): void {
    this.tx(() => {
      this.db.prepare("UPDATE people SET removed_at = ? WHERE id = ? AND role <> 'owner'").run(Date.now(), id)
      // Only the hashes stay, to tell their browsers "you no longer have access" instead of counting a guess.
      this.db.prepare('INSERT OR IGNORE INTO removed_keys (hash, person_id, removed_at) SELECT hash, person_id, ? FROM person_keys WHERE person_id = ?').run(Date.now(), id)
      this.db.prepare('DELETE FROM person_keys WHERE person_id = ?').run(id)
    })
  }

  // Keys are kept only as their hash.
  addPersonKey(hash: string, personId: string, label?: string): void {
    this.db.prepare('INSERT INTO person_keys (hash, person_id, label, created_at) VALUES (?, ?, ?, ?)').run(hash, personId, label ?? null, Date.now())
  }

  // A person's own keys, newest first: what each device said it is, and when it was last seen.
  personKeys(personId: string): { hash: string; label: string; createdAt: number; seenAt?: number }[] {
    return (this.db.prepare('SELECT hash, label, created_at, last_seen FROM person_keys WHERE person_id = ? ORDER BY created_at DESC').all(personId) as Row[]).map((r) => ({
      hash: str(r['hash']),
      label: str(r['label']),
      createdAt: Number(r['created_at']),
      ...(r['last_seen'] ? { seenAt: Number(r['last_seen']) } : {})
    }))
  }

  // A device's push handle (a phone's), or none. False: no such key of this person's.
  setKeyPush(personId: string, hash: string, push: { handle: string; tag?: string } | null): boolean {
    return this.db.prepare('UPDATE person_keys SET push = ? WHERE hash = ? AND person_id = ?').run(push ? JSON.stringify(push) : null, hash, personId).changes > 0
  }

  // The phones that take pushes: of these people (unset: everyone still here).
  pushTargets(people?: string[]): { hash: string; personId: string; handle: string; tag?: string }[] {
    const rows = this.db.prepare('SELECT k.hash, k.person_id, k.push FROM person_keys k JOIN people p ON p.id = k.person_id WHERE k.push IS NOT NULL AND p.removed_at IS NULL').all() as Row[]
    const out: { hash: string; personId: string; handle: string; tag?: string }[] = []
    for (const r of rows) {
      if (people && !people.includes(str(r['person_id']))) continue
      try {
        const p = JSON.parse(str(r['push'])) as { handle?: unknown; tag?: unknown }
        if (typeof p.handle === 'string') out.push({ hash: str(r['hash']), personId: str(r['person_id']), handle: p.handle, ...(typeof p.tag === 'string' ? { tag: p.tag } : {}) })
      } catch {
        // a broken one is skipped
      }
    }
    return out
  }

  dropKeyPush(hash: string): void {
    this.db.prepare('UPDATE person_keys SET push = NULL WHERE hash = ?').run(hash)
  }

  // One of a person's keys goes; its browser reads "no access" (removed_keys) instead of counting a guess.
  removePersonKey(personId: string, hash: string): boolean {
    return this.tx(() => {
      if (!this.db.prepare('SELECT 1 FROM person_keys WHERE hash = ? AND person_id = ?').get(hash, personId)) return false
      this.db.prepare('INSERT OR IGNORE INTO removed_keys (hash, person_id, removed_at) SELECT hash, person_id, ? FROM person_keys WHERE hash = ?').run(Date.now(), hash)
      this.db.prepare('DELETE FROM person_keys WHERE hash = ?').run(hash)
      return true
    })
  }

  // The person a key opens, if they still have access; seen now.
  removedKey(hash: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM removed_keys WHERE hash = ?').get(hash)
  }

  personByKey(hash: string): Person | undefined {
    const r = this.db.prepare('SELECT p.* FROM person_keys k JOIN people p ON p.id = k.person_id WHERE k.hash = ? AND p.removed_at IS NULL').get(hash) as Row | undefined
    if (r) this.db.prepare('UPDATE person_keys SET last_seen = ? WHERE hash = ?').run(Date.now(), hash)
    return r && this.toPerson(r)
  }

  // ---------- invites ----------

  private toInvite(r: Row): Invite {
    return {
      id: str(r['hash']),
      role: str(r['role']) as Invite['role'],
      about: str(r['about']),
      ...(r['restore'] ? { restore: str(r['restore']) } : {}),
      createdBy: str(r['created_by']),
      createdAt: Number(r['created_at']),
      expiresAt: Number(r['expires_at']),
      ...(r['used_at'] ? { usedAt: Number(r['used_at']), usedBy: str(r['used_by']) } : {})
    }
  }

  saveInvite(i: Omit<Invite, 'usedAt' | 'usedBy'>): void {
    this.db
      .prepare('INSERT INTO invites (hash, role, about, restore, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(i.id, i.role, i.about, i.restore ?? null, i.createdBy, i.createdAt, i.expiresAt)
  }

  invites(): Invite[] {
    return (this.db.prepare('SELECT * FROM invites ORDER BY created_at DESC').all() as Row[]).map((r) => this.toInvite(r))
  }

  invite(hash: string): Invite | undefined {
    const r = this.db.prepare('SELECT * FROM invites WHERE hash = ?').get(hash) as Row | undefined
    return r && this.toInvite(r)
  }

  // Single use: true for the one that took it, while it was still good.
  useInvite(hash: string, personId: string, now = Date.now()): boolean {
    const r = this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE hash = ? AND used_at IS NULL AND expires_at > ?').run(now, personId, hash, now)
    return Number(r.changes) === 1
  }

  removeInvite(hash: string): void {
    this.db.prepare('DELETE FROM invites WHERE hash = ?').run(hash)
  }

  // ---------- delegation, removal ----------

  setAbout(id: string, about: string): void {
    this.db.prepare('UPDATE people SET about = ? WHERE id = ?').run(about, id)
  }

  setRole(id: string, role: Exclude<Role, 'owner'>): void {
    this.db.prepare("UPDATE people SET role = ? WHERE id = ? AND role <> 'owner'").run(role, id)
  }

  // Someone answering and approving for this person until then; none ends it.
  setDelegation(personId: string, to?: string, until?: number): void {
    this.db.prepare('UPDATE people SET delegate_to = ?, delegate_until = ? WHERE id = ?').run(to ?? null, to && until ? until : null, personId)
  }

  // What a removed person owned of the team's goes to the Tucano owner: their agents, and their
  // routines outside their DMs. The ones in their DMs are theirs, kept with the DMs: off while
  // they're away (no one else reads there), as they were if they come back. Returns what changed.
  handOver(personId: string): { agents: string[]; routines: string[] } {
    return this.tx(() => {
      const owner = this.ownerId()
      const agents = (this.db.prepare('SELECT id FROM agents WHERE owner = ?').all(personId) as Row[]).map((r) => str(r['id']))
      this.db.prepare('UPDATE agents SET owner = ? WHERE owner = ?').run(owner, personId)
      const inDms = "conversation_id IN (SELECT id FROM conversations WHERE kind = 'dm' AND owner = ?)"
      this.db.prepare(`UPDATE routines SET held = enabled, enabled = 0, next_at = NULL WHERE owner = ? AND ${inDms}`).run(personId, personId)
      const routines = (this.db.prepare(`SELECT id FROM routines WHERE owner = ? AND NOT ${inDms}`).all(personId, personId) as Row[]).map((r) => str(r['id']))
      this.db.prepare(`UPDATE routines SET owner = ? WHERE owner = ? AND NOT ${inDms}`).run(owner, personId, personId)
      this.db.prepare('DELETE FROM routine_watchers WHERE person_id = ?').run(personId)
      this.db.prepare('UPDATE people SET delegate_to = NULL, delegate_until = NULL WHERE delegate_to = ?').run(personId)
      return { agents, routines }
    })
  }

  // The people removed before `before` whose DMs and memories are still kept.
  purgeable(before: number): string[] {
    return (this.db.prepare('SELECT id FROM people WHERE removed_at IS NOT NULL AND removed_at < ? AND purged_at IS NULL').all(before) as Row[]).map((r) => str(r['id']))
  }

  // A removed person's DMs (with everything in them: messages, files, routines, approvals, questions,
  // services, notes made there) and what's theirs alone (memories, unread, preferences, invites that
  // would bring them back) go for good; their name stays, for what they said in channels and the
  // team's log. Returns the DMs deleted, their routines, and the files (artifacts) to delete from disk.
  purgePerson(personId: string, now = Date.now()): { dms: string[]; routines: { id: string; conversationId: string }[]; artifacts: { id: string; name: string }[] } {
    return this.tx(() => {
      const dms = (this.db.prepare("SELECT id FROM conversations WHERE kind = 'dm' AND owner = ?").all(personId) as Row[]).map((r) => str(r['id']))
      const inDms = `(${dms.map(() => '?').join(', ') || "''"})`
      const artifacts = (this.db.prepare(`SELECT id, name FROM artifacts WHERE conversation_id IN ${inDms}`).all(...dms) as Row[]).map((r) => ({ id: str(r['id']), name: str(r['name']) }))
      const routines = (this.db.prepare(`SELECT id, conversation_id FROM routines WHERE conversation_id IN ${inDms}`).all(...dms) as Row[]).map((r) => ({ id: str(r['id']), conversationId: str(r['conversation_id']) }))
      this.db.prepare(`DELETE FROM artifacts WHERE conversation_id IN ${inDms}`).run(...dms)
      this.db.prepare(`DELETE FROM routines WHERE conversation_id IN ${inDms}`).run(...dms)
      this.db.prepare(`DELETE FROM approvals WHERE conversation_id IN ${inDms}`).run(...dms)
      this.db.prepare(`DELETE FROM services WHERE conversation_id IN ${inDms}`).run(...dms)
      this.db.prepare(`DELETE FROM memories WHERE scope = ? OR private_to = ? OR conversation_id IN ${inDms}`).run(`person:${personId}`, personId, ...dms)
      for (const id of dms) this.deleteConversation(id) // messages, members, questions, read state go with it
      this.db.prepare('DELETE FROM read_state WHERE person_id = ?').run(personId)
      this.db.prepare('DELETE FROM unread WHERE person_id = ?').run(personId)
      this.db.prepare('DELETE FROM routine_watchers WHERE person_id = ?').run(personId)
      this.db.prepare('DELETE FROM invites WHERE restore = ? AND used_at IS NULL').run(personId)
      this.db.prepare("UPDATE people SET purged_at = ?, prefs = '{}', about = '', delegate_to = NULL, delegate_until = NULL WHERE id = ? AND removed_at IS NOT NULL").run(now, personId)
      return { dms, routines, artifacts }
    })
  }

  // What was deleted leaves the files too: the pages that held it are rebuilt and the write-ahead
  // log emptied (a purge's deletes would otherwise linger on disk until overwritten). Rare: a purge.
  scrub(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);')
  }

  // ---------- questions ----------

  private toQuestion(r: Row): Question {
    return {
      id: str(r['id']),
      conversationId: str(r['conversation_id']),
      ...(r['thread_id'] ? { threadId: str(r['thread_id']) } : {}),
      agentId: str(r['agent_id']),
      text: str(r['text']),
      askedTo: str(r['asked_to']),
      requestedBy: str(r['requested_by']),
      ...(r['confirm_state'] ? { confirm: str(r['confirm_state']) as Question['confirm'] } : {}),
      state: str(r['state']) as Question['state'],
      deadlineAt: Number(r['deadline_at']),
      ...(r['told_at'] ? { toldAt: Number(r['told_at']) } : {}),
      ...(r['answered_by'] ? { answeredBy: str(r['answered_by']) } : {}),
      ...(r['answered_at'] ? { answeredAt: Number(r['answered_at']) } : {}),
      createdAt: Number(r['created_at'])
    }
  }

  saveQuestion(q: Question): void {
    this.db
      .prepare(
        `INSERT INTO questions (id, conversation_id, thread_id, agent_id, text, asked_to, requested_by, confirm_state, state, deadline_at, told_at, answered_by, answered_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET confirm_state = excluded.confirm_state, state = excluded.state, deadline_at = excluded.deadline_at, told_at = excluded.told_at, answered_by = excluded.answered_by, answered_at = excluded.answered_at`
      )
      .run(q.id, q.conversationId, q.threadId ?? null, q.agentId, q.text, q.askedTo, q.requestedBy, q.confirm ?? null, q.state, q.deadlineAt, q.toldAt ?? null, q.answeredBy ?? null, q.answeredAt ?? null, q.createdAt)
  }

  question(id: string): Question | undefined {
    const r = this.db.prepare('SELECT * FROM questions WHERE id = ?').get(id) as Row | undefined
    return r && this.toQuestion(r)
  }

  // Answered since `since`, newest first.
  answeredQuestions(since: number): Question[] {
    return (this.db.prepare("SELECT * FROM questions WHERE state = 'answered' AND answered_at >= ? ORDER BY answered_at DESC").all(since) as Row[]).map((r) => this.toQuestion(r))
  }

  openQuestions(): Question[] {
    return (this.db.prepare("SELECT * FROM questions WHERE state = 'open' ORDER BY created_at").all() as Row[]).map((r) => this.toQuestion(r))
  }

  // ---------- activity ----------

  addActivity(e: Omit<ActivityEntry, 'id' | 'at'> & { at?: number }): ActivityEntry {
    const entry: ActivityEntry = { id: randomUUID(), at: e.at ?? Date.now(), ...(e.personId ? { personId: e.personId } : {}), kind: e.kind, ...(e.target ? { target: e.target } : {}), ...(e.detail ? { detail: e.detail } : {}) }
    this.db.prepare('INSERT INTO activity (id, at, person_id, kind, target, detail) VALUES (?, ?, ?, ?, ?, ?)').run(entry.id, entry.at, entry.personId ?? null, entry.kind, entry.target ?? null, entry.detail ? JSON.stringify(entry.detail) : null)
    return entry
  }

  // Newest first, a page at a time: `before` is the last page's oldest time. `kind` matches a
  // whole kind ('approval.decided') or a family ('approval').
  activity(f: { personId?: string; kind?: string; before?: number; limit?: number } = {}): ActivityEntry[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (f.personId) where.push('person_id = ?'), args.push(f.personId)
    if (f.kind) where.push('(kind = ? OR kind LIKE ?)'), args.push(f.kind, `${f.kind}.%`)
    if (f.before !== undefined) where.push('at < ?'), args.push(f.before)
    const limit = Math.min(Math.max(1, Math.floor(f.limit ?? 50)), 200)
    const rows = this.db.prepare(`SELECT * FROM activity${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, rowid DESC LIMIT ${limit}`).all(...args) as Row[]
    return rows.map((r) => ({
      id: str(r['id']),
      at: Number(r['at']),
      ...(r['person_id'] ? { personId: str(r['person_id']) } : {}),
      kind: str(r['kind']),
      ...(r['target'] ? { target: str(r['target']) } : {}),
      ...(r['detail'] ? { detail: JSON.parse(str(r['detail'])) as Record<string, unknown> } : {})
    }))
  }
}
