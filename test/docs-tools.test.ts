// Documentos as the agents' tools (core/docs-tools.ts): what an agent sees, finds, reads, saves and moves, for the person it works for.
// docsCall is driven directly on a real Docs (real folder, real SQLite). The same tools in a real run: docs-tools-run.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DocFolder, FolderAccess } from '../src/shared/docs'
import type { Agent, Artifact, Person } from '../src/shared/types'
import { Docs } from '../src/core/docs'
import { docsCall, type DocsCtx } from '../src/core/docs-tools'

const agent = (id: string, extra: Partial<Agent> = {}): Agent => ({ id, name: id[0]!.toUpperCase() + id.slice(1), handle: id, role: '', color: 'sky', instructions: '', modelId: 'sonnet', effort: 'low', limit: 1_000_000, used: 0, grants: {}, memory: 'auto', computer: false, archived: false, ...extra })
const ana: Person = { id: 'ana', name: 'Ana', role: 'owner', about: '' }
const bia: Person = { id: 'bia', name: 'Bia', role: 'member', about: '' }
const caio: Person = { id: 'caio', name: 'Caio', role: 'member', about: '' }

// Who may do what, for the folders made in these tests.
const WRITE: FolderAccess = { people: { bia: 'edit' }, agents: { lia: 'write' }, sectors: {} }
const ADMINS_ONLY: FolderAccess = { people: {}, agents: {}, sectors: {} }

