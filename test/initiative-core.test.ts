// A person's proactive coordinator over the real core's API: what a page gets on a workspace nobody
// set up, what a save needs, and what a save from a page left open is told. No review runs yet.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation } from '../src/shared/types'
import type { InitiativeInput, InitiativeView } from '../src/shared/initiative'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client // the owner
type Snap = { agents: Agent[]; conversations: Conversation[] }
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: Error) => e.message)

// A person can give several bots something to look after: this one's entry, out of their own list.
const mine = async (): Promise<InitiativeView | undefined> => (await ana.call<InitiativeView[]>('initiative')).find((v) => v.config?.agentId === bot)

let bot: string
let dm: string
let channel: string

beforeAll(async () => {
  core = await bootCore({ server: true })
  ana = core.connect()
  await ana.call('setMyName', { name: 'Ana' })
  const snap = await ana.call<Snap>('snapshot')
  bot = snap.agents[0]!.id
  dm = await ana.call<string>('openDm', { agentId: bot })
  channel = snap.conversations.find((c) => c.kind === 'channel')!.id
}, 30_000)
afterAll(() => {
  try {
    rmSync(core.dataDir, { recursive: true, force: true })
  } catch {} // Windows: still open
})

const config = (over: Partial<InitiativeInput> = {}): InitiativeInput => ({
  agentId: bot,
  conversationId: dm,
  enabled: true,
  brief: 'Watch the client thread, and answer what waits on me.',
  observe: { conversations: [channel] },
  work: { conversations: [channel], kinds: ['send'] },
  cadenceMinutes: 15,
  notify: 'material',
  dailyReviews: 24,
  dailyTokens: 2_000_000,
  timezone: 'Europe/Sofia',
  ...over
})

describe('over the API', () => {
  it('has nothing to show until someone asks for it', async () => {
    expect(await ana.call<InitiativeView[]>('initiative')).toEqual([])
    // "Conferir agora" with nothing set up says so instead of starting anything.
    expect(await ana.call('checkInNow', { agentId: bot })).toEqual({ started: false, why: 'off', running: false })
  })

  it('saves the brief against the revision the page read, and refuses an older one', async () => {
    const saved = await ana.call<{ revision: number; enabled: boolean }>('saveInitiative', { config: config(), expectedRevision: 0 })
    expect(saved).toMatchObject({ revision: 1, enabled: true })
    expect((await mine())!.config).toMatchObject({ brief: config().brief, revision: 1 })
    const second = await ana.call<{ revision: number }>('saveInitiative', { config: config({ cadenceMinutes: 30 }), expectedRevision: 1 })
    expect(second.revision).toBe(2)
    expect(await err(ana.call('saveInitiative', { config: config({ brief: 'other words' }), expectedRevision: 1 }))).toMatch(/Reload|Recarregue/)
    expect((await mine())!.config).toMatchObject({ brief: config().brief, cadenceMinutes: 30 })
  })

  it('tells a page what is missing instead of storing it', async () => {
    const revision = (await mine())!.config!.revision
    expect(await err(ana.call('saveInitiative', { config: config({ agentId: 'nope' }), expectedRevision: revision }))).toMatch(/no longer exists|não existe/)
    expect(await err(ana.call('saveInitiative', { config: config({ brief: '' }), expectedRevision: revision }))).toMatch(/Write what it should look after|Escreva/)
    expect(await err(ana.call('saveInitiative', { config: config({ cadenceMinutes: 1 }), expectedRevision: revision }))).toMatch(/interval|intervalo/)
    // Junk at the door reaches the shape check, and the core goes on.
    expect(await err(ana.call('saveInitiative', { config: {}, expectedRevision: revision }))).not.toBe('ok')
    expect(await err(ana.call('saveCommitment', { commitment: {} }))).not.toBe('ok')
    expect((await mine())!.config!.brief).toBe(config().brief)
  })

  it('turns off without losing what was written, and a review stops being allowed', async () => {
    const revision = (await mine())!.config!.revision
    const off = await ana.call<{ enabled: boolean; revision: number; brief: string }>('saveInitiative', { config: config({ enabled: false }), expectedRevision: revision })
    expect(off).toMatchObject({ enabled: false, revision: revision + 1, brief: config().brief })
    expect((await mine())!.config!.enabled).toBe(false)
  })

  it('keeps a responsibility with its provenance, and refuses one that points nowhere', async () => {
    const saved = await ana.call<{ id: string; state: string; conversationId: string }>('saveCommitment', {
      commitment: { agentId: bot, conversationId: dm, by: 'person', description: 'Answer the client about the invoice.', scope: { conversations: [channel], kinds: ['send'] } }
    })
    expect(saved).toMatchObject({ conversationId: dm, state: 'open' })
    expect((await mine())!.commitments.map((c) => c.id)).toContain(saved.id)
    expect(await err(ana.call('saveCommitment', { commitment: { agentId: bot, conversationId: dm, by: 'person', description: 'x', scope: { conversations: [channel], kinds: ['send'] }, links: [{ kind: 'approval', id: 'gone' }] } }))).toMatch(/no longer exists|não existe/)
    const done = await ana.call<{ state: string; closedAt?: number }>('saveCommitment', {
      commitment: { id: saved.id, agentId: bot, conversationId: dm, by: 'person', description: 'Answer the client about the invoice.', scope: { conversations: [channel], kinds: ['send'] }, state: 'done' }
    })
    expect(done.state).toBe('done')
    expect(done.closedAt).toBeGreaterThan(0)
  })
})
