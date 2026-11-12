// Agents on the real Hermes CLI at the same time: two agents, each with a connector of its own,
// and one agent asked in two conversations at once. Each sees only the tools it was given, gets
// its own tool's answer, and no reply fails on the CLI's shared root or daemon. Only the model is
// fake: the CLI, its daemon, the app's gateway and the tool layer are the real ones.
//
// Opt-in and slow (spawns the CLI, warms a fresh root, boots its daemon):
//   TUCANO_HERMES_E2E=1 npx vitest run test/hermes-concurrent.test.ts
import { mkdirSync, writeFileSync } from 'node:fs'
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
import type { Agent, Settings } from '../src/shared/types'
import { fakeModel, hermesBin, hermesE2e, hermesTmpRoot, removeTree, stopDaemon, textOf, type ChatMessage } from './fixtures/hermes-cli'

const DEMO = join(import.meta.dirname, '..', 'scripts', 'demo-mcp-server.mjs')
const ready = { installed: true, loggedIn: true }
const bin = hermesBin()
const enabled = hermesE2e()

// Whose request this is, by the instructions in its system prompt (SOUL.md).
const whose = (messages: ChatMessage[]): string => (/You are (\w+)/.exec(messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'))?.[1] ?? '?')

describe.skipIf(!enabled)('Hermes agents at the same time', () => {
  it('keep their tools apart, and one agent in two conversations answers both', async () => {
    setLang('en')
    const dir = hermesTmpRoot('conc')
    const root = join(dir, 'hermes')
    const userHome = join(dir, 'user')
    mkdirSync(root, { recursive: true })
    mkdirSync(userHome, { recursive: true })
    const tasks = (who: string): string => {
      const f = join(dir, `${who}.json`)
      writeFileSync(f, JSON.stringify([{ id: 1, title: `Task of ${who}`, done: false }]))
      return f
    }

    // The model lists the tasks with whatever list tool it was offered, then says what it saw.
    const model = await fakeModel(({ messages, tools }) => {
      const results = messages.filter((m) => m.role === 'tool')
      if (results.length) return { message: { role: 'assistant', content: `saw: ${textOf(results.at(-1)!.content)}` }, finish: 'stop' as const }
      const asked = tools.map((t) => t.function?.name ?? '').find((n) => n.endsWith('list_tasks'))
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: asked, arguments: '{}' } }] }, finish: 'tool_calls' as const }
    })
    writeFileSync(join(userHome, 'config.yaml'), `providers:\n  probe:\n    base_url: ${model.url}\n    api_mode: chat_completions\n    api_key_env: PROBE_KEY\nmodel:\n  provider: probe\n`)

    const db = new Db(join(dir, 'test.db'))
    const gateway = new Gateway()
    await gateway.start()
    const connectors = new ConnectorManager({ db, secrets: new Secrets(db, plainCipher), emit: () => {}, openUrl: () => {}, oauthCallbackUrl: () => gateway.url('/oauth/callback') })
    const irisTasks = await connectors.add({ kind: 'stdio', name: 'Iris Tasks', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasks('Iris') } })
    const theoTasks = await connectors.add({ kind: 'stdio', name: 'Theo Tasks', command: process.execPath, args: [DEMO], env: { DEMO_TASKS_FILE: tasks('Theo') } })
    await connectors.connect(irisTasks)
    await connectors.connect(theoTasks)

    const settings: Settings = {
      workspaceName: 'Marina', context: '',
      engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready },
      routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000,
      approvalTtlHours: 24, theme: 'system', language: 'en'
    }
    const agent = (id: string, name: string, connectorId: string): Agent => ({
      id, name, handle: name.toLowerCase(), role: '', color: 'sky', instructions: `You are ${name}.`, modelId: 'hermes:probe/probe-model',
      effort: 'low', limit: 1_000_000, used: 0, grants: { [connectorId]: 'read' }, memory: 'read', computer: false, archived: false
    })
    db.saveAgent(agent('a1', 'Iris', irisTasks))
    db.saveAgent(agent('a2', 'Theo', theoTasks))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    db.createConversation({ id: 'd2', kind: 'dm', name: 'a2', members: ['a2'] })
    db.createConversation({ id: 'c1', kind: 'channel', name: 'iris-room', members: ['a1'] })

    const runner = new Runner({
      db,
      engines: { claude: fakeEngine('claude'), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: hermesEngine(() => bin, root) },
      settings: async () => settings,
      emit: () => {},
      workDir: join(dir, 'work'),
      gateway,
      connectors
    })
    const replies = (conversationId: string): string[] => db.messages().filter((m) => m.conversationId === conversationId && m.author.kind === 'agent').map((m) => `${m.run?.status} ${m.text}`)

    const previous = process.env['HERMES_HOME']
    process.env['HERMES_HOME'] = userHome
    try {
      // Two agents at once, on a cold root.
      await Promise.all([runner.send('d1', 'list my tasks'), runner.send('d2', 'list my tasks')])
      await runner.idle()
      expect(replies('d1')).toEqual([expect.stringMatching(/^done saw: [\s\S]*Task of Iris/)])
      expect(replies('d2')).toEqual([expect.stringMatching(/^done saw: [\s\S]*Task of Theo/)])
      // Each was offered only its own connector's tools; a call of the CLI's own (no agent in it) none.
      const seen = new Set<string>()
      for (const r of model.requests()) {
        const offered = r.tools.map((t) => t.function?.name ?? '').filter((n) => n.includes('list_tasks'))
        const who = whose(r.messages)
        if (who === '?') {
          expect(offered, 'a call with no agent in it').toEqual([])
          continue
        }
        seen.add(who)
        expect(offered.length, `${who}: ${offered.join(', ')}`).toBe(1)
        expect(offered[0]!.toLowerCase()).toContain(who.toLowerCase())
      }
      expect([...seen].sort()).toEqual(['Iris', 'Theo'])

      // One agent asked in two conversations at once: both answer, each from its own tool call.
      await Promise.all([runner.send('d1', 'list them again'), runner.send('c1', '@iris list my tasks')])
      await runner.idle()
      expect(replies('d1').at(-1)).toMatch(/^done saw: [\s\S]*Task of Iris/)
      expect(replies('c1')).toEqual([expect.stringMatching(/^done saw: [\s\S]*Task of Iris/)])
    } finally {
      process.env['HERMES_HOME'] = previous
      await stopDaemon(bin!, root)
      await connectors.closeAll()
      await gateway.stop()
      model.close()
      removeTree(dir)
    }
  }, 900_000)
})