describe('docsCall', () => {
  let root: string
  let docs: Docs
  let people: Person[]
  let agents: Agent[]
  let cards: string[] // the files turned into a chat card
  let computerCalls: string[]
  const lia = agent('lia')

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'tucano-docs-tools-'))
    people = [ana, bia, caio]
    agents = [lia, agent('rex')]
    cards = []
    computerCalls = []
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
  const put = (folder: DocFolder, name: string, text: string) => docs.add(ana, { folderId: folder.id, name, data: Buffer.from(text) })
  const find = (name: string) => docs.index.docs().find((d) => d.name === name)

  describe('docs_listar', () => {
    it('lists only the folders the agent reaches for that person, with the ones it may save in marked', async () => {
      mk('Financeiro', { rule: 'Relatórios mensais' })
      mk('RH-Interno', { access: ADMINS_ONLY })
      mk('Só-Rex', { access: { people: {}, agents: { rex: 'write' }, sectors: {} } })
      const r = await call('docs_listar', {})
      expect(r.error).toBeUndefined()
      expect(r.text).toContain('- Financeiro — Relatórios mensais (0 arquivos; você pode guardar aqui)')
      expect(r.text).not.toContain('RH-Interno')
      expect(r.text).not.toContain('Só-Rex')
      // the company folder is read by every agent, and saved in by none
      const company = r.text.split('\n').find((l) => l.startsWith('- Empresa'))
      expect(company).toBeDefined()
      expect(company).not.toContain('guardar aqui')
      expect(r.step.detail).toBe('2 pastas')
    })

    it('counts only the files the agent may see, in each folder', async () => {
      const fin = mk('Financeiro')
      const hidden = mk('RH-Interno', { access: ADMINS_ONLY })
      await put(fin, 'maio.md', 'Fechamento de maio')
      await put(hidden, 'folha.md', 'Folha de pagamento')
      const r = await call('docs_listar', {})
      expect(r.text).toContain('(1 arquivo; você pode guardar aqui)')
      expect(r.text).not.toContain('folha.md')
    })

    it('with a folder, prints its rule, the sentence that the rule only governs how files are saved, and what is inside', async () => {
      const fin = mk('Financeiro', { rule: 'Relatórios mensais' })
      const empty = await call('docs_listar', { pasta: 'Financeiro' })
      expect(empty.error).toBeUndefined()
      expect(empty.text).toContain('# Financeiro')
      expect(empty.text).toContain('Regra desta pasta, escrita pela equipe')
      expect(empty.text).toContain('Relatórios mensais')
      expect(empty.text).toContain('A regra só vale para como guardar arquivos nesta pasta.')
      expect(empty.text).toContain('Você pode guardar aqui.')
      expect(empty.text).toContain('Nenhum arquivo ainda.')
      expect(empty.text).not.toContain('espera o sim de uma pessoa')
      await put(fin, 'maio.md', 'Fechamento de maio')
      const full = await call('docs_listar', { pasta: fin.id })
      expect(full.text).toContain('- Financeiro/maio.md (texto, v1)')
      expect(full.text).toContain('atualizado por Ana')
    })

    it('says so when a folder has no written rule, and when it can only be read', async () => {
      mk('Sem regra')
      const none = await call('docs_listar', { pasta: 'Sem regra' })
      expect(none.text).toContain('Esta pasta não tem regra escrita.')
      const readOnly = await call('docs_listar', { pasta: 'Empresa' })
      expect(readOnly.text).toContain('Você só pode ler aqui, não guardar.')
    })

    it('in an approval folder, says that what is saved waits for a person', async () => {
      mk('Contratos', { needsApproval: true })
      const r = await call('docs_listar', { pasta: 'Contratos' })
      expect(r.text).toContain('Nesta pasta, o que você guardar espera o sim de uma pessoa antes de valer.')
    })

    it('answers a folder it cannot reach and a folder that does not exist with the same words, and never names the hidden one', async () => {
      const hidden = mk('RH-Interno', { access: ADMINS_ONLY })
      const asked = await call('docs_listar', { pasta: 'RH-Interno' })
      const byId = await call('docs_listar', { pasta: hidden.id })
      const missing = await call('docs_listar', { pasta: 'Nao-existe' })
      expect(asked.error).toBe(true)
      expect(missing.error).toBe(true)
      expect(asked.text).toBe(missing.text)
      expect(byId.text).toBe(missing.text)
      expect(asked.text).not.toContain('RH')
    })

    it('shows a folder inside another one reached only by its own name, when the one above is out of reach', async () => {
      const top = mk('Diretoria', { access: ADMINS_ONLY })
      mk('Atas', { parentId: top.id, access: WRITE })
      const r = await call('docs_listar', {})
      expect(r.text).toContain('- Atas')
      expect(r.text).not.toContain('Diretoria')
    })

    it('opens a personal folder only for its own person, never for a channel or a routine', async () => {
      docs.tree(ana) // makes her personal folder
      const mine = await call('docs_listar', {})
      expect(mine.text).toContain('Só meus')
      for (const requester of [bia, [ana, bia], null]) {
        const r = await call('docs_listar', {}, { requester })
        expect(r.text).not.toContain('Só meus')
      }
    })
  })

  describe('docs_buscar', () => {
    it('finds a document by a word in its content, accents aside', async () => {
      const fin = mk('Financeiro')
      await put(fin, 'ata.md', 'Reunião sobre o quarkword do trimestre')
      await put(fin, 'verba.md', 'Orçamento aprovado para o ano')
      const hit = await call('docs_buscar', { busca: 'quarkword' })
      expect(hit.error).toBeUndefined()
      expect(hit.text).toContain('Financeiro/ata.md')
      expect(hit.text).toContain('quarkword')
      expect(hit.step.detail).toContain('1 documento')
      const accent = await call('docs_buscar', { busca: 'orcamento' })
      expect(accent.text).toContain('Financeiro/verba.md')
    })

    it('never returns a document from a folder outside the agent\'s reach', async () => {
      const hidden = mk('RH-Interno', { access: ADMINS_ONLY })
      const fin = mk('Financeiro')
      await put(hidden, 'folha.md', 'Folha com o quarkword')
      await put(fin, 'ata.md', 'Ata com o quarkword')
      const r = await call('docs_buscar', { busca: 'quarkword' })
      expect(r.text).toContain('Financeiro/ata.md')
      expect(r.text).not.toContain('folha.md')
      expect(r.text).not.toContain('RH-Interno')
      // for a person who may not see Financeiro, the agent finds nothing there either
      const forCaio = await call('docs_buscar', { busca: 'quarkword' }, { requester: caio })
      expect(forCaio.text).toContain('Nenhum documento com "quarkword"')
    })

    it('marks a version nobody approved and shows no part of its text', async () => {
      mk('Contratos', { needsApproval: true })
      await save({ pasta: 'Contratos', nome: 'minuta.md', texto: 'Cláusula com o quarkword secreto', resumo: 'Minuta do contrato' })
      const r = await call('docs_buscar', { busca: 'quarkword' })
      expect(r.text).toContain('Contratos/minuta.md')
      expect(r.text).toContain('[esperando aprovação]')
      expect(r.text).not.toContain('**')
      expect(r.text).not.toContain('secreto')
      expect(r.text).not.toContain('Minuta do contrato')
    })

    it('says a folder it cannot reach does not exist, in the same words as one that does not', async () => {
      mk('RH-Interno', { access: ADMINS_ONLY })
      const hidden = await call('docs_buscar', { busca: 'folha', pasta: 'RH-Interno' })
      const missing = await call('docs_buscar', { busca: 'folha', pasta: 'Nao-existe' })
      expect(hidden.error).toBe(true)
      expect(hidden.text).toBe(missing.text)
    })

    it('asks for something to search when there is nothing', async () => {
      const r = await call('docs_buscar', { busca: '  ' })
      expect(r.error).toBe(true)
      expect(r.text).toBe('Faltou o que buscar.')
    })
  })

  describe('docs_ler', () => {
    it('returns the text, by path (any case or accents) or by id', async () => {
      const fin = mk('Financeiro')
      const d = await put(fin, 'ata.md', 'Reunião de planejamento')
      const byPath = await call('docs_ler', { documento: 'financeiro/ATA.md' })
      expect(byPath.error).toBeUndefined()
      expect(byPath.text).toContain('# Financeiro/ata.md')
      expect(byPath.text).toContain('Reunião de planejamento')
      expect(byPath.text).toContain('versão 1')
      const byId = await call('docs_ler', { documento: d.id })
      expect(byId.text).toContain('Reunião de planejamento')
    })

    it('gives the official text, with a note, when a newer version waits for approval', async () => {
      const contracts = mk('Contratos', { needsApproval: true })
      await put(contracts, 'termo.md', 'Texto oficial aprovado') // Ana approves what she saves: official
      const next = await save({ substitui: 'Contratos/termo.md', nome: 'termo.md', texto: 'Texto novo ainda sem aprovação', resumo: 'Nova redação' })
      expect(next.text).toContain('versão 2')
      expect(next.text).toContain('esperando o sim')
      const r = await call('docs_ler', { documento: 'Contratos/termo.md' })
      expect(r.text).toContain('Texto oficial aprovado')
      expect(r.text).not.toContain('Texto novo')
      expect(r.text).toContain('Esta é a versão oficial (1)')
      expect(r.text).toContain('esperando aprovação')
    })

    it('says a draft is a draft', async () => {
      mk('Financeiro')
      await save({ pasta: 'Financeiro', nome: 'rascunho.md', texto: 'Ainda não final', rascunho: true })
      const r = await call('docs_ler', { documento: 'Financeiro/rascunho.md' })
      expect(r.text).toContain('Este documento é um rascunho.')
    })

    it('says a picture has no text', async () => {
      const fin = mk('Financeiro')
      await docs.add(ana, { folderId: fin.id, name: 'foto.png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) })
      const r = await call('docs_ler', { documento: 'Financeiro/foto.png' })
      expect(r.text).toContain('É uma imagem: não tem texto para ler.')
    })

    it('answers a document outside the agent\'s reach and one that does not exist with the same words', async () => {
      const hidden = mk('RH-Interno', { access: ADMINS_ONLY })
      await put(hidden, 'folha.md', 'Salários de todos')
      const asked = await call('docs_ler', { documento: 'RH-Interno/folha.md' })
      const missing = await call('docs_ler', { documento: 'RH-Interno/nao-existe.md' })
      expect(asked.error).toBe(true)
      expect(asked.text).toBe(missing.text)
      expect(asked.text).not.toContain('Salários')
      expect(asked.text).not.toContain('folha')
    })
  })

  describe('docs_guardar', () => {
    it('requires exactly one of arquivo, mostrado or texto', async () => {
      mk('Financeiro')
      for (const source of [{}, { arquivo: '/x/a.md', texto: 'x' }, { mostrado: 'a1', texto: 'x' }, { arquivo: '/x/a.md', mostrado: 'a1' }, { texto: '' }]) {
        const r = await save({ pasta: 'Financeiro', nome: 'a.md', ...source })
        expect(r.error).toBe(true)
        expect(r.text).toContain('exatamente uma fonte')
      }
      expect(docs.index.docs()).toHaveLength(0)
      expect(cards).toEqual([])
    })

    it('asks for the folder and for the summary', async () => {
      mk('Financeiro')
      const noFolder = await save({ texto: 'x', nome: 'a.md' })
      expect(noFolder.error).toBe(true)
      expect(noFolder.text).toContain('Faltou a pasta')
      const noSummary = await call('docs_guardar', { pasta: 'Financeiro', texto: 'x', nome: 'a.md' })
      expect(noSummary.error).toBe(true)
      expect(noSummary.text).toContain('Faltou o resumo')
    })

    it('needs a name with an extension when the source is a text', async () => {
      mk('Financeiro')
      const noName = await save({ pasta: 'Financeiro', texto: 'x' })
      expect(noName.error).toBe(true)
      expect(noName.text).toContain('dê também o nome do arquivo com extensão')
      const noExt = await save({ pasta: 'Financeiro', texto: 'x', nome: 'relatorio' })
      expect(noExt.error).toBe(true)
      expect(noExt.text).toContain('Esse tipo de arquivo não cabe em Documentos')
      expect(docs.index.docs()).toHaveLength(0)
    })

    it('refuses a kind that is not accepted and says which ones are', async () => {
      mk('Financeiro')
      const r = await save({ pasta: 'Financeiro', texto: 'x', nome: 'x.mp4' })
      expect(r.error).toBe(true)
      expect(r.text).toContain('Aceito: PDF, Word, planilha, CSV, texto, página HTML e imagem')
      expect(docs.index.docs()).toHaveLength(0)
      expect(cards).toEqual([])
    })

    it('refuses a text over the size limit', async () => {
      mk('Financeiro')
      const r = await save({ pasta: 'Financeiro', texto: 'a'.repeat(20 * 1024 * 1024 + 1), nome: 'enorme.txt' })
      expect(r.error).toBe(true)
      expect(r.text).toContain('grande demais')
      expect(docs.index.docs()).toHaveLength(0)
    })

    it('saves into a folder given by id or by path, nested ones included', async () => {
      const fin = mk('Financeiro')
      mk('Relatórios', { parentId: fin.id, access: null })
      const byId = await save({ pasta: fin.id, nome: 'a.md', texto: 'um' })
      expect(byId.error).toBeUndefined()
      expect(byId.text).toBe('Guardado em Financeiro como a.md (versão 1).')
      const nested = await save({ pasta: 'financeiro/relatorios', nome: 'b.md', texto: 'dois' })
      expect(nested.text).toBe('Guardado em Financeiro › Relatórios como b.md (versão 1).')
      expect(find('b.md')?.folderId).not.toBe(fin.id)
      expect(cards).toEqual(['a.md', 'b.md'])
    })

    it('makes version 2 of the same document with substitui, not a second file', async () => {
      mk('Financeiro')
      await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'versão um' })
      const r = await save({ substitui: 'Financeiro/a.md', nome: 'a.md', texto: 'versão dois', resumo: 'Segunda', nota: 'Corrigi os números' })
      expect(r.error).toBeUndefined()
      expect(r.text).toContain('versão 2')
      const same = docs.index.docs().filter((d) => d.name === 'a.md')
      expect(same).toHaveLength(1)
      expect(same[0]!.version).toBe(2)
      expect(docs.history(ana, same[0]!.id).versions.map((v) => v.n).sort()).toEqual([1, 2])
      const now = await call('docs_ler', { documento: 'Financeiro/a.md' })
      expect(now.text).toContain('versão dois')
    })

    it('does not update a document outside its reach, and makes no card for it', async () => {
      mk('Financeiro')
      const hidden = mk('RH-Interno', { access: ADMINS_ONLY })
      await put(hidden, 'folha.md', 'Folha')
      const r = await save({ substitui: 'RH-Interno/folha.md', nome: 'folha.md', texto: 'trocada' })
      expect(r.error).toBe(true)
      expect(r.text).toContain('Não achei esse documento entre os que você pode atualizar.')
      expect(r.text).not.toContain('RH-Interno')
      expect(cards).toEqual([])
      expect(find('folha.md')?.version).toBe(1)
    })

    it('marks a draft as draft in a normal folder', async () => {
      mk('Financeiro')
      const r = await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'ainda não', rascunho: true })
      expect(r.text).toBe('Guardado como rascunho em Financeiro como a.md (versão 1).')
      expect(find('a.md')?.status).toBe('draft')
    })

    it('in an approval folder, says it waits for a person, and the document is in review (a draft flag changes nothing)', async () => {
      mk('Contratos', { needsApproval: true })
      const r = await save({ pasta: 'Contratos', nome: 'minuta.md', texto: 'minuta' })
      expect(r.text).toContain('esperando o sim de uma pessoa')
      expect(find('minuta.md')?.status).toBe('review')
      const draft = await save({ pasta: 'Contratos', nome: 'outra.md', texto: 'outra', rascunho: true })
      expect(draft.text).toContain('esperando o sim de uma pessoa')
      expect(find('outra.md')?.status).toBe('review')
    })

    it('keeps a file shown in this conversation, with its own name or the one given (extension added)', async () => {
      mk('Financeiro')
      mkdirSync(join(root, 'artifacts', 'art1'), { recursive: true })
      writeFileSync(join(root, 'artifacts', 'art1', 'nota.md'), 'Texto mostrado no chat')
      const shown = card('art1', 'nota.md', 22)
      const over = { shown: (id: string) => (id === 'art1' ? shown : undefined) }
      const same = await save({ pasta: 'Financeiro', mostrado: 'art1' }, over)
      expect(same.text).toBe('Guardado em Financeiro como nota.md (versão 1).')
      const renamed = await save({ pasta: 'Financeiro', mostrado: 'art1', nome: 'ata' }, over)
      expect(renamed.text).toContain('como ata.md')
      expect(find('nota.md')?.origin.artifactId).toBe('art1')
      expect(cards).toEqual([]) // an already shown file is not shown again
    })

    it('refuses a shown file that is not from this conversation, or whose file is gone, without leaking a disk path', async () => {
      mk('Financeiro')
      const other = await save({ pasta: 'Financeiro', mostrado: 'art-de-outra-conversa' })
      expect(other.error).toBe(true)
      expect(other.text).toContain('Não achei esse arquivo mostrado nesta conversa')
      const gone = card('art2', 'sumiu.md', 3)
      const missing = await save({ pasta: 'Financeiro', mostrado: 'art2' }, { shown: () => gone })
      expect(missing.error).toBe(true)
      expect(missing.text).toBe('Não consegui ler esse arquivo.')
      expect(JSON.stringify([other, missing])).not.toContain(root)
      expect(docs.index.docs()).toHaveLength(0)
    })

    it('checks the folder before it makes any chat card', async () => {
      mk('Financeiro')
      const hidden = mk('RH-Interno', { access: ADMINS_ONLY })
      const readOnly = 'Empresa'
      const over = {
        fromComputer: async (path: string) => {
          computerCalls.push(path)
          return { error: 'não devia chamar' }
        }
      }
      for (const pasta of [hidden.id, 'RH-Interno', readOnly, 'Nao-existe']) {
        const viaText = await save({ pasta, nome: 'a.md', texto: 'segredo' }, over)
        const viaComputer = await save({ pasta, arquivo: '/home/lia/a.md' }, over)
        for (const r of [viaText, viaComputer]) {
          expect(r.error).toBe(true)
          expect(r.text).toContain('Não achei essa pasta entre as que você pode guardar')
          expect(r.text).not.toContain('RH')
        }
      }
      expect(cards).toEqual([])
      expect(computerCalls).toEqual([])
      expect(docs.index.docs()).toHaveLength(0)
    })

    it('records where the document came from: conversation, message, agent, who asked, thread and routine', async () => {
      mk('Financeiro')
      const r = await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'x' }, { threadId: 't1', routineId: 'r1' })
      expect(r.error).toBeUndefined()
      const d = find('a.md')!
      expect(d.origin).toEqual({ conversationId: 'c1', messageId: 'm1', agentId: 'lia', askedBy: 'ana', routineId: 'r1', threadId: 't1', artifactId: 'card1' })
      expect(d.routineId).toBe('r1')
      expect(d.createdBy).toBe('agent:lia')
    })

    it('leaves out thread and routine when there are none, and names no one when it works for several people', async () => {
      mk('Financeiro')
      await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'x' }, { requester: [ana, bia], askedBy: undefined })
      const d = find('a.md')!
      expect(d.origin).toEqual({ conversationId: 'c1', messageId: 'm1', agentId: 'lia', artifactId: 'card1' })
      expect(d.routineId).toBeNull()
      // working for one person, the asker is that person even when the caller did not say
      await save({ pasta: 'Financeiro', nome: 'b.md', texto: 'y' }, { requester: bia, askedBy: undefined })
      expect(find('b.md')?.origin.askedBy).toBe('bia')
    })

    it('in a channel, saves only where everyone who reads the reply may edit', async () => {
      mk('Leitura', { access: { people: { bia: 'view' }, agents: { lia: 'write' }, sectors: {} } })
      mk('Equipe')
      const refused = await save({ pasta: 'Leitura', nome: 'a.md', texto: 'x' }, { requester: [ana, bia] })
      expect(refused.error).toBe(true)
      expect(refused.text).toContain('Não achei essa pasta entre as que você pode guardar')
      const allowed = await save({ pasta: 'Equipe', nome: 'a.md', texto: 'x' }, { requester: [ana, bia] })
      expect(allowed.error).toBeUndefined()
    })

    it('a routine with no one to work for saves with the agent\'s own access and records the routine', async () => {
      mk('Financeiro')
      mk('Segredo', { access: ADMINS_ONLY })
      const ok = await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'x' }, { requester: null, askedBy: undefined, routineId: 'r9' })
      expect(ok.error).toBeUndefined()
      expect(find('a.md')?.origin).toMatchObject({ routineId: 'r9', agentId: 'lia' })
      expect(find('a.md')?.origin.askedBy).toBeUndefined()
      const no = await save({ pasta: 'Segredo', nome: 'b.md', texto: 'x' }, { requester: null, askedBy: undefined })
      expect(no.error).toBe(true)
    })

    it('saves a file from the agent\'s computer through the show_file card, checking the kind first', async () => {
      mk('Financeiro')
      const over = {
        fromComputer: async (path: string, title: string) => {
          computerCalls.push(`${path}|${title}`)
          mkdirSync(join(root, 'artifacts', 'art3'), { recursive: true })
          writeFileSync(join(root, 'artifacts', 'art3', 'plano.md'), 'Plano do trimestre')
          return { artifact: card('art3', 'plano.md', 18) }
        }
      }
      const video = await save({ pasta: 'Financeiro', arquivo: '/home/lia/video.mp4' }, over)
      expect(video.error).toBe(true)
      expect(computerCalls).toEqual([])
      const ok = await save({ pasta: 'Financeiro', arquivo: '/home/lia/plano.md' }, over)
      expect(ok.text).toBe('Guardado em Financeiro como plano.md (versão 1).')
      expect(computerCalls).toEqual(['/home/lia/plano.md|plano.md'])
      expect(find('plano.md')?.origin.artifactId).toBe('art3')
    })

    it('says plainly that there is no computer, and passes on what the computer said when it fails', async () => {
      mk('Financeiro')
      const none = await save({ pasta: 'Financeiro', arquivo: '/home/lia/plano.md' })
      expect(none.error).toBe(true)
      expect(none.text).toContain('Você não tem um computador aqui')
      const failed = await save({ pasta: 'Financeiro', arquivo: '/home/lia/plano.md' }, { fromComputer: async () => ({ error: 'Esse arquivo não existe no computador.' }) })
      expect(failed.text).toBe('Esse arquivo não existe no computador.')
      expect(docs.index.docs()).toHaveLength(0)
    })

    it('still saves when the chat card cannot be made, and says so', async () => {
      mk('Financeiro')
      const r = await save({ pasta: 'Financeiro', nome: 'a.md', texto: 'x' }, { fromText: () => undefined })
      expect(r.error).toBeUndefined()
      expect(r.text).toContain('Guardado em Financeiro como a.md')
      expect(r.text).toContain('Não consegui mostrar o arquivo na conversa, mas ele foi guardado.')
      expect(find('a.md')?.origin.artifactId).toBeUndefined()
    })
  })

  describe('docs_mover', () => {
    it('moves a document between two folders the agent may save in, and renames it keeping the extension', async () => {
      const fin = mk('Financeiro')
      mk('Contratos')
      await put(fin, 'a.md', 'texto')
      const r = await call('docs_mover', { documento: 'Financeiro/a.md', pasta: 'Contratos' })
      expect(r.error).toBeUndefined()
      expect(r.text).toBe('Movido para Contratos como a.md.')
      const renamed = await call('docs_mover', { documento: 'Contratos/a.md', pasta: 'Contratos', nome: 'b' })
      expect(renamed.text).toBe('Movido para Contratos como b.md.')
      expect(find('b.md')?.folderId).not.toBe(fin.id)
    })

    it('refuses a destination outside its reach, or one it can only read, and leaves the document where it was', async () => {
      const fin = mk('Financeiro')
      mk('RH-Interno', { access: ADMINS_ONLY })
      await put(fin, 'a.md', 'texto')
      const hidden = await call('docs_mover', { documento: 'Financeiro/a.md', pasta: 'RH-Interno' })
      const missing = await call('docs_mover', { documento: 'Financeiro/a.md', pasta: 'Nao-existe' })
      const readOnly = await call('docs_mover', { documento: 'Financeiro/a.md', pasta: 'Empresa' })
      for (const r of [hidden, missing, readOnly]) {
        expect(r.error).toBe(true)
        expect(r.text).toBe(missing.text)
      }
      expect(hidden.text).not.toContain('RH')
      expect(find('a.md')?.folderId).toBe(fin.id)
    })

    it('refuses a document in a folder it can only read', async () => {
      mk('Contratos')
      const company = docs.index.folders().find((f) => f.name === 'Empresa')!
      await put(company, 'regras.md', 'Regras da casa')
      const r = await call('docs_mover', { documento: 'Empresa/regras.md', pasta: 'Contratos' })
      expect(r.error).toBe(true)
      expect(r.text).toContain('Esse documento não existe, ou você não tem acesso a ele.')
      expect(find('regras.md')?.folderId).toBe(company.id)
    })

    it('moving into an approval folder makes what an agent moves wait for a person', async () => {
      const fin = mk('Financeiro')
      mk('Contratos', { needsApproval: true })
      await put(fin, 'a.md', 'texto')
      await call('docs_mover', { documento: 'Financeiro/a.md', pasta: 'Contratos' })
      expect(find('a.md')?.status).toBe('review')
    })

    it('asks for the document and the destination', async () => {
      const r = await call('docs_mover', { documento: 'a.md' })
      expect(r.error).toBe(true)
      expect(r.text).toBe('Faltou o documento ou a pasta de destino.')
    })
  })

  describe('what a tool never says', () => {
    it('keeps the documents root path out of every result, even when a file vanished from the disk', async () => {
      const fin = mk('Financeiro')
      mk('Contratos')
      const d = await put(fin, 'a.md', 'texto')
      const results = [
        await call('docs_listar', { pasta: 'Nao-existe' }),
        await call('docs_ler', { documento: 'Nao-existe.md' }),
        await call('docs_buscar', { busca: 'texto' })
      ]
      rmSync(docs.filePath(d)!)
      results.push(await call('docs_ler', { documento: 'Financeiro/a.md' }))
      const moved = await call('docs_mover', { documento: 'Financeiro/a.md', pasta: 'Contratos' })
      results.push(moved)
      expect(moved.error).toBe(true)
      expect(moved.text).toBe('Não consegui mexer neste arquivo agora. Tente de novo.')
      expect(JSON.stringify(results)).not.toContain(root)
      expect(JSON.stringify(results)).not.toContain('documents')
    })

    it('Docs.cleanError turns a file-system error into plain words and strips the root from any other', () => {
      expect(docs.cleanError(new Error(`ENOENT: no such file or directory, open '${docs.root}/x.md'`))).toBe('Não consegui mexer neste arquivo agora. Tente de novo.')
      expect(docs.cleanError(new Error(`falhou em ${docs.root}/Financeiro/x.md`))).not.toContain(root)
    })
  })
})
