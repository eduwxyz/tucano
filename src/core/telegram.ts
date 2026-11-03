// The phone (spec §19): a Telegram bot of the user's own sends approvals with
// buttons, agents' questions (answered by replying to them) and what routines
// did. The app asks Telegram for updates (long polling), so nothing needs to
// reach this Mac. It answers only the chat paired with a code shown in the app.
import { randomInt } from 'node:crypto'
import { L } from '../shared/lang'
import type { Approval, Message, TelegramInfo } from '../shared/types'
import type { Secrets } from './secrets'
import type { PhoneTarget } from './telegram-router'

const API = 'https://api.telegram.org'
const TOKEN = 'telegram:token'
const CHAT = 'telegram:chat'
const REPLIES = 'telegram:replies'
const POLL_SECONDS = 50
const RETRY_MS = 15_000
const MAX_TEXT = 4_000 // Telegram allows 4096 per message

type Fetch = typeof fetch
type Update = {
  update_id: number
  message?: { message_id: number; chat: { id: number; first_name?: string; username?: string; title?: string }; text?: string; reply_to_message?: { message_id: number } }
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } }
}

export interface TelegramDeps {
  secrets: Pick<Secrets, 'get' | 'set'>
  decide(approvalId: string, decision: 'approved' | 'refused', reason?: string): Promise<void>
  approval(id: string): Approval | undefined
  answer(conversationId: string, text: string): void // a reply to a question, as if I wrote it in the app
  receive?(text: string, reply?: PhoneTarget): Promise<PhoneTarget> // triage before posting; replies bypass triage
  canReceive?(): boolean // only new tasks; approvals and replies are independent
  changed(): void // the bot or the pairing changed: settings show it
  fetch?: Fetch
}

export class Telegram {
  private bot?: string
  private chat?: { id: number; name: string }
  private code = String(randomInt(100_000, 1_000_000))
  private error?: string
  private loop?: AbortController
  private offset = 0
  private questions = new Map<number, PhoneTarget>() // Telegram message id → exact destination
  private saving: Promise<void> = Promise.resolve()

  constructor(private deps: TelegramDeps) {}

  private get f(): Fetch {
    return this.deps.fetch ?? fetch
  }

  info(): TelegramInfo {
    return { bot: this.bot, chat: this.chat?.name, code: this.bot && !this.chat ? this.code : undefined, error: this.error }
  }

