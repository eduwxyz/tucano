// Documentos as the agents' tools in a real run (core/docs-tools.ts): which tools an agent is offered, and the Documentos section of its prompt.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocFolder, FolderAccess } from '../src/shared/docs'
import { setLang } from '../src/shared/lang'
import type { Agent, Artifact, EngineId, Person, Settings } from '../src/shared/types'
import { liveContext } from '../src/core/context'
import { Db } from '../src/core/db'
import { Docs } from '../src/core/docs'
import { DOCS_TOOL_NAMES, DOCS_TOOLS, docsCall, type DocsCtx } from '../src/core/docs-tools'
import { callTool, fakeEngine } from '../src/core/engines/fake'
import type { Engine, Turn } from '../src/core/engines/types'
import { Gateway } from '../src/core/gateway'
import { Runner } from '../src/core/runs'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const caio: Person = { id: 'caio', name: 'Caio', role: 'member', about: '' }
const textOf = (r: unknown): string => ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? '').join('\n')

// Who may do what, for the folders made in these tests.
const WRITE: FolderAccess = { people: { bia: 'edit' }, agents: { lia: 'write' }, sectors: {} }
const ADMINS_ONLY: FolderAccess = { people: {}, agents: {}, sectors: {} }

afterEach(() => setLang('pt'))

