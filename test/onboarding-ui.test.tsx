// The first run on screen: nothing set up (ChatGPT and Claude to set up here, or what to subscribe
// to), found ready (tested, in three clicks), the Tuca's question and the agent it makes, the first
// message left in #geral; someone invited and their welcome; the short sidebar of a new install and
// the missions. The core is a stand-in: what's sent to it is what's checked.
import { parseHTML } from 'linkedom'
import { act, useEffect } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, EngineId, EngineStatus, Person, Settings } from '../src/shared/types'
import type { State } from '../src/renderer/src/store'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true, matchMedia: () => ({ matches: true }) })
Object.assign(window, { tucano: {} })
// React reads typing from the input event only where the document says it has one (linkedom doesn't).
Object.assign(document, { oninput: null })

vi.mock('open-bot-avatar/dom', () => ({ mountAvatar: () => new Proxy({}, { get: () => () => {} }) }))
// The opening animation: done at once.
vi.mock('../src/renderer/src/components/Splash', () => ({
  Splash: ({ onDone }: { onDone: () => void }) => {
    useEffect(onDone, [onDone])
    return null
  }
}))

let fake: State
vi.mock('../src/renderer/src/store', async (original) => {
  const real = await original<typeof import('../src/renderer/src/store')>()
  return {
    ...real,
    useStore: <T,>(select: (s: State) => T): T => select(fake),
    getState: () => fake,
    refreshEngines: vi.fn(),
    testEngine: vi.fn(async () => ({ ok: true, seconds: 1.2, message: 'ok' })),
    harnessMcps: vi.fn(async () => [{ key: 'claude:linear', name: 'Linear', address: 'https://mcp.linear.app/mcp', kind: 'remote', harnesses: ['claude'], added: false }]),
    importHarnessMcp: vi.fn(async () => 'c1'),
    localSkills: vi.fn(async () => [{ source: '/s/a', name: 'a', description: '', origin: 'Claude Code', scripts: false, bodyLength: 10 }]),
    linkSkill: vi.fn(async () => ({})),
    engineModels: vi.fn(async () => ({ models: [] })),
    setupEngine: vi.fn(async (engine: string) => ({ engine, step: 'install', state: 'running' })),
    engineSetupState: vi.fn(async () => null),
    newChannel: vi.fn(async () => 'ch1'),
    saveAgent: vi.fn(async () => {}),
    updateSettings: vi.fn(),
    navigate: vi.fn(),
    setMyName: vi.fn(async () => {}),
    openExternal: vi.fn(),
    voiceStatus: vi.fn(() => new Promise(() => {}))
  }
})
const store = await import('../src/renderer/src/store')
const { createRoot } = await import('react-dom/client')
const { Intro, GuestWelcome } = await import('../src/renderer/src/components/Intro')
const { Sidebar } = await import('../src/renderer/src/components/Sidebar')
const { MissionsPage } = await import('../src/renderer/src/components/Missions')
const { Dialogs } = await import('../src/renderer/src/components/Dialogs')
const { askBody, askTitle } = await import('../src/renderer/src/components/Coach')

const off = (): EngineStatus => ({ installed: false, loggedIn: false })
const engines = (p: Partial<Record<EngineId, EngineStatus>> = {}): Settings['engines'] => ({ claude: off(), codex: off(), opencode: off(), pi: off(), gemini: off(), cursor: off(), grok: off(), ...p })

