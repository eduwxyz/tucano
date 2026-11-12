// The Tuca on screen: his builder screen opens the person's conversation where it was ("Nova
// conversa" starts another, asking first when cards there weren't applied); and a reply with several
// proposals shows them as one group: "1 de 5", each card on its own, "Aplicar todos" with what it
// will do, in order, and what didn't work. The core is a stand-in: what's sent to it is what's checked.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation, EngineId, EngineStatus, Message, Proposal, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: true }) })
Object.assign(window, { tucano: {} })
Object.assign(globalThis, { ResizeObserver: class { observe(): void {} unobserve(): void {} disconnect(): void {} } })
Object.assign(document, { oninput: null })

vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    ensureTuca: vi.fn(async (_model?: string, fresh?: boolean) => ({ agentId: 'tuca', conversationId: fresh ? 't2' : 't1' })),
    applyProposal: vi.fn(async () => ({ id: 'x' })),
    applyProposals: vi.fn(async () => ({ applied: [{ index: 0, id: 'lia' }, { index: 2, id: 'r1' }], failed: [{ index: 1, error: 'Já existe o canal #financeiro.' }], forwarded: [], draft: { agentId: 'leo' } })),
    dismissProposal: vi.fn(),
    dismissProposals: vi.fn(),
    saveAgent: vi.fn(async () => {}),
    engineModels: vi.fn(async () => ({ models: [] })),
    navigate: vi.fn(),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Proposals } = await import('../src/renderer/src/components/Tuca')
const { Onboarding } = await import('../src/renderer/src/components/Onboarding')

const off = (): EngineStatus => ({ installed: false, loggedIn: false })
const engines = (p: Partial<Record<EngineId, EngineStatus>> = {}): Settings['engines'] => ({ claude: off(), codex: off(), opencode: off(), pi: off(), antigravity: off(), cursor: off(), grok: off(), cline: off(), hermes: off(), ...p })
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, handle: name.toLowerCase(), role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 2_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra }) as Agent
const tuca = agent('tuca', 'Tuca', { kind: 'tuca' })
const lia = agent('lia', 'Lia')
const nina = agent('nina', 'Nina')
const dm = { id: 't1', kind: 'dm', name: 'tuca', members: ['tuca'] } as Conversation
function state(p: Partial<State> = {}): State {
  return { ...base, ready: true, people: [{ id: 'ana', name: 'Ana', role: 'owner', about: '' }], you: 'ana', agents: [tuca, lia, nina], connectors: [], conversations: [dm], messages: {}, approvals: [], memories: [], routines: [], skills: [], tabs: {}, view: { kind: 'tuca' }, ...p, settings: { ...base.settings, workspaceName: 'Ana', engines: engines({ claude: { installed: true, loggedIn: true, route: 'plan' } }), onboarding: { done: true } } } as State
}
const draft = { name: 'Léo', role: 'Financeiro', color: 'amber', instructions: 'Você cuida das contas.', modelId: 'sonnet', effort: 'low', web: false, grants: {} } as const
const migration = (): Proposal[] => [
  { kind: 'agent', agentId: 'lia', changes: { limit: 345_000 }, before: { limit: 2_000_000 } },
  { kind: 'channel', name: 'financeiro', members: ['nina'], needs: ['Léo'] },
  { kind: 'routine', routine: { name: 'Fechamento do dia', agentId: '', conversationId: '', prompt: 'Resuma os gastos.', schedule: { days: [1, 2, 3, 4, 5], time: '18:00' }, enabled: true }, needs: ['Léo'] },
  { kind: 'agent', agentId: 'nina', changes: { web: false }, before: { web: true } }
]
const reply = (proposals: Proposal[], extra: Partial<NonNullable<Message['run']>> = {}): Message => ({ id: 'm1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Mandei tudo de uma vez.', at: 10, run: { status: 'done', steps: [], proposals, agentDraft: { ...draft }, ...extra } }) as Message

let root: Root
beforeEach(() => {
  fake = state()
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.clearAllMocks()
})
const text = (): string => document.body.textContent ?? ''
const tick = (): Promise<void> => act(async () => new Promise((r) => setTimeout(r, 10)))
const button = (name: RegExp): HTMLButtonElement => {
  const b = [...document.querySelectorAll('button')].find((x) => name.test((x.textContent ?? '').trim()) && !x.disabled)
  if (!b) throw new Error(`no enabled button ${name}: ${[...document.querySelectorAll('button')].map((x) => `${x.textContent}${x.disabled ? '(off)' : ''}`).join(' | ')}`)
  return b as HTMLButtonElement
}
const click = async (name: RegExp | Element): Promise<void> => {
  const b = name instanceof RegExp ? button(name) : name
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await tick()
}
const render = async (node: React.ReactNode): Promise<void> => {
  await act(async () => root.render(node))
  await tick()
}

