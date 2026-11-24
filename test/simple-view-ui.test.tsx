// The simple view on screen: the rail's four places, where a request starts, the person's requests with
// how each stands, the team as lines, what waits on them, their settings with what they let the Tuca do,
// and the switch to the whole app. The core is a stand-in: what's sent to it is what's checked.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Approval, Connector, Conversation, Delegation, Message, Routine, TucaLeave } from '../src/shared/types'
import type { State, View } from '../src/renderer/src/store'

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
    ensureTuca: vi.fn(async () => ({ agentId: 'tuca', conversationId: 'fresh' })),
    sendMessage: vi.fn(),
    navigate: vi.fn(),
    setUiMode: vi.fn(),
    updateSettings: vi.fn(),
    removeTucaLeave: vi.fn(async () => {}),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { SimpleMain, SimpleRail, TucaLeaves } = await import('../src/renderer/src/components/Simple')
const { requestAgents, requestLine, requestState, tucaConversations, tucaTitle } = await import('../src/renderer/src/tuca-conversations')

const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const agent = (id: string, name: string, extra: Partial<Agent> = {}): Agent => ({ id, name, handle: name.toLowerCase(), role: '', color: 'sky', instructions: 'x', modelId: 'sonnet', effort: 'low', limit: 2_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const tuca = agent('tuca', 'Tuca', { kind: 'tuca' })
const duda = agent('duda', 'Duda', { role: 'Atendimento', instructions: 'Você responde os clientes.\nSempre em tom gentil.' })
const nina = agent('nina', 'Nina', { role: 'Marketing' })
const conv = (id: string, extra: Partial<Conversation> = {}): Conversation => ({ id, kind: 'dm', name: 'tuca', members: ['tuca'], createdAt: 1, ...extra }) as Conversation
const said = (id: string, conversationId: string, text: string, at: number, extra: Partial<Message> = {}): Message => ({ id, conversationId, author: { kind: 'person', id: 'ana' }, text, at, ...extra }) as Message
const by = (id: string, conversationId: string, text: string, at: number, run: Partial<NonNullable<Message['run']>> = {}, extra: Partial<Message> = {}): Message => ({ id, conversationId, author: { kind: 'agent', id: 'tuca' }, text, at, run: { status: 'done', steps: [], ...run }, ...extra }) as Message
const asked = (id: string, to: string, origin: string, state: Delegation['state'], extra: Partial<Delegation> = {}): Delegation => ({ id, from: 'tuca', to, conversationId: `dm-${to}`, rootId: `root-${id}`, originConversationId: origin, originMessageId: 'm', requestedBy: 'ana', text: 'responda as avaliações do iFood', state, createdAt: 5, ...extra }) as Delegation

function state(p: Partial<State> = {}): State {
  return { ...base, ready: true, me: { name: 'Ana Souza', initials: 'AS' }, people: [{ id: 'ana', name: 'Ana Souza', role: 'owner', about: '' }], you: 'ana', agents: [tuca, duda, nina], connectors: [], conversations: [], messages: {}, approvals: [], memories: [], routines: [], skills: [], delegations: [], leaves: [], inbox: { approvals: [], questions: [] }, tabs: {}, view: { kind: 'home' }, ...p, settings: { ...base.settings, workspaceName: 'Ana', uiMode: 'simple', ...p.settings } } as State
}

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
  const b = [...document.querySelectorAll('button')].find((x) => name.test((x.textContent?.trim() || x.getAttribute('aria-label') || '').trim()) && !x.disabled)
  if (!b) throw new Error(`no enabled button ${name}: ${[...document.querySelectorAll('button')].map((x) => x.textContent).join(' | ')}`)
  return b as HTMLButtonElement
}
const click = async (name: RegExp | Element): Promise<void> => {
  const b = name instanceof RegExp ? button(name) : name
  await act(async () => void b.dispatchEvent(new window.Event('click', { bubbles: true })))
  await tick()
}
const show = async (view: View, p: Partial<State> = {}): Promise<void> => {
  fake = state({ ...p, view })
  await act(async () => root.render(<><SimpleRail /><main><SimpleMain deep={(v) => <div data-deep={v.kind}>deep:{v.kind}</div>} /></main></>))
  await tick()
}
const went = (): View[] => (store.navigate as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as View)

// Two requests: one that waits on the person (a question of his), one done by Duda and Nina; and an empty one.
const waiting = conv('c-wait', { title: 'Preço dos concorrentes', lastAt: 300 })
const done = conv('c-done', { title: 'Avaliações e aviso do feriado', lastAt: 200 })
const empty = conv('c-new', { lastAt: 100 })
const requests: Partial<State> = {
  conversations: [done, waiting, empty],
  messages: {
    'c-wait': [by('h1', 'c-wait', 'Oi, eu sou o Tuca.', 1, {}, { run: undefined }), said('p1', 'c-wait', 'pesquise o preço dos concorrentes', 290), by('q1', 'c-wait', 'Ninguém do time faz isso ainda.', 300, { status: 'waiting_input', questions: [{ question: 'Posso fazer eu mesmo?', kind: 'single', options: [{ label: 'Pode fazer' }] }] })],
    'c-done': [by('h2', 'c-done', 'Oi, eu sou o Tuca.', 1, {}, { run: undefined }), said('p2', 'c-done', 'responda as avaliações e faça o aviso do feriado', 190), by('a1', 'c-done', '', 195, { delegations: [{ id: 'd1', to: 'duda', conversationId: 'dm-duda', rootId: 'r1' }, { id: 'd2', to: 'nina', conversationId: 'dm-nina', rootId: 'r2' }] }, { threadId: 'p2' }), by('a2', 'c-done', 'Pronto: as nove avaliações foram respondidas e o aviso está no ar.', 200, {}, { threadId: 'p2' })],
    'c-new': [by('h3', 'c-new', 'Oi, eu sou o Tuca.', 100, {}, { run: undefined })]
  },
  delegations: [asked('d1', 'duda', 'c-done', 'done'), asked('d2', 'nina', 'c-done', 'done')]
}

describe('what the lists say of a request', () => {
  it('orders them by when something was last said, names each, and reads how it stands', () => {
    const s = state(requests)
    expect(tucaConversations(s).map((c) => c.id)).toEqual(['c-wait', 'c-done', 'c-new'])
    expect(tucaTitle(s, waiting)).toBe('Preço dos concorrentes')
    expect(tucaTitle(s, { ...waiting, title: undefined })).toBe('Pesquise o preço dos concorrentes') // its first request's own words
    expect(tucaTitle(s, empty)).toBe('Conversa nova')
    expect([waiting, done, empty].map((c) => requestState(s, c))).toEqual(['wait', 'done', 'new'])
    expect(requestState(state({ ...requests, delegations: [asked('d1', 'duda', 'c-done', 'open')] }), done)).toBe('run')
    expect(requestState(state({ ...requests, delegations: [asked('d1', 'duda', 'c-done', 'open', { asking: 'm9' })] }), done)).toBe('wait')
    expect(requestState(state({ ...requests, delegations: [asked('d1', 'duda', 'c-done', 'open', { approval: 'ap1' })], approvals: [{ id: 'ap1', agentId: 'duda', conversationId: 'dm-duda', state: 'pending' } as Approval] }), done)).toBe('wait')
    expect(requestAgents(s, done).map((a) => a.name)).toEqual(['Duda', 'Nina'])
    expect(requestLine(s, waiting)).toBe('Posso fazer eu mesmo?')
    expect(requestLine(s, done)).toBe('Pronto: as nove avaliações foram respondidas e o aviso está no ar.') // his closing, from the thread; never his hello
    expect(requestLine(state({ ...requests, delegations: [asked('d1', 'duda', 'c-done', 'open'), asked('d2', 'nina', 'c-done', 'open')] }), done)).toBe('Duda, Nina estão nisso')
    // Someone else's conversations with him aren't mine.
    expect(tucaConversations(state({ ...requests, conversations: [conv('x', { owner: 'bia' }), waiting] })).map((c) => c.id)).toEqual(['c-wait'])
  })
})

describe('the simple view', () => {
  it('the rail has four places, each named, with what waits on me marked', async () => {
    await show({ kind: 'home' }, { inbox: { approvals: [{ id: 'ap1' } as Approval], questions: [] } })
    expect([...document.querySelectorAll('.simple-rail__label')].map((e) => e.textContent)).toEqual(['Novo', 'Pra você', 'Time', 'Conversas'])
    expect(document.querySelector('.simple-rail__new')!.getAttribute('aria-current')).toBe('page')
    expect(document.querySelector('.simple-rail__dot')!.getAttribute('aria-label')).toBe('1 esperando você')
    await click(/^Time$/)
    await click(/^Conversas$/)
    await click(/^Pra você$/)
    await click(/^AS$/)
    expect(went().map((v) => v.kind)).toEqual(['team', 'requests', 'approvals', 'simple-settings'])
  })

  it('a request starts in a field: it asks for an empty conversation with him and goes to it once something is said', async () => {
    await show({ kind: 'home' })
    expect(store.ensureTuca).toHaveBeenCalledWith(undefined, true) // never deletes: the empty one, or a new one
    expect(text()).toContain('Ana.') // by her first name
    expect(text()).toContain('O que você precisa hoje?')
    expect(document.querySelectorAll('.simple-chip')).toHaveLength(4)
    await click(/Criar uma rotina/)
    expect(store.sendMessage).toHaveBeenCalledWith('fresh', 'Quero que alguém do time faça uma coisa todo dia num horário.')
    expect(went()).toEqual([])
    // What she said is there: the request is open, and the screen goes to it.
    fake = state({ view: { kind: 'home' }, messages: { fresh: [said('p', 'fresh', 'oi', 1)] } })
    await act(async () => root.render(<SimpleMain deep={() => null} />))
    await tick()
    expect(went()).toEqual([{ kind: 'conversation', id: 'fresh' }])
  })

  it('with no team yet, the ideas are about getting a first colleague', async () => {
    await show({ kind: 'home' }, { agents: [tuca] })
    expect([...document.querySelectorAll('.simple-chip')].map((e) => e.textContent)).toContain('Responder meus clientes')
  })

  it('shows what is still open under the field: what waits on me, not what is done', async () => {
    await show({ kind: 'home' }, requests)
    expect(text()).toContain('Em andamento')
    expect([...document.querySelectorAll('.simple-row__title')].map((e) => e.textContent)).toEqual(['Preço dos concorrentes'])
    await click(document.querySelector('.simple-row--request')!)
    expect(went()).toEqual([{ kind: 'conversation', id: 'c-wait' }])
  })

  it('my requests: going ones first, done after, each with who worked on it, and a search over all of it', async () => {
    await show({ kind: 'requests' }, requests)
    expect(text()).toContain('Tudo o que você já pediu.')
    expect([...document.querySelectorAll('.simple-section__title')].map((e) => e.textContent)).toEqual(['Em andamento', 'Prontos'])
    expect([...document.querySelectorAll('.simple-row__title')].map((e) => e.textContent)).toEqual(['Preço dos concorrentes', 'Avaliações e aviso do feriado']) // the empty one isn't a request yet
    expect([...document.querySelectorAll('.simple-state')].map((e) => e.textContent)).toEqual(['espera você', 'pronto'])
    expect(document.querySelectorAll('.simple-row--request')[1]!.querySelector('.simple-row__faces')!.getAttribute('aria-label')).toBe('Duda, Nina')
    const input = document.querySelector('.simple-search input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'nina')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await tick()
    expect([...document.querySelectorAll('.simple-row__title')].map((e) => e.textContent)).toEqual(['Avaliações e aviso do feriado']) // by a colleague's name
  })

  it('with nothing asked yet, says so and offers the first request', async () => {
    await show({ kind: 'requests' }, { conversations: [empty], messages: requests.messages! })
    expect(text()).toContain('Você ainda não pediu nada.')
    await click(/Fazer um pedido/)
    expect(went()).toEqual([{ kind: 'home' }])
  })

  it('the team is lines: who, what they do, how they stand; with what the team knows and the services under it', async () => {
    const routine = { id: 'r1', agentId: 'duda', conversationId: 'dm-duda', name: 'Avaliações da manhã', prompt: 'x', enabled: true, schedule: { days: [1], time: '09:00' } } as Routine
    const gmail = { id: 'g', name: 'Gmail', kind: 'remote', status: 'needs_auth', tools: [] } as unknown as Connector
    await show({ kind: 'team' }, { routines: [routine], connectors: [gmail], approvals: [{ id: 'ap1', agentId: 'duda', conversationId: 'dm-duda', state: 'pending' } as Approval] })
    expect(text()).toContain('Quem trabalha com você.')
    expect([...document.querySelectorAll('.simple-row--colleague .simple-row__name')].map((e) => e.textContent)).toEqual(['Duda', 'Nina']) // never the Tuca
    const rows = [...document.querySelectorAll('.simple-row--colleague')]
    expect(rows[0]!.textContent).toContain('Atendimento')
    expect(rows[0]!.textContent).toContain('1 rotina')
    expect(rows[0]!.querySelector('.simple-state')!.textContent).toBe('espera você')
    expect(rows[1]!.querySelector('.simple-state')!.textContent).toBe('livre')
    expect(text()).toContain('O que o time sabe')
    expect(text()).toContain('Gmail')
    expect(text()).toContain('pede login')
    await click(rows[0]!.querySelector('.simple-row__open')!)
    await click(rows[1]!.querySelector('.simple-row__ask')!)
    await click(/^Wiki/)
    await click(/Novo colega/)
    expect(went()).toEqual([{ kind: 'agent', id: 'duda' }, { kind: 'home', draft: 'Pra Nina: ' }, { kind: 'wiki' }, { kind: 'home', draft: 'Quero um colega novo pra ' }])
  })

  it('a colleague, as someone who works with them reads them, with their whole page one step further', async () => {
    await show({ kind: 'agent', id: 'duda' }, { delegations: [asked('d1', 'duda', 'c-done', 'done')] })
    expect(text()).toContain('Duda')
    expect(text()).toContain('Você responde os clientes.')
    expect(text()).toContain('Últimos pedidos')
    expect(text()).toContain('responda as avaliações do iFood')
    expect(document.querySelector('[data-deep]')).toBeNull()
    await click(/Pedir algo/)
    await click(/Ajustes do colega/)
    expect(went()).toEqual([{ kind: 'home', draft: 'Pra Duda: ' }, { kind: 'agent', id: 'duda', full: true }])
    await show({ kind: 'agent', id: 'duda', full: true })
    expect(document.querySelector('[data-deep="agent"]')).not.toBeNull()
  })

  it('what waits on me: each with whose it is, decided right there', async () => {
    const question = { id: 'q1', conversationId: 'c-wait', agentId: 'tuca', text: 'Posso fazer eu mesmo?', askedTo: 'ana', requestedBy: 'ana', state: 'open', deadlineAt: 9e12, createdAt: Date.now(), decisions: [{ question: 'Posso fazer eu mesmo?', kind: 'single', options: [{ label: 'Pode fazer', recommended: true }, { label: 'Prefiro um colega pra isso' }] }] }
    await show({ kind: 'approvals' }, { ...requests, inbox: { approvals: [], questions: [question] } as State['inbox'] })
    expect(text()).toContain('Uma coisa espera você.')
    expect(text()).toContain('tem uma pergunta pra você')
    expect(text()).toContain('Pode fazer')
    expect(text()).toContain('Prefiro um colega pra isso')
    await click(/Ver o pedido/)
    expect(went()).toEqual([{ kind: 'conversation', id: 'c-wait', message: 'q1' }])
    await show({ kind: 'approvals' })
    expect(text()).toContain('Nada espera você.')
  })

  it('a conversation with him is the request; anything else of the app opens inside the frame, with a way back', async () => {
    await show({ kind: 'conversation', id: 'c-done' }, requests)
    expect(document.querySelector('.simple-head__title')!.textContent).toBe('Avaliações e aviso do feriado')
    expect(document.querySelector('.simple-request')).not.toBeNull()
    expect(text()).not.toContain('Oi, eu sou o Tuca.') // the request starts at her own words
    expect(text()).toContain('responda as avaliações e faça o aviso do feriado')
    await show({ kind: 'connectors' })
    expect(document.querySelector('[data-deep="connectors"]')).not.toBeNull()
    expect(document.querySelector('.simple-head__title')!.textContent).toBe('Serviços ligados')
    await click(/^Voltar$/)
    expect(went()).toEqual([{ kind: 'team' }])
  })

  it('the switch says which view is on and asks for the other', async () => {
    await show({ kind: 'team' })
    const [simple, full] = [...document.querySelectorAll('.mode-switch button')] as HTMLButtonElement[]
    expect(simple!.getAttribute('aria-pressed')).toBe('true')
    expect(full!.getAttribute('aria-pressed')).toBe('false')
    await click(simple!)
    expect(store.setUiMode).not.toHaveBeenCalled()
    await click(full!)
    expect(store.setUiMode).toHaveBeenCalledWith('full')
  })

  it('my settings: the look, the language, and what I let the Tuca do himself, each to take back', async () => {
    const leaves: TucaLeave[] = [
      { id: 'l1', person: 'ana', kind: 'pesquisa de preços', what: 'Pesquisar.', web: true, uses: 2, at: 1 },
      { id: 'l2', person: 'ana', kind: 'triagem', what: 'Ver as issues.', grants: { g: 'read' }, conversationId: 'c-done', uses: 1, at: 2 }
    ]
    await show({ kind: 'simple-settings' }, { ...requests, leaves, connectors: [{ id: 'g', name: 'Linear', kind: 'remote', status: 'connected', tools: [] } as unknown as Connector] })
    expect(text()).toContain('pesquisa de preços')
    expect(text()).toContain('Usando a web · sempre, sem perguntar')
    expect(text()).toContain('Usando Linear (leitura) · só em “Avaliações e aviso do feriado”')
    await click(document.querySelectorAll('.simple-row--leave .simple-link')[1]!)
    expect(store.removeTucaLeave).toHaveBeenCalledWith('l2')
    await click(/^Escuro$/)
    await click(/^English$/)
    expect((store.updateSettings as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([{ theme: 'dark' }, { language: 'en' }])
    await click(/Todas as configurações/)
    expect(went()).toEqual([{ kind: 'settings' }])
    // Nothing allowed yet: it says how it comes to be.
    await act(async () => root.render(<TucaLeaves />))
    fake = state()
    await act(async () => root.render(<TucaLeaves />))
    expect(text()).toContain('o Tuca pergunta se pode fazer ele mesmo')
  })
})
