// The Asks page: every agent's open question to the person in one place, instead of only inside
// the reply that asked it.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Person, Question } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { AsksPage } = await import('../src/renderer/src/components/Pages')

const me: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const tucano: Agent = { ...lia, id: 'a2', name: 'Tucano', handle: 'tucano' }

type Asked = State['inbox']['questions'][number]
const q = (id: string, agentId: string, conversationId: string | undefined, text: string): Asked => ({
  id,
  ...(conversationId ? { conversationId } : {}),
  agentId,
  text,
  askedTo: 'ana',
  requestedBy: 'ana',
  state: 'open',
  deadlineAt: Date.now() + 3_600_000,
  createdAt: 1
}) as Asked

const page = (questions: Asked[]): string => {
  fake = {
    ...fake,
    inbox: { approvals: [], questions },
    conversations: [
      { id: 'dm1', kind: 'dm', name: 'Lia', members: ['a1'] },
      { id: 'ch1', kind: 'channel', name: 'vendas', members: ['a2'] }
    ]
  } as State
  return renderToStaticMarkup(<AsksPage />)
}

// The renderer reads `window` for the web build; these components don't need more than that.
beforeEach(() => {
  vi.stubGlobal('window', {})
  fake = { ...getState(), ready: true, people: [me], agents: [lia, tucano], you: 'ana', inbox: { approvals: [], questions: [] } }
})

describe('the Asks page', () => {
  it('is a rest screen when nothing is waiting', () => {
    const html = page([])
    expect(html).toContain('Nenhuma pergunta esperando')
  })

  it("gathers questions asked in different conversations, which is the point", () => {
    const html = page([q('q1', 'a1', 'dm1', 'Publico o post hoje?'), q('q2', 'a2', 'ch1', 'Fecho o mês assim?')])
    expect(html).toContain('Publico o post hoje?')
    expect(html).toContain('Fecho o mês assim?')
    expect(html).toContain('na sua DM com Lia')
    expect(html).toContain('em #vendas')
  })

  it('shows each open one as a card, not as already answered', () => {
    const html = page([q('q1', 'a1', 'dm1', 'Publico o post hoje?')])
    expect(html).toContain('class="question')
    expect(html).toContain('Pergunta pra você')
    expect(html).not.toContain('Respondida')
  })

  it('carries the decisions of a question that has them', () => {
    const html = page([{ ...q('q1', 'a1', 'dm1', 'Qual caminho?'), decisions: [{ question: 'Qual caminho?', kind: 'single', options: [{ label: 'Um' }, { label: 'Outro' }] }] }])
    expect(html).toContain('class="ask ask--answer')
    expect(html).toContain('Esperando você')
    expect(html).toContain('Um')
  })

  it('still lists one whose conversation is gone, without a link to it', () => {
    const html = page([q('q1', 'a1', undefined, 'Ainda quer isso?')])
    expect(html).toContain('Ainda quer isso?')
    expect(html).toContain('numa conversa que você não vê')
  })
})
