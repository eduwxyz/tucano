// Pure rules of the governance layer: which tools a grant exposes, and how an approval is bound to
// one exact call. How a tool is classified is in shared/classify.ts.
import { createHash } from 'node:crypto'
import type { ConnectorTool, GrantLevel } from '../shared/types'
// The classes themselves live in shared/, so the approval card reads them too.
export { callClass, classify, classifyAction, legacyClassify, permits, runnerAllowed, runnerRules } from '../shared/classify'

// `read` exposes read tools; `read_write` exposes everything (sensitive ones go through approval).
// `forReaders`: a Composio tool exposed to readers too (shared/composio.ts).
export function allowed(tool: ConnectorTool, grant: GrantLevel | undefined, forReaders = false): boolean {
  if (!tool.enabled) return false
  if (grant === 'read') return tool.cls === 'read' || forReaders
  return grant === 'read_write'
}

// Same JSON for the same arguments regardless of key order.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function approvalHash(connectorId: string, tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(`${connectorId}\n${tool}\n${canonical(args)}`).digest('hex')
}
