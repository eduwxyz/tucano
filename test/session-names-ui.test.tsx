// Where a session's name shows: a chip in a reply's head, a bold label before the prompt in the work
// drawer, and its own card in Settings › Models, after Memory. These are the rendered surfaces; the
// naming itself is covered in test/session-name.test.ts.
import { parseHTML } from 'linkedom'
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import { fileURLToPath } from 'node:url'
import { setLang } from '../src/shared/lang'
import type { Agent, Message, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'
import { searchSettings, settingsStructure, settingsTabStructure } from '../src/renderer/src/settings-structure'
import { inspectSettingsPlacement } from '../scripts/lib/settings-placement.mjs'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
Object.assign(document, { oninput: null })
Object.assign(window, { innerWidth: 1280, innerHeight: 800, tucano: {} })
Object.assign(globalThis, {
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} }
})

let fake: State
let live: string | undefined
const updates: Record<string, unknown>[] = []
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    updateSettings: (patch: Record<string, unknown>) => { updates.push(patch); fake.settings = { ...fake.settings, ...patch } as Settings },
    getState: () => fake,
    useLiveText: (m: Message) => live ?? m.text,
    useLiveThoughtState: () => undefined,
    stopRun: () => {},
    startQueued: () => {},
    reorderQueued: () => {},
    dropQueued: () => {},
    sendMessage: () => {},
    loadThread: async () => {}
  }
})

const realStore = await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { MessageList } = await import('../src/renderer/src/components/Conversation')
const { WorkDrawer } = await import('../src/renderer/src/components/WorkDrawer')
vi.mock('../src/renderer/src/components/Harness', () => ({
  ModelPicker: ({ value, effort }: { value: string; effort?: string }) => <div className="model-picker" data-model={value} data-effort={effort ?? ''} />,
  usableEngines: () => ['claude']
}))
const { SessionNamesFields } = await import('../src/renderer/src/components/Pages')

const ana = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const lia = (): Agent => ({ id: 'a1', name: 'Lia', handle: 'lia', role: 'Engineering', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 0, used: 0, grants: {}, memory: 'auto', computer: false, archived: false })
const channel = { id: 'c1', kind: 'channel' as const, name: 'engineering', members: ['a1'] }
const asked = 'Nomes das sessões no Tucano, ao lado do nome do agente e no cabeçalho da thread, com o nome em negrito antes do pedido'
const requestMessage: Message = { id: 'm1', conversationId: 'c1', author: { kind: 'person', id: 'ana' }, text: asked, at: 1 }
const named = (name: string): Message => ({ id: 'r1', conversationId: 'c1', author: { kind: 'agent', id: 'a1' }, text: '', at: 2, run: { status: 'working', steps: [], replyTo: 'm1', sessionName: name } })

let root: Root
beforeEach(() => {
  live = undefined
  setLang('en')
  fake = {
    ...realStore.getState(),
    ready: true,
    you: 'ana',
    people: [ana],
    agents: [lia()],
    conversations: [channel],
    messages: { c1: [] },
    settings: { ...realStore.getState().settings, showThinking: true, proceedButton: true } as Settings
  } as State
  document.getElementById('root')!.innerHTML = ''
  root = createRoot(document.getElementById('root')!)
})
afterEach(() => { act(() => root.unmount()) })

const draw = async (node: ReactNode): Promise<void> => {
  await act(async () => void root.render(node))
}
const openDrawer = async (): Promise<void> => {
  if (!document.querySelector('.work-drawer__list')) await act(async () => void (document.querySelector('.work-drawer__head') as HTMLElement).click())
}

describe('session name in the reply head', () => {
  it('is a chip beside the agent name, before the time, and not text tacked onto the name', async () => {
    fake.messages = { c1: [named('Session names chip')] }
    await draw(<MessageList messages={[named('Session names chip')]} conversationId="c1" />)
    const head = document.querySelector('.msg__head')!
    const order = [...head.children].map((c) => c.className.split(' ')[0])
    expect(order.indexOf('msg__author')).toBeLessThan(order.indexOf('session-tag'))
    expect(order.indexOf('session-tag')).toBeLessThan(order.indexOf('msg__time'))
    expect(head.querySelector('.session-tag .session-tag__name')?.textContent).toBe('Session names chip')
    expect(head.querySelector('.msg__author')?.textContent).toBe('Lia')
    expect(head.textContent).not.toContain('· Session names chip')
  })

  it('leaves the head unchanged when the reply has no name yet', async () => {
    const unnamed = { ...named(''), run: { ...named('').run!, sessionName: undefined } }
    fake.messages = { c1: [unnamed] }
    await draw(<MessageList messages={[unnamed]} conversationId="c1" />)
    expect(document.querySelector('.session-tag')).toBeNull()
  })
})

