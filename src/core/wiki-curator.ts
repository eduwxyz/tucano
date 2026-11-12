// The wiki's curator: after a conversation moves on, it reads what was said and decides if
// something lasting came up (a decision, a fact about a person or a project, a result worth
// keeping). If so, the exchange is kept as a source, as it was, and the pages are brought up
// to date in a change package: a new page goes in right away; changing a page that exists
// goes in or waits for you, as the wiki's settings say. The conversation shows what was kept,
// with Undo. A message can also be kept on purpose ("Keep in the wiki"), and "guarda isso"
// said in the conversation makes the curator keep it.
import { L, locale } from '../shared/lang'
import { asSaid, saidAt, type Agent, type Message, type Person, type Settings, type WikiChange, type WikiOp } from '../shared/types'
import { cleanTitle, ftsQuery } from './wiki'
import type { Wiki } from './wiki'

const QUIET_MS = 20_000 // a conversation that went quiet this long gets read
const MAX_MESSAGES = 14
const MIN_CHARS = 160 // less than this said since the last read: nothing to keep
const MAX_PAGE_CHARS = 3_000
const DOC_PART = 30_000 // a long document is read in parts this size, one after the other

export interface CuratorDeps {
  wiki: Wiki
  db: { conversation(id: string): { id: string; kind: string; name: string; wikiCapture?: boolean; owner?: string } | undefined; messagesAfter(conversationId: string, at: number): Message[]; messagesSaidAfter(conversationId: string, at: number): Message[]; message(id: string): Message | undefined; saveMessage(m: Message): void; agents(): Agent[]; ownerId?(): string; people?(opts: { removed?: boolean }): Person[]; teamMode?(): boolean }
  settings: () => Settings
  llm: (system: string, prompt: string) => Promise<string> // a cheap model, chosen inside; throws when none is ready
  emitMessage: (m: Message) => void
  // The pages (lowercase titles) a curation from this conversation may not read: the ones held for
  // someone other than whose DM it is (see Wiki.inherit). What it writes is read by others.
  hidden?: (conversationId: string) => Set<string>
  // Before it writes: the wiki brought up to date with its git repository, if it has one.
  beforeWrite?: () => Promise<void>
}

