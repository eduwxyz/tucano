// An agent whose wiki access is "write" gets one tool more than the read-only ones: it creates a
// page, adds a stretch to a section of one, or swaps an exact passage. A new page goes in right
// away; changing one that exists waits for the person, as the curator's changes do, unless the
// settings let it go straight in. A page held for someone else isn't the agent's to write.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WIKI_TOOL_NAMES, Wiki, wikiCall, wikiTools, type WikiWrite } from '../src/core/wiki'

const fresh = (): Wiki => {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  return w
}
const write = (w: Wiki, over: Partial<WikiWrite> = {}): WikiWrite => ({ wiki: w, by: 'agent-herald-01', byName: 'Herald', auto: false, visible: () => true, ...over })
const call = (w: Wiki, name: string, args: Record<string, unknown>, over?: Partial<WikiWrite>) => wikiCall(w, name, args, write(w, over))

describe('the tools an access gives', () => {
  it('adds the writing tool only for an agent that writes, and none at all without access', () => {
    expect(wikiTools('write').map((t) => t.name)).toEqual(['wiki_indice', 'wiki_buscar', 'wiki_ler', 'wiki_escrever'])
    expect(wikiTools('read').map((t) => t.name)).not.toContain('wiki_escrever')
    expect(wikiTools('none')).toEqual([])
  })

  it('knows the writing name is a wiki tool, so the runner hands it to the wiki', () => {
    expect(WIKI_TOOL_NAMES.has('wiki_escrever')).toBe(true)
    expect(WIKI_TOOL_NAMES.has('wiki_ler')).toBe(true)
  })
})

describe('an agent writing a page', () => {
  it('creates a page right away, with the agent kept as whoever wrote it', () => {
    const w = fresh()
    const r = call(w, 'wiki_escrever', { pagina: 'OpenLibExtended', texto: 'A CLI de livros, em 1.8.2.', motivo: 'a revisão pediu' })
    expect(r.error).toBeUndefined()
    expect(r.text).toContain('[[OpenLibExtended]]')
    expect(w.page('OpenLibExtended')?.body).toContain('A CLI de livros, em 1.8.2.')
    expect(w.page('OpenLibExtended')?.updatedBy).toBe('agent-herald-01')
    expect(w.changes('pending')).toHaveLength(0) // nothing was left waiting
    expect(w.changes()[0]?.state).toBe('applied')
    expect(w.log()[0]).toContain('**Herald** criou [[OpenLibExtended]]')
  })

  it('waits for the person when it changes a page that exists, and says so instead of pretending', () => {
    const w = fresh()
    w.save({ title: 'Silo', kind: 'Projeto', body: 'Servidor de mídia em casa.', by: 'me', byName: 'Ana' })
    const r = call(w, 'wiki_escrever', { pagina: 'Silo', texto: 'Usa o TerraMaster como DAS.' })
    expect(r.error).toBeUndefined()
    expect(w.page('Silo')?.body).not.toContain('TerraMaster')
    const pending = w.changes('pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ by: 'agent-herald-01', state: 'pending' })
    expect(r.text).toMatch(/aprova|approve/)
    expect(w.log()[0] ?? '').not.toContain('TerraMaster')
  })

  it('goes straight in when the settings are set to auto', () => {
    const w = fresh()
    w.save({ title: 'Silo', kind: 'Projeto', body: 'Servidor de mídia em casa.', by: 'me', byName: 'Ana' })
    const r = call(w, 'wiki_escrever', { pagina: 'Silo', texto: 'Usa o TerraMaster como DAS.' }, { auto: true })
    expect(r.error).toBeUndefined()
    expect(w.page('Silo')?.body).toContain('TerraMaster')
    expect(w.changes('pending')).toHaveLength(0)
  })

  it('adds the stretch inside the section it names, and at the end without one', () => {
    const w = fresh()
    w.save({ title: 'Silo', kind: 'Projeto', body: '## Servidor\n\nUm mini PC.\n\n## Plugins\n\nDois.', by: 'me', byName: 'Ana' })
    call(w, 'wiki_escrever', { pagina: 'Silo', texto: 'Quatro discos de 5 TB.', secao: 'Plugins' }, { auto: true })
    const body = w.page('Silo')!.body
    expect(body.indexOf('Quatro discos')).toBeGreaterThan(body.indexOf('## Plugins'))
    call(w, 'wiki_escrever', { pagina: 'Silo', texto: 'No fim.' }, { auto: true })
    expect(w.page('Silo')!.body.trimEnd().endsWith('No fim.')).toBe(true)
  })

  it('swaps an exact passage, and refuses when the passage is not on the page', () => {
    const w = fresh()
    w.save({ title: 'Silo', kind: 'Projeto', body: 'Roda no Windows.', by: 'me', byName: 'Ana' })
    const ok = call(w, 'wiki_escrever', { pagina: 'Silo', antigo: 'Roda no Windows.', novo: 'Roda no Windows, no WSL.' }, { auto: true })
    expect(ok.error).toBeUndefined()
    expect(w.page('Silo')?.body).toContain('no WSL')
    const no = call(w, 'wiki_escrever', { pagina: 'Silo', antigo: 'Roda no Linux.', novo: 'x' }, { auto: true })
    expect(no.error).toBe(true)
  })

  it('never writes a page kept for someone else', () => {
    const w = fresh()
    const r = call(w, 'wiki_escrever', { pagina: 'Diário', texto: 'algo' }, { visible: () => false })
    expect(r.error).toBe(true)
    expect(w.page('Diário')).toBeUndefined()
  })

  it('asks for what is missing instead of writing an empty page', () => {
    const w = fresh()
    expect(call(w, 'wiki_escrever', { pagina: '', texto: 'x' }).error).toBe(true)
    expect(call(w, 'wiki_escrever', { pagina: 'Vazio' }).error).toBe(true)
    expect(call(w, 'wiki_escrever', { pagina: 'Nenhuma', antigo: 'texto', novo: 'outro' }).error).toBe(true)
    expect(w.page('Vazio')).toBeUndefined()
  })

  it('takes the title with or without brackets, as it comes from a link', () => {
    const w = fresh()
    call(w, 'wiki_escrever', { pagina: '[[Founder Foundry agent]]', texto: 'Cuida do Foundry.' })
    expect(w.page('Founder Foundry agent')).toBeDefined()
  })

  it('reads as a read-only agent in a written reply, saying the access is what stopped it', () => {
    const w = fresh()
    const r = wikiCall(w, 'wiki_escrever', { pagina: 'X', texto: 'y' })
    expect(r.error).toBe(true)
    expect(r.text).toMatch(/escrever|write/)
    expect(w.page('X')).toBeUndefined()
  })
})
