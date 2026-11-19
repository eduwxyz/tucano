// What starting Claude Code while the person types saves, through the real CLI (Haiku, the
// person's own login):
//   router    how long the router takes to pick who answers in a channel, started cold or while typing
//   DM        a reply after the agent's kept process closed (five minutes idle), started cold or while typing
// "While typing" means 3 s before the message is sent. Spends a little of the plan.
//   npx -y tsx scripts/bench-warm-start.ts [rounds, default 4]
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
import { route, routerTurn } from '../src/core/router'
import { Runner } from '../src/core/runs'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'

const rounds = Number(process.argv[2] ?? 4)
const bin = process.env['CLAUDE_BIN'] || (await detectClaude()).path
if (!bin) throw new Error('Claude Code not found')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
const s = (ms: number): string => `${(ms / 1000).toFixed(2)} s`
const agent = (id: string, name: string, role: string, instructions: string): Agent => ({ id, name, handle: id, role, color: 'sky', instructions, modelId: 'haiku', effort: 'low', limit: 100_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
const lia = agent('lia', 'Lia', 'Dados', 'Você é a Lia, de engenharia de dados. Responda em uma frase curta.')
const theo = agent('theo', 'Theo', 'Engenharia', 'Você é o Theo, de engenharia de software. Responda em uma frase curta.')

// ---------- router ----------
const work = join(tmpdir(), 'bench-warm')
const routerDir = join(work, '_router')
mkdirSync(routerDir, { recursive: true })
const engine = claudeEngine(() => bin)
const ask = (i: number): Message[] => [{ id: randomUUID(), conversationId: 'c', author: { kind: 'me' }, text: `A tabela vendas_diarias veio com ${1000 + i} linhas, o dobro de ontem. Alguém olha?`, at: Date.now() }]
const routerMs: Record<'cold' | 'typing', number[]> = { cold: [], typing: [] }
for (let i = 0; i < rounds; i++) {
  for (const way of ['cold', 'typing'] as const) {
    if (way === 'typing') {
      engine.warm!(routerTurn('haiku', routerDir))
      await wait(3000)
    }
    const r = await route({ engine, model: 'haiku', messages: ask(i), agents: [lia, theo], me: 'Gabriel', cwd: routerDir })
    if ('error' in r) throw new Error(`router: ${r.error}`)
    routerMs[way].push(r.ms)
    await wait(1000)
  }
}

// ---------- DM after the kept process closed ----------
const ready = { installed: true, loggedIn: true }
const settings = { workspaceName: 'Gabriel', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' } as Settings
const db = new Db(join(mkdtempSync(join(tmpdir(), 'bench-db-')), 'bench.db'))
db.saveAgent(lia)
db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
const dmEngine = claudeEngine(() => bin)
const engines: Record<EngineId, Engine> = { claude: dmEngine, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor') }
const gateway = new Gateway()
await gateway.start()
let firstAt = 0
const runner = new Runner({ db, engines, settings: async () => settings, emit: (e: CoreEvent) => void (e.type === 'delta' && !firstAt && (firstAt = Date.now())), workDir: work, gateway })
const say = async (text: string): Promise<number> => {
  firstAt = 0
  const sent = Date.now()
  await runner.send('dm', text)
  await runner.idle()
  const reply = db.messages().filter((m) => m.author.kind === 'agent').at(-1)!
  if (reply.run?.status !== 'done') throw new Error(`DM: ${reply.run?.status} ${reply.run?.error ?? ''}`)
  return firstAt - sent
}
await say('Oi Lia, tudo certo com o job de hoje?')
const dmMs: Record<'cold' | 'typing', number[]> = { cold: [], typing: [] }
for (let i = 0; i < rounds; i++) {
  for (const way of ['cold', 'typing'] as const) {
    dmEngine.dispose!() // its five minutes are over: the process closed
    await wait(1000)
    if (way === 'typing') {
      await runner.typing('dm')
      await wait(3000)
    }
    dmMs[way].push(await say(`E o job das ${10 + i}h, passou?`))
  }
}
dmEngine.dispose!()
engine.dispose!()
await gateway.stop()

console.log('| | cold | started while typing |')
console.log('|---|---|---|')
console.log(`| router picks who answers (median) | ${s(median(routerMs.cold))} | ${s(median(routerMs.typing))} |`)
console.log(`| DM reply's first token after the process closed (median) | ${s(median(dmMs.cold))} | ${s(median(dmMs.typing))} |`)
console.log(`\nrouter cold ${routerMs.cold.map(s).join(', ')} · typing ${routerMs.typing.map(s).join(', ')}`)
console.log(`DM cold ${dmMs.cold.map(s).join(', ')} · typing ${dmMs.typing.map(s).join(', ')}`)
process.exit(0)
