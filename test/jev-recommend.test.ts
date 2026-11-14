// Jev suggesting one option on an agent's question: the pick lands on the reply as a pill, one
// cheap typed question per decision, and only when the person turned it on in the settings.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Decision } from '../src/shared/questions'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { RECOMMEND_NONE, recommendOptions } from '../src/core/jev'
import { People } from '../src/core/people'
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

// The two decisions the fake engine asks: one with options, one that's free text.
const decisions = (): Decision[] => [
  { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito', description: 'mais simples' }] },
  { question: 'Pra quando?', kind: 'text' }
]

// A stand-in for TypeSafe: answers `pick` with the key it was given, and records every request.
function typesafe(opts: { pick?: string; status?: number; body?: unknown } = {}) {
  const requests: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    if (opts.status) return new Response('no', { status: opts.status })
    if (opts.body) return Response.json(opts.body)
    return Response.json({ answers: { pick: { type: 'choice', choice: opts.pick ?? 'o0', probabilities: {} } } })
  }) as unknown as typeof fetch
  const bodies = (): { model: string; state: string; questions: Record<string, { type: string; instructions: string; criteria: Record<string, string> }> }[] =>
    requests.map((r) => JSON.parse(r.init.body as string))
  return { f, requests, bodies }
}

describe('the recommended option', () => {
  const ask = (api: ReturnType<typeof typesafe>, questions = decisions(), context = 'Arquivei a issue #255.') =>
    recommendOptions({ key: 'ts-key', questions, context, fetch: api.f })

  it('picks one option per decision that has options, and leaves a text answer alone', async () => {
    const api = typesafe({ pick: 'o1' })
    const r = await ask(api)
    expect('picks' in r && r.picks).toEqual([1, null])
    // One question, for the decision with options: the free-text one has nothing to pick between.
    expect(api.bodies()).toHaveLength(1)
  })

  it('asks with the decision, its options and what the agent said before it', async () => {
    const api = typesafe()
    await ask(api)
    const body = api.bodies()[0]!
    expect(body.model).toBe('jev-latest')
    expect(body.state).toContain('Arquivei a issue #255.')
    expect(body.state).toContain('Paginação no menu?')
    expect(body.state).toContain('Scroll infinito — mais simples')
    expect(body.questions['pick']!.type).toBe('choice')
    expect(Object.keys(body.questions['pick']!.criteria)).toEqual(['o0', 'o1', RECOMMEND_NONE])
  })

  it('answers none when no option is clearly better', async () => {
    const r = await ask(typesafe({ pick: RECOMMEND_NONE }))
    expect('picks' in r && r.picks).toEqual([null, null])
  })

  it('makes no call when no decision has two options', async () => {
    const api = typesafe()
    const r = await recommendOptions({ key: 'ts-key', questions: [{ question: 'Nome?', kind: 'text' }, { question: 'Um só?', kind: 'single', options: [{ label: 'Sim' }] }], fetch: api.f })
    expect('picks' in r && r.picks).toEqual([null, null])
    expect(api.requests).toHaveLength(0)
  })

  it('marks nothing on a next-steps card, which answers itself with its ticks', async () => {
    const api = typesafe({ pick: 'o1' })
    const steps: Decision = {
      question: 'O que vem agora?',
      kind: 'multiple',
      nextSteps: true,
      options: [{ label: 'Rodar a suíte' }, { label: 'Traduzir os rótulos' }]
    }
    const r = await recommendOptions({ key: 'ts-key', questions: [steps, ...decisions()], context: 'Arquivei a issue #255.', fetch: api.f })
    // The pick stays aligned with the card's decisions: null where the steps are.
    expect('picks' in r && r.picks).toEqual([null, 1, null])
    expect(api.bodies()).toHaveLength(1)
    expect(api.bodies()[0]!.state).toContain('Paginação no menu?')
  })

  it('reports a failure instead of guessing, when TypeSafe refuses or answers something unknown', async () => {
    expect(await ask(typesafe({ status: 429 }))).toMatchObject({ error: expect.stringContaining('esperar') })
    expect(await ask(typesafe({ body: { answers: {} } }))).toMatchObject({ error: expect.any(String) })
    expect(await ask(typesafe({ pick: 'o9' }))).toMatchObject({ error: expect.any(String) })
  })
})

