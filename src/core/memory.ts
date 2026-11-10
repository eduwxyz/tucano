// Memory, short and long term (spec §12). Short term: each conversation keeps
// a summary of what scrolled out of the window. Long term: notes about me (for
// every agent) or about an agent's own work. Both are plain rows the user can
// read, edit and forget; nothing lives inside the CLIs.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { L } from '../shared/lang'
import type { CoreEvent } from '../shared/rpc'
import { ENGINES, personScope, scopePerson, usable, modelInfo, splitForPrompt, SUMMARY_MAX_AFTER, SUMMARY_WINDOW, type Agent, type Conversation, type EngineId, type Memory, type MemoryScope, type Message, type Person, type RunStatus, type Settings } from '../shared/types'
import type { Db } from './db'
import type { Engine } from './engines/types'
import type { ToolDef } from './gateway'

export const WINDOW = SUMMARY_WINDOW
export const MAX_AFTER = SUMMARY_MAX_AFTER
// A thread is summarized (and its memories extracted) once it's quiet this long...
export const THREAD_QUIET_MS = 10 * 60_000
// ...with this many messages since its summary, at least: a question and its answer alone wait.
export const THREAD_MIN = 3
const THREAD_HORIZON_MS = 24 * 60 * 60_000 // threads quiet for longer were swept already (or predate this)
const SWEEP_BATCH = 3
const MAX_CHUNK = 200 // messages one consolidation reads at most: a long backlog goes in parts
const REBUILD_BATCH = 40 // a summary made again from scratch, this many messages a time
const MAX_MEMORY_CHARS = 500

export const BUSCAR_MEMORIAS: ToolDef = {
  name: 'buscar_memorias',
  get description() {
    return L(
      'Busca nas memórias mais antigas, as que não cabem mais no seu prompt. Use quando uma preferência, decisão ou fato de antes puder ajudar agora. Passe palavras que estariam na memória; sem resultado, o fato não foi guardado: não invente.',
      "Searches the older memories, the ones that no longer fit in your prompt. Use it when a preference, decision or fact from before could help now. Pass words that would be in the memory; with no result, the fact wasn't saved: don't make it up."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        busca: { type: 'string', description: L('Palavras-chave, ex.: "deploy sexta vercel".', 'Keywords, e.g. "deploy friday vercel".') },
        limite: { type: 'number', description: L('Quantas trazer, de 1 a 10. Padrão: 5.', 'How many to bring, 1 to 10. Default: 5.') }
      },
      required: ['busca']
    }
  }
}

export const LEMBRAR: ToolDef = {
  name: 'lembrar',
  get description() {
    return L(
      'Guarda uma memória durável: uma preferência, um padrão ou um fato que vai continuar valendo em outras conversas. Uma ideia curta por chamada. Não guarde o que só importa nesta conversa.',
      "Saves a lasting memory: a preference, a pattern or a fact that will keep holding in other conversations. One short idea per call. Don't save what only matters in this conversation."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        texto: {
          type: 'string',
          description: L('A memória, numa frase curta, autossuficiente e na terceira pessoa (ex.: "Prefere PRs pequenos").', 'The memory, in one short, self-contained sentence in the third person (e.g. "Prefers small PRs").')
        },
        sobre: {
          type: 'string',
          enum: ['usuario', 'agente'],
          description: L(
            '"usuario": sobre a pessoa com quem você fala (vale pra todos os agentes). "agente": sobre o seu trabalho (só você vê).',
            '"usuario": about the person you talk to (holds for every agent). "agente": about your own work (only you see it).'
          )
        },
        substitui: { type: 'string', description: L('Id de uma memória que esta atualiza, quando algo mudou.', 'Id of a memory this one updates, when something changed.') }
      },
      required: ['texto', 'sobre']
    }
  }
}

// The summary and the memories come out in the app's language.
export const memorySystem = (): string =>
  L(
    [
      'Você mantém a memória de um chat de trabalho entre uma pessoa e agentes de IA.',
      'Recebe o resumo atual da conversa, um trecho de mensagens numeradas que vai sair da janela, as memórias sobre a pessoa e as que ela mandou esquecer.',
      'Responda SOMENTE com JSON, sem texto em volta, no formato:',
      JSON_SHAPE,
      '- "summary": o resumo novo, que junta o anterior e o trecho. Até 500 palavras, em português. Guarde decisões, pendências, números, nomes e o estado do trabalho; corte conversa fiada. Pode usar tópicos.',
      '- "memories": só o que vale fora desta conversa: preferências, jeito de trabalhar, padrões e fatos duráveis sobre a pessoa e os projetos dela. Lista vazia é o normal.',
      '  - "add" pra algo novo; "update" quando algo já lembrado mudou (use o id); "confirm" quando o trecho reforça uma memória que já existe.',
      '  - "evidence": os números das mensagens que sustentam. Só vale o que a PESSOA disse ou confirmou, nunca o que um agente supôs.',
      '  - Nunca recrie nada parecido com uma memória esquecida.',
      '  - Cada "text" é uma frase curta na terceira pessoa, autossuficiente.'
    ].join('\n'),
    [
      'You keep the memory of a work chat between a person and AI agents.',
      "You get the conversation's current summary, a stretch of numbered messages about to leave the window, the memories about the person and the ones they asked to forget.",
      'Reply ONLY with JSON, no text around it, in the format:',
      JSON_SHAPE,
      '- "summary": the new summary, joining the previous one and the stretch. Up to 500 words, in English. Keep decisions, open items, numbers, names and the state of the work; cut small talk. Bullet points are fine.',
      '- "memories": only what holds outside this conversation: preferences, ways of working, patterns and lasting facts about the person and their projects. An empty list is normal.',
      '  - "add" for something new; "update" when something already remembered changed (use the id); "confirm" when the stretch reinforces an existing memory.',
      '  - "evidence": the numbers of the messages that back it. Only what the PERSON said or confirmed counts, never what an agent assumed.',
      '  - Never recreate anything like a forgotten memory.',
      '  - Each "text" is one short sentence in the third person, self-contained.'
    ].join('\n')
  )
