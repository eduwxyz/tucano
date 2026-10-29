import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { opencodeArgs, opencodeConfig, opencodeParser, stripJsonComments, userOpencodeProviders } from '../src/core/engines/opencode'

// Lines recorded from `opencode run --format json` (1.15), trimmed.
const STEP = '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","tokens":{"total":222,"input":204,"output":18,"reasoning":0,"cache":{"write":0,"read":0}}}}'
const TOOL = '{"type":"tool_use","part":{"type":"tool","tool":"webfetch","state":{"status":"completed","input":{"url":"https://example.com"},"output":"..."}}}'
const TEXT = '{"type":"text","part":{"type":"text","text":"São 13:37 no Tucano."}}'
const LAST = '{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":306,"input":200,"output":60,"reasoning":10,"cache":{"write":0,"read":46}}}}'
const ERROR = '{"type":"error","error":{"name":"APIError","data":{"message":"Model not found: openai/gpt-9"}}}'

describe('opencode', () => {
  it('turns its events into the engine events', () => {
    const p = opencodeParser()
    const events = [STEP, TOOL, TEXT, LAST].flatMap((l) => p.line(l))
    expect(events).toContainEqual({ type: 'web', action: 'fetch', detail: 'https://example.com' })
    expect(events).toContainEqual({ type: 'text', delta: 'São 13:37 no Tucano.' })
    expect(p.end(0, '')).toEqual([{ type: 'done', text: 'São 13:37 no Tucano.', usage: { inputTokens: 450, cacheReadTokens: 46, outputTokens: 88 } }])
  })

  it('reports the first error and nothing else', () => {
    const p = opencodeParser()
    expect(p.line(ERROR)).toEqual([{ type: 'error', message: 'Model not found: openai/gpt-9' }])
    expect(p.line('{"type":"error","error":{"name":"UnknownError"}}')).toEqual([])
    expect(p.end(0, '')).toEqual([])
  })

  it('gives it only the gateway tools, the web when allowed, and the system prompt', () => {
    const c = opencodeConfig({ system: 'Você é a Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, { provider: { acme: {} } })
    expect(c['tools']).toEqual({ '*': false, 'tucano_*': true, webfetch: false, websearch: false })
    expect(c['mcp']).toEqual({ tucano: { type: 'remote', url: 'http://127.0.0.1:1/mcp/x', enabled: true } })
    expect(c['agent']).toEqual({ tucano: { mode: 'primary', prompt: 'Você é a Iris.' } })
    expect(c['provider']).toEqual({ acme: {} })
    expect(opencodeArgs({ model: 'openai/gpt-5.6-luna' })).toEqual(['run', '--pure', '--format', 'json', '--agent', 'tucano', '-m', 'openai/gpt-5.6-luna'])
  })

  it('accumulates the cost V2 reports per step', () => {
    const p = opencodeParser()
    const withCost = '{"type":"step_finish","part":{"type":"step-finish","reason":"tool-calls","cost":0.0005,"tokens":{"total":222,"input":204,"output":18,"reasoning":0,"cache":{"write":0,"read":0}}}}'
    p.line(withCost)
    const [done] = p.end(0, '')
    expect(done).toMatchObject({ usage: { apiCostUsd: 0.0005 } })
  })

  it('still ends done when V2 emits no step_finish at all', () => {
    const p = opencodeParser()
    p.line(TEXT)
    expect(p.end(0, '')).toEqual([{ type: 'done', text: 'São 13:37 no Tucano.', usage: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } }])
  })

  it("takes only the providers from the user's opencode.jsonc", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'opencode.jsonc'), '{\n  // a comment\n  "provider": { "acme": { "options": { "baseURL": "https://llm.acme.com/v1" } } },\n  "mcp": { "x": {} },\n  "instructions": ["a.md"],\n}\n')
    expect(userOpencodeProviders(dir)).toEqual({ provider: { acme: { options: { baseURL: 'https://llm.acme.com/v1' } } } })
    expect(stripJsonComments('{"url": "http://x//y" /* c */}')).toBe('{"url": "http://x//y" }')
  })

  it("takes V2's providers shape too, for V2 only, and only the policies about providers", () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-'))
    const providers = { empresa: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://llm.acme.com/v1' } } }
    const policies = [{ action: 'provider.use', resource: 'empresa', effect: 'allow' }, { action: 'tool.use', resource: 'shell', effect: 'allow' }]
    writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ provider: { acme: {} }, providers, policies, mcp: { servers: {} } }))
    expect(userOpencodeProviders(dir, true)).toEqual({ provider: { acme: {} }, providers, policies: [policies[0]] })
    expect(userOpencodeProviders(dir)).toEqual({ provider: { acme: {} } })
  })
})
