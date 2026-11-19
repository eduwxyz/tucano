import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pageKey, Wiki, wikiWrite } from '../src/core/wiki'

const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-write-privacy-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), dmOf: (id) => id === 'dm-ana' ? 'ana' : null })
  w.init(false)
  return w
}
const agent = { id: 'lia', name: 'Lia' }
const write = (w: Wiki, conversationId: string, title = 'Plano privado'): void => {
  const result = wikiWrite(w, agent, 'wiki_escrever', { pagina: title, texto: 'Segredo da Ana.' }, () => true, { conversationId })
  expect(result.error).toBeUndefined()
}

describe('where an agent wiki write came from', () => {
  it('holds a solo DM write for its person when the workspace becomes a team', () => {
    const w = fresh()
    write(w, 'dm-ana')
    w.inherit('ana')
    expect(w.heldTitles('bia').has(pageKey('Plano privado'))).toBe(true)
    expect(w.view(w.heldTitles('bia')).search('Segredo')).toEqual([])
    expect(w.view(w.heldTitles('ana')).page('Plano privado')?.body).toContain('Segredo')
  })

  it('holds a new DM page before the write is announced or sent to git', () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-write-publish-'))
    const published: string[][] = []
    const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), dmOf: () => 'ana', onWrite: () => published.push(w.heldFiles()) })
    w.init(false)
    w.inherit('ana')
    write(w, 'dm-ana')
    expect(published.at(-1)).toEqual(['pages/Plano privado.md'])
    expect(w.view(w.heldTitles('bia')).page('Plano privado')).toBeUndefined()
    expect(w.history('Plano privado')[0]).toMatchObject({ by: 'lia', action: 'create' })
  })

  it('holds an existing shared page when private text is appended or corrected', () => {
    const w = fresh()
    w.inherit('ana')
    w.save({ title: 'Projeto', body: 'Público.', by: 'ana', byName: 'Ana' })
    write(w, 'dm-ana', 'Projeto')
    expect(w.view(w.heldTitles('bia')).page('Projeto')).toBeUndefined()
    w.release('Projeto')
    const result = wikiWrite(w, agent, 'wiki_editar', { pagina: 'Projeto', antigo: 'Público.', novo: 'Privado.' }, () => true, { conversationId: 'dm-ana' })
    expect(result.error).toBeUndefined()
    expect(w.view(w.heldTitles('bia')).page('Projeto')).toBeUndefined()
  })

  it('keeps a channel write shared', () => {
    const w = fresh()
    w.inherit('ana')
    write(w, 'channel', 'Projeto compartilhado')
    expect(w.heldFiles()).toEqual([])
    expect(w.view(w.heldTitles('bia')).page('Projeto compartilhado')).toBeDefined()
  })

  it('reholds a released DM version when it is restored', () => {
    const w = fresh()
    w.inherit('ana')
    write(w, 'dm-ana')
    const version = w.history('Plano privado')[0]!
    w.release('Plano privado')
    w.save({ title: 'Plano privado', body: 'Do time.', by: 'ana', byName: 'Ana' })
    expect(w.restore(version.id, 'ana', 'Ana').reheld).toBe(true)
    expect(w.view(w.heldTitles('bia')).page('Plano privado')).toBeUndefined()
  })
})
