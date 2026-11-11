// Tucano Team v1, what a person reads on the screens: an agent's page a member only looks at has
// no hints or buttons for changing it, the activity log names tools as the approval card does,
// and a group of buttons under a field's name is not one big label.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Connector, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

// The screens read the store through useStore; here it reads a state made for each test.
let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { AgentPage, Field } = await import('../src/renderer/src/components/Pages')
const { activityText } = await import('../src/renderer/src/components/People')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: { c: 'read' }, memory: 'auto', computer: false, archived: false, owner: 'ana' }
const gitlab: Connector = { id: 'c', name: 'GitLab', kind: 'remote', url: 'https://x', args: [], envKeys: [], auth: 'oauth', tools: [], status: 'needs_auth' }

beforeEach(() => {
  fake = { ...getState(), ready: true, people: [ana, bia], you: 'ana', agents: [lia], connectors: [gitlab], tabs: {} }
})
afterEach(() => vi.clearAllMocks())

const page = (tab: string, you: string): string => {
  fake = { ...fake, you, tabs: { agent: tab } }
  return renderToStaticMarkup(<AgentPage id="a1" />)
}

describe("an agent's page a member only looks at", () => {
  it('shows the character recommendation for a long existing prompt without restricting the textarea', () => {
    fake = { ...fake, agents: [{ ...lia, instructions: `${'x'.repeat(32_000)} END` }] }
    const html = page('perfil', 'ana')
    expect(html).toContain('Prompt longo')
    expect(html).toContain('32.004')
    expect(html).not.toMatch(/<textarea[^>]*maxlength=/i)
  })

  it('has no "takes effect right away" and no "authorize in the browser"', () => {
    for (const tab of ['ferramentas', 'memoria']) expect(page(tab, 'ana')).toContain('Muda na hora, sem precisar salvar.')
    expect(page('ferramentas', 'ana')).toContain('Autorizar no navegador')
    for (const tab of ['ferramentas', 'memoria']) expect(page(tab, 'bia')).not.toContain('Muda na hora')
    const tools = page('ferramentas', 'bia')
    expect(tools).not.toContain('Autorizar no navegador')
    expect(tools).toContain('Precisa autorizar') // what it is, still
  })
})

describe('the activity log', () => {
  it('names a tool in words, as the approval card does', () => {
    const at = 1
    const text = activityText({ id: 'x', at, personId: 'ana', kind: 'approval.decided', detail: { decision: 'approved', agentId: 'a1', connector: 'GitLab', tool: 'create_merge_request' } }, fake, new Map())
    expect(text).toBe('aprovou Lia usar create merge request no GitLab')
    expect(activityText({ id: 'y', at, personId: 'ana', kind: 'approval.always', detail: { connector: 'GitLab', tool: 'mcp__gitlab__createMergeRequest' } }, fake, new Map())).toBe('deixou usar create merge request no GitLab sem pedir')
  })
})

describe('a field of buttons', () => {
  it("is a named group, not a label around them: each button keeps its own name", () => {
    const html = renderToStaticMarkup(
      <Field group label="De quem é" hint="Sua: roda em seu nome.">
        <button type="button">Só pra mim</button>
        <button type="button">Do canal</button>
      </Field>
    )
    expect(html).not.toContain('<label')
    expect(html).toMatch(/role="group"/)
    const labelled = /aria-labelledby="([^"]+)"/.exec(html)?.[1]
    expect(html).toContain(`id="${labelled}">De quem é<`)
    expect(html).toMatch(/aria-describedby="[^"]+"/)
  })
})

describe('a question answered by someone else while I typed (round 2, 11)', () => {
  it('keeps what I typed and says who answered, in Pra você and in the channel', async () => {
    const { QuestionCard, questionDrafts } = await import('../src/renderer/src/components/Conversation')
    const { InboxPage } = await import('../src/renderer/src/components/Pages')
    const carla: Person = { id: 'carla', name: 'Carla', role: 'admin', about: '' }
    fake = { ...fake, people: [ana, bia, carla], you: 'bia', inbox: { approvals: [], questions: [], answered: [{ id: 'q1', conversationId: 'ch', agentId: 'a1', text: 'Qual o orçamento?', askedTo: 'bia', requestedBy: 'ana', state: 'answered', answeredBy: 'carla', deadlineAt: 0, createdAt: 1 }] } }
    questionDrafts.set('q1', 'uns 40 mil')
    const inbox = renderToStaticMarkup(<InboxPage />)
    expect(inbox).toContain('Qual o orçamento?')
    expect(inbox).toContain('value="uns 40 mil"')
    expect(inbox).toContain('Respondida por Carla')
    // Nothing typed: it just leaves the list.
    questionDrafts.delete('q1')
    expect(renderToStaticMarkup(<InboxPage />)).not.toContain('Qual o orçamento?')
    // In the channel: the card names who answered.
    questionDrafts.set('q2', 'minha resposta')
    const card = renderToStaticMarkup(<QuestionCard id="q2" agentName="Lia" askedTo="bia" question="E o prazo?" answered answeredBy="carla" />)
    expect(card).toContain('Respondida por Carla')
    expect(card).toContain('value="minha resposta"')
    expect(card).not.toContain('Essa pergunta já foi respondida.')
  })
})

