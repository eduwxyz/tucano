// What the real core keeps of an agent's bosses, over its API as the app's screens send it: the one it
// answers to first and the ones it also answers to (src/shared/org.ts bossesOf), and nothing that would
// put it in a circle.
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Conversation } from '../src/shared/types'
import { bossesOf } from '../src/shared/org'
import { bootCore, type Client, type TestCore } from './helpers/core'

vi.setConfig({ testTimeout: process.platform === 'win32' ? 60_000 : 30_000 })

let core: TestCore
let ana: Client
type Snap = { agents: Agent[]; conversations: Conversation[] }
const agents = async (): Promise<Agent[]> => (await ana.call<Snap>('snapshot')).agents
const one = async (handle: string): Promise<Agent> => (await agents()).find((a) => a.handle === handle)!
// What the page sends: the whole agent with the patch over it (store.ts patchAgent).
const save = async (handle: string, patch: Partial<Agent>): Promise<void> => {
  await ana.call('saveAgent', { agent: { ...(await one(handle)), ...patch }, channelIds: [] })
}
let lia = ''
let theo = ''
let nina = ''

beforeAll(async () => {
  core = await bootCore()
  ana = core.connect()
  lia = (await one('lia')).id
  theo = (await one('theo')).id
  nina = (await one('nina')).id
}, 30_000)
afterAll(() => {
  try {
    rmSync(core.dataDir, { recursive: true, force: true })
  } catch {
    // Windows: still open
  }
})

describe('the bosses an agent answers to, saved from its page', () => {
  it('keeps a second and a third, and gives them back', async () => {
    await save('theo', { reportsTo: undefined, alsoTo: undefined })
    await save('nina', { reportsTo: undefined, alsoTo: undefined })
    await save('lia', { reportsTo: theo, alsoTo: [nina] })
    expect((await one('lia')).reportsTo).toBe(theo)
    expect((await one('lia')).alsoTo).toEqual([nina])
    // Both of them have it on its team; the first is the one it hangs under.
    const all = await agents()
    expect(bossesOf(all, all.find((a) => a.id === lia)!).map((a) => a.handle)).toEqual(['theo', 'nina'])
  })

  it('drops a boss that is itself, its own primary one, or the same one twice', async () => {
    await save('lia', { alsoTo: [lia, lia, theo, nina] })
    expect((await one('lia')).alsoTo).toEqual([nina])
  })

  it('refuses a boss that sits below it, and keeps one it already had', async () => {
    await save('lia', { alsoTo: undefined })
    await save('nina', { reportsTo: lia }) // now below it: a link back up would be a circle
    await save('lia', { alsoTo: [nina] })
    expect((await one('lia')).alsoTo).toBeUndefined()
    // A link it already had stays as it was, even once the tree moved under it (a save from an older page).
    await save('nina', { reportsTo: undefined })
    await save('lia', { alsoTo: [nina] })
    expect((await one('lia')).alsoTo).toEqual([nina])
    await save('nina', { reportsTo: lia })
    await save('lia', { name: (await one('lia')).name })
    expect((await one('lia')).alsoTo).toEqual([nina])
  })
})
