import { accessSync, constants } from 'node:fs'
import { basename, delimiter, dirname } from 'node:path'
import type { SandboxConfig, SandboxProviderId } from '../shared/types'

export type SandboxPolicy = Omit<SandboxConfig, 'provider'>

export interface SandboxCommand {
  command: string
  args: string[]
  cwd?: string
}

export interface SandboxLaunch {
  command: string
  args: string[]
  cwd: string
  policy: SandboxPolicy
}

export interface SandboxProvider {
  readonly id: SandboxProviderId
  wrap(launch: SandboxLaunch): SandboxCommand
}

export class NoneSandboxProvider implements SandboxProvider {
  readonly id = 'none' as const
  wrap({ command, args }: SandboxLaunch): SandboxCommand {
    return { command, args }
  }
}

export class AiJailProvider implements SandboxProvider {
  readonly id = 'ai-jail' as const

  constructor(private readonly locate: () => string | undefined = findAiJail) {}

  wrap(launch: SandboxLaunch): SandboxCommand {
    const { command, args, policy } = launch
    const executable = this.locate()
    if (!executable) throw new Error('Selected sandbox provider ai-jail is not available. Install ai-jail or select another sandbox.')
    const wrapped: string[] = []
    if (policy.configFile && basename(policy.configFile) !== '.ai-jail') throw new Error('Selected .ai-jail file must be named .ai-jail.')
    const hosts = policy.allowHosts ?? []
    if (hosts.length) for (const host of hosts) wrapped.push('--allow-host', host)
    else if (!policy.configFile) wrapped.push(policy.network ? '--network' : '--no-network')
    wrapped.push('--rw-map', launch.cwd)
    for (const path of policy.readOnlyPaths ?? []) wrapped.push('--map', path)
    for (const path of policy.readWritePaths ?? []) if (path !== launch.cwd) wrapped.push('--rw-map', path)
    for (const path of policy.overlayPaths ?? []) wrapped.push('--overlay-map', path)
    for (const name of policy.hideDotDirs ?? []) wrapped.push('--hide-dotdir', name)
    for (const path of policy.maskPaths ?? []) wrapped.push('--mask', path)
    for (const path of policy.maskExceptPaths ?? []) wrapped.push('--mask-except', path)
    for (const path of policy.denyPaths ?? []) wrapped.push('--deny-path', path)
    for (const path of policy.denyExceptPaths ?? []) wrapped.push('--deny-path-except', path)
    for (const name of policy.environment ?? []) wrapped.push('--env', name)
    for (const path of policy.envFromFiles ?? []) wrapped.push('--env-from-file', path)
    const bool = (value: boolean | undefined, on: string, off: string): void => {
      if (value !== undefined) wrapped.push(value ? on : off)
    }
    bool(policy.privateHome, '--private-home', '--no-private-home')
    bool(policy.lockdown, '--lockdown', '--no-lockdown')
    bool(policy.landlock, '--landlock', '--no-landlock')
    bool(policy.seccomp, '--seccomp', '--no-seccomp')
    bool(policy.rlimits, '--rlimits', '--no-rlimits')
    bool(policy.agentState, '--agent-state', '--no-agent-state')
    bool(policy.inheritEnv, '--inherit-env', '--no-inherit-env')
    bool(policy.github, '--github', '--no-github')
    bool(policy.aws, '--aws', '--no-aws')
    bool(policy.kube, '--kube', '--no-kube')
    bool(policy.gcloud, '--gcloud', '--no-gcloud')
    bool(policy.dockerConfig, '--docker-config', '--no-docker-config')
    bool(policy.ssh, '--ssh', '--no-ssh')
    bool(policy.pictures, '--pictures', '--no-pictures')
    bool(policy.docker, '--docker', '--no-docker')
    bool(policy.tailscale, '--tailscale', '--no-tailscale')
    bool(policy.terminalPassthrough, '--terminal-passthrough', '--no-terminal-passthrough')
    bool(policy.systemdUser, '--systemd-user', '--no-systemd-user')
    bool(policy.gpu, '--gpu', '--no-gpu')
    bool(policy.display, '--display', '--no-display')
    bool(policy.audio, '--audio', '--no-audio')
    bool(policy.kvm, '--kvm', '--no-kvm')
    bool(policy.macosHostIpc, '--macos-host-ipc', '--no-macos-host-ipc')
    bool(policy.x11, '--x11', '--no-x11')
    bool(policy.hostShm, '--host-shm', '--no-host-shm')
    bool(policy.updateCheck, '--update-check', '--no-update-check')
    bool(policy.worktree, '--worktree', '--no-worktree')
    bool(policy.mise, '--mise', '--no-mise')
    bool(policy.toolchains, '--toolchains', '--no-toolchains')
    bool(policy.saveConfig, '--save-config', '--no-save-config')
    bool(policy.hideConfig, '--hide-config', '--no-hide-config')
    if (policy.exec) wrapped.push('--exec')
    bool(policy.auditLog, '--audit-log', '--no-audit-log')
    bool(policy.statusBar, '--status-bar', '--no-status-bar')
    if (policy.claudeDir) wrapped.push('--claude-dir', policy.claudeDir)
    if (policy.browser === 'hard' || policy.browser === 'soft') wrapped.push(`--browser=${policy.browser}`)
    else if (policy.browser === 'none') wrapped.push('--no-browser')
    if (!policy.configFile) return { command: executable, args: [...wrapped, '--', command, ...args] }
    return {
      command: executable,
      cwd: dirname(policy.configFile),
      args: [...wrapped, '--', '/bin/sh', '-c', 'cd "$1" && shift && exec "$@"', 'tucano-ai-jail', launch.cwd, command, ...args]
    }
  }
}

export function sandboxProvider(id: SandboxProviderId): SandboxProvider {
  if (id === 'none') return new NoneSandboxProvider()
  if (id === 'ai-jail') return new AiJailProvider()
  throw new Error('Unknown sandbox provider: ' + String(id))
}

export function findAiJail(): string | undefined {
  const path = process.env.PATH ?? ''
  for (const dir of path.split(delimiter)) {
    if (!dir) continue
    const candidate = dir + '/ai-jail'
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue searching the user's PATH.
    }
  }
  return undefined
}
