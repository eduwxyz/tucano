import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Parser } from '../src/core/engines/cli'
import { claudeArgs, claudeInput, claudeParser, userProvider } from '../src/core/engines/claude'
import { CODEX_DISABLED_FEATURES, codexArgs, codexEnv, codexParser, userCodexProvider } from '../src/core/engines/codex'
import { geminiArgs, geminiEnv, geminiHome, geminiParser } from '../src/core/engines/gemini'
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
    const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(s['mcpServers']).toEqual({ tucano: { httpUrl: 'http://127.0.0.1:1/mcp/x' } })
    expect(s['coreTools']).toEqual([]) // no built-in tools, no web
    expect((s['experimental'] as Record<string, unknown>)['skills']).toEqual({ enabled: false })
    expect((s['privacy'] as Record<string, unknown>)['usageStatisticsEnabled']).toBe(false)
    // the agent's instructions are the system prompt, and the login is brought in
    expect(readFileSync(join(home, 'system.md'), 'utf8')).toBe('You are Iris.')
    expect(geminiEnv(home, { PATH: '/x' })).toEqual({ PATH: '/x', GEMINI_CLI_HOME: home, GEMINI_SYSTEM_MD: join(home, 'system.md') })
  })

  it('turns on only the web search when the agent has the web', () => {
    const home = geminiHome(mkdtempSync(join(tmpdir(), 'gh2-')), { system: 's', mcpUrl: undefined, web: true }, mkdtempSync(join(tmpdir(), 'gu2-')))
    const s = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
    expect(s['coreTools']).toEqual(['google_web_search'])
    expect(s['mcpServers']).toBeUndefined()
  })

  it('gives a different home each turn', () => {
    const appDir = mkdtempSync(join(tmpdir(), 'gh3-'))
    const userHome = mkdtempSync(join(tmpdir(), 'gu3-'))
    const a = geminiHome(appDir, { system: 'a', mcpUrl: undefined, web: false }, userHome)
    const b = geminiHome(appDir, { system: 'b', mcpUrl: undefined, web: false }, userHome)
    expect(a).not.toBe(b)
  })
})