const JSON_SHAPE = '{"summary": "...", "memories": [{"op": "add", "text": "...", "evidence": [1]}, {"op": "update", "id": "...", "text": "...", "evidence": [2]}, {"op": "confirm", "id": "..."}]}'

type Op = { op: 'add'; text: string; evidence: number[] } | { op: 'update'; id: string; text: string; evidence: number[] } | { op: 'confirm'; id: string }

// `thread`: the stretch is a thread's, since its summary (not what leaves a conversation's window).
// `others`: more people who wrote in the stretch, each with their own memories (`me` is the first).
export function consolidationPrompt(opts: { summary?: string; messages: Message[]; me: string; agents: Agent[]; memories: Memory[]; forgotten: Memory[]; thread?: boolean; people?: Pick<Person, 'id' | 'name'>[]; others?: { name: string; memories: Memory[]; forgotten: Memory[] }[] }): string {
  const { summary, messages, me, agents, memories, forgotten, thread, people, others = [] } = opts
  const author = (m: Message): string =>
    m.author.kind === 'person'
      ? (people?.find((p) => m.author.kind === 'person' && p.id === m.author.id)?.name ?? me)
      : m.author.kind === 'routine'
        ? L(`rotina agendada por ${me}`, `routine scheduled by ${me}`)
        : `${agents.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? L('agente', 'agent')} · ${L('agente', 'agent')}`
  const none = L('(nenhuma)', '(none)')
  return [
    L('Resumo atual:', 'Current summary:'),
    summary?.trim() || L('(ainda não há)', '(none yet)'),
    '',
    thread ? L('Mensagens da thread desde o resumo:', "The thread's messages since the summary:") : L('Trecho que vai sair da janela:', 'Stretch about to leave the window:'),
    // In a conversation's stretch, thread replies are marked: each thread also has its own summary.
    ...messages.map((m, i) => `(${i + 1}) [${author(m)}${!thread && m.threadId ? L(' · numa thread', ' · in a thread') : ''}] ${m.text.trim().slice(0, 4000)}`),
    '',
    L(`Memórias sobre ${me}:`, `Memories about ${me}:`),
    ...(memories.length ? memories.map((m) => `- [${m.id}] ${m.text}`) : [none]),
    '',
    L(`Esquecidas a pedido de ${me} (não recriar):`, `Forgotten at ${me}'s request (don't recreate):`),
    ...(forgotten.length ? forgotten.map((m) => `- ${m.text}`) : [none]),
    '',
    // Each person's memories apart: a memory is about whoever said what backs it.
    ...others.flatMap((o) => [
      L(`Memórias sobre ${o.name}:`, `Memories about ${o.name}:`),
      ...(o.memories.length ? o.memories.map((m) => `- [${m.id}] ${m.text}`) : [none]),
      '',
      L(`Esquecidas a pedido de ${o.name} (não recriar):`, `Forgotten at ${o.name}'s request (don't recreate):`),
      ...(o.forgotten.length ? o.forgotten.map((m) => `- ${m.text}`) : [none]),
      ''
    ]),
    L('Responda só com o JSON.', 'Reply with the JSON only.')
  ].join('\n')
}

// Lenient like the router's: models sometimes wrap the JSON in a code fence.
export function parseConsolidation(text: string): { summary: string; ops: Op[] } | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  const { summary, memories } = (data ?? {}) as { summary?: unknown; memories?: unknown }
  if (typeof summary !== 'string' || !summary.trim()) return null
  const ops: Op[] = []
  for (const raw of Array.isArray(memories) ? memories : []) {
    const o = (raw ?? {}) as Record<string, unknown>
    const text = typeof o['text'] === 'string' ? o['text'].trim().slice(0, MAX_MEMORY_CHARS) : ''
    const id = typeof o['id'] === 'string' ? o['id'] : ''
    const evidence = Array.isArray(o['evidence']) ? o['evidence'].filter((n): n is number => Number.isInteger(n)) : []
    if (o['op'] === 'add' && text) ops.push({ op: 'add', text, evidence })
    else if (o['op'] === 'update' && id && text) ops.push({ op: 'update', id, text, evidence })
    else if (o['op'] === 'confirm' && id) ops.push({ op: 'confirm', id })
  }
  return { summary: summary.trim(), ops }
}

// Another thread of the conversation, in a line: what opened it, who answered and who is
// on it now. Only the router reads these: an agent's thread is a conversation of its own.
export interface ThreadDigest {
  id: string // the message that opened it
  root?: Message
  last?: Message // its newest reply with something said
  replies: number
  agents: string[] // who answered in it
  working: { agentId: string; status: RunStatus }[]
  at: number // its latest activity
}

export const MAX_DIGESTS = 12
const BUSY: RunStatus[] = ['working', 'waiting_input', 'waiting_approval']

