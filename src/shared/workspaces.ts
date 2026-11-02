// The desktop registry exposes metadata and counts, never another workspace's content.
import type { Settings } from './types'

export function isTheme(value: unknown): value is Settings['theme'] {
  return value === 'system' || value === 'light' || value === 'dark'
}

export interface Workspace {
  id: string
  name: string
  dataDir: string
  webhookPort: number
  gitPort: number
  isDefault: boolean
}

export interface WorkspaceSummary {
  id: string
  name: string
  isDefault: boolean
  paused: boolean
  unread: number
  approvals: number
  status: 'starting' | 'ready' | 'failed'
}

export interface WorkspaceList {
  selected: string
  workspaces: WorkspaceSummary[]
}

export function suggestWorkspaceCopyName(name: string, existing: string[]): string {
  const taken = new Set(existing)
  for (let count = 2; ; count++) {
    const suffix = ` (${count})`
    const candidate = `${name.trim().slice(0, 120 - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}