describe('docsCall', () => {
  let root: string
  let docs: Docs
  let people: Person[]
  let agents: Agent[]
  let cards: string[] // the files turned into a chat card
  const lia = agent('lia')

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'tucano-docs-tools-'))
    people = [ana, bia, caio]
    agents = [lia, agent('rex')]
    cards = []
    docs = new Docs({ dir: join(root, 'documents'), indexPath: join(root, 'docs.db'), artifactsDir: join(root, 'artifacts'), agents: () => agents, people: () => people, artifact: () => undefined, canSeeArtifact: () => true, emit: () => {} })
    docs.init()
    await docs.loaded
  })
  afterEach(() => {
    docs.close()
    rmSync(root, { recursive: true, force: true })
  })

  const card = (id: string, name: string, size: number, title = name): Artifact => ({ id, agentId: 'lia', conversationId: 'c1', messageId: 'm1', kind: 'text', name, title, source: 'docs_guardar', size, createdAt: 0 })
  const ctx = (over: Partial<DocsCtx> = {}): DocsCtx => ({
    docs,
    agent: lia,
    requester: ana,
    askedBy: 'ana',
    conversationId: 'c1',
    messageId: 'm1',
    dataDir: root,
    shown: () => undefined,
    fromText: (name, data, title) => {
      cards.push(name)
      return card(`card${cards.length}`, name, data.length, title)
    },
    ...over
  })
  const call = (name: string, args: Record<string, unknown>, over: Partial<DocsCtx> = {}) => docsCall(ctx(over), name, args)
  const save = (args: Record<string, unknown>, over: Partial<DocsCtx> = {}) => call('docs_guardar', { resumo: 'Um arquivo', ...args }, over)
  const mk = (name: string, o: { rule?: string; access?: FolderAccess | null; parentId?: string | null; needsApproval?: boolean } = {}): DocFolder =>
    docs.saveFolder(ana, { parentId: o.parentId ?? null, name, rule: o.rule ?? '', access: o.access === undefined ? WRITE : o.access, ...(o.needsApproval ? { needsApproval: true } : {}) })


  describe('the tools in English', () => {
    it('speaks English when the app does, and never leaves a Portuguese sentence in what a model reads', async () => {
      const prose = (t: (typeof DOCS_TOOLS)[number]): string => {
        const described = [...JSON.stringify(t.inputSchema).matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!)
        return [t.description, ...described].join('\n')
      }
      const pt = DOCS_TOOLS.map((t) => t.description)
      setLang('en')
      // Portuguese words that cannot be English; the argument names (arquivo, mostrado, texto…) are not in this list on purpose
      const PORTUGUESE = /\b(não|você|também|até|para|uma|quando|quem|sempre|nunca|aprovação|pessoa|regra|guardar|guarde|pasta)\b/iu
      DOCS_TOOLS.forEach((t, i) => {
        expect(t.description).not.toBe(pt[i])
        expect(prose(t)).not.toMatch(PORTUGUESE)
      })
      mk('Financeiro', { rule: 'Monthly reports' })
      const list = await call('docs_listar', {})
      expect(list.text).toContain('you may save here')
      const missing = await call('docs_listar', { pasta: 'Nao-existe' })
      expect(missing.text).toContain("I didn't find that folder among the ones you reach.")
      const saved = await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'x' })
      expect(saved.text).toBe('Saved in Financeiro as a.md (version 1).')
    })

    it('has the five tools, each with what it needs', () => {
      expect([...DOCS_TOOL_NAMES].sort()).toEqual(['docs_buscar', 'docs_guardar', 'docs_ler', 'docs_listar', 'docs_mover'])
      const schema = (name: string) => DOCS_TOOLS.find((t) => t.name === name)!.inputSchema as { required?: string[] }
      expect(schema('docs_guardar').required).toEqual(['resumo'])
      expect(schema('docs_buscar').required).toEqual(['busca'])
      expect(schema('docs_ler').required).toEqual(['documento'])
      expect(schema('docs_mover').required).toEqual(['documento', 'pasta'])
    })
  })

  describe('sectors', () => {
    it('gives the whole sector its folder, and an agent of another sector neither the folder nor its name', async () => {
      // lia heads a sector with aux; bob heads another with bob2. Each head got a folder of its sector at the start.
      docs.close()
      agents = [lia, agent('aux', { reportsTo: 'lia' }), agent('bob'), agent('bob2', { reportsTo: 'bob' })]
      docs = new Docs({ dir: join(root, 'documents-sectors'), indexPath: join(root, 'docs-sectors.db'), artifactsDir: join(root, 'artifacts'), agents: () => agents, people: () => people, artifact: () => undefined, canSeeArtifact: () => true, emit: () => {} })
      docs.init()
      await docs.loaded
      const aux = await call('docs_listar', {}, { agent: agents[1]! })
      expect(aux.text).toContain('- Setor de Lia')
      expect(aux.text).toContain('você pode guardar aqui')
      expect(aux.text).not.toContain('Setor de Bob')
      const bob = await call('docs_listar', {}, { agent: agents[2]! })
      expect(bob.text).toContain('- Setor de Bob')
      expect(bob.text).not.toContain('Lia')
      const asked = await call('docs_listar', { pasta: 'Setor de Lia' }, { agent: agents[2]! })
      const missing = await call('docs_listar', { pasta: 'Setor de Ninguém' }, { agent: agents[2]! })
      expect(asked.error).toBe(true)
      expect(asked.text).toBe(missing.text)
      const saved = await save({ pasta: 'Setor de Lia', nome: 'a.md', texto: 'x' }, { agent: agents[1]! })
      expect(saved.text).toBe('Guardado em Setor de Lia como a.md (versão 1).')
    })
  })
})

