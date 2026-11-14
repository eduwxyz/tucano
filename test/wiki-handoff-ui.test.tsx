// A finding's card offers the agents that can actually write: the picker shows the agents with
// wiki write access, and a person whose team has none is told what to turn on instead of being
// offered a picker that would go nowhere.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { L } from '../src/shared/lang'
import type { Agent, WikiAccess, WikiFinding } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { HandOff } = await import('../src/renderer/src/components/Wiki')

const agent = (id: string, handle: string, wiki?: WikiAccess, kind?: 'tuca'): Agent => ({
  id,
  name: handle.replace(/^./, (c) => c.toUpperCase()),
  handle,
  role: '',
  color: 'sky',
  ...(kind ? { kind } : {}),
  ...(wiki ? { wiki } : {}),
  instructions: '',
  modelId: 'deepseek',
  effort: 'low',
  limit: 1_000_000,
  used: 0,
  grants: {},
  memory: 'auto',
  computer: false,
  archived: false,
  owner: 'ana'
})

const finding = (f: Partial<WikiFinding> & Pick<WikiFinding, 'kind'>): WikiFinding => ({ id: 'f1', at: 0, pages: ['Reforma do apto 302'], text: '', ...f })
const card = (f: WikiFinding): string => renderToStaticMarkup(<HandOff finding={f} />)

beforeEach(() => {
  fake = { ...getState(), ready: true, agents: [] }
})

describe("a finding's card", () => {
  it('offers only the agents that write on the wiki', () => {
    fake = { ...fake, agents: [agent('a1', 'herald', 'read_write'), agent('a2', 'steward', 'read'), agent('a3', 'wrench')] }
    const html = card(finding({ kind: 'broken', name: 'Construtora Alpha' }))
    expect(html).toContain('@herald')
    expect(html).not.toContain('@steward')
    expect(html).not.toContain('@wrench')
    expect(html).toContain(L('Escrever a página', 'Write the page'))
  })

  it('leaves the Tuca and archived agents out, even with write access', () => {
    fake = { ...fake, agents: [agent('t', 'tuca', 'read_write', 'tuca'), { ...agent('a2', 'steward', 'read_write'), archived: true }] }
    expect(card(finding({ kind: 'broken', name: 'Alpha' }))).toContain(L('Nenhum agente escreve na wiki ainda', 'No agent writes on the wiki yet'))
  })

  it('asks for the links, not a page, when nothing links to it', () => {
    fake = { ...fake, agents: [agent('a1', 'herald', 'read_write')] }
    const html = card(finding({ kind: 'orphan', pages: ['Scratch files', 'OpenLibExtended'] }))
    expect(html).toContain(L('Ligar as páginas', 'Link the pages'))
    expect(html).not.toContain(L('Escrever a página', 'Write the page'))
  })

  it('says what to turn on when nobody in the team writes', () => {
    fake = { ...fake, agents: [agent('a2', 'steward', 'read')] }
    const html = card(finding({ kind: 'broken', name: 'Alpha' }))
    expect(html).toContain(L('Lê e escreve', 'Read and write'))
    expect(html).not.toContain(L('Escrever a página', 'Write the page'))
  })
})
