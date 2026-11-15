import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const until = async (ready: () => boolean): Promise<void> => {
  const end = Date.now() + 8000
  while (!ready()) {
    if (Date.now() > end) throw new Error('The real execution queue did not reach the expected state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, ...extra })

it('does not nudge or fail delegated work legitimately waiting behind six active replies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-delegation-queue-'))
  const db = new Db(join(root, 'test.db'))
  const gateway = new Gateway()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let ask!: () => void
  const readyToAsk = new Promise<void>((resolve) => { ask = resolve })
  let active = 0
  let handed = false
  let childStarts = 0
  const ids: EngineId[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes']
  const makeEngine = (id: EngineId): Engine => ({
    id,
    async *run(turn) {
      if (turn.agentKey === 'boss' && !handed) {
        active++
        await readyToAsk
        await callTool(turn.mcpUrl!, 'pedir', { para: 'child', pedido: 'Confira o resultado.' })
        handed = true
        await held
      } else if (turn.agentKey?.startsWith('worker')) {
        active++
        await held
      } else if (turn.agentKey === 'child') childStarts++
      yield { type: 'done', text: 'Finished.', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    }
  })
  const engines = Object.fromEntries(ids.map((id) => [id, makeEngine(id)])) as Record<EngineId, Engine>
  const settings = { workspaceName: 'Ana', context: '', routerModel: 'haiku', memoryModel: 'haiku', engines: Object.fromEntries(ids.map((id) => [id, { installed: true, loggedIn: true }])) } as Settings
  const runner = new Runner({ db, gateway, engines, settings: async () => settings, emit: () => {}, workDir: join(root, 'work') })
  try {
    await gateway.start()
    db.saveAgent(agent('boss'))
    db.saveAgent(agent('child', { reportsTo: 'boss' }))
    db.createConversation({ id: 'child-room', kind: 'channel', name: 'child-room', members: ['child'] })
    for (const id of ['boss', ...Array.from({ length: 5 }, (_, n) => `worker${n}`)]) {
      db.saveAgent(db.agent(id) ?? agent(id))
      db.createConversation({ id, kind: 'dm', name: id, members: [id] })
      await runner.send(id, 'Begin.')
    }
    await until(() => active === 6)
    ask()
    await until(() => handed)
    expect(childStarts).toBe(0)
    const delegation = db.openDelegations()[0]!
    expect(delegation).toBeDefined()
    runner.sweepDelegations(delegation.createdAt + 5 * 60000)
    runner.sweepDelegations(delegation.createdAt + 11 * 60000)
    const queued = db.delegation(delegation.id)!
    release()
    await runner.idle()
    expect(queued.state).toBe('open')
    expect(queued.nudges).toBeUndefined()
    expect(childStarts).toBe(1)
    expect(db.delegation(delegation.id)?.state).toBe('done')
  } finally {
    ask()
    release()
    await runner.idle()
    await gateway.stop()
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
