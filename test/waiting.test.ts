import { describe, expect, it } from 'vitest'
import { waitingIn, waitingTitle } from '../src/renderer/src/components/waiting'
import type { Message, RunStatus } from '../src/shared/types'

const msg = (id: string, conversationId: string, agentId: string, status: RunStatus): Message => ({ id, conversationId, author: { kind: 'agent', id: agentId }, text: '', at: 0, run: { status, steps: [] } })
const names: Record<string, string> = { leo: 'Leo', bia: 'Bia', nina: 'Nina' }
const nameOf = (id: string): string => names[id] ?? id

describe('waitingIn', () => {
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
