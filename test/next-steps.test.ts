// Next steps: an agent proposes the work that comes after its reply as a card of checkboxes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_STEPS, parseNextSteps, type Decision } from '../src/shared/questions'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const ready = { installed: true, loggedIn: true }

const agent = (id: string, handle: string): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false
})

const four = (): Decision => {
  const r = parseNextSteps({
    question: 'O que vem agora?',
    steps: [
      { label: 'Rodar a suíte inteira', description: 'o que já está escrito' },
      { label: 'Traduzir os rótulos novos' },
      { label: 'Escrever o teste do card' },
      { label: 'Publicar as capturas' }
    ]
  })
  if ('error' in r) throw new Error(r.error)
  return r.decision
}

describe('what next_steps takes', () => {
  it('makes one multiple decision, marked as steps, with the question it was given', () => {
    const d = four()
    expect(d).toMatchObject({ question: 'O que vem agora?', kind: 'multiple', nextSteps: true })
    expect(d.options?.map((o) => o.label)).toEqual(['Rodar a suíte inteira', 'Traduzir os rótulos novos', 'Escrever o teste do card', 'Publicar as capturas'])
    expect(d.options?.[0]?.description).toBe('o que já está escrito')
  })

  it('takes a step as a bare string, and titles the card when it is not told one', () => {
    const r = parseNextSteps({ steps: ['Rodar os testes', 'Traduzir os rótulos'] })
    expect('decision' in r && r.decision.question).toBe('Por onde eu sigo?')
    expect('decision' in r && r.decision.options?.map((o) => o.label)).toEqual(['Rodar os testes', 'Traduzir os rótulos'])
  })

  it('refuses an empty list, too many steps, a repeated step and a label that is too long', () => {
    expect(parseNextSteps({ steps: [] })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => `Passo ${i + 1}`) })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: ['Rodar os testes', 'rodar OS testes'] })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: [{ label: 'x'.repeat(81) }] })).toMatchObject({ error: expect.any(String) })
    expect(parseNextSteps({ steps: [{ description: 'sem label' }] })).toMatchObject({ error: expect.any(String) })
  })
})

describe('the card an agent gets', () => {
  let db: Db
  let settings: Settings
  let gateway: Gateway

  const engines = (claude: Engine): Record<EngineId, Engine> => ({
    claude,
    codex: fakeEngine('codex', { delayMs: 1 }),
    opencode: fakeEngine('opencode'),
    pi: fakeEngine('pi'),
    antigravity: fakeEngine('antigravity'),
    cursor: fakeEngine('cursor'),
    grok: fakeEngine('grok'),
    cline: fakeEngine('cline'),
    hermes: fakeEngine('hermes'),
    endpoint: fakeEngine('endpoint')
  })
  const asked = (): Message | undefined => db.messages().find((m) => m.author.kind === 'agent' && m.run?.status === 'waiting_input')

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'steps-')), 'test.db'))
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    gateway = new Gateway()
    await gateway.start()
    return () => gateway.stop()
  })

  const runner = (): Runner =>
    new Runner({
      db,
      engines: engines(fakeEngine('claude', { delayMs: 1 })),
      settings: async () => settings,
      emit: () => {},
      workDir: mkdtempSync(join(tmpdir(), 'steps-work-')),
      gateway
    })

  it('puts the steps on one card', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()
    expect(q?.run?.questions).toHaveLength(1)
    expect(q?.run?.questions?.[0]).toMatchObject({ nextSteps: true, kind: 'multiple' })
    expect(q?.run?.questions?.[0]?.options).toHaveLength(4)
  })

  it('what stays ticked comes back as the next message, and nothing else does', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    r.answerDecision(q.id, 0, { chosen: [0, 2] }, db.owner())
    await r.submitDecisions(q.id, db.owner())
    await r.idle()
    const mine = db.messages().filter((m) => m.author.kind === 'person').pop()
    expect(mine?.text).toContain('O que vem agora?')
    expect(mine?.text).toContain('Rodar a suíte inteira')
    expect(mine?.text).toContain('Escrever o teste do card')
    expect(mine?.text).not.toContain('Traduzir os rótulos novos')
    expect(mine?.text).not.toContain('Publicar as capturas')
  })

  it('a step written by hand comes back as another step, not as something else', async () => {
    const r = runner()
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()!
    r.answerDecision(q.id, 0, { chosen: [0], other: 'Escrever a nota de lançamento' }, db.owner())
    await r.submitDecisions(q.id, db.owner())
    await r.idle()
    const mine = db.messages().filter((m) => m.author.kind === 'person').pop()
    expect(mine?.text).toContain('Rodar a suíte inteira')
    expect(mine?.text).toContain('Outro passo: Escrever a nota de lançamento')
    expect(mine?.text).not.toContain('Outra coisa')
  })
})