// The same tools, in a real run: the agent is offered them (or not) by what it and the person it works for may reach.
describe('Documentos in a run', () => {
  const ready = { installed: true, loggedIn: true }
  const settings = { workspaceName: 'Ana', context: '', engines: Object.fromEntries((['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes', 'endpoint'] as EngineId[]).map((id) => [id, ready])), routerModel: 'haiku', memoryModel: 'haiku', memory: 'auto', chainDepth: 3 } as unknown as Settings
  let root: string
  let db: Db
  let docs: Docs
  let gateway: Gateway
  let owner: Person

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'tucano-docs-run-'))
    db = new Db(join(root, 'core.db'))
    db.saveAgent(agent('lia'))
    db.saveAgent(agent('rex'))
    db.addPerson(bia)
    owner = db.owner()
    db.createConversation({ id: 'dm', kind: 'dm', name: 'lia', members: ['lia'] })
    db.createConversation({ id: 'dm-rex', kind: 'dm', name: 'rex', members: ['rex'] })
    db.createConversation({ id: 'eng', kind: 'channel', name: 'engenharia', members: ['lia'] })
    docs = new Docs({ dir: join(root, 'documents'), indexPath: join(root, 'docs.db'), artifactsDir: join(root, 'artifacts'), agents: () => db.agents(), people: () => db.people(), artifact: (id) => db.artifact(id), canSeeArtifact: () => true, emit: () => {} })
    docs.init()
    await docs.loaded
    gateway = new Gateway()
    await gateway.start()
  })
  afterEach(async () => {
    await gateway.stop()
    docs.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })

  const folder = (name: string, access: FolderAccess, rule = ''): DocFolder => docs.saveFolder(owner, { parentId: null, name, rule, access })
  // The company folder is read by every agent: some tests need an agent that reaches nothing at all.
  const dropCompany = (): void => {
    const company = docs.index.folders().find((f) => f.name === 'Empresa')!
    docs.removeFolder(owner, company.id)
  }
  const runnerWith = (claude: Engine): Runner => {
    const ids: EngineId[] = ['claude', 'codex', 'opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes', 'endpoint']
    const engines = Object.fromEntries(ids.map((id) => [id, id === 'claude' ? claude : fakeEngine(id)])) as Record<EngineId, Engine>
    return new Runner({ db, gateway, engines, settings: async () => settings, emit: () => {}, workDir: join(root, 'work'), dataDir: root, docs })
  }
  // An engine that calls the given tools (name, arguments) and says what they answered.
  const scripted = (calls: [string, Record<string, unknown>][], seen: Turn[] = []): Engine => ({
    id: 'claude',
    async *run(turn: Turn) {
      seen.push(turn)
      if (!turn.mcpUrl) {
        yield { type: 'done', text: 'ok', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
        return
      }
      const out: string[] = []
      for (const [name, args] of calls) out.push(textOf(await callTool(turn.mcpUrl!, name, args)))
      yield { type: 'done', text: out.join('\n---\n') || 'ok', usage: { inputTokens: 1, cacheReadTokens: 0, outputTokens: 1 } }
    }
  })
  const say = async (runner: Runner, conversation: string, text: string, by: string = owner.id): Promise<void> => {
    await runner.send(conversation, text, [], undefined, by)
    await runner.idle()
  }
  const replies = (conversation: string) => db.messages().filter((m) => m.conversationId === conversation && m.author.kind === 'agent')

  it('offers the tools to an agent whose folder it owns: "guarde em" saves a file and attaches a chat card to the reply', async () => {
    const fin = folder('Financeiro', { people: { bia: 'edit' }, agents: { lia: 'write' }, sectors: {} }, 'Relatórios mensais')
    const runner = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await say(runner, 'dm', 'guarde em Financeiro: relatorio.md = Resultado de maio')
    const saved = docs.tree(owner).docs.find((d) => d.name === 'relatorio.md')
    expect(saved).toBeDefined()
    expect(saved!.folderId).toBe(fin.id)
    expect(saved!.origin).toMatchObject({ conversationId: 'dm', agentId: 'lia', askedBy: owner.id })
    const reply = replies('dm').at(-1)!
    expect(reply.text).toContain('Guardado em Financeiro como relatorio.md')
    const cardId = reply.run?.artifactIds?.[0]
    expect(reply.run?.artifactIds).toHaveLength(1)
    expect(db.artifact(cardId!)?.name).toBe('relatorio.md')
    expect(existsSync(join(root, 'artifacts', cardId!, 'relatorio.md'))).toBe(true)
    expect(saved!.origin.artifactId).toBe(cardId)
    expect(reply.run?.steps.some((s) => s.label === 'Guardou em Documentos' && s.status === 'done')).toBe(true)
  })

  it('lists and reads what it saved, in the next messages', async () => {
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} })
    const runner = runnerWith(fakeEngine('claude', { delayMs: 1 }))
    await say(runner, 'dm', 'guarde em Financeiro: relatorio.md = Resultado de maio')
    await say(runner, 'dm', 'liste os documentos de Financeiro')
    expect(replies('dm').at(-1)!.text).toContain('- Financeiro/relatorio.md')
    await say(runner, 'dm', 'leia o documento Financeiro/relatorio.md')
    expect(replies('dm').at(-1)!.text).toContain('Resultado de maio')
  })

  it('in a channel a member without access can read, the same agent is not offered the tools and nothing is saved; in the owner\'s DM it is', async () => {
    dropCompany()
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} }) // Bia has no access to it
    const runner = runnerWith(scripted([['docs_guardar', { pasta: 'Financeiro', nome: 'a.md', texto: 'x', resumo: 'Um arquivo' }]]))
    await say(runner, 'eng', '@lia guarde isso')
    expect(replies('eng').at(-1)!.text).toContain('Ferramenta não permitida: docs_guardar')
    expect(docs.index.docs()).toHaveLength(0)
    await say(runner, 'dm', 'guarde isso')
    expect(replies('dm').at(-1)!.text).toContain('Guardado em Financeiro como a.md')
    expect(docs.index.docs()).toHaveLength(1)
  })

  it('in the same channel, saves where everyone there may edit', async () => {
    dropCompany()
    folder('Equipe', { people: { bia: 'edit' }, agents: { lia: 'write' }, sectors: {} })
    const runner = runnerWith(scripted([['docs_guardar', { pasta: 'Equipe', nome: 'a.md', texto: 'x', resumo: 'Um arquivo' }]]))
    await say(runner, 'eng', '@lia guarde isso')
    expect(replies('eng').at(-1)!.text).toContain('Guardado em Equipe como a.md')
    expect(docs.index.docs()[0]!.origin).toMatchObject({ conversationId: 'eng', agentId: 'lia', askedBy: owner.id })
  })

  it('does not offer the tools to an agent of another sector that reaches no folder', async () => {
    dropCompany()
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} })
    const runner = runnerWith(scripted([['docs_listar', {}], ['docs_guardar', { pasta: 'Financeiro', nome: 'a.md', texto: 'x', resumo: 'Um arquivo' }]]))
    await say(runner, 'dm-rex', 'guarde isso')
    const text = replies('dm-rex').at(-1)!.text
    expect(text).toContain('Ferramenta não permitida: docs_listar')
    expect(text).toContain('Ferramenta não permitida: docs_guardar')
    expect(docs.index.docs()).toHaveLength(0)
  })

  it('when the other agent does reach something, it still sees and saves nothing in the folder it cannot reach', async () => {
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} })
    const runner = runnerWith(scripted([['docs_listar', { pasta: 'Financeiro' }], ['docs_guardar', { pasta: 'Financeiro', nome: 'a.md', texto: 'x', resumo: 'Um arquivo' }]]))
    await say(runner, 'dm-rex', 'guarde isso')
    const text = replies('dm-rex').at(-1)!.text
    expect(text).toContain('Não achei essa pasta entre as que você alcança')
    expect(text).toContain('Não achei essa pasta entre as que você pode guardar')
    expect(docs.index.docs()).toHaveLength(0)
  })

  it('keeps a shown file only when it was shown in the same conversation', async () => {
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} })
    for (const [id, conversationId, name] of [['artA', 'dm', 'nota.md'], ['artB', 'eng', 'outra.md']] as const) {
      db.saveArtifact({ id, agentId: 'lia', conversationId, messageId: 'x', kind: 'markdown', name, title: name, source: '', size: 5, createdAt: 0 })
      mkdirSync(join(root, 'artifacts', id), { recursive: true })
      writeFileSync(join(root, 'artifacts', id, name), 'Texto mostrado')
    }
    const runner = runnerWith(scripted([['docs_guardar', { pasta: 'Financeiro', mostrado: 'artA', resumo: 'Uma nota' }], ['docs_guardar', { pasta: 'Financeiro', mostrado: 'artB', resumo: 'Outra' }]]))
    await say(runner, 'dm', 'guarde os dois')
    const text = replies('dm').at(-1)!.text
    expect(text).toContain('Guardado em Financeiro como nota.md')
    expect(text).toContain('Não achei esse arquivo mostrado nesta conversa')
    expect(docs.index.docs().map((d) => d.name)).toEqual(['nota.md'])
  })

  it('puts the Documentos section in the prompt of an agent that reaches a folder, and never names a folder it does not reach', async () => {
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} }, 'Relatórios mensais')
    folder('RH-Interno', ADMINS_ONLY, 'Folha de pagamento')
    const seen: Turn[] = []
    const runner = runnerWith(scripted([], seen))
    await say(runner, 'dm', 'quero ver as pastas')
    const turn = seen.find((t) => t.prompt.includes('quero ver as pastas'))!
    const prompt = `${turn.system}\n${turn.prompt}`
    expect(prompt).toContain('## Documentos')
    expect(prompt).toContain('Financeiro')
    expect(prompt).toContain('Relatórios mensais')
    expect(prompt).not.toContain('RH-Interno')
    expect(prompt).not.toContain('Folha de pagamento')
  })

  it('leaves the section out for an agent that reaches no folder', async () => {
    dropCompany()
    folder('Financeiro', { people: {}, agents: { lia: 'write' }, sectors: {} })
    const seen: Turn[] = []
    const runner = runnerWith(scripted([], seen))
    await say(runner, 'dm-rex', 'quero ver as pastas')
    const turn = seen.find((t) => t.prompt.includes('quero ver as pastas'))!
    const prompt = `${turn.system}\n${turn.prompt}`
    expect(prompt).not.toContain('## Documentos')
    expect(prompt).not.toContain('Financeiro')
  })
})

