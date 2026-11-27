// A short title for each request (the board's cards): when a reply starts on a request, a cheap model
// (the memory's, Settings › Memory) names what it's about in a few words, kept on the request message.
// Once per request; a request already short is its own title (src/shared/titles.ts) and costs nothing.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { L } from '../shared/lang'
import type { CoreEvent } from '../shared/rpc'
import { cleanTitle, titledAlready } from '../shared/titles'
import { modelInfo, usable, type EngineId, type Message, type Settings } from '../shared/types'
import type { Db } from './db'
import type { Engine } from './engines/types'

export const titleSystem = (): string =>
  L(
    'Você dá títulos curtos a pedidos de trabalho. Responda só com o título: de 2 a 6 palavras, na língua do pedido, sem aspas e sem ponto final. Diga o assunto, como o nome de uma tarefa num quadro (ex.: "Notas da versão 0.2.37", "App fecha ao arquivar agente"). Não ponha o nome de quem pediu nem de quem vai fazer.',
    'You give short titles to work requests. Answer with the title only: 2 to 6 words, in the request’s language, no quotes and no closing period. Name the subject, like a task on a board (e.g. "Release notes for 0.2.37", "App crashes when archiving an agent"). Leave out who asked and who will do it.'
  )

// What a session is called: the same job as a title, for the reply itself rather than the request that
// started it. Its own model (Settings › Models › Session names), so the two can be picked apart.
export const sessionNameSystem = (): string =>
  L(
    'Você dá nome a sessões de trabalho. Responda só com o nome: de 2 a 5 palavras, na língua do pedido, sem aspas e sem ponto final. Diga o que a sessão está fazendo, como o título de uma conversa (ex.: "Nomes das sessões", "Ícone do app no macOS"). Não ponha o nome de quem pediu nem de quem faz.',
    'You name work sessions. Answer with the name only: 2 to 5 words, in the request’s language, no quotes and no closing period. Say what the session is doing, like a conversation’s title (e.g. "Session names", "App icon on macOS"). Leave out who asked and who will do it.'
  )

const PROMPT_MAX = 1500

export interface TitlesDeps {
  db: Db
  engines: Record<EngineId, Engine>
  settings: () => Promise<Settings>
  emit: (e: CoreEvent) => void
  workDir: string
}

export class Titles {
  private seen = new Set<string>()
  private named = new Set<string>()
  constructor(private deps: TitlesDeps) {}

  // A reply just started: the request it works on gets its title (a person's message, or the note that
  // opened a part handed on to it), and the reply itself is given the name of its session.
  forReply(m: Message): void {
    if (m.author.kind !== 'agent' || m.run?.status !== 'working') return
    const id = m.run.replyTo ?? (m.run.handed ? this.deps.db.delegation(m.run.handed)?.rootId : undefined)
    if (id) void this.title(id).catch((e: unknown) => console.error('[titles]', e))
    void this.nameSession(m, id).catch((e: unknown) => console.error('[titles]', e))
  }

  // The name of the reply's session, kept on the reply and shown next to the agent's name (and as the
  // thread's name when the reply opens one). Made once, in the background: the reply doesn't wait for
  // it. `off` in Settings › Models › Session names leaves sessions unnamed.
  async nameSession(m: Message, requestId?: string): Promise<string | undefined> {
    if (!m.run || m.run.sessionName || this.named.has(m.id)) return undefined
    this.named.add(m.id)
    const { db } = this.deps
    const settings = await this.deps.settings()
    const chosen = (settings.sessionNameModel ?? '').trim()
    if (chosen === 'off') return undefined
    // What the session is about: the request under it, the task it was given, or what it opened with.
    const request = requestId ? db.message(requestId) : undefined
    const about = (request?.text || m.run.task || m.text || '').trim()
    if (!about) return undefined
    const model = usable(modelInfo(chosen || settings.memoryModel)) ?? modelInfo('haiku')!
    const status = settings.engines[model.engine]
    if (!status?.installed || !status.loggedIn) return undefined
    const cwd = join(this.deps.workDir, '_titles')
    mkdirSync(cwd, { recursive: true })
    const started = Date.now()
    let text = ''
    for await (const ev of this.deps.engines[model.engine].run({ model: model.id, effort: 'low', system: sessionNameSystem(), prompt: about.slice(0, PROMPT_MAX), cwd, signal: AbortSignal.timeout(60_000) })) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'done') {
        text = ev.text || text
        db.addReceipt({ ...ev.usage, model: model.id, ms: Date.now() - started, messageId: m.id, agentId: 'titles', engine: model.engine, at: Date.now() })
      } else if (ev.type === 'error') return undefined
    }
    const name = cleanTitle(text)
    if (!name) return undefined
    db.setRunSessionName(m.id, name)
    const saved = db.message(m.id)
    if (saved) this.deps.emit({ type: 'message', message: saved })
    return name
  }

  async title(id: string): Promise<string | undefined> {
    if (this.seen.has(id)) return undefined
    this.seen.add(id)
    const { db } = this.deps
    const m = db.message(id)
    // A routine's run is called by the routine's name; a request short already needs nothing.
    if (!m || m.title || m.author.kind === 'routine' || m.author.kind === 'system' || !m.text.trim() || titledAlready(m.text)) return undefined
    const settings = await this.deps.settings()
    const model = usable(modelInfo(settings.memoryModel)) ?? modelInfo('haiku')!
    const status = settings.engines[model.engine]
    if (!status?.installed || !status.loggedIn) return undefined
    const cwd = join(this.deps.workDir, '_titles')
    mkdirSync(cwd, { recursive: true })
    const started = Date.now()
    let text = ''
    for await (const ev of this.deps.engines[model.engine].run({ model: model.id, effort: 'low', system: titleSystem(), prompt: m.text.slice(0, PROMPT_MAX), cwd, signal: AbortSignal.timeout(60_000) })) {
      if (ev.type === 'text') text += ev.delta
      else if (ev.type === 'done') {
        text = ev.text || text
        db.addReceipt({ ...ev.usage, model: model.id, ms: Date.now() - started, messageId: id, agentId: 'titles', engine: model.engine, at: Date.now() })
      } else if (ev.type === 'error') return undefined
    }
    const title = cleanTitle(text)
    if (!title) return undefined
    db.setMessageTitle(id, title)
    const saved = db.message(id)
    if (saved) this.deps.emit({ type: 'message', message: saved })
    return title
  }
}
