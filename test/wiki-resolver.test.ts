import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { Wiki } from '../src/core/wiki'
import { parseResolution, WikiResolver } from '../src/core/wiki-resolver'

function wiki(): Wiki {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  const save = (title: string, body: string, kind = 'Projeto'): void => void w.save({ title, body, kind, by: 'me', byName: 'Ana' })
  save('Marcos Lima', 'Cliente da [[Reforma do apto 302]]. Indicado pela Construtora Alpha.', 'Pessoa')
  save('Reforma do apto 302', 'Do [[Marcos Lima]], com a Construtora Alpha.\n\n## Situação\nAguardando resposta do orçamento.\n\nVer [[Orçamento antigo]].')
  save('Andamento da obra', 'A obra do [[Marcos Lima]] começou em novembro.', 'Projeto')
  return w
}

// A finding as a review leaves it: no fix, only the pointing out.
function finding(w: Wiki, kind: 'contradiction' | 'stale' | 'orphan' = 'contradiction', pages = ['Reforma do apto 302', 'Andamento da obra']): string {
  w.setFindings([{ key: `${kind}:${pages.join('|')}`, kind, pages, text: 'Uma página diz que espera resposta, a outra que começou.' }])
  return w.findings().find((f) => f.kind === kind)!.id
}

const SETTINGS = (over: Partial<Settings> = {}): Settings => ({ workspaceName: 'Ana Ribeiro', wikiResolve: true, ...over }) as Settings