describe('the Documentos section of the prompt', () => {
  const folders = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `Pasta ${i + 1}`, rule: i === 0 ? '  Contratos\nassinados  ' : '' }))
  const section = (docsFolders: { path: string; rule: string }[], routine = false) => liveContext({ settings: { workspaceName: 'Edu', context: '' }, docs: docsFolders, docsRoutine: routine })

  it('lists the folders with their rule on one line, and says the rule is only about saving', () => {
    const s = section(folders(2))
    expect(s).toContain('## Documentos')
    expect(s).toContain('- Pasta 1: Contratos assinados')
    expect(s).toContain('- Pasta 2\n')
    expect(s).toContain('A regra só vale para como guardar arquivos nesta pasta.')
    expect(s).toContain('Não cite nem adivinhe pastas que você não vê.')
    expect(s).not.toContain('substitui` no mesmo documento')
  })

  it('shows at most 12 folders and counts the rest', () => {
    const s = section(folders(15))
    expect(s).toContain('- Pasta 12')
    expect(s).not.toContain('- Pasta 13')
    expect(s).toContain('+3 pastas (veja com docs_listar)')
  })

  it('adds the living-document advice only in a routine', () => {
    expect(section(folders(1), true)).toContain('guarde com `substitui` no mesmo documento')
  })

  it('is absent when the agent reaches no folder', () => {
    expect(section([])).not.toContain('Documentos')
  })

  it('is written in English too', () => {
    setLang('en')
    const s = section(folders(1), true)
    expect(s).toContain('## Documents')
    expect(s).toContain("Don't mention or guess at folders you can't see.")
    expect(s).not.toMatch(/\b(você|não|pastas)\b/iu)
  })
})