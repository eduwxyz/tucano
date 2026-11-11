// The Asks history: one row per finished ask, in the same table the approvals keep, with the text
// clipped to a line until the row is opened, then rendered as a bullet per question and per option.
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Person } from '../src/shared/types'
import type { AskEntry } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return { ...real, useStore: <T,>(select: (s: State) => T): T => select(fake) }
})
const { getState } = await import('../src/renderer/src/store')
const { AskedRow } = await import('../src/renderer/src/components/Pages')
const { parseQuestionsText } = await import('../src/shared/questions')

const me: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }

const asked = (over: Partial<AskEntry> = {}): AskEntry =>
  ({
    id: 'q1',
    agentId: 'a1',
    text: '1. Publico o post hoje? (Sim, publico | Não, espero)',
    askedTo: 'ana',
    requestedBy: 'ana',
    state: 'answered',
    deadlineAt: 0,
    answeredBy: 'ana',
    answeredAt: 1794422327652,
    createdAt: 1794422099188,
    ...over
  }) as AskEntry

const row = (open: boolean, q: AskEntry = asked()): string =>
  renderToStaticMarkup(<AskedRow q={q} place="na sua DM com Lia" open={open} onToggle={() => {}} />)

beforeEach(() => {
  vi.stubGlobal('window', {})
  fake = { ...getState(), ready: true, people: [me], agents: [lia], you: 'ana', inbox: { approvals: [], questions: [] } } as State
})

describe('the text an ask was stored as', () => {
  it('reads numbered lines with piped options back into a question and its options', () => {
    const [q] = parseQuestionsText('1. Re-render the three pages? (Yes, re-render those three | Leave them)')
    expect(q!.question).toBe('Re-render the three pages?')
    expect(q!.options?.map((o) => o.label)).toEqual(['Yes, re-render those three', 'Leave them'])
  })

  it('keeps every question of a multi-line ask, in order', () => {
    const qs = parseQuestionsText(
      '1. Keep page 6 as it is? (Keep | Split: page 6 figures only, page 7 objects)\n2. Try the axe again? (Axe-first frame | Leave it, it reads fine)'
    )
    expect(qs.map((q) => q.question)).toEqual(['Keep page 6 as it is?', 'Try the axe again?'])
    expect(qs[1]!.options?.map((o) => o.label)).toEqual(['Axe-first frame', 'Leave it, it reads fine'])
  })

  it('leaves a plain question as one free-text decision, brackets and all', () => {
    const [q] = parseQuestionsText('Publico o post hoje (com a foto)?')
    expect(q!.question).toBe('Publico o post hoje (com a foto)?')
    expect(q!.options).toBeUndefined()
  })
})

describe('a row of the asks history', () => {
  it('is a table row with the ask on one line while it is closed', () => {
    const html = row(false)
    expect(html).toContain('class="table__row table__row--btn ask-row__head"')
    // One line, options nowhere: they are what opening reveals.
    expect(html).toContain('Publico o post hoje?')
    expect(html).not.toContain('<ul>')
    expect(html).not.toContain('Sim, publico')
    expect(html).toContain('aria-expanded="false"')
    // The date keeps its own line: wrapped, it made the row three lines tall (styles.css ask-row__when).
    expect(html).toContain('muted small ask-row__when')
  })

  it('opens into a bullet per question and a bullet per option under it', () => {
    const html = row(true)
    expect(html).toContain('aria-expanded="true"')
    // Two lists: the questions, and the options nested under their question.
    expect(html.match(/<ul>/g)?.length).toBe(2)
    const question = html.indexOf('Publico o post hoje?')
    const firstOption = html.indexOf('Sim, publico')
    expect(question).toBeGreaterThan(-1)
    expect(html.indexOf('<ul', question)).toBeGreaterThan(question) // the options hang off the question
    expect(firstOption).toBeGreaterThan(html.indexOf('<li', question))
    expect(html).toContain('na sua DM com Lia')
  })

  it('says how it ended: by you, by someone else, or with no answer at all', () => {
    expect(row(false)).toContain('por você')
    expect(row(false, asked({ answeredBy: undefined, state: 'closed' }))).toContain('sem resposta')
  })
})
