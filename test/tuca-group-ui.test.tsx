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
    createFromDraft: vi.fn(async () => ({ agentId: 'rafa', conversationId: 'd1' })),
    sendMessage: vi.fn(),
    settleDraft: vi.fn(),
    openDm: vi.fn(async () => {}),
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
const engines = (p: Partial<Record<EngineId, EngineStatus>> = {}): Settings['engines'] => ({ claude: off(), codex: off(), opencode: off(), pi: off(), antigravity: off(), cursor: off(), grok: off(), cline: off(), hermes: off(), endpoint: off(), ...p })
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
  it('shows the recommendation for long proposed instructions and keeps the full text on the card', async () => {
    const instructions = `${'x'.repeat(32_000)} END`
    const m = reply([{ kind: 'agent', agentId: 'lia', changes: { instructions }, before: { instructions: 'x' } }, migration()[2]!])
    await render(<Proposals message={m} />)
    await click(/^→$/)
    expect(text()).toContain('Prompt longo')
    expect(text()).toContain('32.004')
    expect(text()).toContain(instructions)
  })

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

  it('a card that needs an agent no card of the reply makes says to create it first', async () => {
    // An older reply where a second new agent took the first one's card: Sustinho is in no card any more.
    const susto: Proposal = { kind: 'routine', routine: { name: 'Preparo do susto', agentId: '', conversationId: '', prompt: 'Prepare o susto.', schedule: { days: [1], time: '08:00' }, enabled: true }, needs: ['Sustinho'] }
    const m = reply([susto], { agentDraft: { ...draft, name: 'Faro' } })
    fake = state({ messages: { t1: [m] } })
    await render(<Proposals message={m} />)
    await click(/^→$/)
    expect(text()).toContain('Depende de Sustinho, que não está em nenhum card desta resposta: crie antes (peça ao Tuca) e aplique esta depois.')
    // Once there's a Sustinho (made some other way), it's an ordinary card again.
    fake = state({ messages: { t1: [m] }, agents: [tuca, lia, nina, agent('s1', 'Sustinho')] })
    await render(<Proposals message={{ ...m }} />)
    expect(text()).not.toContain('que não está em nenhum card')
    expect(text()).toContain('É de Sustinho, que já está no time.')
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

describe('the builder screen, after the debloat: steps, ideas and the proposal beside the chat', () => {
  const hello = { id: 'h1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Oi, eu sou o Tuca.', at: 1 } as Message
  const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'tickets de suporte', at: 5 } as Message
  const proposed = (extra: Partial<NonNullable<Message['run']>['agentDraft']> = {}, proposals: Proposal[] = []): Message =>
    ({ id: 'm1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Montei o Léo.', at: 10, run: { status: 'done', steps: [], proposals, agentDraft: { ...draft, task: 'Resuma os gastos de hoje.', ...extra } } }) as Message
  const steps = (): string[] => [...document.querySelectorAll('.onb-steps li')].map((li) => `${li.className}:${li.textContent}`)
  const rows = (): string[] => [...document.querySelectorAll('.onb-tc__rows > div')].map((r) => `${r.querySelector('dt')?.textContent}=${r.querySelector('dd')?.textContent}`)

  it('starts in the chat: his greeting, four ideas that send, and an empty proposal that cannot be created', async () => {
    fake = state({ messages: { t1: [hello] } })
    await render(<Onboarding build />)
    expect(steps()[0]).toBe('is-now:1Conversa')
    expect(text()).toContain('Explica o Tucano, investiga o que não funciona e cria agentes.')
    expect(text()).toContain('Oi, eu sou o Tuca.')
    expect(document.querySelectorAll('.onb-tc__idea')).toHaveLength(4)
    expect(rows().slice(0, 4)).toEqual(['Nome=—', 'O que faz=—', 'Quando=—', 'Acesso=—'])
    expect(button(/Prefiro montar eu mesmo/)).toBeTruthy()
    expect([...document.querySelectorAll('button')].find((b) => b.textContent === 'Criar agente')?.disabled).toBe(true)
    // "Nada é criado sem você" once, under the field (not in it too).
    expect(text().split('Nada é criado sem você').length - 1).toBe(1)
    await click(/Triar os tickets de suporte toda manhã/)
    expect(store.sendMessage).toHaveBeenCalledWith('t1', 'Quero alguém pra triar os tickets de suporte toda manhã.')
  })

  it('a proposal fills the card ("Quando" from its routine) and "Criar agente" makes it and tries its first task', async () => {
    const routine: Proposal = { kind: 'routine', routine: { name: 'Fechamento', agentId: '', conversationId: '', prompt: 'Resuma.', schedule: { days: [1, 2, 3, 4, 5], time: '18:00' }, enabled: true }, needs: ['Léo'] }
    fake = state({ messages: { t1: [hello, said, proposed({}, [routine])] } })
    await render(<Onboarding build />)
    expect(steps().map((s) => s.split(':')[0])).toEqual(['is-done', 'is-now', ''])
    expect(rows()).toContain('Nome=Léo · Financeiro')
    expect(rows()).toContain('Quando=Seg a sex às 18h')
    expect(rows()).toContain('Acesso=Sem web · sem conectores')
    expect(document.querySelectorAll('.onb-tc__idea')).toHaveLength(0)
    await click(/^Criar agente$/)
    expect(store.createFromDraft).toHaveBeenCalledWith('m1')
    expect(store.sendMessage).toHaveBeenCalledWith('d1', 'Resuma os gastos de hoje.')
    await click(/^Descartar$/)
    expect(store.settleDraft).toHaveBeenCalledWith('m1')
  })

  it('"Editar antes" goes on to its access, with the steps still on Proposta', async () => {
    fake = state({ messages: { t1: [hello, said, proposed()] } })
    await render(<Onboarding build />)
    await click(/^Editar antes$/)
    expect(steps()[1]).toBe('is-now:2Proposta · acesso')
  })

  it('once made, the steps say Pronto and the card opens its conversation', async () => {
    const leo = agent('leo', 'Léo')
    fake = state({ agents: [tuca, lia, nina, leo], messages: { t1: [hello, said, proposed({ state: 'created', agentId: 'leo' })] } })
    await render(<Onboarding build />)
    expect(steps().map((s) => s.split(':')[0])).toEqual(['is-done', 'is-done', 'is-now'])
    expect(text()).toContain('Entrou no time')
    await click(/Abrir conversa com Léo/)
    expect(store.openDm).toHaveBeenCalledWith('leo')
  })
})
