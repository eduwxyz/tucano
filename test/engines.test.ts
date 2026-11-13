import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Parser } from '../src/core/engines/cli'
import { claudeArgs, claudeInput, claudeParser, userProvider } from '../src/core/engines/claude'
import { CODEX_DISABLED_FEATURES, codexArgs, codexEnv, codexParser, userCodexProvider } from '../src/core/engines/codex'
import { antigravityArgs, antigravityHomeEnv, antigravityInput, antigravityModel, antigravityParser, antigravityPrompt, antigravitySettings, antigravityTurnDirs, parseAntigravityModels, RULES_MAX } from '../src/core/engines/antigravity'
import { cursorArgs, cursorCleanup, cursorConfig, cursorEngine, cursorHomeEnv, cursorParser, cursorSignedIn, cursorSlug, cursorWorkerSocket, cursorTurnDirs, imageRefused, parseCursorModels } from '../src/core/engines/cursor'
import { grokArgs, grokCleanup, grokConfig, grokEngine, grokLogin, grokParser, grokPrompt, grokTurnDirs, grokTurnEnv, parseGrokModels, userGrokHome } from '../src/core/engines/grok'
import { CLINE_OFF, clineArgs, clineEngine, clineLead, clineLogins, clineMcp, clineModel, clineParser, clinePrompt, clineSettings, clineTurnDirs, clineTurnEnv, clineCleanup, clineLoginEnv, clineProvidersFile } from '../src/core/engines/cline'
import { detectCline } from '../src/core/engines/detect'
import { copilotArgs, copilotEngine, copilotEnv, copilotParser, copilotTurnDirs, copilotUsage, effortRefused, parseCopilotModels, sweepCopilotTurns } from '../src/core/engines/copilot'
import { customModel, modelInfo, usable } from '../src/shared/types'
import type { EngineEvent } from '../src/core/engines/types'

// Fixtures are real CLI output (Claude Code 2.1.286, Codex 0.153.4), or the exact
// event shape taken from the CLI's own writer (Gemini CLI 0.66), trimmed of local paths.
const fixture = (name: string): string[] => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8').split('\n')

function feed(parser: Parser, lines: string[], exit = 0, stderr = ''): EngineEvent[] {
  return [...lines.flatMap((l) => (l.trim() ? parser.line(l) : [])), ...parser.end(exit, stderr)]
}

const text = (events: EngineEvent[]): string => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')

describe('Claude Code stream', () => {
  it('streams the text and reports the final usage', () => {
    const events = feed(claudeParser(), fixture('claude-stream.jsonl'))
    expect(text(events)).toBe('oi, tudo certo.')
    const done = events.find((e) => e.type === 'done')
    expect(done).toEqual({
      type: 'done',
      text: 'oi, tudo certo.',
      context: 10 + 6617 + 84, // the last model call's input and output
      usage: { inputTokens: 10 + 6617, cacheReadTokens: 6617, outputTokens: 84, apiCostUsd: 0.0010917 }
    })
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('reports growing progress while streaming', () => {
    const progress = feed(claudeParser(), fixture('claude-stream.jsonl')).flatMap((e) => (e.type === 'progress' ? [e.tokens] : []))
    expect(progress.length).toBeGreaterThan(0)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(progress.at(-1)).toBe(10 + 6617 + 84)
  })

  it('turns an error result into an error event', () => {
    const events = feed(claudeParser(), ['{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}'])
    expect(events).toEqual([{ type: 'error', message: 'Not logged in · Please run /login' }])
  })

  it('reports an error when the process exits without a result', () => {
    const events = feed(claudeParser(), [], 1, 'boom\nsomething failed')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('something failed')
  })

  it('ignores lines that are not JSON or not known', () => {
    expect(feed(claudeParser(), ['not json', '{"type":"rate_limit_event"}', '{"type":"something_new"}'], 0)).toHaveLength(1) // only the "no result" error
  })

  it('separates text from model calls before and after a tool call', () => {
    const start = '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":5}}}}'
    const delta = (t: string): string => JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: t } } })
    expect(text(feed(claudeParser(), [start, delta('Vou perguntar.'), start, delta('Pronto.')]))).toBe('Vou perguntar.\n\nPronto.')
  })

  it('gets the gateway as its only MCP server, with its tools pre-allowed', () => {
    const args = claudeArgs({ model: 'sonnet', effort: 'low', system: 'x', mcpUrl: 'http://127.0.0.1:1/mcp/abc' })
    // The address (and its token) comes from the environment: never in the arguments, which other programs can list.
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { tucano: { type: 'http', url: '${TUCANO_MCP_URL}' } } })
    expect(args.join(' ')).not.toContain('/mcp/abc')
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['mcp__tucano', 'ToolSearch'])
    expect(args).toContain('--strict-mcp-config')
    expect(claudeArgs({ model: 'sonnet', effort: 'low', system: 'x' })).not.toContain('--mcp-config')
  })

  it('keeps tool search on with the gateway, so connector tools stay out of every call', () => {
    // Without ToolSearch among the tools, the CLI puts every MCP tool in every model call.
    const args = claudeArgs({ model: 'sonnet', effort: 'low', system: 'x', mcpUrl: 'http://127.0.0.1:1/mcp/abc' })
    expect(args[args.indexOf('--tools') + 1]).toBe('ToolSearch')
    const noGateway = claudeArgs({ model: 'sonnet', effort: 'low', system: 'x', web: true })
    expect(noGateway[noGateway.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch')
  })

  it('runs isolated: no built-in tools, no user settings, no session, never --bare', () => {
    const args = claudeArgs({ model: 'sonnet', effort: 'medium', system: 'x' })
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence']))
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args[args.indexOf('--system-prompt') + 1]).toBe('x')
    expect(args).not.toContain('--bare')
  })

  it("takes only how to reach the model from the user's settings: env and apiKeyHelper, not hooks or plugins", () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-settings-'))
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://llm.empresa.com', N: 1 }, apiKeyHelper: '~/bin/chave', hooks: { Stop: [] }, enabledPlugins: { x: true } }))
    expect(userProvider(dir)).toEqual({ env: { ANTHROPIC_BASE_URL: 'https://llm.empresa.com' }, apiKeyHelper: '~/bin/chave' })
    expect(userProvider(join(dir, 'nada'))).toEqual({ env: {} })
    const args = claudeArgs({ model: 'sonnet', effort: 'low', system: 'x' }, '~/bin/chave')
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ apiKeyHelper: '~/bin/chave' })
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(claudeArgs({ model: 'sonnet', effort: 'low', system: 'x' })).not.toContain('--settings')
  })

  it("takes the gateway from the user's Codex config: the provider and the variables holding its key, not MCP servers", () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-config-'))
    writeFileSync(
      join(dir, 'config.toml'),
      ['model_provider = "empresa"', '[model_providers.empresa]', 'base_url = "https://llm.empresa.com/v1"', 'env_key = "EMPRESA_KEY"', 'env_http_headers = { "X-Time" = "EMPRESA_TIME" }', '[mcp_servers.x]', 'command = "x"'].join('\n')
    )
    const p = userCodexProvider(dir)
    expect(p.baseUrl).toBe('https://llm.empresa.com/v1')
    expect(p.envNames).toEqual(['OPENAI_BASE_URL', 'EMPRESA_KEY', 'EMPRESA_TIME'])
    expect(p.config).toEqual([
      '-c', 'model_provider="empresa"',
      '-c', 'model_providers.empresa={ "base_url" = "https://llm.empresa.com/v1", "env_key" = "EMPRESA_KEY", "env_http_headers" = { "X-Time" = "EMPRESA_TIME" } }'
    ])
    const args = codexArgs({ model: 'gpt-x', effort: 'low', system: 'x', cwd: '/tmp' }, p.config)
    expect(args).toContain('--ignore-user-config')
    expect(args.join(' ')).not.toContain('mcp_servers.x')
    expect(userCodexProvider(join(dir, 'nada'))).toEqual({ config: [], envNames: [] })
  })

  it('takes model names the app does not list, for the engine they were typed in', () => {
    expect(modelInfo('opus')?.label).toBe('Opus')
    expect(modelInfo(customModel('codex', ' gpt-4.1-empresa '))).toMatchObject({ id: 'gpt-4.1-empresa', engine: 'codex' })
    expect(modelInfo('claude:us.anthropic.claude-sonnet-4-5:0')).toMatchObject({ id: 'us.anthropic.claude-sonnet-4-5:0', engine: 'claude' })
    expect(modelInfo('claude:')?.id).toBe('')
    expect(modelInfo('qualquer')).toBeUndefined()
    // the router and the memory fall back to the default while the name is empty
    expect(usable(modelInfo('claude:'))).toBeUndefined()
    expect(usable(modelInfo('claude:gw-haiku'))?.id).toBe('gw-haiku')
  })

  it('sends the conversation as one text block per message, so the next turn reads them from the cache', () => {
    const turn = { model: 'sonnet', effort: 'low' as const, system: 'x', prompt: 'a\n\nb', blocks: ['a', ' ', 'b'] }
    expect(claudeArgs(turn)).toEqual(expect.arrayContaining(['--input-format', 'stream-json']))
    expect(JSON.parse(claudeInput(turn))).toEqual({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })
    expect(claudeArgs({ ...turn, blocks: undefined })).not.toContain('--input-format')
    expect(claudeInput({ prompt: 'só texto' })).toBe('só texto')
  })

  it('puts an attached image right after the block of its message, read from disk', () => {
    const png = join(mkdtempSync(join(tmpdir(), 'ad-img-')), 'tela.png')
    writeFileSync(png, Buffer.from('fake-png'))
    const turn = { model: 'sonnet', effort: 'low' as const, system: 'x', prompt: 'a\n\nb', blocks: ['a', 'b'], images: [{ block: 0, path: png, mime: 'image/png' }, { block: 1, path: '/nao/existe.png', mime: 'image/png' }] }
    expect(claudeArgs(turn)).toEqual(expect.arrayContaining(['--input-format', 'stream-json']))
    expect(JSON.parse(claudeInput(turn)).message.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('fake-png').toString('base64') } },
      { type: 'text', text: 'b' }
    ])
  })

  it('reports how much of the running total came from the cache', () => {
    const start = (u: object): string => JSON.stringify({ type: 'stream_event', event: { type: 'message_start', message: { usage: u } } })
    const progress = feed(claudeParser(), [start({ input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90 }), start({ input_tokens: 5, cache_read_input_tokens: 1000 })]).filter((e) => e.type === 'progress')
    expect(progress.at(-1)).toEqual({ type: 'progress', tokens: 2005, cacheRead: 1900 })
  })

  it('with web, gets only the web tools, pre-allowed, and reports each search and page read', () => {
    const args = claudeArgs({ model: 'sonnet', effort: 'low', system: 'x', mcpUrl: 'http://127.0.0.1:1/mcp/abc', web: true })
    expect(args[args.indexOf('--tools') + 1]).toBe('ToolSearch,WebSearch,WebFetch')
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['mcp__tucano', 'ToolSearch', 'WebSearch', 'WebFetch'])
    const assistant = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'WebSearch', input: { query: 'electron release' } },
          { type: 'tool_use', name: 'WebFetch', input: { url: 'https://electronjs.org', prompt: 'versão?' } },
          { type: 'tool_use', name: 'mcp__tucano__bash', input: {} }
        ]
      }
    })
    expect(feed(claudeParser(), [assistant]).filter((e) => e.type === 'web')).toEqual([
      { type: 'web', action: 'search', detail: 'electron release' },
      { type: 'web', action: 'fetch', detail: 'https://electronjs.org' }
    ])
  })
})

