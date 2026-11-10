import { describe, expect, it } from 'vitest'
import { AiJailProvider, findAiJail, sandboxProvider, type SandboxPolicy } from '../src/core/sandbox'
import { runCli } from '../src/core/engines/cli'

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
      args: ['--network', '--rw-map', '/tmp', '--map', '/Users/andre/project', '--rw-map', '/Users/andre/work', '--env', 'PATH', '--', '/bin/echo', 'ok'],
    })
  })

  it('makes the default-deny network policy explicit', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    expect(provider.wrap({ command: '/bin/echo', args: [], cwd: '/tmp', policy: { network: false } }).args.slice(0, 3)).toEqual(['--no-network', '--rw-map', '/tmp'])
  })

  it('executes a one-shot command through the installed ai-jail', async ({ skip }) => {
    if (!findAiJail()) return skip()
    const lines: string[] = []
    const parser = {
      line(line: string) {
        lines.push(line)
        return []
      },
      end() {
        return []
      }
    }
    for await (const _event of runCli({
      bin: '/bin/echo',
      args: ['sandbox-ok'],
      stdin: '',
      cwd: '/tmp',
      signal: new AbortController().signal,
      parser,
      sandbox: { provider: 'ai-jail', network: false, environment: ['PATH'] }
    })) {
      // The parser only records stdout; no engine events are needed for this smoke test.
    }
    expect(lines.join('')).toContain('sandbox-ok')
  })

  it('fails closed when the selected provider is unavailable', () => {
    const provider = new AiJailProvider(() => undefined)
    expect(() => provider.wrap({ command: '/bin/echo', args: [], cwd: '/tmp', policy })).toThrow(/ai-jail.*available/i)
  })
})
