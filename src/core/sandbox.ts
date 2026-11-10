import { accessSync, constants } from 'node:fs'
import { delimiter } from 'node:path'
import type { SandboxConfig, SandboxProviderId } from '../shared/types'

export type SandboxPolicy = Omit<SandboxConfig, 'provider'>

export interface SandboxCommand {
  command: string
  args: string[]
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
    const wrapped: string[] = [policy.network ? '--network' : '--no-network', '--rw-map', launch.cwd]
    for (const path of policy.readOnlyPaths ?? []) wrapped.push('--map', path)
    for (const path of policy.readWritePaths ?? []) {
      if (path !== launch.cwd) wrapped.push('--rw-map', path)
    }
    for (const name of policy.environment ?? []) wrapped.push('--env', name)
    return { command: executable, args: [...wrapped, '--', command, ...args] }
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
