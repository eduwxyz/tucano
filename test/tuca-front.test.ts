// The Tuca takes the person's requests and passes each to whoever on the team does it: what he is told
// of the team, how a request of his reaches a colleague, and what comes back to his conversation.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Agent, EngineId, Message, Settings } from '../src/shared/types'
import { askKind } from '../src/shared/org'
import { setLang } from '../src/shared/lang'
import { Db } from '../src/core/db'
import { askTask, teamSection } from '../src/core/delegations'
import { fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'
import { tucaAgent, tucaHello, tucaInstructions } from '../src/core/tuca'

const ready = { installed: true, loggedIn: true }
const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })

let db: Db
let settings: Settings
let gateway: Gateway
let turns: Turn[]
let tuca: Agent

function runner(): Runner {
  const fake = fakeEngine('claude', { delayMs: 1 })
  const claude: Engine = { id: 'claude', run: (t) => (turns.push(t), fake.run(t)) }
  const engines: Record<EngineId, Engine> = { claude, codex: fakeEngine('codex'), opencode: fakeEngine('opencode'), pi: fakeEngine('pi'), antigravity: fakeEngine('antigravity'), cursor: fakeEngine('cursor'), grok: fakeEngine('grok'), cline: fakeEngine('cline'), hermes: fakeEngine('hermes'), endpoint: fakeEngine('endpoint') }
  return new Runner({ db, engines, settings: async () => settings, emit: () => {}, workDir: mkdtempSync(join(tmpdir(), 'ad-work-')), gateway })
}