export const curatorSystem = (): string =>
  L(
    `Você é o curador da wiki de um time. A wiki guarda o que vale lembrar por muito tempo, em páginas ligadas por [[Título]]: pessoas, clientes, projetos, assuntos e decisões. Ela é um retrato de como as coisas estão, não um diário do que foi feito.

Você recebe as regras da wiki (o esquema), o índice das páginas, algumas páginas que podem ter a ver, e um trecho novo (uma conversa ou uma mensagem). Decida se o trecho traz conhecimento durável:
- uma decisão ("vamos fechar com a Construtora Alpha");
- um fato que continua valendo sobre uma pessoa, um cliente ou um projeto (contato, preferência, prazo, valor, situação);
- o resultado de um trabalho ou de uma pesquisa, o próprio resultado (um roteiro, uma comparação, um orçamento);
- algo que a pessoa pediu pra guardar ("guarda isso", "anota na wiki").

Conhecimento, não registro. Os agentes contam o que fizeram ("enviei o e-mail", "procurei na agenda", "rodei os testes", "criei o rascunho", "não achei o arquivo"). Isso é o registro da tarefa, não conhecimento: não guarde as ações, os passos, as tentativas, os erros nem as ferramentas usadas. Quando uma ação mudou algo que continua valendo, guarde o que mudou, não a ação: "marquei a reunião com o Marcos dia 12" vira "Reunião com [[Marcos Lima]] em 12/01" na página certa; "mandei o orçamento pro Marcos" vira "Orçamento enviado em 03/11" na situação do projeto.
Não guarde também: conversa fiada, perguntas sem resposta, o que só importa nesta conversa, tarefas em andamento sem conclusão.

Se valer, escreva as mudanças:
- "create": uma página nova, inteira, no formato do esquema (uma frase de resumo no começo; seções com ##; [[links]] pras outras páginas). Só crie se não houver página sobre isso no índice.
- "replace": troque um trecho exato que ficou errado ou velho. "old" tem que estar na página, letra por letra. Quando um fato mudou (a situação, um prazo, um valor), atualize o que a página diz em vez de acrescentar mais uma linha.
- "append": acrescente um trecho curto numa seção de uma página que existe (a seção é criada se faltar), pra um fato novo. Um histórico só leva marcos (contrato assinado, obra começou), não cada conversa.
Escreva só o que é novo: o que já está numa página (inclusive em outra) não se repete; ligue com [[link]]. Não invente nem complete. Datas no formato dd/mm. Pouco e certo é melhor que muito.
Em cada mudança, diga em "lasting" se ela ainda vai importar daqui a três meses, pra alguém que nunca viu esta conversa. Se não, "lasting": false, e ela não entra.

Responda só com JSON:
{"worth": true|false, "reason": "uma frase", "source_title": "título curto do trecho", "changes": [{"op": "create"|"append"|"replace", "page": "Título", "kind": "Pessoa|Projeto|Assunto|Decisão", "section": "Situação", "text": "markdown", "old": "trecho exato", "new": "trecho novo", "lasting": true|false}]}`,
    `You curate a team's wiki. The wiki keeps what's worth remembering for a long time, as pages linked with [[Title]]: people, clients, projects, topics and decisions. It's a picture of how things stand, not a diary of what was done.

You get the wiki's rules (the schema), the page index, a few pages that may be related, and a new stretch (a conversation or a message). Decide if the stretch brings lasting knowledge:
- a decision ("we're going with Alpha Builders");
- a fact that keeps holding about a person, a client or a project (contact, preference, deadline, price, status);
- the result of a piece of work or research, the result itself (a plan, a comparison, a quote);
- something the person asked to keep ("save this", "put it in the wiki").

Knowledge, not a record. Agents tell what they did ("I sent the email", "I checked the calendar", "I ran the tests", "I made the draft", "I couldn't find the file"). That's the record of the task, not knowledge: don't keep the actions, the steps, the attempts, the errors or the tools used. When an action changed something that keeps holding, keep what changed, not the action: "I booked the meeting with Mark on the 12th" becomes "Meeting with [[Mark Lee]] on Jan 12" on the right page; "I sent Mark the quote" becomes "Quote sent on Nov 3" in the project's status.
Don't keep either: small talk, unanswered questions, what matters only in this conversation, tasks in progress with no outcome.

If it's worth it, write the changes:
- "create": a new page, whole, in the schema's format (a summary sentence first; ## sections; [[links]] to other pages). Only create it if no page in the index is about it.
- "replace": swap an exact passage that became wrong or old. "old" must be on the page, letter by letter. When a fact changed (the status, a deadline, a price), update what the page says instead of adding one more line.
- "append": add a short passage under a section of an existing page (the section is made if missing), for a new fact. A history only takes milestones (contract signed, work started), not every conversation.
Write only what is new: what a page already says (even another page) isn't repeated; link to it with [[link]]. Don't make things up or fill gaps. Dates written out, like Jan 12 or Nov 3 (never 12/01). Little and right beats a lot.
For each change, say in "lasting" whether it will still matter three months from now, to someone who never saw this conversation. If not, "lasting": false, and it stays out.

Reply with JSON only:
{"worth": true|false, "reason": "one sentence", "source_title": "short title of the stretch", "changes": [{"op": "create"|"append"|"replace", "page": "Title", "kind": "Person|Project|Topic|Decision", "section": "Status", "text": "markdown", "old": "exact passage", "new": "new passage", "lasting": true|false}]}`
  )

// Lenient: models sometimes wrap the JSON in a fence or add a word around it.
export function parseCuration(text: string): { worth: boolean; reason: string; title: string; ops: WikiOp[] } | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let v: Record<string, unknown>
  try {
    v = JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')
  const ops = parseOps(v['mudancas'] ?? v['changes'])
  const worth = v['guardar'] === true || v['worth'] === true
  return { worth: worth && ops.length > 0, reason: str(v['motivo'] ?? v['reason']), title: cleanTitle(str(v['titulo_fonte'] ?? v['source_title'])) || L('Trecho de conversa', 'Conversation excerpt'), ops }
}

