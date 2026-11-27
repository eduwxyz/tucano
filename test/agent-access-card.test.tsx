// The card an agent's access request becomes names the computer right on the machine as the agent page
// does: this Mac, this computer (Windows, Linux) or the server, and warns only where it runs as the person.
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Message, Proposal } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { ProposalCard } = await import('../src/renderer/src/components/Tuca')

const dev: Agent = { id: 'a1', name: 'Dev', handle: 'dev', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const proposal: Proposal = { kind: 'agent', agentId: 'a1', changes: { computer: true, computerKind: 'mac' }, reason: 'Rodar os scripts' } as Proposal
const message: Message = { id: 'm1', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: '', at: 0, run: { status: 'done', steps: [], proposals: [proposal] } } as unknown as Message
const card = (): string => renderToStaticMarkup(<ProposalCard message={message} proposal={proposal} />)

beforeEach(() => {
  fake = { ...getState(), ready: true, agents: [dev], people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana' }
})
afterEach(() => vi.unstubAllGlobals())

describe('the card for a computer right on the machine', () => {
  it('on a Mac: this Mac, with the warning', () => {
    fake = { ...fake, platform: 'mac' }
    const html = card()
    expect(html).toContain('este Mac (roda como você)')
    expect(html).toContain('proposal__risk')
  })

  it('on Windows or Linux: this computer, never "Mac"', () => {
    fake = { ...fake, platform: 'windows' }
    const html = card()
    expect(html).toContain('este computador (roda como você)')
    expect(html).not.toMatch(/Mac/)
    expect(html).toContain('proposal__risk')
  })

  it('on a server: right on the server, with no warning about your files', () => {
    vi.stubGlobal('window', { __TUCANO_WEB__: true })
    fake = { ...fake, platform: 'linux' }
    const html = card()
    expect(html).toContain('direto no servidor')
    expect(html).not.toContain('proposal__risk')
  })
})