describe('several proposals in one reply, on screen', () => {
  it('one group: "1 de 5", the new agent first, and each card with its own Aplicar', async () => {
    const m = reply(migration())
    fake = state({ messages: { t1: [m] } })
    await render(<Proposals message={m} />)
    expect(document.querySelectorAll('.proposal-group')).toHaveLength(1)
    expect(text()).toContain('5 propostas')
    expect(text()).toContain('1 de 5')
    expect(text()).toContain('Léo') // the new agent, first
    await click(/^→$/)
    expect(text()).toContain('2 de 5')
    expect(text()).toContain('Ajustar Lia')
    await click(/^Aplicar$/)
    expect(store.applyProposal).toHaveBeenCalledWith('m1', 0)
    // A card that needs the new agent says so.
    await click(/^→$/)
    await click(/^→$/)
    expect(text()).toContain('#financeiro')
    expect(text()).toContain('Depende de Léo')
  })

  it('"Aplicar todos" says what it will do, in order, then what was applied and what failed', async () => {
    const m = reply(migration())
    fake = state({ messages: { t1: [m] } })
    await render(<Proposals message={m} />)
    await click(/Aplicar todos \(5\)/)
    const steps = [...document.querySelectorAll('.proposal-group__confirm li')].map((li) => li.textContent)
    expect(steps).toEqual([
      'Criar o agente Léo',
      'Ajustar Lia: limite',
      'Ajustar Nina: web',
      'Criar o canal #financeiro',
      'Criar a rotina “Fechamento do dia” de Léo (Seg a sex às 18h)'
    ])
    await click(/^Confirmar$/)
    expect(store.applyProposals).toHaveBeenCalledWith('m1', true)
    expect(text()).toContain('3 aplicadas · 1 não deu certo')
    expect(text()).toContain('Já existe o canal #financeiro.')
    // It goes to the card that failed.
    expect(text()).toContain('4 de 5')
  })

  it('"Descartar todos", and a single card shows as it always did', async () => {
    const m = reply(migration())
    fake = state({ messages: { t1: [m] } })
    await render(<Proposals message={m} />)
    await click(/Descartar todos/)
    expect(store.dismissProposals).toHaveBeenCalledWith('m1', true)
    const one = reply([migration()[0]!], { agentDraft: undefined })
    fake = state({ messages: { t1: [one] } })
    await render(<Proposals message={one} />)
    expect(document.querySelectorAll('.proposal-group')).toHaveLength(0)
    expect(text()).toContain('Ajustar Lia')
  })

  it('a reply from before (one `proposal`) still shows its card', async () => {
    const old = { ...reply([]), run: { status: 'done', steps: [], proposal: migration()[0] } } as Message
    fake = state({ messages: { t1: [old] } })
    await render(<Proposals message={old} />)
    expect(text()).toContain('Ajustar Lia')
    await click(/^Aplicar$/)
    expect(store.applyProposal).toHaveBeenCalledWith('m1', 0)
  })
})

describe("the Tuca's builder screen", () => {
  it('opens the conversation where it was, with no new session', async () => {
    const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'quero planejar a migração', at: 5 } as Message
    fake = state({ messages: { t1: [said, reply(migration())] } })
    await render(<Onboarding build />)
    expect(store.ensureTuca).toHaveBeenCalledTimes(1)
    expect((store.ensureTuca as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBeUndefined() // never `fresh`
    expect(text()).toContain('quero planejar a migração')
    expect(text()).toContain('5 propostas') // the new agent's card too: the others need it, so "Aplicar todos" creates it first
    expect(text()).toContain('Usar esse agente') // on its own, it still fills the form
    // Leaving and coming back: the same.
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    await render(<Onboarding build />)
    expect((store.ensureTuca as ReturnType<typeof vi.fn>).mock.calls.every((c) => !c[1])).toBe(true)
    expect(text()).toContain('quero planejar a migração')
  })

  it('"Nova conversa" asks first when cards were not applied, then starts another', async () => {
    const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'quero planejar a migração', at: 5 } as Message
    fake = state({ messages: { t1: [said, reply(migration())] } })
    await render(<Onboarding build />)
    await click(/Nova conversa/)
    expect(text()).toContain('Tem 5 propostas que você não aplicou')
    expect(store.ensureTuca).toHaveBeenCalledTimes(1)
    await click(/Manter esta/)
    expect(text()).toContain('quero planejar a migração')
    await click(/Nova conversa/)
    await click(/Começar do zero/)
    expect(store.ensureTuca).toHaveBeenLastCalledWith(undefined, true)
  })

  it('"Nova conversa" with nothing left to apply starts over at once', async () => {
    const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'oi', at: 5 } as Message
    fake = state({ messages: { t1: [said] } })
    await render(<Onboarding build />)
    await click(/Nova conversa/)
    expect(store.ensureTuca).toHaveBeenLastCalledWith(undefined, true)
  })
})
