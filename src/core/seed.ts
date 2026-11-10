import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import type { Agent } from '../shared/types'
import type { Db } from './db'
import { unlessTesting } from './testing-model'

export function initializeWorkspace(db: Db, env: NodeJS.ProcessEnv = process.env): void {
  if (!db.created) return
  // Demo seeding belongs to the original test install, never a workspace made
  // from the switcher. Even in fake mode those follow the normal introduction.
  const demo = env['TUCANO_DEFAULT_WORKSPACE'] !== '0' &&
    (env['TUCANO_SEED'] === '1' || (env['TUCANO_FAKE_ENGINES'] === '1' && env['TUCANO_SEED'] !== '0'))
  if (demo) seed(db, env)
  // A new install starts with the short sidebar; a workspace made from the switcher is someone's who knows the app.
  else db.setSettings({ onboarding: { done: false, ...(env['TUCANO_DEFAULT_WORKSPACE'] !== '0' ? { fresh: true } : {}) } })
}

// First run: a small team and three channels, so there is someone to talk to.
export function seed(db: Db, env: NodeJS.ProcessEnv = process.env): void {
  const agent = (a: Omit<Agent, 'id' | 'used' | 'grants' | 'memory' | 'computer' | 'archived'>): Agent => ({ ...a, id: randomUUID(), used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
  // A demo team on a testing checkout runs the testing model: there may be no Claude subscription
  // on the machine, and an agent whose model is missing can't answer a word.
  const model = (usual: string): string => unlessTesting(usual, env)
  const lia = agent({
    name: 'Lia',
    handle: 'lia',
    role: L('Engenharia', 'Engineering'),
    color: 'sky',
    instructions: L(
      'Ajuda com código, arquitetura e bugs. Explica o raciocínio em poucas linhas e mostra código quando ajuda. Antes de propor algo grande, descreve o plano e pergunta.',
      'Helps with code, architecture and bugs. Explains the reasoning in a few lines and shows code when it helps. Before proposing something big, describes the plan and asks.'
    ),
    modelId: model('sonnet'),
    effort: 'medium',
    limit: 3_000_000
  })
  const theo = agent({
    name: 'Theo',
    handle: 'theo',
    role: L('Dados', 'Data'),
    color: 'violet',
    instructions: L('Responde perguntas sobre métricas, SQL e análise de dados. Mostra a query ou a conta que usou.', 'Answers questions about metrics, SQL and data analysis. Shows the query or the math it used.'),
    modelId: model('gpt-5.6-luna'),
    effort: 'medium',
    limit: 2_000_000
  })
  const nina = agent({
    name: 'Nina',
    handle: 'nina',
    role: L('Conteúdo', 'Content'),
    color: 'rose',
    instructions: L('Escreve posts, anúncios e textos no meu tom: leve, curto, sem jargão. Entrega o rascunho e pergunta se ajusta.', 'Writes posts, ads and copy in my tone: light, short, no jargon. Delivers the draft and asks whether to adjust.'),
    modelId: model('sonnet'),
    effort: 'low',
    limit: 2_000_000
  })

  db.tx(() => {
    for (const a of [lia, theo, nina]) db.saveAgent(a)
    db.createConversation({ id: randomUUID(), kind: 'channel', name: L('engenharia', 'engineering'), members: [lia.id, theo.id] })
    db.createConversation({ id: randomUUID(), kind: 'channel', name: L('dados', 'data'), members: [theo.id] })
    db.createConversation({ id: randomUUID(), kind: 'channel', name: L('conteudo', 'content'), members: [nina.id] })
  })
}
