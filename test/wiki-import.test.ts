import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { linksIn, Wiki } from '../src/core/wiki'

const vault = (): string => {
  const v = mkdtempSync(join(tmpdir(), 'cofre-'))
  const w = (rel: string, text: string): void => (mkdirSync(join(v, rel, '..'), { recursive: true }), writeFileSync(join(v, rel), text))
  w('.obsidian/app.json', '{}')
  w('Anexos/planta.png', 'png')
  w('Clientes/Marcos Lima.md', '---\ntags:\n  - cliente\n  - reforma\naliases:\n  - Marcos\n---\nCliente da [[Projetos/Reforma do 302|reforma]], indicado pela [[Construtora Alpha]].\n\n![[planta.png]]\n')
  w('Projetos/Reforma do 302.md', '---\ncliente: "[[Marcos Lima]]"\n---\nA obra. Ver [[Prazos#Apartamentos]].\n')
  w('Construtora Alpha.md', '---\ntags: [fornecedor]\n---\nParceira.\n')
  w('Prazos.md', 'Sem cabeçalho. [[Orçamento da Beta]].\n')
  return v
}
const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  return w
}

describe('an Obsidian vault', () => {
  it('reads links the way Obsidian does', () => {
    expect(linksIn('[[Clientes/Marcos Lima|Marcos]] [[Prazos#Casas]] [[Nota.md]] ![[foto.png]] ![[Outra nota]]')).toEqual(['Marcos Lima', 'Prazos', 'Nota', 'Outra nota'])
  })

  it('comes in as it is: folders, links, attachments, kinds; the vault stays untouched', () => {
    const v = vault()
    const before = readFileSync(join(v, 'Clientes/Marcos Lima.md'), 'utf8')
    const w = fresh()
    const r = w.importVault(v, 'Ana')
    expect(r).toMatchObject({ pages: 4, attachments: 1, skipped: [], missing: 1 })
    expect(Object.fromEntries(r.kinds)).toEqual({ Clientes: 1, Projetos: 1, Fornecedor: 1, Outros: 1 })
    const marcos = w.page('Marcos Lima')!
    expect(marcos.file).toBe('pages/Clientes/Marcos Lima.md')
    expect(marcos.links).toEqual(['Reforma do 302', 'Construtora Alpha'])
    // the link in the project's properties counts as a link back
    expect(marcos.backlinks).toEqual(['Reforma do 302'])
    expect(w.page('Prazos')!.backlinks).toEqual(['Reforma do 302'])
    expect(w.search('parceira')[0]!.title).toBe('Construtora Alpha')
    expect(w.history('Marcos Lima')[0]).toMatchObject({ by: 'import', action: 'create' })
    expect(readFileSync(join(v, 'Clientes/Marcos Lima.md'), 'utf8')).toBe(before)
    // again: what's already here is left alone
    expect(w.importVault(v, 'Ana')).toMatchObject({ pages: 0, skipped: expect.arrayContaining(['Clientes/Marcos Lima.md']) })
  })

  it('an edit keeps the frontmatter it had and the folder the note is in', () => {
    const w = fresh()
    w.importVault(vault(), 'Ana')
    const p = w.page('Marcos Lima')!
    w.save({ title: 'Marcos Lima', body: p.body + '\n## Contato\n- (41) 99999-0000', kind: p.kind, expectedHash: p.hash, by: 'me', byName: 'Ana' })
    const text = readFileSync(join(w.dir, 'pages/Clientes/Marcos Lima.md'), 'utf8')
    expect(text).toMatch(/^---\ntags:\n {2}- cliente\n {2}- reforma\naliases:\n {2}- Marcos\n---\n/)
    expect(text).not.toContain('tipo:')
    expect(text).toContain('## Contato')
    // renamed: still in its folder
    w.save({ title: 'Marcos A. Lima', rename: 'Marcos Lima', body: w.page('Marcos Lima')!.body, by: 'me', byName: 'Ana' })
    expect(w.page('Marcos A. Lima')!.file).toBe('pages/Clientes/Marcos A. Lima.md')
  })

  it('a vault can also be the wiki itself, in place', () => {
    const v = vault()
    const w = new Wiki({ dir: v, indexPath: join(mkdtempSync(join(tmpdir(), 'idx-')), 'wiki.db') })
    w.init(false)
    expect(w.count()).toBe(4)
    expect(w.page('Reforma do 302')!.file).toBe('Projetos/Reforma do 302.md')
  })

  it('refuses a folder with no notes, or the wiki itself', () => {
    const w = fresh()
    expect(() => w.importVault(mkdtempSync(join(tmpdir(), 'vazio-')), 'Ana')).toThrow('.md')
    expect(() => w.importVault(w.dir, 'Ana')).toThrow()
  })
})
