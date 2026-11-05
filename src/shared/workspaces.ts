// The desktop registry exposes metadata and counts, never another workspace's content.
import type { Settings } from './types'

// What a workspace is called on screen: its own name, or else the person's (one workspace, as before).
export const workspaceLabel = (s: Pick<Settings, 'workspaceName' | 'workspaceLabel'>): string => s.workspaceLabel?.trim() || s.workspaceName

// What "bring the general settings" takes to a new workspace: how things work, not what it holds.
// Never its context, wiki folder, accounts, keys or phone: those belong to each workspace.
export const GENERAL_SETTINGS = ['workspaceName', 'language', 'routerModel', 'memoryModel', 'memoryLearning', 'defaultLimit', 'approvalTtlHours', 'runBudgetPct', 'runStallMinutes', 'quietHours', 'harnesses', 'sounds', 'voice', 'browserJev', 'wikiCapture', 'wikiEdits', 'wikiReview'] as const satisfies readonly (keyof Settings)[]
export type GeneralSettings = Partial<Pick<Settings, (typeof GENERAL_SETTINGS)[number]>>

export function generalSettings(s: unknown): GeneralSettings {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return {}
  const from = s as Record<string, unknown>
  return Object.fromEntries(GENERAL_SETTINGS.filter((k) => from[k] !== undefined).map((k) => [k, from[k]])) as GeneralSettings
}

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
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16)
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
