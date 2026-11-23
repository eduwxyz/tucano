// The listen and smart-routing jobs belong to the Classifiers section like the others: the job is
// written once, and whichever provider is chosen for it answers. These cases hold the two seams that
// were TypeSafe-only: a listener picked by another provider, and the routing read answered elsewhere.
import { describe, expect, it } from 'vitest'
import type { Agent, Message } from '../src/shared/types'
import type { ClassifierConfig } from '../src/shared/classifiers'
import { listenJev } from '../src/core/jev'
import { demandOf, readPrompt } from '../src/core/model-routing'

const agent = (id: string, handle: string, role: string): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role,
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'read',
  computer: false,
  archived: false
})
const astra = agent('a3', 'astra', 'Auditoria')
const lia = agent('a1', 'lia', 'Engenharia')
const said = (text: string): Message => ({ id: 'm1', conversationId: 'c1', author: { kind: 'person', id: 'me' }, text, at: 1 })

const luna: ClassifierConfig = { id: 'c1', name: 'Luna', provider: 'openai', model: 'gpt-6-luna' }
const gemini: ClassifierConfig = { id: 'c2', name: 'Gemini Decision', provider: 'gemini', model: 'gemini-decision-1' }

// OpenAI answers an array, one entry per question, each naming itself.
function openai(listen: { choice: string; probabilities: Record<string, number> }) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { questions: { name: string }[]; model: string; input: string }
    calls.push({ url, body })
    return Response.json({
      answers: [
        { name: 'who', type: 'choice', choice: listen.choice, probabilities: listen.probabilities },
        { name: 'needed', type: 'choice', choice: '__nao', probabilities: {} }
      ]
    })
  }) as unknown as typeof fetch
  return { f, calls }
}

describe('a job answered by another provider', () => {
  it('asks OpenAI for the listener, in its own shape, and reads the pick back', async () => {
    const api = openai({ choice: 'astra', probabilities: { astra: 0.9, __ninguem: 0.1 } })
    const r = await listenJev({ key: 'sk-x', target: luna, messages: [], trigger: said('preciso de uma auditoria'), listeners: [astra], answering: [lia], me: 'Edu', fetch: api.f })
    expect(r).toMatchObject({ agents: [astra], reason: 'Astra, 90%' })
    const call = api.calls[0]!
    expect(call.url).toContain('/decisions')
    expect(call.body['model']).toBe('gpt-6-luna')
    expect(Array.isArray(call.body['questions'])).toBe(true)
    expect((call.body['questions'] as { name: string }[]).map((q) => q.name)).toEqual(['who', 'needed'])
    expect(typeof call.body['input']).toBe('string')
  })

  it('names the provider that failed, not TypeSafe', async () => {
    const failing = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    const r = await listenJev({ key: 'sk-x', target: luna, messages: [], trigger: said('oi'), listeners: [astra], answering: [], me: 'Edu', fetch: failing })
    expect('error' in r && r.error).toContain('OpenAI')
  })
})

describe('the routing read on another provider', () => {
  it('asks Gemini the same four questions and judges the reply from its answers', async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = []
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) as Record<string, unknown> })
      return Response.json({
        answers: {
          acao: { type: 'choice', choice: 'engenharia', probabilities: { engenharia: 0.7, conteudo: 0.3 } },
          complexidade: { type: 'score', score: 2 },
          capacidade: { type: 'score', score: 2 },
          raciocinio: { type: 'predicate', noul: 0.8 }
        }
      })
    }) as unknown as typeof fetch
    const read = await readPrompt({ key: 'g-key', target: gemini, prompt: 'desenhe o cache de sessões', roles: {}, fetch: f })
    expect('error' in read).toBe(false)
    if ('error' in read) return
    expect(read.role).toBe('engenharia')
    expect(read.complexity).toBe(2)
    expect(read.capability).toBe(2)
    expect(read.deepReasoning).toBeCloseTo(0.8)
    // The role distribution's top stands in for TypeSafe's stated confidence.
    expect(read.roleConfidence).toBeCloseTo(0.7)
    expect(demandOf(read)).toBeGreaterThan(1)
    expect(calls[0]!.url).toContain('/decisions')
    expect(calls[0]!.body['model']).toBe('gemini-decision-1')
  })
})