describe('Codex exec stream', () => {
  it('collects agent messages and reports the turn usage', () => {
    const events = feed(codexParser(), fixture('codex-exec.jsonl'))
    expect(text(events)).toBe('oi, tudo certo.')
    expect(events.find((e) => e.type === 'done')).toEqual({
      type: 'done',
      text: 'oi, tudo certo.',
      usage: { inputTokens: 14839, cacheReadTokens: 10368, outputTokens: 9 }
    })
    // The "error" item in the fixture is a hook warning, not a failure.
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('turns a failed turn into an error event', () => {
    const events = feed(codexParser(), ['{"type":"turn.failed","error":{"message":"usage limit reached"}}'])
    expect(events).toEqual([{ type: 'error', message: 'usage limit reached' }])
  })

  it('runs isolated from the user config, read-only, with instructions as developer_instructions', () => {
    const args = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'Você é "Theo".', cwd: '/tmp/x' })
    expect(args).toEqual(expect.arrayContaining(['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules']))
    expect(args[args.indexOf('-s') + 1]).toBe('read-only')
    expect(args[args.indexOf('-C') + 1]).toBe('/tmp/x')
    expect(args).toContain('developer_instructions="Você é \\"Theo\\"."')
    expect(args.at(-1)).toBe('-')
  })

  it("tells an agent with a computer that Codex's read-only sandbox isn't it", () => {
    const instructions = (system: string, mcpUrl?: string): string => {
      const args = codexArgs({ model: 'gpt-6-astra', effort: 'low', system, cwd: '/tmp/x', ...(mcpUrl ? { mcpUrl } : {}) })
      return args.find((a) => a.startsWith('developer_instructions='))!
    }
    const computer = 'Use bash, read_file, write_file and edit_file on /work.'
    expect(instructions(computer, 'http://127.0.0.1:1/mcp/t')).toMatch(/apply_patch.*write_file e edit_file|apply_patch.*write_file and edit_file/)
    expect(instructions('Você é Theo.', 'http://127.0.0.1:1/mcp/t')).not.toMatch(/apply_patch/) // no computer: nothing to point to
    expect(instructions(computer)).not.toMatch(/apply_patch/) // no gateway, no tools
  })

  it('turns off skills, web search, project docs and every built-in tool', () => {
    const args = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'x', cwd: '/tmp/x' })
    expect(args).toEqual(expect.arrayContaining(['skills.include_instructions=false', 'skills.bundled.enabled=false', 'web_search="disabled"', 'project_doc_max_bytes=0']))
    expect(CODEX_DISABLED_FEATURES).not.toContain('code_mode_host') // every tool call goes through it
    for (const f of ['shell_tool', 'unified_exec', 'plugins', 'computer_use', 'multi_agent']) {
      expect(CODEX_DISABLED_FEATURES).toContain(f)
      expect(args[args.indexOf(f) - 1]).toBe('--disable')
    }
  })

  it('with web, searches live and reports each search', () => {
    expect(codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'x', cwd: '/tmp/x', web: true })).toContain('web_search="live"')
    // attached images: one value per flag, so none swallows the prompt's "-"; missing files are left out
    const png = join(mkdtempSync(join(tmpdir(), 'ad-img-')), 'tela.png')
    writeFileSync(png, 'x')
    const withImages = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'x', cwd: '/tmp/x', images: [{ block: 2, path: png, mime: 'image/png' }, { block: 3, path: '/nao/existe.png', mime: 'image/png' }] })
    expect(withImages.filter((a) => a.startsWith('--image'))).toEqual([`--image=${png}`])
    expect(withImages.at(-1)).toBe('-')
    const item = (i: object): string => JSON.stringify({ type: 'item.completed', item: { id: 'w', type: 'web_search', ...i } })
    expect(feed(codexParser(), [item({ query: 'electron release' }), item({ action: { type: 'open_page', url: 'https://electronjs.org' } })]).filter((e) => e.type === 'web')).toEqual([
      { type: 'web', action: 'search', detail: 'electron release' },
      { type: 'web', action: 'fetch', detail: 'https://electronjs.org' }
    ])
  })

  it('runs in the app\'s own home, so the user\'s AGENTS.md, skills and memories never load', () => {
    expect(codexEnv('/data/codex-home')).toMatchObject({ HOME: '/data/codex-home', CODEX_HOME: join('/data/codex-home', '.codex') })
  })

  it('gets the gateway as its only MCP server, with approval delegated to the gateway', () => {
    const args = codexArgs({ model: 'gpt-5.6-luna', effort: 'low', system: 'x', cwd: '/tmp/x', mcpUrl: 'http://127.0.0.1:1/mcp/abc' })
    expect(args).toContain('mcp_servers.tucano.url="http://127.0.0.1:1/mcp/abc"')
    expect(args).toContain('mcp_servers.tucano.default_tools_approval_mode="approve"')
    expect(args.at(-1)).toBe('-')
  })
})


describe('Antigravity stream', () => {
  // Real agy 1.5.3 output: a gateway tool, a denied shell command and file read, the
  // reply, and a web search (from another real run) before the result.
  const lines = fixture('antigravity-stream.jsonl').filter((l) => l.trim())
  const result = JSON.parse(lines.at(-1)!) as { result: { response: string } }

  it('streams the reply and reports the usage from the result, thinking as output', () => {
    const events = feed(antigravityParser(), lines)
    expect(text(events)).toBe(result.result.response)
    expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done', text: result.result.response, usage: { inputTokens: 38055, cacheReadTokens: 4036, outputTokens: 336 } })
  })

  it('gives a running total after each model call, for the limits', () => {
    const progress = feed(antigravityParser(), lines).filter((e) => e.type === 'progress')
    expect(progress.length).toBe(5)
    expect(progress[0]).toEqual({ type: 'progress', tokens: 8068, cacheRead: 0 })
    expect(progress.at(-1)).toMatchObject({ tokens: 38391, cacheRead: 4036 })
  })

  it('reports the web search it ran, and nothing for the denied tools', () => {
    const web = feed(antigravityParser(), lines).filter((e) => e.type === 'web')
    expect(web).toEqual([{ type: 'web', action: 'search', detail: 'antigravity cli' }])
  })

  it('keeps text from separate model calls as paragraphs', () => {
    const step = (i: number, delta: string): string => JSON.stringify({ event: 'step_update', step_update: { step_index: i, state: 'DONE', step_type: 'agent_response', text_delta: delta } })
    const done = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Pronto.', usage: {} } })
    expect(text(feed(antigravityParser(), [step(1, 'Vou ver.'), step(3, 'Pronto.'), done]))).toBe('Vou ver.\n\nPronto.')
  })

  it('turns a result that is not a success into an error', () => {
    const bad = JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota exceeded' } })
    expect(feed(antigravityParser(), [bad])).toEqual([{ type: 'error', message: 'quota exceeded' }])
    const canceled = JSON.stringify({ event: 'result', result: { status: 'CANCELED' } })
    expect((feed(antigravityParser(), [canceled])[0] as { message: string }).message).toMatch(/CANCELED/)
  })

  it('reports an exit without a result, and says to sign in when that was it', () => {
    const quota = feed(antigravityParser(), [lines[0]!], 1, 'boom\nquota exceeded')
    expect(quota).toHaveLength(1)
    expect((quota[0] as { message: string }).message).toContain('quota exceeded')
    const signedOut = feed(antigravityParser(), [], 1, 'Error: authentication required')
    expect((signedOut[0] as { message: string }).message).toMatch(/agy/)
  })

  it('ignores unknown lines', () => {
    expect(feed(antigravityParser(), ['{"event":"something_new"}', 'not json'], 0)).toHaveLength(1) // only the "no result" error
  })
})