// A swap's new passage. Models often write it under "text" (as for the other ops) or in Portuguese;
// read as an empty "new", the swap would show nothing in its place and delete the passage on approval.
const swapIn = (o: Record<string, unknown>): string => {
  for (const k of ['new', 'novo', 'text', 'texto']) if (typeof o[k] === 'string' && (o[k] as string).trim()) return o[k] as string
  return ''
}

// The changes a model wrote, in the JSON both the curator and the review use.
export function parseOps(list: unknown): WikiOp[] {
  const str = (x: unknown): string => (typeof x === 'string' ? x.trim() : '')
  const ops: WikiOp[] = []
  for (const c of Array.isArray(list) ? list : []) {
    const o = c as Record<string, unknown>
    const op = str(o['op'])
    const page = cleanTitle(str(o['pagina'] ?? o['page']).replace(/^\[\[|\]\]$/g, ''))
    if (!page || !['create', 'append', 'replace'].includes(op)) continue
    if (op === 'replace' && !str(o['old'])) continue
    if (op !== 'replace' && !str(o['texto'] ?? o['text'])) continue
    // the model's own word that this won't matter in three months: a record of the task, not knowledge
    if (o['lasting'] === false) continue
    ops.push({
      op: op as WikiOp['op'],
      page,
      ...(str(o['tipo'] ?? o['kind']) ? { kind: str(o['tipo'] ?? o['kind']) } : {}),
      ...(str(o['secao'] ?? o['section']) ? { section: str(o['secao'] ?? o['section']) } : {}),
      ...(op !== 'replace' ? { text: str(o['texto'] ?? o['text']) } : { old: String(o['old']), new: swapIn(o) })
    })
  }
  return ops
}

export class WikiCurator {
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = new Map<string, Promise<void>>()

  constructor(private deps: CuratorDeps) {}

  // After a reply: read the conversation once it goes quiet, if capture is on.
  afterReply(conversationId: string, quietMs = QUIET_MS): void {
    if (this.deps.settings().wikiCapture === false) return
    const t = this.timers.get(conversationId)
    if (t) clearTimeout(t)
    this.timers.set(
      conversationId,
      setTimeout(() => {
        this.timers.delete(conversationId)
        void this.read(conversationId)
      }, quietMs)
    )
  }

