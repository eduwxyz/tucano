// One agent answering to more than one boss (src/shared/org.ts bossesOf): a specialist that several
// teams share. Three campaigns, each with its bot, and one artist the three of them ask.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CoreEvent } from '../src/shared/rpc'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { teamSection } from '../src/core/delegations'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { exportTeam, importTeam } from '../src/core/team'
import { bossesOf, directReports, reachOf } from '../src/shared/org'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id, handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

function counted(engine: Engine): Engine & { turns: Turn[] } {
  const turns: Turn[] = []
  return { id: engine.id, turns, run: (t) => (turns.push(t), engine.run(t)) }
}

let db: Db
let events: CoreEvent[]
let settings: Settings
let gateway: Gateway
let claude: ReturnType<typeof counted>
let codex: ReturnType<typeof counted>

function runner(): Runner {
  claude = counted(fakeEngine('claude', { delayMs: 1 }))
  codex = counted(fakeEngine('codex', { delayMs: 1 }))
  const engines: Record<EngineId, Engine> = { claude, codex, opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') }
  return new Runner({ db, engines, settings: async () => settings, emit: (e) => events.push(e), workDir: mkdtempSync(join(tmpdir(), 'sb-work-')), gateway })
}

const by = (id: string, conversationId?: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id && (!conversationId || m.conversationId === conversationId))
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error('never happened')
    await new Promise((r) => setTimeout(r, 10))
  }
}

// The artist answers to campaign-a (its own line) and, also, to campaign-b and campaign-c.
beforeEach(async () => {
  db = new Db(join(mkdtempSync(join(tmpdir(), 'sb-db-')), 'test.db'))
  events = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
  db.saveAgent(agent('campaign-a', { role: 'Campanha A' }))
  db.saveAgent(agent('campaign-b', { role: 'Campanha B' }))
  db.saveAgent(agent('campaign-c', { role: 'Campanha C' }))
  db.saveAgent(agent('artist', { reportsTo: 'campaign-a', alsoTo: ['campaign-b', 'campaign-c'] }))
  db.createConversation({ id: 'dm-a', kind: 'dm', name: 'campaign-a', members: ['campaign-a'] })
  db.createConversation({ id: 'dm-b', kind: 'dm', name: 'campaign-b', members: ['campaign-b'] })
  db.createConversation({ id: 'art', kind: 'channel', name: 'arte', topic: 'Imagens das três campanhas', members: ['artist'] })
  gateway = new Gateway()
  await gateway.start()
  return () => gateway.stop()
})

describe('one agent, more than one boss', () => {
  it('keeps the other bosses it answers to, in the database and in a team file', () => {
    expect(db.agent('artist')?.alsoTo).toEqual(['campaign-b', 'campaign-c'])
    expect(db.agent('artist')?.reportsTo).toBe('campaign-a')
    // A save that sends none clears them, as the primary one does.
    db.saveAgent({ ...db.agent('artist')!, alsoTo: ['campaign-c'] })
    expect(db.agent('artist')?.alsoTo).toEqual(['campaign-c'])
    db.saveAgent({ ...db.agent('artist')!, alsoTo: ['campaign-b', 'campaign-c'] })

    const other = new Db(join(mkdtempSync(join(tmpdir(), 'sb-db-')), 'other.db'))
    importTeam(other, exportTeam(db), 1000)
    const id = (handle: string): string | undefined => other.agents().find((a) => a.handle === handle)?.id
    const there = other.agents().find((a) => a.handle === 'artist')!
    expect(there.reportsTo).toBe(id('campaign-a'))
    expect(there.alsoTo).toEqual([id('campaign-b'), id('campaign-c')])
  })

  it('reaches the shared agent from every boss, and every boss from it', () => {
    const agents = db.agents()
    expect(bossesOf(agents, agents.find((a) => a.id === 'artist')!).map((b) => b.id)).toEqual(['campaign-a', 'campaign-b', 'campaign-c'])
    for (const boss of ['campaign-a', 'campaign-b', 'campaign-c']) {
      expect(reachOf(agents, boss).map((a) => a.id)).toContain('artist')
      expect(directReports(agents, boss).map((a) => a.id)).toEqual(['artist'])
    }
  })

  it('shows every boss it answers to, and lists it in the team of each of them', () => {
    const agents = db.agents()
    const conversations = db.conversations()
    const section = teamSection({ agent: agents.find((a) => a.id === 'artist')!, agents, conversations, connectors: [], open: [], me: 'Edu' })!
    expect(section).toContain('## Seus chefes')
    for (const name of ['campaign-a', 'campaign-b', 'campaign-c']) expect(section).toContain(`@${name}`)
    // Each of them has it on its own team, and is told it may hand it work.
    for (const boss of ['campaign-a', 'campaign-b', 'campaign-c']) {
      const boss_ = teamSection({ agent: agents.find((a) => a.id === boss)!, agents, conversations, connectors: [], open: [], me: 'Edu' })!
      expect(boss_).toContain('## Seu time')
      expect(boss_).toContain('- @artist ')
    }
  })

  it('has a second boss hand it work, and gets the answer back where it asked', async () => {
    const r = runner()
    // Campaign B only shares the artist: it is not the artist's own line.
    await r.send('dm-b', 'delegue a artist: desenhe a capa da campanha b')
    await r.idle()

    const [root] = by('campaign-b', 'art')
    expect(root?.text).toBe('@artist, um pedido:\n\ndesenhe a capa da campanha b')
    const [answer] = by('artist', 'art')
    expect(answer).toMatchObject({ threadId: root!.id, run: { status: 'done' } })
    const d = db.delegationAt(root!.id)!
    expect(d).toMatchObject({ from: 'campaign-b', to: 'artist', state: 'done', told: true, originConversationId: 'dm-b', result: answer!.id })
    // Campaign B was told what came back, in its own DM.
    await until(() => by('campaign-b', 'dm-b').length >= 2)
    expect(by('campaign-b', 'dm-b').at(-1)?.text).toBe('Pronto: o time terminou o que pedi.')
    // And the request went out: the artist's own boss, campaign-a, never saw one.
    expect(db.openDelegations()).toEqual([])
    expect(by('campaign-a').length).toBe(0)
  })
})
