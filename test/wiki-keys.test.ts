// One canonical key per page (its file name's, case folded, NFC): what's held, where a page came
// from and its history all go by it, so no spelling of a title reads around them.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { pageKey, Wiki } from '../src/core/wiki'

const roots: string[] = []
// Best effort: on Windows a database still open keeps its folder busy.
afterAll(() => roots.forEach((r) => { try { rmSync(r, { recursive: true, force: true }) } catch {} }))
const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wikikeys-'))
  roots.push(root)
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db'), dmOf: (id) => (id === 'dm1' ? 'ana' : null) })
  w.init(false)
  return w
}
// A page the curator wrote from Ana's DM, while she was alone.
const fromDm = (w: Wiki, title: string, body = 'segredo do DM'): void => {
  const src = w.addSource({ title: 'trecho', text: body, kind: 'conversation', origin: { conversationId: 'dm1' }, by: 'auto' })
  w.save({ title, body, by: 'auto', byName: 'Curador', sourceId: src.id })
}

describe('pageKey', () => {
  it('is the same for every spelling of one file name', () => {
    const k = pageKey('Plano A-B')
    for (const t of ['Plano A/B', ' plano a:b', 'Plano A-B\n', '\tPLANO A-B', 'Plano  A-B']) expect(pageKey(t)).toBe(k)
    expect(pageKey('Café'.normalize('NFD'))).toBe(pageKey('Café'))
  })
})

describe('pages held by the canonical key', () => {
  it('a DM page titled with "/" or ":" is held', () => {
    const w = fresh()
    fromDm(w, 'Plano A/B')
    fromDm(w, 'Hora: 10h')
    w.inherit('ana', 1)
    expect(w.held('ana').map((h) => h.title).sort()).toEqual(['Hora- 10h', 'Plano A-B'])
  })

  it("another person can't read a held page by any spelling", () => {
    const w = fresh()
    fromDm(w, 'Orcamento Zeta')
    fromDm(w, 'Café da Ana')
    w.inherit('ana', 1)
    const bia = w.view(w.heldTitles('bia'))
    for (const t of [' Orcamento Zeta', 'Orcamento Zeta\n', '\tOrcamento Zeta', 'ORCAMENTO ZETA', 'Orcamento  Zeta']) expect(bia.page(t)).toBeUndefined()
    expect(bia.page('Café da Ana'.normalize('NFD'))).toBeUndefined()
    expect(bia.search('segredo').map((h) => h.title)).toEqual([])
  })

  it('a renamed held page leaves no history under its old title; its versions go with it', () => {
    const w = fresh()
    fromDm(w, 'Viagem Lisboa')
    w.inherit('ana', 1)
    w.save({ title: 'Viagem nova', rename: 'Viagem Lisboa', body: 'outro texto', by: 'ana', byName: 'Ana' })
    expect(w.history('Viagem Lisboa')).toEqual([])
    const moved = w.history('Viagem nova')
    expect(moved.some((v) => v.after?.includes('segredo do DM'))).toBe(true)
    // the old version is held as the page is
    const old = moved.find((v) => v.after?.includes('segredo do DM'))!
    expect(w.heldTitles('bia').has(w.versionInfo(old.id)!.key)).toBe(true)
    // restoring it puts it back on the page as it's called now, not under the old title
    w.restore(old.id, 'ana', 'Ana')
    expect(w.page('Viagem Lisboa')).toBeUndefined()
    expect(w.page('Viagem nova')?.body).toContain('segredo do DM')
    expect(w.view(w.heldTitles('bia')).recent(50).map((r) => r.title)).toEqual([])
  })

  it('two titles of one file never overwrite each other', () => {
    const w = fresh()
    w.save({ title: 'A-b', body: 'primeira', by: 'ana', byName: 'Ana' })
    expect(() => w.save({ title: 'A/b', body: 'outra', by: 'bia', byName: 'Bia' })).toThrow(/Já existe|already/)
    expect(() => w.save({ title: 'a-B', body: 'outra', by: 'bia', byName: 'Bia' })).toThrow(/Já existe|already/)
    expect(w.page('A-b')?.body).toContain('primeira')
    // the same title, as before, is an edit
    w.save({ title: 'A-b', body: 'segunda', by: 'ana', byName: 'Ana' })
    expect(w.page('A-b')?.body).toContain('segunda')
    // NFD and NFC are one title: one page, never two files
    w.save({ title: 'Café', body: 'nfc', by: 'ana', byName: 'Ana' })
    w.save({ title: 'Café'.normalize('NFD'), body: 'nfd', by: 'ana', byName: 'Ana' })
    expect(w.list().filter((p) => pageKey(p.title) === pageKey('Café')).map((p) => p.title)).toEqual(['Café'])
  })

  it('deleting a held page clears what was held; a new page with that name is seen, its old history is not', () => {
    const w = fresh()
    fromDm(w, 'Rota K')
    w.inherit('ana', 1)
    w.remove('Rota K', 'ana', 'Ana')
    expect(w.heldTitles('bia').size).toBe(0)
    w.save({ title: 'Rota K', body: 'do time', by: 'bia', byName: 'Bia' })
    const bia = w.view(w.heldTitles('bia'), { viewer: 'bia' })
    expect(bia.page('Rota K')?.body).toContain('do time')
    expect(w.history('Rota K', () => true, 0, 'bia').some((v) => (v.before ?? '').includes('segredo') || (v.after ?? '').includes('segredo'))).toBe(false)
    expect(w.history('Rota K', () => true, 0, 'ana').some((v) => (v.before ?? '').includes('segredo'))).toBe(true)
  })

  it("the log, for someone else, starts at the switch and leaves out the held pages' lines", () => {
    const w = fresh()
    w.save({ title: 'Rascunho solo', body: 'x', by: 'ana', byName: 'Ana' })
    w.remove('Rascunho solo', 'ana', 'Ana')
    fromDm(w, 'Plano A/B')
    w.inherit('ana', 1)
    w.save({ title: 'Plano A-B', body: 'editado depois', by: 'ana', byName: 'Ana' })
    w.save({ title: 'Mural', body: 'do time', by: 'bia', byName: 'Bia' })
    const log = w.view(w.heldTitles('bia'), { viewer: 'bia', afterSwitch: true }).log()
    expect(log.join('\n')).not.toMatch(/Rascunho solo|Plano A/)
    expect(log.join('\n')).toContain('Mural')
    expect(w.log().join('\n')).toContain('Rascunho solo') // the owner's whole log
  })
})
