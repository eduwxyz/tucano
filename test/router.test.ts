import { describe, expect, it } from 'vitest'
import { parseRoute, routerPrompt } from '../src/core/router'
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
    expect(parseRoute('{"handles":["lia"],"reason":"bug"}', team)).toEqual({ agents: [lia], reason: 'bug' })
    expect(parseRoute('```json\n{\n "handles": ["@Nina"],\n "reason": "post"\n}\n```', team)).toEqual({ agents: [nina], reason: 'post' })
  })

  it('accepts an empty choice', () => {
    expect(parseRoute('{"handles":[],"reason":"cumprimento"}', team)).toEqual({ agents: [], reason: 'cumprimento' })
  })

  it('calls every agent when the message is for the whole group, like a greeting, past the cap of two', () => {
    const three = [...team, agent('a3', 'theo', 'Dados')]
    expect(parseRoute('{"handles":[],"todos":true,"reason":"cumprimento pro grupo"}', three)).toEqual({ agents: three, reason: 'cumprimento pro grupo' })
    expect(parseRoute('{"handles":["lia"],"everyone":true,"reason":"greeting"}', three)?.agents).toEqual(three)
  })

  it('drops unknown handles and duplicates, and caps at two', () => {
    const three = [...team, agent('a3', 'theo', 'Dados')]
    expect(parseRoute('{"handles":["ghost","lia","lia","nina","theo"],"reason":""}', three)?.agents).toEqual([lia, nina])
  })

  it('returns null when there is no usable JSON', () => {
    expect(parseRoute('acho que a Lia', team)).toBeNull()
    expect(parseRoute('{"who":"lia"}', team)).toBeNull()
    expect(parseRoute('{handles: [lia]}', team)).toBeNull()
  })
})

describe('routerPrompt', () => {
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
