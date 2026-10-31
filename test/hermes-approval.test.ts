// A sensitive call from an agent running on the real Hermes CLI. The app's tool
// layer has to turn it into a pending approval instead of running it, the way it
// does for every other harness — the last thing the review asked for. Only the
// model is fake: the CLI, its gateway daemon, the app's gateway and the approval
// path are the real ones.
//
// Opt-in and slow (spawns the CLI, warms a fresh root, boots its daemon):
//   TUCANO_HERMES_E2E=1 npx vitest run test/hermes-approval.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConnectorManager } from '../src/core/connectors'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import { hermesEngine } from '../src/core/engines/hermes'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { plainCipher, Secrets } from '../src/core/secrets'
import { setLang } from '../src/shared/lang'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, Message, Settings } from '../src/shared/types'
import { fakeModel, hermesBin, hermesE2e, stopDaemon, textOf } from './fixtures/hermes-cli'

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }
const bin = hermesBin()
const enabled = hermesE2e()

describe.skipIf(!enabled)('a Hermes agent asking for a sensitive tool', () => {
  it('becomes a pending approval in the app instead of running', async () => {
    setLang('en') // the app's own messages, asserted in its English side

    const dir = mkdtempSync(join(tmpdir(), 'tucano-hermes-appr-'))
    const root = join(dir, 'hermes') // the root the engine owns
    const userHome = join(dir, 'user') // the person's own Hermes config
    const tasksFile = join(dir, 'tasks.json')
    mkdirSync(root, { recursive: true })
    mkdirSync(userHome, { recursive: true })

    // The model asks for the connector's delete tool — a sensitive one — with the
    // reason the app shows, and then reports whatever the app answered.
    const model = await fakeModel(({ messages, tools }) => {
      const results = messages.filter((m) => m.role === 'tool')
      if (results.length) {
        return { message: { role: 'assistant', content: `saw: ${textOf(results[results.length - 1]!.content)}` }, finish: 'stop' as const }
      }
      const asked = tools.map((t) => t.function?.name ?? '').find((n) => n.endsWith('__delete_task'))
      const args = JSON.stringify({ id: 2, _motivo: 'it is duplicated' })
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: asked, arguments: args } }] }, finish: 'tool_calls' as const }
    })
    writeFileSync(join(userHome, 'config.yaml'), `providers:\n  probe:\n    base_url: ${model.url}\n    api_mode: chat_completions\n    api_key_env: PROBE_KEY\nmodel:\n  provider: probe\n`)

    const db = new Db(join(dir, 'test.db'))
    const events: CoreEvent[] = []
    const gateway = new Gateway()
    await gateway.start()
    const connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: (e) => events.push(e), openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
    const connectorId = await connectors.add({ kind: 'stdio', name: 'Tasks', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasksFile } })
    await connectors.connect(connectorId)

    const settings: Settings = {
      workspaceName: 'Marina', context: '',
      engines: { claude: ready, codex: ready, opencode: ready, pi: ready, gemini: ready, hermes: ready },
      routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000,
      approvalTtlHours: 24, theme: 'system', language: 'en'
    }
    // The agent runs on Hermes, and may read and write the Tasks connector.
    const agent: Agent = {
      id: 'a1', name: 'Iris', handle: 'iris', role: '', color: 'sky', instructions: '', modelId: 'hermes:probe/probe-model',
      effort: 'low', limit: 1_000_000, used: 0, grants: { [connectorId]: 'read_write' }, memory: 'auto', computer: false, archived: false
    }
    db.saveAgent(agent)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })

    // Every piece here is the app's: the real engine, the real gateway, the real
    // tool layer with its approvals.
    const runner = new Runner({
      db,
      engines: { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), gemini: fakeEngine('gemini'), hermes: hermesEngine(() => bin, root) },
      settings: async () => settings,
      emit: (e) => events.push(e),
      workDir: join(dir, 'work'),
      gateway,
      connectors
    })

    const previous = process.env['HERMES_HOME']
    process.env['HERMES_HOME'] = userHome
    try {
      await runner.send('d1', 'delete task 2')
      await runner.idle()

      // The call reached the app's tool layer and became a request, not an action.
      const [ap] = db.approvals()
      expect(ap).toMatchObject({ state: 'pending', tool: 'delete_task', args: { id: 2 }, why: 'it is duplicated', connectorName: 'Tasks' })
      // And the app shows it: the message is parked on that approval, and the
      // app emitted the event its screens listen to.
      const message = db.messages().filter((m) => m.author.kind === 'agent')[0] as Message | undefined
      expect(message?.run).toMatchObject({ status: 'waiting_approval', approvalId: ap!.id })
      expect(events.some((e) => e.type === 'approval')).toBe(true)
      // The Hermes agent got the app's answer back, not the tool's output.
      const last = model.requests().at(-1)!.messages.filter((m) => m.role === 'tool').at(-1)
      expect(textOf(last?.content)).toContain('has NOT run yet')
      // Nothing ran: the task is still there.
      const tasks = existsSync(tasksFile) ? (JSON.parse(readFileSync(tasksFile, 'utf8')) as { id: number }[]) : []
      expect(tasks.some((t) => t.id === 2) || tasks.length === 0).toBe(true)
    } finally {
      process.env['HERMES_HOME'] = previous
      await stopDaemon(bin!, root)
      await connectors.closeAll()
      await gateway.stop()
      model.close()
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 600_000)
})
