import { describe, expect, it } from 'vitest'
import { mentioned, stamp, systemPrompt, transcript } from '../src/core/context'
import type { Agent, Conversation, Message } from '../src/shared/types'

const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({
  id,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  handle,
  role: '',
  color: 'sky',
  instructions: '',
  modelId: 'sonnet',
  effort: 'medium',
  limit: 1000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false,
  ...extra
})

const lia = agent('a1', 'lia', { role: 'Engenharia', instructions: 'Mostra código quando ajuda.' })
const theo = agent('a2', 'theo', { role: 'Dados' })
const channel: Conversation = { id: 'c1', kind: 'channel', name: 'engenharia', members: ['a1', 'a2'] }
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }

describe('mentioned', () => {
  it('finds handles in order, once each, ignoring case and unknown handles', () => {
    expect(mentioned('@Theo e @lia, olhem isso. @lia de novo. @ninguem', [lia, theo]).map((a) => a.id)).toEqual(['a2', 'a1'])
  })

  it('does not match emails', () => {
    expect(mentioned('manda pra eu@lia.com', [lia])).toEqual([])
  })

  it('ignores handles inside fenced code blocks and inline code', () => {
    const text = 'veja:\n```\nchame a @lia pra revisar\n```\ne inline `chame a @lia aqui` fim'
    expect(mentioned(text, [lia])).toEqual([])
  })

  it('still finds handles around code, and an unterminated fence stops the scan', () => {
    expect(mentioned('```\ncódigo\n```\nfala com @lia', [lia]).map((a) => a.id)).toEqual(['a1'])
    expect(mentioned('bloco:\n```\n@lia sem fechar', [lia])).toEqual([])
  })

  it('ignores a fenced block shown inside a longer fence', () => {
    expect(mentioned('````\n```\n@lia revisa\n```\n````\nfala com @lia', [lia]).map((a) => a.id)).toEqual(['a1'])
    expect(mentioned('````md\n```\n@lia revisa\n```\n````', [lia])).toEqual([])
  })
})

describe('systemPrompt', () => {
  it('includes identity, workspace context, instructions and the room', () => {
    const s = systemPrompt({ agent: lia, settings: { workspaceName: 'Edu', context: 'Trabalho com agentes.' }, conversation: channel, peers: [theo] })
    expect(s).toContain('Você é Lia (@lia)')
    expect(s).toContain('Seu papel: Engenharia.')
    expect(s).toContain('## Sobre Edu\nTrabalho com agentes.')
    expect(s).toContain('## Suas instruções\nMostra código quando ajuda.')
    expect(s).toContain('canal #engenharia')
    expect(s).toContain('Theo (@theo, Dados)')
  })

  it('tells a DM’s agent, who has no one else in the room, that it can call one in by handle', () => {
    const withRoster = systemPrompt({ agent: theo, settings: { workspaceName: 'Edu', context: '' }, conversation: dm, peers: [], roster: true })
    expect(withRoster).toContain('@handle')
    expect(withRoster).toContain('A ferramenta equipe lista o time')
    // Without the tool it isn't told to use it, and a channel is told what it already was.
    expect(systemPrompt({ agent: theo, settings: { workspaceName: 'Edu', context: '' }, conversation: dm, peers: [] })).not.toContain('equipe')
    const inChannel = systemPrompt({ agent: lia, settings: { workspaceName: 'Edu', context: '' }, conversation: channel, peers: [theo], roster: true })
    expect(inChannel).toContain('canal de equipe')
    expect(inChannel).not.toContain('A ferramenta equipe')
  })

  it('leaves out empty sections and describes a DM', () => {
    const s = systemPrompt({ agent: theo, settings: { workspaceName: 'Edu', context: '  ' }, conversation: dm, peers: [] })
    expect(s).not.toContain('## Sobre')
    expect(s).not.toContain('## Suas instruções')
    expect(s).toContain('conversa direta (DM) com Edu')
  })
})

