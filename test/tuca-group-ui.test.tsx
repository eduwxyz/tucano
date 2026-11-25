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
    removeTucaLeave: vi.fn(async () => {}),
    applyProposal: vi.fn(async () => ({ id: 'x' })),
    applyProposals: vi.fn(async () => ({ applied: [{ index: 0, id: 'lia' }, { index: 2, id: 'r1' }], failed: [{ index: 1, error: 'Já existe o canal #financeiro.' }], forwarded: [], draft: { agentId: 'leo' } })),
    dismissProposal: vi.fn(),
    dismissProposals: vi.fn(),
    undoProposal: vi.fn(async () => {}),
    undoProposals: vi.fn(async () => ({ applied: [], failed: [{ index: 1, error: 'Já tem conversa em #financeiro.' }], forwarded: [] })),
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

  it('what applied by itself is a receipt with Desfazer; the limit left to confirm is a card; "Desfazer tudo" says what it could not', async () => {
    const undo = { until: Date.now() + 3_600_000 }
    const [limit, channel, routine] = migration()
    const m = reply([{ ...limit! }, { ...channel!, state: 'applied', auto: true, appliedId: 'c9', undo }, { ...routine!, state: 'applied', auto: true, appliedId: 'r9', undo }], { agentDraft: { ...draft, state: 'created', agentId: 'leo', auto: true, undo: { ...undo, stamps: {} } } })
    fake = state({ messages: { t1: [m] }, agents: [tuca, lia, nina, agent('leo', 'Léo')] })
    await render(<Proposals message={m} />)
    expect(text()).toContain('Criei Léo.')
    expect(text()).toContain('feito por Tuca')
    await click(/^Desfazer$/)
    expect(store.undoProposal).toHaveBeenCalledWith('m1', undefined, true)
    await click(/^→$/)
    expect(text()).toContain('Isso dá acesso ou mexe no gasto')
    expect(button(/^Aplicar$/)).toBeTruthy()
    await click(/^→$/)
    expect(text()).toContain('Criei o canal #financeiro.')
    await click(/^Desfazer$/)
    expect(store.undoProposal).toHaveBeenCalledWith('m1', 1)
    await click(/Desfazer tudo \(3\)/)
    expect(store.undoProposals).toHaveBeenCalledWith('m1')
    expect(text()).toContain('Uma não foi desfeita: Já tem conversa em #financeiro.')
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

  it('"Nova conversa" starts another at once, cards or not: this one is kept, so there is nothing to confirm', async () => {
    const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'quero planejar a migração', at: 5 } as Message
    fake = state({ messages: { t1: [said, reply(migration())] } })
    await render(<Onboarding build />)
    expect(text()).not.toContain('Conversas (') // with one conversation there is nothing to switch to
    await click(/Nova conversa/)
    expect(text()).not.toContain('apaga esta')
    expect(store.ensureTuca).toHaveBeenLastCalledWith(undefined, true)
  })

  it('lists the other conversations with him, the one last talked in first, and goes back to one', async () => {
    const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'quero planejar a migração', at: 5 } as Message
    const other = { id: 'p2', conversationId: 't0', author: { kind: 'person', id: 'ana' }, text: 'Oi Tuca, preciso de um resumo das vendas', at: 2 } as Message
    const base = state({ messages: { t1: [said], t0: [other] } })
    fake = { ...base, conversations: [...base.conversations, { id: 't0', kind: 'dm', name: 'tuca', members: ['tuca'], title: 'Resumo das vendas', createdAt: 1 }] } as State
    await render(<Onboarding build />)
    await click(/Conversas \(2\)/)
    const rows = [...document.querySelectorAll('.onb-tc__conv-title')].map((e) => e.textContent)
    expect(rows).toEqual(['Quero planejar a migração', 'Resumo das vendas'])
    await click(/Resumo das vendas/)
    expect(text()).toContain('preciso de um resumo das vendas')
    expect(text()).not.toContain('quero planejar a migração')
  })
})

