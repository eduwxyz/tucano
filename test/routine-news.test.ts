// A routine's run that found nothing new (src/shared/routine-news.ts): the run is told to answer one
// fixed phrase then, and the core marks a reply that is only that (Run.noNews), so the conversation
// folds those runs by a flag rather than by reading what the agent wrote.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Runner } from '../src/core/runs'
import { setLang } from '../src/shared/lang'
import { isNoNews, noNewsPhrase, noNewsRun } from '../src/shared/routine-news'
import type { Agent, EngineId, Routine, Settings } from '../src/shared/types'

afterEach(() => setLang('pt'))

describe('the no-news phrase', () => {
  it('is the phrase alone, in either language, whatever the case, accents or formatting around it', () => {
    for (const t of ['Sem novidade.', 'sem novidade', '**Sem novidade.**', '  Sem novidades!  ', '“Sem novidade”', 'SEM NOVIDADE', 'Nothing new.', 'nothing new', '_Nothing new_']) expect(isNoNews(t), t).toBe(true)
  })

  it('anything more than the phrase is news', () => {
    for (const t of ['', 'Sem novidade no GitHub, mas a CI quebrou.', 'Nada novo.', 'Sem novidade. Uma issue nova: #530', 'Nothing new on GitHub, but CI is red.', 'novidade']) expect(isNoNews(t), t).toBe(false)
  })

  it('a reply is only no news when nothing else came with it', () => {
    expect(noNewsRun('Sem novidade.', { status: 'done' })).toBe(true)
    expect(noNewsRun('Sem novidade.', { status: 'failed' })).toBe(false)
    expect(noNewsRun('Sem novidade.', { status: 'done', approvalId: 'a1' })).toBe(false)
    expect(noNewsRun('Sem novidade.', { status: 'done', artifactIds: ['x'] })).toBe(false)
    expect(noNewsRun('Sem novidade.', { status: 'done', question: 'Abro o PR?' })).toBe(false)
    expect(noNewsRun('Sem novidade.', { status: 'done', delegations: [{ id: 'd', to: 'a2', conversationId: 'c', rootId: 'm' }] })).toBe(false)
  })

  it('is said in the workspace’s language', () => {
    expect(noNewsPhrase()).toBe('Sem novidade.')
    setLang('en')
    expect(noNewsPhrase()).toBe('Nothing new.')
  })
})

describe('a routine’s run, marked when it found nothing new', () => {
  const ready = { installed: true, loggedIn: true }
  const settings: Settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
  const agent: Agent = { id: 'a1', name: 'Bento', handle: 'bento', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }
  const routine: Routine = { id: 'gh', name: 'Vigia do GitHub', agentId: 'a1', conversationId: 'd1', prompt: 'Olhe as issues novas do Tucano.', schedule: { days: [0, 1, 2, 3, 4, 5, 6], time: '09:00' }, enabled: true, createdAt: 1 }
  let db: Db
  let turns: Turn[]
  let answer: string
  let runner: Runner

  beforeEach(() => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-no-news-')), 'test.db'))
    db.saveAgent(agent)
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    turns = []
    answer = 'Sem novidade.'
    const base = fakeEngine('claude', { delayMs: 1, reply: () => answer })
    const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), base.run(t)) }
    const other = (id: EngineId): Engine => fakeEngine(id, { delayMs: 1 })
    const engines: Record<EngineId, Engine> = { claude, codex: other('codex'), opencode: other('opencode'), pi: other('pi'), antigravity: other('antigravity'), cursor: other('cursor'), grok: other('grok'), cline: other('cline'), hermes: other('hermes'), endpoint: other('endpoint') }
    runner = new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-w-')) })
  })

  const ask = () => db.messages().find((m) => m.author.kind === 'routine')!

  it('tells the run to answer only the phrase when there is nothing new', async () => {
    await runner.runRoutine(routine, { scheduledAt: Date.now(), late: false })
    await runner.idle()
    const said = turns.map((t) => `${t.system}\n${t.prompt}`).join('\n')
    expect(said).toContain('responda só "Sem novidade."')
  })

  it('marks the reply that is only the phrase, and keeps the routine’s message it answers', async () => {
    const reply = await runner.runRoutine(routine, { scheduledAt: Date.now(), late: false })
    await runner.idle()
    expect(reply?.run).toMatchObject({ status: 'done', noNews: true, routineAsk: ask().id })
    expect(db.message(reply!.id)?.run).toMatchObject({ noNews: true, routineAsk: ask().id })
  })

  it('a reply with news is not marked, and still knows its routine’s message', async () => {
    answer = 'Uma issue nova: #530, o app fecha ao arquivar um agente.'
    const reply = await runner.runRoutine(routine, { scheduledAt: Date.now(), late: false })
    await runner.idle()
    expect(reply?.run?.noNews).toBeUndefined()
    expect(reply?.run?.routineAsk).toBe(ask().id)
  })

  it('the same words from a reply to a person are not a routine’s: not marked', async () => {
    await runner.send('d1', 'alguma novidade?')
    await runner.idle()
    const reply = db.messages().find((m) => m.author.kind === 'agent')
    expect(reply?.text).toBe('Sem novidade.')
    expect(reply?.run?.noNews).toBeUndefined()
  })
})
