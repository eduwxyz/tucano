// The stand-in for TypeSafe's questions, used when a machine has no key: it has to answer the listen
// question the way the real one would, and the router's too, or the frames and the app are wrong.
import { describe, expect, it } from 'vitest'
import type { Agent, Message } from '../src/shared/types'
import { listenJev } from '../src/core/jev'
import { LISTEN_STUB_KEY, listenStub } from '../src/core/jev-fake'

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
const lia = agent('a1', 'lia', 'Engenharia')
const astra = agent('a3', 'astra', 'Auditoria de segurança e planos')
const said = (text: string): Message => ({ id: 'm1', conversationId: 'c1', author: { kind: 'person', id: 'me' }, text, at: 1 })
const ask = (handle: string) =>
  listenJev({ key: LISTEN_STUB_KEY, messages: [], trigger: said('revise a autenticação do gateway'), listeners: [astra], answering: [lia], me: 'Edu', fetch: listenStub(handle) })

describe('the TypeSafe stand-in', () => {
  it('brings in the agent it was told to, with a percentage, like the real answer', async () => {
    expect(await ask('astra')).toMatchObject({ agents: [astra], reason: 'Astra, 88%' })
  })

  it('keeps every listener out when it was told none', async () => {
    expect(await ask('none')).toMatchObject({ agents: [], reason: '' })
  })

  it('answers the router question too, with the agent it was told to', async () => {
    const res = await listenStub('astra')('https://api.typesafe.example/systemone', {
      method: 'POST',
      body: JSON.stringify({ questions: { who: { type: 'choice', criteria: { lia: 'Lia, Engenharia', astra: 'Astra, Auditoria' } } } })
    })
    const body = (await res.json()) as { answers: { who: { choice: string; probabilities: Record<string, number> } } }
    expect(body.answers.who.choice).toBe('astra')
    expect(body.answers.who.probabilities['astra']).toBe(0.88)
  })
})
