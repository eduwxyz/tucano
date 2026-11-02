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

// UUIDv7: bytes 0-5 (48 bits) = Unix timestamp in milliseconds.
export function workspaceCreatedAt(id: string): number {
  return parseInt(id.slice(0, 12), 16)
}

export function sortWorkspaces(workspaces: WorkspaceSummary[] | undefined | null): WorkspaceSummary[] {
  if (!workspaces) return []
  return [...workspaces].sort((a, b) => {
    const nameCmp = a.name.localeCompare(b.name)
    if (nameCmp !== 0) return nameCmp
    return workspaceCreatedAt(a.id) - workspaceCreatedAt(b.id)
  })
}

export function suggestWorkspaceCopyName(name: string, existing: string[]): string {
  const taken = new Set(existing)
  for (let count = 2; ; count++) {
    const suffix = ` (${count})`
    const candidate = `${name.trim().slice(0, 120 - suffix.length).trimEnd()}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}
