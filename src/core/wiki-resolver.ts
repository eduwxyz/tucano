// The wiki's resolver: a finding the review couldn't fix, read again properly. The review sees
// fragments of the pages under a budget, which is why it leaves a contradiction alone ("when unsure,
// just point it out"). This one gets the whole of the pages the finding is about, the pages around
// them and the sources they came from, and either writes the change package that settles it (the
// same shape as the review's, so it waits in the same card) or says what it couldn't settle and asks
// the one question only the person can answer. Built in, like the curator: no agent, no DM.
import { L, locale } from '../shared/lang'
import type { Settings, WikiChange, WikiFinding, WikiOp, WikiPage } from '../shared/types'
import { parseOps } from './wiki-curator'
import type { Wiki, WikiView } from './wiki'

const PAGE_CHARS = 14_000 // of a page, in the prompt: the whole of most of them
const MAX_CHARS = 90_000 // of pages and sources together, in one pass
const SOURCE_CHARS = 3_000
const MAX_SOURCES = 3
const NEAR_CHARS = 2_000 // of a page around the ones it's about

export interface ResolverDeps {
  wiki: Wiki
  settings: () => Settings
  // Already pointed at the model Wiki settings name for it (the memory's, then Haiku, when unset).
  llm: (system: string, prompt: string) => Promise<string>
}

export const resolverSystem = (): string =>
  L(
    `Você resolve um achado da wiki de um time: páginas em Markdown ligadas por [[Título]], cada uma um retrato de como as coisas estão.
Você recebe as páginas inteiras de que o achado trata, as páginas em volta delas e as fontes de onde essas páginas vieram. A revisão que achou isso leu só pedaços, e por isso não decidiu; você lê tudo.

Decida, com o que as páginas e as fontes dizem:
- Se um dos lados está certo (o mais novo, ou o que uma fonte sustenta), escreva a mudança que faz o outro dizer o mesmo: "replace" troca um trecho exato ("old" tem que estar na página, letra por letra) pelo certo ("new"); "append" acrescenta um trecho curto numa seção (a seção é criada se faltar).
- Se os dois lados são plausíveis, faça uma pergunta curta sobre o fato em que eles não batem: só o que a pessoa pode responder, nunca algo que as páginas já dizem.
- Se eles não se contradizem mais (um já foi atualizado, ou falam de coisas diferentes), diga isso no "motivo" e não mude nada.

Não invente. Não reescreva mais do que o fato em questão. Diga só o que as páginas e as fontes dizem; se elas não resolvem, pergunte.
Datas escritas por extenso ("12 de janeiro", nunca "12/01").

Responda só com JSON:
{"mudancas": [{"op": "replace"|"append"|"create", "pagina": "Título", "secao": "Seção", "texto": "markdown", "old": "trecho exato", "new": "trecho novo"}], "pergunta": "uma frase curta", "motivo": "uma frase"}`,
    `You settle a finding in a team's wiki: pages in Markdown linked with [[Title]], each one a picture of how things stand.
You get the whole of the pages the finding is about, the pages around them, and the sources those pages came from. The review that found it read only fragments, and so it didn't decide; you read all of it.

Decide, with what the pages and the sources say:
- If one side is right (the newer one, or the one a source backs), write the change that makes the other say the same: "replace" swaps an exact passage ("old" must be on the page, letter by letter) for the right one ("new"); "append" adds a short passage under a section (the section is made if missing).
- If both sides are plausible, ask one short question about the fact they disagree on: only what the person can answer, never anything the pages already say.
- If they don't disagree any more (one was already updated, or they talk about different things), say so in "reason" and change nothing.

Don't invent. Don't rewrite more than the fact in question. Say only what the pages and sources say; if they don't settle it, ask.
Dates written out ("Jan 12", never "12/01").

Reply with JSON only:
{"changes": [{"op": "replace"|"append"|"create", "page": "Title", "section": "Section", "text": "markdown", "old": "exact passage", "new": "new passage"}], "question": "one short sentence", "reason": "one sentence"}`
  )

export interface Resolution {
  ops: WikiOp[]
  reason: string
  note?: string // what it couldn't settle, or the question: nothing is written from it
}

const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')

// Lenient, as the curator's: a fence around the JSON, or a word before it, changes nothing.
export function parseResolution(text: string, wiki: Pick<WikiView, 'page'>): Resolution | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let v: Record<string, unknown>
  try {
    v = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  // A swap whose passage isn't on the page, or a change to a page that doesn't exist, is dropped: the
  // same rule the review follows, so a package never reaches a page it would break.
  const ops = parseOps(v['mudancas'] ?? v['changes'])
    .filter((op) => {
      const pg = op.op !== 'create' ? wiki.page(op.page) : undefined
      return !!pg && (op.op !== 'replace' || pg.body.includes(op.old!))
    })
    // a swap names no section of its own; one the page doesn't have ("raiz") says nothing
    .map(({ section, ...op }) => (section && op.op === 'append' ? { ...op, section } : op))
  const reason = str(v['motivo'] ?? v['reason'])
  const question = str(v['pergunta'] ?? v['question'])
  if (ops.length) return { ops, reason: reason || (question ? question : '') }
  const note = question || reason
  if (!note) return null
  return { ops: [], reason, note }
}

