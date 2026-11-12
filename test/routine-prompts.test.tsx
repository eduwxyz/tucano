// How the request a routine posts before running shows (personal setting `routinePrompts`): whole as
// always, folded to one line, or left out with the reply saying "via <routine>".
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, Message, Person, Routine, RoutinePromptsMode, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { setLang } from '../src/shared/lang'
import { settingsPatchError } from '../src/core/settings-patch'
import { hideRoutinePrompts } from '../src/renderer/src/routine-prompts'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { CSS: { escape: (v: string) => v, supports: () => false } })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
const navigate = vi.fn()
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    setTab: vi.fn(),
    navigate: (v: unknown) => navigate(v),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const real = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { ConversationView } = await import('../src/renderer/src/components/Conversation')

const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisadora', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const dm: Conversation = { id: 'd1', kind: 'dm', name: 'a1', members: ['a1'] }
const routine: Routine = { id: 'r1', name: 'Morning digest', agentId: 'a1', conversationId: 'd1', prompt: 'Summarise the news', schedule: { kind: 'daily', time: '09:00' }, enabled: true, createdAt: 0 } as unknown as Routine
const PROMPT = 'Summarise the news and list three links'

const ask = (p: Partial<Message> = {}): Message => ({ id: 'ask', conversationId: 'd1', author: { kind: 'routine', id: 'r1' }, text: PROMPT, at: 1_000, routine: { name: 'Morning digest', scheduledAt: 1_000, late: false }, ...p })
const answer = (p: Partial<Message> = {}): Message => ({ id: 'ans', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'Here is the digest.', at: 2_000, run: { status: 'done', steps: [] }, ...p })
const threadReply = (): Message => ({ id: 'tr', conversationId: 'd1', author: { kind: 'agent', id: 'a1' }, text: 'In the thread.', at: 3_000, threadId: 'ask', run: { status: 'done', steps: [] } })

let root: Root | undefined
beforeEach(() => {
  setLang('en')
  navigate.mockClear()
  document.getElementById('root')!.innerHTML = ''
  root = undefined
  fake = { ...real.getState(), ready: true, people: [ana], you: 'ana', agents: [lia], conversations: [dm], routines: [routine], messages: {}, inbox: { approvals: [], questions: [] }, settings: { ...real.getState().settings } as Settings } as State
})
const show = async (mode: RoutinePromptsMode | undefined, messages: Message[], routines: Routine[] = [routine]): Promise<void> => {
  fake = { ...fake, routines, messages: { d1: messages }, settings: { ...fake.settings, routinePrompts: mode } }
  if (root) await act(async () => root!.unmount())
  const host = document.createElement('div')
  document.getElementById('root')!.append(host)
  root = createRoot(host)
  const mounted = root
  await act(async () => mounted.render((<ConversationView id="d1" />) as ReactNode))
}
const toggle = (): HTMLElement => document.querySelector<HTMLElement>('.routine-prompt-toggle')!
const via = (): Element | null => document.querySelector('.routine-via')

describe('full', () => {
  for (const mode of [undefined, 'full'] as const) {
    it(`shows the prompt whole when the setting is ${mode ?? 'unset'}`, async () => {
      await show(mode, [ask(), answer()])
      const article = document.querySelector('.msg--routine')!
      expect(article.textContent).toContain(PROMPT)
      expect(article.classList.contains('msg--routine-compact')).toBe(false)
      expect(document.querySelector('.md--one-line')).toBeNull()
      expect(toggle()).toBeNull()
      expect(via()).toBeNull()
    })
  }
})

describe('compact', () => {
  it('keeps the whole prompt in the page but clamps it to one line, with a toggle that opens and folds it', async () => {
    await show('compact', [ask(), answer()])
    const article = document.querySelector('.msg--routine')!
    expect(article.getAttribute('data-id')).toBe('ask')
    expect(article.textContent).toContain('Morning digest')
    expect(article.textContent).toContain('routine')
    expect(article.textContent).toContain(PROMPT)
    const prompt = article.querySelector('.md')!
    expect(prompt.classList.contains('md--one-line')).toBe(true)
    expect(toggle().tagName).toBe('BUTTON')
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(toggle().getAttribute('aria-controls')).toBe(prompt.id)
    expect(toggle().getAttribute('aria-label')).toBe('Show prompt')

    await act(async () => toggle().click())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().getAttribute('aria-label')).toBe('Hide prompt')
    expect(article.querySelector('.md')!.classList.contains('md--one-line')).toBe(false)

    await act(async () => toggle().click())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(article.querySelector('.md')!.classList.contains('md--one-line')).toBe(true)
  })

  it('shows the late tag, and keeps the trigger note outside what folds', async () => {
    await show('compact', [ask({ routine: { name: 'Morning digest', scheduledAt: 500, late: true, event: { source: 'GitHub', title: 'Issue opened' } } }), answer()])
    const article = document.querySelector('.msg--routine')!
    expect(article.querySelector('.tag--warn')?.textContent).toContain('late')
    const note = article.querySelector('.routine-event')!
    expect(note.textContent).toContain('GitHub')
    expect(note.textContent).toContain('Issue opened')
    expect(note.closest('.md--one-line')).toBeNull()
  })

  it('keeps the thread link visible while folded', async () => {
    await show('compact', [ask(), answer(), threadReply()])
    expect(document.querySelector('.msg--routine .thread-link')).not.toBeNull()
    expect(document.querySelector('.md--one-line')).not.toBeNull()
  })

  it('opens already unfolded when the view is focused on the routine message', async () => {
    const scrolled = vi.fn()
    Object.assign(window.HTMLElement.prototype, { scrollIntoView: scrolled })
    fake = { ...fake, view: { kind: 'conversation', id: 'd1', message: 'ask' } as State['view'] }
    await show('compact', [ask(), answer()])
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(scrolled).toHaveBeenCalled()
  })
})

