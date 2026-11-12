import { describe, expect, it } from 'vitest'
import { classifierFor, classifierJobsOf, classifierList, JEV_CLASSIFIER, type ClassifierConfig } from '../src/shared/classifiers'
import type { Settings } from '../src/shared/types'
import { ask, checkClassifierKey } from '../src/core/classifiers'
import { readPrompt } from '../src/core/model-routing'
import { jevBox, listenJev, routeJev, stepsWorthDoing } from '../src/core/jev'

const luna: ClassifierConfig = { id: 'luna', name: 'Luna', provider: 'openai', model: 'gpt-6-luna' }
const gemini: ClassifierConfig = { id: 'gem', name: 'Gemini', provider: 'gemini', model: 'gemini-decision-1' }
const router: ClassifierConfig = { id: 'or', name: 'Jev (OpenRouter)', provider: 'openrouter', model: 'typesafe/jev-1.13' }

const settingsWith = (p: Partial<Settings>): Settings => ({
  workspaceName: 'Apo',
  context: '',
  engines: {} as never,
  routerModel: 'haiku',
  memoryModel: 'haiku',
  memoryLearning: 'approve',
  defaultLimit: 1000,
  approvalTtlHours: 24,
  theme: 'system',
  language: 'pt',
  ...p
})

// A stand-in for a provider: records every request and answers with what the test hands it.
function provider(answer: unknown) {
  const requests: { url: string; init: RequestInit }[] = []
  const f = (async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    return Response.json(answer)
  }) as unknown as typeof fetch
  return { f, requests, body: (i = 0) => JSON.parse(requests[i]!.init.body as string) as Record<string, unknown>, headers: (i = 0) => requests[i]!.init.headers as Record<string, string> }
}

const choiceQuestion = { name: 'who', type: 'choice' as const, instructions: 'Who replies?', criteria: { lia: 'Engineering', nina: 'Content' } }

describe('the classifiers a workspace has', () => {
  it('an install from before the section keeps the one Jev it was using', () => {
    expect(classifierList(settingsWith({}))).toEqual([])
    expect(classifierList(settingsWith({ routerModel: 'jev' }))).toEqual([JEV_CLASSIFIER])
    expect(classifierFor(settingsWith({ routerModel: 'jev' }), 'routing')).toEqual(JEV_CLASSIFIER)
    expect(classifierFor(settingsWith({ routerModel: 'jev' }), 'browser')).toBeUndefined()
    expect(classifierFor(settingsWith({ browserJev: true }), 'browser')).toEqual(JEV_CLASSIFIER)
    expect(classifierJobsOf(settingsWith({ routerModel: 'jev' }))).toEqual({ routing: 'jev' })
  })

  it('a saved list and its jobs are what counts, and a job left out is off', () => {
    const s = settingsWith({ classifiers: [luna, gemini], classifierJobs: { routing: 'luna' } })
    expect(classifierList(s)).toEqual([luna, gemini])
    expect(classifierFor(s, 'routing')).toEqual(luna)
    expect(classifierFor(s, 'browser')).toBeUndefined()
  })

  it('a row deleted from the list leaves no job pointing at it', () => {
    const s = settingsWith({ classifiers: [luna], routerModel: 'jev' })
    expect(classifierFor(s, 'routing')).toBeUndefined()
  })
})

