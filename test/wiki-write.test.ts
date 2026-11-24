// An agent given "read and write" keeps the wiki itself: wiki_escrever creates a page or adds to it,
// wiki_editar swaps a passage. Nothing replaces a page whole, a passage that moved is refused instead
// of guessed, a wiki that takes no writes says why, and a page held for someone else isn't touched.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Wiki, wikiCall, wikiToolsFor, wikiWrite, WIKI_WRITE_TOOLS } from '../src/core/wiki'
import { wikiAccess, wikiWrites } from '../src/shared/types'

const fresh = (readOnly?: () => string | undefined): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-w-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), ...(readOnly ? { readOnly } : {}) })
  w.init(false)
  return w
}
const by = { by: 'me', byName: 'Ana' }
const ana = { id: 'a1', name: 'Lia' }
const open = (): boolean => true
const shut = (): boolean => false

describe('the level an agent has, and the tools that come with it', () => {
  it('reads by default, and may write only when told to', () => {
    expect(wikiAccess({})).toBe('read')
    expect(wikiWrites({})).toBe(false)
    expect(wikiAccess({ wiki: 'read_write' })).toBe('read_write')
    expect(wikiWrites({ wiki: 'read_write' })).toBe(true)
    expect(wikiAccess({ wiki: 'read_write', kind: 'tuca' })).toBe('none') // the Tuca belongs to the app, not the wiki
  })

  it('hands out three tools for reading and five for reading and writing', () => {
    expect(wikiToolsFor('none').map((t) => t.name)).toEqual([])
    expect(wikiToolsFor('read').map((t) => t.name)).toEqual(['wiki_indice', 'wiki_buscar', 'wiki_ler'])
    expect(wikiToolsFor('read_write').map((t) => t.name)).toEqual(['wiki_indice', 'wiki_buscar', 'wiki_ler', 'wiki_escrever', 'wiki_editar'])
    for (const t of WIKI_WRITE_TOOLS) expect(t.description.length).toBeGreaterThan(40)
  })
})

