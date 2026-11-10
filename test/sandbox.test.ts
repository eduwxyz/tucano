import { describe, expect, it } from 'vitest'
import { AiJailProvider, sandboxProvider, type SandboxPolicy } from '../src/core/sandbox'

const policy: SandboxPolicy = {
  network: true,
  readOnlyPaths: ['/Users/andre/project'],
  readWritePaths: ['/Users/andre/work'],
  environment: ['PATH'],
}

describe('sandbox providers', () => {
  it('returns no wrapper for the explicit unsandboxed provider', () => {
    const provider = sandboxProvider('none')
    expect(provider.wrap({ command: '/bin/echo', args: ['ok'], cwd: '/tmp', policy })).toEqual({ command: '/bin/echo', args: ['ok'] })
  })

  it('builds an ai-jail command from the generic policy', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    expect(provider.wrap({ command: '/bin/echo', args: ['ok'], cwd: '/tmp', policy })).toEqual({
      command: '/usr/local/bin/ai-jail',
      args: ['--network', '--map', '/Users/andre/project', '--rw-map', '/Users/andre/work', '--env', 'PATH', '--', '/bin/echo', 'ok'],
    })
  })

  it('fails closed when the selected provider is unavailable', () => {
    const provider = new AiJailProvider(() => undefined)
    expect(() => provider.wrap({ command: '/bin/echo', args: [], cwd: '/tmp', policy })).toThrow(/ai-jail.*available/i)
  })
})
