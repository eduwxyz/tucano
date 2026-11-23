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
import { memoryEffort } from './memory'

export const titleSystem = (): string =>
  L(
    'Você dá títulos curtos a pedidos de trabalho. Responda só com o título: de 2 a 6 palavras, na língua do pedido, sem aspas e sem ponto final. Diga o assunto, como o nome de uma tarefa num quadro (ex.: "Notas da versão 0.2.37", "App fecha ao arquivar agente"). Não ponha o nome de quem pediu nem de quem vai fazer.',
    'You give short titles to work requests. Answer with the title only: 2 to 6 words, in the request’s language, no quotes and no closing period. Name the subject, like a task on a board (e.g. "Release notes for 0.2.37", "App crashes when archiving an agent"). Leave out who asked and who will do it.'
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
  constructor(private deps: TitlesDeps) {}

  // A reply just started: the request it works on gets its title (a person's message, or the note that
  // opened a part handed on to it).
  forReply(m: Message): void {
    if (m.author.kind !== 'agent' || m.run?.status !== 'working') return
    const id = m.run.replyTo ?? (m.run.handed ? this.deps.db.delegation(m.run.handed)?.rootId : undefined)
    if (id) void this.title(id).catch((e: unknown) => console.error('[titles]', e))
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
    for await (const ev of this.deps.engines[model.engine].run({ model: model.id, effort: memoryEffort(settings), system: titleSystem(), prompt: m.text.slice(0, PROMPT_MAX), cwd, signal: AbortSignal.timeout(60_000) })) {
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