// The other threads active in `recent`, oldest activity first, the newest MAX_DIGESTS.
function digests(db: Pick<Db, 'message'>, recent: Message[], except?: string): ThreadDigest[] {
  const groups = new Map<string, Message[]>()
  for (const m of recent) {
    const key = m.threadId ?? m.id
    if (key !== except) groups.set(key, [...(groups.get(key) ?? []), m])
  }
  return [...groups]
    .map(([id, ms]): ThreadDigest => {
      const said = ms.filter((m) => m.id !== id && m.author.kind !== 'system' && m.text.trim())
      const agents = [...new Set(ms.flatMap((m) => (m.id !== id && m.author.kind === 'agent' ? [m.author.id] : [])))]
      const working = ms.flatMap((m) => (m.author.kind === 'agent' && m.run && BUSY.includes(m.run.status) ? [{ agentId: m.author.id, status: m.run.status }] : []))
      return { id, root: ms.find((m) => m.id === id) ?? db.message(id), last: said.at(-1), replies: said.length, agents, working, at: Math.max(...ms.map((m) => m.at)) }
    })
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_DIGESTS)
}

// What a reply reads of the conversation. In a thread, only that thread: the message that
// opened it and its newest `limit` replies, with the thread's summary when older ones are
// left out. A thread a person opened by writing in the conversation also gets `before`: the
// last messages outside threads before theirs, what they had on screen as they wrote ("pode
// disparar agora" answers the question at the end of the agent's message above it). The other threads aren't in it (an agent looks them up with buscar_threads);
// `threads` digests them for the router. Outside threads (a conversation that answers in it,
// a routine): its recent messages after `until`, what the conversation's summary covers, and of
// a thread only the message that opened it; what was said inside is looked up the same way.
export function contextWindow(
  db: Pick<Db, 'message' | 'recentMessages'>,
  before: Message,
  limit: number,
  until = 0
): { messages: Message[]; threads: ThreadDigest[]; summary?: string; before?: Message[] } {
  const here = (m: Message): boolean => m.id !== before.id && m.at <= before.at && m.at > until
  if (!before.threadId) return { messages: db.recentMessages(before.conversationId, limit + 40, null).filter(here).slice(-limit), threads: [] }
  const recent = db.recentMessages(before.conversationId, limit + 40).filter(here)
  const root = db.message(before.threadId)
  const replies = db.recentMessages(before.conversationId, limit + 2, before.threadId).filter((m) => m.id !== before.id && m.at <= before.at)
  const omitted = replies.length > limit
  const above = root ? onScreen(db, root) : []
  return {
    messages: [...(root ? [root] : []), ...replies.slice(-limit)],
    threads: digests(db, recent, before.threadId),
    ...(omitted && root?.threadSummary?.text.trim() ? { summary: root.threadSummary.text } : {}),
    ...(above.length ? { before: above } : {})
  }
}

export const ON_SCREEN = 3
export const ON_SCREEN_MS = 12 * 60 * 60 * 1000

// The messages outside threads just before a person's message that opened a thread: the newest
// ON_SCREEN with something said, from the ON_SCREEN_MS before it. Not one still being written: it
// changes, and what a reply reads before its thread doesn't.
function onScreen(db: Pick<Db, 'recentMessages'>, root: Message): Message[] {
  if (root.author.kind !== 'person' || root.threadId) return []
  return db
    .recentMessages(root.conversationId, ON_SCREEN + 10, null, root.at)
    .filter((m) => m.at >= root.at - ON_SCREEN_MS && m.author.kind !== 'system' && !!m.text.trim() && m.run?.status !== 'working')
    .slice(-ON_SCREEN)
}

// One thread found by buscar_threads.
export interface ThreadHit {
  id: string
  conversationId: string
  root?: Message
  last?: Message
  at: number
}

// buscar_threads: the threads of these conversations that best match the words, by what was
// said in them and their summaries (a thread just opened has none yet). `except`: the thread
// the search is made from.
// `keep`: what the one asking may read (a message left out is as if it weren't there).
export function searchThreads(db: Pick<Db, 'message' | 'recentMessages'>, conversationIds: string[], query: string, except?: string, limit = 5, keep: (m: Message) => boolean = () => true): ThreadHit[] {
  const groups = new Map<string, Message[]>()
  for (const c of conversationIds)
    for (const m of db.recentMessages(c, 400)) {
      const key = m.threadId ?? m.id
      if (key === except || m.author.kind === 'system' || !m.text.trim() || !keep(m)) continue
      groups.set(key, [...(groups.get(key) ?? []), m])
    }
  const docs = [...groups].map(([id, ms]) => {
    const found = db.message(id)
    const root = ms.find((m) => m.id === id) ?? (found && keep(found) ? found : undefined)
    const replies = ms.filter((m) => m.id !== id)
    const text = [root?.text ?? '', root?.threadSummary?.text ?? '', ...replies.map((m) => m.text)].join('\n')
    return { hit: { id, conversationId: ms[0]!.conversationId, root, last: replies.at(-1), at: ms.at(-1)!.at }, text }
  })
  return rank(docs, (d) => d.text, query, limit, (a, b) => b.hit.at - a.hit.at).map((d) => d.hit)
}

// Lowercase, no accents, words of letters and digits separated by single spaces.
const fold = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// For matching a new memory against forgotten and existing ones.
export const normalize = (t: string): string =>
  t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

export interface MemoryDeps {
  db: Db
  engines: Record<EngineId, Engine>
  settings: () => Promise<Settings>
  emit: (e: CoreEvent) => void
  workDir: string
}

export class Memories {
  private running = new Map<string, Promise<void>>()
  private swept = new Map<string, number>() // thread → the last activity a sweep already tried

  constructor(private deps: MemoryDeps) {}

  // ---------- reading ----------

