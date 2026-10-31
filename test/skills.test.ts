import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { Skills } from '../src/core/skills'

const agent = (id: string, handle: string): Agent => ({
  id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false
})

let db: Db
let skills: Skills
let notes: string[]
beforeEach(() => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-skills-')), 'test.db'))
  notes = []
  skills = new Skills({ db, emit: () => {}, notify: (t) => notes.push(t) })
  db.saveAgent(agent('a1', 'staff'))
  db.saveAgent(agent('a2', 'pm'))
})

const recipe = { name: 'Testes do Core', description: 'Ao rodar ou consertar testes do Core', body: 'swift test --package-path Core --scratch-path /work/build-core', agents: [] }

describe('skills', () => {
  it('I write one: active right away, for all agents or only the chosen ones', () => {
    const k = skills.save(recipe)
    expect(k).toMatchObject({ name: 'testes-do-core', state: 'active' })
    expect(skills.forAgent('a2')).toHaveLength(1)
    skills.save({ ...recipe, id: k.id, agents: ['a1'] })
    expect(skills.forAgent('a2')).toHaveLength(0)
    expect(skills.forAgent('a1')).toHaveLength(1)
    expect(() => skills.save({ ...recipe, body: 'outra' })).toThrow('Já existe uma skill chamada testes-do-core.')
  })

  it("an agent's new skill waits for me, and only its proposer gets it once approved", () => {
    const r = skills.propose(db.agent('a1')!, { nome: 'abrir PR', quando_usar: 'Ao terminar uma tarefa', receita: 'git push … (feito pelo Eduardo)', motivo: 'faço sempre igual' })
    expect(r.skill).toMatchObject({ state: 'pending', name: 'abrir-pr', proposedBy: 'a1', agents: ['a1'] })
    expect(notes).toEqual(['Staff propõe uma skill'])
    expect(skills.forAgent('a1')).toHaveLength(0)
    skills.decide(r.skill!.id, true)
    expect(skills.forAgent('a1').map((k) => k.name)).toEqual(['abrir-pr'])
    expect(skills.forAgent('a2')).toHaveLength(0)
  })

  it("a change to a skill waits too; approving keeps the old version, and restoring it undoes", () => {
    const k = skills.save(recipe)
    const p = skills.propose(db.agent('a1')!, { nome: 'testes-do-core', quando_usar: recipe.description, receita: 'swift build primeiro, depois swift test …' }).skill!
    expect(p.replaces).toBe(k.id)
    expect(db.skill(k.id)!.body).toBe(recipe.body) // nothing changes until I approve
    skills.decide(p.id, true)
    expect(db.skill(k.id)!.body).toBe('swift build primeiro, depois swift test …')
    expect(db.skill(p.id)).toBeUndefined()
    const [before] = db.skillVersions(k.id)
    expect(before!.body).toBe(recipe.body)
    skills.restore(k.id, before!.id)
    expect(db.skill(k.id)!.body).toBe(recipe.body)
    expect(db.skillVersions(k.id)).toHaveLength(2) // the undone version is kept as well
  })

  it("refusing drops the proposal; an agent can't take a skill that isn't its own", () => {
    skills.save({ ...recipe, agents: ['a2'] })
    expect(skills.propose(db.agent('a1')!, { nome: 'testes-do-core', quando_usar: 'x', receita: 'y' })).toMatchObject({ error: true })
    const p = skills.propose(db.agent('a1')!, { nome: 'outra', quando_usar: 'x', receita: 'y' }).skill!
    skills.decide(p.id, false)
    expect(db.skills().map((k) => k.name)).toEqual(['testes-do-core'])
  })
})

describe('in a reply', () => {
  let gateway: Gateway
  afterEach(async () => {
    await gateway.stop()
  })

  it('the agent sees its skills in the prompt, reads one, and proposes one', async () => {
    skills.save({ ...recipe, agents: ['a1'] })
    const ready = { installed: true, loggedIn: true }
    const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, hermes: ready, gemini: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    gateway = new Gateway()
    await gateway.start()
    const turns: Turn[] = []
    const replies: string[] = []
    const claude: Engine = {
      id: 'claude',
      async *run(turn) {
        turns.push(turn)
        for (const [name, args] of [['ler_skill', { nome: 'testes-do-core' }], ['propor_skill', { nome: 'build-ios', quando_usar: 'Quando pedirem build do app iOS', receita: 'Pedir ao Edu no Xcode.' }]] as const) {
          const r = (await callTool(turn.mcpUrl!, name, args)) as { content: { text: string }[] }
          replies.push(r.content[0]!.text)
        }
        yield { type: 'done', text: 'feito', usage: { inputTokens: 10, cacheReadTokens: 0, outputTokens: 1 } }
      }
    }
    const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), hermes: fakeEngine('hermes'), gemini: fakeEngine('gemini') }
    const r = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')), gateway, skills })
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    await r.send('d1', 'roda os testes')
    await r.idle()
    expect(turns[0]!.system).toContain('## Suas skills')
    expect(turns[0]!.system).toContain('- testes-do-core: Ao rodar ou consertar testes do Core')
    expect(replies[0]).toContain('swift test --package-path Core')
    expect(replies[1]).toContain('Ela só vale depois que o usuário aprovar')
    const steps = db.messages().find((m) => m.author.kind === 'agent')!.run!.steps.map((s) => `${s.label}: ${s.detail}`)
    expect(steps).toEqual(expect.arrayContaining(['Leu a skill: testes-do-core', 'Propôs uma skill: build-ios']))
  })
})