describe('Antigravity config', () => {
  it('runs headless with stream-json both ways and slash commands off, never skipping permissions', () => {
    const args = antigravityArgs('gemini-4-argon-medium')
    expect(args).toEqual(['--output-format', 'stream-json', '--input-format', 'stream-json', '--disable-slash-commands', '--model', 'gemini-4-argon-medium'])
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(antigravityInput('oi\n"x"')).toBe('{"event":"user","message":{"content":"oi\\n\\"x\\""}}\n')
  })

  it("denies the CLI's own shell, files and browser, and allows the gateway's tools", () => {
    const s = antigravitySettings({ mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }) as { permissions: { allow: string[]; deny: string[] } }
    expect(s.permissions.allow).toEqual(['mcp(tucano/*)'])
    expect(s.permissions.deny).toEqual(['command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'execute_url(*)', 'read_url(*)'])
    expect(s).not.toHaveProperty('toolPermission') // strict ends the turn with no reply at the first denied tool
  })

  it('lets it read pages only when the agent has the web', () => {
    const s = antigravitySettings({ mcpUrl: undefined, web: true }) as { permissions: { allow: string[]; deny: string[] } }
    expect(s.permissions.allow).toEqual(['read_url(*)'])
    expect(s.permissions.deny).not.toContain('read_url(*)')
    expect(s.permissions.deny).toContain('execute_url(*)') // the browser is Tucano's own
  })

  it("gives each turn its own home and workspace: the gateway, the instructions and, on a Mac, only the keychain", () => {
    const real = mkdtempSync(join(tmpdir(), 'ag-real-'))
    mkdirSync(join(real, 'Library', 'Keychains'), { recursive: true })
    writeFileSync(join(real, 'Library', 'Keychains', 'login.keychain-db'), 'secret')
    mkdirSync(join(real, '.gemini', 'config'), { recursive: true })
    writeFileSync(join(real, '.gemini', 'config', 'mcp_config.json'), '{"mcpServers":{"mine":{"command":"rm"}}}')
    const appDir = mkdtempSync(join(tmpdir(), 'ag-app-'))
    const dirs = antigravityTurnDirs(appDir, { system: 'You are Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, 'mac', real)
    expect(dirs.root.startsWith(appDir)).toBe(true)
    expect(JSON.parse(readFileSync(join(dirs.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'))).toEqual({ mcpServers: { tucano: { url: 'http://127.0.0.1:1/mcp/x' } } })
    expect(JSON.parse(readFileSync(join(dirs.home, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'))).toEqual(antigravitySettings({ mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }))
    expect(readFileSync(join(dirs.workspace, 'GEMINI.md'), 'utf8')).toBe('You are Iris.')
    expect(readFileSync(join(dirs.home, 'Library', 'Keychains', 'login.keychain-db'), 'utf8')).toBe('secret')
    expect(readdirSync(join(dirs.home, 'Library'))).toEqual(['Keychains'])
    const linux = antigravityTurnDirs(appDir, { system: 'x', mcpUrl: undefined, web: false }, 'linux', real)
    expect(existsSync(join(linux.home, 'Library'))).toBe(false)
    expect(JSON.parse(readFileSync(join(linux.home, '.gemini', 'config', 'mcp_config.json'), 'utf8'))).toEqual({ mcpServers: {} })
    expect(linux.root).not.toBe(dirs.root)
  })

  it('puts instructions too long for a rules file at the top of the prompt instead', () => {
    const long = 'x'.repeat(RULES_MAX + 1)
    const dirs = antigravityTurnDirs(mkdtempSync(join(tmpdir(), 'ag-long-')), { system: long, mcpUrl: undefined, web: false }, 'linux')
    expect(existsSync(join(dirs.workspace, 'GEMINI.md'))).toBe(false)
    expect(antigravityPrompt({ system: long, prompt: 'oi' })).toBe(`<instructions>\n${long}\n</instructions>\n\noi`)
    expect(antigravityPrompt({ system: 'curto', prompt: 'oi' })).toBe('oi')
  })

  it('tells the agent when images could not go along', () => {
    const img = join(mkdtempSync(join(tmpdir(), 'ag-img-')), 'a.png')
    writeFileSync(img, 'png')
    expect(antigravityPrompt({ system: 's', prompt: 'oi', images: [{ block: 0, path: img, mime: 'image/png' }] })).toMatch(/^oi\n\n\(.*(imagens|images)/s)
  })

  it('moves the home on Linux and Windows but keeps their app-data folders', () => {
    expect(antigravityHomeEnv('/t/h', 'mac', '/Users/e', {})).toEqual({ HOME: '/t/h' })
    expect(antigravityHomeEnv('/t/h', 'linux', '/home/e', {})).toEqual({ HOME: '/t/h', XDG_CONFIG_HOME: join('/home/e', '.config') })
    const win = antigravityHomeEnv('/t/h', 'windows', 'C:/Users/e', { APPDATA: 'C:/R' })
    expect(win).toMatchObject({ HOME: '/t/h', USERPROFILE: '/t/h', APPDATA: 'C:/R', LOCALAPPDATA: join('C:/Users/e', 'AppData', 'Local') })
  })

  it("takes the model id alone, and an old Gemini CLI id as the Antigravity one it became", () => {
    expect(antigravityModel('antigravity/gemini-4-argon-high')).toBe('gemini-4-argon-high')
    expect(antigravityModel('gemini/gemini-2.5-pro')).toBe('gemini-4-argon-medium')
    expect(antigravityModel('gemini-3.8-flash')).toBe('gemini-3.8-flash-medium')
  })

  it('lists the models from agy models, and none when signed out', () => {
    const out = 'Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n'
    expect(parseAntigravityModels(out)).toEqual(['antigravity/gemini-4-argon-medium', 'antigravity/claude-opus-5-5-high'])
    expect(parseAntigravityModels('Fetching available models...\nError: Please sign in to view available models.')).toEqual([])
  })
})

describe('Cursor stream', () => {
  const answer = 'Vou consultar a hora no servidor tucano e a versão LTS atual do Node.js.\n\nSão 21:58 no Tucano e a LTS atual do Node.js é a 26.13.0 (Lithium).\n\n— Lia'

  it('streams the deltas once (not the whole message that repeats them), with paragraphs around tool calls', () => {
    const events = feed(cursorParser(), fixture('cursor-stream.jsonl'))
    expect(text(events)).toBe(answer)
    expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done', text: answer })
  })

  it('reports the usage the CLI gives, cache reads and writes counted as sent', () => {
    const done = feed(cursorParser(), fixture('cursor-stream.jsonl')).find((e) => e.type === 'done')
    expect(done).toMatchObject({ usage: { inputTokens: 12277 + 31744, cacheReadTokens: 31744, outputTokens: 338 } })
  })

  it("reports a web search that ran, not the gateway's tools", () => {
    const web = feed(cursorParser(), fixture('cursor-stream.jsonl')).filter((e) => e.type === 'web')
    expect(web).toEqual([{ type: 'web', action: 'search', detail: 'Node.js current LTS version' }])
  })

  it("doesn't report a web read the permissions refused", () => {
    const refused = '{"type":"tool_call","subtype":"completed","tool_call":{"webFetchToolCall":{"args":{"url":"https://nodejs.org"},"result":{"permissionDenied":{}}}}}'
    const ran = '{"type":"tool_call","subtype":"completed","tool_call":{"webFetchToolCall":{"args":{"url":"https://nodejs.org"},"result":{"success":{}}}}}'
    expect(feed(cursorParser(), [refused]).filter((e) => e.type === 'web')).toEqual([])
    expect(feed(cursorParser(), [ran]).filter((e) => e.type === 'web')).toEqual([{ type: 'web', action: 'fetch', detail: 'https://nodejs.org' }])
  })

  it('takes the whole message when no deltas came', () => {
    const whole = '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]},"model_call_id":"m1","timestamp_ms":1}'
    const last = '{"type":"assistant","message":{"content":[{"type":"text","text":"OK"}]}}'
    const result = '{"type":"result","subtype":"success","is_error":false,"result":"OK","usage":{"inputTokens":10,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0}}'
    const events = feed(cursorParser(), [whole, last, result])
    expect(text(events)).toBe('OK')
    expect(events.find((e) => e.type === 'done')).toMatchObject({ text: 'OK' })
  })

  it('estimates the usage when the CLI gives none: the characters sent and received, about 4 a token, the sent part doubled', () => {
    const delta = '{"type":"assistant","message":{"content":[{"type":"text","text":"12345678"}]},"timestamp_ms":1}'
    const result = '{"type":"result","subtype":"success","is_error":false,"result":"12345678"}'
    const done = feed(cursorParser(400), [delta, result]).find((e) => e.type === 'done')
    expect(done).toMatchObject({ usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 2 } })
  })

  it('turns an error result into an error, and an exit without a result too', () => {
    const bad = '{"type":"result","subtype":"error","is_error":true,"result":"You have hit your usage limit"}'
    expect(feed(cursorParser(), [bad])).toEqual([{ type: 'error', message: 'You have hit your usage limit' }])
    const gone = feed(cursorParser(), ['{"type":"system","subtype":"init"}'], 1, 'boom\nnot logged in')
    expect(gone).toHaveLength(1)
    expect((gone[0] as { message: string }).message).toContain('not logged in')
  })
})

describe('Cursor config', () => {
  it('runs headless with deltas, the prompt on stdin, the model named, and neither --force nor --approve-mcps', () => {
    const args = cursorArgs({ model: 'auto' })
    expect(args).toEqual(['-p', '--output-format', 'stream-json', '--stream-partial-output', '--trust', '--model', 'auto'])
    expect(args).not.toContain('--force')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--approve-mcps')
  })

  it('attaches the images that exist with --image, once per file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-cursor-img-'))
    const a = join(dir, 'a.png')
    const b = join(dir, 'b.jpg')
    writeFileSync(a, 'x')
    writeFileSync(b, 'y')
    const images = [
      { block: 0, path: a, mime: 'image/png' },
      { block: 1, path: join(dir, 'gone.png'), mime: 'image/png' },
      { block: 2, path: b, mime: 'image/jpeg' }
    ]
    expect(cursorArgs({ model: 'auto', images }).slice(7)).toEqual(['--image', a, '--image', b])
  })

  it('knows when the CLI refused --image itself', () => {
    expect(imageRefused("Cursor exited without a reply (code 1).\nerror: unknown option '--image'")).toBe(true)
    expect(imageRefused("error: unknown option '--imagex'")).toBe(false)
    expect(imageRefused('You have hit your usage limit')).toBe(false)
    expect(imageRefused('Could not read --image file')).toBe(false)
  })


  it("denies Cursor's own files and shell, and allows only the gateway", () => {
    const c = cursorConfig({ mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }) as { permissions: { allow: string[]; deny: string[] }; autoAcceptWebSearch: boolean }
    expect(c.permissions.allow).toEqual(['Mcp(tucano:*)'])
    expect(c.permissions.deny).toEqual(['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)'])
    expect(c.autoAcceptWebSearch).toBe(false)
  })

  it('lets the web in only when the agent has it', () => {
    const c = cursorConfig({ mcpUrl: undefined, web: true }) as { permissions: { allow: string[]; deny: string[] }; autoAcceptWebSearch: boolean }
    expect(c.permissions.allow).toEqual(['WebFetch(*)'])
    expect(c.permissions.deny).toEqual(['Read(**)', 'Write(**)', 'Shell(*)'])
    expect(c.autoAcceptWebSearch).toBe(true)
  })

  it('gives each turn its own folder: the config, the instructions as AGENTS.md, the gateway as the only MCP server', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'cu-'))
    const a = cursorTurnDirs(appDir, { system: 'You are Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false })
    const b = cursorTurnDirs(appDir, { system: 'You are Theo.', mcpUrl: undefined, web: false })
    expect(a.root).not.toBe(b.root)
    expect(a.root.startsWith(appDir)).toBe(true)
    expect(a.data.startsWith(a.root)).toBe(true)
    expect(readFileSync(join(a.workspace, 'AGENTS.md'), 'utf8')).toBe('You are Iris.')
    expect(JSON.parse(readFileSync(join(a.workspace, '.cursor', 'mcp.json'), 'utf8'))).toEqual({ mcpServers: { tucano: { url: 'http://127.0.0.1:1/mcp/x' } } })
    expect(JSON.parse(readFileSync(join(a.config, 'cli-config.json'), 'utf8')).permissions.deny).toContain('Shell(*)')
    expect(() => readFileSync(join(b.workspace, '.cursor', 'mcp.json'))).toThrow()
  })

  // The CLI reads hooks, plugins and skills from the home folder: a turn gets one of its own.
  it("gives each turn an empty home, with only the way to the person's login", () => {
    const real = join('/h', 'eduar')
    const turnHome = join('/t', 'home')
    const app = join('/app', 'cursor')
    const mac = cursorHomeEnv(turnHome, app, 'mac', real, {})
    expect(mac).toEqual({ HOME: turnHome, NODE_COMPILE_CACHE: join(app, 'compile-cache') })
    // Linux: the login is a file under XDG_CONFIG_HOME, which stays the person's.
    expect(cursorHomeEnv(turnHome, app, 'linux', real, {})['XDG_CONFIG_HOME']).toBe(join(real, '.config'))
    expect(cursorHomeEnv(turnHome, app, 'linux', real, { XDG_CONFIG_HOME: '/x/conf' })['XDG_CONFIG_HOME']).toBe('/x/conf')
    expect(cursorHomeEnv(turnHome, app, 'linux', real, {})['HOME']).toBe(turnHome)
    // Windows: the home is USERPROFILE; the login is under %APPDATA%, which stays the person's.
    const win = cursorHomeEnv(turnHome, app, 'windows', real, { APPDATA: 'C:/Users/e/AppData/Roaming' })
    expect(win['USERPROFILE']).toBe(turnHome)
    expect(win['APPDATA']).toBe('C:/Users/e/AppData/Roaming')
    expect(win['LOCALAPPDATA']).toBe(join(real, 'AppData', 'Local'))
    expect(cursorHomeEnv(turnHome, app, 'windows', real, {})['APPDATA']).toBe(join(real, 'AppData', 'Roaming'))
  })

  // Symlinks need privileges on Windows; the link is only made on macOS.
  it.skipIf(process.platform === 'win32')('links only the keychain into the home on macOS, and the cleanup leaves what it points to', async () => {
    const real = mkdtempSync(join(tmpdir(), 'cu-real-'))
    mkdirSync(join(real, 'Library', 'Keychains'), { recursive: true })
    writeFileSync(join(real, 'Library', 'Keychains', 'login.keychain-db'), 'secret')
    mkdirSync(join(real, '.claude'), { recursive: true })
    const appDir = mkdtempSync(join(tmpdir(), 'cu-'))
    const dirs = cursorTurnDirs(appDir, { system: 'x', mcpUrl: undefined, web: false }, 'mac', real)
    expect(dirs.home.startsWith(dirs.root)).toBe(true)
    expect(readdirSync(dirs.home)).toEqual(['Library'])
    expect(readdirSync(join(dirs.home, 'Library'))).toEqual(['Keychains'])
    expect(lstatSync(join(dirs.home, 'Library', 'Keychains')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dirs.home, 'Library', 'Keychains', 'login.keychain-db'), 'utf8')).toBe('secret')
    await cursorCleanup(dirs)
    expect(existsSync(dirs.root)).toBe(false)
    expect(readFileSync(join(real, 'Library', 'Keychains', 'login.keychain-db'), 'utf8')).toBe('secret')
    // Elsewhere the home stays empty.
    const linux = cursorTurnDirs(appDir, { system: 'x', mcpUrl: undefined, web: false }, 'linux', real)
    expect(readdirSync(linux.home)).toEqual([])
  })

  it('names a workspace the way the CLI does', () => {
    expect(cursorSlug('/Users/x/Library/Application Support/Tucano/cursor/ab12/workspace')).toBe('Users-x-Library-Application-Support-Tucano-cursor-ab12-workspace')
  })

  // The worker's socket is a Unix socket: on Windows the turn doesn't look for it.
  it.skipIf(process.platform === 'win32')('finds its worker socket the way the CLI does', () => {
    // short: under <data>/projects
    expect(cursorWorkerSocket('/t/w', '/t/d')).toBe(join('/t/d', 'projects', 't-w', 'worker.sock'))
    // long: cut to 83 characters plus a hash (the CLI's rule, checked against a real run)
    const ws = '/Users/eduardo/Library/Application Support/Tucano/cursor/0011223344556677/workspace'
    const sock = cursorWorkerSocket(ws, '/Users/eduardo/Library/Application Support/Tucano/cursor/0011223344556677/d')
    expect(sock.startsWith('/Users/eduardo/Library/Application Support/Tucano/cursor/0011223344556677/d/Users-')).toBe(true)
    expect(sock).toMatch(/-[0-9a-f]{7}\/worker\.sock$/)
    expect(sock.length).toBeLessThanOrEqual(83 + 8 + '/worker.sock'.length)
  })

  it('reads the model list and the login', () => {
    expect(parseCursorModels('Available models\n\nauto - Auto (default)\ngpt-5.3-codex - Codex 5.3\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\n\nTip: use --model')).toEqual(['auto', 'gpt-5.3-codex', 'claude-opus-5-5-high'])
    expect(cursorSignedIn('✓ Logged in as someone@example.com', {})).toBe(true)
    expect(cursorSignedIn('Not logged in', {})).toBe(false)
    expect(cursorSignedIn('Not logged in', { CURSOR_API_KEY: 'k' })).toBe(true)
  })
})

describe.skipIf(process.platform === 'win32')('Cursor engine with images', () => {
  // A stand-in CLI: it takes `mcp enable`, and answers with what it was given.
  const fakeCli = (takesImages: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-cursor-cli-'))
    const bin = join(dir, 'cursor-agent')
    writeFileSync(
      bin,
      `#!/bin/sh
[ "$1" = mcp ] && exit 0
images=0
for a in "$@"; do [ "$a" = --image ] && images=$((images+1)); done
${takesImages ? '' : `[ $images -gt 0 ] && { echo "error: unknown option '--image'" >&2; exit 1; }`}
note=no
cat | grep -q 'Tucano:' && note=yes
echo '{"type":"result","subtype":"success","is_error":false,"result":"images='"$images"' note='"$note"'","usage":{"inputTokens":1,"outputTokens":1}}'
`,
      { mode: 0o755 }
    )
    return bin
  }
  const reply = async (bin: string, images: { block: number; path: string; mime: string }[]): Promise<EngineEvent[]> => {
    const app = mkdtempSync(join(tmpdir(), 'tucano-cursor-app-'))
    const turn = { model: 'auto', effort: 'medium' as const, system: 'You are Iris.', prompt: 'What is in the picture?', images, cwd: app, signal: new AbortController().signal }
    const out: EngineEvent[] = []
    for await (const ev of cursorEngine(() => bin, app).run(turn)) out.push(ev)
    return out
  }
  const picture = (): { block: number; path: string; mime: string }[] => {
    const p = join(mkdtempSync(join(tmpdir(), 'tucano-cursor-pic-')), 'p.png')
    writeFileSync(p, 'x')
    return [{ block: 0, path: p, mime: 'image/png' }]
  }

  it("runs the CLI with the turn's home, and the turn's folder goes afterwards", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-cursor-cli-'))
    const bin = join(dir, 'cursor-agent')
    writeFileSync(bin, `#!/bin/sh\n[ "$1" = mcp ] && exit 0\ncat >/dev/null\necho '{"type":"result","subtype":"success","is_error":false,"result":"'"$HOME|$CURSOR_CONFIG_DIR"'","usage":{"inputTokens":1,"outputTokens":1}}'\n`, { mode: 0o755 })
    const app = mkdtempSync(join(tmpdir(), 'tucano-cursor-app-'))
    const turn = { model: 'auto', effort: 'medium' as const, system: 'You are Iris.', prompt: 'Hi', cwd: app, signal: new AbortController().signal }
    const out: EngineEvent[] = []
    for await (const ev of cursorEngine(() => bin, app).run(turn)) out.push(ev)
    const done = out.find((e) => e.type === 'done')
    const [home, config] = (done && done.type === 'done' ? done.text : '').split('|')
    expect(home).not.toBe(homedir())
    expect(home!.startsWith(app)).toBe(true)
    expect(home).toBe(join(dirname(config!), 'home'))
    expect(existsSync(dirname(config!))).toBe(false)
  })

  it('sends the images along when the CLI takes them', async () => {
    const done = (await reply(fakeCli(true), picture())).find((e) => e.type === 'done')
    expect(done && done.type === 'done' && done.text).toBe('images=1 note=no')
  })

  it('runs again without them, and tells the agent, when the CLI refuses --image', async () => {
    const events = await reply(fakeCli(false), picture())
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    const done = events.find((e) => e.type === 'done')
    expect(done && done.type === 'done' && done.text).toBe('images=0 note=yes')
  })

  it('runs once, without --image, when there are no images', async () => {
    const done = (await reply(fakeCli(false), [])).find((e) => e.type === 'done')
    expect(done && done.type === 'done' && done.text).toBe('images=0 note=no')
  })
})

// Real output of GitHub Copilot CLI 1.0.105 (`--output-format json`), trimmed of
// local paths, the attachment's bytes and the long usage checkpoint.
describe('Copilot stream', () => {
  const usageFile = join(import.meta.dirname, 'fixtures', 'copilot-usage.json')

  it("streams the answer after a gateway tool call, and reports the usage file's tokens", () => {
    const events = feed(copilotParser(() => copilotUsage(usageFile)), fixture('copilot-stream.jsonl'))
    expect(text(events)).toBe('abacaxi')
    expect(events.filter((e) => e.type === 'web')).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'done', text: 'abacaxi', usage: { inputTokens: 8171, cacheReadTokens: 4061, outputTokens: 38 } })
  })

  it('leaves out the thinking and the tool-only messages, and reports the web reads that ran', () => {
    const events = feed(copilotParser(), fixture('copilot-web.jsonl'))
    const answer = '1. The title of https://example.com is **"Example Domain"**.\n2. The image, in five words: **Geometric black toucan with orange beak.**'
    expect(text(events)).toBe(answer)
    expect(events.at(-1)).toMatchObject({ type: 'done', text: answer })
    expect(events.filter((e) => e.type === 'web')).toEqual([
      { type: 'web', action: 'fetch', detail: 'https://example.com' },
      { type: 'web', action: 'fetch', detail: 'https://example.com' }
    ])
  })

  it('keeps messages around tool calls as paragraphs, and takes a whole message only when no deltas came for it', () => {
    const delta = (id: string, t: string): string => JSON.stringify({ type: 'assistant.message_delta', data: { messageId: id, deltaContent: t } })
    const whole = (id: string, t: string): string => JSON.stringify({ type: 'assistant.message', data: { messageId: id, content: t, toolRequests: [] } })
    const result = '{"type":"result","exitCode":0}'
    const events = feed(copilotParser(), [delta('m1', 'Vou '), delta('m1', 'olhar.'), whole('m1', 'Vou olhar.'), whole('m2', ''), whole('m3', 'Pronto.'), result])
    expect(text(events)).toBe('Vou olhar.\n\nPronto.')
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Vou olhar.\n\nPronto.' })
  })

  it('keeps every message that comes with no id, and still pairs its deltas with its whole text', () => {
    const delta = (t: string): string => JSON.stringify({ type: 'assistant.message_delta', data: { deltaContent: t } })
    const whole = (t: string): string => JSON.stringify({ type: 'assistant.message', data: { content: t } })
    const events = feed(copilotParser(), [delta('Vou '), delta('olhar.'), whole('Vou olhar.'), whole('Pronto.'), '{"type":"result","exitCode":0}'])
    expect(text(events)).toBe('Vou olhar.\n\nPronto.')
  })

  it("doesn't report a web read that failed", () => {
    const start = '{"type":"tool.execution_start","data":{"toolCallId":"t1","toolName":"web_fetch","arguments":{"url":"https://nodejs.org"}}}'
    const failed = '{"type":"tool.execution_complete","data":{"toolCallId":"t1","success":false}}'
    expect(feed(copilotParser(), [start, failed, '{"type":"result","exitCode":0}']).filter((e) => e.type === 'web')).toEqual([])
  })

  it('estimates the usage when the CLI wrote none: the characters sent and received, about 4 a token, the sent part doubled', () => {
    const lines = ['{"type":"assistant.message","data":{"messageId":"m1","content":"12345678"}}', '{"type":"result","exitCode":0}']
    expect(feed(copilotParser(() => undefined, 400), lines).at(-1)).toMatchObject({ usage: { inputTokens: 200, cacheReadTokens: 0, outputTokens: 2 } })
    expect(copilotUsage(join(tmpdir(), 'no-such-copilot-usage.json'))).toBeUndefined()
  })

  it('turns a failed result into an error, and an exit without a result too', () => {
    const bad = feed(copilotParser(), ['{"type":"result","exitCode":1}'], 1, 'Error: You are not authorized to use Copilot')
    expect(bad).toEqual([{ type: 'error', message: 'Error: You are not authorized to use Copilot' }])
    const gone = feed(copilotParser(), [], 1, 'Error: Model "gpt-5-mini" from --model flag is not available.')
    expect(gone).toHaveLength(1)
    expect((gone[0] as { message: string }).message).toContain('is not available')
  })

  it("isn't a reply when the result has no exit code, or says 0 from a process that failed", () => {
    const answer = '{"type":"assistant.message","data":{"messageId":"m1","content":"oi"}}'
    expect(feed(copilotParser(), [answer, '{"type":"result"}'], 0)).toMatchObject([{ type: 'text' }, { type: 'error' }])
    expect(feed(copilotParser(), [answer, '{"type":"result","exitCode":0}'], 1, 'Error: boom')).toEqual([{ type: 'text', delta: 'oi' }, { type: 'error', message: 'Error: boom' }])
  })

  it('knows when the model refused the reasoning effort', () => {
    expect(effortRefused('Copilot exited without a reply (code 1).\nError: Model "claude-haiku-4.5" does not support reasoning effort configuration (requested: "high").')).toBe(true)
    expect(effortRefused('Error: Model "gpt-5-mini" from --model flag is not available.')).toBe(false)
  })
})

describe('Copilot config', () => {
  const files = { mcpConfig: join('/t', 'mcp.json'), usage: join('/t', 'usage.json') }
  const tools = (args: string[]): string | undefined => args.find((a) => a.startsWith('--available-tools'))
  const after = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1]

  it('runs headless with JSON out, every tool allowed, and only the gateway available', () => {
    const args = copilotArgs({ model: 'claude-sonnet-5.5', effort: 'high', web: false }, files)
    expect(tools(args)).toBe('--available-tools=tucano')
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'json', '--allow-all-tools', '--disable-builtin-mcps', '--no-ask-user', '--no-auto-update']))
    expect(after(args, '--model')).toBe('claude-sonnet-5.5')
    expect(after(args, '--reasoning-effort')).toBe('high')
    expect(after(args, '--additional-mcp-config')).toBe(`@${files.mcpConfig}`)
    expect(after(args, '--usage-output-file')).toBe(files.usage)
    expect(args).not.toContain('--allow-all-urls')
    expect(args).not.toContain('--yolo')
    expect(args).not.toContain('--allow-all')
  })

  it('never leaves the tool list empty, even with no gateway and no web', () => {
    const args = copilotArgs({ model: 'gpt-5.5', effort: 'low', web: false }, { usage: files.usage })
    expect(tools(args)).toBe('--available-tools=tucano')
    expect(args).not.toContain('--additional-mcp-config')
  })

  it('lets web_fetch in only when the agent has the web, and leaves the effort out when there is none', () => {
    const args = copilotArgs({ model: 'gpt-5.5', effort: undefined, web: true }, files)
    expect(tools(args)).toBe('--available-tools=tucano,web_fetch')
    expect(args).toContain('--allow-all-urls')
    expect(args).not.toContain('--reasoning-effort')
  })

  it('attaches the images that exist, once per file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-copilot-img-'))
    const a = join(dir, 'a.png')
    writeFileSync(a, 'x')
    const images = [
      { block: 0, path: a, mime: 'image/png' },
      { block: 1, path: join(dir, 'gone.png'), mime: 'image/png' }
    ]
    const args = copilotArgs({ model: 'gpt-5.5', effort: 'low', web: false, images }, files)
    expect(args.filter((x) => x === '--attachment')).toHaveLength(1)
    expect(after(args, '--attachment')).toBe(a)
  })

  it('gives each turn its own folder: hooks off, the instructions as AGENTS.md, the gateway as the only MCP server', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'tucano-copilot-'))
    const userHome = mkdtempSync(join(tmpdir(), 'tucano-copilot-user-'))
    const a = copilotTurnDirs(appDir, { system: 'You are Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x' }, userHome)
    const b = copilotTurnDirs(appDir, { system: 'You are Theo.', mcpUrl: undefined }, userHome)
    expect(a.root).not.toBe(b.root)
    expect(a.root.startsWith(appDir)).toBe(true)
    expect([a.home, a.workspace, a.usage].every((p) => p.startsWith(a.root))).toBe(true)
    expect(readFileSync(join(a.workspace, 'AGENTS.md'), 'utf8')).toBe('You are Iris.')
    expect(JSON.parse(readFileSync(join(a.home, 'settings.json'), 'utf8'))).toMatchObject({ disableAllHooks: true })
    expect(JSON.parse(readFileSync(a.mcpConfig!, 'utf8'))).toEqual({ mcpServers: { tucano: { type: 'http', url: 'http://127.0.0.1:1/mcp/x', tools: ['*'] } } })
    expect(b.mcpConfig).toBeUndefined()
    expect(existsSync(join(a.home, 'config.json'))).toBe(false)
  })

  it("brings a copy of the person's config.json in (the login is there with no credential store), which the turn can rewrite", () => {
    const userHome = mkdtempSync(join(tmpdir(), 'tucano-copilot-user-'))
    writeFileSync(join(userHome, 'config.json'), '{"login":"edu"}')
    const d = copilotTurnDirs(mkdtempSync(join(tmpdir(), 'tucano-copilot-')), { system: '', mcpUrl: undefined }, userHome)
    expect(readFileSync(join(d.home, 'config.json'), 'utf8')).toBe('{"login":"edu"}')
    writeFileSync(join(d.home, 'config.json'), '{"login":"edu","firstLaunchAt":"now"}')
    expect(readFileSync(join(userHome, 'config.json'), 'utf8')).toBe('{"login":"edu"}')
  })

  it("runs with the turn's home, and none of the person's variables that change what the turn is", () => {
    const dirs = { root: join('/t'), home: join('/t', 'home') }
    const env = copilotEnv(dirs, {
      PATH: '/bin',
      GH_TOKEN: 'gho_x',
      COPILOT_HOME: '/h/.copilot',
      COPILOT_CUSTOM_INSTRUCTIONS_DIRS: '/h/notes',
      COPILOT_ASSISTED_APPROVAL: '1',
      COPILOT_ALLOW_ALL: 'true',
      COPILOT_PROVIDER_BASE_URL: 'http://gw'
    })
    expect(env).toEqual({ PATH: '/bin', GH_TOKEN: 'gho_x', COPILOT_HOME: dirs.home, GIT_CEILING_DIRECTORIES: dirs.root, COPILOT_PROVIDER_BASE_URL: 'http://gw' })
  })

  it("keeps git's search inside the turn's folder, even with the app's data inside a repository", () => {
    const repo = mkdtempSync(join(tmpdir(), 'tucano-copilot-repo-'))
    execFileSync('git', ['init', '-q'], { cwd: repo })
    const d = copilotTurnDirs(join(repo, 'data', 'copilot'), { system: '', mcpUrl: undefined }, mkdtempSync(join(tmpdir(), 'tucano-copilot-user-')))
    const inRepo = (env: NodeJS.ProcessEnv): boolean => spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: d.workspace, env }).status === 0
    expect(inRepo(process.env)).toBe(true)
    expect(inRepo(copilotEnv(d, process.env))).toBe(false)
  })

  it('reads the models from `copilot help config`', () => {
    const help = '  `logLevel`: log level.\n\n  `model`: AI model to use for Copilot CLI; can be changed.\n    - "claude-sonnet-5.5"\n    - "gpt-5.4-mini"\n    - "gemini-3.8-flash"\n\n  `contextTier`: context window tier.\n    - "default"\n'
    expect(parseCopilotModels(help)).toEqual(['claude-sonnet-5.5', 'gpt-5.4-mini', 'gemini-3.8-flash'])
    expect(parseCopilotModels('nothing here')).toEqual([])
  })
})