export class WikiResolver {
  private running = new Set<string>()
  private error: string | undefined

  constructor(private deps: ResolverDeps) {}

  status(): { running: string[]; error?: string } {
    return { running: [...this.running], ...(this.error ? { error: this.error } : {}) }
  }

  // On when Wiki settings say so, and only for a finding that is still open and has no fix waiting.
  canResolve(id: string): boolean {
    if (this.deps.settings().wikiResolve !== true) return false
    const f = this.deps.wiki.findings().find((x) => x.id === id)
    return !!f && !f.change && f.kind !== 'git' && !this.running.has(id)
  }

  // One pass over one finding. A package it writes waits for the person, as the review's do; when it
  // can't settle it, its sentence stays next to the finding.
  async resolve(id: string): Promise<{ change?: WikiChange; note?: string; gone?: boolean }> {
    if (this.deps.settings().wikiResolve !== true) throw new Error(L('O resolvedor está desligado. Ligue em Ajustes da wiki.', 'The resolver is off. Turn it on in Wiki settings.'))
    const finding = this.deps.wiki.findings().find((f) => f.id === id)
    if (!finding) return { gone: true }
    if (finding.change) return { change: finding.change }
    if (finding.kind === 'git' || this.running.has(id)) return {}
    this.running.add(id)
    this.error = undefined
    try {
      const answer = parseResolution(await this.deps.llm(resolverSystem(), this.prompt(finding)), this.deps.wiki.view(this.deps.wiki.heldTitles()))
      // Said out loud, not swallowed: a person who pressed Resolve and got nothing would think it worked.
      if (!answer) {
        this.error = L('O modelo não respondeu no formato da wiki.', 'The model answered in no usable form.')
        throw new Error(this.error)
      }
      const change = this.deps.wiki.resolveFinding(id, { ops: answer.ops, reason: answer.reason, ...(answer.note ? { note: answer.note } : {}) })
      return { ...(change ? { change } : {}), ...(answer.ops.length ? {} : { note: answer.note }) }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      this.running.delete(id)
    }
  }

  // The whole of the pages it's about, the pages around them, and the sources those pages came from.
  private prompt(f: WikiFinding): string {
    const view = this.deps.wiki.view(this.deps.wiki.heldTitles())
    const around = new Set<string>()
    const pages: WikiPage[] = []
    for (const title of f.pages) {
      const pg = view.page(title)
      if (!pg) continue
      pages.push(pg)
      for (const t of [...pg.links, ...pg.backlinks]) if (!f.pages.includes(t)) around.add(t)
    }
    const shown: WikiPage[] = []
    let size = 0
    for (const pg of pages) {
      if (size >= MAX_CHARS) break
      shown.push(pg)
      size += Math.min(pg.body.length, PAGE_CHARS)
    }
    const near: string[] = []
    for (const title of around) {
      const pg = view.page(title)
      if (!pg || size >= MAX_CHARS) continue
      near.push(`### [[${pg.title}]] (${pg.kind}, ${L('atualizada em', 'updated')} ${date(pg.updatedAt)})\n${pg.body.slice(0, NEAR_CHARS)}`)
      size += Math.min(pg.body.length, NEAR_CHARS)
    }
    const sources = this.sourcesOf(f.pages, size)
    return [
      L('## O que a revisão achou', '## What the review found'),
      `**${f.kind}**: ${f.text}`,
      ...(f.note ? [L('## O que já se tentou', '## What was tried'), f.note] : []),
      L('## As páginas inteiras', '## The whole pages'),
      ...shown.map((p) => `### [[${p.title}]] (${p.kind}, ${L('atualizada em', 'updated')} ${date(p.updatedAt)})\n${p.body.slice(0, PAGE_CHARS)}`),
      ...(near.length ? [L('## As páginas em volta', '## The pages around them'), ...near] : []),
      ...(sources.length ? [L('## As fontes de onde vieram', '## The sources they came from'), ...sources] : []),
      L('Responda só com o JSON.', 'Reply with the JSON only.')
    ].join('\n\n')
  }

  // The sources behind those pages: the changes that wrote them carry the source they came from.
  private sourcesOf(titles: string[], used: number): string[] {
    const out: string[] = []
    let size = used
    const keys = new Set(titles.map((t) => t.toLowerCase()))
    const seen = new Set<string>()
    for (const c of this.deps.wiki.changes('applied')) {
      if (!c.source || seen.has(c.source.id)) continue
      if (!c.ops.some((o) => keys.has(o.page.toLowerCase()))) continue
      seen.add(c.source.id)
      const src = this.deps.wiki.source(c.source.id)
      if (!src?.text) continue
      out.push(`### ${src.title} (${date(src.addedAt)})\n${src.text.slice(0, SOURCE_CHARS)}`)
      size += Math.min(src.text.length, SOURCE_CHARS)
      if (out.length >= MAX_SOURCES || size >= MAX_CHARS) break
    }
    return out
  }
}

const date = (ms: number): string => new Date(ms).toLocaleDateString(locale())