describe('transcript', () => {
  const at = new Date(2026, 9, 17, 14, 2).getTime()
  const off = -new Date(at).getTimezoneOffset()
  const stampZone = `UTC${off < 0 ? '-' : '+'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`
  const messages: Message[] = [
    { id: 'm1', conversationId: 'c1', author: { kind: 'person', id: 'me' }, text: 'Oi, time', at },
    { id: 'm2', conversationId: 'c1', author: { kind: 'system' }, text: 'Router chamou Lia', at },
    { id: 'm3', conversationId: 'c1', author: { kind: 'agent', id: 'a2' }, text: 'Oi!', at },
    { id: 'm4', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: 'Olá', at },
    { id: 'm5', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at }
  ]

  it('labels authors, marks the agent itself, skips system lines and empty messages', () => {
    const blocks = transcript({ agent: lia, conversation: channel, messages, agents: [lia, theo], me: 'Edu' })
    expect(blocks).toEqual(['Conversa em #engenharia, das mais antigas pras mais novas:', '[Edu · sáb 17/10 14:02]\nOi, time', '[Theo · agente · sáb 17/10 14:02]\nOi!', '[Lia (você) · agente · sáb 17/10 14:02]\nOlá'])
    // An agent whose tools filter by time gets the year, the offset and the Unix seconds too.
    const when = `sáb 17/10/2026 14:02 (${stampZone}, unix ${Math.floor(at / 1000)})`
    expect(transcript({ agent: lia, conversation: channel, messages, agents: [lia, theo], me: 'Edu', unix: true })[1]).toBe(`[Edu · ${when}]\nOi, time`)
  })

  it('gives each message its time with the year, the UTC offset and the Unix seconds, for tools that filter by time', () => {
    expect(stamp(at)).toMatch(/^sáb 17\/10\/2026 14:02 \(UTC[+-]\d\d:\d\d, unix \d{10}\)$/)
    expect(Number(/unix (\d+)/.exec(stamp(at))![1])).toBe(Math.floor(at / 1000))
  })

  it('tells an agent with connectors to read only the window it needs, and not to wait with sleep', () => {
    const s = systemPrompt({ agent: theo, settings: { workspaceName: 'Edu', context: '' }, conversation: dm, peers: [], connectors: true })
    expect(s).toContain('oldest = (unix da última mensagem − 3600)')
    expect(s).toContain('Não espere com sleep')
    expect(s).toContain('Se o pedido é sobre algo de agora') // a table of open issues isn't read for the last hour only
    expect(systemPrompt({ agent: theo, settings: { workspaceName: 'Edu', context: '' }, conversation: dm, peers: [] })).not.toContain('oldest')
  })

  it("keeps every block of a turn in the next one, so they come from the cache; a task goes last, with the time", () => {
    const first = transcript({ agent: lia, conversation: channel, messages: messages.slice(0, 3), agents: [lia, theo], me: 'Edu' })
    const next = transcript({ agent: lia, conversation: channel, messages, agents: [lia, theo], me: 'Edu', task: 'Edu aprovou o pedido.' })
    expect(next.slice(0, first.length)).toEqual(first)
    expect(next.at(-1)).toMatch(/^Edu aprovou o pedido\.\n\nAgora: .+\.$/)
  })
})

describe('what waits for an approval, at the agent’s level', () => {
  const at = (a: Agent, autonomy?: 'careful' | 'normal' | 'free') => systemPrompt({ agent: a, settings: { workspaceName: 'Edu', context: '', autonomy }, conversation: dm, peers: [] })
  it('Normal (the default): sensitive actions become a request', () => {
    expect(at(theo)).toContain('Ações sensíveis (enviar, apagar, publicar, pagar) não rodam na hora')
  })
  it('Careful: anything that changes something asks, from Settings or the agent', () => {
    expect(at(theo, 'careful')).toContain('Edu quer aprovar tudo que muda algo')
    expect(at({ ...theo, autonomy: 'careful' }, 'free')).toContain('Edu quer aprovar tudo que muda algo')
  })
  it('No guardrails: it acts without asking, and never hears that sensitive actions wait', () => {
    const p = at({ ...theo, autonomy: 'free' })
    expect(p).toContain('Edu deixou você agir sem pedir aprovação')
    expect(p).not.toContain('Ações sensíveis')
  })
})
