// Shapes a seeded workspace like Apo's: a team of 17 with no monthly limit, and two of them keeping
// a ceiling (at 90% and 100%) so a frame can show the dots still come when there is one.
// `used` is read from receipts, so the usage is written there.
// node scripts/seed-no-limit.mjs <data-dir>   (after the app was opened once with TUCANO_SEED=1)
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) throw new Error('usage: node scripts/seed-no-limit.mjs <data-dir>')
const db = new DatabaseSync(join(dir, 'tucano.db'))

const COLORS = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']
const NAMES = ['Lia', 'Theo', 'Nina', 'Rafa', 'Otto', 'Vera', 'Caio', 'Iris', 'Dora', 'Bento', 'Lena', 'Iago', 'Sara', 'Tomas', 'Maya', 'Enzo', 'Clara']
const now = Date.now()

// The seeded team first, then enough more agents for the sidebar to have a full team.
const existing = db.prepare('SELECT id, name FROM agents ORDER BY created_at').all()
const have = new Set(existing.map((a) => a.name))
const insert = db.prepare('INSERT INTO agents (id, name, handle, role, color, instructions, model, effort, limit_tokens, grants, archived, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
for (const [i, name] of NAMES.entries()) {
  if (have.has(name)) continue
  insert.run(randomUUID(), name, name.toLowerCase(), '', COLORS[i % COLORS.length], '', 'sonnet', 'low', 0, '{}', 0, now - 1000 + i)
}
const agents = db.prepare('SELECT id, name, limit_tokens FROM agents ORDER BY created_at').all()

const at = now - 24 * 3_600_000 // inside the month
const receipt = db.prepare('INSERT INTO receipts (message_id, agent_id, engine, model, input_tokens, cache_read_tokens, output_tokens, ms, api_cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
const setLimit = db.prepare('UPDATE agents SET limit_tokens = ? WHERE id = ?')

// Two keep a ceiling, one just under the warning and one spent, so the dots are still shown to work.
const kept = agents.filter((a) => a.name === 'Lia' || a.name === 'Theo')
const spent = new Map()
for (const [i, a] of kept.entries()) {
  setLimit.run(1_000_000, a.id)
  spent.set(a.id, i === 0 ? 900_000 : 1_000_000)
}
for (const a of agents) {
  if (!spent.has(a.id)) {
    setLimit.run(0, a.id)
    spent.set(a.id, 5_000_000)
  }
  receipt.run(`seed-${a.id}`, a.id, 'claude', 'sonnet', spent.get(a.id), 0, 0, 1000, null, at)
}
// A DM with an agent that has no limit, holding a reply that stopped on the month's limit: the two
// buttons under it (Try again / Raise the limit) are what the third frame is about.
const nina = agents.find((a) => a.name === 'Nina')
let dm = db.prepare("SELECT id FROM conversations WHERE kind = 'dm' AND name = ?").get(nina.id)
if (!dm) {
  dm = { id: randomUUID() }
  db.prepare('INSERT INTO conversations (id, kind, name, topic, created_at) VALUES (?, ?, ?, ?, ?)').run(dm.id, 'dm', nina.id, null, now)
  db.prepare('INSERT INTO members (conversation_id, agent_id) VALUES (?, ?)').run(dm.id, nina.id)
}
const said = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(dm.id).n
if (!said) {
  db.prepare('INSERT INTO messages (id, conversation_id, author_kind, author_id, text, at, run) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    randomUUID(), dm.id, 'agent', nina.id, 'Stopped here: the month ran out.', now - 3_600_000,
    JSON.stringify({ status: 'limit_reached', steps: [] })
  )
}
console.log(JSON.stringify({ agents: agents.length, kept: kept.map((a) => a.name), dm: dm.id }, null, 2))
db.close()