  // Reads what came since the last time; one at a time per conversation.
  read(conversationId: string): Promise<void> {
    const cur = this.running.get(conversationId)
    if (cur) return cur
    const p = this.doRead(conversationId)
      .catch((e: unknown) => console.error('[wiki]', e))
      .finally(() => this.running.delete(conversationId))
    this.running.set(conversationId, p)
    return p
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  private name(m: Message): string {
    const me = this.deps.settings().workspaceName || L('Você', 'You')
    const id = m.author.kind === 'person' ? m.author.id : ''
    if (m.author.kind === 'person') return id === this.deps.db.ownerId?.() ? me : (this.deps.db.people?.({ removed: true }).find((p) => p.id === id)?.name ?? me)
    if (m.author.kind === 'routine') return L('Rotina', 'Routine')
    const agentId = m.author.kind === 'agent' ? m.author.id : ''
    return this.deps.db.agents().find((a) => a.id === agentId)?.name ?? L('Agente', 'Agent')
  }
  private excerpt(messages: Message[]): string {
    return messages.map((m) => `**${this.name(m)}** (${new Date(saidAt(m)).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}): ${m.text.trim()}`).join('\n\n')
  }

  private async doRead(conversationId: string): Promise<void> {
    const { db, wiki } = this.deps
    const conv = db.conversation(conversationId)
    if (!conv || conv.wikiCapture === false) return // a conversation kept out of the wiki
    // A DM is its person's alone: once the Tucano is a team (its first invite on), no DM (the owner's
    // either) goes into the team's wiki on its own. One person alone keeps what it always did.
    if (conv.kind === 'dm' && ((db.teamMode?.() ?? (db.people?.({}).length ?? 1) > 1) || (conv.owner && db.ownerId && conv.owner !== db.ownerId()))) return
    const since = wiki.mark(conversationId)
    // what was already kept on purpose ("Keep in the wiki") isn't read a second time
    const kept = wiki.readMessages(conversationId)
    // In the order things were said, and the mark goes by that too: a reply still at work when the
    // conversation was last read comes after what was read then, however early it started.
    const all = asSaid(db.messagesSaidAfter(conversationId, since)).filter((m) => (m.author.kind === 'person' || m.author.kind === 'agent') && m.text.trim() && m.run?.status !== 'working')
    const fresh = all.filter((m) => !kept.has(m.id))
    if (!fresh.length) return all.length ? wiki.setMark(conversationId, saidAt(all.at(-1)!)) : undefined
    const stretch = fresh.slice(-MAX_MESSAGES)
    const last = stretch.at(-1)!
    if (stretch.reduce((n, m) => n + m.text.length, 0) < MIN_CHARS) return wiki.setMark(conversationId, saidAt(last))
    await this.curate({ messages: stretch, kind: 'conversation', conversationId, force: false })
    wiki.setMark(conversationId, saidAt(last))
  }

  // A message kept on purpose: with the one it answers, if it's a reply (in a thread, my last message there).
  async keepMessage(messageId: string): Promise<WikiChange[]> {
    const m = this.deps.db.message(messageId)
    if (!m) throw new Error(L('Essa mensagem não existe mais.', 'That message no longer exists.'))
    const before = this.deps.db
      .messagesAfter(m.conversationId, 0)
      .filter((x) => x.at < m.at && x.author.kind === 'person' && (x.threadId === m.threadId || x.id === m.threadId))
      .at(-1)
    return this.curate({ messages: before && m.author.kind !== 'person' ? [before, m] : [m], kind: 'message', conversationId: m.conversationId, force: true })
  }

  // A package that ran into a newer page: made again on the page as it is now; when a passage
  // it swaps is gone, written again from its source.
  async redo(changeId: string): Promise<WikiChange[]> {
    const { wiki } = this.deps
    const c = wiki.change(changeId)
    if (!c || c.state !== 'conflict') return []
    const again = wiki.rebaseChange(changeId)
    if (again) return [again]
    const src = c.source && wiki.source(c.source.id)
    if (!src) throw new Error(L('A fonte dessa mudança não existe mais.', "This change's source no longer exists."))
    wiki.refuseChange(changeId)
    return this.curate({ text: src.text.replace(/^# .*\n+/, ''), plain: src.text, kind: 'message', conversationId: src.origin.conversationId ?? '', force: true, source: src, messages: [] })
  }

  // A file, a link or a note brought to the wiki: read (in parts, if long) and turned into pages.
  ingest(sourceId: string): Promise<void> {
    const cur = this.running.get(`source:${sourceId}`)
    if (cur) return cur
    const p = this.doIngest(sourceId).finally(() => this.running.delete(`source:${sourceId}`))
    this.running.set(`source:${sourceId}`, p)
    return p
  }

  private async doIngest(sourceId: string): Promise<void> {
    const { wiki } = this.deps
    const src = wiki.source(sourceId)
    if (!src) return
    wiki.setSourceStatus(sourceId, 'reading')
    try {
      const body = src.text.trimStart().replace(/^# .*\n+/, '')
      const parts: string[] = []
      for (let at = 0; at < body.length; at += DOC_PART) {
        // cut at a paragraph near the edge, so a part doesn't end mid-sentence
        let end = Math.min(body.length, at + DOC_PART)
        if (end < body.length) {
          const brk = body.lastIndexOf('\n\n', end)
          if (brk > at + DOC_PART / 2) end = brk
        }
        parts.push(body.slice(at, end))
        at = end - DOC_PART
      }
      let made = 0
      for (const [k, part] of parts.entries()) {
        if (!wiki.source(sourceId)) return // taken back between two parts
        const head = parts.length > 1 ? L(`(parte ${k + 1} de ${parts.length} de "${src.title}")\n\n`, `(part ${k + 1} of ${parts.length} of "${src.title}")\n\n`) : ''
        made += (await this.curate({ messages: [], kind: src.kind === 'note' ? 'message' : 'document', conversationId: '', force: src.kind === 'note', text: head + part, plain: part, source: src })).length
      }
      if (wiki.source(sourceId)) wiki.setSourceStatus(sourceId, 'done', { changes: made })
    } catch (e) {
      if (wiki.source(sourceId)) wiki.setSourceStatus(sourceId, 'failed', { error: e instanceof Error ? e.message : String(e) })
    } finally {
      wiki.dropOrphans()
    }
  }

  private async curate(p: { messages: Message[]; kind: 'conversation' | 'message' | 'document'; conversationId: string; force: boolean; text?: string; plain?: string; source?: { id: string; file: string; title: string } }): Promise<WikiChange[]> {
    const wiki = this.deps.wiki
    // A wiki that takes no writes (a read-only repository): nothing is read to be written.
    const ro = wiki.readOnly()
    if (ro) throw new Error(ro)
    const shown = wiki.view(this.deps.hidden?.(p.conversationId) ?? new Set())
    const text = p.text ?? this.excerpt(p.messages)
    const plain = p.plain ?? p.messages.map((m) => m.text).join(' ')
    // The pages it may touch: the ones the words of the stretch find.
    // The pages it may touch: first the ones the stretch names ("o Rogério mudou de telefone"),
    // then what a search finds in its end, the newest part; a long reply up front can't crowd them out.
    const words = ftsQuery(plain, true)
    const low = plain.toLowerCase()
    const named = shown.list().filter((p) => p.title.length >= 3 && new RegExp(`(^|[^\\p{L}\\p{N}])${p.title.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(low)).map((p) => p.title)
    const found = words ? shown.search(plain.slice(-600), 4).map((h) => h.title) : []
    const pages = [...new Set([...named, ...found])].slice(0, 6).map((t) => shown.page(t)).filter((x): x is NonNullable<typeof x> => !!x)
    // What already waits for approval on those pages, so it isn't proposed twice or fought over.
    const titles = new Set(pages.map((pg) => pg.title))
    const waiting = wiki.changes('pending').flatMap((c) => c.ops.filter((o) => titles.has(o.page)).map((o) => `- [[${o.page}]] ${o.op}${o.section ? ` (${o.section})` : ''}: ${o.op === 'replace' ? `"${o.old}" → "${o.new}"` : (o.text ?? '').slice(0, 300)}`))
    const owner = this.deps.settings().workspaceName
    const prompt = [
      ...(owner ? [L(`A wiki é de ${owner} ("eu", "você" nas conversas; a empresa ou o nome dela nos documentos). Não crie página sobre ${owner}.`, `The wiki belongs to ${owner} ("I", "you" in conversations; their company or name in documents). Don't make a page about ${owner}.`)] : []),
      L('## Esquema da wiki', "## The wiki's schema"),
      wiki.schema().trim(),
      L('## Índice', '## Index'),
      shown.indexText().trim() || L('(a wiki está vazia)', '(the wiki is empty)'),
      ...(pages.length ? [L('## Páginas que podem ter a ver', '## Pages that may be related'), ...pages.map((pg) => `### [[${pg.title}]] (${pg.kind})\n${pg.body.slice(0, MAX_PAGE_CHARS)}`)] : []),
      ...(waiting.length ? [L('## Mudanças já propostas, esperando aprovação (não repita; se o trecho mudar algo delas, escreva sobre o texto atual da página)', '## Changes already proposed, waiting for approval (don\'t repeat them; if the stretch changes one, write against the page as it is now)'), waiting.join('\n')] : []),
      p.kind === 'message'
        ? L('## Trecho que a pessoa pediu pra guardar (guarde)', '## Stretch the person asked to keep (keep it)')
        : p.kind === 'document'
          ? L('## Trecho de um documento que a pessoa trouxe pra wiki (guarde o que for durável: pessoas, valores, prazos, decisões, regras)', '## Stretch of a document the person brought to the wiki (keep what lasts: people, amounts, deadlines, decisions, rules)')
          : L('## Trecho novo da conversa', '## New stretch of the conversation'),
      text,
      L('Responda só com o JSON.', 'Reply with the JSON only.')
    ].join('\n\n')
    const out = parseCuration(await this.deps.llm(curatorSystem(), prompt))
    // While the model read, the source may have been taken back, or its conversation deleted (a
    // purge): nothing of it gets written, and what it left behind goes.
    if ((p.source && !wiki.source(p.source.id)) || (p.conversationId && !this.deps.db.conversation(p.conversationId))) {
      wiki.dropOrphans()
      return []
    }
    if (!out || (!out.worth && !p.force) || !out.ops.length) return []
    // What the repository has now, before writing on top of it (a failed pull doesn't stop it: the
    // sync deals with it later, conflicts included).
    await this.deps.beforeWrite?.().catch(() => {})
    if (wiki.readOnly()) throw new Error(wiki.readOnly())
    const source = p.source ?? wiki.addSource({ title: out.title, text, kind: p.kind === 'document' ? 'file' : p.kind, origin: { conversationId: p.conversationId, messageIds: p.messages.map((m) => m.id) }, by: 'auto' })
    const cite = ` ([[${source.file}|${L('fonte', 'source')}]])`
    // A swap whose passage isn't on that page: on the one page that has it, it goes there; on none, it
    // becomes an addition to the page named, so approving it can't fail.
    const fitted = out.ops.map((o): WikiOp => {
      if (o.op !== 'replace' || shown.page(o.page)?.body.includes(o.old!)) return o
      const holders = shown.list().filter((p) => shown.page(p.title)?.body.includes(o.old!))
      if (holders.length === 1) return { ...o, page: holders[0]!.title }
      const { old: _old, new: text = '', ...rest } = o
      return { ...rest, op: 'append', text }
    })
    const ops = fitted.filter((o) => o.op !== 'append' || o.text).map((o): WikiOp => (o.op === 'append' ? { ...o, text: `${o.text}${cite}` } : o.op === 'create' ? { ...o, text: `${o.text}\n\n${L('Fontes', 'Sources')}: [[${source.file}|${source.title}]]` } : o.op === 'replace' && o.new ? { ...o, new: `${o.new}${cite}` } : o))
    // New pages go in now; changes to existing ones go in or wait, as the settings say.
    const exists = (t: string): boolean => !!wiki.page(t)
    const creates = ops.filter((o) => o.op === 'create' && !exists(o.page))
    const edits = ops.filter((o) => !creates.includes(o))
    const me = this.deps.settings().workspaceName || L('Você', 'You')
    const made: WikiChange[] = []
    if (creates.length) made.push(wiki.applyChange(wiki.addChange({ ops: creates, sourceId: source.id, by: 'auto', reason: out.reason }).id, L('Curador da wiki', 'Wiki curator')))
    if (edits.length) {
      const c = wiki.addChange({ ops: edits, sourceId: source.id, by: 'auto', reason: out.reason })
      made.push(this.deps.settings().wikiEdits === 'auto' ? wiki.applyChange(c.id, L('Curador da wiki', 'Wiki curator')) : c)
    }
    wiki.dropOrphans()
    // The reply it came from says so, with what was kept and Undo.
    const anchor = [...p.messages].reverse().find((m) => m.author.kind === 'agent') ?? p.messages.at(-1)
    const msg = anchor && this.deps.db.message(anchor.id)
    if (msg?.run && made.length) {
      const next: Message = { ...msg, run: { ...msg.run, wikiChanges: [...(msg.run.wikiChanges ?? []), ...made.map((c) => c.id)] } }
      this.deps.db.saveMessage(next)
      this.deps.emitMessage(next)
    }
    return made
  }
}
