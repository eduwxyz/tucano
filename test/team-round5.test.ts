// Tucano Team v1, fifth round: the pieces under the core (connectors each role reads, the wiki's
// held titles after a delete or a rename, a restore that would publish DM text, titles with
// invisible characters, names against agents, lookalike letters, backlinks past ASCII, the
// heritage's channel messages, two wordings).
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Db } from '../src/core/db'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine } from '../src/core/engines/types'
import { nameKey, People } from '../src/core/people'
import { routerSystem } from '../src/core/router'
import { Runner } from '../src/core/runs'
import { settingsPatchError } from '../src/core/settings-patch'
import { cleanTitle, pageKey, Wiki } from '../src/core/wiki'
import { parseCuration } from '../src/core/wiki-curator'
import type { CoreEvent } from '../src/shared/rpc'
import type { Connector, EngineId, Message, Person, Settings } from '../src/shared/types'

const roots: string[] = []
// Best effort: on Windows a database still open keeps its folder busy.
afterAll(() => roots.forEach((r) => { try { rmSync(r, { recursive: true, force: true }) } catch {} }))
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'tucano-r5-'))
  roots.push(d)
  return d
}
const agent = (id: string, name: string, handle: string, archived = false) => ({ id, name, handle, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived }) as const

function twoPeople(): { db: Db; people: People; ana: Person; bia: Person } {
  const db = new Db(join(tmp(), 'tucano.db'))
  db.saveAgent(agent('a1', 'Lia', 'lia'))
  db.renamePerson(db.ownerId(), 'Ana')
  db.addPerson({ id: 'bia', name: 'Bia', role: 'member', about: '' })
  db.addPerson({ id: 'carla', name: 'Carla', role: 'admin', about: '' })
  db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: ['a1'] })
  return { db, people: new People(db), ana: db.owner(), bia: db.person('bia')! }
}
const freshWiki = (deps: Partial<ConstructorParameters<typeof Wiki>[0]> = {}): Wiki => {
  const root = tmp()
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), ...deps })
  w.init(false)
  return w
}
const dmOf = (id: string): string | null | undefined => (id === 'dm' ? 'owner' : id === 'ch' ? null : undefined)
const ready = { installed: true, loggedIn: true }
const settingsOf = (over: Partial<Settings> = {}): Settings => ({ workspaceName: 'Ana', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready }, routerModel: 'haiku', memoryModel: 'haiku', memoryLearning: 'off', defaultLimit: 1000, approvalTtlHours: 24, theme: 'system', language: 'pt', ...over }) as unknown as Settings

