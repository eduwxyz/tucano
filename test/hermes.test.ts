import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, expect, it } from 'vitest'
import { hermesArgs, hermesEnv, hermesHome, hermesParser, userHermesProviders, warmHermes } from '../src/core/engines/hermes'
import { hermesEndpointProviders, olderThan, parseHermesModels } from '../src/core/engines/detect'
import { ENGINES } from '../src/shared/types'

// Fixture is real CLI output (`hermes chat --format stream-json`, Hermes 2026-10-29), trimmed.
const lines = readFileSync(join(import.meta.dirname, 'fixtures', 'hermes-stream.jsonl'), 'utf8').split('\n').filter((l) => l.trim())

describe('hermes', () => {
  it('turns its events into the engine events', () => {
    const p = hermesParser()
    const events = lines.flatMap((l) => p.line(l))
    expect(events).toContainEqual({ type: 'web', action: 'search', detail: 'Pi coding agent official site' })
    const end = p.end(0, '')
    expect(end).toEqual([
      {
        type: 'done',
        text: 'O endereço oficial do Pi coding agent é https://pi.dev (repo: https://github.com/earendil-works/pi).',
        // total = input + cache_read + output, so `input` alone misses the cache read.
        usage: { inputTokens: 5278 + 2048, cacheReadTokens: 2048, outputTokens: 28 }
      }
    ])
  })

  it('uses the final text, not the deltas', () => {
    const p = hermesParser()
    lines.flatMap((l) => p.line(l))
    expect(p.end(0, '')[0]).toMatchObject({ type: 'done', text: expect.stringContaining('https://pi.dev') })
  })

  it('reports an error result', () => {
    const p = hermesParser()
    p.line('{"type":"result","session_id":"x","exit_code":1,"text":"","tokens":{"input":0,"output":0,"total":0,"cache_read":0,"cache_write":0},"error":"No provider for acme"}')
    expect(p.end(0, '')).toEqual([{ type: 'error', message: 'No provider for acme' }])
  })

  it('reports an error when the process exits without a result', () => {
    const p = hermesParser()
    const end = p.end(1, 'boom\nsomething failed')
    expect(end).toHaveLength(1)
    expect(end[0]).toMatchObject({ type: 'error' })
    expect((end[0] as { message: string }).message).toContain('something failed')
  })

  it('ignores lines that are not JSON or not known', () => {
    const p = hermesParser()
    expect(p.line('not json')).toEqual([])
    expect(p.line('{"type":"tool_result","name":"web_search","output":"..."}')).toEqual([])
  })
})

