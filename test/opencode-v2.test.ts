import { describe, expect, it } from 'vitest'
import { opencodeV2Args, opencodeV2Config } from '../src/core/engines/opencode-v2'

describe('opencode v2', () => {
  it('emits the native V2 config', () => {
    const c = opencodeV2Config({ system: 'Você é a Iris.', mcpUrl: 'http://127.0.0.1:1/mcp/x', web: false }, { provider: { acme: {} } })
    expect(c['tools']).toEqual({ '*': false, 'tucano_*': true, webfetch: false, websearch: false })
    expect(c['mcp']).toEqual({ servers: { tucano: { type: 'remote', url: 'http://127.0.0.1:1/mcp/x', disabled: false } } })
    expect(c['agents']).toEqual({ tucano: { system: 'Você é a Iris.' } })
    expect(c['update']).toBe('disable')
    expect(c['snapshots']).toBe(false)
    expect(c['share']).toBe('disabled')
    expect(c['provider']).toEqual({ acme: {} })
  })

  it('omits the mcp block when there is no gateway', () => {
    const c = opencodeV2Config({ system: 's', web: true })
    expect(c['mcp']).toEqual({})
    expect(c['tools']).toEqual({ '*': false, 'tucano_*': true, webfetch: true, websearch: true })
  })

  it('runs standalone, without --pure', () => {
    expect(opencodeV2Args({ model: 'acme/gpt-9' })).toEqual(['run', '--standalone', '--format', 'json', '--agent', 'tucano', '-m', 'acme/gpt-9'])
  })
})