  // Whose memories a stretch may hold: the people who wrote in it (a DM's person in a DM). With
  // nobody, the DM's person or the owner: the prompt reads as it always did.
  private learners(conv: Pick<Conversation, 'kind' | 'owner'>, stretch: Message[]): string[] {
    const ids = [...new Set(stretch.flatMap((m) => (m.author.kind === 'person' ? [m.author.id] : [])))]
    const dm = conv.kind === 'dm' ? (conv.owner ?? this.deps.db.ownerId()) : undefined
    const kept = dm ? ids.filter((id) => id === dm) : ids
    return kept.length ? kept : [dm ?? this.deps.db.ownerId()]
  }

  // What the extraction prompt gets: the first person's memories as `me`'s, the rest apart.
  // Only what may be read where the stretch is: what someone said in their DM never goes into a channel's summary.
  private aboutPeople(learners: string[], settings: Settings, conv?: Pick<Conversation, 'kind' | 'owner'>): Pick<Parameters<typeof consolidationPrompt>[0], 'me' | 'memories' | 'forgotten' | 'others'> {
    const { db } = this.deps
    const names = this.names(settings)
    const here = this.readableIn(conv)
    const each = learners.map((id) => ({
      name: names.find((p) => p.id === id)?.name ?? settings.workspaceName,
      memories: db.memories({ scope: personScope(id), state: 'active' }).filter(here),
      forgotten: db.memories({ scope: personScope(id), state: 'forgotten' }).filter(here).slice(-50)
    }))
    const [first, ...others] = each
    return { me: first?.name ?? settings.workspaceName, memories: first?.memories ?? [], forgotten: first?.forgotten ?? [], ...(others.length ? { others } : {}) }
  }

  // What goes in an agent's prompt: each scope up to the budget, newest first. `people`: whose
  // memories about them it gets (the DM's person, or who is talking; the owner when left out).
  // `searchable` counts the rest, which buscar_memorias reaches.
  // `conv`: where the reply goes. An agent's note made in a DM is that DM's person's: it comes in
  // only where they alone read the reply (their DM, or anywhere when they're the Tucano's one person).
  // A memory about someone learned in their DM comes in the same way: only where they alone read it.
  forPrompt(agent: Agent, people: string[] = [this.deps.db.ownerId()], conv?: Pick<Conversation, 'kind' | 'owner'>): { aboutMe: Memory[]; own: Memory[]; searchable: number } {
    const me = splitForPrompt(this.about(people, conv))
    const own = splitForPrompt(this.notes(agent, conv))
    return { aboutMe: me.prompt, own: own.prompt, searchable: me.searchable.length + own.searchable.length }
  }

  // `buscar_memorias`: only among the memories left out of this agent's prompt.
  search(agent: Agent, query: string, limit = 5, people: string[] = [this.deps.db.ownerId()], conv?: Pick<Conversation, 'kind' | 'owner'>): Memory[] {
    const out = [splitForPrompt(this.about(people, conv)), splitForPrompt(this.notes(agent, conv))].flatMap((x) => x.searchable)
    return rankMemories(out, query, limit)
  }

  // The agent's own notes a reply in `conv` may read: the team's, and the private ones of whoever
  // alone reads it.
  private notes(agent: Agent, conv?: Pick<Conversation, 'kind' | 'owner'>): Memory[] {
    return this.deps.db.memories({ scope: agent.id, state: 'active' }).filter(this.readableIn(conv))
  }

  // These people's memories about them that a reply in `conv` may read.
  private about(people: string[], conv?: Pick<Conversation, 'kind' | 'owner'>): Memory[] {
    return people.flatMap((p) => this.deps.db.memories({ scope: personScope(p), state: 'active' })).filter(this.readableIn(conv))
  }

  // A private memory (a DM's) is read only where its person alone reads: their DM, or anywhere
  // when they're the Tucano's one person (and no team yet: an invite out makes it one). Everything else, wherever.
  private readableIn(conv?: Pick<Conversation, 'kind' | 'owner'>): (m: Memory) => boolean {
    const { db } = this.deps
    if (conv?.kind !== 'dm' && db.teamMode()) return (m) => !m.privateTo
    const readers = conv?.kind === 'dm' ? [conv.owner ?? db.ownerId()] : db.people().map((p) => p.id)
    const only = readers.length === 1 ? readers[0] : readers.length === 0 ? db.ownerId() : undefined
    return (m) => !m.privateTo || m.privateTo === only
  }

  // Who alone may read a memory learned in `conv`: a DM's person; anywhere else, no one in particular.
  private privateIn(conv?: Pick<Conversation, 'kind' | 'owner'>): string | undefined {
    return conv?.kind === 'dm' ? (conv.owner ?? this.deps.db.ownerId()) : undefined
  }

  // What a turn sees of the conversation (contextWindow): in a thread, the thread and its own
  // summary; outside threads, the conversation's summary and what came after it.
  window(conv: Conversation, before: Message): { summary?: string; messages: Message[]; threads: ThreadDigest[]; before?: Message[] } {
    const w = contextWindow(this.deps.db, before, MAX_AFTER, conv.summaryUntil ?? 0)
    return before.threadId ? w : { ...w, summary: conv.summary }
  }

  // ---------- short term: consolidation ----------