describe('what the Tuca was let to do himself, on his screen', () => {
  const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'quero o preço dos concorrentes', at: 5 } as Message
  const linear = { id: 'c-lin', name: 'Linear', kind: 'remote', status: 'connected', tools: [] } as unknown as State['connectors'][number]

  it('is not there while nothing was allowed', async () => {
    fake = state({ messages: { t1: [said] } })
    await render(<Onboarding build />)
    expect(text()).not.toContain('Liberado (')
  })

  it('lists each leave with what it uses and where it holds, and "Retirar" takes it back', async () => {
    fake = state({
      messages: { t1: [said] },
      connectors: [linear],
      leaves: [
        { id: 'l1', person: 'ana', kind: 'pesquisa de preços', what: 'Pesquisar.', web: true, uses: 3, at: 1 },
        { id: 'l2', person: 'ana', conversationId: 't1', kind: 'tarefas do Linear', what: 'Listar.', grants: { 'c-lin': 'read' }, uses: 1, at: 2 },
        { id: 'l3', person: 'ana', conversationId: 'gone', kind: 'contas', what: 'Calcular.', uses: 1, at: 3 }
      ]
    })
    await render(<Onboarding build />)
    await click(/Liberado \(3\)/)
    const rows = [...document.querySelectorAll('.onb-tc__leave')].map((e) => e.textContent!.replace(/\s+/g, ' ').trim())
    expect(rows).toEqual([
      'pesquisa de preçosUsando a web · sempre, sem perguntarRetirar',
      'tarefas do LinearUsando Linear (leitura) · só em “Quero o preço dos concorrentes”Retirar',
      'contasUsando nada além de escrever · só numa conversaRetirar'
    ])
    await act(async () => (document.querySelectorAll('.onb-tc__leave .link')[1] as HTMLElement).click())
    expect(store.removeTucaLeave).toHaveBeenCalledWith('l2')
  })
})

