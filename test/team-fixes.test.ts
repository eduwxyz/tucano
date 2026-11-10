// Tucano Team v1: what an end-to-end run found. Decisions reach the others at once, a member's
// read-only pages ask only for what they may read, the browser says what each person is looking
// at, agents without an owner are the Tucano owner's, and the words a person reads are plain.
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { setLang } from '../src/shared/lang'
import type { CoreEvent, Method } from '../src/shared/rpc'
import type { Agent, Approval, EngineId, Person, Settings } from '../src/shared/types'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { deciders, People } from '../src/core/people'
import { admit, admitComputer, NEEDS } from '../src/core/policy-people'
import { Runner } from '../src/core/runs'
import { Viewers } from '../src/server/people'

const dir = (): string => mkdtempSync(join(tmpdir(), 'tucano-fixes-'))
const agent = (id: string, handle: string, extra: Partial<Agent> = {}): Agent => ({ id, name: handle[0]!.toUpperCase() + handle.slice(1), handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const approval = (id: string, conversationId: string, requestedBy: string, agentId = 'a1'): Approval => ({ id, hash: id, agentId, conversationId, messageId: 'x', connectorId: 'c', connectorName: 'GitLab', tool: 'create_merge_request', args: {}, why: '', highRisk: false, state: 'pending', createdAt: 1, expiresAt: Date.now() + 60_000, requestedBy })
const ready = { installed: true, loggedIn: true }
const settings: Settings = { workspaceName: 'Ana', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'auto', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt' }
const engines = (): Record<EngineId, Engine> => ({ claude: fakeEngine('claude', { delayMs: 1 }), codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes') })

// Ana (owner), Bia (member), Dani (admin).
function team(file = ':memory:'): { db: Db; people: People; ana: Person; bia: Person; dani: Person } {
  const db = new Db(file)
  db.renamePerson(db.ownerId(), 'Ana')
  const people = new People(db)
  const ana = db.owner()
  const join1 = (name: string, role: 'member' | 'admin'): Person => {
    const r = people.join(people.createInvite(ana, { role }).code, name)
    if (!('person' in r)) throw new Error(r.error)
    return r.person
  }
  return { db, people, ana, bia: join1('Bia', 'member'), dani: join1('Dani', 'admin') }
}

afterEach(() => setLang('pt'))

describe('an approval decided', () => {
  it('reaches everyone as decided (and by whom) before the call it allowed comes back', async () => {
    const { db, bia, dani } = team()
    db.saveConnector({ id: 'c', name: 'GitLab', kind: 'remote', url: 'https://x', auth: 'none' })
    db.syncTools('c', [{ name: 'create_merge_request', description: '', inputSchema: {}, cls: 'sensitive' }])
    db.saveAgent({ ...agent('a1', 'lia', { grants: { c: 'read_write' } }), owner: bia.id })
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    db.saveMessage({ id: 'x', conversationId: 'ch', author: { kind: 'agent', id: 'a1' }, text: 'pedi', at: 1, run: { status: 'waiting_approval', steps: [] } })
    db.createApproval(approval('p1', 'ch', bia.id))
    let finish: () => void = () => {}
    const slow = new Promise<{ content: { type: 'text'; text: string }[] }>((resolve) => (finish = () => resolve({ content: [{ type: 'text', text: 'ok' }] })))
    const events: CoreEvent[] = []
    const connectors = { list: () => db.connectors().map((c) => ({ ...c, status: 'connected' as const })), call: () => slow }
    const runner = new Runner({ db, engines: engines(), settings: async () => settings, emit: (e) => events.push(e), workDir: dir(), connectors })
    const deciding = runner.decide('p1', 'approved', undefined, false, dani.id)
    await new Promise((r) => setTimeout(r, 20))
    const told = events.flatMap((e) => (e.type === 'approval' ? [e.approval] : []))
    expect(told[0]).toMatchObject({ id: 'p1', state: 'approved', decidedBy: dani.id })
    expect(told[0]?.outcome).toBeUndefined()
    finish()
    await deciding
    await runner.idle()
    expect(events.flatMap((e) => (e.type === 'approval' ? [e.approval] : [])).at(-1)).toMatchObject({ state: 'approved', decidedBy: dani.id, outcome: 'Executou.' })
  })
})

describe("a member's read-only pages", () => {
  const { bia, dani } = team()

  it('may read the status a page shows on opening; changing it stays the admins', () => {
    for (const m of ['desktopStatus', 'installedApps', 'openApps', 'engineModels', 'computerAction'] as Method[]) expect(() => admit(bia, m), m).not.toThrow()
    expect(() => admitComputer(bia, 'refresh')).not.toThrow()
    for (const a of ['start', 'restart', 'erase', 'open_folder'] as const) {
      expect(() => admitComputer(bia, a), a).toThrow('Só um admin pode fazer isso.')
      expect(() => admitComputer(dani, a), a).not.toThrow()
    }
  })

  // What a page asks for as it opens (a useEffect), read off the renderer's source: none of it may
  // be admin-only unless the effect itself checks that the viewer is an admin, or the screen is one
  // only admins reach (listed, with why).
  it('never ask on opening for what only an admin may read', () => {
    const root = join(import.meta.dirname, '..', 'src', 'renderer', 'src')
    const store = readFileSync(join(root, 'store.ts'), 'utf8')
    const gated = (Object.keys(NEEDS) as Method[]).filter((m) => NEEDS[m] === 'admin' || NEEDS[m] === 'owner')
    // Each store helper and the admin-only methods it calls.
    const helpers = new Map<string, string>()
    for (const block of store.split(/\n(?=export )/)) {
      const name = /^export (?:const|function|async function) (\w+)/.exec(block)?.[1]
      const method = name && gated.find((m) => block.includes(`'${m}'`))
      if (name && method) helpers.set(name, method)
    }
    expect(helpers.get('loadReport')).toBe('report')
    // Screens only an admin reaches: the connectors' admin view, the introduction (the owner's; someone
    // invited gets GuestWelcome) and the agent builder (admins'), the activity log, adding a skill from
    // the terminal, a skill's history, the skills-folders card (Settings' Agents tab is the admins'),
    // and a harness's sign-in on the server's terminal (opened by an admin's Sign in).
    const ADMIN_SCREENS = new Set(['LoginTerminal.tsx:loginScreen', 'LoginTerminal.tsx:refreshEngines', 'ConnectorStore.tsx:ownApp', 'Harness.tsx:harnessMcps', 'Intro.tsx:testEngine', 'Intro.tsx:refreshEngines', 'Intro.tsx:harnessMcps', 'Intro.tsx:localSkills', 'People.tsx:activity', 'People.tsx:removedPeople', 'Skills.tsx:localSkills', 'Skills.tsx:skillVersions', 'Pages.tsx:skillFolders'])
    const found: string[] = []
    for (const file of readdirSync(join(root, 'components')).filter((f) => f.endsWith('.tsx'))) {
      const src = readFileSync(join(root, 'components', file), 'utf8')
      for (let i = src.indexOf('useEffect('); i >= 0; i = src.indexOf('useEffect(', i + 1)) {
        let depth = 0
        let j = i + 'useEffect'.length
        for (; j < src.length; j++) if (src[j] === '(') depth++; else if (src[j] === ')' && --depth === 0) break
        let body = src.slice(i, j + 1)
        // An effect that runs a function of the component (`useEffect(check, [])`, `() => load()`): its body too.
        for (const f of body.matchAll(/\b(\w+)(?:\(\)|\s*,\s*\[)/g)) body += new RegExp(`(?:const|function) ${f[1]}\\b[^\\n]*(?:\\n(?!  (?:const|function|useEffect))[^\\n]*){0,8}`).exec(src)?.[0] ?? ''
        if (/\b(admin|owner)\b/.test(body)) continue // gated: only an admin (or the owner) runs it
        for (const [helper, method] of helpers) if (new RegExp(`\\b${helper}\\(`).test(body) && !ADMIN_SCREENS.has(`${file}:${method}`)) found.push(`${file}:${src.slice(0, i).split('\n').length} ${method}`)
      }
    }
    expect(found).toEqual([])
  })
})

describe('what each person is looking at, from the browser', () => {
  it("is the person's latest page; closing one falls back to another of theirs, or to nothing", () => {
    const v = new Viewers()
    expect(v.set('s1', 'bia', 'c1')).toBe('c1')
    expect(v.set('s2', 'bia', 'c2')).toBe('c2')
    expect(v.set('s3', '', 'c9')).toBe('c9') // the owner's token
    expect(v.drop('s2')).toEqual({ person: 'bia', conversation: 'c1' })
    expect(v.drop('s1')).toEqual({ person: 'bia', conversation: null })
    expect(v.drop('s1')).toBeUndefined()
    expect(v.set('s3', '', null)).toBeNull()
  })

  it('is told by the bridge, which no longer drops it', () => {
    const server = readFileSync(join(import.meta.dirname, '..', 'src', 'server', 'index.ts'), 'utf8')
    expect(server).not.toMatch(/viewing: \(\) => \{\}/)
    expect(server).toMatch(/'\/viewing'/)
  })
})

describe('an agent with no owner (made by another tool)', () => {
  it("is the Tucano owner's: its approvals go to them and to whoever covers for them", () => {
    const file = join(dir(), 'tucano.db')
    const { db, people, ana, bia, dani } = team(file)
    db.saveAgent(agent('a1', 'lia'))
    const other = new DatabaseSync(file)
    other.exec('UPDATE agents SET owner = NULL')
    other.close()
    expect(db.agent('a1')?.owner).toBe(ana.id)
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
    const a = approval('p1', 'ch', dani.id)
    db.createApproval(a)
    expect(people.canDecide(bia, a)).toBe(false)
    people.setDelegation(ana, bia.id, Date.now() + 3_600_000)
    expect(deciders(db, 'a1')).toContain(bia.id)
    expect(people.canDecide(bia, a)).toBe(true)
    expect(people.inbox(bia).approvals.map((x) => x.id)).toEqual(['p1'])
  })
})

describe('the words a person reads', () => {
  it("someone else's DM says so, without saying more", () => {
    const { db, people, ana, bia } = team()
    db.saveAgent(agent('a1', 'lia'))
    db.createConversation({ id: 'ana-dm', kind: 'dm', name: 'a1', members: ['a1'], owner: ana.id })
    expect(people.conversationError(bia, 'ana-dm')).toBe('Essa conversa é de outra pessoa.')
    expect(people.conversationError(bia, 'gone')).toBe('Essa conversa não existe mais.')
    expect(people.conversationError(ana, 'ana-dm')).toBeUndefined()
    setLang('en')
    expect(people.conversationError(bia, 'ana-dm')).toBe('That conversation belongs to someone else.')
  })
})
