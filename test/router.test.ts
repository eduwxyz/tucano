import { describe, expect, it } from 'vitest'
import { handoffPrompt, handoffSystem, parseRoute, planBrief, routerPrompt, routerSystem } from '../src/core/router'
import type { Agent, Connector, Message } from '../src/shared/types'

const agent = (id: string, handle: string, role: string, instructions = ''): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role,
  color: 'sky',
  instructions,
  modelId: 'sonnet',
  effort: 'low',
  limit: 1000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false
})
const lia = agent('a1', 'lia', 'Engenharia', 'Ajuda com código e bugs.\nSegunda linha que não entra.')
const nina = agent('a2', 'nina', 'Conteúdo')
const team = [lia, nina]

describe('parseRoute', () => {
  it('reads plain JSON and JSON inside a code fence', () => {
    expect(parseRoute('{"handles":["lia"],"reason":"bug"}', team)).toEqual({ plan: [[lia]], reason: 'bug' })
    expect(parseRoute('```json\n{\n "handles": ["@Nina"],\n "reason": "post"\n}\n```', team)).toEqual({ plan: [[nina]], reason: 'post' })
  })

  it('accepts an empty choice', () => {
    expect(parseRoute('{"handles":[],"reason":"cumprimento"}', team)).toEqual({ plan: [], reason: 'cumprimento' })
  })

  it('calls every agent when the message is for the whole group, like a greeting, past the cap of two', () => {
    const three = [...team, agent('a3', 'theo', 'Dados')]
    expect(parseRoute('{"handles":[],"todos":true,"reason":"cumprimento pro grupo"}', three)).toEqual({ plan: [three], reason: 'cumprimento pro grupo' })
    expect(parseRoute('{"handles":["lia"],"everyone":true,"reason":"greeting"}', three)?.plan.flat()).toEqual(three)
  })

  it('drops unknown handles and duplicates, and caps at two', () => {
    const three = [...team, agent('a3', 'theo', 'Dados')]
    expect(parseRoute('{"handles":["ghost","lia","lia","nina","theo"],"reason":""}', three)?.plan).toEqual([[lia, nina]])
  })

  it('reads the layers of a plan, in order', () => {
    const theo = agent('a3', 'theo', 'Dados')
    const three = [...team, theo]
    expect(parseRoute('{"plano":[["lia"],["nina","theo"]],"reason":"um acha, o outro escreve"}', three)).toEqual({ plan: [[lia], [nina, theo]], reason: 'um acha, o outro escreve' })
    expect(parseRoute('{"plan":[["nina"],["lia"]],"reason":""}', three)?.plan).toEqual([[nina], [lia]])
  })

  it('caps a plan at two layers and three agents, and nobody answers twice', () => {
    const theo = agent('a3', 'theo', 'Dados')
    const bia = agent('a4', 'bia', 'Produto')
    const four = [...team, theo, bia]
    expect(parseRoute('{"plano":[["lia","nina"],["theo","bia"]],"reason":""}', four)?.plan).toEqual([[lia, nina], [theo]])
    expect(parseRoute('{"plano":[["lia"],["nina"],["theo"]],"reason":""}', four)?.plan).toEqual([[lia], [nina]])
    expect(parseRoute('{"plano":[["lia"],["lia"]],"reason":""}', four)?.plan).toEqual([[lia]])
  })

  it('returns null when there is no usable JSON', () => {
    expect(parseRoute('acho que a Lia', team)).toBeNull()
    expect(parseRoute('{"who":"lia"}', team)).toBeNull()
    expect(parseRoute('{handles: [lia]}', team)).toBeNull()
  })
})

describe('planBrief', () => {
  it('tells every layer of a plan which one is theirs and who answers next', () => {
    const plan = [[lia], [nina]]
    const first = planBrief(plan, lia, 'um acha, o outro escreve')
    expect(first).toContain('O roteador dividiu esta mensagem em 2 camadas')
    expect(first).toContain('- 1ª camada: Lia\n- 2ª camada: Nina')
    expect(first).toContain('Você é da 1ª camada')
    expect(first).toContain('A camada seguinte só começa quando a sua terminar')
    expect(first).toContain('Motivo do plano: um acha, o outro escreve')
    expect(planBrief(plan, nina, '')).toContain('Você é da 2ª camada')
  })

  it('names the agents of a layer of two, and says nothing without a reason', () => {
    const first = planBrief([[lia, nina], [agent('a3', 'theo', 'Dados')]], lia, '')
    expect(first).toContain('- 1ª camada: Lia e Nina')
    expect(first).not.toContain('Motivo do plano')
  })

  it('says nothing for a single layer, which has no order to keep', () => {
    expect(planBrief([[lia, nina]], lia, 'dois assuntos')).toBe('')
    expect(planBrief([], lia, '')).toBe('')
  })

  it('says nothing for an agent that is not in the plan', () => {
    expect(planBrief([[lia], [nina]], agent('a3', 'theo', 'Dados'), 'um acha, o outro escreve')).toBe('')
  })
})