  // Folds what is about to leave the window into the conversation's summary (for what reads
  // it: replies outside threads, like a routine's) and extracts memories about me from the
  // messages outside threads; a thread's come from its own consolidation. One at a time per conversation.
  consolidate(conversationId: string, force = false): Promise<void> {
    const current = this.running.get(conversationId)
    if (current) return current
    const p: Promise<void> = this.doConsolidate(conversationId, force)
      .then(() => {})
      .catch((e: unknown) => console.error('[memory]', e))
      .finally(() => {
        if (this.running.get(conversationId) === p) this.running.delete(conversationId)
      })
    this.running.set(conversationId, p)
    return p
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values())
  }

  // The summaries of a channel and of its threads, made again from what was said there alone
  // (when the Tucano gets a second person: what one person's DMs taught the old ones isn't the
  // team's). The old ones go first; nothing is learned again on the way.
  // The old ones are gone when this returns; the new ones are made after it, in the background.
  // `from`: the moment the new summaries start at (the heritage: what the channel held before stays
  // the owner's, so no summary the team reads is made of it).
  rebuild(conversationId: string, from = 0): Promise<void> {
    const { db, emit } = this.deps
    const conv = db.conversation(conversationId)
    if (!conv || conv.kind !== 'channel') return Promise.resolve()
    const roots = db.summarizedThreads(conv.id)
    db.setSummary(conv.id, '', from)
    for (const id of roots) db.setThreadSummary(id, '', from)
    emit({ type: 'conversation', conversation: db.conversation(conv.id)! })
    for (const id of roots) emit({ type: 'message', message: db.message(id)! })
    const prev = this.running.get(conversationId) ?? Promise.resolve()
    const p: Promise<void> = prev
      .then(async () => {
        while (await this.doConsolidate(conv.id, true, { learn: false, batch: REBUILD_BATCH }));
        for (const id of roots) while (await this.doThread(id, 'now', { learn: false, batch: REBUILD_BATCH }));
      })
      .catch((e: unknown) => console.error('[memory]', e))
      .finally(() => {
        if (this.running.get(conversationId) === p) this.running.delete(conversationId)
      })
    this.running.set(conversationId, p)
    return p
  }

  // True when a part was summarized (a rebuild goes on to the next one).
  private async doConsolidate(conversationId: string, force: boolean, opts: { learn?: boolean; batch?: number } = {}): Promise<boolean> {
    const { db, engines, emit } = this.deps
    const conv = db.conversation(conversationId)
    if (!conv) return false
    const after = db.messagesAfter(conv.id, conv.summaryUntil ?? 0).filter((m) => m.author.kind !== 'system' && m.text.trim())
    if (!force && after.length <= MAX_AFTER) return false
    const chunk = after.slice(0, Math.min(Math.max(0, after.length - WINDOW), opts.batch ?? MAX_CHUNK))
    if (chunk.length === 0) return false
    // Made while the Tucano had one person, a summary may hold what only they could read: one that
    // ends after the Tucano got its second person isn't kept (it's made again without it).
    const epoch = db.meta('heritageAt')

    const settings = await this.deps.settings()
    const model = usable(modelInfo(settings.memoryModel)) ?? modelInfo('haiku')!
    const status = settings.engines[model.engine]
    if (!status.installed || !status.loggedIn) return (console.log(`[memory] skipped: ${ENGINES[model.engine].label} not ready`), false)

    const cwd = join(this.deps.workDir, '_memory')
    mkdirSync(cwd, { recursive: true })
    const learners = this.learners(conv, chunk)
    const prompt = consolidationPrompt({
      summary: conv.summary,
      messages: chunk,
      people: this.names(settings),
      agents: db.agents(),
      ...this.aboutPeople(learners, settings, conv)
    })

    const started = Date.now()
    let text = ''
    let error: string | undefined
    for await (const ev of engines[model.engine].run({ model: model.id, effort: 'low', system: memorySystem(), prompt, cwd, signal: AbortSignal.timeout(120_000) })) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'done') {
        text = ev.text || text
        db.addReceipt({ ...ev.usage, model: model.id, ms: Date.now() - started, messageId: conv.id, agentId: 'memory', engine: model.engine, at: Date.now() })
      } else if (ev.type === 'error') error = ev.message
    }
    const parsed = error ? null : parseConsolidation(text)
    if (!parsed) return (console.log(`[memory] consolidation failed: ${error ?? 'resposta fora do formato'}`), false)
    if (db.meta('heritageAt') !== epoch) return false

    db.setSummary(conv.id, parsed.summary, chunk.at(-1)!.at)
    emit({ type: 'conversation', conversation: db.conversation(conv.id)! })
    const threads = db.threadRoots(conv.id)
    if (settings.memoryLearning !== 'off' && opts.learn !== false) this.applyExtraction(parsed.ops, chunk, conv.id, learners, settings.memoryLearning, (m) => !m.threadId && !threads.has(m.id))
    return true
  }

  // ---------- threads ----------

  // A thread's own summary and the memories in it, in one call. 'grown': only once more than
  // MAX_AFTER messages follow its summary (the older ones leave the replies' window); 'quiet':
  // it stopped (sweep), with at least THREAD_MIN messages to read; 'now': asked for. One at a time per thread.
  consolidateThread(rootId: string, reason: 'grown' | 'quiet' | 'now'): Promise<void> {
    const key = `thread:${rootId}`
    const current = this.running.get(key)
    if (current) return current
    const p = this.doThread(rootId, reason)
      .then(() => {})
      .catch((e: unknown) => console.error('[memory]', e))
      .finally(() => this.running.delete(key))
    this.running.set(key, p)
    return p
  }

  // The threads quiet for THREAD_QUIET_MS with at least THREAD_MIN messages since their summary,
  // a few per call (the clock calls it every minute), never one with a reply still being
  // written. Each is tried once per stretch: if it fails, it waits for something new in it.
  async sweep(now = Date.now()): Promise<void> {
    const { db } = this.deps
    const due = db.quietThreads(now - THREAD_QUIET_MS, now - THREAD_HORIZON_MS).filter((t) => {
      if (this.swept.get(t.id) === t.last) return false
      const root = db.message(t.id)
      const since = root?.threadSummary?.until ?? 0
      const replies = db.recentMessages(t.conversationId, 1000, t.id)
      if (replies.some((m) => m.run?.status === 'working')) return false
      return [root, ...replies].filter((m) => m && m.at > since && m.author.kind !== 'system' && m.text.trim()).length >= THREAD_MIN
    })
    for (const t of due.slice(0, SWEEP_BATCH)) {
      this.swept.set(t.id, t.last)
      await this.consolidateThread(t.id, 'quiet')
    }
  }

  // True when a part was summarized (a rebuild goes on to the next one).
  private async doThread(rootId: string, reason: 'grown' | 'quiet' | 'now', opts: { learn?: boolean; batch?: number } = {}): Promise<boolean> {
    const { db, engines, emit } = this.deps
    const root = db.message(rootId)
    if (!root || root.threadId) return false
    const since = root.threadSummary?.until ?? 0
    const all = [root, ...db.recentMessages(root.conversationId, 1000, root.id)].filter((m) => m.at > since && m.author.kind !== 'system' && m.text.trim())
    if (reason === 'grown' && all.length <= MAX_AFTER) return false
    if (reason === 'quiet' && all.length < THREAD_MIN) return false
    const stretch = all.slice(0, opts.batch ?? MAX_CHUNK)
    if (stretch.length === 0) return false
    const epoch = db.meta('heritageAt')

    const settings = await this.deps.settings()
    const model = usable(modelInfo(settings.memoryModel)) ?? modelInfo('haiku')!
    const status = settings.engines[model.engine]
    if (!status.installed || !status.loggedIn) return (console.log(`[memory] skipped: ${ENGINES[model.engine].label} not ready`), false)

    const cwd = join(this.deps.workDir, '_memory')
    mkdirSync(cwd, { recursive: true })
    const where = db.conversationOwner(root.conversationId) ?? { kind: 'channel' as const }
    const learners = this.learners(where, stretch)
    const prompt = consolidationPrompt({
      summary: root.threadSummary?.text,
      messages: stretch,
      people: this.names(settings),
      agents: db.agents(),
      ...this.aboutPeople(learners, settings, where),
      thread: true
    })
    const started = Date.now()
    let text = ''
    let error: string | undefined
    for await (const ev of engines[model.engine].run({ model: model.id, effort: 'low', system: memorySystem(), prompt, cwd, signal: AbortSignal.timeout(120_000) })) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'done') {
        text = ev.text || text
        db.addReceipt({ ...ev.usage, model: model.id, ms: Date.now() - started, messageId: rootId, agentId: 'memory', engine: model.engine, at: Date.now() })
      } else if (ev.type === 'error') error = ev.message
    }
    const parsed = error ? null : parseConsolidation(text)
    if (!parsed) return (console.log(`[memory] thread consolidation failed: ${error ?? 'resposta fora do formato'}`), false)
    if (db.meta('heritageAt') !== epoch || !db.message(rootId)) return false

    db.setThreadSummary(rootId, parsed.summary, stretch.at(-1)!.at)
    emit({ type: 'message', message: db.message(rootId)! })
    if (settings.memoryLearning !== 'off' && opts.learn !== false) this.applyExtraction(parsed.ops, stretch, root.conversationId, learners, settings.memoryLearning)
    return true
  }

  editThreadSummary(rootId: string, text: string): void {
    const root = this.deps.db.message(rootId)
    if (!root || root.threadId) return
    this.deps.db.setThreadSummary(rootId, text.trim())
    this.deps.emit({ type: 'message', message: this.deps.db.message(rootId)! })
  }

  // Whether a memory about `person` names someone else in the Tucano (by their first or whole name,
  // as a word of its own). A Tucano of one has no one else: what its person says is kept as always.
  private namesSomeoneElse(text: string, person: string): boolean {
    const others = this.deps.db.people({ removed: true }).filter((p) => p.id !== person)
    if (!others.length) return false
    const words = ` ${fold(text)} `
    return others.some((p) => {
      const name = fold(p.name)
      const first = name.split(' ')[0] ?? ''
      return (first.length >= 3 && words.includes(` ${first} `)) || (name.includes(' ') && words.includes(` ${name} `))
    })
  }

  // The people's names as the transcript shows them (the owner's is the workspace's name).
  private names(settings: Settings): Pick<Person, 'id' | 'name'>[] {
    const owner = this.deps.db.ownerId()
    return this.deps.db.people({ removed: true }).map((p) => (p.id === owner ? { id: p.id, name: settings.workspaceName } : p))
  }

  // `counts`: which messages of the chunk may back a memory (the rest is only read for context).
  // Each memory is about the person whose own words back it, and kept in their scope: someone
  // else's word about them, or an agent's guess, never is.
  private applyExtraction(ops: Op[], chunk: Message[], conversationId: string, learners: string[], learning: 'approve' | 'auto', counts: (m: Message) => boolean = () => true): void {
    const conv = this.deps.db.conversationOwner(conversationId) ?? { kind: 'channel' as const }
    const known = new Map(this.about(learners, conv).map((m) => [m.id, m]))
    // Learned in a DM: that person's, for their DMs alone.
    const privateTo = this.privateIn(conv)
    const backing = (nums: number[]): Message[] => nums.map((n) => chunk[n - 1]).filter((m): m is Message => m?.author.kind === 'person' && learners.includes(m.author.id) && counts(m))
    const by = (msgs: Message[], person: string): string[] => msgs.filter((m) => m.author.kind === 'person' && m.author.id === person).map((m) => m.id)
    for (const op of ops) {
      if (op.op === 'confirm') {
        const m = known.get(op.id)
        if (m) this.save({ ...m, confirmedAt: Date.now() })
        continue
      }
      const msgs = backing(op.evidence)
      const replaces = op.op === 'update' ? known.get(op.id) : undefined
      if (op.op === 'update' && !replaces) continue
      // An update stays with whom the memory was about; a new one goes to who said most of it.
      const about = replaces ? scopePerson(replaces.scope)! : learners.map((p) => ({ p, n: by(msgs, p).length })).sort((a, b) => b.n - a.n)[0]?.p
      const ids = about ? by(msgs, about) : []
      if (!about || ids.length === 0) continue
      // What one person says about another isn't a fact about either: it would reach prompts as one.
      if (op.op === 'add' && this.namesSomeoneElse(op.text, about)) continue
      this.propose({ scope: personScope(about), text: op.text, origin: 'extraction', conversationId, messageIds: ids, replaces: replaces?.id, active: learning === 'auto', ...(privateTo ? { privateTo } : {}) })
    }
  }

  // ---------- long term ----------

  // The one way memories come in, so every path gets the same checks.
  private propose(p: { scope: MemoryScope; text: string; origin: Memory['origin']; agentId?: string; conversationId?: string; messageIds: string[]; replaces?: string; active: boolean; privateTo?: string }):
    | { kind: 'forgotten' }
    | { kind: 'duplicate'; memory: Memory }
    | { kind: 'saved'; memory: Memory } {
    const { db } = this.deps
    const key = normalize(p.text)
    // Someone's private note is no one else's. About a person, it's the same memory wherever it was
    // learned: forgotten is forgotten, and said again outside their DM it's no longer the DM's alone.
    const aboutPerson = !!scopePerson(p.scope)
    const alike = (m: Memory): boolean => normalize(m.text) === key && (aboutPerson || m.privateTo === p.privateTo)
    if (db.memories({ scope: p.scope, state: 'forgotten' }).some(alike)) return { kind: 'forgotten' }
    const same = db.memories({ scope: p.scope }).find((m) => (m.state === 'active' || m.state === 'pending') && alike(m))
    if (same) {
      const opened = same.privateTo && !p.privateTo ? { privateTo: undefined } : {}
      if (same.state === 'active' || 'privateTo' in opened) this.save({ ...same, ...opened, ...(same.state === 'active' ? { confirmedAt: Date.now() } : {}) })
      return { kind: 'duplicate', memory: same }
    }
    const now = Date.now()
    const memory: Memory = {
      id: this.newId(),
      scope: p.scope,
      text: p.text,
      state: p.active ? 'active' : 'pending',
      origin: p.origin,
      agentId: p.agentId,
      conversationId: p.conversationId,
      messageIds: p.messageIds,
      replaces: p.replaces,
      ...(p.privateTo ? { privateTo: p.privateTo } : {}),
      createdAt: now,
      confirmedAt: now
    }
    this.save(memory)
    if (p.active) this.archiveReplaced(memory)
    return { kind: 'saved', memory }
  }

  // Called by the runner when an agent uses `lembrar`. `personId`: who "the user" is in this reply.
  remember(agent: Agent, conv: Conversation, args: Record<string, unknown>, personId = this.deps.db.ownerId()): { memory?: Memory; reply: string; label?: string; error?: boolean } {
    const text = typeof args['texto'] === 'string' ? args['texto'].trim() : ''
    if (!text) return { reply: L('Faltou o texto da memória.', "Missing the memory's text."), error: true }
    if (text.length > MAX_MEMORY_CHARS) return { reply: L(`Memória longa demais: use até ${MAX_MEMORY_CHARS} caracteres, uma ideia só.`, `Memory too long: use up to ${MAX_MEMORY_CHARS} characters, one idea only.`), error: true }
    const theirs = personScope(personId)
    const scope: MemoryScope = args['sobre'] === 'agente' ? agent.id : theirs
    if (scope === theirs && this.namesSomeoneElse(text, personId))
      return { reply: L('Não guardei: uma memória "usuario" é sobre a pessoa com quem você fala, e esta fala de outra pessoa do Tucano. O que alguém diz de outra pessoa não vira fato sobre ninguém.', "Not saved: a \"usuario\" memory is about the person you talk to, and this one is about someone else in this Tucano. What someone says about another person isn't a fact about anyone."), error: true }
    // Made in a DM, an agent's note, or what it learned about the person, is that DM's person's alone ("só você vê").
    const privateTo = this.privateIn(conv)
    let replaces: string | undefined
    if (typeof args['substitui'] === 'string' && args['substitui'].trim()) {
      const old = this.deps.db.memory(args['substitui'].trim())
      if (!old || old.state !== 'active' || (old.scope !== theirs && old.scope !== agent.id) || (old.privateTo !== undefined && old.privateTo !== personId) || !this.readableIn(conv)(old)) return { reply: L(`Não achei a memória ${args['substitui']} pra substituir.`, `I couldn't find memory ${args['substitui']} to replace.`), error: true }
      if (old.scope !== scope) return { reply: L(`A memória ${old.id} é de outro escopo; use "sobre" igual ao dela.`, `Memory ${old.id} has a different scope; use the same "sobre" as it.`), error: true }
      replaces = old.id
    }
    const lastMine = this.deps.db
      .recentMessages(conv.id, 20)
      .reverse()
      .find((m) => m.author.kind === 'person' && m.author.id === personId)
    const active = agent.memory === 'auto'
    const r = this.propose({ scope, text, origin: 'agent', agentId: agent.id, conversationId: conv.id, messageIds: lastMine ? [lastMine.id] : [], replaces, active, ...(privateTo ? { privateTo } : {}) })
    if (r.kind === 'forgotten') return { reply: L('Isso foi esquecido a pedido do usuário. Não guarde de novo nem mencione.', "That was forgotten at the user's request. Don't save it again or mention it.") }
    if (r.kind === 'duplicate') return { reply: L('Isso já está na memória.', "That's already in memory.") }
    return active
      ? { memory: r.memory, label: L('Guardou na memória', 'Saved to memory'), reply: L('Guardado. Siga com a resposta sem anunciar que guardou.', 'Saved. Go on with your reply without announcing you saved it.') }
      : { memory: r.memory, label: L('Quer guardar na memória', 'Wants to save to memory'), reply: L('Virou um pedido: o usuário decide se guarda. Siga com a resposta.', 'It became a request: the user decides whether to save it. Go on with your reply.') }
  }

  add(scope: MemoryScope, text: string): void {
    const clean = text.trim().slice(0, MAX_MEMORY_CHARS)
    if (clean) this.propose({ scope, text: clean, origin: 'me', messageIds: [], active: true })
  }

  edit(id: string, text: string): void {
    const m = this.deps.db.memory(id)
    const clean = text.trim().slice(0, MAX_MEMORY_CHARS)
    if (m && clean && (m.state === 'active' || m.state === 'pending')) this.save({ ...m, text: clean, confirmedAt: Date.now() })
  }

  confirm(id: string): void {
    const m = this.deps.db.memory(id)
    if (m?.state === 'active') this.save({ ...m, confirmedAt: Date.now() })
  }

  decide(id: string, accept: boolean): void {
    const m = this.deps.db.memory(id)
    if (m?.state !== 'pending') return
    if (!accept) return this.remove(id) // a discarded suggestion was never a memory
    const memory: Memory = { ...m, state: 'active', confirmedAt: Date.now() }
    this.save(memory)
    this.archiveReplaced(memory)
  }

  // Keeps the text as a record, so it is not learned again.
  forget(id: string, reason?: string): void {
    const m = this.deps.db.memory(id)
    if (m && m.state !== 'forgotten') this.save({ ...m, state: 'forgotten', reason })
  }

  purge(id: string): void {
    if (this.deps.db.memory(id)?.state === 'forgotten') this.remove(id)
  }

  editSummary(conversationId: string, text: string): void {
    this.deps.db.setSummary(conversationId, text.trim())
    const conv = this.deps.db.conversation(conversationId)
    if (conv) this.deps.emit({ type: 'conversation', conversation: conv })
  }

  private archiveReplaced(m: Memory): void {
    const old = m.replaces ? this.deps.db.memory(m.replaces) : undefined
    if (old?.state === 'active') this.save({ ...old, state: 'archived' })
  }

  private save(m: Memory): void {
    this.deps.db.saveMemory(m)
    this.deps.emit({ type: 'memory', memory: m })
  }

  // Gone for good. Someone's own memory (about them, or private to them) is no one else's news.
  private remove(id: string): void {
    const m = this.deps.db.memory(id)
    this.deps.db.deleteMemory(id)
    const whose = m ? (m.privateTo ?? scopePerson(m.scope)) : undefined
    this.deps.emit({ type: 'memory_removed', id, ...(whose ? { for: whose } : {}) })
  }

  // Short ids: the model reads and writes them back (`substitui`, `update`).
  private newId(): string {
    for (;;) {
      const id = randomBytes(4).toString('hex')
      if (!this.deps.db.memory(id)) return id
    }
  }
}

