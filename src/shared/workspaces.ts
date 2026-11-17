// The desktop registry exposes metadata and counts, never another workspace's content.
import type { Settings } from './types'

// What a workspace is called on screen: its own name, or else the person's (one workspace, as before).
export const workspaceLabel = (s: Pick<Settings, 'workspaceName' | 'workspaceLabel'>): string => s.workspaceLabel?.trim() || s.workspaceName

// The general settings: how things work, not what the workspace holds (never its context, wiki
// folder, accounts, keys or phone).
export const GENERAL_SETTINGS = ['workspaceName', 'language', 'routerModel', 'memoryModel', 'memoryLearning', 'defaultLimit', 'approvalTtlHours', 'runBudgetPct', 'runStallMinutes', 'chainDepth', 'actionRules', 'autonomy', 'outsideGuard', 'quietHours', 'harnesses', 'sounds', 'stepsOpen', 'voice', 'browserJev', 'wikiCapture', 'wikiEdits', 'wikiReview'] as const satisfies readonly (keyof Settings)[]
// What a new workspace takes from another, each picked when creating it (a duplicate takes it all).
// The wiki isn't copied: the new workspace uses the same one, and what one keeps the other reads.
// Never messages, memories, approvals, usage, computers' files, browser sessions or extra logins.
export const WORKSPACE_PARTS = ['general', 'context', 'wiki', 'agents', 'channels', 'skills', 'connectors', 'routines'] as const
export type WorkspacePart = (typeof WORKSPACE_PARTS)[number]
export type WorkspaceParts = Record<WorkspacePart, boolean>
export const ALL_PARTS: WorkspaceParts = { general: true, context: true, wiki: true, agents: true, channels: true, skills: true, connectors: true, routines: true }

export function workspaceParts(raw: unknown): WorkspaceParts {
  const from = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const parts = Object.fromEntries(WORKSPACE_PARTS.map((p) => [p, from[p] === true])) as WorkspaceParts
  return { ...parts, routines: parts.routines && parts.agents } // a routine is an agent's
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
