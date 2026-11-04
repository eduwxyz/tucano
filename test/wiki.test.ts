import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileOf, linksIn, parsePage, summaryOf, Wiki, WikiConflict, wikiCall } from '../src/core/wiki'
import { wikiAccess } from '../src/shared/types'

const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  return w
}
const by = { by: 'me', byName: 'Ana' }

describe('the wiki folder', () => {
  it('starts with the schema, the log and the index, as Obsidian opens them', () => {
    const w = fresh()
    for (const f of ['esquema.md', 'registro.md', 'índice.md', 'pages']) expect(existsSync(join(w.dir, f))).toBe(true)
    expect(w.schema()).toContain('Tipos de página')
  })

  it('keeps a page as a Markdown file with frontmatter, and lists it in the index and the log', () => {
    const w = fresh()
    const p = w.save({ title: 'Marcos Lima', kind: 'Pessoa', body: 'Cliente da reforma do apto 302.\n\nQuer começar em janeiro.', ...by })
    const text = readFileSync(join(w.dir, 'pages', 'Marcos Lima.md'), 'utf8')
    expect(parsePage(text).meta).toMatchObject({ tipo: 'Pessoa' })
    expect(parsePage(text).body).toContain('Quer começar em janeiro.')
    expect(p).toMatchObject({ title: 'Marcos Lima', kind: 'Pessoa', summary: 'Cliente da reforma do apto 302.', updatedBy: 'me' })
    expect(w.indexText()).toContain('- [[Marcos Lima]]: Cliente da reforma do apto 302.')
    expect(w.log()[0]).toContain('**Ana** criou [[Marcos Lima]]')
  })

  it('finds pages by words, with or without accents', () => {
    const w = fresh()
    w.save({ title: 'Reforma do apto 302', kind: 'Projeto', body: 'Orçamento aprovado: R$ 12.960, em 3 vezes.', ...by })
    w.save({ title: 'Viagem a Morretes', kind: 'Projeto', body: 'Trem pela Serra do Mar.', ...by })
    expect(w.search('orcamento').map((h) => h.title)).toEqual(['Reforma do apto 302'])
    expect(w.search('ORÇAMENTO aprovado')[0]!.snippet).toContain('**')
    expect(w.search('morretes')[0]!.title).toBe('Viagem a Morretes')
    expect(w.search('nada disso')).toEqual([])
  })

  it('knows what links to a page, and which links have no page yet', () => {
    const w = fresh()
    w.save({ title: 'Marcos Lima', kind: 'Pessoa', body: 'Cliente.', ...by })
    w.save({ title: 'Reforma do apto 302', kind: 'Projeto', body: 'De [[Marcos Lima]], com a [[Construtora Alpha]]. `[[não é link]]`', ...by })
    expect(w.page('marcos lima')!.backlinks).toEqual(['Reforma do apto 302'])
    expect(w.page('Reforma do apto 302')!.missing).toEqual(['Construtora Alpha'])
  })

  it('refuses a save made on an older copy of the page', () => {
    const w = fresh()
    const p = w.save({ title: 'Marcos Lima', body: 'v1', ...by })
    w.save({ title: 'Marcos Lima', body: 'v2', expectedHash: p.hash, ...by })
    expect(() => w.save({ title: 'Marcos Lima', body: 'v3', expectedHash: p.hash, ...by })).toThrow(WikiConflict)
    expect(w.page('Marcos Lima')!.body).toContain('v2')
  })

  it('picks up a page changed outside Tucano, and keeps it in the history', () => {
    const w = fresh()
    w.save({ title: 'Marcos Lima', body: 'Cliente.', ...by })
    writeFileSync(join(w.dir, 'pages', 'Marcos Lima.md'), '---\ntipo: Pessoa\n---\n\nCliente desde março.\n')
    writeFileSync(join(w.dir, 'pages', 'Nova.md'), 'Escrita no Obsidian.\n')
    expect(w.scan()).toBe(true)
    expect(w.page('Marcos Lima')!.body).toContain('desde março')
    expect(w.history('Marcos Lima')[0]).toMatchObject({ by: 'outside', action: 'edit' })
    expect(w.search('obsidian')[0]!.title).toBe('Nova')
    expect(w.scan()).toBe(false) // nothing new the second time
  })

  it('renames a page, deletes it, and brings it back from its history', () => {
    const w = fresh()
    const p = w.save({ title: 'Marcos', body: 'Cliente.', ...by })
    w.save({ title: 'Marcos Lima', body: 'Cliente.', rename: 'Marcos', expectedHash: p.hash, ...by })
    expect(w.list().map((x) => x.title)).toEqual(['Marcos Lima'])
    w.remove('Marcos Lima', 'me', 'Ana')
    expect(w.page('Marcos Lima')).toBeUndefined()
    const del = w.history('Marcos Lima').find((v) => v.action === 'delete')!
    expect(w.restore(del.id, 'me', 'Ana').body).toContain('Cliente.')
  })
})

describe('the agents and the wiki', () => {
  it('reads the index, searches and opens a page, and says when it is not there', () => {
    const w = fresh()
    w.save({ title: 'Marcos Lima', kind: 'Pessoa', body: 'Quer começar a reforma em janeiro.', ...by })
    expect(wikiCall(w, 'wiki_indice', {}).text).toContain('[[Marcos Lima]]')
    expect(wikiCall(w, 'wiki_buscar', { busca: 'reforma janeiro' }).text).toContain('- [[Marcos Lima]] (Pessoa)')
    expect(wikiCall(w, 'wiki_ler', { pagina: '[[Marcos Lima]]' }).text).toContain('Quer começar a reforma em janeiro.')
    expect(wikiCall(w, 'wiki_ler', { pagina: 'Ninguém' }).error).toBe(true)
    expect(wikiCall(w, 'wiki_buscar', { busca: 'pizza' }).text).toContain('não invente')
  })

  it('every agent reads the wiki unless told otherwise; the Tuca does not', () => {
    expect(wikiAccess({})).toBe('read')
    expect(wikiAccess({ wiki: 'none' })).toBe('none')
    expect(wikiAccess({ kind: 'tuca' })).toBe('none')
  })

  it('parses the bits a page is made of', () => {
    expect(linksIn('[[A]] e [[B|bê]] e [[C#seção]] ```[[D]]```')).toEqual(['A', 'B', 'C'])
    expect(summaryOf('# Título\n\n- **Cliente** de [[Marcos Lima|Marcos]].')).toBe('Cliente de Marcos.')
    expect(fileOf('a/b: c?')).toBe('a-b- c-.md')
  })
})