const by = (id: string, conversationId?: string): Message[] => db.messages().filter((m) => m.author.kind === 'agent' && m.author.id === id && (!conversationId || m.conversationId === conversationId))
const dmOf = (id: string): string => db.conversations().find((c) => c.kind === 'dm' && c.name === id)?.id ?? 'none'
const until = async (ok: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !ok(); ) {
    if (Date.now() > end) throw new Error('never happened')
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(async () => {
  setLang('pt')
  db = new Db(join(mkdtempSync(join(tmpdir(), 'ad-db-')), 'test.db'))
  turns = []
  settings = { workspaceName: 'Edu', context: '', engines: { claude: ready, codex: ready, opencode: ready, pi: ready, antigravity: ready, cursor: ready, grok: ready, cline: ready, hermes: ready, endpoint: ready }, routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
  tuca = tucaAgent('sonnet', [])
  db.saveAgent(tuca)
  db.createConversation({ id: 'tuca-dm', kind: 'dm', name: tuca.id, members: [tuca.id] })
  gateway = new Gateway()
  await gateway.start()
  return () => gateway.stop()
})

describe('who the Tuca is now', () => {
  it('has no monthly limit of his own, remembers, and says what he does in both languages', () => {
    expect(tuca).toMatchObject({ limit: 0, memory: 'auto', kind: 'tuca', web: false, grants: {} })
    for (const lang of ['pt', 'en'] as const) {
      setLang(lang)
      expect(tucaInstructions()).toContain(lang === 'pt' ? 'quem recebe os pedidos da pessoa' : "takes the person's requests")
      expect(tucaInstructions()).toContain('pedir')
      expect(tucaInstructions()).toContain(lang === 'pt' ? 'você lê só o que volta dos pedidos que você mesmo fez' : 'you read only what comes back from the requests you made yourself')
      expect(tucaHello()).toContain(lang === 'pt' ? 'eu passo pra quem do time faz' : 'I pass it to whoever on the team does it')
    }
    setLang('pt')
  })

  it('a Tuca from before loses his monthly limit and starts remembering, once', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tuca-mig-')), 'test.db')
    const db0 = new Db(file)
    db0.saveAgent({ ...tucaAgent('sonnet', []), id: 't0', limit: 50_000, memory: 'read' })
    db0.saveAgent(agent('duda', { limit: 50_000, memory: 'read' }))
    db0.close()
    // As a database from before this: its last migration not run yet.
    const raw = new DatabaseSync(file)
    const { user_version } = raw.prepare('PRAGMA user_version').get() as { user_version: number }
    raw.exec(`PRAGMA user_version = ${user_version - 1}`)
    raw.close()
    const db1 = new Db(file)
    expect(db1.agent('t0')).toMatchObject({ limit: 0, memory: 'auto' })
    expect(db1.agent('duda')).toMatchObject({ limit: 50_000, memory: 'read' }) // nobody else's changes
    db1.close()
  })
})

describe('what the Tuca is told of the team', () => {
  it('lists everyone by what they do, with the sectors and the entry point, and nothing of a tree of his own', () => {
    const team = [
      tuca,
      agent('orion', { entry: true, role: 'Coordena' }),
      agent('bento', { reportsTo: 'orion', role: 'Engenharia', sectorName: 'Engenharia', sectorDoes: 'código e deploy' }),
      agent('nico', { reportsTo: 'bento', role: 'Backend' }),
      agent('duda', { role: 'Atendimento', instructions: 'Você responde clientes.' }),
      agent('velho', { archived: true })
    ]
    const text = teamSection({ agent: tuca, agents: team, conversations: [], connectors: [], open: [], me: 'Edu' })!
    expect(text).toMatch(/^## O time\n/)
    expect(text).toContain('Você recebe os pedidos de Edu e passa cada um a quem faz, com pedir.')
    expect(text).toContain('- @orion · Orion, Coordena · acessa: nenhum sistema externo · porta de entrada')
    expect(text).toContain('- @bento · Bento, Engenharia · acessa: nenhum sistema externo · chefe do Engenharia (resolve: código e deploy)')
    expect(text).toContain('- @nico · Nico, Backend · acessa: nenhum sistema externo · responde a Bento')
    expect(text).toContain('- @duda · Duda, Atendimento: Você responde clientes.')
    expect(text).toContain('Orion é a porta de entrada que Edu escolheu')
    expect(text).not.toContain('velho')
    expect(text).not.toContain('@tuca')
    expect(text).not.toContain('## Outros agentes')
    expect(text).not.toContain('## Seu time')
  })

  it('with no one yet, says so and builds the first instead of forcing a request', () => {
    const text = teamSection({ agent: tuca, agents: [tuca], conversations: [], connectors: [], open: [], me: 'Edu' })!
    expect(text).toContain('Ainda não tem ninguém no time')
    expect(text).toContain('propor_agente')
    setLang('en')
    expect(teamSection({ agent: tuca, agents: [tuca], conversations: [], connectors: [], open: [], me: 'Edu' })).toContain('There is no one on the team yet')
    setLang('pt')
  })

  it("a request of his is the person's own, arriving through him", () => {
    const team = [tuca, agent('bento'), agent('nico', { reportsTo: 'bento' }), agent('duda')]
    expect(askKind(team, tuca.id, 'duda')).toBe('front')
    expect(askKind(team, tuca.id, 'bento')).toBe('front')
    expect(askKind(team, 'bento', 'nico')).toBe('down') // the tree's own ways stay
    expect(askTask(tuca, 'Edu', undefined, 'front', undefined, false)).toContain('A mensagem acima é um pedido de Edu, que chegou por Tuca')
    expect(askTask(tuca, 'Edu', undefined, 'front', undefined, true)).toContain('ou passe a quem do seu time faz')
    setLang('en')
    expect(askTask(tuca, 'Edu', undefined, 'front', undefined, false)).toContain('The message above is a request from Edu, which came through Tuca')
    setLang('pt')
  })
})

describe('a request through the Tuca', () => {
  it('goes to the colleague, works in their own conversation with the person, and comes back to his', async () => {
    db.saveAgent(agent('duda', { role: 'Atendimento' }))
    db.saveAgent(agent('nina', { role: 'Marketing' }))
    const r = runner()
    await r.send('tuca-dm', 'delegue a @duda: responda as avaliações do iFood')
    await r.idle()
    await until(() => by(tuca.id, 'tuca-dm').some((m) => m.run?.status === 'done' && m.text.trim().length > 0))

    // His prompt: the team, and the tools that hand work over.
    const first = turns.find((t) => t.system.includes('Você é Tuca'))!
    expect(`${first.system}\n${first.prompt}`).toContain('## O time')
    expect(`${first.system}\n${first.prompt}`).toContain('- @duda · Duda, Atendimento')
    expect(by(tuca.id, 'tuca-dm').flatMap((m) => m.run?.steps.map((x) => x.label) ?? [])).toContain('Pediu a Duda')

    // One request, to Duda, in her own DM with the person: nobody else was called.
    const asked = by(tuca.id, 'tuca-dm').flatMap((m) => m.run?.delegations ?? []).map((x) => db.delegation(x.id)!)
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ from: tuca.id, to: 'duda', conversationId: dmOf('duda'), originConversationId: 'tuca-dm', state: 'done' })
    expect(by('nina')).toHaveLength(0)

    // Duda was told whose request it is: the person's, through him.
    const hers = turns.find((t) => t.system.includes('Você é Duda'))!
    expect(hers.prompt).toContain('A mensagem acima é um pedido de Edu, que chegou por Tuca')

    // What she ended with came back to his conversation, and he was called again to close it.
    const back = turns.filter((t) => t.system.includes('Você é Tuca')).at(-1)!
    expect(back.prompt).toContain('Voltou do que você pediu ao seu time')
    expect(by(tuca.id, 'tuca-dm').at(-1)!.run?.status).toBe('done')
  })
})
