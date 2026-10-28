import { describe, expect, it } from 'vitest'
import { parsePiModels } from '../src/core/engines/detect'
import { listModels, quietClaude, quietCodex, withChoice } from '../src/core/harness'
import type { EngineId, EngineStatus } from '../src/shared/types'

const ready: EngineStatus = { installed: true, loggedIn: true, route: 'plan' }
const engines: Record<EngineId, EngineStatus> = { claude: ready, codex: ready, opencode: { ...ready, route: 'providers' }, 'opencode-v2': { ...ready, route: 'providers' }, pi: { ...ready, route: 'providers' } }

describe('harnesses', () => {
  it('runs every ready harness the app supports when none was picked', () => {
    const out = withChoice(engines, undefined)
    expect(out.claude.loggedIn).toBe(true)
    expect(out.codex.loggedIn).toBe(true)
    expect(out.opencode.loggedIn).toBe(true)
    expect(out.pi.loggedIn).toBe(true)
  })

  it('turns off the harnesses the person left out', () => {
    const out = withChoice(engines, ['claude'])
    expect(out.claude.loggedIn).toBe(true)
    expect(out.codex).toMatchObject({ loggedIn: false, off: true })
  })

  it('turns telemetry off only for a harness on a gateway', () => {
    expect(quietClaude({ env: {} }).env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBeUndefined()
    expect(quietClaude({ env: { ANTHROPIC_BASE_URL: 'https://llm.acme.com' } }).env).toMatchObject({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1' })
    expect(quietCodex({ config: [], envNames: [] }).config).toEqual([])
    expect(quietCodex({ config: ['-c', 'model_provider="acme"'], envNames: [], baseUrl: 'https://llm.acme.com/v1' }).config).toContain('analytics.enabled=false')
  })

  it('reads the models Pi lists', () => {
    const out = 'provider       model               context  max-out\nanthropic      claude-sonnet-5     1M       128K\nopenrouter     moonshotai/kimi-k3  256K     32K\n'
    expect(parsePiModels(out)).toEqual(['anthropic/claude-sonnet-5', 'openrouter/moonshotai/kimi-k3'])
  })

  it('lists the models a gateway gives, on each API', async () => {
    const asked: { url: string; headers: Record<string, string> }[] = []
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      asked.push({ url, headers: init.headers })
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6-luna' }, { id: 'claude-sonnet-5-5' }, { id: 'gpt-5.6-luna' }] }))
    }) as unknown as typeof fetch
    expect(await listModels('codex', 'https://llm.acme.com/v1/', 'k', f)).toEqual(['claude-sonnet-5-5', 'gpt-5.6-luna'])
    await listModels('claude', 'https://llm.acme.com/anthropic', 'k', f)
    expect(asked.map((a) => a.url)).toEqual(['https://llm.acme.com/v1/models', 'https://llm.acme.com/anthropic/v1/models?limit=1000'])
    expect(asked[1]!.headers).toMatchObject({ 'x-api-key': 'k', authorization: 'Bearer k' })
  })
})
