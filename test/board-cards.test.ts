// The board's cards (src/renderer/src/board.ts): one per request, read off the messages as they are.
import { describe, expect, it } from 'vitest'
import { boardCards, familyOf, storyOf, tasksOf, titleOf, type BoardInput } from '../src/renderer/src/board'
import { cleanTitle, shortTitle, titledAlready } from '../src/shared/titles'
import type { Agent, Delegation, Inbox, Message, Run } from '../src/shared/types'

const NOW = new Date(2026, 10, 16, 15, 0).getTime()
const MIN = 60_000
const agent = (id: string, name: string): Agent => ({ id, name, handle: id, kind: 'agent' }) as unknown as Agent
const AGENTS = [agent('lia', 'Lia'), agent('theo', 'Theo'), agent('nina', 'Nina'), { ...agent('tuca', 'Tuca'), kind: 'tuca' } as unknown as Agent]
const NO_INBOX: Inbox = { approvals: [], questions: [] }
let n = 0
const me = (conversationId: string, text: string, at: number, extra: Partial<Message> = {}): Message => ({ id: `p${++n}`, conversationId, author: { kind: 'person', id: 'ana' }, text, at, ...extra })
const reply = (conversationId: string, by: string, at: number, run: Partial<Run>, extra: Partial<Message> = {}): Message =>
  ({ id: `r${++n}`, conversationId, author: { kind: 'agent', id: by }, text: extra.text ?? '', at, run: { status: 'done', steps: [], endedAt: at + MIN, ...run }, ...extra }) as Message
const input = (messages: Message[], o: Partial<BoardInput> = {}): BoardInput => {
  const byConv: Record<string, Message[]> = {}
  for (const m of messages) (byConv[m.conversationId] ??= []).push(m)
  return { you: 'ana', agents: AGENTS, messages: byConv, delegations: [], inbox: NO_INBOX, name: (id) => (id === 'bia' ? 'Bia' : id), ...o }
}