describe('the words and the layout a person reads (round 2, 13)', () => {
  it('the activity log says in words what happened to a wiki source, a channel, a DM, a summary', () => {
    const at = 1
    expect(activityText({ id: '1', at, personId: 'ana', kind: 'wiki.source_removed', detail: { title: 'Ata de março' } }, fake, new Map())).toBe('apagou a fonte “Ata de março” da wiki')
    expect(activityText({ id: '2', at, personId: 'ana', kind: 'wiki.source_removed', detail: { private: true } }, fake, new Map())).toBe('apagou uma fonte da wiki que veio de uma conversa privada')
    expect(activityText({ id: '2b', at, personId: 'ana', kind: 'wiki.source_removed' }, fake, new Map())).toBe('apagou uma fonte da wiki')
    expect(activityText({ id: '3', at, personId: 'ana', kind: 'channel.deleted', detail: { name: 'vendas' } }, fake, new Map())).toBe('excluiu o canal #vendas')
    expect(activityText({ id: '4', at, personId: 'ana', kind: 'dm.deleted' }, fake, new Map())).toBe('apagou uma conversa privada')
    expect(activityText({ id: '5', at, personId: 'ana', kind: 'channel.summary_edited', target: 'ch' }, fake, new Map())).toBe('editou o resumo de um canal')
  })

  it("an admin isn't offered to revoke the owner's admin invite; the owner is", async () => {
    const { canRevoke } = await import('../src/renderer/src/components/People')
    const carla: Person = { id: 'carla', name: 'Carla', role: 'admin', about: '' }
    expect(canRevoke({ role: 'admin' }, carla)).toBe(false)
    expect(canRevoke({ role: 'member' }, carla)).toBe(true)
    expect(canRevoke({ role: 'admin' }, ana)).toBe(true)
  })

  it('a long tool name in Pra você history wraps inside its own column', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')
    expect(css).toMatch(/\.history-row__what \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/)
    expect(css).toMatch(/\.history-row > :not\(\.history-row__what\):not\(\.history-row__outcome\) \{[^}]*flex-shrink: 0;/)
    const { HistoryRow } = await import('../src/renderer/src/components/Pages')
    fake = { ...fake, approvals: [{ id: 'ap', hash: 'h', agentId: 'a1', conversationId: 'ch', messageId: 'm', connectorName: 'GitLab', tool: 'mcp__gitlab__create_merge_request_with_a_really_long_name', args: {}, why: '', highRisk: false, state: 'approved', createdAt: 1, expiresAt: 2, decidedAt: 3 } as never] }
    const html = renderToStaticMarkup(<HistoryRow id="ap" />)
    expect(html).toContain('class="table__row history-row"')
    expect(html).toContain('class="history-row__what"')
  })

  it('both history tables reserve one width for the state pill and one for the date', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'styles.css'), 'utf8')
    // One pair of widths for both tables, centred inside the cell: without them each row's label
    // width moved the column by a few pixels and the dates never lined up.
    expect(css).toMatch(/\.history-row,\s*\.ask-row__head \{[^}]*--history-state: 96px;[^}]*--history-when: 104px;/)
    expect(css).toMatch(/\.history-row__state,\s*\.ask-row__state \{[^}]*flex: 0 0 var\(--history-state\);[^}]*justify-content: center;/)
    expect(css).toMatch(/\.history-row__when,\s*\.ask-row__when \{[^}]*flex: 0 0 var\(--history-when\);[^}]*text-align: center;/)
    // The outcome cell keeps its place on a row that reported nothing, so the columns still line up.
    fake = { ...fake, approvals: [{ id: 'ap', hash: 'h', agentId: 'a1', conversationId: 'ch', messageId: 'm', connectorName: 'GitLab', tool: 'write', args: {}, why: '', highRisk: false, state: 'approved', createdAt: 1, expiresAt: 2, decidedAt: 3 } as never] }
    const { HistoryRow } = await import('../src/renderer/src/components/Pages')
    const html = renderToStaticMarkup(<HistoryRow id="ap" />)
    expect(html).toContain('history-row__outcome')
    expect(html).toContain('history-row__state')
    expect(html).toContain('history-row__when')
  })

  it("a removed person's browser reads that they no longer have access, and nothing about the Tucano", async () => {
    const { NO_ACCESS_PAGE } = await import('../src/server/people')
    expect(NO_ACCESS_PAGE).toContain('Você não tem mais acesso a este Tucano.')
    expect(NO_ACCESS_PAGE).not.toMatch(/server\.js|link/)
  })
})
