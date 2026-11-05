// How fast, and how much from the prompt cache, the next replies in a DM come, through the real
// runner and the real Claude Code (Haiku, low effort, the person's own login), three ways:
//   today      a new `claude -p` per reply, with the whole conversation again
//   resumed    the session kept, resumed from disk in a new process per reply
//   kept open  the session kept, and its process open between replies
// The DM starts with `history` messages (20: about 16k tokens). With more than 30 the window slides
// at every reply (the oldest message leaves), as it does after a summary is rewritten or with a task
// block at the end: today's way then writes the whole history to the cache again. Spends a little
// of the plan.
//   npx -y tsx scripts/bench-kept-session.ts [replies per way, default 4] [history, default 20]
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Db } from '../src/core/db'
import { claudeEngine } from '../src/core/engines/claude'
import { detectClaude } from '../src/core/engines/detect'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Settings } from '../src/shared/types'

const replies = Number(process.argv[2] ?? 4)
const seeded = Number(process.argv[3] ?? 20)
const bin = process.env['CLAUDE_BIN'] || (await detectClaude()).path
if (!bin) throw new Error('Claude Code not found')
const ready = { installed: true, loggedIn: true }
const settings = { workspaceName: 'Gabriel', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as Settings
const lia: Agent = { id: 'lia', name: 'Lia', handle: 'lia', role: 'Dados', color: 'sky', instructions: 'Você é a Lia, de engenharia de dados. Responda em uma frase curta.', modelId: 'haiku', effort: 'low', limit: 100_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const line = (i: number): string => `Mensagem ${i}: a tabela vendas_diarias teve ${1000 + i} linhas hoje, e o job de ingestão rodou em ${30 + i} segundos sem erro. ${'Detalhe do log do job, linha repetida para ocupar espaço. '.repeat(25)}`

type Row = { way: string; reply: number; firstMs: number; totalMs: number; input: number; cacheRead: number }

async function measure(way: string, sessions: boolean, between?: (engine: Engine) => void): Promise<Row[]> {
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'bench-db-')), 'bench.db'))
  db.saveAgent(lia)
  db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
  const t0 = Date.now() - seeded * 60_000 - 60_000
  for (let i = 0; i < seeded; i++) db.saveMessage({ id: randomUUID(), conversationId: 'dm', author: i % 2 ? { kind: 'agent', id: 'lia' } : { kind: 'me' }, text: line(i), at: t0 + i * 60_000 })

  const real = claudeEngine(() => bin)
  const claude: Engine = sessions ? real : { id: 'claude', run: (t) => real.run(t) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), cursor: fakeEngine('cursor') }
  const gateway = new Gateway()
  await gateway.start()
  const workDir = join(tmpdir(), 'bench-work')
  mkdirSync(workDir, { recursive: true })
  let firstAt = 0
  const runner = new Runner({ db, engines, settings: async () => settings, emit: (e: CoreEvent) => void (e.type === 'delta' && !firstAt && (firstAt = Date.now())), workDir, gateway })

  const rows: Row[] = []
  for (let n = 0; n <= replies; n++) {
    if (n > 0) between?.(real)
    firstAt = 0
    const sent = Date.now()
    await runner.send('dm', n === 0 ? 'Oi Lia, me resume o que rolou com o job hoje.' : `E agora, mensagem nova ${n}: o job das ${10 + n}h também passou?`)
    await runner.idle()
    const reply = db.messages().filter((m) => m.author.kind === 'agent').at(-1)!
    const r = reply.run?.receipt
    if (reply.run?.status !== 'done' || !r) throw new Error(`${way}: reply ${n} ${reply.run?.status}: ${reply.run?.error ?? ''}`)
    rows.push({ way, reply: n, firstMs: firstAt - sent, totalMs: r.ms, input: r.inputTokens, cacheRead: r.cacheReadTokens })
  }
  real.dispose?.()
  await gateway.stop()
  return rows
}

const all = [
  ...(await measure('today', false)),
  ...(await measure('resumed', true, (e) => e.dispose?.())), // each next reply finds no process open
  ...(await measure('kept open', true))
]
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
console.log('| way | reply | first token | total | input | from cache | not from cache |')
console.log('|---|---|---|---|---|---|---|')
for (const r of all) console.log(`| ${r.way} | ${r.reply === 0 ? 'first' : r.reply} | ${(r.firstMs / 1000).toFixed(2)} s | ${(r.totalMs / 1000).toFixed(2)} s | ${r.input} | ${r.cacheRead} | ${r.input - r.cacheRead} |`)
console.log('\nMedians of the next replies (not the first):')
for (const way of ['today', 'resumed', 'kept open']) {
  const next = all.filter((r) => r.way === way && r.reply > 0)
  console.log(`- ${way}: first token ${(median(next.map((r) => r.firstMs)) / 1000).toFixed(2)} s, total ${(median(next.map((r) => r.totalMs)) / 1000).toFixed(2)} s, from cache ${median(next.map((r) => r.cacheRead))}, not from cache ${median(next.map((r) => r.input - r.cacheRead))}`)
}
process.exit(0)