describe('the board’s cards', () => {
  it('a request and its reply are one card, titled by what was asked; where it stands comes from the reply', () => {
    const ask = me('dm', '@lia Corrigir o **bug** do checkout\nno Safari', NOW - 9 * MIN)
    const working = reply('dm', 'lia', NOW - 8 * MIN, { status: 'working', replyTo: ask.id, steps: [{ id: 's', label: 'Rodando os testes', status: 'running' }] })
    const [c] = boardCards(input([ask, working]), NOW)
    expect(c).toMatchObject({ title: 'Corrigir o bug do checkout', by: { kind: 'me', name: 'Você' }, agentId: 'lia', column: 'doing', state: 'working', requestId: ask.id })
  })

  it('a question to me goes to "Precisa de você"; my answer and the reply after it stay on the same card', () => {
    const ask = me('dm', 'Responder a cliente do reembolso', NOW - 20 * MIN)
    const q = reply('dm', 'lia', NOW - 19 * MIN, { status: 'waiting_input', replyTo: ask.id, question: 'Devolvo?' })
    const waiting = boardCards(input([ask, q], { inbox: { approvals: [], questions: [{ id: q.id } as Inbox['questions'][number]] } }), NOW)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ column: 'you', state: 'question' })
    const answer = me('dm', 'Devolve', NOW - 10 * MIN)
    const after = reply('dm', 'lia', NOW - 9 * MIN, { status: 'done', replyTo: answer.id }, { text: 'Devolvi.' })
    const done = boardCards(input([ask, { ...q, run: { ...q.run!, status: 'done' } }, answer, after]), NOW)
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ column: 'done', title: 'Responder a cliente do reembolso' })
    expect(done[0]!.replies.map((r) => r.id)).toEqual([q.id, after.id])
  })

  it("waiting on someone else's approval is still Fazendo, saying so", () => {
    const ask = me('c', 'Mandar o PR', NOW - 5 * MIN)
    const r = reply('c', 'lia', NOW - 4 * MIN, { status: 'waiting_approval', replyTo: ask.id, approvalId: 'ap1' })
    expect(boardCards(input([ask, r]), NOW)[0]).toMatchObject({ column: 'doing', state: 'other' })
    const mine = boardCards(input([ask, r], { inbox: { approvals: [{ id: 'ap1' } as Inbox['approvals'][number]], questions: [] } }), NOW)
    expect(mine[0]).toMatchObject({ column: 'you', state: 'approval' })
  })

  it('a request split among agents: the parts hang from it, it waits on them, and the reply that puts them together ends it', () => {
    const ask = me('eng', 'Preparar o lançamento de sexta', NOW - 14 * MIN)
    const split = reply('eng', 'lia', NOW - 13 * MIN, { status: 'done', replyTo: ask.id, delegations: [{ id: 'd1', to: 'theo', conversationId: 'dados', rootId: 'root1' }, { id: 'd2', to: 'nina', conversationId: 'cont', rootId: 'root2' }] })
    const root1 = reply('dados', 'lia', NOW - 12 * MIN, { status: 'done', delegation: { id: 'd1', to: 'theo', conversationId: 'dados', rootId: 'root1' } }, { id: 'root1', text: '@theo Números do lançamento' })
    const theo = reply('dados', 'theo', NOW - 11 * MIN, { status: 'working', handed: 'd1' }, { threadId: 'root1' })
    const d = (id: string, to: string, state: Delegation['state'], text: string): Delegation => ({ id, from: 'lia', to, conversationId: to === 'theo' ? 'dados' : 'cont', rootId: id === 'd1' ? 'root1' : 'root2', originConversationId: 'eng', originMessageId: split.id, requestedBy: 'ana', text, state, createdAt: NOW - 12 * MIN }) as Delegation
    const open = boardCards(input([ask, split, root1, theo], { delegations: [d('d1', 'theo', 'open', 'Números do lançamento'), d('d2', 'nina', 'open', 'Post de anúncio')] }), NOW)
    const parent = open.find((c) => c.title === 'Preparar o lançamento de sexta')!
    expect(parent).toMatchObject({ column: 'doing', state: 'parts' })
    expect(parent.parts).toHaveLength(2)
    const parts = open.filter((c) => c.parent === parent.id)
    expect(parts.map((p) => [p.title, p.agentId, p.by.name])).toEqual(expect.arrayContaining([['Números do lançamento', 'theo', 'Lia'], ['Post de anúncio', 'nina', 'Lia']]))
    expect(open.some((c) => c.title.includes('@theo') || c.requestId === undefined)).toBe(false) // the note opening the part isn't a card
    expect(familyOf(open, parts[0]!.id)).toEqual(new Set([parent.id, ...parent.parts]))

    const together = reply('eng', 'lia', NOW - 2 * MIN, { status: 'done' }, { text: 'Plano pronto.' })
    const done = boardCards(input([ask, split, root1, { ...theo, run: { ...theo.run!, status: 'done' } }, together], { delegations: [d('d1', 'theo', 'done', 'Números'), d('d2', 'nina', 'done', 'Post')] }), NOW)
    const p2 = done.find((c) => c.id === parent.id)!
    expect(p2).toMatchObject({ column: 'done', state: 'done' })
    expect(p2.replies.at(-1)!.id).toBe(together.id)
  })

  it('a routine’s run is titled by the routine; failed and paused ones go to the stuck strip', () => {
    const r = { id: 'rt', conversationId: 'cli', author: { kind: 'routine', id: 'routine1' }, text: 'Checar pedidos', at: NOW - 30 * MIN, routine: { name: 'Checar pedidos parados', scheduledAt: NOW - 30 * MIN } } as unknown as Message
    const failed = reply('cli', 'lia', NOW - 29 * MIN, { status: 'failed', error: 'O Linear pediu login.' })
    expect(boardCards(input([r, failed]), NOW)[0]).toMatchObject({ title: 'Checar pedidos parados', by: { kind: 'routine' }, column: 'stuck', state: 'failed' })
    const paused = reply('cli', 'lia', NOW - 29 * MIN, { status: 'paused' })
    expect(boardCards(input([r, paused]), NOW)[0]).toMatchObject({ column: 'stuck', state: 'paused' })
  })

  it('done shows today only; open work shows however old; Tuca and empty replies are left out', () => {
    const old = me('dm', 'Antigo', NOW - 30 * 60 * MIN)
    const oldDone = reply('dm', 'lia', NOW - 29 * 60 * MIN, { status: 'done', replyTo: old.id, endedAt: NOW - 29 * 60 * MIN })
    const oldOpen = me('dm2', 'Ainda aberto', NOW - 40 * 60 * MIN)
    const working = reply('dm2', 'theo', NOW - 40 * 60 * MIN, { status: 'working', replyTo: oldOpen.id })
    const tuca = reply('dm3', 'tuca', NOW - MIN, { status: 'working' }, { text: 'oi' })
    const cards = boardCards(input([old, oldDone, oldOpen, working, tuca]), NOW)
    expect(cards.map((c) => c.title)).toEqual(['Ainda aberto'])
  })

  it('titles drop mentions and Markdown, and stay short', () => {
    expect(titleOf('\n\n@lia   [veja](http://x) o `log`')).toBe('Veja o log')
    expect(titleOf('x'.repeat(300)).length).toBeLessThanOrEqual(60)
    expect(titleOf('qualquer coisa longa', 'Notas da versão 0.2.37')).toBe('Notas da versão 0.2.37')
  })

  it('a title skips greetings, the name it is addressed to and nudges, and keeps the first sentence', () => {
    expect(shortTitle('Otto, publique a v0.2.35 do Tucano (desktop), com o OK do Eduardo (dado às 08:44 de 16/11)')).toBe('Publique a v0.2.35 do Tucano (desktop), com o OK do…')
    expect(shortTitle('Quero o seguinte. Hoje a gente facilita a importação de quem vem do Open Bot.')).toBe('Hoje a gente facilita a importação de quem vem do Open Bot')
    expect(shortTitle('Bom dia! Revise o PR #531')).toBe('Revise o PR #531')
    expect(shortTitle('E aí?\nComo ficou o deploy do site?')).toBe('Como ficou o deploy do site?')
    expect(cleanTitle('Título: "Notas da versão."\n')).toBe('Notas da versão')
    expect(titledAlready('Revise o PR #531')).toBe(true)
    expect(titledAlready('Revise o PR #531\ne depois junte')).toBe(false)
  })
})