describe('routerPrompt', () => {
  it('asks for a plan of layers, one agent at a time', () => {
    expect(routerSystem()).toContain('"plano"')
    expect(routerSystem()).toContain('a camada seguinte só começa quando a anterior terminar')
  })
  it('lists agents with role and first instruction line, and the last messages', () => {
    const messages: Message[] = [
      { id: 'm1', conversationId: 'c', author: { kind: 'me' }, text: 'o build quebrou', at: 1 },
      { id: 'm2', conversationId: 'c', author: { kind: 'system' }, text: 'Chamei Lia', at: 2 },
      { id: 'm3', conversationId: 'c', author: { kind: 'agent', id: 'a1' }, text: 'olhando', at: 3 }
    ]
    const p = routerPrompt({ messages, agents: team, me: 'Edu' })
    expect(p).toContain('- lia: Lia, Engenharia: Ajuda com código e bugs.')
    expect(p).not.toContain('Segunda linha')
    expect(p).toContain('[Edu] o build quebrou')
    expect(p).toContain('[Lia] olhando')
    expect(p).not.toContain('Chamei')
  })

  it('says which connectors each agent can use', () => {
    const linear = { id: 'k1', name: 'Linear' } as Connector
    const demo = { id: 'k2', name: 'Demo' } as Connector
    const withAccess = { ...lia, grants: { k1: 'read', k2: 'read_write' } } as Agent
    const p = routerPrompt({ messages: [], agents: [withAccess, { ...nina, grants: { k1: 'none' } }], me: 'Edu', connectors: [linear, demo] })
    expect(p).toContain('- lia: Lia, Engenharia: Ajuda com código e bugs. · acessa: Linear (só leitura), Demo (leitura e escrita)')
    expect(p).toContain('- nina: Nina, Conteúdo · acessa: nenhum sistema externo')
  })
})

describe('handoffPrompt', () => {
  const messages: Message[] = [
    { id: 'm1', conversationId: 'c', author: { kind: 'me' }, text: 'revisa o build', at: 1 },
    { id: 'm2', conversationId: 'c', author: { kind: 'system' }, text: 'Chamei Lia', at: 2 }
  ]
  const p = handoffPrompt({ reply: 'Valeu, @nina!', author: lia, candidates: [nina], messages, members: team, me: 'Edu' })

  it('lists the mentioned agents with role, and marks the reply being judged', () => {
    expect(p).toContain('- nina: Nina, Conteúdo')
    expect(p).not.toContain('- lia:')
    expect(p).toContain('<reply>\nValeu, @nina!\n</reply>')
    expect(p).toContain('Lia')
  })

  it('includes the recent messages and skips system notes', () => {
    expect(p).toContain('[Edu] revisa o build')
    expect(p).not.toContain('Chamei')
  })

  it('says who is already replying, only when someone is', () => {
    expect(p).not.toContain('Já estão respondendo')
    const busy = handoffPrompt({ reply: 'Valeu, @nina!', author: lia, candidates: [nina], busy: [nina], messages, members: team, me: 'Edu' })
    expect(busy).toContain('Já estão respondendo aqui: Nina.')
    expect(busy).toContain('algo novo')
  })

  it('does not count waiting for someone as a request', () => {
    expect(handoffSystem()).toContain('Fico esperando o aviso do Léo')
  })
})

describe('parseRoute with hand-off candidates', () => {
  it('accepts an empty list and drops handles outside the candidates', () => {
    expect(parseRoute('{"handles":[],"reason":"agradecimento"}', [nina])).toEqual({ plan: [], reason: 'agradecimento' })
    expect(parseRoute('{"handles":["lia","nina"],"reason":""}', [nina])?.plan.flat()).toEqual([nina])
  })

  it('keeps all three when a reply hands the turn to three candidates', () => {
    const three = [lia, nina, agent('a3', 'theo', 'Dados')]
    expect(parseRoute('{"handles":["lia","nina","theo"],"reason":"pedido"}', three, three.length)?.plan.flat()).toEqual(three)
  })
})