// The stand-in CLI is a Node script so it runs on every system.
describe('Copilot engine', () => {
  const fakeCopilot = (refusesEffort: boolean): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-copilot-cli-'))
    const script = join(dir, 'fake-copilot.mjs')
    writeFileSync(
      script,
      [
        "import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'",
        "import { join } from 'node:path'",
        'const args = process.argv.slice(2)',
        "appendFileSync(join(import.meta.dirname, 'calls.log'), 'x')",
        `if (${refusesEffort} && args.includes('--reasoning-effort')) {`,
        "  process.stderr.write('Error: Model \"m\" does not support reasoning effort configuration (requested: \"medium\").\\n')",
        '  process.exit(1)',
        '}',
        "const prompt = readFileSync(0, 'utf8')",
        "writeFileSync(args[args.indexOf('--usage-output-file') + 1], JSON.stringify({ modelMetrics: { m: { usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 2 } } } }))",
        "const agents = existsSync('AGENTS.md') ? readFileSync('AGENTS.md', 'utf8') : 'noagents'",
        "const said = [prompt, process.env.COPILOT_HOME ? 'home' : 'nohome', agents, args.includes('--reasoning-effort') ? 'effort' : 'noeffort'].join('|')",
        "console.log(JSON.stringify({ type: 'assistant.message', data: { messageId: 'm1', content: said } }))",
        "console.log(JSON.stringify({ type: 'result', exitCode: 0 }))"
      ].join('\n')
    )
    const win = process.platform === 'win32'
    const bin = join(dir, win ? 'copilot.cmd' : 'copilot')
    writeFileSync(bin, win ? `@node "${script}" %*\r\n` : `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 })
    return bin
  }
  const reply = async (bin: string, app: string): Promise<EngineEvent[]> => {
    const turn = { model: 'm', effort: 'medium' as const, system: 'You are Iris.', prompt: 'Oi', cwd: app, signal: new AbortController().signal }
    const out: EngineEvent[] = []
    for await (const ev of copilotEngine(() => bin, app).run(turn)) out.push(ev)
    return out
  }

  it("runs the CLI in the turn's folder with the instructions and the prompt, reads the usage file, and the folder goes afterwards", async () => {
    const app = mkdtempSync(join(tmpdir(), 'tucano copilot app-'))
    const events = await reply(fakeCopilot(false), app)
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Oi|home|You are Iris.|effort', usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 2 } })
    expect(readdirSync(app)).toEqual([])
  })

  it('runs again without the effort when the model takes none, and says nothing of the refusal', async () => {
    const events = await reply(fakeCopilot(true), mkdtempSync(join(tmpdir(), 'tucano-copilot-app-')))
    expect(events.filter((e) => e.type === 'error')).toEqual([])
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Oi|home|You are Iris.|noeffort' })
  })

  it('remembers a model that takes no effort, so its next turn runs once', async () => {
    const bin = fakeCopilot(true)
    const engine = copilotEngine(() => bin, mkdtempSync(join(tmpdir(), 'tucano-copilot-app-')))
    const turn = { model: 'm', effort: 'medium' as const, system: '', prompt: 'Oi', cwd: tmpdir(), signal: new AbortController().signal }
    const calls = (): number => readFileSync(join(dirname(bin), 'calls.log'), 'utf8').length
    for await (const _ of engine.run(turn));
    expect(calls()).toBe(2)
    for await (const _ of engine.run(turn));
    expect(calls()).toBe(3)
  })

  it("leaves no folder when the person's shell can't be read", async () => {
    const app = mkdtempSync(join(tmpdir(), 'tucano-copilot-app-'))
    const engine = copilotEngine(() => fakeCopilot(false), app, () => Promise.reject(new Error('shell gone')))
    const turn = { model: 'm', effort: 'low' as const, system: '', prompt: 'Oi', cwd: tmpdir(), signal: new AbortController().signal }
    await expect((async () => { for await (const _ of engine.run(turn)); })()).rejects.toThrow('shell gone')
    expect(readdirSync(app)).toEqual([])
  })

  it('clears the turn folders left from a day ago, and keeps the newer ones', () => {
    const app = mkdtempSync(join(tmpdir(), 'tucano-copilot-app-'))
    mkdirSync(join(app, 'old'))
    mkdirSync(join(app, 'new'))
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(join(app, 'old'), twoDaysAgo, twoDaysAgo)
    sweepCopilotTurns(app)
    expect(readdirSync(app)).toEqual(['new'])
    sweepCopilotTurns(join(app, 'missing'))
  })

  it("says so when the CLI isn't installed", async () => {
    const out: EngineEvent[] = []
    for await (const ev of copilotEngine(() => undefined, tmpdir()).run({ model: 'm', effort: 'low', system: '', prompt: '', cwd: tmpdir(), signal: new AbortController().signal })) out.push(ev)
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('error')
  })
})

// The fixture is the streaming-json shape from grok 1.0.70's headless docs, not a recorded turn.
describe('Grok stream', () => {
  it('streams the text and skips thoughts', () => {
    const events = feed(grokParser(), fixture('grok-stream.jsonl'))
    expect(text(events)).toBe('Vou consultar. São 21:58.')
    expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done', text: 'Vou consultar. São 21:58.' })
  })

  it('counts cache reads and writes as sent, and does not add reasoning on top of output', () => {
    const done = feed(grokParser(), fixture('grok-stream.jsonl')).find((e) => e.type === 'done')
    expect(done).toMatchObject({ usage: { inputTokens: 100 + 50 + 10, cacheReadTokens: 50, outputTokens: 20, apiCostUsd: 0.0123 } })
  })

  it('reports a web search once, when it completes, and not the gateway tools', () => {
    const web = feed(grokParser(), fixture('grok-stream.jsonl')).filter((e) => e.type === 'web')
    expect(web).toEqual([{ type: 'web', action: 'search', detail: 'Node.js LTS' }])
  })

  // Recorded from grok 1.0.70: a web search, a page read, and a gateway tool found with search_tool and called with use_tool.
  it('reads a recorded turn: its text, each web step once, a running total and the whole turn at the end', () => {
    const events = feed(grokParser(), fixture('grok-stream-recorded.jsonl'))
    const done = events.find((e) => e.type === 'done')
    expect(done && done.type === 'done' && done.text).toContain('Node.js')
    expect(done).toMatchObject({ usage: { inputTokens: 11445 + 16384, cacheReadTokens: 16384, outputTokens: 560, apiCostUsd: 0.039442 } })
    expect(events.filter((e) => e.type === 'web')).toEqual([
      { type: 'web', action: 'search', detail: 'Node.js current LTS version' },
      { type: 'web', action: 'fetch', detail: 'https://nodejs.org/en' }
    ])
    const totals = events.flatMap((e) => (e.type === 'progress' ? [e.tokens] : []))
    expect(totals.slice(0, 3)).toEqual([2767 + 1152 + 189, 2767 + 1152 + 189 + 7608 + 3840 + 113, 2767 + 1152 + 189 + 7608 + 3840 + 113 + 1070 + 11392 + 258])
    expect(totals.at(-1)).toBe(11445 + 16384 + 560)
  })

  it('reports a finished page read, and not one still running', () => {
    const running = '{"type":"tool_call","toolCallId":"f1","toolName":"web_fetch","status":"in_progress","rawInput":{"url":"https://nodejs.org"}}'
    const done = '{"type":"tool_call_update","toolCallId":"f1","status":"completed"}'
    expect(feed(grokParser(), [running]).filter((e) => e.type === 'web')).toEqual([])
    expect(feed(grokParser(), [running, done]).filter((e) => e.type === 'web')).toEqual([{ type: 'web', action: 'fetch', detail: 'https://nodejs.org' }])
  })

  it('estimates the usage when the CLI gives none', () => {
    const end = '{"type":"end","stopReason":"end_turn","text":"12345678"}'
    const done = feed(grokParser(400), [end]).find((e) => e.type === 'done')
    expect(done).toMatchObject({ text: '12345678', usage: { inputTokens: 100, cacheReadTokens: 0, outputTokens: 2 } })
  })

  it('turns an error line, a refusal and an exit without an end into errors', () => {
    expect(feed(grokParser(), ['{"type":"error","message":"Not signed in"}'])).toEqual([{ type: 'error', message: 'Not signed in' }])
    expect(feed(grokParser(), ['{"type":"end","stopReason":"refusal"}'])[0]).toMatchObject({ type: 'error' })
    const gone = feed(grokParser(), ['{"type":"text","data":"oi"}'], 1, 'boom\nnot signed in')
    expect(gone.some((e) => e.type === 'done')).toBe(false)
    expect((gone.find((e) => e.type === 'error') as { message: string }).message).toContain('not signed in')
  })
})

describe('Grok config', () => {
  const base = { model: 'grok-4.7', effort: 'high' as const, system: 'You are Iris.' }

  it('runs headless from a prompt file, with no -p, and names the model past a prefix', () => {
    const args = grokArgs({ ...base, model: 'grok:grok-4.7' }, '/tmp/prompt.txt', '/tmp/leader.sock')
    expect(args).toContain('--output-format')
    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-json')
    expect(args[args.indexOf('--model') + 1]).toBe('grok-4.7')
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('high')
    expect(args[args.indexOf('--system-prompt-override') + 1]).toBe('You are Iris.')
    expect(args[args.indexOf('--prompt-file') + 1]).toBe('/tmp/prompt.txt')
    expect(args[args.indexOf('--leader-socket') + 1]).toBe('/tmp/leader.sock')
    expect(args).not.toContain('-p')
    const withGateway = grokArgs({ ...base, mcpUrl: 'http://127.0.0.1:1/mcp/x' }, 'p.txt', 's.sock')
    expect(withGateway[withGateway.indexOf('--system-prompt-override') + 1]).toMatch(/^You are Iris\.\n\n.*tucano__lembrar/s)
    expect(args).toContain('--no-subagents')
    expect(args).toContain('--no-plan')
    expect(args).toContain('--no-wait-for-background')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
  })

  it('keeps only the gateway tools, and the web only when the agent has it', () => {
    const off = grokArgs({ ...base, web: false }, 'p.txt', 's.sock')
    const on = grokArgs({ ...base, web: true }, 'p.txt', 's.sock')
    const list = (args: string[], flag: string): string[] => (args[args.indexOf(flag) + 1] ?? '').split(',').filter(Boolean)
    const deny = (args: string[]): string[] => args.flatMap((a, i) => (a === '--deny' ? [args[i + 1]!] : []))
    expect(list(off, '--tools')).toEqual(['search_tool', 'use_tool'])
    expect(list(on, '--tools')).toEqual(['search_tool', 'use_tool', 'web_search', 'web_fetch'])
    expect(list(off, '--disallowed-tools')).toEqual(expect.arrayContaining(['run_terminal_command', 'web_search', 'WebFetch', 'XSearch']))
    expect(list(on, '--disallowed-tools')).toEqual(expect.arrayContaining(['run_terminal_command', 'XSearch']))
    for (const name of ['web_search', 'web_fetch', 'WebSearch', 'WebFetch']) expect(list(on, '--disallowed-tools')).not.toContain(name)
    expect(off).toContain('--disable-web-search')
    expect(on).not.toContain('--disable-web-search')
    expect(deny(off)).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'WebFetch'])
    expect(deny(on)).toEqual(['Bash', 'Read', 'Write', 'Edit', 'Grep'])
  })

  it('strips an API key when the subscription login is named, and keeps it otherwise', () => {
    const baseEnv = { PATH: '/bin', XAI_API_KEY: 'secret', GROK_CODE_XAI_API_KEY: 'other', GROK_CONFIG: '/c', GROK_CONFIG_PATH: '/c2', GROK_AGENT: 'x' }
    const withAuth = grokTurnEnv(baseEnv, '/turn', '/real/auth.json')
    expect(withAuth['GROK_HOME']).toBe('/turn')
    expect(withAuth['HOME']).toBe('/turn')
    expect(grokTurnEnv(baseEnv, '/turn', undefined, 'darwin')['USERPROFILE']).toBeUndefined()
    expect(grokTurnEnv(baseEnv, '/turn', undefined, 'win32')['USERPROFILE']).toBe('/turn')
    expect(withAuth['GROK_AUTH_PATH']).toBe('/real/auth.json')
    expect(withAuth['XAI_API_KEY']).toBeUndefined()
    expect(withAuth['GROK_CODE_XAI_API_KEY']).toBeUndefined()
    expect(withAuth['GROK_CONFIG']).toBeUndefined()
    expect(withAuth['GROK_CONFIG_PATH']).toBeUndefined()
    expect(withAuth['GROK_AGENT']).toBeUndefined()
    expect(withAuth['GROK_MEMORY']).toBe('0')
    expect(withAuth['GROK_WORKFLOWS']).toBe('0')
    expect(withAuth['GROK_CLAUDE_SKILLS_ENABLED']).toBe('false')
    expect(withAuth['GROK_CURSOR_HOOKS_ENABLED']).toBe('false')
    expect(withAuth['PATH']).toBe('/bin')
    const keyOnly = grokTurnEnv(baseEnv, '/turn')
    expect(keyOnly['XAI_API_KEY']).toBe('secret')
    expect(keyOnly['GROK_AUTH_PATH']).toBeUndefined()
  })

  it('writes the prompt as text, or as ACP blocks when an image exists', () => {
    expect(grokPrompt({ prompt: 'oi' })).toEqual({ name: 'prompt.txt', body: 'oi' })
    const dir = mkdtempSync(join(tmpdir(), 'tucano-grok-img-'))
    const png = join(dir, 'a.png')
    writeFileSync(png, Buffer.from([1, 2, 3]))
    const withImage = grokPrompt({ prompt: 'veja', images: [{ block: 0, path: png, mime: 'image/png' }, { block: 1, path: join(dir, 'gone.png'), mime: 'image/png' }] })
    expect(withImage.name).toBe('prompt.json')
    expect(JSON.parse(withImage.body)).toEqual([
      { type: 'text', text: 'veja' },
      { type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }
    ])
    expect(grokPrompt({ prompt: '   ', images: [{ block: 0, path: png, mime: 'image/png' }] }).body).toBe(JSON.stringify([{ type: 'image', mimeType: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }]))
  })

  it('points the turn config at the gateway and turns the other scans off', () => {
    const c = grokConfig({ mcpUrl: 'http://127.0.0.1:1/mcp/x"y' })
    expect(c).toContain('[mcp_servers.tucano]')
    expect(c).toContain('url = "http://127.0.0.1:1/mcp/x\\"y"')
    expect(c).toContain('enabled = true')
    expect(c).toContain('[compat.claude]')
    expect(c).toContain('skills = false')
    expect(c).toContain('[compat.cursor]')
    expect(c).toContain('[compat.codex]')
    expect(grokConfig({})).not.toContain('mcp_servers')
  })

  it('reads the model list and which login it is', () => {
    const listed = 'You are logged in with grok.com.\nDefault model: grok-4.7\nAvailable models:\n\n  * grok-4.7 (default)\n  - grok-4.7-build-fast\n  - grok-4.6\n  - grok-4.5\n'
    expect(parseGrokModels(listed)).toEqual(['grok-4.7', 'grok-4.7-build-fast', 'grok-4.6', 'grok-4.5'])
    expect(grokLogin(listed)).toEqual({ loggedIn: true, plan: true })
    // What grok 1.0.70 prints signed out (the models are still listed) and with only an API key.
    const models = '\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n'
    expect(grokLogin(`You are not authenticated.\n${models}`)).toEqual({ loggedIn: false, plan: false })
    expect(grokLogin(`You are using XAI_API_KEY.\n${models}`)).toEqual({ loggedIn: true, plan: false })
    expect(grokLogin('Not signed in. To authenticate without a browser, run: grok login --device-code')).toEqual({ loggedIn: false, plan: false })
    expect(userGrokHome({ GROK_HOME: '  /custom/grok  ' }, '/h')).toBe('/custom/grok')
    expect(userGrokHome({}, '/h')).toBe(join('/h', '.grok'))
  })

  it('puts the turn outside any checkout, and the cleanup leaves the login file', () => {
    const dirs = grokTurnDirs()
    expect(existsSync(dirs.work)).toBe(true)
    expect(dirs.work.startsWith(dirs.root)).toBe(true)
    expect(dirs.root).toContain('tucano-grok-')
    expect(dirs.socket.length).toBeLessThanOrEqual(100)
    const auth = join(mkdtempSync(join(tmpdir(), 'tucano-grok-auth-')), 'auth.json')
    writeFileSync(auth, 'secret')
    writeFileSync(join(dirs.root, 'config.toml'), 'x')
    grokCleanup(dirs)
    expect(existsSync(dirs.root)).toBe(false)
    expect(readFileSync(auth, 'utf8')).toBe('secret')
  })
})

describe.skipIf(process.platform === 'win32')('Grok engine', () => {
  const fakeCli = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-grok-cli-'))
    const bin = join(dir, 'grok')
    writeFileSync(
      bin,
      `#!/bin/sh
key=\${XAI_API_KEY-unset}
cfg=\${GROK_CONFIG-unset}
mem=\${GROK_MEMORY-unset}
auth=\${GROK_AUTH_PATH-unset}
pflag=no
prompt=
prev=
for a in "$@"; do
  [ "$a" = -p ] && pflag=yes
  [ "$prev" = --prompt-file ] && prompt=$a
  prev=$a
done
mcp=no
if [ -f "$GROK_HOME/config.toml" ] && grep -q 'mcp_servers.tucano' "$GROK_HOME/config.toml"; then mcp=yes; fi
img=no
if [ -n "$prompt" ] && grep -q '"type":"image"' "$prompt"; then img=yes; fi
printf '%s\\n' "{\\"type\\":\\"text\\",\\"data\\":\\"key=$key cfg=$cfg mem=$mem pflag=$pflag mcp=$mcp img=$img home=$GROK_HOME userhome=$HOME cwd=$(pwd) auth=$auth\\"}"
printf '%s\\n' '{"type":"end","stopReason":"end_turn","usage":{"input_tokens":4,"output_tokens":1}}'
`,
      { mode: 0o755 }
    )
    return bin
  }

  const run = async (bin: string | undefined, extra: { images?: { block: number; path: string; mime: string }[]; shell?: NodeJS.ProcessEnv } = {}): Promise<EngineEvent[]> => {
    const cwd = mkdtempSync(join(tmpdir(), 'tucano-grok-cwd-'))
    const turn = { model: 'grok-4.7', effort: 'medium' as const, system: 'You are Iris.', prompt: 'Oi', images: extra.images, cwd, mcpUrl: 'http://127.0.0.1:9/mcp/abc', signal: new AbortController().signal }
    const out: EngineEvent[] = []
    for await (const ev of grokEngine(() => bin, async () => extra.shell ?? {}).run(turn)) out.push(ev)
    return out
  }

  it('is missing when the CLI is not installed', async () => {
    const events = await run(undefined)
    expect(events).toEqual([expect.objectContaining({ type: 'error' })])
  })

  it("runs in its own home, drops an API key when the login file is named, and removes the turn folder", async () => {
    const authDir = mkdtempSync(join(tmpdir(), 'tucano-grok-real-'))
    const auth = join(authDir, 'auth.json')
    writeFileSync(auth, 'secret')
    const done = (await run(fakeCli(), { shell: { GROK_HOME: authDir, XAI_API_KEY: 'secret', GROK_CONFIG: '/nope' } })).find((e) => e.type === 'done')
    const body = done && done.type === 'done' ? done.text : ''
    expect(body).toContain('key=unset')
    expect(body).toContain('cfg=unset')
    expect(body).toContain('mem=0')
    expect(body).toContain('pflag=no')
    expect(body).toContain('mcp=yes')
    expect(body).toContain('img=no')
    expect(body).toContain(`auth=${auth}`)
    const home = /home=(\S+)/.exec(body)?.[1]
    const cwd = /cwd=(\S+)/.exec(body)?.[1]
    // macOS resolves /var to /private/var; the shell's pwd follows the link.
    const plain = (p: string): string => p.replace(/^\/private/, '')
    expect(home).toBeTruthy()
    expect(/userhome=(\S+)/.exec(body)?.[1]).toBe(home)
    expect(plain(cwd!)).toBe(plain(join(home!, 'work')))
    expect(existsSync(home!)).toBe(false)
    expect(readFileSync(auth, 'utf8')).toBe('secret')
  })

  it('sends an existing image as an ACP block', async () => {
    const png = join(mkdtempSync(join(tmpdir(), 'tucano-grok-pic-')), 'p.png')
    writeFileSync(png, 'x')
    const done = (await run(fakeCli(), { images: [{ block: 0, path: png, mime: 'image/png' }] })).find((e) => e.type === 'done')
    expect(done && done.type === 'done' && done.text).toContain('img=yes')
  })
})

// Recorded from cline 3.0.74 (--json) against a stand-in model and gateway: some text, a call to the
// gateway's lembrar, then the reply, two model calls.
describe('Cline stream', () => {
  it('streams the text of each model call as a paragraph, and ends with the whole of it', () => {
    const events = feed(clineParser(), fixture('cline-stream-recorded.jsonl'))
    expect(text(events)).toBe('Let me save that. \n\nHello from mock.')
    expect(events.find((e) => e.type === 'done')).toMatchObject({ type: 'done', text: 'Let me save that. \n\nHello from mock.' })
    expect(events.filter((e) => e.type === 'error')).toEqual([])
  })

  it('keeps a running total per model call, and the whole turn at the end, cache reads counted as sent', () => {
    const events = feed(clineParser(), fixture('cline-stream-recorded.jsonl'))
    expect(events.filter((e) => e.type === 'progress')).toEqual([
      { type: 'progress', tokens: 1000 + 20, cacheRead: 400 },
      { type: 'progress', tokens: 2200 + 25, cacheRead: 1400 }
    ])
    expect(events.find((e) => e.type === 'done')).toMatchObject({ usage: { inputTokens: 2200, cacheReadTokens: 1400, outputTokens: 25 } })
    // A cost of 0 (an unknown price) isn't a cost.
    const done = events.find((e) => e.type === 'done')
    expect(done && done.type === 'done' && 'apiCostUsd' in done.usage).toBe(false)
  })

  it('takes the cost when the CLI knows it', () => {
    const end = '{"type":"run_result","finishReason":"completed","usage":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":0,"totalCost":0.0042},"text":"ok"}'
    expect(feed(clineParser(), [end]).find((e) => e.type === 'done')).toMatchObject({ text: 'ok', usage: { inputTokens: 10, outputTokens: 2, apiCostUsd: 0.0042 } })
  })

  it("reports a page read or a web search once it ran, not a failed one, and not the gateway's tools", () => {
    const start = (id: string, name: string, input: object): string => JSON.stringify({ type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: name, toolCallId: id, input } })
    const end = (id: string, name: string, error?: string): string => JSON.stringify({ type: 'agent_event', event: { type: 'content_end', contentType: 'tool', toolName: name, toolCallId: id, ...(error ? { error } : {}) } })
    const web = feed(clineParser(), [
      start('a', 'fetch_web_content', { url: 'https://nodejs.org', prompt: 'LTS?' }),
      end('a', 'fetch_web_content'),
      start('b', 'web_search', { query: 'node lts' }),
      end('b', 'web_search'),
      start('c', 'fetch_web_content', { url: 'https://down.example' }),
      end('c', 'fetch_web_content', 'fetch failed'),
      start('d', 'tucano__lembrar', { fact: 'x' }),
      end('d', 'tucano__lembrar')
    ]).filter((e) => e.type === 'web')
    expect(web).toEqual([
      { type: 'web', action: 'fetch', detail: 'https://nodejs.org' },
      { type: 'web', action: 'search', detail: 'node lts' }
    ])
  })

  // Recorded from cline 3.0.74: a bad key, and a Cline account that isn't signed in.
  it("turns a failed run into the CLI's own error, from the event, the result or stderr", () => {
    const failed = [
      '{"type":"agent_event","event":{"type":"error","error":{"name":"Error","message":"invalid x-api-key"},"errorClass":"auth","recoverable":false,"iteration":1}}',
      '{"type":"run_result","finishReason":"error","iterations":1,"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalCost":0},"text":"invalid x-api-key"}'
    ]
    expect(feed(clineParser(), failed)).toEqual([{ type: 'error', message: 'invalid x-api-key' }])
    expect(feed(clineParser(), [failed[1]!])).toEqual([{ type: 'error', message: 'invalid x-api-key' }])
    const stderr = '{"ts":"2026-11-09T11:25:11.402Z","type":"error","message":"Unauthorized: re-authenticate your Cline account."}'
    expect(feed(clineParser(), [], 1, stderr)).toEqual([{ type: 'error', message: 'Unauthorized: re-authenticate your Cline account.' }])
    const gone = feed(clineParser(), ['{"type":"agent_event","event":{"type":"content_start","contentType":"text","text":"oi"}}'], 1, 'boom')
    expect(gone.some((e) => e.type === 'done')).toBe(false)
    expect((gone.find((e) => e.type === 'error') as { message: string }).message).toContain('boom')
  })

  it('a stopped run, or one with nothing said, is not a reply', () => {
    expect(feed(clineParser(), ['{"type":"run_result","finishReason":"aborted","text":""}'])[0]).toMatchObject({ type: 'error' })
    expect(feed(clineParser(), ['{"type":"run_result","finishReason":"completed","text":""}'])[0]).toMatchObject({ type: 'error' })
  })
})

describe('Cline config', () => {
  const base = { model: 'openai-compatible/mock-model', effort: 'high' as const, system: 'You are Pia.' }

  it('runs headless with the model, its provider, the effort and the instructions; never a key', () => {
    const args = clineArgs(base)
    expect(args).toContain('--json')
    expect(args[args.indexOf('--auto-approve') + 1]).toBe('true')
    expect(args[args.indexOf('--thinking') + 1]).toBe('high')
    expect(args[args.indexOf('--provider') + 1]).toBe('openai-compatible')
    expect(args[args.indexOf('--model') + 1]).toBe('mock-model')
    expect(args[args.indexOf('--system') + 1]).toBe('You are Pia.')
    // The prompt argument is a lead-in with a space (one word would be taken for a command); the conversation goes on stdin.
    expect(args.at(-1)).toBe(clineLead())
    expect(clineLead()).toMatch(/\s/)
    expect(args).not.toContain('-k')
    expect(args).not.toContain('--key')
    expect(args).not.toContain('--yolo')
  })

  it('splits the provider off the model, and keeps the rest of a Cline account model whole', () => {
    expect(clineModel('cline/anthropic/claude-sonnet-4.5')).toEqual({ provider: 'cline', model: 'anthropic/claude-sonnet-4.5' })
    expect(clineModel('anthropic/claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' })
    expect(clineModel('mock-model')).toEqual({ model: 'mock-model' })
    expect(clineArgs({ ...base, model: 'mock-model' })).not.toContain('--provider')
    expect(modelInfo(customModel('cline', 'cline/anthropic/claude-sonnet-4.5'))).toMatchObject({ engine: 'cline', id: 'cline/anthropic/claude-sonnet-4.5' })
  })

  it('turns off every built-in tool, and the web ones unless the agent has the web', () => {
    const off = clineSettings({}) as { disabledTools: string[]; tools: { web_search: { enabled: boolean } }; telemetryOptOut: boolean; autoUpdateEnabled: boolean }
    for (const tool of ['read_files', 'search_codebase', 'run_commands', 'editor', 'apply_patch', 'skills', 'ask_question', 'spawn_agent', 'team_spawn_teammate', 'team_run_task', 'fetch_web_content', 'web_search']) expect(off.disabledTools).toContain(tool)
    expect(off.tools.web_search.enabled).toBe(false)
    expect(off.telemetryOptOut).toBe(true)
    expect(off.autoUpdateEnabled).toBe(false)
    const web = clineSettings({ web: true }) as typeof off
    expect(web.disabledTools).toEqual(CLINE_OFF)
    expect(web.disabledTools).not.toContain('fetch_web_content')
    expect(web.tools.web_search.enabled).toBe(true)
  })

  it('has the gateway as the only MCP server, over streamable HTTP', () => {
    expect(clineMcp({ mcpUrl: 'http://127.0.0.1:9/mcp/abc' })).toEqual({ mcpServers: { tucano: { type: 'streamableHttp', url: 'http://127.0.0.1:9/mcp/abc' } } })
    expect(clineMcp({})).toEqual({ mcpServers: {} })
  })

  it('tells the agent its images were left out', () => {
    const png = join(mkdtempSync(join(tmpdir(), 'tucano-cline-pic-')), 'p.png')
    writeFileSync(png, 'x')
    expect(clinePrompt({ prompt: 'Oi' })).toBe('Oi')
    expect(clinePrompt({ prompt: 'Oi', images: [{ block: 0, path: png, mime: 'image/png' }] })).toMatch(/^Oi\n\n.*imag/s)
  })

  it("writes the turn's settings and gateway in a folder of its own, and the cleanup takes it all", () => {
    const app = mkdtempSync(join(tmpdir(), 'tucano-cline-app-'))
    const dirs = clineTurnDirs(app, { mcpUrl: 'http://127.0.0.1:9/mcp/abc', web: false })
    const settings = join(dirs.config, 'data', 'settings')
    expect(JSON.parse(readFileSync(join(settings, 'global-settings.json'), 'utf8')).disabledTools).toContain('run_commands')
    expect(JSON.parse(readFileSync(join(settings, 'cline_mcp_settings.json'), 'utf8')).mcpServers.tucano.url).toBe('http://127.0.0.1:9/mcp/abc')
    expect(dirs.config.startsWith(dirs.root) && dirs.work.startsWith(dirs.root)).toBe(true)
    expect(readdirSync(dirs.work)).toEqual([])
    clineCleanup(dirs)
    expect(existsSync(dirs.root)).toBe(false)
  })

  it("points a turn at its own home and the app's login, and drops what would send Cline elsewhere", () => {
    const dirs = { root: '/t/home', config: '/t/home/.cline', work: '/t/home/work' }
    const env = clineTurnEnv({ PATH: '/bin', HOME: '/Users/me', CLINE_DATA_DIR: '/Users/me/.cline/data', CLINE_MCP_SETTINGS_PATH: '/x.json', CLINE_HOOKS_DIR: '/h', CLINE_HUB_PORT: '1', ANTHROPIC_API_KEY: 'k', OneDrive: 'C:/od' }, dirs, '/app/cline/login/data/settings/providers.json', 'windows')
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/t/home', USERPROFILE: '/t/home', CLINE_DIR: '/t/home/.cline', CLINE_PROVIDER_SETTINGS_PATH: '/app/cline/login/data/settings/providers.json', CLINE_SESSION_BACKEND_MODE: 'local', ANTHROPIC_API_KEY: 'k' })
    for (const k of ['CLINE_DATA_DIR', 'CLINE_MCP_SETTINGS_PATH', 'CLINE_HOOKS_DIR', 'CLINE_HUB_PORT', 'OneDrive']) expect(env[k]).toBeUndefined()
    expect(clineTurnEnv({}, dirs, 'p', 'mac')['USERPROFILE']).toBeUndefined()
    expect(clineLoginEnv('/app/cline/login')).toEqual({ CLINE_DIR: '/app/cline/login', CLINE_SESSION_BACKEND_MODE: 'local' })
    expect(clineProvidersFile('/app/cline/login')).toBe(join('/app/cline/login', 'data', 'settings', 'providers.json'))
  })

  it("reads what the app's login is signed into, and the model each provider last ran, never a provider with no credentials", () => {
    const file = JSON.stringify({
      version: 1,
      lastUsedProvider: 'cline',
      providers: {
        cline: { settings: { provider: 'cline', model: 'anthropic/claude-sonnet-4.5', auth: { accessToken: 't', refreshToken: 'r' } } },
        anthropic: { settings: { provider: 'anthropic', model: 'claude-sonnet-4-5', apiKey: 'k' } },
        ollama: { settings: { provider: 'ollama', baseUrl: 'http://localhost:11434' } },
        bedrock: { settings: { provider: 'bedrock', model: 'x', aws: { profile: 'work' } } },
        // A run saves the provider and model it was asked for, signed in or not.
        openai: { settings: { provider: 'openai', model: 'gpt-5' } }
      }
    })
    expect(clineLogins(file)).toEqual({ providers: ['cline', 'anthropic', 'ollama', 'bedrock'], models: ['cline/anthropic/claude-sonnet-4.5', 'anthropic/claude-sonnet-4-5', 'bedrock/x'] })
    expect(clineLogins('not json')).toEqual({ providers: [], models: [] })
    expect(clineLogins('{"version":1,"providers":{}}')).toEqual({ providers: [], models: [] })
  })
})

describe.skipIf(process.platform === 'win32')('Cline engine', () => {
  // Says where it ran, what it was given and whether stdin is a file; then a reply.
  const fakeCli = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-cline-cli-'))
    const bin = join(dir, 'cline')
    writeFileSync(
      bin,
      `#!/bin/sh
kind=other
[ -f /dev/stdin ] && kind=file
input=$(cat | tr '\\n' ' ')
last=""
for a in "$@"; do last=$a; done
off=no
grep -q '"run_commands"' "$CLINE_DIR/data/settings/global-settings.json" && off=yes
mcp=no
grep -q '"tucano"' "$CLINE_DIR/data/settings/cline_mcp_settings.json" && mcp=yes
printf '%s\\n' "{\\"type\\":\\"agent_event\\",\\"event\\":{\\"type\\":\\"content_start\\",\\"contentType\\":\\"text\\",\\"text\\":\\"stdin=$kind input=$input| last=$last| off=$off mcp=$mcp home=$HOME clinedir=$CLINE_DIR prov=$CLINE_PROVIDER_SETTINGS_PATH data=\${CLINE_DATA_DIR-unset} cwd=$(pwd)\\"}}"
printf '%s\\n' '{"type":"run_result","finishReason":"completed","usage":{"inputTokens":4,"outputTokens":1,"cacheReadTokens":0,"totalCost":0}}'
`,
      { mode: 0o755 }
    )
    return bin
  }

  const run = async (bin: string | undefined, app: string, shell: NodeJS.ProcessEnv = {}): Promise<EngineEvent[]> => {
    const cwd = mkdtempSync(join(tmpdir(), 'tucano-cline-cwd-'))
    const turn = { model: 'cline/anthropic/claude-sonnet-4.5', effort: 'medium' as const, system: 'You are Pia.', prompt: 'Oi, tudo bem?', cwd, mcpUrl: 'http://127.0.0.1:9/mcp/abc', signal: new AbortController().signal }
    const out: EngineEvent[] = []
    for await (const ev of clineEngine(() => bin, app, async () => shell).run(turn)) out.push(ev)
    return out
  }

  it('is missing when the CLI is not installed', async () => {
    expect(await run(undefined, mkdtempSync(join(tmpdir(), 'tucano-cline-app-')))).toEqual([expect.objectContaining({ type: 'error' })])
  })

  it("runs in a home of its own on the app's login, the conversation in a stdin file, and removes the turn's folder", async () => {
    const app = mkdtempSync(join(tmpdir(), 'tucano-cline-app-'))
    const done = (await run(fakeCli(), app, { CLINE_DATA_DIR: '/Users/me/.cline/data' })).find((e) => e.type === 'done')
    const body = done && done.type === 'done' ? done.text : ''
    expect(body).toContain('stdin=file')
    expect(body).toContain('input=Oi, tudo bem?')
    expect(body).toContain(`last=${clineLead()}|`)
    expect(body).toContain('off=yes mcp=yes')
    expect(body).toContain('data=unset')
    expect(body).toContain(`prov=${join(app, 'login', 'data', 'settings', 'providers.json')}`)
    const home = /home=(\S+)/.exec(body)?.[1]
    const plain = (p: string): string => p.replace(/^\/private/, '')
    expect(home && plain(home).startsWith(plain(join(app, 'turns')))).toBe(true)
    expect(/clinedir=(\S+)/.exec(body)?.[1]).toBe(join(home!, '.cline'))
    expect(plain(/cwd=(\S+)/.exec(body)![1]!)).toBe(plain(join(home!, 'work')))
    expect(existsSync(home!)).toBe(false)
  })
})

describe.skipIf(process.platform === 'win32')('Cline detection', () => {
  it("finds the CLI, its version, and what the app's own login is signed into", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tucano-cline-bin-'))
    writeFileSync(join(dir, 'cline'), '#!/bin/sh\necho 3.0.74\n', { mode: 0o755 })
    const login = mkdtempSync(join(tmpdir(), 'tucano-cline-login-'))
    const path = process.env['PATH']
    process.env['PATH'] = `${dir}:${path}`
    try {
      const out = await detectCline(login)
      expect(out.status).toMatchObject({ installed: true, version: '3.0.74', loggedIn: false })
      expect(out.status.account).toContain('cline auth')
      mkdirSync(dirname(clineProvidersFile(login)), { recursive: true })
      writeFileSync(clineProvidersFile(login), JSON.stringify({ version: 1, providers: { cline: { settings: { provider: 'cline', model: 'anthropic/claude-sonnet-4.5', auth: { accessToken: 't' } } } } }))
      const signed = await detectCline(login)
      expect(signed.status).toMatchObject({ installed: true, loggedIn: true, route: 'providers' })
      expect(signed.status.account).toContain('Cline')
      expect(signed.models).toEqual(['cline/anthropic/claude-sonnet-4.5'])
    } finally {
      process.env['PATH'] = path
    }
  })
})