describe('the team beside his conversation', () => {
  const hello = { id: 'h1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Oi, eu sou o Tuca.', at: 1 } as Message
  const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'um aviso e a mediana', at: 5 } as Message
  const duda = agent('duda', 'Duda', { role: 'Atendimento' })
  const theo = agent('theo', 'Theo', { role: 'Dados' })
  const cora = agent('cora', 'Cora', { role: 'Conteúdo' })
  const part = (id: string, to: string, st: State['delegations'][number]['state'], text: string, extra: Partial<State['delegations'][number]> = {}): State['delegations'][number] =>
    ({ id, from: 'tuca', to, conversationId: `dm-${to}`, rootId: `r-${id}`, originConversationId: 't1', originThreadId: 'p1', originMessageId: 'a1', requestedBy: 'ana', text, state: st, createdAt: Number(id.slice(1)), ...extra }) as State['delegations'][number]
  const mates = (): string[] => [...document.querySelectorAll('.onb-tc__mate')].map((m) => `${m.querySelector('.onb-tc__mate-name')!.textContent}|${m.querySelector('.request-note__state')?.textContent ?? ''}|${m.querySelector('.onb-tc__mate-sub')!.textContent}`)
  const steps = (): number => document.querySelectorAll('.onb-steps li').length

  it('at rest: who does what, ideas that are requests, and nothing of building an agent', async () => {
    fake = state({ agents: [tuca, duda, theo, cora], messages: { t1: [hello] } })
    await render(<Onboarding build />)
    expect(steps()).toBe(0)
    expect(text()).toContain('Seu time')
    expect(text()).toContain('Quem faz o que você pede')
    expect(mates()).toEqual(['Duda||Atendimento', 'Theo||Dados', 'Cora||Conteúdo'])
    expect([...document.querySelectorAll('.onb-tc__idea')].map((i) => i.textContent)).toEqual(['Um aviso pros meus clientes', 'Pesquisar um assunto pra mim', 'Um agente novo no time', 'Por que uma rotina falhou?'])
    expect(text()).toContain('O Tuca passa pra quem do time faz. O que ele cria entra na hora, e dá pra desfazer.')
    expect(text()).not.toContain('Prefiro montar eu mesmo')
    expect(document.querySelector('.onb-tc__rows')).toBeNull() // no proposal card
    await click(/Um aviso pros meus clientes/)
    expect(store.sendMessage).toHaveBeenCalledWith('t1', 'Preciso de um aviso curto pros meus clientes sobre uma novidade.')
    // A colleague at rest opens its page.
    await click(document.querySelectorAll('.onb-tc__mate')[1]!)
    expect(store.navigate).toHaveBeenLastCalledWith({ kind: 'agent', id: 'theo' })
  })

  it('with a request in hand: whoever got a part comes first, with what was asked and how it stands', async () => {
    fake = state({
      agents: [tuca, duda, theo, cora],
      messages: { t1: [hello, said] },
      delegations: [part('d1', 'cora', 'open', 'Escreva o aviso do feriado.'), part('d2', 'theo', 'failed', 'Calcule a mediana de 3, 9 e 4.')]
    })
    await render(<Onboarding build />)
    expect(mates()).toEqual(['Cora|trabalhando|Escreva o aviso do feriado.', 'Theo|não terminou|Calcule a mediana de 3, 9 e 4.', 'Duda||Atendimento'])
    expect(text()).toContain('2 neste pedido · 1 trabalhando')
    // A part in hand opens the colleague's work, where it is done.
    await click(document.querySelectorAll('.onb-tc__mate')[0]!)
    expect(store.navigate).toHaveBeenLastCalledWith({ kind: 'conversation', id: 'dm-cora', message: 'r-d1' })
    // Everything back.
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    fake = state({ agents: [tuca, duda, theo, cora], messages: { t1: [hello, said] }, delegations: [part('d1', 'cora', 'done', 'Escreva o aviso do feriado.')] })
    await render(<Onboarding build />)
    expect(mates()[0]).toBe('Cora|concluído|Escreva o aviso do feriado.')
    expect(text()).toContain('1 neste pedido · tudo de volta')
  })

  it("only the latest thing asked lights the team: an older request's parts are at rest", async () => {
    const later = { id: 'p2', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'e como funcionam as aprovações?', at: 50 } as Message
    fake = state({ agents: [tuca, duda, theo, cora], messages: { t1: [hello, said, later] }, delegations: [part('d1', 'cora', 'done', 'Escreva o aviso do feriado.')] })
    await render(<Onboarding build />)
    expect(mates()).toEqual(['Duda||Atendimento', 'Theo||Dados', 'Cora||Conteúdo'])
  })

  it('"Novo agente" brings the proposal and its steps, and "Ver o time" goes back', async () => {
    fake = state({ agents: [tuca, duda, theo, cora], messages: { t1: [hello, said] }, delegations: [part('d1', 'cora', 'done', 'Escreva o aviso do feriado.')] })
    await render(<Onboarding build />)
    await click(/^Novo agente$/)
    expect(steps()).toBe(3)
    expect(document.querySelector('.onb-tc__rows')).not.toBeNull()
    expect(document.querySelector('.onb-tc__team')).toBeNull()
    expect(text()).toContain('Prefiro montar eu mesmo')
    await click(/^Ver o time$/)
    expect(steps()).toBe(0)
    expect(document.querySelector('.onb-tc__team')).not.toBeNull()
  })

  it('a proposal to decide is what sits beside the chat, and a made agent gives the team back once closed', async () => {
    const proposed = (st?: 'created'): Message => ({ id: 'm1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Montei o Léo.', at: 10, run: { status: 'done', steps: [], agentDraft: { ...draft, ...(st ? { state: st, agentId: 'leo' } : {}) } } }) as Message
    fake = state({ agents: [tuca, duda, theo, cora], messages: { t1: [hello, said, proposed()] } })
    await render(<Onboarding build />)
    expect(steps()).toBe(3)
    expect(text()).toContain('Proposta do Tuca, pronta pra criar')
    expect(text()).not.toContain('Ver o time') // it waits on a decision
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    fake = state({ agents: [tuca, duda, theo, cora, agent('leo', 'Léo', { role: 'Financeiro' })], messages: { t1: [hello, said, proposed('created')] } })
    await render(<Onboarding build />)
    expect(text()).toContain('Entrou no time')
    await click(/^Ver o time$/)
    expect(mates().at(-1)).toBe('Léo||Financeiro')
  })
})