describe('the pill on the card', () => {
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
    hermes: fakeEngine('hermes')
  })
  const asked = (): Message | undefined => db.messages().find((m) => m.author.kind === 'agent' && m.run?.status === 'waiting_input')
  const until = async (check: () => boolean): Promise<void> => {
    const started = Date.now()
    while (!check() && Date.now() - started < 3_000) await new Promise((r) => setTimeout(r, 10))
  }

  beforeEach(async () => {
    db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-pick-')), 'test.db'))
    settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'approve', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] })
    gateway = new Gateway()
    await gateway.start()
    return () => gateway.stop()
  })

  const runner = (api: ReturnType<typeof typesafe>, key: string | undefined): Runner =>
    new Runner({
      db,
      engines: engines(fakeEngine('claude', { delayMs: 1 })),
      settings: async () => settings,
      emit: () => {},
      workDir: mkdtempSync(join(tmpdir(), 'ad-work-')),
      gateway,
      jev: { key: async () => key, fetch: api.f }
    })

  it('lands on the reply afterwards, so asking never waits on TypeSafe', async () => {
    settings = { ...settings, jevRecommend: true }
    const api = typesafe({ pick: 'o1' })
    const r = runner(api, 'ts-key')
    await r.send('d1', '@lia me ajuda a decidir')
    await r.idle()
    // The card is there before the suggestion is: the answer is a nice-to-have, not a gate.
    const q = asked()
    expect(q?.run?.questions).toHaveLength(2)
    await until(() => !!db.message(q!.id)?.run?.recommended)
    expect(db.message(q!.id)?.run).toMatchObject({ status: 'waiting_input', recommended: [1, null] })
    expect(api.requests).toHaveLength(1)
    // The inbox answer a question from the same card, so it carries the pick too.
    const [inbox] = new People(db).inbox(db.owner()).questions
    expect(inbox?.recommended).toEqual([1, null])
  })

  it('stays off by default: no option is marked, and nothing goes to TypeSafe', async () => {
    const api = typesafe({ pick: 'o1' })
    const r = runner(api, 'ts-key')
    await r.send('d1', '@lia me ajuda a decidir')
    await r.idle()
    const q = asked()
    await new Promise((res) => setTimeout(res, 50))
    expect(db.message(q!.id)?.run?.recommended).toBeUndefined()
    expect(api.requests).toHaveLength(0)
  })

  it('with no key, the card is what it always was', async () => {
    settings = { ...settings, jevRecommend: true }
    const api = typesafe({ pick: 'o1' })
    const r = runner(api, undefined)
    await r.send('d1', '@lia me ajuda a decidir')
    await r.idle()
    const q = asked()
    await new Promise((res) => setTimeout(res, 50))
    expect(db.message(q!.id)?.run?.recommended).toBeUndefined()
    expect(api.requests).toHaveLength(0)
  })

  it('sends nothing at all for a next-steps card, which has its own toggles', async () => {
    settings = { ...settings, jevRecommend: true }
    const api = typesafe({ pick: 'o1' })
    const r = runner(api, 'ts-key')
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()
    expect(q?.run?.questions?.[0]).toMatchObject({ nextSteps: true })
    await new Promise((res) => setTimeout(res, 50))
    expect(db.message(q!.id)?.run?.recommended).toBeUndefined()
    expect(api.requests).toHaveLength(0)
  })

  it('with the steps question on too, the card is answered once: by its ticks', async () => {
    settings = { ...settings, jevRecommend: true, jevNextSteps: true }
    const seen: { instructions: string; state: string }[] = []
    // A step is answered do/later by where it sits in the list; a decision, with its second option.
    const f = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { state: string; questions: { pick: { instructions: string } } }
      seen.push({ instructions: body.questions.pick.instructions, state: body.state })
      if (/próximo passo/.test(body.questions.pick.instructions)) {
        const i = Number([...body.state.matchAll(/^(\d+)\. /gm)].pop()?.[1] ?? 1) - 1
        return Response.json({ answers: { pick: { type: 'choice', choice: i % 2 === 0 ? 'do' : 'later', probabilities: {} } } })
      }
      return Response.json({ answers: { pick: { type: 'choice', choice: 'o1', probabilities: {} } } })
    }) as unknown as typeof fetch
    const r = runner({ ...typesafe(), f } as ReturnType<typeof typesafe>, 'ts-key')
    await r.send('d1', '@lia me dá os próximos passos')
    await r.idle()
    const q = asked()
    expect(q?.run?.questions?.[0]?.ticked).toEqual([0, 2])
    await new Promise((res) => setTimeout(res, 50))
    // No second answer to the same list, and no call spent on one: all four were about a step.
    expect(db.message(q!.id)?.run?.recommended).toBeUndefined()
    expect(seen).toHaveLength(4)
    expect(seen.every((b) => /próximo passo/.test(b.instructions))).toBe(true)
  })

  it('is not written onto a question that was answered while TypeSafe thought', async () => {
    settings = { ...settings, jevRecommend: true }
    let release: () => void = () => {}
    const slow = (async (url: string, init: RequestInit) => {
      await new Promise<void>((res) => (release = res))
      return typesafe({ pick: 'o1' }).f(url, init)
    }) as unknown as typeof fetch
    const api = { ...typesafe(), f: slow }
    const r = runner(api as ReturnType<typeof typesafe>, 'ts-key')
    await r.send('d1', '@lia me ajuda a decidir')
    await r.idle()
    const q = asked()
    r.answerDecision(q!.id, 0, { chosen: [0] }, db.owner())
    release()
    await new Promise((res) => setTimeout(res, 50))
    expect(db.message(q!.id)?.run?.recommended).toBeUndefined()
    expect(db.message(q!.id)?.run?.answers?.[0]).toEqual({ chosen: [0] })
  })
})
