// Stands in for the Codex CLI: `codex app-server` speaking its JSON-RPC over stdio (the method and
// event names of Codex 0.153), and `codex exec --json` for the fallback. A reply says which process,
// which thread, which of the thread's turns it was, and whether the thread was resumed into this
// process. "demore" in the message: it takes 5 s before answering, unless interrupted. A thread
// not ephemeral is written to CODEX_HOME/sessions as Codex does, and thread/delete takes it away.
// FAKE_CODEX_OLD=1: a CLI with no app-server. FAKE_CODEX_LOG: every request goes there, one per line.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const log = (entry) => process.env.FAKE_CODEX_LOG && appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`)
const home = process.env.CODEX_HOME ?? join(process.env.HOME ?? '.', '.codex')
const day = join(home, 'sessions', '2026', '11', '06')
const fileOf = (id) => join(day, `rollout-2026-11-06T10-00-00-${id}.jsonl`)
const find = (id) => (existsSync(day) ? readdirSync(day).find((f) => f.endsWith(`-${id}.jsonl`)) : undefined)

if (process.argv[2] === 'exec') {
  log({ exec: process.argv.slice(2) })
  let input = ''
  process.stdin.on('data', (d) => (input += d))
  process.stdin.on('end', () => {
    out({ type: 'thread.started', thread_id: 'x' })
    out({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: `exec pid=${process.pid}` } })
    out({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } })
  })
} else if (process.argv[2] === 'app-server') {
  if (process.env.FAKE_CODEX_OLD) {
    process.stderr.write("error: unrecognized subcommand 'app-server'\n")
    process.exit(2)
  }
  log({ argv: process.argv.slice(2) })
  const threads = new Map() // id → { turns, resumed, running }
  createInterface({ input: process.stdin }).on('line', async (line) => {
    const m = JSON.parse(line)
    if (m.method) log({ method: m.method, params: m.params })
    const reply = (result) => out({ id: m.id, result })
    const fail = (message, code = -32600) => out({ id: m.id, error: { code, message } })
    switch (m.method) {
      case 'initialize':
        return reply({ userAgent: 'fake', codexHome: home, platformFamily: 'unix', platformOs: 'macos' })
      case 'initialized':
        return
      case 'account/rateLimits/read':
        return reply({ rateLimits: { limitId: 'codex', primary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 1794567151 }, secondary: null, planType: 'plus' } })
      case 'thread/start': {
        const id = randomUUID()
        threads.set(id, { turns: 0, resumed: false })
        if (!m.params.ephemeral) {
          mkdirSync(day, { recursive: true })
          writeFileSync(fileOf(id), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: m.params.cwd } })}\n`)
        }
        return reply({ thread: { id, path: m.params.ephemeral ? null : fileOf(id), ephemeral: !!m.params.ephemeral }, model: m.params.model, cwd: m.params.cwd, instructionSources: [], approvalPolicy: 'never', sandbox: { type: 'readOnly' } })
      }
      case 'thread/resume': {
        if (!find(m.params.threadId)) return fail(`no rollout found for thread id ${m.params.threadId}`)
        threads.set(m.params.threadId, { turns: 0, resumed: true })
        return reply({ thread: { id: m.params.threadId } })
      }
      case 'thread/unsubscribe':
        threads.delete(m.params.threadId)
        return reply({ status: 'unsubscribed' })
      case 'thread/delete': {
        const f = find(m.params.threadId)
        if (!f) return fail(`no rollout found for thread id ${m.params.threadId}`)
        rmSync(join(day, f))
        return reply({})
      }
      case 'turn/interrupt': {
        const t = threads.get(m.params.threadId)
        if (t?.running) {
          clearTimeout(t.running.timer)
          t.running.end('interrupted')
        }
        return reply({})
      }
      case 'turn/start': {
        const threadId = m.params.threadId
        const t = threads.get(threadId)
        if (!t) return fail(`thread not loaded: ${threadId}`)
        const turnId = randomUUID()
        t.turns++
        reply({ turn: { id: turnId, items: [], status: 'inProgress' } })
        const text = m.params.input.map((i) => i.text ?? '').join('\n')
        const words = `pid=${process.pid} thread=${threadId} turn=${t.turns} resumed=${t.resumed}`
        const say = (method, params) => out({ method, params: { threadId, turnId, ...params } })
        say('turn/started', { turn: { id: turnId, status: 'inProgress' } })
        const end = (status) => {
          t.running = undefined
          out({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status, items: [], error: null } } })
        }
        const answer = () => {
          say('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 100 * t.turns, cachedInputTokens: 50 * t.turns, outputTokens: 5 * t.turns }, last: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 5 } } })
          say('item/agentMessage/delta', { itemId: 'm1', delta: words.slice(0, 6) })
          say('item/agentMessage/delta', { itemId: 'm1', delta: words.slice(6) })
          say('item/completed', { item: { type: 'agentMessage', id: 'm1', text: words } })
          end('completed')
        }
        t.running = { end, timer: setTimeout(answer, /demore/.test(text) ? 5000 : 10) }
        return
      }
      default:
        if (m.id !== undefined) fail(`unknown method ${m.method}`, -32601)
    }
  })
}
