// The whole Hermes path with the real CLI: a Tucano agent's tool call goes from
// the model, through the CLI's own gateway daemon, to the app's gateway (the MCP
// server the profile points at) and back. Only the model is faked — a local
// OpenAI-compatible endpoint scripted to ask for the tool once.
//
// Opt-in and slow (spawns the CLI, warms a fresh root, boots its daemon):
//   TUCANO_HERMES_E2E=1 npx vitest run test/hermes-e2e.test.ts
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hermesEngine, hermesHome } from '../src/core/engines/hermes'
import { Gateway, textResult, type ToolDef } from '../src/core/gateway'
import { alive, daemonPid, fakeModel, hermesBin, hermesE2e, stopDaemon, textOf } from './fixtures/hermes-cli'

const MCP_NAME = 'list_tasks'
const TOOL: ToolDef = { name: MCP_NAME, description: 'Lists the tasks', inputSchema: { type: 'object', properties: {} } }
const bin = hermesBin()
const enabled = hermesE2e()

describe.skipIf(!enabled)('the Hermes engine end to end', () => {
  it('runs a tool the app gave it, through the CLI gateway and back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-hermes-e2e-'))
    const userHome = mkdtempSync(join(tmpdir(), 'tucano-hermes-user-'))
    // Hermes offers a server's tools to the model as `mcp__<server>__<tool>` (the
    // call back to the server uses the raw name), so the script asks for whatever
    // it was offered and answers from the result it got back.
    const model = await fakeModel(({ messages, tools }) => {
      const results = messages.filter((m) => m.role === 'tool')
      if (results.length) {
        return { message: { role: 'assistant', content: `saw: ${textOf(results[results.length - 1]!.content)}` }, finish: 'stop' as const }
      }
      const asked = tools.map((t) => t.function?.name ?? '').find((n) => n.endsWith(`__${MCP_NAME}`))
      return { message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: asked, arguments: '{}' } }] }, finish: 'tool_calls' as const }
    })

    const gateway = new Gateway()
    await gateway.start()
    const called: string[] = []
    gateway.agentTurn('iris', { tools: [TOOL], call: async (name) => (called.push(name), textResult('2 tasks: coffee and bread')) })

    const previous = process.env['HERMES_HOME']
    process.env['HERMES_HOME'] = userHome
    try {
      // The person's own config: a provider pointed at the fake model.
      writeFileSync(join(userHome, 'config.yaml'), `providers:\n  probe:\n    base_url: ${model.url}\n    api_mode: chat_completions\n    api_key_env: PROBE_KEY\nmodel:\n  provider: probe\n`)

      // Nothing warms this root first: a cold root used to die on the CLI's own
      // imports ("No module named 'ruamel'"), so the engine has to prepare it.

      const home = hermesHome(root, { system: 'You are Iris, a Tucano agent.', mcpUrl: gateway.agentUrl('iris'), web: false, agentKey: 'iris' }, userHome)
      expect(home).toContain(join('profiles', 'iris'))

      const events = []
      for await (const ev of hermesEngine(() => bin, root).run({
        model: 'probe/probe-model', effort: 'low', system: 'You are Iris, a Tucano agent.',
        prompt: 'list my tasks', blocks: ['list my tasks'], images: [], cwd: userHome,
        agentKey: 'iris', signal: new AbortController().signal, mcpUrl: gateway.agentUrl('iris'), web: false
      })) {
        events.push(ev)
      }

      const done = events.find((e) => e.type === 'done')
      expect(events.find((e) => e.type === 'error')).toBeUndefined()
      expect(done).toBeDefined()
      // The model only says this after reading the tool result back, so the
      // app's payload made the whole round trip.
      expect((done as { text: string }).text).toContain('2 tasks: coffee and bread')
      // And the call really reached the app's gateway: the handler ran, under
      // the raw tool name (the namespaced one is the model's view).
      expect(called).toEqual([MCP_NAME])
      expect(model.calls()).toBeGreaterThanOrEqual(2)

      // A turn leaves the CLI's own gateway daemon behind, and in 0.22 there is
      // no switch to turn it off: every turn goes through that runtime and the
      // profiles layout is built on it. So what the app owes is that stopping it
      // leaves nothing behind — the process goes and its pid file goes with it.
      // The idle exit in the generated config (2 minutes) bounds the case where
      // nobody asks.
      const pid = daemonPid(root)
      expect(pid).toBeGreaterThan(0)
      expect(alive(pid!)).toBe(true)
      await stopDaemon(bin!, root)
      expect(alive(pid!)).toBe(false)
      expect(existsSync(join(root, 'gateway.pid'))).toBe(false)
    } finally {
      process.env['HERMES_HOME'] = previous
      await stopDaemon(bin!, root)
      await gateway.stop()
      model.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      rmSync(userHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }, 600_000)
})
