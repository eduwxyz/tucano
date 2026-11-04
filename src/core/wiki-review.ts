// Looking after the wiki: what's broken or missing (found by reading the pages, no model), and
// what no longer adds up (a cheap model reads what changed since the last review, next to the
// pages around it). Everything it finds waits for the person; nothing goes in on its own.
import { L } from '../shared/lang'
import type { Settings, WikiFinding, WikiOp, WikiPage, WikiReview } from '../shared/types'
import { parseOps } from './wiki-curator'
import { linksIn, type Wiki } from './wiki'

export interface ReviewDeps {
  wiki: Wiki
  settings: () => Settings
  llm: (system: string, prompt: string) => Promise<string>
}

type Found = Omit<WikiFinding, 'id' | 'at' | 'change'> & { key: string; ops?: WikiOp[]; reason?: string }

const WEEK = 7 * 24 * 3600_000
const MAX_CHARS = 60_000 // of pages shown to the model in one review
const PAGE_CHARS = 4_000
const link = (t: string): string => `[[${t}]]`
const list = (ts: string[]): string => (ts.length <= 3 ? ts.map(link).join(', ') : `${ts.slice(0, 3).map(link).join(', ')} ${L(`e mais ${ts.length - 3}`, `and ${ts.length - 3} more`)}`)

// Names written with capitals ("Construtora Alpha", "Dona Rita"), in the text outside links and code.
const NAME = /(?<![\p{L}\p{N}])(\p{Lu}[\p{L}\p{N}]+(?:\s+(?:d[aeo]s?\s+|e\s+)?\p{Lu}[\p{L}\p{N}]+){1,3})(?![\p{L}\p{N}])/gu
function namesIn(body: string): Set<string> {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\[\[[^\]]*\]\]/g, ' · ')
    .replace(/^#+ .*$/gm, ' · ')
    .replace(/\*\*[^*\n]*:\*\*/g, ' · ')
  const out = new Set<string>()
  for (const line of text.split(/\n|[.!?:;]\s/)) {
    for (const m of line.matchAll(NAME)) out.add(m[1]!.replace(/\s+/g, ' '))
  }
  return out
}

// What can be found without a model.
export function lint(wiki: Wiki, owner?: string): Found[] {
  const pages = wiki
    .list()
    .map((p) => wiki.page(p.title))
    .filter((p): p is WikiPage => !!p)
  const titles = new Set(pages.map((p) => p.title.toLowerCase()))
  const out: Found[] = []
  // links to pages that don't exist
  const broken = new Map<string, string[]>()
  for (const p of pages) for (const m of p.missing) broken.set(m, [...(broken.get(m) ?? []), p.title])
  for (const [name, from] of broken)
    out.push({ key: `broken:${name.toLowerCase()}`, kind: 'broken', name, pages: from, text: L(`${list(from)} ${from.length === 1 ? 'liga' : 'ligam'} pra ${link(name)}, que ainda não existe.`, `${list(from)} ${from.length === 1 ? 'links' : 'link'} to ${link(name)}, which doesn't exist yet.`) })
  // pages nothing links to (in a wiki big enough for that to matter), as one finding
  const alone = pages.length >= 4 ? pages.filter((p) => !p.backlinks.length).map((p) => p.title) : []
  if (alone.length)
    out.push({
      key: `orphan:${[...alone].sort().join('|').toLowerCase()}`,
      kind: 'orphan',
      pages: alone,
      text: alone.length === 1 ? L(`Nenhuma página liga pra ${link(alone[0]!)}.`, `No page links to ${link(alone[0]!)}.`) : L(`Nenhuma página liga pra ${alone.map(link).join(', ')}. Quem chega nelas só chega buscando.`, `No page links to ${alone.map(link).join(', ')}. They're only found by searching.`)
    })
  // a name several pages mention, with no page of its own
  const seen = new Map<string, { name: string; pages: string[] }>()
  for (const p of pages)
    for (const n of namesIn(p.body)) {
      const k = n.toLowerCase()
      if (titles.has(k) || broken.has(n) || (owner && k.includes(owner.toLowerCase()))) continue
      const s = seen.get(k) ?? { name: n, pages: [] }
      if (!s.pages.includes(p.title)) s.pages.push(p.title)
      seen.set(k, s)
    }
  for (const [k, s] of seen) if (s.pages.length >= 3) out.push({ key: `missing:${k}`, kind: 'missing', name: s.name, pages: s.pages, text: L(`**${s.name}** aparece em ${list(s.pages)}, e não tem página.`, `**${s.name}** shows up in ${list(s.pages)}, and has no page.`) })
  return out
}

