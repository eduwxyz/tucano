import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { pageKey, Wiki } from '../src/core/wiki'

const agent: Agent = { id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1000000, used: 0, grants: {}, memory: 'read', computer: false, archived: false, wiki: 'read_write' }
const calls = [
  { name: 'wiki_ler', args: { pagina: 'Projeto' } },
  { name: 'wiki_buscar', args: { busca: 'Confidencial' } },
  { name: 'wiki_indice', args: {} },
  { name: 'wiki_escrever', args: { pagina: 'Projeto', texto: 'Agent change.' } },
  { name: 'wiki_editar', args: { pagina: 'Projeto', antigo: 'detalhes novos', novo: 'Agent change' } }
]

for (const change of ['unchanged', 'hold', 'revoke'] as const) for (const call of calls) {
  it(`rechecks ${change} before an in-flight ${call.name} call`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-live-'))
    const db = new Db(join(root, 'core.db'))
    const wiki = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
    const gateway = new Gateway()
    let result: unknown
    let invoked = false
    wiki.init(false)
    wiki.save({ title: 'Projeto', body: 'Público no início.', by: 'ana', byName: 'Ana' })
    db.saveAgent(agent)
    db.createConversation({ id: 'room', kind: 'channel', name: 'room', members: [agent.id] })
    const engine: Engine = {
      id: 'claude',
      async *run(turn: Turn) {
        expect(turn.mcpUrl).toBeTruthy()
        // The tools and their original view already exist; the person changes access now.
        if (change === 'hold') wiki.holdKey(pageKey('Projeto'), 'ana')
        else if (change === 'revoke') db.saveAgent({ ...agent, wiki: 'none' })
        wiki.save({ title: 'Projeto', body: 'Confidencial: detalhes novos.', by: 'ana', byName: 'Ana' })
        invoked = true
        result = await callTool(turn.mcpUrl!, call.name, call.args)
        yield { type: 'done', text: 'Concluído.', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const ids: EngineId[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes']
    const engines = Object.fromEntries(ids.map((id) => [id, id === 'claude' ? engine : fakeEngine(id)])) as Record<EngineId, Engine>
    const settings = { workspaceName: 'Ana', context: '', routerModel: 'haiku', memoryModel: 'haiku', engines: Object.fromEntries(ids.map((id) => [id, { installed: true, loggedIn: true }])) } as Settings
    const runner = new Runner({ db, wiki, gateway, engines, settings: async () => settings, emit: () => {}, workDir: join(root, 'work') })
    try {
      await gateway.start()
      await runner.runRoutine({ id: 'r', name: 'r', agentId: agent.id, conversationId: 'room', prompt: 'Leia a wiki.', schedule: { days: [1], time: '09:00' }, enabled: true, createdAt: 1 }, { scheduledAt: 1, late: false })
      await runner.idle()
      expect(invoked).toBe(true)
      expect(result).toBeDefined()
      const writing = call.name === 'wiki_escrever' || call.name === 'wiki_editar'
      if (change === 'unchanged' && !writing) expect(JSON.stringify(result)).toContain('detalhes novos')
      else expect(JSON.stringify(result)).not.toContain('detalhes novos')
      if (writing) {
        if (change === 'unchanged') expect(wiki.page('Projeto')!.body).toContain('Agent change')
        else {
          expect(wiki.page('Projeto')!.body).toContain('detalhes novos')
          expect(wiki.page('Projeto')!.body).not.toContain('Agent change')
          expect(result).toMatchObject({ isError: true })
        }
      }
      if (change === 'revoke') expect(result).toMatchObject({ isError: true })
      else if (change === 'hold' && !writing && call.name !== 'wiki_ler') expect(JSON.stringify(result)).not.toContain('Projeto')
    } finally {
      await gateway.stop()
      wiki.close()
      db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
}