describe('1. what each role reads of a connector', () => {
  const stdio: Connector = { id: 'c1', name: 'Jira', kind: 'stdio', command: 'npx', args: ['-y', 'jira-mcp', '--token', 'ghp_SECRETSECRETSECRET1234', '--org=acme', '--api-key=sk-live-ABCDEF0123456789'], envKeys: ['JIRA_TOKEN'], auth: 'none', status: 'connected', error: 'ECONNREFUSED /Users/ana/x', errorDetail: 'fetch failed ← Bearer ghp_SECRETsecret0123456789abcdefABCDEF0123 refused', tools: [{ name: 'issues', description: 'd', cls: 'read', enabled: true, highRisk: false, isNew: false }] }
  const remote: Connector = { id: 'c2', name: 'Notion', kind: 'remote', url: 'https://mcp.example.com/sse?key=abcdef123456&team=acme', auth: 'token', status: 'needs_auth', tools: [] }

  it('a member gets the name, kind, status and tools and nothing else', () => {
    const { people, bia } = twoPeople()
    const c = people.connectorFor(bia, stdio)
    expect(c).toEqual({ id: 'c1', name: 'Jira', kind: 'stdio', auth: 'none', status: 'connected', tools: stdio.tools })
    expect(people.connectorFor(bia, remote)).not.toHaveProperty('url')
  })

  it('an admin gets the command and the address with the secrets masked; the owner, everything', () => {
    const { db, people, ana } = twoPeople()
    const carla = db.person('carla')!
    const c = people.connectorFor(carla, stdio)
    expect(c.command).toBe('npx')
    expect(c.args!.join(' ')).toMatch(/--token \*+/)
    expect(c.args!.join(' ')).toMatch(/--api-key=\*+/)
    expect(c.args!.join(' ')).not.toMatch(/SECRET|sk-live/)
    expect(c.args!.join(' ')).toContain('--org=acme')
    expect(c.envKeys).toEqual(['JIRA_TOKEN'])
    expect(c.errorDetail).toContain('fetch failed')
    expect(c.errorDetail).not.toContain('SECRET')
    const r = people.connectorFor(carla, remote)
    expect(r.url).toMatch(/^https:\/\/mcp\.example\.com\/sse\?key=\*+&team=\*+$/)
    expect(people.connectorFor(ana, stdio)).toEqual(stdio)
    expect(people.connectorFor(ana, remote)).toEqual(remote)
  })

  it('the snapshot and the connector event go through the same door', () => {
    const { people, bia } = twoPeople()
    const ev = people.eventFor({ type: 'connector', connector: stdio }, bia) as Extract<CoreEvent, { type: 'connector' }>
    expect(ev.connector).not.toHaveProperty('command')
    const snap = people.snapshotFor(bia, { settings: settingsOf(), agents: [], messages: [], connectors: [stdio, remote], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac', packaged: false, isolatedComputers: false })
    expect(JSON.stringify(snap.connectors)).not.toMatch(/SECRET|key=abcdef|npx/)
  })
})

describe('2. a held title stays out of the log once the page is gone or renamed', () => {
  it('the log a member reads never names a page that was ever held, unless released', () => {
    const w = freshWiki({ dmOf })
    const fromDm = w.addSource({ title: 'dm', text: 'x', kind: 'conversation', origin: { conversationId: 'dm' }, by: 'auto' })
    w.save({ title: 'Viagem Lisboa', body: 'x', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.save({ title: 'Rotak Entrega', body: 'x', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.save({ title: 'Salário Ana', body: 'x', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.save({ title: 'Cardápio', body: 'Sexta tem peixe.', by: 'owner', byName: 'Ana' })
    w.inherit('owner')
    w.remove('Viagem Lisboa', 'owner', 'Ana')
    w.save({ title: 'Rota nova', rename: 'Rotak Entrega', body: 'x', by: 'owner', byName: 'Ana' })
    w.release('Salário Ana')
    w.save({ title: 'Salário Ana', body: 'liberado', by: 'owner', byName: 'Ana' })
    w.save({ title: 'Cardápio', body: 'Sexta tem peixe. Sábado, feijoada.', by: 'owner', byName: 'Ana' })
    const bia = w.view(w.heldTitles('bia'), { viewer: 'bia', afterSwitch: true, everHidden: w.everHeld('bia') })
    const log = bia.log(50).join('\n')
    expect(log).not.toMatch(/Viagem|Rotak|Rota nova/)
    expect(log).toContain('Cardápio')
    expect(log).toContain('Salário Ana') // released: the team's now, its log lines too
    // the owner reads all of it
    expect(w.view(w.heldTitles('owner'), {}).log(50).join('\n')).toMatch(/Viagem/)
  })
})

describe('3. restoring a DM-origin version onto a public page', () => {
  it('holds the page again instead of publishing the text, and says so', () => {
    const w = freshWiki({ dmOf })
    const fromDm = w.addSource({ title: 'dm', text: 'x', kind: 'conversation', origin: { conversationId: 'dm' }, by: 'auto' })
    w.save({ title: 'Viagem', body: 'SEGREDO da DM.', by: 'auto', byName: 'Curador', sourceId: fromDm.id })
    w.inherit('owner')
    const old = w.history('Viagem').find((v) => v.action === 'create')!
    w.remove('Viagem', 'owner', 'Ana') // the name is free: Bia makes her own
    w.save({ title: 'Viagem', body: 'do time', by: 'bia', byName: 'Bia' })
    expect(w.heldTitles('bia').has(pageKey('Viagem'))).toBe(false)
    const restored = w.restore(old.id, 'owner', 'Ana')
    expect(restored.body).toContain('SEGREDO')
    expect(restored.reheld).toBe(true)
    expect(w.heldTitles('bia').has(pageKey('Viagem'))).toBe(true)
    expect(w.view(w.heldTitles('bia'), { viewer: 'bia' }).page('Viagem')).toBeUndefined()
    // restoring a hand-written version of a public page holds nothing
    const w2 = freshWiki({ dmOf })
    w2.save({ title: 'Nota', body: 'v1', by: 'owner', byName: 'Ana' })
    w2.save({ title: 'Nota', body: 'v2', by: 'owner', byName: 'Ana' })
    w2.inherit('owner')
    const v1 = w2.history('Nota').find((v) => v.action === 'create')!
    expect(w2.restore(v1.id, 'owner', 'Ana').reheld).toBeUndefined()
    expect(w2.held()).toEqual([])
  })
})

describe('4. one cleaning for every title', () => {
  it('drops controls, bidi and zero-width characters, refuses what is left empty, keeps ordinary titles', () => {
    expect(cleanTitle('Pla​no\u0007 ‮A­')).toBe('Plano A')
    expect(cleanTitle('  Plano   A/B  ')).toBe('Plano A/B')
    expect(cleanTitle('​‎\u0000')).toBe('')
    expect(cleanTitle('Ação'.normalize('NFD'))).toBe('Ação')
    expect(pageKey('Pla​no')).toBe(pageKey('Plano'))
    const w = freshWiki()
    expect(w.save({ title: 'Pla​no\u0007', body: 'x', by: 'owner', byName: 'Ana' }).title).toBe('Plano')
    expect(() => w.save({ title: '​‎', body: 'x', by: 'owner', byName: 'Ana' })).toThrow(/título|title/)
    expect(w.save({ title: 'Plano', body: 'y', rename: 'Pla​no', by: 'owner', byName: 'Ana' }).title).toBe('Plano')
    expect(w.addSource({ title: 'No​ta\u0001', text: 'x', kind: 'note', by: 'owner' }).title).toBe('Nota')
    const parsed = parseCuration(JSON.stringify({ worth: true, reason: 'r', source_title: 'Fon​te', changes: [{ op: 'create', page: 'Pá​gina\u0007', text: 'x' }] }))!
    expect(parsed.ops[0]!.page).toBe('Página')
    expect(parsed.title).toBe('Fonte')
  })
})

describe('4b. a removed page goes by its clean title', () => {
  it('wikiRemove with a control character keeps none in the history or registro.md', () => {
    const w = freshWiki()
    w.save({ title: 'Plano', body: 'x', by: 'owner', byName: 'Ana' })
    w.remove('Pla\u0007no\u200b', 'owner', 'Ana')
    expect(w.page('Plano')).toBeUndefined()
    const removed = w.history('Plano').find((v) => v.action === 'delete')!
    expect(removed.title).toBe('Plano')
    const log = readFileSync(join(w.dir, 'registro.md'), 'utf8')
    expect(log).toMatch(/apagou Plano|deleted Plano/)
    expect(log).not.toMatch(/[\u0007\u200b]/)
  })
})

describe('5. names against agents', () => {
  it('"Lia." and "@lia" are the agent Lia; an agent may not take a person’s name or handle, and a handle is one agent’s', () => {
    const { db, people } = twoPeople()
    expect(people.nameTaken('Lia.')).toBe(true)
    expect(people.nameTaken('@lia')).toBe(true)
    expect(people.nameTaken('Bia-Teste', 'x')).toBe(false)
    db.addPerson({ id: 'bt', name: 'Bia Teste Silva', role: 'member', about: '' })
    expect(people.nameTaken('Bia-Teste Silva')).toBe(true)
    expect(people.agentNameError({ name: 'Carla', handle: 'carlinha' })).toMatch(/pessoa|person/)
    expect(people.agentNameError({ name: 'Ajudante', handle: 'bia' })).toMatch(/pessoa|person/)
    expect(people.agentNameError({ name: 'Ajudante', handle: 'ajud' })).toBeUndefined()
    db.saveAgent(agent('a2', 'Velho', 'velho', true))
    expect(people.agentNameError({ name: 'Novo', handle: 'velho' })).toMatch(/@velho/) // archived agents keep their handle
    expect(people.agentNameError({ name: 'Novo', handle: 'velho' })).not.toMatch(/Algo deu errado/)
    expect(people.agentNameError({ id: 'a2', name: 'Velho', handle: 'velho' })).toBeUndefined() // itself
    // someone removed who may come back keeps their name
    db.removePerson('carla')
    expect(people.agentNameError({ name: 'Carla', handle: 'c' })).toMatch(/pessoa|person/)
  })
  it('alone, the owner may be a Nina next to the agent Nina', () => {
    const db = new Db(join(tmp(), 'tucano.db'))
    db.renamePerson(db.ownerId(), 'Nina')
    expect(new People(db).agentNameError({ name: 'Nina', handle: 'nina' })).toBeUndefined()
  })
})

describe('6. lookalike letters', () => {
  it('small capitals, mathematical and enclosed letters read as the plain ones', () => {
    expect(nameKey('Ana Tesᴛe')).toBe(nameKey('Ana Teste'))
    expect(nameKey('ᴀɴᴀ ᴛᴇꜱᴛᴇ')).toBe(nameKey('Ana Teste'))
    expect(nameKey('𝐀𝐧𝐚 𝑇𝑒𝑠𝑡𝑒')).toBe(nameKey('Ana Teste'))
    expect(nameKey('Ⓐⓝⓐ Ⓣⓔⓢⓣⓔ')).toBe(nameKey('Ana Teste'))
    expect(nameKey('Ａｎａ Ｔｅｓｔｅ')).toBe(nameKey('Ana Teste'))
    expect(nameKey('Ana Teste')).not.toBe(nameKey('Ana Testa'))
  })
})

describe('7. backlinks past ASCII', () => {
  it('a link to a title with a capital accented letter is found, in the page and the map', () => {
    const w = freshWiki()
    w.save({ title: 'Ínsula', body: 'Uma ilha.', by: 'owner', byName: 'Ana' })
    w.save({ title: 'Mapa', body: 'Veja [[ÍNSULA]] e [[Ínsula]] e [[Ação]].', by: 'owner', byName: 'Ana' })
    w.save({ title: 'AÇÃO', body: 'Fazer.', by: 'owner', byName: 'Ana' })
    expect(w.page('Ínsula')!.backlinks).toEqual(['Mapa'])
    expect(w.page('AÇÃO')!.backlinks).toEqual(['Mapa'])
    expect(w.page('Mapa')!.missing).toEqual([])
    const g = w.graph()
    expect(g.nodes.filter((n) => n.missing)).toEqual([])
    expect(g.edges.map((e) => e.join('→')).sort()).toEqual(['Mapa→AÇÃO', 'Mapa→Ínsula'].sort())
  })
})

describe('8. channel messages from before the heritage are the owner’s', () => {
  const at0 = 1_000_000
  function withHistory(): { db: Db; people: People; ana: Person; bia: Person } {
    const t = twoPeople()
    const { db } = t
    for (let i = 0; i < 3; i++) db.saveMessage({ id: `old-${i}`, conversationId: 'ch', author: { kind: 'person', id: db.ownerId() }, text: `ANTIGA ${i} segredo da fase solo`, at: at0 + i })
    db.saveMessage({ id: 'old-reply', conversationId: 'ch', author: { kind: 'agent', id: 'a1' }, text: 'ANTIGA resposta', at: at0 + 3, run: { status: 'done', steps: [] } })
    db.setMeta('heritageAt', String(at0 + 100))
    db.saveMessage({ id: 'new-0', conversationId: 'ch', author: { kind: 'person', id: 'bia' }, text: 'NOVA da Bia', at: at0 + 200 })
    return t
  }
  const base = { settings: settingsOf(), agents: [], connectors: [], approvals: [], memories: [], artifacts: [], computers: [], browsers: [], routines: [], skills: [], platform: 'mac' as const, packaged: false, isolatedComputers: false }

  it('a member’s snapshot has none of them and one boundary line; the owner’s has them all and no line', () => {
    const { db, people, ana, bia } = withHistory()
    const theirs = people.snapshotFor(bia, { ...base, messages: db.messages() })
    const texts = theirs.messages.map((m) => m.text)
    expect(texts.join('\n')).not.toMatch(/ANTIGA/)
    expect(texts).toContain('NOVA da Bia')
    const lines = theirs.messages.filter((m) => m.author.kind === 'system')
    expect(lines.length).toBe(1)
    expect(lines[0]!.text).toMatch(/Histórico anterior visível só pro dono|Earlier history/)
    expect(lines[0]!.conversationId).toBe('ch')
    const owners = people.snapshotFor(ana, { ...base, messages: db.messages() })
    expect(owners.messages.map((m) => m.text).join('\n')).toMatch(/ANTIGA 0[\s\S]*ANTIGA resposta/)
    expect(owners.messages.some((m) => m.author.kind === 'system')).toBe(false)
    // an event about an old message (a reply's run changing) isn't the member's either
    const old = db.message('old-reply')!
    expect(people.eventFor({ type: 'message', message: old }, bia)).toBeUndefined()
    expect(people.eventFor({ type: 'message', message: old }, ana)).toBeDefined()
    expect(people.eventFor({ type: 'message', message: db.message('new-0')! }, bia)).toBeDefined()
  })

  it('alone (no heritage), every message is there and no line is drawn', () => {
    const db = new Db(join(tmp(), 'tucano.db'))
    db.createConversation({ id: 'ch', kind: 'channel', name: 'geral', members: [] })
    db.saveMessage({ id: 'm', conversationId: 'ch', author: { kind: 'person', id: db.ownerId() }, text: 'oi', at: 1 })
    const snap = new People(db).snapshotFor(db.owner(), { ...base, messages: db.messages() })
    expect(snap.messages.map((m) => m.text)).toEqual(['oi'])
  })

  it('an agent answering a member in the channel reads none of them; answering the owner, all', async () => {
    const { db } = withHistory()
    const prompts: { prompt: string; who: string }[] = []
    let who = ''
    const claude: Engine = fakeEngine('claude', { delayMs: 1, reply: (t) => (prompts.push({ prompt: t.prompt ?? '', who }), 'ok') })
    const r = new Runner({ db, engines: { claude, codex: claude, opencode: claude, pi: claude, antigravity: claude, cursor: claude, grok: claude, cline: claude, hermes: claude } as Record<EngineId, Engine>, settings: async () => settingsOf(), emit: () => {}, workDir: tmp() })
    who = 'bia'
    await r.send('ch', '@lia me resume o que foi dito', undefined, undefined, 'bia')
    await r.idle()
    who = 'ana'
    await r.send('ch', '@lia me resume o que foi dito', undefined, undefined, db.ownerId())
    await r.idle()
    const forBia = prompts.filter((p) => p.who === 'bia').map((p) => p.prompt).join('\n')
    const forAna = prompts.filter((p) => p.who === 'ana').map((p) => p.prompt).join('\n')
    expect(forBia).not.toMatch(/ANTIGA|segredo da fase solo/)
    expect(forBia).toContain('NOVA da Bia')
    expect(forAna).toMatch(/ANTIGA 0/)
  })
})

describe('9. two wordings', () => {
  it('an unknown setting is refused in plain words, whatever its key is called', () => {
    expect(settingsPatchError({ quota: 1 })).toBe('Essa configuração não existe.')
    expect(settingsPatchError({ chainDepth: 5 })).toBeUndefined() // the limit on agent replies in a row
    expect(settingsPatchError({ chainDepth: 'muitas' })).toBeTruthy()
    expect(settingsPatchError({ quota: 1 })).not.toMatch(/quota/)
  })
  it('the router’s limit note reads as one sentence, no parentheses around the reason', async () => {
    const db = new Db(join(tmp(), 'tucano.db'))
    db.saveAgent(agent('a1', 'Lia', 'lia'))
    db.saveAgent(agent('a2', 'Theo', 'theo'))
    db.createConversation({ id: 'c1', kind: 'channel', name: 'geral', members: ['a1', 'a2'] })
    const base = fakeEngine('claude', { delayMs: 1 })
    const claude: Engine = { id: 'claude', run: (t) => (t.system === routerSystem() ? (async function* () { yield { type: 'error' as const, message: "You've hit your 5-hour limit · resets 1:20am (America/Bahia)" } })() : base.run(t)) }
    const r = new Runner({ db, engines: { claude, codex: base, opencode: base, pi: base, antigravity: base, cursor: base, grok: base, cline: base, hermes: base } as Record<EngineId, Engine>, settings: async () => settingsOf(), emit: () => {}, workDir: tmp() })
    await r.send('c1', 'bom dia, quem me ajuda?')
    await r.idle()
    const note = db.messages().find((m) => m.author.kind === 'system')!
    expect(note.text).toMatch(/Não consegui escolher quem responde: Seu plano/)
    expect(note.text).not.toMatch(/\.\)|\(Seu plano/) // the reason isn't wrapped (its own "(libera: …)" stays as errors.ts writes it)
    expect(note.text).toMatch(/Tente de novo mais tarde\. Mencione um agente/)
  })
})

// keeps the type import used when the file is read on its own
export type { Message }