export const reviewSystem = (): string =>
  L(
    `Você revisa a wiki de um time: páginas em Markdown ligadas por [[Título]]. Leia as páginas e procure só problemas reais:
- "contradicao": duas páginas (ou uma página consigo mesma) dizem coisas diferentes sobre o mesmo fato (um valor, uma data, um contato, uma situação);
- "desatualizada": uma página diz algo que outra, mais nova, mostra que já mudou (ex.: "aguardando resposta" numa página, "contrato assinado" em outra);
- "duplicada": duas páginas sobre a mesma coisa (mesma pessoa, mesmo projeto) com títulos diferentes;
- "ligacao": uma página sem ninguém ligando pra ela, que deveria ser citada em outra (diga onde).
Para cada problema, proponha a correção como mudanças:
- "replace": troque um trecho exato ("old" tem que estar na página, letra por letra) pelo certo ("new");
- "append": acrescente um trecho numa seção de uma página.
Corrija pelo que é mais novo ou tem fonte; na dúvida, não troque: só aponte, sem mudanças. Pra duplicadas, fique com a página que mais páginas ligam (ou a mais completa), leve pra ela todo fato que só a outra tem, sem perder nenhum, e na outra deixe só "Ver [[Título]]". Não invente nada que não esteja nas páginas. Pouco e certo: se nada estiver errado, a lista vem vazia.

Responda só com JSON:
{"achados": [{"tipo": "contradicao"|"desatualizada"|"duplicada"|"ligacao", "paginas": ["Título"], "explicacao": "uma frase, com [[links]]", "mudancas": [{"op": "replace"|"append", "pagina": "Título", "secao": "Seção", "texto": "markdown", "old": "trecho exato", "new": "trecho novo"}]}]}`,
    `You review a team's wiki: Markdown pages linked with [[Title]]. Read the pages and look only for real problems:
- "contradicao": two pages (or a page and itself) say different things about the same fact (an amount, a date, a contact, a status);
- "desatualizada": a page says something another, newer one shows has changed (e.g. "waiting for an answer" on one page, "contract signed" on another);
- "duplicada": two pages about the same thing (same person, same project) under different titles;
- "ligacao": a page nothing links to, that another one should mention (say where).
For each problem, write the fix as changes:
- "replace": swap an exact passage ("old" must be on the page, letter by letter) for the right one ("new");
- "append": add a passage under a section of a page.
Fix toward what's newer or has a source; when unsure, don't swap: just point it out, with no changes. For duplicates, keep the page more pages link to (or the fuller one), bring into it every fact only the other has, losing none, and leave just "See [[Title]]" in the other. Don't make up anything the pages don't say. Little and right: if nothing is wrong, the list is empty.

Reply with JSON only:
{"achados": [{"tipo": "contradicao"|"desatualizada"|"duplicada"|"ligacao", "paginas": ["Title"], "explicacao": "one sentence, with [[links]]", "mudancas": [{"op": "replace"|"append", "pagina": "Title", "secao": "Section", "texto": "markdown", "old": "exact passage", "new": "new passage"}]}]}`
  )

const KINDS: Record<string, WikiFinding['kind']> = { contradicao: 'contradiction', contradiction: 'contradiction', desatualizada: 'stale', stale: 'stale', duplicada: 'duplicate', duplicate: 'duplicate', ligacao: 'link', link: 'link' }

export function parseReview(text: string, wiki: Wiki): Found[] {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  let v: Record<string, unknown>
  try {
    v = JSON.parse(json) as Record<string, unknown>
  } catch {
    return []
  }
  const out: Found[] = []
  for (const a of Array.isArray(v['achados']) ? v['achados'] : Array.isArray(v['findings']) ? v['findings'] : []) {
    const o = a as Record<string, unknown>
    const kind = KINDS[String(o['tipo'] ?? o['kind'] ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')]
    const text = String(o['explicacao'] ?? o['explanation'] ?? '').trim()
    if (!kind || !text) continue
    const pages = (Array.isArray(o['paginas']) ? o['paginas'] : Array.isArray(o['pages']) ? o['pages'] : []).map((t) => String(t).replace(/^\[\[|\]\]$/g, '').trim()).filter((t) => !!wiki.page(t))
    // A swap whose passage isn't on the page, or a change to a page that doesn't exist, is dropped.
    const ops = parseOps(o['mudancas'] ?? o['changes'])
      .filter((op) => {
        const pg = op.op !== 'create' ? wiki.page(op.page) : undefined
        return !!pg && (op.op !== 'replace' || pg.body.includes(op.old!))
      })
      // a swap names no section of its own; one the page doesn't have ("raiz") says nothing
      .map(({ section, ...op }) => (section && op.op === 'append' ? { ...op, section } : op))
    out.push({ key: `${kind}:${[...pages].sort().join('|').toLowerCase()}:${text.slice(0, 80).toLowerCase()}`, kind, pages, text, ...(ops.length ? { ops, reason: text.replace(/\[\[([^\]|]+)(\|[^\]]*)?\]\]/g, '$1') } : {}) })
  }
  return out
}

