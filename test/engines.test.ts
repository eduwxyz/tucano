import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Parser } from '../src/core/engines/cli'
import { claudeArgs, claudeInput, claudeParser, userProvider } from '../src/core/engines/claude'
import { CODEX_DISABLED_FEATURES, codexArgs, codexEnv, codexParser, userCodexProvider } from '../src/core/engines/codex'
import { detectGeminiCliModels, geminiArgs, geminiEnv, geminiHome, geminiModels, geminiParser } from '../src/core/engines/gemini'
import { cursorArgs, cursorCleanup, cursorConfig, cursorEngine, cursorHomeEnv, cursorParser, cursorSignedIn, cursorSlug, cursorWorkerSocket, cursorTurnDirs, imageRefused, parseCursorModels } from '../src/core/engines/cursor'
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
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { tucano: { type: 'http', url: 'http://127.0.0.1:1/mcp/abc' } } })
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__tucano')
    expect(args).toContain('--strict-mcp-config')
    expect(claudeArgs({ model: 'sonnet', effort: 'low', system: 'x' })).not.toContain('--mcp-config')
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
    expect(args[args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch')
    expect(args.slice(args.indexOf('--allowedTools') + 1)).toEqual(['mcp__tucano', 'WebSearch', 'WebFetch'])
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


describe('Gemini stream', () => {
  it('streams the assistant deltas as the answer and reports the usage from the result', () => {
    const events = feed(geminiParser(), fixture('gemini-stream.jsonl'))
    expect(text(events)).toBe('Deixa eu buscar. O dólar está R$ 5,10.')
    const done = events.find((e) => e.type === 'done')
    expect(done).toMatchObject({ type: 'done', text: 'Deixa eu buscar. O dólar está R$ 5,10.', usage: { inputTokens: 1000, cacheReadTokens: 34, outputTokens: 200 } })
  })

  it("reports the model's web search, and only that built-in", () => {
    const web = feed(geminiParser(), fixture('gemini-stream.jsonl')).filter((e) => e.type === 'web')
    expect(web).toEqual([{ type: 'web', action: 'search', detail: 'preço do dólar hoje' }])
  })

  it('turns an error result into an error event, and a warning is not fatal', () => {
    const warn = '{"type":"error","severity":"warning","message":"a slow tool"}'
    const bad = '{"type":"result","status":"error","error":{"type":"AuthError","message":"not signed in"}}'
    const events = feed(geminiParser(), [warn, bad])
    expect(events).toEqual([{ type: 'error', message: 'not signed in' }])
  })

  it('reports an error when the process exits without a result', () => {
    const events = feed(geminiParser(), ['{"type":"init","session_id":"s","model":"gemini-2.5-pro"}'], 1, 'boom\nquota exceeded')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error' })
    expect((events[0] as { message: string }).message).toContain('quota exceeded')
  })

  it('ignores the user echo and unknown lines', () => {
    const echo = '{"type":"message","role":"user","content":"oi"}'
    const unknown = '{"type":"something_new"}'
    expect(feed(geminiParser(), [echo, unknown, 'not json'], 0)).toHaveLength(1) // only the "no result" error
  })
})

describe('Gemini config', () => {
  it('runs headless with stream-json, auto-approving tools (the gateway decides), the model alone', () => {
    const args = geminiArgs({ model: 'gemini-2.5-pro' })
    expect(args).toEqual(['-p', '', '--output-format', 'stream-json', '--approval-mode', 'yolo', '-m', 'gemini-2.5-pro'])
  })

  it('gives each turn a fresh home with the gateway as its only MCP server and no built-in tools', () => {
    const userHome = mkdtempSync(join(tmpdir(), 'gu-'))
    writeFileSync(join(userHome, 'oauth_creds.json'), '{}')
    const appDir = mkdtempSync(join(tmpdir(), 'gh-'))
    const home = geminiHome(appDir, { system: 'You are Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, userHome)
    expect(home.startsWith(appDir)).toBe(true)
    // the CLI reads $GEMINI_CLI_HOME/.gemini/, so nothing goes at the root
    const s = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(existsSync(join(home, 'settings.json'))).toBe(false)
    expect(s['mcpServers']).toEqual({ tucano: { url: 'http://127.0.0.1:1/mcp/x', type: 'http', trust: true } })
    expect(existsSync(join(home, '.gemini', 'oauth_creds.json'))).toBe(true)
    expect(existsSync(join(home, 'oauth_creds.json'))).toBe(false)
    // keys as the CLI reads them: tools.core, not the old flat coreTools
    expect(s['tools']).toEqual({ core: [], discoveryCommand: '', callCommand: '' }) // no built-in tools, no web, no discovered tools
    expect(s['coreTools']).toBeUndefined()
    expect(s['mcp']).toEqual({ allowed: ['tucano'] })
    expect(s['skills']).toEqual({ enabled: false })
    expect(s['agents']).toEqual({ overrides: { codebase_investigator: { enabled: false }, cli_help: { enabled: false } } })
    expect((s['privacy'] as Record<string, unknown>)['usageStatisticsEnabled']).toBe(false)
    // nothing a working folder could turn into a command or a request: hooks, telemetry
    expect(s['hooksConfig']).toEqual({ enabled: false })
    expect(s['telemetry']).toEqual({ enabled: false, logPrompts: false })
    // the agent's instructions are the system prompt, and the login is brought in
    expect(readFileSync(join(home, 'system.md'), 'utf8')).toBe('You are Iris.')
    // the turn's settings are also the system settings, applied over the working folder's
    expect(geminiEnv(home, { PATH: '/x' })).toEqual({ PATH: '/x', GEMINI_CLI_HOME: home, GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(home, '.gemini', 'settings.json'), GEMINI_SYSTEM_MD: join(home, 'system.md') })
  })

  it('turns on only the web search when the agent has the web', () => {
    const home = geminiHome(mkdtempSync(join(tmpdir(), 'gh2-')), { system: 's', mcpUrl: undefined, web: true }, mkdtempSync(join(tmpdir(), 'gu2-')))
    const s = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(s['tools']).toEqual({ core: ['google_web_search'], discoveryCommand: '', callCommand: '' })
    expect(s['mcpServers']).toBeUndefined()
  })

  it('gives a different home each turn', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'gh3-'))
    const userHome = mkdtempSync(join(tmpdir(), 'gu3-'))
    const a = geminiHome(appDir, { system: 'a', mcpUrl: undefined, web: false }, userHome)
    const b = geminiHome(appDir, { system: 'b', mcpUrl: undefined, web: false }, userHome)
    expect(a).not.toBe(b)
  })

  it('lists default models when no bin path is provided', () => {
    const list = geminiModels()
    expect(list).toContain('gemini/gemini-3.8-flash')
    expect(list).toContain('gemini/gemini-3.1-pro-preview')
  })

  it('dynamically extracts models from an installed @google/gemini-cli package', () => {
    const root = mkdtempSync(join(tmpdir(), 'gemini-pkg-'))
    const bundle = join(root, 'node_modules', '@google', 'gemini-cli', 'bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(
      join(bundle, 'chunk-models.js'),
      'var defs = { "gemini-3.9-flash": { isVisible: true }, "gemini-4-pro": { isVisible: true }, "internal-hidden": { isVisible: false } };'
    )
    const bin = join(root, 'gemini.cmd')
    writeFileSync(bin, '@ECHO off')
    expect(detectGeminiCliModels(bin)).toEqual(['gemini/gemini-3.9-flash', 'gemini/gemini-4-pro'])
    expect(geminiModels(bin)).toEqual(['gemini/gemini-3.9-flash', 'gemini/gemini-4-pro'])
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
