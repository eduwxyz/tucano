import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

describe('reading the folder behind the window', () => {
  it('a start indexes the folder without blocking, then watches it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
    const dir = join(root, 'vault')
    mkdirSync(join(dir, '.obsidian'), { recursive: true })
    mkdirSync(join(dir, 'Clientes'))
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, 'Clientes', `Cliente ${i}.md`), `Cliente número ${i}, ligado a [[Cliente ${(i + 1) % 40}]].\n`)
    let changes = 0
    const w = new Wiki({ dir, indexPath: join(root, 'wiki.db'), onChange: () => changes++ })
    w.init(true, true)
    expect(w.list()).toEqual([]) // nothing read yet: init returned at once
    await w.loaded
    expect(w.list()).toHaveLength(40)
    expect(w.page('Cliente 3')?.kind).toBe('Clientes')
    expect(changes).toBe(1) // the screen hears that the pages came in
    w.close()

    // Opened again with nothing changed: no change to tell.
    const again = new Wiki({ dir, indexPath: join(root, 'wiki.db'), onChange: () => changes++ })
    again.init(false, true)
    await again.loaded
    expect(again.list()).toHaveLength(40)
    expect(changes).toBe(1)
    again.close()
  })

  it('what the app wrote after the folder was listed is not taken for a change from outside', () => {
    const w = fresh()
    w.save({ title: 'Antiga', body: 'v1', ...by })
    const listed: [string, number][] = [['Antiga.md', 1]] // as the folder was a moment ago
    w.save({ title: 'Antiga', body: 'v2', ...by, expectedHash: w.page('Antiga')!.hash })
    w.save({ title: 'Nova', body: 'escrita agora', ...by })
    const inner = w as unknown as { applyFiles: (found: [string, number][], late: boolean, logs: string[]) => boolean; removeMissing: (found: [string, number][], gone: Set<string>, late: boolean, logs: string[]) => boolean }
    expect(inner.applyFiles(listed, true, [])).toBe(false)
    expect(inner.removeMissing(listed, new Set(), true, [])).toBe(false)
    expect(w.page('Nova')?.body).toContain('escrita agora') // not dropped as gone from the folder
    expect(w.history('Antiga').every((v) => v.by !== 'outside')).toBe(true)
  })

  it('a page deleted after the folder was listed leaves the index', () => {
    const w = fresh()
    w.save({ title: 'Some', body: 'logo some', ...by })
    const listed: [string, number][] = [['Some.md', 1]]
    rmSync(join(w.dir, 'pages', 'Some.md'))
    const inner = w as unknown as { applyFiles: (found: [string, number][], late: boolean, logs: string[], gone: Set<string>) => boolean; removeMissing: (found: [string, number][], gone: Set<string>, late: boolean, logs: string[]) => boolean }
    const gone = new Set<string>()
    const logs: string[] = []
    inner.applyFiles(listed, true, logs, gone)
    expect(inner.removeMissing(listed, gone, true, logs)).toBe(true)
    expect(w.page('Some')).toBeUndefined()
    expect(logs).toEqual(['Some saiu da pasta'])
  })

  it('the map and the log are read again only after something changed', () => {
    const w = fresh()
    w.save({ title: 'A', body: 'liga a [[B]]', ...by })
    const g1 = w.graph()
    expect(w.graph()).toBe(g1)
    const log1 = w.log()
    expect(w.log()).toBe(log1)
    w.save({ title: 'B', body: 'agora existe', ...by })
    const g2 = w.graph()
    expect(g2).not.toBe(g1)
    expect(g2.nodes.find((n) => n.title === 'B')?.missing).toBeUndefined()
    expect(w.log()).not.toBe(log1)
    expect(w.log()[0]).toContain('B')
  })
})

describe('approving all that waits', () => {
  it('puts in every waiting change oldest first, makes again the ones that ran into the one before, and leaves what no longer fits', () => {
    const w = fresh()
    w.save({ title: 'Obra', body: 'Começa em janeiro.', ...by })
    const a = w.addChange({ ops: [{ op: 'append', page: 'Obra', text: 'Piso: porcelanato.' }], by: 'auto' })
    const b = w.addChange({ ops: [{ op: 'append', page: 'Obra', text: 'Pintura: branco gelo.' }], by: 'auto' })
    const gone = w.addChange({ ops: [{ op: 'replace', page: 'Obra', old: 'Começa em janeiro.', new: 'Começa em março.' }], by: 'auto' })
    const review = w.addChange({ ops: [{ op: 'append', page: 'Obra', text: 'Revisar.' }], by: 'review' })
    w.save({ title: 'Obra', body: 'Começa em fevereiro.', ...by, expectedHash: w.page('Obra')!.hash })
    expect(w.applyWaiting('Ana')).toEqual({ applied: 2, left: 1 })
    expect(w.page('Obra')!.body).toContain('Piso: porcelanato.')
    expect(w.page('Obra')!.body).toContain('Pintura: branco gelo.')
    expect(w.page('Obra')!.body).not.toContain('março')
    expect(w.change(gone.id)!.state).toBe('conflict')
    expect(w.change(review.id)!.state).toBe('pending')
    expect([a, b].map((c) => w.change(c.id)!.state)).toEqual(['refused', 'refused']) // made again, and those went in
  })
})
