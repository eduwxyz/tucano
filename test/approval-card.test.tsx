// The approval card (issue #252, direction A): it leads with the action and its target, keeps the
// status a quiet row, and tells "approved" apart from "completed" — the decision is stored the
// moment it's made and the call finishes later. Also the reminder over the field that counts the
// requests still waiting here.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Approval, Message, Person } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { ApprovalCard } = await import('../src/renderer/src/components/Conversation')
const { approvalsIn } = await import('../src/renderer/src/store')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, owner: 'ana' }

const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'ap1',
  hash: 'h',
  agentId: 'a1',
  conversationId: 'ch',
  messageId: 'm1',
  connectorId: 'tasks',
  connectorName: 'Tasks',
  tool: 'delete_task',
  args: { title: 'Demo task', id: 2 },
  why: 'This will delete the selected task.',
  highRisk: false,
  state: 'pending',
  createdAt: 1_000,
  expiresAt: Date.now() + 3_600_000,
  requestedBy: 'ana',
  ...extra
})

const card = (a: Approval = approval()): string => renderToStaticMarkup(<ApprovalCard approval={a} />)
// What the core would put in this person's inbox: everything pending here is theirs in these tests.
const inboxed = (s: State): State => ({ ...s, inbox: { ...s.inbox, approvals: s.approvals.filter((a) => a.state === 'pending') } })

beforeEach(() => {
  fake = { ...getState(), ready: true, people: [ana, bia], agents: [lia], you: 'ana' }
})