describe('session name in the work drawer', () => {
  it('is the first element of a working row, in bold before the normalized, one-line prompt', async () => {
    fake.messages = { c1: [requestMessage, named('Session names chip')] }
    await draw(<WorkDrawer conversationId="c1" />)
    await openDrawer()
    const go = document.querySelector('.work-row__go')!
    const parts = [...go.children].map((c) => c.className.split(' ')[0])
    expect(parts[0]).toBe('work-row__name')
    expect(parts.indexOf('work-row__name')).toBeLessThan(parts.indexOf('work-row__text'))
    expect(go.querySelector('.work-row__name')?.textContent).toBe('Session names chip')
    // asked(m) keeps its 90-character cut with an ellipsis and folds the request into one line.
    const prompt = go.querySelector('.work-row__text')?.textContent ?? ''
    expect(prompt.endsWith('…')).toBe(true)
    expect(prompt).toBe(`${asked.replace(/\s+/g, ' ').trim().slice(0, 90)}…`)
    expect(prompt).not.toContain('\n')
  })

  it('shows no name label on a reply that was never named', async () => {
    const unnamed: Message = { ...named(''), run: { ...named('').run!, sessionName: undefined } }
    fake.messages = { c1: [requestMessage, unnamed] }
    await draw(<WorkDrawer conversationId="c1" />)
    await openDrawer()
    expect(document.querySelector('.work-row__name')).toBeNull()
    expect(document.querySelector('.work-row__text')?.textContent).toContain('Nomes das sessões')
  })
})

describe('the settings card', () => {
  it('owns sessionNameModel, follows Memory in the Models group, and has a rendered anchor', () => {
    const rootDir = fileURLToPath(new URL('..', import.meta.url))
    const report = inspectSettingsPlacement(rootDir)
    expect(report.failures).toEqual([])
    expect(report.passed).toBe(true)
    const sections = settingsStructure({ admin: true, owner: true, team: true, servers: true })
    const models = settingsTabStructure('modelos', sections).map((s) => s.id)
    expect(models.indexOf('models-session-names')).toBe(models.indexOf('knowledge-memory') + 1)
    expect(sections.find((s) => s.id === 'models-session-names')?.page).toBe('modelos')
    expect(sections.find((s) => s.id === 'models-session-names')?.keys).toEqual(['sessionNameEnabled', 'sessionNameModel', 'sessionNameEffort'])
    expect(searchSettings(sections, 'Session names').map((hit) => hit.section.id)).toContain('models-session-names')
    expect(searchSettings(sections, 'Session Names model').map((hit) => hit.section.id)).toContain('models-session-names')
    expect(searchSettings(sections, 'Thinking level').map((hit) => hit.section.id)).toContain('models-session-names')
  })
})

describe('the Session Names switch', () => {
  const sw = (): HTMLElement => document.querySelector('button.toggle[role="switch"]') as HTMLElement
  const picker = (): HTMLElement | null => document.querySelector('.model-picker') as HTMLElement | null
  const defaults = () => {
    fake.settings = { ...fake.settings, sessionNameEnabled: undefined, sessionNameModel: undefined, sessionNameEffort: undefined, memoryModel: 'haiku' } as Settings
    updates.length = 0
  }

  it('is off by default and shows no trio', async () => {
    defaults()
    await draw(<SessionNamesFields />)
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(sw().getAttribute('aria-label')).toBe('Session Names')
    expect(picker()).toBeNull()
    expect(document.body.textContent).not.toContain('Session Names model')
  })

  it('shows the trio with the memory model and level once turned on', async () => {
    defaults()
    await draw(<SessionNamesFields />)
    await act(async () => sw().click())
    await draw(<SessionNamesFields />)
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(updates).toContainEqual({ sessionNameEnabled: true })
    expect(picker()?.getAttribute('data-model')).toBe('haiku')
    expect(document.querySelector('[aria-label="Reasoning effort"]')?.textContent).toContain('Low')
    expect(document.body.textContent).toContain('Session Names model')
  })

  it('keeps the chosen trio when switched off and back on', async () => {
    defaults()
    fake.settings = { ...fake.settings, sessionNameEnabled: true, sessionNameModel: 'sonnet', sessionNameEffort: 'xhigh' } as Settings
    await draw(<SessionNamesFields />)
    expect(picker()?.getAttribute('data-model')).toBe('sonnet')
    expect(document.querySelector('[aria-label="Reasoning effort"]')?.textContent).toContain('Max')
    await act(async () => sw().click())
    await draw(<SessionNamesFields />)
    expect(sw().getAttribute('aria-checked')).toBe('false')
    expect(picker()).toBeNull()
    expect(fake.settings.sessionNameModel).toBe('sonnet')
    expect(fake.settings.sessionNameEffort).toBe('xhigh')
    await act(async () => sw().click())
    await draw(<SessionNamesFields />)
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(picker()?.getAttribute('data-model')).toBe('sonnet')
    expect(document.querySelector('[aria-label="Reasoning effort"]')?.textContent).toContain('Max')
  })
})