  async start(): Promise<void> {
    const token = await this.deps.secrets.get(TOKEN)
    if (!token) return
    this.chat = (await this.deps.secrets.get(CHAT).then((s) => (s ? (JSON.parse(s) as { id: number; name: string }) : undefined))) ?? undefined
    try {
      const saved = JSON.parse((await this.deps.secrets.get(REPLIES)) ?? '{}') as { chatId?: number; entries?: [number, PhoneTarget][] }
      if (this.chat && saved.chatId === this.chat.id && Array.isArray(saved.entries)) this.questions = new Map(saved.entries.filter(([id, t]) => Number.isSafeInteger(id) && t && typeof t.conversationId === 'string' && typeof t.workspaceId === 'string'))
    } catch { this.questions.clear() }
    try {
      this.bot = await this.me(token)
      this.error = undefined
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e)
    }
    this.deps.changed()
    this.listen(token)
  }

  stop(): void {
    this.loop?.abort()
    this.loop = undefined
  }

  // Checked with Telegram before it's saved; null forgets the bot and the pairing.
  async setToken(token: string | null): Promise<void> {
    const t = token?.trim()
    if (t) await this.me(t)
    this.stop()
    await this.saving.catch(() => {})
    this.questions.clear()
    await this.deps.secrets.set(REPLIES, undefined)
    this.offset = 0
    await this.deps.secrets.set(TOKEN, t || undefined)
    await this.deps.secrets.set(CHAT, undefined)
    this.bot = undefined
    this.chat = undefined
    this.error = undefined
    this.code = String(randomInt(100_000, 1_000_000))
    if (t) await this.start()
    else this.deps.changed()
  }

  async unpair(): Promise<void> {
    await this.saving.catch(() => {})
    this.questions.clear()
    await this.deps.secrets.set(REPLIES, undefined)
    await this.deps.secrets.set(CHAT, undefined)
    this.chat = undefined
    this.code = String(randomInt(100_000, 1_000_000))
    this.deps.changed()
  }

  private async me(token: string): Promise<string> {
    let res: Response
    try {
      res = await this.f(`${API}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) })
    } catch {
      throw new Error(L('Não consegui falar com o Telegram. Confira a internet.', "I couldn't reach Telegram. Check the internet."))
    }
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null
    if (!res.ok || !body?.ok) throw new Error(L('O Telegram recusou esse token. Copie de novo do @BotFather.', 'Telegram refused that token. Copy it again from @BotFather.'))
    return `@${body.result?.username ?? 'bot'}`
  }

  private async api(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const token = await this.deps.secrets.get(TOKEN)
    if (!token) return undefined
    const res = await this.f(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: signal ?? AbortSignal.timeout(15_000)
    })
    const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; description?: string } | null
    if (!body?.ok) throw new Error(body?.description ?? `Telegram ${res.status}`)
    return body.result
  }

  private listen(token: string): void {
    this.stop()
    const ctl = new AbortController()
    this.loop = ctl
    void (async () => {
      while (!ctl.signal.aborted) {
        try {
          const res = await this.f(`${API}/bot${token}/getUpdates?timeout=${POLL_SECONDS}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`, {
            signal: AbortSignal.any([ctl.signal, AbortSignal.timeout((POLL_SECONDS + 10) * 1000)])
          })
          const body = (await res.json()) as { ok: boolean; result?: Update[]; description?: string }
          if (!body.ok) throw new Error(body.description ?? `Telegram ${res.status}`)
          for (const u of body.result ?? []) {
            this.offset = u.update_id + 1
            await this.handle(u).catch((e: unknown) => console.error('[telegram]', e))
          }
          if (this.error) {
            this.error = undefined
            this.deps.changed()
          }
        } catch (e) {
          if (ctl.signal.aborted) return
          const why = e instanceof Error ? e.message : String(e)
          if (why !== this.error) {
            this.error = why
            this.deps.changed()
          }
          await new Promise((r) => setTimeout(r, RETRY_MS))
        }
      }
    })()
  }

  private async handle(u: Update): Promise<void> {
    const m = u.message
    if (m?.text !== undefined) {
      if (!this.chat) {
        // Pairing: only someone who sees the code in the app can take the bot.
        if (m.text.replace('/start', '').trim() !== this.code) return
        this.chat = { id: m.chat.id, name: m.chat.title ?? m.chat.first_name ?? m.chat.username ?? 'Telegram' }
        await this.deps.secrets.set(CHAT, JSON.stringify(this.chat))
        this.deps.changed()
        await this.send(
          L(
            'Pronto: este chat recebe as aprovações, as perguntas dos agentes e o fim das rotinas. No app, você pode ativar o envio de tarefas e o recebimento de todas as respostas concluídas separadamente. Pra continuar uma conversa, responda à mensagem dela.',
            "Done: this chat gets approvals, agents' questions and routine results. In the app, you can separately enable sending tasks and receiving all finished replies. To continue a conversation, reply to its message."
          )
        )
        return
      }
      if (m.chat.id !== this.chat.id) return
      if (!m.text.trim()) return
      const reply = m.reply_to_message && this.questions.get(m.reply_to_message.message_id)
      if (m.reply_to_message && !reply) {
        await this.send(L('Não reconheço essa mensagem. Mande uma nova tarefa sem responder, ou responda a uma mensagem recente do agente.', 'I do not recognize that message. Send a new task without replying, or reply to a recent agent message.'))
      } else if (!reply && this.deps.canReceive?.() === false) {
        await this.send(L('Para enviar novas tarefas, ative “Enviar mensagens aos agentes” em Configurações → Celular e GitHub. Você ainda pode responder às perguntas e usar os botões de aprovação.', 'To send new tasks, enable “Send messages to agents” in Settings → Phone and GitHub. You can still reply to questions and use approval buttons.'), { reply_to_message_id: m.message_id })
      } else if (this.deps.receive || reply) {
        try {
          const destination = this.deps.receive ? await this.deps.receive(m.text, reply || undefined) : reply!
          if (!this.deps.receive) this.deps.answer(destination.conversationId, m.text)
          const id = await this.send(L('Mandei a sua mensagem.', 'I sent your message.'), { reply_to_message_id: m.message_id })
          if (id) await this.remember(id, destination)
        } catch {
          await this.send(L('Não consegui enviar. Confira o canal e os agentes no app e tente de novo.', 'I could not send it. Check the channel and agents in the app and try again.'), { reply_to_message_id: m.message_id })
        }
      } else {
        await this.send(L('Pra responder a um agente, responda à mensagem da pergunta (deslize pro lado). Aprovações têm botões.', "To answer an agent, reply to the question's message (swipe it sideways). Approvals have buttons."))
      }
      return
    }

    const q = u.callback_query
    if (!q?.data || !this.chat || q.message?.chat.id !== this.chat.id) return
    const [kind, id, action] = q.data.split(':')
    const ap = kind === 'ap' && id ? this.deps.approval(id) : undefined
    const edit = (text: string, buttons?: unknown): Promise<unknown> =>
      this.api('editMessageText', { chat_id: this.chat!.id, message_id: q.message!.message_id, text, ...(buttons ? { reply_markup: buttons } : {}) })
    if (!ap || ap.state !== 'pending') {
      await this.api('answerCallbackQuery', { callback_query_id: q.id, text: L('Esse pedido já foi decidido.', 'That request was already decided.') })
      if (ap) await edit(`${approvalText(ap)}\n\n${ap.state === 'approved' ? L('✅ Aprovado', '✅ Approved') : ap.state === 'refused' ? L('❌ Recusado', '❌ Refused') : L('Expirou', 'Expired')}`).catch(() => {})
      return
    }
    if (action === 'ok' && ap.highRisk) {
      // In the app this needs a long press; here, a second tap.
      await this.api('answerCallbackQuery', { callback_query_id: q.id })
      await edit(`${approvalText(ap)}\n\n${L('⚠️ Alto risco. Tem certeza?', '⚠️ High risk. Are you sure?')}`, {
        inline_keyboard: [[{ text: L('Sim, executar', 'Yes, run it'), callback_data: `ap:${ap.id}:sure` }, { text: L('Recusar', 'Refuse'), callback_data: `ap:${ap.id}:no` }]]
      })
      return
    }
    const approve = action === 'ok' || action === 'sure'
    await this.api('answerCallbackQuery', { callback_query_id: q.id, text: approve ? L('Aprovado', 'Approved') : L('Recusado', 'Refused') })
    await edit(`${approvalText(ap)}\n\n${approve ? L('✅ Aprovado pelo Telegram', '✅ Approved from Telegram') : L('❌ Recusado pelo Telegram', '❌ Refused from Telegram')}`)
    await this.deps.decide(ap.id, approve ? 'approved' : 'refused', approve ? undefined : L('Recusado pelo Telegram', 'Refused from Telegram'))
  }

  private async send(text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    if (!this.chat) return undefined
    const r = (await this.api('sendMessage', { chat_id: this.chat.id, text: clip(toPlainText(text)), ...extra }).catch((e: unknown) => console.error('[telegram]', e))) as { message_id?: number } | undefined
    return r?.message_id
  }

  // ---------- what goes to the phone ----------

  private remember(id: number, target: PhoneTarget): Promise<void> {
    this.questions.set(id, target)
    while (this.questions.size > 2000) this.questions.delete(this.questions.keys().next().value!)
    const saved = JSON.stringify({ chatId: this.chat?.id, entries: [...this.questions] })
    this.saving = this.saving.catch(() => {}).then(() => this.deps.secrets.set(REPLIES, saved))
    return this.saving
  }

  async approvalAsked(ap: Approval, agentName: string, workspaceId = 'default'): Promise<void> {
    const id = await this.send(`${L(`${agentName} pede aprovação`, `${agentName} asks for approval`)}\n\n${approvalText(ap)}`, {
      reply_markup: { inline_keyboard: [[{ text: L('Aprovar', 'Approve'), callback_data: `ap:${ap.id}:ok` }, { text: L('Recusar', 'Refuse'), callback_data: `ap:${ap.id}:no` }]] }
    })
    if (id) await this.remember(id, { workspaceId, conversationId: ap.conversationId, agentId: ap.agentId, messageId: ap.messageId })
  }

  async questionAsked(msg: Message, agentName: string, where: string, workspaceId = 'default'): Promise<void> {
    if (!msg.run?.question) return
    const id = await this.send(
      L(`${agentName} pergunta (${where}):\n\n${msg.run.question}\n\nResponda a esta mensagem.`, `${agentName} asks (${where}):\n\n${msg.run.question}\n\nReply to this message.`),
      { reply_markup: { force_reply: true, input_field_placeholder: L('Sua resposta', 'Your answer') } }
    )
    if (id) await this.remember(id, { workspaceId, conversationId: msg.conversationId, agentId: msg.author.kind === 'agent' ? msg.author.id : undefined, messageId: msg.id })
  }

  async finished(msg: Message, agentName: string, where: string, workspaceId = 'default'): Promise<void> {
    if (!this.chat || !msg.text.trim()) return
    const header = `${agentName} (${where}):\n\n`
    const continuationPrefix = `${agentName} (${where}):\n${L('continuando mensagem...', 'continuing message...')}`
    const target = { workspaceId, conversationId: msg.conversationId, agentId: msg.author.kind === 'agent' ? msg.author.id : undefined, messageId: msg.id }

    // Split into Telegram-safe parts without cutting words; continuation parts
    // get the agent/channel header plus a "continuing message…" notice.
    // Reserve room on the first part for the header.
    const parts = splitMessage(msg.text, MAX_TEXT - header.length, continuationPrefix)
    const firstPart = header + parts[0]
    const id = await this.send(firstPart)
    if (id) await this.remember(id, target)
    for (let i = 1; i < parts.length; i++) {
      const partId = await this.send(parts[i]!)
      if (partId) await this.remember(partId!, target)
    }
  }

  async notice(title: string, body: string): Promise<void> {
    await this.send(`${title}\n\n${body}`)
  }
}

function approvalText(ap: Approval): string {
  const args = JSON.stringify(ap.args, null, 1)
  return `${ap.connectorName} · ${ap.tool}${ap.why ? `\n${L('Motivo', 'Reason')}: ${ap.why}` : ''}\n\n${args.length > 1500 ? `${args.slice(0, 1500)}…` : args}`
}

const clip = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) : s)

// Splits text into Telegram-safe parts without cutting words.
// Prefers line breaks, falls back to word boundaries.
// Continuation parts (after the first) get a prefix header prepended.
function splitMessage(text: string, maxLen: number, prefix = ''): string[] {
  const parts: string[] = []
  let remaining = text
  let first = true

  while (remaining.length > 0) {
    const prefixLen = prefix ? prefix.length + 1 : 0
    const available = first ? maxLen : maxLen - prefixLen

    if (remaining.length <= available) {
      parts.push(first ? remaining : (prefix ? `${prefix}\n${remaining}` : remaining))
      break
    }

    // Find split point: prefer a line break, then the last space (never cut a word).
    let splitAt = available
    const newlineIdx = remaining.lastIndexOf('\n', available)
    if (newlineIdx !== -1 && newlineIdx > 0) {
      splitAt = newlineIdx + 1 // include the newline
    } else {
      const spaceIdx = remaining.lastIndexOf(' ', available)
      if (spaceIdx !== -1 && spaceIdx > 0) {
        splitAt = spaceIdx
      }
    }
    // Never split a UTF-16 surrogate pair (emoji).
    if (splitAt > 1 && splitAt < remaining.length && /[\uD800-\uDBFF]/.test(remaining[splitAt - 1]!)) {
      splitAt--
    }

    parts.push(first ? remaining.slice(0, splitAt) : (prefix ? `${prefix}\n${remaining.slice(0, splitAt)}` : remaining.slice(0, splitAt)))
    remaining = remaining.slice(splitAt)
    first = false
  }

  return parts
}

// Strip inline markdown formatting for clean Telegram plain-text delivery.
// Keeps line breaks, list indentation and code-block separation intact.
function toPlainText(s: string): string {
  return s
    // fenced code blocks: ```lang → ---lang, closing ``` → ---
    .replace(/```(\w*)/g, '---$1')
    .replace(/^```\s*$/gm, '---')
    // **bold** and *italic* → text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    // `inline code` → text
    .replace(/`([^`]+)`/g, '$1')
}