describe('the builder screen, after the debloat: steps, ideas and the proposal beside the chat', () => {
  const hello = { id: 'h1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Oi, eu sou o Tuca.', at: 1 } as Message
  const said = { id: 'p1', conversationId: 't1', author: { kind: 'person', id: 'ana' }, text: 'tickets de suporte', at: 5 } as Message
  const proposed = (extra: Partial<NonNullable<Message['run']>['agentDraft']> = {}, proposals: Proposal[] = []): Message =>
    ({ id: 'm1', conversationId: 't1', author: { kind: 'agent', id: 'tuca' }, text: 'Montei o Léo.', at: 10, run: { status: 'done', steps: [], proposals, agentDraft: { ...draft, task: 'Resuma os gastos de hoje.', ...extra } } }) as Message
  const steps = (): string[] => [...document.querySelectorAll('.onb-steps li')].map((li) => `${li.className}:${li.textContent}`)
  const rows = (): string[] => [...document.querySelectorAll('.onb-tc__rows > div')].map((r) => `${r.querySelector('dt')?.textContent}=${r.querySelector('dd')?.textContent}`)

  it('opened to make an agent, it starts on the proposal: his greeting, four ideas that send, and an empty card that cannot be created', async () => {
    fake = state({ messages: { t1: [hello] } })
    await render(<Onboarding build making />)
    expect(steps()[0]).toBe('is-now:1Conversa')
    expect(text()).toContain('Recebe seus pedidos, passa pra quem do time faz e cuida do Tucano.')
    expect(text()).toContain('Oi, eu sou o Tuca.')
    expect(document.querySelectorAll('.onb-tc__idea')).toHaveLength(4)
    expect(rows().slice(0, 4)).toEqual(['Nome=—', 'O que faz=—', 'Quando=—', 'Acesso=—'])
    expect(button(/Prefiro montar eu mesmo/)).toBeTruthy()
    expect([...document.querySelectorAll('button')].find((b) => b.textContent === 'Criar agente')?.disabled).toBe(true)
    // What happens to what he proposes, once, under the field (not in it too): made at once, with Desfazer.
    expect(text().split('O que ele cria entra na hora, e dá pra desfazer.').length - 1).toBe(1)
    await click(/Triar os tickets de suporte toda manhã/)
    expect(store.sendMessage).toHaveBeenCalledWith('t1', 'Quero alguém pra triar os tickets de suporte toda manhã.')
    // Turned off in the settings: nothing is made without a click, as before.
    await act(async () => root.unmount())
    root = createRoot(document.getElementById('root')!)
    fake = { ...state({ messages: { t1: [hello] } }), settings: { ...state().settings, tucaApplyNow: false } }
    await render(<Onboarding build making />)
    expect(text().split('Nada é criado sem você').length - 1).toBe(1)
  })

  it('with no one on the team yet, the proposal is what sits beside the chat, however he was opened', async () => {
    fake = state({ agents: [tuca], messages: { t1: [hello] } })
    await render(<Onboarding build />)
    expect(steps()[0]).toBe('is-now:1Conversa')
    expect(rows().slice(0, 2)).toEqual(['Nome=—', 'O que faz=—'])
    expect(document.querySelector('.onb-tc__team')).toBeNull()
    expect(text()).not.toContain('Ver o time') // there is no team to see
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
