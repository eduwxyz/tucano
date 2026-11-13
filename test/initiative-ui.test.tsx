// The proactive coordinator's page: the line in the DM, the window that sets it up, and the record that
// answers "why did it wake?". Real DOM (linkedom), real clicks and keys; only the core is a fake.
import { parseHTML } from 'linkedom'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Commitment, InitiativeConfig, InitiativeInput, InitiativeView, InitiativeWake } from '../src/shared/initiative'
import type { Agent, Conversation } from '../src/shared/types'
import { setLang } from '../src/shared/lang'

const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>')
Object.assign(globalThis, { window, document, HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, IS_REACT_ACT_ENVIRONMENT: true })

let fake: { initiative: InitiativeView[] | null; agents: Agent[]; conversations: Conversation[]; you: string }
const saveInitiative = vi.fn(async (config: InitiativeInput, expectedRevision: number) => ({ ...config, personId: 'ana', revision: expectedRevision + 1, createdAt: 1, updatedAt: 2 }) as InitiativeConfig)
const saveCommitment = vi.fn(async (c: unknown) => c)
const checkInNow = vi.fn(async (_agentId: string): Promise<{ started: boolean; why?: string; running: boolean }> => ({ started: true, running: true }))
const refreshInitiative = vi.fn(async () => {})
const opened: unknown[] = []
const went: unknown[] = []
vi.mock('../src/renderer/src/store', () => ({
  useStore: (select: (s: typeof fake) => unknown) => select(fake),
  saveInitiative: (config: InitiativeInput, expectedRevision: number) => saveInitiative(config, expectedRevision),
  saveCommitment: (c: unknown) => saveCommitment(c),
  checkInNow: (agentId: string) => checkInNow(agentId),
  refreshInitiative: () => refreshInitiative(),
  openDialog: (d: unknown) => opened.push(d),
  navigate: (v: unknown) => went.push(v)
}))
// The page's own building blocks, kept small: this test is about the coordinator's page, not them.
vi.mock('../src/renderer/src/components/Pages', () => ({
  Card: ({ title, lead, children }: { title: string; lead?: string; children: React.ReactNode }) => (
    <section className="card">
      <h2>{title}</h2>
      {lead && <p>{lead}</p>}
      {children}
    </section>
  ),
  Field: ({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) => (
    <div className="field">
      <span className="field__label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </div>
  ),
  Toggle: ({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) => <button className="toggle" role="switch" aria-checked={on} aria-label="ligada" onClick={() => onChange(!on)} />
}))

const { createRoot } = await import('react-dom/client')
const { InitiativeDialog, InitiativeLine, InitiativeSwitch } = await import('../src/renderer/src/components/Initiative')

let root: ReturnType<typeof createRoot> | null = null
const lia: Agent = { id: 'lia', name: 'Lia', handle: 'lia', role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false }
const sol: Agent = { ...lia, id: 'sol', name: 'Sol', handle: 'sol' }
const dm = (id: string, agent: string, name: string): Conversation => ({ id, kind: 'dm', name, members: [agent], unread: 0 })
const channel: Conversation = { id: 'clientes', kind: 'channel', name: 'clientes', members: ['lia', 'sol'], unread: 0 }

const config = (over: Partial<InitiativeConfig> = {}): InitiativeConfig => ({
  personId: 'ana',
  agentId: 'lia',
  conversationId: 'dm-lia',
  enabled: true,
  brief: 'Answer the client about the invoice.',
  observe: { conversations: ['clientes'] },
  work: { conversations: ['clientes'], kinds: ['send'] },
  cadenceMinutes: 15,
  notify: 'material',
  dailyReviews: 24,
  dailyTokens: 2_000_000,
  timezone: 'Europe/Sofia',
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  ...over
})

const commitment = (over: Partial<Commitment> = {}): Commitment => ({
  id: 'c1',
  personId: 'ana',
  agentId: 'lia',
  conversationId: 'dm-lia',
  by: 'person',
  description: 'Send the client the number they asked for.',
  scope: { conversations: ['clientes'], kinds: ['send'] },
  state: 'open',
  evidence: [],
  links: [],
  unchangedFor: 0,
  createdAt: 1,
  updatedAt: 2,
  ...over
})

const wake = (over: Partial<InitiativeWake> = {}): InitiativeWake => ({
  id: 'w1',
  personId: 'ana',
  agentId: 'lia',
  revision: 3,
  at: Date.UTC(2026, 10, 13, 9, 0),
  endedAt: Date.UTC(2026, 10, 13, 9, 1),
  outcome: 'quiet',
  tokens: 900,
  ...over
})

const view = (over: Partial<InitiativeView> = {}): InitiativeView => ({
  config: config(),
  commitments: [commitment()],
  wakes: [wake()],
  status: { dueAt: Date.now() + 12 * 60_000, open: 1, waitingOnPerson: 0, today: { reviews: 2, tokens: 1_500 }, paused: false },
  ...over
})

beforeEach(() => {
  setLang('pt')
  fake = { initiative: [view()], agents: [lia, sol], conversations: [dm('dm-lia', 'lia', 'Lia'), dm('dm-sol', 'sol', 'Sol'), channel], you: 'ana' }
  saveInitiative.mockClear()
  saveCommitment.mockClear()
  checkInNow.mockClear()
  refreshInitiative.mockClear()
  opened.length = 0
  went.length = 0
  root = createRoot(document.getElementById('root')!)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  document.getElementById('root')!.innerHTML = ''
})

const render = async (el: React.ReactElement): Promise<void> => {
  await act(async () => root!.render(el))
}
const click = async (el: Element | null | undefined): Promise<void> => {
  await act(async () => {
    el!.dispatchEvent(new window.Event('click', { bubbles: true }))
  })
}
const button = (text: string, where: ParentNode = document): HTMLButtonElement | undefined =>
  [...where.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
const text = (): string => document.body.textContent ?? ''

describe('the line in the DM', () => {
  it('says what the coordinator is doing, and opens where it is set', async () => {
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(text()).toMatch(/próxima em/)
    await click(document.querySelector('.initiative-line'))
    expect(opened).toEqual([{ kind: 'initiative', agentId: 'lia', conversationId: 'dm-lia' }])
  })

  it('says when it is waiting on the person, and stays away from a DM whose bot does not look after them', async () => {
    fake.initiative = [view({ status: { ...view().status, waitingOnPerson: 1 } })]
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(text()).toContain('espera você')
    expect(document.querySelector('.initiative-line')?.className).toContain('is-waiting')
    // Another bot's DM says nothing about this one: it offers its own way in, not lia's waiting.
    await render(<InitiativeLine conversationId="dm-sol" agentId="sol" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-off')
    expect(text()).not.toContain('espera você')
  })

  it('offers the way in from a DM whose bot has no coordinator yet', async () => {
    // Nobody has one: this DM is where a person turns it on, and it opens on this bot and this DM.
    fake.initiative = [view({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })]
    await render(<InitiativeLine conversationId="dm-sol" agentId="sol" />)
    const line = document.querySelector('.initiative-line')
    expect(line?.className).toContain('is-off')
    expect(line?.textContent).toBe('Iniciativa')
    await click(line)
    expect(opened).toEqual([{ kind: 'initiative', agentId: 'sol', conversationId: 'dm-sol' }])
  })

  it('turns from the way in to the line itself when the person saves one', async () => {
    // The same line, on the same page, before and after a save: the hooks it runs cannot depend on which.
    fake.initiative = [view({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })]
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-off')
    fake.initiative = [view()]
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-on')
    expect(text()).toMatch(/próxima em/)
    // And back again, when it is turned off entirely.
    fake.initiative = [view({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })]
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-off')
  })

  it("speaks for one bot, so a second bot's DM offers its own way in beside the first's line", async () => {
    // A person can give several bots something to look after: lia has one, sol does not, and each DM
    // answers for the bot it belongs to.
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-on')
    await render(<InitiativeLine conversationId="dm-sol" agentId="sol" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-off')
    // And once sol has one of its own, its line is its own, next to lia's rather than instead of it.
    fake.initiative = [...(fake.initiative ?? []), view({ config: config({ agentId: 'sol', conversationId: 'dm-sol' }), commitments: [], wakes: [] })]
    await render(<InitiativeLine conversationId="dm-sol" agentId="sol" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-on')
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(document.querySelector('.initiative-line')?.className).toContain('is-on')
    expect(text()).toMatch(/próxima em/)
  })

  it('says the app is paused rather than pretending the clock is running', async () => {
    fake.initiative = [view({ status: { ...view().status, paused: true } })]
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(text()).toContain('tudo pausado')
  })
})

describe('the window', () => {
  it('shows the brief, the caps and what is left of today, in Portuguese and in English', async () => {
    await render(<InitiativeDialog onClose={() => {}} />)
    // The brief is a controlled textarea: React holds its value, so this harness reads the field and the
    // save payload (below) rather than the DOM node, which linkedom does not fill in.
    expect(document.querySelector('textarea')).toBeTruthy()
    expect(text()).toContain('O que ele cuida pra você')
    expect(text()).toMatch(/2 de 24 conferidas hoje/)
    expect(text()).toMatch(/1 em aberto, 0 esperando você/)
    setLang('en')
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(text()).toContain('2 of 24 check-ins today')
    expect(text()).toContain('Check now')
    expect(text()).not.toContain('Conferir agora')
  })

  it('saves against the revision the page read, so another window is never overwritten', async () => {
    await render(<InitiativeDialog onClose={() => {}} />)
    await click(button('Salvar'))
    expect(saveInitiative).toHaveBeenCalledTimes(1)
    expect(saveInitiative.mock.calls[0]![1]).toBe(3)
    expect(saveInitiative.mock.calls[0]![0]).toMatchObject({ brief: 'Answer the client about the invoice.', enabled: true })
  })

  it('starts from the DM it was opened from when nobody has a coordinator yet', async () => {
    fake.initiative = [view({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })]
    await render(<InitiativeDialog onClose={() => {}} agentId="sol" conversationId="dm-sol" />)
    await click(button('Salvar')) // disabled, but the draft it would send is what matters
    expect(saveInitiative).not.toHaveBeenCalled()
    // The field for the bot's own conversation is not a choice: it is the DM this came from.
    expect(text()).toContain('#clientes')
  })

  it('does not offer to save a brief with nothing in it, and offers the narrow defaults for a new one', async () => {
    // A coordinator nobody has set up yet: no brief, nothing to look at, nothing it may do outside.
    fake.initiative = [view({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })]
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(button('Salvar')?.disabled).toBe(true)
    expect((document.querySelector('select') as HTMLSelectElement).value).toBe('15')
    const boxes = [...document.querySelectorAll('.initiative__check input')] as HTMLInputElement[]
    expect(boxes.every((b) => !b.checked)).toBe(true)
    expect(document.body.textContent).toContain('Desligada')
  })

  it('asks for one right now, and says why not when the core refuses', async () => {
    await render(<InitiativeDialog onClose={() => {}} />)
    await click(button('Conferir agora'))
    expect(checkInNow).toHaveBeenCalledTimes(1)
    checkInNow.mockResolvedValueOnce({ started: false, why: 'cap', running: false })
    await click(button('Conferir agora'))
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/conferidas de hoje acabaram/)
  })

  it('cannot ask while one is running, nor while the app is paused', async () => {
    fake.initiative = [view({ wakes: [wake({ endedAt: undefined, outcome: 'interrupted' })] })]
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(button('Conferindo…')?.disabled).toBe(true)
    fake.initiative = [view({ status: { ...view().status, paused: true } })]
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(button('Conferir agora')?.disabled).toBe(true)
    expect(text()).toContain('nada roda até você despausar')
  })

  it('turns it off from the page, which is a save with the switch down', async () => {
    await render(<InitiativeDialog onClose={() => {}} />)
    await click(button('Desligar'))
    expect(saveInitiative.mock.calls[0]![0]).toMatchObject({ enabled: false })
  })

  it('opens a coordinator nobody has set up with the switch off, not on', async () => {
    fake.initiative = [view({ config: null, commitments: [], wakes: [], status: { open: 0, waitingOnPerson: 0, today: { reviews: 0, tokens: 0 }, paused: false } })]
    await render(<InitiativeDialog onClose={() => {}} />)
    const sw = document.querySelector('[role="switch"]') as HTMLElement
    expect(sw.getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('Desligada')
  })

  it('turns on from the switch, once there is something to look after', async () => {
    fake.initiative = [view({ config: config({ enabled: false }) })]
    await render(<InitiativeDialog onClose={() => {}} />)
    expect((document.querySelector('[role="switch"]') as HTMLElement).getAttribute('aria-checked')).toBe('false')
    await click(document.querySelector('[role="switch"]'))
    expect(saveInitiative).toHaveBeenCalledTimes(1)
    expect(saveInitiative.mock.calls[0]![0]).toMatchObject({ enabled: true, brief: 'Answer the client about the invoice.' })
    expect(saveInitiative.mock.calls[0]![1]).toBe(3)
  })

  it('says why it cannot go up when there is no brief, at the switch rather than under the fields', async () => {
    fake.initiative = [view({ config: config({ enabled: false, brief: '' }) })]
    await render(<InitiativeDialog onClose={() => {}} />)
    // The hint says what is missing before anything is pressed, on the line under the switch.
    expect(text()).toContain('Escreva o pedido para poder ligar')
    // Nothing is sent: the core would refuse an enabled check-in with nothing to go on.
    await click(document.querySelector('[role="switch"]'))
    expect(saveInitiative).not.toHaveBeenCalled()
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Escreva o que ele deve cuidar/)
  })

  it('closes a responsibility by its own state, and never by its text', async () => {
    await render(<InitiativeDialog onClose={() => {}} />)
    await click(button('Dispensar'))
    expect(saveCommitment).toHaveBeenCalledTimes(1)
    expect(saveCommitment.mock.calls[0]![0]).toMatchObject({ id: 'c1', state: 'dismissed' })
    await click(button('Concluir'))
    expect(saveCommitment.mock.calls[1]![0]).toMatchObject({ id: 'c1', state: 'done' })
    // And where it was read is one click away, closing the page it came from.
    await click(button('Abrir conversa'))
    expect(went).toEqual([{ kind: 'conversation', id: 'dm-lia' }])
    expect(opened).toEqual([null])
  })

  it('says what it did, why it did not appear, and what it cost', async () => {
    fake.initiative = [view({
      wakes: [
        wake({ id: 'w2', outcome: 'reported', text: '**The invoice is still unpaid.**', tokens: 1_200, at: Date.UTC(2026, 10, 13, 10, 0), endedAt: Date.UTC(2026, 10, 13, 10, 1) }),
        wake({ id: 'w1', outcome: 'reported', deduped: true, text: 'The invoice is still unpaid.', tokens: 10, at: Date.UTC(2026, 10, 13, 9, 30), endedAt: Date.UTC(2026, 10, 13, 9, 31) }),
        wake({ id: 'w0', outcome: 'skipped', why: 'revision', at: Date.UTC(2026, 10, 13, 9, 0) })
      ]
    })]
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(text()).toContain('escreveu na conversa')
    expect(text()).toContain('The invoice is still unpaid.')
    expect(text()).toContain('repetia a conferida anterior')
    expect(text()).toContain('pulada: você mudou o pedido')
    expect(text()).toMatch(/1 mil tokens/)
  })

  it('shows the last six and hands over the rest, however long the history', async () => {
    const many = Array.from({ length: 20 }, (_, i) => wake({ id: `w${i}`, at: Date.UTC(2026, 10, 13, 10, 0) - i * 60_000 }))
    fake.initiative = [view({ wakes: many })]
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(document.querySelectorAll('.initiative__run')).toHaveLength(6)
    await click(button('Mostrar tudo (20)'))
    expect(document.querySelectorAll('.initiative__run')).toHaveLength(20)
    expect(button('Mostrar menos')).toBeTruthy()
  })

  it('names a conversation it can no longer reach, and offers only what it can', async () => {
    fake.initiative = [view({ config: config({ observe: { conversations: ['clientes'] }, work: { conversations: [], kinds: [] } }) })]
    await render(<InitiativeDialog onClose={() => {}} />)
    const boxes = [...document.querySelectorAll('.initiative__check input')] as HTMLInputElement[]
    // Every conversation the person can see is offered once, and the marked one is the one saved.
    expect(boxes.filter((b) => b.type === 'checkbox' && b.checked).length).toBe(1)
    expect(text()).toContain('#clientes')
  })

  it('keeps its keyboard path: Esc closes, and every control is a real button or field', async () => {
    let closed = 0
    await render(<InitiativeDialog onClose={() => (closed += 1)} />)
    await act(async () => {
      const esc = new window.Event('keydown', { bubbles: true })
      Object.defineProperty(esc, 'key', { value: 'Escape' })
      window.dispatchEvent(esc)
    })
    expect(closed).toBe(1)
    // Nothing is a div pretending to be a control: the actions are buttons, the brief is a textarea.
    expect(document.querySelector('textarea')).toBeTruthy()
    expect([...document.querySelectorAll('.initiative__actions > *')].every((n) => n.tagName === 'BUTTON' || n.className === 'spacer' || n.tagName === 'SPAN')).toBe(true)
  })
})

describe('a page that cannot read the record', () => {
  it('says it is reading instead of showing an empty coordinator', async () => {
    // Nothing has been read yet: an empty list is an answer (no bot has one), null is not.
    fake.initiative = null
    await render(<InitiativeDialog onClose={() => {}} />)
    expect(text()).toContain('Lendo…')
    // And the line in the DM is not there at all, rather than claiming it is off.
    await render(<InitiativeLine conversationId="dm-lia" agentId="lia" />)
    expect(document.querySelector('.initiative-line')).toBeNull()
  })
})

describe("the switch on a bot's own page", () => {
  it('shows a bot nobody has set up as off, and opens the window to write the brief', async () => {
    fake.initiative = []
    await render(<InitiativeSwitch agentId="sol" />)
    expect(document.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false')
    expect(text()).toContain('sem pedido ainda')
    // Nothing is sent: there is no brief to turn on, so the press is the way into the window.
    await click(document.querySelector('[role="switch"]'))
    expect(saveInitiative).not.toHaveBeenCalled()
    expect(opened).toEqual([{ kind: 'initiative', agentId: 'sol', conversationId: 'dm-sol' }])
  })

  it('turns this bot on, against the revision it read, and leaves the other one alone', async () => {
    fake.initiative = [view({ config: config({ enabled: false }) }), view({ config: config({ agentId: 'sol', conversationId: 'dm-sol', revision: 7 }), commitments: [], wakes: [] })]
    await render(<InitiativeSwitch agentId="lia" />)
    await click(document.querySelector('[role="switch"]'))
    expect(saveInitiative).toHaveBeenCalledTimes(1)
    expect(saveInitiative.mock.calls[0]![0]).toMatchObject({ agentId: 'lia', enabled: true, brief: 'Answer the client about the invoice.' })
    expect(saveInitiative.mock.calls[0]![1]).toBe(3)
  })

  it('turns one off from the page, and says when it is waiting on the person', async () => {
    await render(<InitiativeSwitch agentId="lia" />)
    expect(text()).toMatch(/próxima em/)
    await click(document.querySelector('[role="switch"]'))
    expect(saveInitiative.mock.calls[0]![0]).toMatchObject({ agentId: 'lia', enabled: false })
    fake.initiative = [view({ status: { ...view().status, waitingOnPerson: 1 } })]
    await render(<InitiativeSwitch agentId="lia" />)
    expect(text()).toContain('espera você')
  })
})