describe('an agent writing in the wiki', () => {
  it('creates a page, with the kind it asked for, and the agent as its author', () => {
    const w = fresh()
    const r = wikiWrite(w, ana, 'wiki_escrever', { pagina: 'Reforma do apto 302', texto: 'Orçamento aprovado em 3 vezes.', tipo: 'Projeto' }, open)
    expect(r.error).toBeUndefined()
    expect(r.step).toEqual({ label: 'Criou na wiki', detail: 'Reforma do apto 302' })
    const p = w.page('Reforma do apto 302')!
    expect(p.kind).toBe('Projeto')
    expect(p.body).toContain('Orçamento aprovado em 3 vezes.')
    expect(p.updatedBy).toBe('a1') // the agent's own id: the screen shows its face and name
    expect(w.history('Reforma do apto 302')[0]).toMatchObject({ by: 'a1', action: 'create' })
    expect(w.log()[0]).toContain('**Lia** criou [[Reforma do apto 302]]')
  })

  it('adds to the end of a page that exists instead of writing over it', () => {
    const w = fresh()
    w.save({ title: 'Marcos Lima', kind: 'Pessoa', body: 'Cliente da reforma.', ...by })
    const r = wikiWrite(w, ana, 'wiki_escrever', { pagina: '[[Marcos Lima]]', texto: 'Fechou em 12 de novembro.' }, open)
    expect(r.error).toBeUndefined()
    expect(r.step.detail).toBe('Marcos Lima')
    expect(w.page('Marcos Lima')!.body.trim()).toBe('Cliente da reforma.\n\nFechou em 12 de novembro.')
    expect(w.history('Marcos Lima')[0]).toMatchObject({ by: 'a1', action: 'edit' })
  })

  it('puts it under a section, making the section when it is not there', () => {
    const w = fresh()
    w.save({ title: 'Marcos Lima', kind: 'Pessoa', body: 'Cliente.\n\n## Conversas\nFalamos em outubro.', ...by })
    expect(wikiWrite(w, ana, 'wiki_escrever', { pagina: 'Marcos Lima', secao: 'Conversas', texto: 'Falamos em novembro.' }, open).error).toBeUndefined()
    expect(w.page('Marcos Lima')!.body.trim()).toBe('Cliente.\n\n## Conversas\nFalamos em outubro.\nFalamos em novembro.')
    expect(wikiWrite(w, ana, 'wiki_escrever', { pagina: 'Marcos Lima', secao: 'Pagamentos', texto: 'Três parcelas.' }, open).error).toBeUndefined()
    expect(w.page('Marcos Lima')!.body).toContain('## Pagamentos\nTrês parcelas.')
  })

  it('corrects a passage that is still there, and refuses one that has gone', () => {
    const w = fresh()
    w.save({ title: 'Reforma', kind: 'Projeto', body: 'Começa em dezembro.', ...by })
    const r = wikiWrite(w, ana, 'wiki_editar', { pagina: 'Reforma', antigo: 'dezembro', novo: 'janeiro' }, open)
    expect(r.error).toBeUndefined()
    expect(r.step.label).toBe('Corrigiu na wiki')
    expect(w.page('Reforma')!.body.trim()).toBe('Começa em janeiro.')
    const gone = wikiWrite(w, ana, 'wiki_editar', { pagina: 'Reforma', antigo: 'dezembro', novo: 'março' }, open)
    expect(gone.error).toBe(true)
    expect(gone.text).toBe('O trecho a trocar não está mais em "Reforma".') // the passage moved: refused, never guessed
    expect(w.page('Reforma')!.body.trim()).toBe('Começa em janeiro.') // untouched
  })

  it('says it has no page to correct, and how to write one', () => {
    const w = fresh()
    const r = wikiWrite(w, ana, 'wiki_editar', { pagina: 'Ninguém', antigo: 'a', novo: 'b' }, open)
    expect(r.error).toBe(true)
    expect(r.text).toContain('wiki_escrever')
  })

  it('asks for what it needs instead of writing an empty page', () => {
    const w = fresh()
    expect(wikiWrite(w, ana, 'wiki_escrever', { pagina: 'X' }, open)).toMatchObject({ error: true })
    expect(wikiWrite(w, ana, 'wiki_escrever', { texto: 'sem título' }, open)).toMatchObject({ error: true })
    expect(w.count()).toBe(0)
  })

  it('refuses a page that this conversation cannot read, and does not write it', () => {
    const w = fresh()
    w.save({ title: 'Diário', kind: 'Pessoa', body: 'Segredo.', ...by })
    const r = wikiWrite(w, ana, 'wiki_escrever', { pagina: 'Diário', texto: 'Mais.' }, shut)
    expect(r.error).toBe(true)
    expect(w.page('Diário')!.body.trim()).toBe('Segredo.')
  })

  it('takes no writes from anyone when the wiki is read-only, and says why', () => {
    const w = fresh(() => 'a chave do repositório só lê')
    const r = wikiWrite(w, ana, 'wiki_escrever', { pagina: 'Nova', texto: 'Texto.' }, open)
    expect(r.error).toBe(true)
    expect(r.text).toContain('só lê')
    expect(w.page('Nova')).toBeUndefined()
  })

  it('what it writes is there for the reading tools, index and search alike', () => {
    const w = fresh()
    wikiWrite(w, ana, 'wiki_escrever', { pagina: 'Morretes', texto: 'Trem pela Serra do Mar em fevereiro.', tipo: 'Projeto' }, open)
    expect(wikiCall(w, 'wiki_indice', {}).text).toContain('[[Morretes]]')
    expect(wikiCall(w, 'wiki_buscar', { busca: 'serra do mar' }).text).toContain('[[Morretes]]')
    expect(w.count()).toBe(1)
  })
})

describe('what the agent is told about the wiki it may write', () => {
  const settings = { workspaceName: 'Ana', context: '' }
  it('tells a reader it only reads, and names the curator', async () => {
    const { liveContext } = await import('../src/core/context')
    const text = liveContext({ settings, wiki: { pages: 4, kinds: ['Pessoa'] } })
    expect(text).toContain('Você só lê a wiki')
    expect(text).not.toContain('wiki_escrever')
  })

  it('tells a writer which tools write, and that it may start an empty wiki', async () => {
    const { liveContext } = await import('../src/core/context')
    const text = liveContext({ settings, wiki: { pages: 0, kinds: [], write: true } })
    expect(text).toContain('ainda sem páginas')
    expect(text).toContain('wiki_escrever')
    expect(text).toContain('wiki_editar')
    expect(text).not.toContain('Você só lê a wiki')
  })
})
