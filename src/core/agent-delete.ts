// Deleting an agent, for good. Archiving keeps everything for when it comes back;
// this lets go of what was the agent's own: settings, DMs, routines, memories,
// computer and browser logins. Its messages in channels stay readable, and its
// receipts keep the month's totals right, so a small record stays behind with only
// its name and look. That record is archived, which every list and every reply
// already respects, and its handle is freed for a new agent.
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { L } from '../shared/lang'
import type { CoreEvent } from '../shared/rpc'
import type { Agent, RunStatus } from '../shared/types'
import type { Db } from './db'

const BUSY: RunStatus[] = ['working', 'waiting_input', 'waiting_approval']

export interface AgentDeleteDeps {
  db: Db
  emit: (e: CoreEvent) => void
  emitConversations: (ids: string[]) => void
  workDir: string // the agents' own empty directories
  stopRun: (messageId: string) => void
  forgetSessions: (agentId: string) => void
  removeRoutine: (id: string) => void
  deleteConversation: (id: string) => void
  forgetMemories: (agentId: string) => void
  forgetSkills: (agentId: string) => void
  // Both get the agent as it was. They may take a while (Docker, a browser closing), so nothing waits on them.
  eraseComputer: (agent: Agent) => Promise<void>
  eraseBrowser: (agent: Agent) => Promise<void>
}

// What stays of an agent: enough to show who wrote its old messages.
export const removedRecord = (a: Agent): Agent => ({
  id: a.id,
  name: a.name,
  handle: `removed-${a.id}`,
  role: '',
  color: a.color,
  ...(a.customColor ? { customColor: a.customColor } : {}),
  ...(a.picture ? { picture: a.picture } : {}),
  ...(a.avatar ? { avatar: a.avatar } : {}),
  instructions: '',
  modelId: a.modelId,
  effort: a.effort,
  limit: a.limit,
  used: a.used,
  grants: {},
  memory: 'read',
  computer: false,
  web: false,
  browser: false,
  apps: [],
  autoApprove: [],
  wiki: 'none',
  archived: true,
  kind: 'removed'
})

// Throws for what can't be deleted, before anything changes. Everything the app depends on
// is done on return; the promise covers the disk and Docker, and never rejects.
export function deleteAgent(id: string, deps: AgentDeleteDeps): Promise<void> {
  const { db, emit } = deps
  const agent = db.agent(id)
  if (!agent || agent.kind === 'removed') return Promise.resolve()
  if (agent.kind === 'tuca') throw new Error(L('O Tuca faz parte do app e não pode ser excluído.', 'Tuca is part of the app and can’t be deleted.'))

  // Its routines post as the routine, so their replies are found through them.
  const routines = db.routines().filter((r) => r.agentId === id)
  const routineIds = new Set(routines.map((r) => r.id))
  for (const m of db.messages()) {
    const own = (m.author.kind === 'agent' && m.author.id === id) || (m.author.kind === 'routine' && routineIds.has(m.author.id))
    if (own && m.run && BUSY.includes(m.run.status)) deps.stopRun(m.id)
  }
  for (const r of routines) deps.removeRoutine(r.id)
  for (const a of db.approvals()) {
    if (a.agentId === id && a.state === 'pending' && db.decideApproval(a.id, 'expired', L('O agente foi excluído.', 'The agent was deleted.'))) {
      emit({ type: 'approval', approval: db.approvals().find((x) => x.id === a.id)! })
    }
  }
  deps.forgetSessions(id)
  for (const c of db.conversations()) if (c.kind === 'dm' && (c.name === id || c.members.includes(id))) deps.deleteConversation(c.id)
  const channels = db.setAgentChannels(id, [])
  deps.forgetMemories(id)
  deps.forgetSkills(id)

  // Lent folders are only forgotten: they are the person's, and nothing in them is touched.
  db.setFolders(id, [])
  db.saveAgent(removedRecord(agent))
  emit({ type: 'agent', agent: db.agent(id)! })
  deps.emitConversations(channels)

  const left = (what: string) => (e: unknown): void => console.warn(`[agent-delete] ${what} of ${id}:`, e)
  return Promise.all([
    deps.eraseComputer(agent).catch(left('computer')),
    deps.eraseBrowser(agent).catch(left('browser')),
    // A reply just stopped may still hold this folder for a moment, on Windows above all.
    rm(join(deps.workDir, id), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(left('folder'))
  ]).then(() => {})
}
