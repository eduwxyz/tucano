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

  wrap({ command, args, policy }: SandboxLaunch): SandboxCommand {
    const executable = this.locate()
    if (!executable) throw new Error('Selected sandbox provider ai-jail is not available. Install ai-jail or select another sandbox.')
    const wrapped: string[] = []
    if (policy.network) wrapped.push('--network')
    for (const path of policy.readOnlyPaths ?? []) wrapped.push('--map', path)
    for (const path of policy.readWritePaths ?? []) wrapped.push('--rw-map', path)
    for (const name of policy.environment ?? []) wrapped.push('--env', name)
    return { command: executable, args: [...wrapped, '--', command, ...args] }
  }
}

export function sandboxProvider(id: SandboxProviderId): SandboxProvider {
  return id === 'ai-jail' ? new AiJailProvider() : new NoneSandboxProvider()
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