export class WikiReviewer {
  private running: Promise<void> | null = null
  private error: string | undefined

  constructor(private deps: ReviewDeps) {}

  status(): WikiReview {
    const at = Number(this.deps.wiki.getMeta('reviewed_at') ?? 0)
    return { ...(at ? { at } : {}), running: !!this.running, ...(this.error ? { error: this.error } : {}), findings: this.deps.wiki.findings() }
  }

  // Once a week, when the person asked for that.
  due(now = Date.now()): boolean {
    const at = Number(this.deps.wiki.getMeta('reviewed_at') ?? 0)
    return this.deps.settings().wikiReview === 'weekly' && !this.running && this.deps.wiki.count() >= 3 && now - at >= WEEK
  }

  review(): Promise<void> {
    this.running ??= this.run().finally(() => {
      this.running = null
      // a failed model read leaves the mark where it was, so the next review reads those pages again
      if (!this.error) this.deps.wiki.setMeta('reviewed_at', String(Date.now()))
      this.deps.wiki.setFindings(this.found)
    })
    return this.running
  }

  private found: Found[] = []

  private async run(): Promise<void> {
    const { wiki } = this.deps
    const owner = this.deps.settings().workspaceName
    this.error = undefined
    this.found = lint(wiki, owner)
    if (wiki.count() < 2) return
    try {
      const asked = await this.ask()
      // a page the model already said where to link isn't also listed as nobody's
      const linked = new Set(asked.filter((f) => f.kind === 'link').flatMap((f) => [...f.pages, ...linksIn(f.text), ...(f.ops ?? []).flatMap((o) => linksIn(o.text ?? o.new ?? ''))].map((t) => t.toLowerCase())))
      const orphan = this.found.find((f) => f.kind === 'orphan')
      if (orphan) {
        orphan.pages = orphan.pages.filter((t) => !linked.has(t.toLowerCase()))
        if (!orphan.pages.length) this.found = this.found.filter((f) => f !== orphan)
        else if (linked.size) Object.assign(orphan, { key: `orphan:${[...orphan.pages].sort().join('|').toLowerCase()}`, text: L(`Nenhuma página liga pra ${orphan.pages.map(link).join(', ')}.`, `No page links to ${orphan.pages.map(link).join(', ')}.`) })
      }
      this.found.push(...asked)
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    }
  }

  // What changed since the last review, and the pages around it; the first review reads it all.
  private async ask(): Promise<Found[]> {
    const { wiki } = this.deps
    const since = Number(wiki.getMeta('reviewed_at') ?? 0)
    const all = wiki.list()
    const changed = all.filter((p) => p.updatedAt > since).sort((a, b) => b.updatedAt - a.updatedAt)
    if (!changed.length) return []
    const picked = new Map<string, WikiPage>()
    const add = (t: string): void => {
      if (picked.has(t.toLowerCase())) return
      const pg = wiki.page(t)
      if (pg) picked.set(t.toLowerCase(), pg)
    }
    for (const p of changed) {
      add(p.title)
      const pg = wiki.page(p.title)
      for (const t of [...(pg?.links ?? []), ...(pg?.backlinks ?? []), ...wiki.search(p.title, 3).map((h) => h.title)]) add(t)
    }
    let size = 0
    const shown: WikiPage[] = []
    for (const pg of picked.values()) {
      if (size > MAX_CHARS) break
      shown.push(pg)
      size += Math.min(pg.body.length, PAGE_CHARS)
    }
    const orphans = shown.filter((p) => !p.backlinks.length).map((p) => link(p.title))
    const date = (ms: number): string => new Date(ms).toLocaleDateString('pt-BR')
    const prompt = [
      L('## Páginas', '## Pages'),
      ...shown.map((p) => `### [[${p.title}]] (${p.kind}, ${L('atualizada em', 'updated')} ${date(p.updatedAt)})\n${p.body.slice(0, PAGE_CHARS)}`),
      ...(orphans.length ? [L('## Páginas sem ninguém ligando pra elas', '## Pages nothing links to'), orphans.join(', ')] : []),
      L('Responda só com o JSON.', 'Reply with the JSON only.')
    ].join('\n\n')
    return parseReview(await this.deps.llm(reviewSystem(), prompt), wiki)
  }
}
