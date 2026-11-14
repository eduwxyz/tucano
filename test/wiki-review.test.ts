import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Settings } from '../src/shared/types'
import { Wiki } from '../src/core/wiki'
import { lint, logSections, namesIn, parseReview, WikiReviewer } from '../src/core/wiki-review'

function wiki(): Wiki {
  const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
  const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
  w.init(false)
  const save = (title: string, body: string, kind = 'Projeto'): void => void w.save({ title, body, kind, by: 'me', byName: 'Ana' })
  save('Marcos Lima', 'Cliente da [[Reforma do apto 302]]. Indicado pela Construtora Alpha.', 'Pessoa')
  save('Reforma do apto 302', 'Do [[Marcos Lima]], com a Construtora Alpha.\n\n## Situação\nAguardando resposta.\n\nVer [[Orçamento antigo]].')
  save('Valor do m² de projeto', 'R$ 180 por m². Vale pra obras da Construtora Alpha.', 'Decisão')
  save('Viagem a Morretes', 'Ana Ribeiro e a família, em dezembro.', 'Assunto')
  return w
}

describe('a review of the wiki', () => {
  it('finds broken links, names with no page and pages nothing links to', () => {
    const found = lint(wiki(), 'Ana Ribeiro')
    expect(found.find((f) => f.kind === 'broken')).toMatchObject({ name: 'Orçamento antigo', pages: ['Reforma do apto 302'] })
    expect(found.find((f) => f.kind === 'missing')).toMatchObject({ name: 'Construtora Alpha' })
    expect(found.find((f) => f.kind === 'missing')!.pages).toHaveLength(3)
    expect(found.filter((f) => f.kind === 'orphan').map((f) => [...f.pages].sort())).toEqual([['Valor do m² de projeto', 'Viagem a Morretes']])
    // the owner's own name isn't a missing page
    expect(found.some((f) => f.name?.includes('Ana'))).toBe(false)
  })

  it('a sentence that starts with a date is not a name, and a real name still is', () => {
    const root = mkdtempSync(join(tmpdir(), 'tucano-wiki-'))
    const w = new Wiki({ dir: join(root, 'wiki'), indexPath: join(root, 'wiki.db') })
    w.init(false)
    const save = (title: string, body: string): void => void w.save({ title, body, kind: 'Projeto', by: 'me', byName: 'Ana' })
    save('Reforma do apto 302', 'On Nov 10 Apo decided the Farm prep was rebuilt, with the Construtora Alpha e a Rosa Argentis. The Foundry runs the campaign.')
    save('Orçamento da obra', 'On Nov 10 Apo decided the Farm prep was rebuilt. A Construtora Alpha mandou o orçamento, com a Rosa Argentis. The Foundry hosts it.')
    save('Diário de obra', 'On Nov 10 Apo decided the Farm prep was rebuilt. A Rosa Argentis acompanha a obra da Construtora Alpha. The Foundry is the source.')
    save('Campanha de verão', 'Campanha Fev 2026 começa agora.')
    save('Campanha de inverno', 'Campanha Fev 2026 tem três lojas.')
    save('Campanha de outono', 'Campanha Fev 2026 fecha em dezembro.')
    const names = lint(w, 'Apo')
      .filter((f) => f.kind === 'missing')
      .map((f) => f.name)
      .sort()
    // the real names stay; the date that opens a sentence, the function word and the month don't
    expect(names).toEqual(['Construtora Alpha', 'Rosa Argentis'])
    expect(names).not.toContain('On Nov')
    expect(names).not.toContain('The Foundry')
    expect(names).not.toContain('Campanha Fev')
  })

  it('drops a candidate that opens with a function word or carries a month, and keeps the rest', () => {
    // the pair a sentence opens with is a date, not a name, in either language
    expect([...namesIn('On Nov 10 Apo decided the Farm prep was rebuilt.')]).toEqual([])
    expect([...namesIn('Em Dez 2026 a obra fecha.')]).toEqual([])
    expect([...namesIn('The Foundry runs on 30005.')]).toEqual([])
    expect([...namesIn('Whether Steward gets the receipt is still open.')]).toEqual([])
    // a month anywhere in the pair drops it too ("Campanha Fev"), in English and Portuguese
    expect([...namesIn('Campanha Fev 2026 começa. A Campanha March fecha.')]).toEqual([])
    // real names next to them stay
    expect([...namesIn('A Construtora Alpha e a Rosa Argentis fecharam com a Celaena Sardothien.')]).toEqual(['Construtora Alpha', 'Rosa Argentis', 'Celaena Sardothien'])
  })

  it('a dismissed finding the review no longer finds stops being carried', async () => {
    const w = wiki()
    const r = new WikiReviewer({ wiki: w, settings: () => ({ workspaceName: 'Ana Ribeiro' }) as Settings, llm: async () => JSON.stringify({ achados: [] }) })
    await r.review()
    w.dismissFinding(r.status().findings.find((f) => f.kind === 'missing')!.id)
    expect(r.status().findings.some((f) => f.kind === 'missing')).toBe(false)
    // the page gets written: the review no longer finds that name, so the silence goes with it
    w.save({ title: 'Construtora Alpha', body: 'Do [[Marcos Lima]].', kind: 'Empresa', by: 'me', byName: 'Ana' })
    await r.review()
    expect(r.status().findings.some((f) => f.kind === 'missing')).toBe(false)
    // taken away again, the name is a finding again: the dismissal didn't outlive the problem
    w.remove('Construtora Alpha', 'me', 'Ana')
    await r.review()
    expect(r.status().findings.find((f) => f.kind === 'missing')).toMatchObject({ name: 'Construtora Alpha' })
  })

  it("keeps the model's findings whose fix fits the pages", () => {
    const w = wiki()
    const out = parseReview(
      JSON.stringify({
        achados: [
          { tipo: 'desatualizada', paginas: ['Reforma do apto 302'], explicacao: 'A [[Reforma do apto 302]] diz que espera resposta.', mudancas: [{ op: 'replace', pagina: 'Reforma do apto 302', secao: 'raiz', old: 'Aguardando resposta.', new: 'Fechada.' }] },
          { tipo: 'contradição', paginas: ['Marcos Lima'], explicacao: 'Trecho que não está na página.', mudancas: [{ op: 'replace', pagina: 'Marcos Lima', old: 'não existe', new: 'x' }] },
          { tipo: 'outra coisa', paginas: [], explicacao: 'ignorado' }
        ]
      }),
      w
    )
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ kind: 'stale', ops: [{ op: 'replace', old: 'Aguardando resposta.' }], reason: 'A Reforma do apto 302 diz que espera resposta.' })
    expect(out[0]!.ops![0]!.section).toBeUndefined()
    // the swap with a passage that isn't there is dropped; the finding stays, to be read
    expect(out[1]).toMatchObject({ kind: 'contradiction' })
    expect(out[1]!.ops).toBeUndefined()
  })

  it('leaves everything waiting, and what was left alone or refused is not said again', async () => {
    const w = wiki()
    const answer = { achados: [{ tipo: 'desatualizada', paginas: ['Reforma do apto 302'], explicacao: 'Espera resposta, mas fechou.', mudancas: [{ op: 'replace', pagina: 'Reforma do apto 302', old: 'Aguardando resposta.', new: 'Fechada.' }] }] }
    const prompts: string[] = []
    const r = new WikiReviewer({ wiki: w, settings: () => ({ workspaceName: 'Ana Ribeiro' }) as Settings, llm: async (_s, p) => (prompts.push(p), JSON.stringify(answer)) })
    await r.review()
    const st = r.status()
    expect(st.at).toBeGreaterThan(0)
    const stale = st.findings.find((f) => f.kind === 'stale')!
    expect(stale.change).toMatchObject({ state: 'pending', by: 'review' })
    expect(w.page('Reforma do apto 302')!.body).toContain('Aguardando resposta.')
    expect(prompts[0]).toContain('### [[Reforma do apto 302]]')

    // refuse the fix, leave a broken link alone: the next review doesn't bring them back
    w.refuseChange(stale.change!.id)
    w.dismissFinding(st.findings.find((f) => f.kind === 'broken')!.id)
    w.save({ title: 'Reforma do apto 302', body: w.page('Reforma do apto 302')!.body + '\n\nObra em janeiro.', by: 'me', byName: 'Ana' })
    await r.review()
    const again = r.status().findings
    expect(again.some((f) => f.kind === 'stale' || f.kind === 'broken')).toBe(false)
    expect(again.some((f) => f.kind === 'missing')).toBe(true)
    // only what changed since the last review (and the pages around it) goes to the model
    expect(prompts[1]).toContain('Obra em janeiro')
    expect(prompts[1]).not.toContain('Viagem a Morretes')
  })

  it('an approved fix closes the finding; nothing changed means no model call', async () => {
    const w = wiki()
    let calls = 0
    const r = new WikiReviewer({ wiki: w, settings: () => ({ wikiReview: 'weekly' }) as Settings, llm: async () => (calls++, JSON.stringify({ achados: [{ tipo: 'desatualizada', paginas: ['Reforma do apto 302'], explicacao: 'Velha.', mudancas: [{ op: 'replace', pagina: 'Reforma do apto 302', old: 'Aguardando resposta.', new: 'Fechada.' }] }] })) })
    expect(r.due()).toBe(true)
    await r.review()
    expect(r.due()).toBe(false)
    const f = r.status().findings.find((x) => x.change)!
    w.applyChange(f.change!.id, 'Ana')
    expect(w.page('Reforma do apto 302')!.body).toContain('Fechada.')
    expect(r.status().findings.some((x) => x.id === f.id)).toBe(false)
    await r.review() // only the fix changed a page
    await r.review() // nothing changed
    expect(calls).toBe(2)
  })

  it('a model that fails keeps the mark, so the next review reads those pages again', async () => {
    const w = wiki()
    const r = new WikiReviewer({ wiki: w, settings: () => ({}) as Settings, llm: async () => { throw new Error('sem modelo') } })
    await r.review()
    expect(r.status()).toMatchObject({ error: 'sem modelo' })
    expect(r.status().at).toBeUndefined()
    expect(r.status().findings.some((f) => f.kind === 'broken')).toBe(true)
  })

  it('a history that grew into a log is pointed out, and the model is asked to condense it', async () => {
    const w = wiki()
    const diary = Array.from({ length: 9 }, (_, i) => `- ${i + 1}/11: a Lia conferiu a agenda e mandou um lembrete.`).join('\n')
    w.save({ title: 'Marcos Lima', body: `Cliente.\n\n## Histórico\n${diary}\n\n## Contato\n- (41) 99999-0000`, by: 'me', byName: 'Ana' })
    expect(logSections(w.page('Marcos Lima')!.body)).toEqual([{ section: 'Histórico', items: 9 }])
    expect(lint(w).find((f) => f.kind === 'log')).toMatchObject({ pages: ['Marcos Lima'] })
    // reviewed once: it still goes to the model next time, though it didn't change
    const prompts: string[] = []
    const answer = { achados: [{ tipo: 'registro', paginas: ['Marcos Lima'], explicacao: 'O histórico virou um diário.', mudancas: [{ op: 'replace', pagina: 'Marcos Lima', old: diary, new: '- Lembretes de agenda em novembro.' }] }] }
    const r = new WikiReviewer({ wiki: w, settings: () => ({}) as Settings, llm: async (_s, p) => (prompts.push(p), JSON.stringify(answer)) })
    w.setMeta('reviewed_at', String(Date.now() + 1000))
    await r.review()
    expect(prompts[0]).toContain('cara de registro')
    expect(prompts[0]).toContain('### [[Marcos Lima]]')
    const found = r.status().findings.filter((f) => f.kind === 'log')
    // the model's proposal, with its fix, takes the place of the count
    expect(found).toHaveLength(1)
    expect(found[0]!.change).toMatchObject({ state: 'pending', ops: [{ op: 'replace', new: '- Lembretes de agenda em novembro.' }] })
  })
})