describe('the four providers, one question shape', () => {
  it('OpenAI: /v1/decisions with an array of questions, choices as value/description', async () => {
    const api = provider({ model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'who', choice: 'lia', confidence: 0.9, probabilities: [{ value: 'lia', probability: 0.9 }, { value: 'nina', probability: 0.1 }] }] })
    const r = await ask({ target: luna, key: 'sk-o', state: 'o build quebrou', questions: [choiceQuestion], timeoutMs: 1000, fetch: api.f })
    expect('error' in r).toBe(false)
    expect(r).toMatchObject({ who: { choice: 'lia', probabilities: { lia: 0.9, nina: 0.1 } } })
    expect(api.requests[0]!.url).toBe('https://api.openai.com/v1/decisions')
    expect(api.headers()).toMatchObject({ Authorization: 'Bearer sk-o' })
    const body = api.body()
    expect(body['model']).toBe('gpt-6-luna')
    expect(body['input']).toBe('o build quebrou')
    expect(body['questions']).toEqual([{ type: 'choice', name: 'who', instructions: 'Who replies?', choices: [{ value: 'lia', description: 'Engineering' }, { value: 'nina', description: 'Content' }] }])
  })

  it('OpenAI: a yes/no goes in as a predicate, with what yes and no mean in the question itself', async () => {
    const api = provider({ answers: [{ type: 'predicate', name: 'q', probability: 0.82 }] })
    const r = await ask({
      target: luna,
      key: 'k',
      state: { a: 1 },
      questions: [{ name: 'q', type: 'yesno', instructions: 'Is it broken?', criteria: { true_description: 'it fails', false_description: 'it works' } }],
      timeoutMs: 1000,
      fetch: api.f
    })
    expect(r).toMatchObject({ q: { probability: 0.82 } })
    const q = (api.body()['questions'] as { type: string; instructions: string }[])[0]!
    expect(q.type).toBe('predicate')
    expect(q.instructions).toContain('it fails')
    expect(q.instructions).toContain('it works')
    // An object state goes in as JSON text: this endpoint takes a string or a list of messages.
    expect(typeof api.body()['input']).toBe('string')
  })

  it('OpenAI: a score goes in as ordered levels', async () => {
    const api = provider({ answers: [{ type: 'score', name: 'sev', score: 1.4, probabilities: [{ value: 1, label: 'broken', probability: 0.6 }] }] })
    const r = await ask({ target: luna, key: 'k', state: 'x', questions: [{ name: 'sev', type: 'score', instructions: 'How bad?', criteria: ['cosmetic', 'broken'] }], timeoutMs: 1000, fetch: api.f })
    expect(r).toMatchObject({ sev: { score: 1.4 } })
    expect((api.body()['questions'] as { levels: { label: string }[] }[])[0]!.levels).toEqual([{ label: 'cosmetic' }, { label: 'broken' }])
  })

  it('Google: /v1beta/decisions with the key in x-goog-api-key and questions keyed by id', async () => {
    const api = provider({ answers: { who: { type: 'choice', choice: 'nina', probabilities: { lia: 0.2, nina: 0.8 }, confidence: 0.8 } } })
    const r = await ask({ target: gemini, key: 'g-key', state: 'quem escreve o post?', questions: [choiceQuestion], timeoutMs: 1000, fetch: api.f })
    expect(r).toMatchObject({ who: { choice: 'nina' } })
    expect(api.requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions')
    expect(api.headers()).toMatchObject({ 'x-goog-api-key': 'g-key' })
    expect(api.body()).toMatchObject({ model: 'gemini-decision-1', input: 'quem escreve o post?', questions: { who: { type: 'choice', instructions: 'Who replies?', criteria: { lia: 'Engineering', nina: 'Content' } } } })
  })

  it('OpenRouter: Jev on the same body as TypeSafe, on the OpenRouter base URL', async () => {
    const api = provider({ answers: { who: { type: 'choice', choice: 'lia', probabilities: { lia: 0.7 } } } })
    const r = await ask({ target: router, key: 'or-key', state: 'o build quebrou', questions: [choiceQuestion], timeoutMs: 1000, fetch: api.f })
    expect(r).toMatchObject({ who: { choice: 'lia' } })
    expect(api.requests[0]!.url).toBe('https://openrouter.ai/api/v1/systemone')
    expect(api.headers()).toMatchObject({ Authorization: 'Bearer or-key' })
    expect(api.body()).toMatchObject({ model: 'typesafe/jev-1.13', state: 'o build quebrou' })
  })

  it('says which provider refused, and what came back malformed', async () => {
    const denied = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    expect(await ask({ target: luna, key: 'k', state: 'x', questions: [choiceQuestion], timeoutMs: 1000, fetch: denied })).toEqual({ error: 'a chave do OpenAI não vale mais' })
    const junk = (async () => Response.json({ nothing: true })) as unknown as typeof fetch
    expect(await ask({ target: gemini, key: 'k', state: 'x', questions: [choiceQuestion], timeoutMs: 1000, fetch: junk })).toEqual({ error: 'resposta do Google fora do formato' })
  })

  it('checks a key against its own provider before saving it', async () => {
    const ok = provider({ models: [] })
    await expect(checkClassifierKey(router, 'or-key', ok.f)).resolves.toBeUndefined()
    expect(ok.requests[0]!.url).toBe('https://openrouter.ai/api/v1/key')
    const g = provider({ models: [] })
    await expect(checkClassifierKey(gemini, 'g', g.f)).resolves.toBeUndefined()
    expect(g.requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect(g.headers()).toMatchObject({ 'x-goog-api-key': 'g' })
    const denied = (async () => new Response('', { status: 401 })) as unknown as typeof fetch
    await expect(checkClassifierKey(luna, 'bad', denied)).rejects.toThrow('OpenAI recusou essa chave.')
  })
})

describe('the router on another classifier', () => {
  const messages = [{ id: 'm1', conversationId: 'c1', author: { kind: 'person' as const, id: 'me' }, text: 'o build quebrou', at: 1 }]
  const agent = (id: string, handle: string): never =>
    ({ id, name: handle, handle, role: 'Engenharia', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }) as never

  it('asks the classifier chosen for routing, and names it in the reason', async () => {
    const api = provider({ answers: [{ type: 'choice', name: 'who', choice: 'lia', probabilities: [{ value: 'lia', probability: 0.84 }] }] })
    const r = await routeJev({ key: 'k', target: luna, messages, agents: [agent('a1', 'lia'), agent('a2', 'nina')], me: 'Apo', fetch: api.f })
    expect(r).toMatchObject({ reason: 'Luna, 84%' })
    expect((r as { agents: unknown[] }).agents).toHaveLength(1)
    expect(api.requests[0]!.url).toBe('https://api.openai.com/v1/decisions')
  })

  it('only TypeSafe reads a screenshot: another classifier says so instead of calling', async () => {
    const api = provider({ answers: {} })
    expect(await jevBox({ key: 'k', target: 'o botão Buscar', classifier: luna, jpeg: 'AAAA', fetch: api.f })).toMatchObject({ error: expect.stringContaining('OpenAI') })
    expect(api.requests).toHaveLength(0)
  })
})

