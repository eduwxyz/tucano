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

  it('maps the extended ai-jail policy to explicit flags', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    const result = provider.wrap({
      command: '/bin/echo',
      args: ['ok'],
      cwd: '/tmp/work',
      policy: {
        network: true,
        allowHosts: ['api.example.com'],
        overlayPaths: ['/tmp/cache'],
        hideDotDirs: ['.secrets'],
        envFromFiles: ['/tmp/env-file'],
        maskPaths: ['/tmp/private'],
        denyPaths: ['/tmp/blocked'],
        privateHome: true,
        lockdown: true,
        landlock: true,
        seccomp: true,
        rlimits: true,
        agentState: false,
        inheritEnv: false,
        github: true,
        aws: true,
        kube: true,
        gcloud: true,
        dockerConfig: true,
        ssh: true,
        pictures: true,
        browser: 'hard',
        docker: false,
        tailscale: false,
        terminalPassthrough: false,
        auditLog: true,
        statusBar: false
      }
    })
    expect(result.args).toEqual(expect.arrayContaining([
      '--rw-map', '/tmp/work', '--allow-host', 'api.example.com',
      '--overlay-map', '/tmp/cache', '--hide-dotdir', '.secrets', '--mask', '/tmp/private', '--deny-path', '/tmp/blocked',
      '--private-home', '--lockdown', '--landlock', '--seccomp', '--rlimits', '--no-agent-state', '--no-inherit-env',
      '--github', '--aws', '--kube', '--gcloud', '--docker-config', '--ssh', '--pictures', '--browser=hard', '--no-docker',
      '--no-tailscale', '--no-terminal-passthrough', '--audit-log', '--no-status-bar'
    ]))
    expect(result.args).not.toContain('--network')
  })

  it('uses a selected .ai-jail file while preserving the agent workdir', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    const result = provider.wrap({
      command: '/bin/echo',
      args: ['ok'],
      cwd: '/tmp/work',
      policy: { configFile: '/tmp/policies/.ai-jail' }
    })
    expect(result.args).toEqual([
      '--rw-map', '/tmp/work', '--', '/bin/sh', '-c', 'cd "$1" && shift && exec "$@"',
      'tucano-ai-jail', '/tmp/work', '/bin/echo', 'ok'
    ])
    expect(result.cwd).toBe('/tmp/policies')
  })

  it('rejects a selected sandbox file with the wrong name', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    expect(() => provider.wrap({ command: '/bin/echo', args: [], cwd: '/tmp', policy: { configFile: '/tmp/policies/custom.ai-jail' } })).toThrow(/\.ai-jail file must be named \.ai-jail/i)
  })

  it('maps host integration and path exception options to explicit flags', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    const result = provider.wrap({
      command: '/bin/echo', args: [], cwd: '/tmp/work',
      policy: {
        maskExceptPaths: ['/tmp/public'],
        denyExceptPaths: ['/tmp/cache'],
        systemdUser: true,
        gpu: false,
        display: true,
        audio: true,
        kvm: true,
        macosHostIpc: true,
        x11: true,
        hostShm: true,
        updateCheck: true,
        worktree: false,
        mise: true,
        toolchains: false,
        saveConfig: false,
        hideConfig: false,
        exec: true,
        claudeDir: '/tmp/claude'
      }
    })
    expect(result.args).toEqual(expect.arrayContaining([
      '--mask-except', '/tmp/public', '--deny-path-except', '/tmp/cache',
      '--systemd-user', '--no-gpu', '--display', '--audio', '--kvm', '--macos-host-ipc',
      '--x11', '--host-shm', '--update-check', '--no-worktree', '--mise', '--no-toolchains',
      '--no-save-config', '--no-hide-config', '--exec', '--claude-dir', '/tmp/claude'
    ]))
  })

  it('covers explicit disabled options and paths already mounted', () => {
    const provider = new AiJailProvider(() => '/usr/local/bin/ai-jail')
    const result = provider.wrap({
      command: '/bin/echo', args: [], cwd: '/tmp/work',
      policy: {
        network: false, readWritePaths: ['/tmp/work'], browser: 'none',
        privateHome: false, lockdown: false, landlock: false, seccomp: false, rlimits: false,
        agentState: false, inheritEnv: false, github: false, aws: false, kube: false, gcloud: false,
        dockerConfig: false, ssh: false, pictures: false, docker: false, tailscale: false,
        terminalPassthrough: false, auditLog: false, statusBar: false
      }
    })
    expect(result.args).toContain('--no-browser')
    expect(result.args.filter((arg) => arg === '/tmp/work')).toHaveLength(1)
  })

  it('rejects an unknown provider id', () => {
    expect(() => sandboxProvider('future-provider' as never)).toThrow(/unknown sandbox provider/i)
  })

  it('returns no ai-jail executable when PATH has no executable', () => {
    const original = process.env.PATH
    process.env.PATH = ':/definitely-not-a-real-directory'
    try {
      expect(findAiJail()).toBeUndefined()
    } finally {
      process.env.PATH = original
    }
  })

  it('handles a missing PATH safely', () => {
    const original = process.env.PATH
    delete process.env.PATH
    try {
      expect(findAiJail()).toBeUndefined()
    } finally {
      process.env.PATH = original
    }
  })

  it('fails closed when the selected provider is unavailable', () => {
    const provider = new AiJailProvider(() => undefined)
    expect(() => provider.wrap({ command: '/bin/echo', args: [], cwd: '/tmp', policy })).toThrow(/ai-jail.*available/i)
  })
})
