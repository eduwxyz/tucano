import { describe, expect, it } from 'vitest'
import { opencodeStatuses } from '../src/core/engines/detect'
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

describe('opencode detection', () => {
  it('sends the full status to the engine matching the major version', () => {
    const v2 = opencodeStatuses('opencode v2.2.0', '/bin/opencode', ['acme/gpt-9'])
    expect(v2.v2).toMatchObject({ installed: true, path: '/bin/opencode', version: '2.2.0', loggedIn: true })
    expect(v2.v1.installed).toBe(false)
    expect(v2.v1.account).toContain('V2')
    const v1 = opencodeStatuses('1.15.0', '/bin/opencode', ['acme/gpt-9'])
    expect(v1.v1.installed).toBe(true)
    expect(v1.v2.installed).toBe(false)
    expect(v1.v2.account).toContain('V1')
  })

  it('defaults an unparseable version to V1, as the app always did', () => {
    const s = opencodeStatuses('opencode tomorrow-build', '/bin/opencode', [])
    expect(s.v1.installed).toBe(true)
    expect(s.v2.installed).toBe(false)
  })
})