let root: Root
const base = (await vi.importActual<typeof import('../src/renderer/src/store')>('../src/renderer/src/store')).getState()
const ana: Person = { id: 'ana', name: 'Eduardo', role: 'owner', about: '' }
function state(p: Omit<Partial<State>, 'settings'> & { settings?: Partial<Settings> } = {}): State {
  return { ...base, ready: true, people: [], you: 'ana', agents: [], connectors: [], conversations: [], messages: {}, approvals: [], memories: [], routines: [], skills: [], tabs: {}, view: { kind: 'approvals' }, ...p, settings: { ...base.settings, workspaceName: 'Carol', engines: engines(), onboarding: { done: false, fresh: true }, ...p.settings } } as State
}

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
// Typing as React sees it: the value set past React's own tracker, then the input event.
const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  let proto: object | null = Object.getPrototypeOf(input)
  let set: ((v: string) => void) | undefined
  while (proto && !set) (set = Object.getOwnPropertyDescriptor(proto, 'value')?.set), (proto = Object.getPrototypeOf(proto))
  await act(async () => {
    set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const render = async (node: React.ReactNode): Promise<void> => {
  await act(async () => root.render(node))
  await tick()
}

describe('the first run', () => {
  it('with nothing set up: ChatGPT and Claude, set up here, or what to subscribe to; the escape hatch stays', async () => {
    await render(<Intro />)
    expect(text()).toContain('Seu time de IA')
    await click(/^Começar$/)
    expect(text()).toContain('Conectar a IA')
    expect(text()).toContain('O login é feito no site deles. O Tucano nunca vê a sua senha.')
    expect(text()).toContain('Uso chave de API, gateway da empresa ou outro programa')
    await click(/Não assino nenhuma/)
    expect(text()).toContain('você paga direto pra empresa, não pro Tucano')
    await click(button(/Ver os planos/))
    expect(store.openExternal).toHaveBeenCalledWith('https://chatgpt.com/pricing')
    await click(/ChatGPT/)
    expect(store.setupEngine).toHaveBeenCalledWith('codex')
    expect(text()).toContain('Preparando tudo no seu computador')
    expect(text()).toContain('Testar com uma resposta de verdade')
    // No jargon on the guided path.
    expect(text()).not.toMatch(/\b(MCP|harness|roteamento)\b/)
  })

  it('found ready: tested with a real reply, tools and skills to bring, the models picked; three clicks to the agent', async () => {
    fake = state({ settings: { engines: engines({ claude: { installed: true, loggedIn: true, route: 'plan', account: 'Plano Claude Max' } }) } })
    await render(<Intro />)
    await click(/^Começar$/)
    await tick()
    expect(text()).toContain('Achei 1 pronto pra usar')
    expect(store.testEngine).toHaveBeenCalledWith('haiku')
    expect(text()).toContain('Plano Claude Max · respondeu em 1,2 s')
    expect(text()).toContain('Também achei no Claude Code')
    expect(text()).toContain('Trazer 1 ferramenta: Linear')
    expect(text()).toContain('Modelos dos bastidores: Haiku pra escolher quem responde e pra memória.')
    expect(text()).not.toMatch(/\bMCP\b/)
    await click(/^Continuar$/)
    expect(store.importHarnessMcp).toHaveBeenCalledWith('claude:linear')
    expect(store.linkSkill).toHaveBeenCalledWith('/s/a')
    expect(text()).toContain('Qual é a primeira coisa que você queria tirar das suas costas?')
    await click(/Organizar minha semana/)
    expect(text()).toContain('O que Lia faz por você')
    expect(text()).toContain('Quanto Lia faz por conta própria?')
    expect(text()).toContain('Ver a sua agenda do Google')
    await click(/Chamar Lia pro time/)
    await act(async () => new Promise((r) => setTimeout(r, 700)))
    expect(store.newChannel).toHaveBeenCalledWith('geral')
    const [saved, channels] = vi.mocked(store.saveAgent).mock.calls[0]! as [Agent, string[]]
    expect(channels).toEqual(['ch1'])
    // Safe by default: the web the goal needs, no computer, no browser of its own.
    expect(saved).toMatchObject({ name: 'Lia', handle: 'lia', web: true, computer: false, browser: false, modelId: 'sonnet' })
    // Normal, the recommended answer, untouched: the agent follows Settings ("Padrão").
    expect(saved.autonomy).toBeUndefined()
    // The models picked behind the scenes, the tour started in #geral, and nothing sent.
    expect(store.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ routerModel: 'haiku', memoryModel: 'haiku', onboarding: { fresh: true, done: true, channel: 'ch1', tour: { done: [] } } }))
    expect(store.navigate).toHaveBeenCalledWith({ kind: 'conversation', id: 'ch1' })
  })

  it("makes the agent from the person's own words", async () => {
    fake = state({ settings: { engines: engines({ codex: { installed: true, loggedIn: true, route: 'plan' } }) } })
    await render(<Intro />)
    await click(/^Começar$/)
    await click(/^Continuar$/)
    const input = document.querySelector<HTMLInputElement>('#intro-say')!
    await type(input, 'responder clientes da minha loja no Instagram')
    await act(async () => void document.querySelector('form.intro-say')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    await tick()
    expect(text()).toContain('O que Duda faz por você')
    expect(text()).toContain('Ajuda a responder os seus clientes')
  })

  it('"Prefiro configurar do zero" opens the detailed form', async () => {
    fake = state({ settings: { engines: engines({ claude: { installed: true, loggedIn: true, route: 'plan' } }) } })
    await render(<Intro />)
    await click(/^Começar$/)
    await click(/^Continuar$/)
    await click(/Prefiro configurar do zero/)
    expect(text()).toContain('Quem vai trabalhar com você?')
  })
})

describe('how far the agent goes on its own', () => {
  const ready = (): State => state({ settings: { engines: engines({ claude: { installed: true, loggedIn: true, route: 'plan' } }) } })
  const toAgent = async (): Promise<void> => {
    await render(
      <>
        <Intro />
        <Dialogs />
      </>
    )
    await click(/^Começar$/)
    await click(/^Continuar$/)
    await click(/Organizar minha semana/)
  }
  const rows = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.autonomy-pick__row')]
  const picked = (): string => rows().find((r) => r.getAttribute('aria-checked') === 'true')?.textContent ?? ''
  const hint = (): string => document.querySelector('.autonomy-pick__hint')?.textContent ?? ''
  const create = async (): Promise<Agent> => {
    await click(/Chamar Lia pro time/)
    await act(async () => new Promise((r) => setTimeout(r, 700)))
    return vi.mocked(store.saveAgent).mock.calls[0]![0] as Agent
  }

  it('asks it on the agent, with Normal picked and recommended, and no lock line', async () => {
    fake = ready()
    await toAgent()
    expect(text()).toContain('Quanto Lia faz por conta própria?')
    expect(text()).not.toContain('pede o seu ok')
    expect(rows().map((r) => r.textContent)).toEqual(['Me pergunta antes de mudar qualquer coisa', 'Faz o dia a dia por conta própria e pergunta antes do que importaRecomendado', 'Faz tudo por conta própria, até enviar e pagar'])
    expect(picked()).toContain('Faz o dia a dia')
    expect(hint()).toContain('Pede antes de enviar, apagar, publicar, pagar')
  })

  it('creates the agent with Careful when that is the answer, and the hint follows', async () => {
    fake = ready()
    await toAgent()
    await click(rows()[0]!)
    expect(picked()).toContain('Me pergunta antes')
    expect(hint()).toContain('Pede antes de escrever num app')
    expect((await create()).autonomy).toBe('careful')
  })

  it('asks the same confirmation as Settings before No guardrails; cancelled, nothing changes', async () => {
    fake = ready()
    await toAgent()
    await click(rows()[2]!)
    expect(text()).toContain('Deixar agir sem travas?')
    expect(text()).toContain('Envia, apaga, publica, paga e clica sem te perguntar.')
    await click(/^Cancelar$/)
    expect(text()).not.toContain('Deixar agir sem travas?')
    expect(picked()).toContain('Faz o dia a dia')
    await click(rows()[2]!)
    await click(/^Sem travas$/)
    expect(picked()).toContain('Faz tudo por conta própria')
    expect(hint()).toContain('Ainda pede o que é de alto risco')
    expect((await create()).autonomy).toBe('free')
  })

  it('keeps Normal as the agent\'s own when Settings say otherwise', async () => {
    fake = ready()
    fake.settings.autonomy = 'careful'
    await toAgent()
    expect(picked()).toContain('Faz o dia a dia')
    expect((await create()).autonomy).toBe('normal')
  })

  it('is also in the detailed form, from "Prefiro configurar do zero"', async () => {
    fake = ready()
    await render(
      <>
        <Intro />
        <Dialogs />
      </>
    )
    await click(/^Começar$/)
    await click(/^Continuar$/)
    await click(/Prefiro configurar do zero/)
    await click(/^Continuar$/)
    expect(text()).toMatch(/Quanto .+ faz por conta própria\?/)
    expect(picked()).toContain('Faz o dia a dia')
    expect(text()).not.toContain('Nada disso acontece sem o seu ok')
  })

  it("the tour's balloon promises only what the level does", () => {
    expect(askTitle('Lia')).toBe('Quando Lia precisar de você, pede aqui.')
    expect(askBody('careful')).toContain('Antes de mudar qualquer coisa')
    expect(askBody('normal')).toContain('Antes de enviar, apagar, publicar ou pagar')
    expect(askBody('free')).toContain('só pede o que é de alto risco')
    expect(askBody('free')).toContain('depois de ler algo de fora')
    expect(askBody('free', false)).not.toContain('de fora')
    for (const l of ['careful', 'normal', 'free'] as const) expect(askTitle('Lia') + askBody(l)).not.toMatch(/Nada acontece sem você/)
  })
})

describe('someone invited to a team', () => {
  const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Pesquisa e resume', color: 'violet', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  const marina: Person = { id: 'mar', name: 'Marina', role: 'member', about: '' }

  it('says who invited them, shows the team and the deal, and starts the short tour', async () => {
    fake = state({ people: [ana, marina, { id: 'rafa', name: 'Rafa', role: 'member', about: '' }], you: 'mar', agents: [lia], settings: { workspaceLabel: 'Agência Norte', onboarding: { done: true, guest: { by: 'Eduardo' } } } })
    await render(<GuestWelcome />)
    expect(text()).toContain('Eduardo te chamou pro time')
    expect(text()).toContain('Agência Norte')
    expect(text()).toContain('Pesquisa e resume')
    expect(text()).toContain('Eduardo e Rafa já estão aqui')
    expect(text()).toContain('O que você fala direto com um agente só você lê. Nem Eduardo.')
    expect(text()).toContain('Nos canais, o time todo vê.')
    expect(text()).toContain('Os agentes pedem ok antes de enviar, apagar ou pagar.')
    await click(/^Atendimento$/)
    await click(/Entrar no time/)
    expect(store.setMyName).toHaveBeenCalledWith('Marina', 'Atendimento')
    expect(store.updateSettings).toHaveBeenCalledWith({ onboarding: { done: true, tour: { done: ['first'] } } })
  })
})

describe('the sidebar and the missions', () => {
  const geral = { id: 'ch1', kind: 'channel', name: 'geral', members: ['a1'] } as State['conversations'][number]
  const lia: Agent = { id: 'a1', name: 'Lia', handle: 'lia', role: 'Agenda', color: 'violet', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
  const labels = (): string[] => [...document.querySelectorAll('.nav-item__label')].map((x) => x.textContent ?? '')

  it('starts short on a new install: the Tuca, what waits on you, the channel, the agent, the missions, the settings', async () => {
    fake = state({ agents: [lia], conversations: [geral], settings: { onboarding: { done: true, fresh: true } } })
    await render(<Sidebar />)
    expect(labels()).toEqual(['Tuca', 'Aprovações', 'geral', 'Lia', 'Configurações'])
    expect(text()).toContain('Missões')
    expect(text()).toContain('Próxima: fale com Lia')
  })

  it('grows as missions bring parts, tagged new until opened', async () => {
    fake = state({ agents: [lia], conversations: [geral], connectors: [{ id: 'c1' } as State['connectors'][number]], settings: { onboarding: { done: true, fresh: true } } })
    await render(<Sidebar />)
    expect(labels()).toContain('Conectores')
    expect(document.querySelector('.nav-item.is-fresh')?.textContent).toContain('NOVO')
    expect(text()).toContain('Você liberou Conectores')
    await click(document.querySelector('.nav-item.is-fresh')!)
    expect(store.updateSettings).toHaveBeenCalledWith({ onboarding: { done: true, fresh: true, seen: ['connectors'] } })
  })

  it('is whole for someone who already used Tucano, and after "Mostrar tudo de uma vez"', async () => {
    for (const onboarding of [undefined, { done: true }, { done: true, fresh: true, showAll: true }]) {
      fake = state({ agents: [lia], conversations: [geral], settings: { onboarding } })
      await render(<Sidebar />)
      expect(labels()).toEqual(expect.arrayContaining(['Memória', 'Wiki', 'Rotinas', 'Skills', 'Boletim', 'Uso e limites', 'Conectores']))
    }
  })

  it('lists the six missions, with what each brings, and turns the short sidebar off on request', async () => {
    fake = state({ agents: [lia], conversations: [geral], settings: { onboarding: { done: true, fresh: true } } })
    await render(<MissionsPage />)
    expect([...document.querySelectorAll('.mission > b')].map((b) => b.textContent)).toEqual(['Fale com Lia', 'Aprove algo', 'Conecte uma conta', 'Monte um segundo agente', 'Deixe algo no automático', 'Guarde algo que importa'])
    expect(text()).toContain('Libera Conectores')
    await click(/Mostrar tudo de uma vez/)
    expect(store.updateSettings).toHaveBeenCalledWith({ onboarding: { done: true, fresh: true, showAll: true } })
  })
})