// ---------- the jobs beyond the first two ----------
// A Jev that answered everything before is not only the router and the browser: it listened for the
// agents in mention mode, marked the best option on a question, kept only the next steps worth
// doing, and read each request to pick the model. Each of those is a job of its own here, and any
// classifier can serve it.
describe('the other jobs the same seam serves', () => {
  const said = (text: string): never => ({ id: 'm1', conversationId: 'c1', author: { kind: 'person', id: 'me' }, text, at: 1 }) as never
  const listener = (id: string, handle: string, role: string): never =>
    ({ id, name: handle, handle, role, color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'read', computer: false, archived: false }) as never

  it('an install with a Jev key keeps every job that key was serving, and nothing when it had none', () => {
    const before = { routerModel: 'jev', jevKey: true, jevRecommend: true, jevNextSteps: true }
    expect(classifierJobsOf(settingsWith(before))).toEqual({ routing: 'jev', listen: 'jev', recommend: 'jev', nextSteps: 'jev', smart: 'jev' })
    // The two switches that shipped off stay off: a job nobody turned on is not switched on here.
    expect(classifierJobsOf(settingsWith({ routerModel: 'jev', jevKey: true }))).toEqual({ routing: 'jev', listen: 'jev', smart: 'jev' })
    expect(classifierJobsOf(settingsWith({ jevRecommend: true }))).toEqual({})
  })

  it('listen: the listener joins when the classifier says the room cannot do without it', async () => {
    const api = provider({ answers: [{ type: 'choice', name: 'who', choice: 'astra', probabilities: [{ value: 'astra', probability: 0.9 }] }, { type: 'choice', name: 'needed', choice: '__nao' }] })
    const r = await listenJev({
      key: 'k',
      target: luna,
      messages: [],
      trigger: said('preciso de uma auditoria de segurança'),
      listeners: [listener('a3', 'astra', 'Auditoria')] as never,
      answering: [listener('a1', 'lia', 'Engenharia')] as never,
      me: 'Apo',
      fetch: api.f
    })
    expect(r).toMatchObject({ agents: [{ id: 'a3' }] })
    expect(api.requests[0]!.url).toBe('https://api.openai.com/v1/decisions')
    // Two questions travel together: who joins, and whether the room can do without them.
    const names = (api.body()['questions'] as { name: string }[]).map((q) => q.name)
    expect(names).toEqual(['who', 'needed'])
  })

  it('next steps: only the steps the classifier says to do now keep their tick', async () => {
    let n = 0
    const answers = ['do', 'later']
    const f = (async () => Response.json({ answers: [{ type: 'choice', name: 'pick', choice: answers[n++] }] })) as unknown as typeof fetch
    const decision = {
      name: 'next_steps',
      question: 'O que fazer agora?',
      options: [
        { label: 'Rodar o teste', description: 'destrava o resto' },
        { label: 'Polir o README', description: 'opcional' }
      ],
      multiple: true
    } as never
    const r = await stepsWorthDoing({ key: 'k', target: luna, decision, context: 'o build quebrou', fetch: f })
    expect(r).toMatchObject({ ticked: [0] })
  })

  it('smart routing reads the request on the classifier chosen for it', async () => {
    const api = provider({
      answers: {
        acao: { type: 'choice', choice: 'code', probabilities: { code: 0.8, chat: 0.2 } },
        complexidade: { type: 'score', score: 1 },
        capacidade: { type: 'score', score: 2 },
        raciocinio: { type: 'noul', noul: 0.9 }
      }
    })
    const roles = { code: { descriptor: 'Código', chain: [], floor: 't1', effort: 'medium' } } as never
    const j = await readPrompt({ key: 'g', target: gemini, prompt: 'conserta o build', roles, fetch: api.f })
    expect(j).toMatchObject({ role: 'code', complexity: 1, capability: 2, deepReasoning: 0.9 })
    expect(api.requests[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions')
    const questions = api.body()['questions'] as Record<string, { type: string }>
    expect(Object.keys(questions)).toEqual(['acao', 'complexidade', 'capacidade', 'raciocinio'])
    expect(questions['raciocinio']!.type).toBe('noul')
  })

  it('a failure names the classifier that failed, not TypeSafe', async () => {
    const denied = (async () => new Response('', { status: 429 })) as unknown as typeof fetch
    const r = await readPrompt({ key: 'k', target: gemini, prompt: 'oi', roles: {} as never, fetch: denied })
    expect('error' in r && r.error).toContain('Google')
  })
})