// ---------- search ----------

// Lowercase, no accents, words of letters and digits.
const words = (text: string): string[] => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []

// A light stem for Portuguese, both ways: "preferências" finds "prefere" and
// "deploys" finds "deploy" (a shared start of 5 letters, or all of a 4-letter
// word). Shorter words (PR, CI, v2) must match whole.
function matches(term: string, word: string): boolean {
  if (word === term) return true
  if (term.length < 4 || word.length < 4) return false
  let common = 0
  while (common < term.length && term[common] === word[common]) common++
  return common >= Math.min(5, term.length, word.length)
}

// BM25 over the memories given, best first; ties go to the most recently confirmed.
export function rankMemories(memories: Memory[], query: string, limit = 5): Memory[] {
  return rank(memories, (m) => m.text, query, limit, (x, y) => y.confirmedAt - x.confirmedAt)
}

// BM25 over any items, by their text, best first (at most 10); `tie` orders equal scores.
function rank<T>(items: T[], text: (t: T) => string, query: string, limit: number, tie: (x: T, y: T) => number): T[] {
  const terms = [...new Set(words(query))]
  if (!terms.length || !items.length) return []
  const docs = items.map((m) => ({ m, w: words(text(m)) }))
  const avg = docs.reduce((n, d) => n + d.w.length, 0) / docs.length || 1
  const k1 = 1.2
  const b = 0.75
  const idf = new Map(terms.map((t) => {
    const n = docs.filter((d) => d.w.some((w) => matches(t, w))).length
    return [t, Math.log(1 + (docs.length - n + 0.5) / (n + 0.5))]
  }))
  return docs
    .map((d) => ({
      m: d.m,
      score: terms.reduce((sum, t) => {
        const tf = d.w.filter((w) => matches(t, w)).length
        return tf ? sum + idf.get(t)! * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.w.length) / avg))) : sum
      }, 0)
    }))
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score || tie(x.m, y.m))
    .slice(0, Math.min(Math.max(1, Math.floor(limit)), 10))
    .map((r) => r.m)
}