describe('hidden', () => {
  it('sends a focus on a hidden request to the reply that stands in for it', async () => {
    const scrolled = vi.fn()
    Object.assign(window.HTMLElement.prototype, { scrollIntoView: scrolled })
    fake = { ...fake, view: { kind: 'conversation', id: 'd1', message: 'ask' } as State['view'] }
    await show('hidden', [ask(), answer()])
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(scrolled.mock.contexts[0]).toBe(document.querySelector('[data-id="ans"]'))
  })

  it('leaves the routine message out and tags the reply with the routine', async () => {
    await show('hidden', [ask(), answer()])
    expect(document.querySelector('.msg--routine')).toBeNull()
    expect(document.body.textContent).not.toContain(PROMPT)
    expect(document.body.textContent).toContain('Here is the digest.')
    expect(via()?.textContent).toContain('via Morning digest')
    expect(via()?.querySelector('svg')).toBeNull()
  })

  it('adds the lightning bolt when an event started the run', async () => {
    await show('hidden', [ask({ routine: { name: 'Morning digest', scheduledAt: 1_000, late: false, event: { source: 'GitHub', title: 'Issue opened' } } }), answer()])
    expect(via()?.querySelector('svg')).not.toBeNull()
    expect(via()?.getAttribute('title')).toBe('GitHub: Issue opened')
  })

  it('opens the routines screen from the tag while the routine exists', async () => {
    await show('hidden', [ask(), answer()])
    expect(via()?.tagName).toBe('BUTTON')
    await act(async () => (via() as HTMLElement).click())
    expect(navigate).toHaveBeenCalledWith({ kind: 'routines' })
  })

  it('is plain text once the routine was deleted', async () => {
    await show('hidden', [ask(), answer()], [])
    expect(via()?.tagName).toBe('SPAN')
    expect(via()?.textContent).toContain('via Morning digest')
  })

  it('falls back to compact for a request that opens a thread, so the thread keeps its root', async () => {
    await show('hidden', [ask(), answer(), threadReply()])
    const article = document.querySelector('.msg--routine')!
    expect(article.classList.contains('msg--routine-compact')).toBe(true)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })
})

describe('which reply belongs to a hidden request', () => {
  const personAsk: Message = { id: 'p1', conversationId: 'd1', author: { kind: 'person', id: 'ana' }, text: 'hi', at: 1_500 }
  const toPerson = answer({ id: 'to-person', at: 1_600, run: { status: 'done', steps: [], replyTo: 'p1' } })

  it('skips a reply that answers a person and a reply in a thread', () => {
    const { via: found, repliesOf } = hideRoutinePrompts([ask(), personAsk, toPerson, answer()])
    expect([...found.keys()]).toEqual(['ans'])
    expect(repliesOf.get('ask')).toBe('ans')
  })

  it('stops at the next routine request, so a run with no reply yet claims nobody else’s', () => {
    const next = ask({ id: 'ask2', at: 5_000 })
    const { via: found } = hideRoutinePrompts([ask(), next, answer({ id: 'later', at: 6_000 })])
    expect([...found.keys()]).toEqual(['later'])
    expect(found.get('later')?.routineId).toBe('r1')
  })
})

describe('the setting', () => {
  it('takes the three modes, or none, and nothing else', () => {
    for (const v of ['full', 'compact', 'hidden', null]) expect(settingsPatchError({ routinePrompts: v })).toBeUndefined()
    for (const v of ['tiny', true, 1, '']) expect(settingsPatchError({ routinePrompts: v })).toBe('Invalid value for routinePrompts.')
  })
})
