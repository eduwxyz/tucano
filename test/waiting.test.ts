import { describe, expect, it } from 'vitest'
import { mineIn, waitingIn, waitingTitle } from '../src/renderer/src/components/waiting'
import type { Approval, Inbox, Message, RunStatus } from '../src/shared/types'

const msg = (id: string, conversationId: string, agentId: string, status: RunStatus): Message => ({ id, conversationId, author: { kind: 'agent', id: agentId }, text: '', at: 0, run: { status, steps: [] } })
const names: Record<string, string> = { leo: 'Leo', bia: 'Bia', nina: 'Nina' }
const nameOf = (id: string): string => names[id] ?? id

describe('waitingIn', () => {
  it('reads the messages it is given, not the ones it read before', () => {
    const before = [msg('1', 'c1', 'leo', 'waiting_input')]
    expect(waitingIn(before, 'c1').asked).toEqual(['leo'])
    expect(waitingIn([msg('1', 'c1', 'leo', 'done')], 'c1').asked).toEqual([])
    expect(waitingIn(before, 'c1').asked).toEqual(['leo'])
  })

  it('lists who asked and who asks for approval in a conversation, each once', () => {
    const messages = [msg('1', 'c1', 'leo', 'waiting_input'), msg('2', 'c1', 'bia', 'waiting_approval'), msg('3', 'c1', 'leo', 'waiting_input'), msg('4', 'c2', 'nina', 'waiting_input'), msg('5', 'c1', 'nina', 'working')]
    expect(waitingIn(messages, 'c1')).toEqual({ asked: ['leo'], approval: ['bia'] })
    expect(waitingIn(messages, 'c3')).toEqual({ asked: [], approval: [] })
  })
  it('counts threads too, and nothing that is done', () => {
    const inThread = { ...msg('1', 'c1', 'leo', 'waiting_input'), threadId: 'root' }
    expect(waitingIn([inThread, msg('2', 'c1', 'bia', 'done')], 'c1')).toEqual({ asked: ['leo'], approval: [] })
  })
})

describe('waitingIn with a team', () => {
  it('marks only what waits on me: a question in my inbox, an approval I can decide', () => {
    const toBia = msg('1', 'c1', 'leo', 'waiting_input')
    const toMe = msg('2', 'c1', 'nina', 'waiting_input')
    const approval = { ...msg('3', 'c1', 'bia', 'waiting_approval'), run: { status: 'waiting_approval' as const, steps: [], approvalId: 'ap1' } }
    const messages = [toBia, toMe, approval]
    const inbox: Inbox = { approvals: [], questions: [{ id: '2', agentId: 'nina', text: 'Qual?', askedTo: 'me', requestedBy: 'me', state: 'open', deadlineAt: 0, createdAt: 0 }] }
    expect(waitingIn(messages, 'c1', { key: inbox, test: mineIn(inbox) })).toEqual({ asked: ['nina'], approval: [] })
    const mine: Inbox = { ...inbox, approvals: [{ id: 'ap1' } as Approval] }
    expect(waitingIn(messages, 'c1', { key: mine, test: mineIn(mine) })).toEqual({ asked: ['nina'], approval: ['bia'] })
    expect(waitingIn(messages, 'c1')).toEqual({ asked: ['leo', 'nina'], approval: ['bia'] }) // alone: everything is mine
  })
})

describe('waitingTitle', () => {
  it('says who is waiting and for what', () => {
    expect(waitingTitle({ asked: ['leo'], approval: [] }, nameOf)).toBe('Leo te perguntou algo')
    expect(waitingTitle({ asked: ['leo', 'nina'], approval: [] }, nameOf)).toBe('Leo e Nina te perguntaram algo')
    expect(waitingTitle({ asked: [], approval: ['bia'] }, nameOf)).toBe('Bia pede aprovação')
    expect(waitingTitle({ asked: [], approval: ['bia', 'leo'] }, nameOf)).toBe('Bia e Leo pedem aprovação')
    expect(waitingTitle({ asked: ['leo'], approval: ['bia'] }, nameOf)).toBe('Leo te perguntou algo · Bia pede aprovação')
    expect(waitingTitle({ asked: [], approval: [] }, nameOf)).toBe('')
  })
})