describe('the resolver of the wiki', () => {
  it("keeps the model's fix only where it fits the pages, and reads a question as a note", () => {
    const w = wiki()
    const fits = parseResolution(
      JSON.stringify({ mudancas: [{ op: 'replace', pagina: 'Reforma do apto 302', old: 'Aguardando resposta do orçamento.', new: 'Orçamento aprovado em 3 de novembro.' }], motivo: 'A obra começou.' }),
      w
    )
    expect(fits).toMatchObject({ ops: [{ op: 'replace', page: 'Reforma do apto 302', old: 'Aguardando resposta do orçamento.' }], reason: 'A obra começou.' })
    expect(fits!.note).toBeUndefined()
    // a passage that isn't on the page, and a page that doesn't exist, are dropped
    const broken = parseResolution(
      JSON.stringify({ mudancas: [{ op: 'replace', pagina: 'Reforma do apto 302', old: 'não está aqui', new: 'x' }, { op: 'append', pagina: 'Página que não existe', texto: 'oi' }], pergunta: 'Qual das duas vale?' }),
      w
    )
    expect(broken).toMatchObject({ ops: [], note: 'Qual das duas vale?' })
    // nothing usable at all: no answer
    expect(parseResolution('{"mudancas": [], "pergunta": ""}', w)).toBeNull()
    expect(parseResolution('nada de json', w)).toBeNull()
  })

  it('attaches a fix to the finding, waiting for the person, and writes nothing yet', async () => {
    const w = wiki()
    const id = finding(w)
    const r = new WikiResolver({
      wiki: w,
      settings: () => SETTINGS(),
      llm: async () =>
        JSON.stringify({ mudancas: [{ op: 'replace', pagina: 'Reforma do apto 302', old: 'Aguardando resposta do orçamento.', new: 'Orçamento aprovado em 3 de novembro.' }], motivo: 'A obra começou.' })
    })
    const answer = await r.resolve(id)
    expect(answer.change).toMatchObject({ state: 'pending', by: 'review' })
    expect(w.page('Reforma do apto 302')!.body).toContain('Aguardando resposta do orçamento.')
    const f = w.findings().find((x) => x.id === id)!
    expect(f.change).toMatchObject({ id: answer.change!.id })
    expect(f.note).toBeUndefined()
    // the person's approval is what writes it
    w.applyChange(answer.change!.id, 'Ana')
    expect(w.page('Reforma do apto 302')!.body).toContain('Orçamento aprovado em 3 de novembro.')
    expect(w.findings().some((x) => x.id === id)).toBe(false)
  })

  it('asks the one question it cannot answer, and keeps it next to the finding through later reviews', async () => {
    const w = wiki()
    const id = finding(w)
    const r = new WikiResolver({ wiki: w, settings: () => SETTINGS(), llm: async () => JSON.stringify({ mudancas: [], pergunta: 'O orçamento foi aprovado ou ainda espera resposta?', motivo: 'As duas páginas parecem certas.' }) })
    const answer = await r.resolve(id)
    expect(answer.change).toBeUndefined()
    expect(answer.note).toBe('O orçamento foi aprovado ou ainda espera resposta?')
    expect(w.findings().find((x) => x.id === id)!.note).toBe('O orçamento foi aprovado ou ainda espera resposta?')
    // nothing was written
    expect(w.page('Reforma do apto 302')!.body).toContain('Aguardando resposta do orçamento.')

    // a review says the same thing again under the same key: the question stays where it is
    const same = { kind: 'contradiction' as const, pages: ['Reforma do apto 302', 'Andamento da obra'], text: 'Uma página diz que espera resposta, a outra que começou.' }
    w.setFindings([{ key: 'contradiction:Reforma do apto 302|Andamento da obra', ...same }])
    const after = w.findings()
    expect(after).toHaveLength(1)
    expect(after[0]!.note).toBe('O orçamento foi aprovado ou ainda espera resposta?')
  })

  it("reads the whole page, not the fragments the review sees, and the sources it came from", async () => {
    const w = wiki()
    const long = `Do [[Marcos Lima]].\n\n${'Enchimento sem importância nenhuma. '.repeat(250)}\n\nO orçamento foi aprovado em 3 de novembro.`
    w.save({ title: 'Reforma do apto 302', body: long, by: 'me', byName: 'Ana' })
    // a source behind that page, through a change the curator made of it
    const src = w.addSource({ title: 'Conversa sobre o orçamento', text: 'Fechamos por 42 mil, o Marcos aprovou hoje.', kind: 'note', by: 'me', status: 'done' })
    const change = w.addChange({ ops: [{ op: 'append', page: 'Reforma do apto 302', section: 'Situação', text: 'Orçamento aprovado.' }], sourceId: src.id, by: 'auto' })
    w.applyChange(change.id, 'Ana')
    const id = finding(w)
    let prompt = ''
    const r = new WikiResolver({ wiki: w, settings: () => SETTINGS(), llm: async (_s, p) => ((prompt = p), JSON.stringify({ mudancas: [], pergunta: 'Qual vale?' })) })
    await r.resolve(id)
    // past the 4 000 characters the review slices a page at
    expect(prompt).toContain('O orçamento foi aprovado em 3 de novembro.')
    expect(prompt).toMatch(/## (As fontes de onde vieram|The sources they came from)/)
    expect(prompt).toContain('Fechamos por 42 mil')
    // the pages around the finding go in too
    expect(prompt).toContain('Andamento da obra')
  })

  it('is off unless Wiki settings say so, and leaves alone what already has a fix or no pages', async () => {
    const w = wiki()
    const id = finding(w)
    let calls = 0
    const llm = async (): Promise<string> => (calls++, JSON.stringify({ mudancas: [], pergunta: 'x' }))
    await expect(new WikiResolver({ wiki: w, settings: () => SETTINGS({ wikiResolve: false }), llm }).resolve(id)).rejects.toThrow(/desligado|resolver is off/)
    const r = new WikiResolver({ wiki: w, settings: () => SETTINGS(), llm })
    expect(r.canResolve(id)).toBe(true)
    await r.resolve(id)
    expect(calls).toBe(1)
    // a finding that already carries a fix isn't read again
    const withFix = w.findings()[0]!
    w.setFindings([{ key: 'contradiction:x', kind: 'contradiction', pages: ['Reforma do apto 302'], text: 'Outra.', ops: [{ op: 'append', page: 'Reforma do apto 302', section: 'Situação', text: 'Nota.' }] }])
    const fixed = w.findings().find((f) => f.change)!
    expect(withFix).toBeDefined()
    expect(await r.resolve(fixed.id)).toMatchObject({ change: fixed.change })
    expect(calls).toBe(1)
    // one that no longer exists
    expect(await r.resolve('nao-existe')).toEqual({ gone: true })
  })

  it('a model that answers in no usable form says so, and leaves the finding as it was', async () => {
    const w = wiki()
    const id = finding(w)
    const r = new WikiResolver({ wiki: w, settings: () => SETTINGS(), llm: async () => 'não sei' })
    await expect(r.resolve(id)).rejects.toThrow(/formato da wiki|no usable form/)
    expect(r.status().error).toBeTruthy()
    expect(w.findings().find((x) => x.id === id)!.note).toBeUndefined()
  })
})