describe('hermes setup', () => {
  it('runs the oneshot protocol with the model, effort and stdin query', () => {
    expect(hermesArgs({ model: 'acme/deepseek-v4-flash-official', effort: 'high', images: [] })).toEqual([
      'chat',
      '--format',
      'stream-json',
      '--query-file',
      '-',
      '--reasoning',
      'high',
      '-m',
      'acme/deepseek-v4-flash-official'
    ])
  })

  it('names the provider of a bare model id from the user config, and attaches the newest existing image only', () => {
    const args = hermesArgs({ model: 'deepseek-v4-flash-official', effort: 'low', images: [{ block: 0, path: '/tmp/inexistente.png', mime: 'image/png' }] }, 'acme')
    expect(args).toEqual(['chat', '--format', 'stream-json', '--query-file', '-', '--reasoning', 'low', '-m', 'deepseek-v4-flash-official', '--provider', 'acme'])
  })

  it('builds a per-agent home with the gateway, the web when allowed, and the user providers', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'hu-'))
    writeFileSync(join(userHome, 'config.yaml'), 'providers:\n  acme:\n    base_url: https://llm.acme.com/v1\n    api_mode: chat_completions\nmcp_servers:\n  atlassian:\n    command: uvx\nmodel:\n  provider: acme\n')
    writeFileSync(join(userHome, 'auth.json'), '{}')
    writeFileSync(join(userHome, '.env'), 'CUSTOM_API_KEY=x')
    const appDir = mkdtempSync(join(tmpdir(), 'hh-'))
    const home = hermesHome(appDir, { system: 'You are Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false, agentKey: 'iris' }, userHome)
    expect(home).toContain(join('profiles', 'iris')) // one profile home per Tucano agent
    expect(lstatSync(join(home, 'auth.json')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(home, '.env')).isSymbolicLink()).toBe(true)
    const c = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(c['approvals']).toEqual({ mode: 'off' })
    expect(c['platform_toolsets']).toEqual({ cli: [] }) // no built-in tools, no web
    expect(c['tools']).toEqual({ tool_search: { enabled: 'off' } }) // the gateway's tools reach the model directly
    expect(c['memory']).toEqual({ memory_enabled: false, user_profile_enabled: false }) // no memories behind the app's back
    expect(c['skills']).toEqual({ auto_load: [], project_discovery: false })
    expect(c['auxiliary']).toEqual({ background_review: { enabled: false }, title_generation: { enabled: false } }) // no model call per turn outside the receipts
    expect(c['mcp_servers']).toEqual({ tucano: { url: 'http://127.0.0.1:1/mcp/x' } })
    expect(c['providers']).toEqual({ acme: { base_url: 'https://llm.acme.com/v1', api_mode: 'chat_completions' } })
    expect(c['model']).toEqual({ provider: 'acme' })
    expect(Object.keys(c['mcp_servers'] as object)).not.toContain('atlassian')
  })

  it("makes the agent Tucano's: the instructions are the home's SOUL.md", () => {
    const appDir = mkdtempSync(join(tmpdir(), 'hs-'))
    const userHome = mkdtempSync(join(tmpdir(), 'hu4-'))
    const home = hermesHome(appDir, { system: 'You are Iris.', mcpUrl: undefined, web: false, agentKey: 'iris' }, userHome)
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('You are Iris.')
    // the skills the CLI would seed come from an empty folder next to the homes
    expect(existsSync(join(appDir, 'no-skills'))).toBe(true)
    // the turn env points the CLI at that empty skills source and the agent home
    expect(hermesEnv(appDir, home, { PATH: '/x' })).toEqual({ PATH: '/x', HERMES_HOME: home, HERMES_BUNDLED_SKILLS: join(appDir, 'no-skills') })
  })

  it('lays the root out as the CLI expects and inherits the heavy environment from it', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'he2-'))
    const userHome = mkdtempSync(join(tmpdir(), 'hu5-'))
    const a = hermesHome(appDir, { system: 'a', mcpUrl: undefined, web: false, agentKey: 'a' }, userHome)
    const b = hermesHome(appDir, { system: 'b', mcpUrl: undefined, web: false, agentKey: 'b' }, userHome)
    expect(a).not.toBe(b)
    // the root is a Hermes home with a versioned config; profiles live under profiles/
    const rc = parseYaml(readFileSync(join(appDir, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(rc['_config_version']).toBe(12)
    // The CLI's own gateway daemon is unavoidable in 0.22, so its life is bounded
    // instead: it idles out instead of staying up after the app closes.
    expect(rc['gateway']).toEqual({ unmanaged_idle_exit_seconds: 120 })
    // Hermes' scheduler stays out of it: no agent-created jobs, no catch-up.
    expect(rc['cron']).toEqual({ allow_agent_scheduling: false, catch_up_missed: false })
    // the per-agent home carries the gates, not the root
    const ca = parseYaml(readFileSync(join(a, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(ca['_config_version']).toBe(12)
    expect(ca['memory']).toEqual({ memory_enabled: false, user_profile_enabled: false })
    const cb = parseYaml(readFileSync(join(b, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(cb['memory']).toEqual({ memory_enabled: false, user_profile_enabled: false })
  })

  it('turns the web on as the only built-in toolset', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'hw-'))
    const home = hermesHome(appDir, { system: 's', mcpUrl: undefined, web: true, agentKey: 'w' }, mkdtempSync(join(tmpdir(), 'hu2-')))
    const c = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(c['platform_toolsets']).toEqual({ cli: ['web'] })
    expect(c['mcp_servers']).toBeUndefined()
  })

  it("takes only the providers from the user's config.yaml", () => {
    const userHome = mkdtempSync(join(tmpdir(), 'hu3-'))
    writeFileSync(join(userHome, 'config.yaml'), 'providers:\n  acme:\n    base_url: https://x/v1\napprovals:\n  mode: manual\n')
    expect(userHermesProviders(userHome)).toEqual({ providers: { acme: { base_url: 'https://x/v1' } } })
    expect(userHermesProviders(join(tmpdir(), 'vazio-'))).toEqual({})
  })

  it('rewrites each agent home every turn (the gateway changes with it), without crossing agents', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'he-'))
    hermesHome(appDir, { system: 's1', mcpUrl: 'http://127.0.0.1:1/mcp/a', web: false, agentKey: 'iris' })
    const home = hermesHome(appDir, { system: 's2', mcpUrl: undefined, web: false, agentKey: 'iris' })
    const c = parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(existsSync(join(home, 'config.yaml'))).toBe(true)
    expect(c['mcp_servers']).toBeUndefined() // the last turn's gateway is gone
    expect(readFileSync(join(home, 'SOUL.md'), 'utf8')).toBe('s2')
    // a second agent's home is untouched
    const other = hermesHome(appDir, { system: 'other', mcpUrl: 'http://127.0.0.1:1/mcp/b', web: false, agentKey: 'rafa' })
    const c2 = parseYaml(readFileSync(join(other, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(c2['mcp_servers']).toEqual({ tucano: { url: 'http://127.0.0.1:1/mcp/b' } })
  })

  it('reads the model ids from the provider cache', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hc-'))
    // Shape of the real cache: one entry per credential, models per entry.
    writeFileSync(
      join(dir, 'provider_models_cache.json'),
      JSON.stringify({
        copilot: { fp: 'x', at: 1, models: ['gpt-5.4', 'claude-sonnet-5'] },
        'custom:https://llm.acme.com/api/v2#aa2f87b585a35b95': { fp: 'y', at: 2, models: ['deepseek-v4-flash'] },
        'custom:https://broken#z': { fp: 'z', at: 3, models: ['m'] }
      })
    )
    const providers = hermesEndpointProviders({ acme: { base_url: 'https://llm.acme.com/api/v2/' } })
    // The person's own endpoint is labelled with its config key (that is what
    // --provider takes); an endpoint that is in no config falls back to its host.
    expect(parseHermesModels(join(dir, 'provider_models_cache.json'), providers)).toEqual(['copilot/gpt-5.4', 'copilot/claude-sonnet-5', 'acme/deepseek-v4-flash', 'broken/m'])
    expect(parseHermesModels(join(dir, 'missing.json'))).toEqual([])
  })

  it('builds the dependency environment once per root, and a run waits for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-'))
    const log = join(dir, 'calls.txt')
    const bin = join(dir, 'hermes')
    writeFileSync(bin, `#!/bin/sh\necho "$@" >> "${log}"\nsleep 0.2\n`, { mode: 0o755 })
    const first = warmHermes(bin, dir)
    expect(warmHermes(bin, dir)).toBe(first) // one build per root, not per caller
    await first
    expect(readFileSync(log, 'utf8').trim()).toBe('pm repair')
  })

  it('knows when the installed Hermes is older than what the app drives', () => {
    // The flags the engine uses are 0.22's; PyPI's package is older.
    expect(olderThan('0.19.0', '0.22.0')).toBe(true)
    expect(olderThan('0.22.0', '0.22.0')).toBe(false)
    expect(olderThan('0.22.5', '0.22.0')).toBe(false)
    expect(olderThan('0.9.0', '0.22.0')).toBe(true) // part by part, not as text: 9 < 22
    // the hint the row shows points at the official installer, floor stated
    expect(ENGINES.hermes.install).toContain('hermes-agent.nousresearch.com/install.sh')
    expect(ENGINES.hermes.min).toBe('0.22.0')
  })

  it('tries again when a repair fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hf-'))
    const log = join(dir, 'calls.txt')
    const bin = join(dir, 'hermes')
    writeFileSync(bin, `#!/bin/sh\necho x >> "${log}"\nexit 1\n`, { mode: 0o755 })
    await warmHermes(bin, dir)
    await warmHermes(bin, dir)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2)
  })
})
