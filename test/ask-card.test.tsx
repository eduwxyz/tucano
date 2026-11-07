// The decisions card (ask_user) under an agent's reply: who gets to answer it, what it shows
// while waiting, and what it keeps once answered.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import type { Decision } from '../src/shared/questions'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { AskCard } = await import('../src/renderer/src/components/Decisions')
const { QuestionCard } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const carl: Person = { id: 'carl', name: 'Carl', role: 'member', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'ana' }
const decisions: Decision[] = [
  { question: 'Paginação no menu?', kind: 'single', options: [{ label: 'Busca remota' }, { label: 'Scroll infinito' }, { label: 'Paginar' }] },
  { question: 'Pra quando?', kind: 'text' }
]
const open = { id: 'q1', conversationId: 'ch', agentId: 'a1', text: '1. …', askedTo: 'bia', requestedBy: 'ana', state: 'open' as const, deadlineAt: Date.now() + 3_600_000, createdAt: 1 }
const card = (extra: Record<string, unknown> = {}): string => renderToStaticMarkup(<QuestionCard id="q1" agentName="Lia" askedTo="bia" question="1. …" decisions={decisions} answered={false} {...extra} />)

beforeEach(() => {
  fake = { ...getState(), ready: true, people: [ana, bia, carl], agents: [lia], you: 'bia', inbox: { approvals: [], questions: [] } }
})

describe('the decisions card', () => {
  it("shows the agent's options (3 at most) and always Something else after them, one decision at a time", () => {
    const html = renderToStaticMarkup(<AskCard id="m1" questions={decisions} mode="answer" badge="Esperando você" />)
    expect(html.match(/class="ask-option[ "]/g)).toHaveLength(4)
    expect(html).toContain('Outra coisa…')
    expect(html).toContain('1 de 2')
    expect(html).not.toContain('Pra quando?') // the next decision comes after this one
  })

  it('answered, keeps each decision with what was chosen', () => {
    const html = renderToStaticMarkup(<AskCard id="m1" questions={decisions} saved={[{ chosen: [1] }, { text: 'sexta' }]} mode="done" badge="Respondida por Bia" />)
    expect(html).toContain('Respondida por Bia')
    expect(html).toMatch(/Paginação no menu\?<\/dt><dd[^>]*>Scroll infinito</)
    expect(html).toMatch(/Pra quando\?<\/dt><dd[^>]*>sexta</)
  })

  it('with a team: Bia answers it there; Carl only reads it; an admin answers for her when choosing to', () => {
    fake = { ...fake, inbox: { approvals: [], questions: [open] } }
    expect(card()).toContain('ask--answer')
    fake = { ...fake, you: 'carl', inbox: { approvals: [], questions: [] } }
    expect(card()).toContain('ask--view')
    expect(card()).toContain('Esperando Bia')
    expect(card()).not.toContain('Responder no lugar de Bia')
    fake = { ...fake, you: 'ana' }
    expect(card()).toContain('ask--view')
    expect(card()).toContain('Responder no lugar de Bia')
  })

  it('with a team, answered, says by whom', () => {
    fake = { ...fake, you: 'ana' }
    const html = card({ answered: true, answeredBy: 'bia', answers: [{ chosen: [0] }, { skipped: true }] })
    expect(html).toContain('Respondida por Bia')
    expect(html).toContain('Busca remota')
  })

  it("in a DM, waiting on its person's yes: no one answers it yet", () => {
    fake = { ...fake, you: 'ana', inbox: { approvals: [], questions: [{ ...open, confirm: 'pending' }] } }
    const html = card()
    expect(html).toContain('Lia quer perguntar a Bia')
    expect(html).not.toContain('ask--answer')
  })
})