describe('the approval card', () => {
  it('names the page a browser click lands on, and a command in one sentence', () => {
    const click = card(approval({ connectorId: 'navegador', connectorName: 'Navegador', tool: 'navegador_clicar', args: { alvo: 'Pagar', url: 'https://loja.example/checkout' } }))
    expect(click).toContain('“Pagar” em loja.example/checkout')
    const command = card(approval({ connectorId: 'computador', connectorName: 'Computador', tool: 'bash', args: { command: 'git commit -m x && git push' } }))
    expect(command).toMatch(/approval__title[^>]*>Fazer commit e subir commits \(push\)/)
  })

  it('an old row, a grant or an app the agent still has to use never reads as waiting or completed', () => {
    const old = card(approval({ state: 'approved', outcome: 'Executou.', decidedBy: 'ana' }))
    expect(old).toContain('Aprovado')
    expect(old).not.toContain('esperando o resultado')
    expect(old).not.toContain('Concluído')
    // A row from before the field whose call failed: its outcome is all that says so.
    const oldFailed = card(approval({ state: 'approved', outcome: 'Rodou, com erro.', decidedBy: 'ana' }))
    expect(oldFailed).toContain('Falhou')
    expect(oldFailed).not.toContain('Concluído')
    const app = card(approval({ connectorId: 'apps', connectorName: 'Apps', tool: 'app_clicar', args: { app: 'Mail', alvo: 'Enviar' }, state: 'approved', outcome: 'Liberado: o agente faz agora.', decidedBy: 'ana' }))
    expect(app).not.toContain('Concluído')
  })

  it('leads with the action and its target, its status a quiet row above', () => {
    const html = card()
    expect(html).toMatch(/approval__title[^>]*>Delete task <strong>“Demo task”<\/strong>/)
    // The status row comes before the title, and the risk is on the other end of it.
    expect(html.indexOf('Esperando você')).toBeLessThan(html.indexOf('approval__title'))
    expect(html).toContain('Conector:')
    expect(html).toContain('Tasks')
    expect(html).toContain('Alvo:')
    expect(html).toContain('Demo task, ID 2')
    expect(html).toContain('This will delete the selected task.')
  })

  it('a high-risk call shows the exact details already open and asks for a hold, not a click', () => {
    const html = card(approval({ highRisk: true }))
    expect(html).toContain('alto risco')
    expect(html).toContain('btn--hold')
    expect(html).toContain('Segure pra aprovar')
    expect(html).not.toMatch(/>Aprovar</)
    // Open from the start: the arguments are on screen, not behind a click.
    expect(html).toContain('&quot;title&quot;: &quot;Demo task&quot;')
  })

  it('approved is not completed: it waits for the result, and then says what it was', () => {
    const waiting = card(approval({ state: 'approved', decidedBy: 'ana', decidedAt: 2_000 }))
    expect(waiting).toContain('Aprovado · esperando o resultado')
    expect(waiting).not.toContain('Concluído')
    const done = card(approval({ state: 'approved', result: 'done', outcome: 'Executou.', decidedBy: 'ana' }))
    expect(done).toContain('Concluído')
    // A call that ran and came back an error is a failure, not a quiet approval.
    const failed = card(approval({ state: 'approved', result: 'error', outcome: 'Rodou, com erro.', decidedBy: 'ana' }))
    expect(failed).toContain('Falhou')
    expect(failed).toContain('approval--error')
    expect(failed).toContain('Rodou, com erro.')
    // Nothing ran at all: still honest about it, and never called a completion.
    const skipped = card(approval({ state: 'approved', result: 'not_run', outcome: 'Não executou: o computador está desligado.', decidedBy: 'ana' }))
    expect(skipped).toContain('Aprovado · não rodou')
    expect(skipped).not.toContain('Concluído')
  })

  it('marks the long "always allow" label as the one the row may shorten', () => {
    // The row is one line (approval-row.test.ts): the three buttons never wrap, so the label that
    // can be long lives in its own span, told apart by the CSS that lets it read on two lines.
    const html = card()
    expect(html).toContain('approval__allow')
    expect(html).toMatch(/approval__allow-label">Aprovar e sempre permitir</)
    // One row, in order: Approve, the long one, Refuse.
    const order = ['approval__approve', 'approval__allow', 'approval__refuse-btn'].map((cls) => html.indexOf(cls))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('a bare command on a lent computer offers no "always allow": only a kind of action can be allowed for good', () => {
    const lent = (command: string): Approval => approval({ connectorId: 'node-mac', connectorName: 'Mac da Ana', tool: 'node_bash', args: { command } })
    expect(card(lent('ls -la'))).not.toContain('approval__allow')
    // A command with a kind keeps it, as on this computer: the kind turns to "does it alone".
    expect(card(lent('git push'))).toContain('approval__allow')
  })

  it('refused keeps who refused it and the reason', () => {
    const html = card(approval({ state: 'refused', decidedBy: 'ana', decidedAt: 2_000, reason: 'not now', outcome: 'Nada foi executado.' }))
    expect(html).toContain('Recusado')
    expect(html).toContain('Recusado por Eu') // this is me: the card says so rather than my name
    expect(html).toContain('“not now”')
    expect(html).not.toContain('approval__approve')
  })

  it('only the person who may decide gets the buttons', () => {
    fake = { ...fake, you: 'bia' }
    const html = card()
    expect(html).toContain('Esperando')
    expect(html).not.toContain('approval__approve')
    expect(html).not.toContain('approval__refuse-btn')
  })
})

describe('the reminder over the field', () => {
  const msg = (id: string, threadId?: string): Message => ({ id, conversationId: 'ch', author: { kind: 'agent', id: 'a1' }, text: '', at: 1, ...(threadId ? { threadId } : {}) })

  it('counts the pending approvals I decide here, oldest first, and only those', () => {
    const older = approval({ id: 'ap0', createdAt: 1, messageId: 'm0' })
    const newer = approval({ id: 'ap2', createdAt: 9, messageId: 'm2' })
    fake = {
      ...fake,
      approvals: [newer, approval({ createdAt: 5 }), older, approval({ id: 'ap3', state: 'approved' })],
      messages: { ch: [msg('m0'), msg('m1'), msg('m2')] }
    }
    expect(approvalsIn(inboxed(fake), 'ch').map((a) => a.id)).toEqual(['ap0', 'ap1', 'ap2'])
    // Another conversation's requests are not counted here.
    expect(approvalsIn(inboxed(fake), 'other')).toEqual([])
  })

  it('in a thread, only the approvals asked in that thread', () => {
    fake = {
      ...fake,
      approvals: [approval({ id: 'ap1', messageId: 'm1' }), approval({ id: 'ap2', messageId: 'm2' })],
      messages: { ch: [msg('m1'), msg('m2', 't1')] }
    }
    expect(approvalsIn(inboxed(fake), 'ch').map((a) => a.id)).toEqual(['ap1'])
    expect(approvalsIn(inboxed(fake), 'ch', 't1').map((a) => a.id)).toEqual(['ap2'])
  })

  it('what I cannot decide is not counted as mine to decide', () => {
    // The core leaves it out of the inbox: another person's agent, or a command on their lent computer.
    fake = { ...fake, you: 'bia', approvals: [approval()], messages: { ch: [msg('m1')] }, inbox: { approvals: [], questions: [] } }
    expect(approvalsIn(fake, 'ch')).toEqual([])
  })
})