describe('one task, one card', () => {
  const split = (): { ask: Message; msgs: Message[]; d: (id: string, to: string, state: Delegation['state']) => Delegation; splitId: string } => {
    const ask = me('eng', 'Lançar a 0.2.35', NOW - 60 * MIN)
    const s = reply('eng', 'lia', NOW - 59 * MIN, { status: 'done', replyTo: ask.id, delegations: [{ id: 'd1', to: 'theo', conversationId: 'dados', rootId: 'root1' }, { id: 'd2', to: 'nina', conversationId: 'cont', rootId: 'root2' }] })
    const d = (id: string, to: string, state: Delegation['state']): Delegation => ({ id, from: 'lia', to, conversationId: to === 'theo' ? 'dados' : 'cont', rootId: id === 'd1' ? 'root1' : 'root2', originConversationId: 'eng', originMessageId: s.id, requestedBy: 'ana', text: to === 'theo' ? 'Revisar o commit' : 'Escrever o post', state, createdAt: NOW - 58 * MIN }) as Delegation
    return { ask, msgs: [ask, s], d, splitId: s.id }
  }

  it('a part that asks me puts the whole task in "Precisa de você", once, saying who asks', () => {
    const { msgs, d } = split()
    const theo = reply('dados', 'theo', NOW - 50 * MIN, { status: 'done', handed: 'd1' }, { threadId: 'root1', text: 'Revisado.' })
    const nina = reply('cont', 'nina', NOW - 40 * MIN, { status: 'waiting_input', handed: 'd2', question: 'Posto sem imagem?' }, { threadId: 'root2' })
    const cards = boardCards(input([...msgs, theo, nina], { delegations: [d('d1', 'theo', 'done'), d('d2', 'nina', 'open')], inbox: { approvals: [], questions: [{ id: nina.id } as Inbox['questions'][number]] } }), NOW)
    const tasks = tasksOf(cards)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: 'Lançar a 0.2.35', column: 'you' })
    expect(tasks[0]!.asking!.agentId).toBe('nina')
    expect(tasks[0]!.crew).toEqual([{ agentId: 'nina', state: 'you' }, { agentId: 'lia', state: 'waiting' }, { agentId: 'theo', state: 'done' }])
  })

  it('a task delivered still goes to "Precisa de você" while a part of it asks me', () => {
    const { msgs, d } = split()
    const nina = reply('cont', 'nina', NOW - 40 * MIN, { status: 'waiting_input', handed: 'd2', question: 'Posto sem imagem?' }, { threadId: 'root2' })
    const together = reply('eng', 'lia', NOW - 5 * MIN, { status: 'done' }, { text: 'Lançado.' })
    const tasks = tasksOf(boardCards(input([...msgs, nina, together], { delegations: [d('d1', 'theo', 'done'), d('d2', 'nina', 'open')], inbox: { approvals: [], questions: [{ id: nina.id } as Inbox['questions'][number]] } }), NOW))
    expect(tasks.map((t) => t.column)).toEqual(['you'])
  })

  it('while the parts run, the task is in Fazendo and its crew is who is on it now', () => {
    const { msgs, d } = split()
    const theo = reply('dados', 'theo', NOW - 50 * MIN, { status: 'working', handed: 'd1' }, { threadId: 'root1' })
    const tasks = tasksOf(boardCards(input([...msgs, theo], { delegations: [d('d1', 'theo', 'open'), d('d2', 'nina', 'open')] }), NOW))
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.column).toBe('doing')
    expect(tasks[0]!.crew[0]).toEqual({ agentId: 'theo', state: 'working' })
  })

  it('its story: who asked, who split it, each part, in order', () => {
    const { msgs, d } = split()
    const theo = reply('dados', 'theo', NOW - 50 * MIN, { status: 'done', handed: 'd1' }, { threadId: 'root1', text: 'Revisado.' })
    const [task] = tasksOf(boardCards(input([...msgs, theo], { delegations: [d('d1', 'theo', 'done'), d('d2', 'nina', 'open')] }), NOW))
    expect(storyOf(task!).map((b) => [b.kind, b.agentId ?? b.by?.name, b.state])).toEqual([
      ['asked', 'Você', 'waiting'],
      ['split', 'lia', 'done'],
      ['part', 'theo', 'done'],
      ['part', 'nina', 'waiting']
    ])
  })
})

describe('titles that say nothing', () => {
  it('a nudge alone keeps its words', () => {
    expect(shortTitle('E aí?')).toBe('E aí?')
    expect(shortTitle('Oi')).toBe('Oi')
  })
})
