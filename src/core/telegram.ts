// The phone (spec §19): a Telegram bot of the user's own sends approvals with
// buttons, agents' questions (answered by replying to them) and what routines
// did. The app asks Telegram for updates (long polling), so nothing needs to
// reach this Mac. It answers only the chat paired with a code shown in the app.
import { randomInt } from 'node:crypto'
import { L } from '../shared/lang'
import type { Approval, Message, TelegramInfo } from '../shared/types'
import type { Secrets } from './secrets'

const API = 'https://api.telegram.org'
const TOKEN = 'telegram:token'
const CHAT = 'telegram:chat'
const POLL_SECONDS = 50
const RETRY_MS = 15_000
const MAX_TEXT = 3_500 // Telegram allows 4096 per message

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
  private questions = new Map<number, string>() // Telegram message id → conversation it asked from

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
            'Pronto: este chat recebe as aprovações, as perguntas dos agentes e o fim das rotinas. Pra responder a uma pergunta, responda à mensagem dela.',
            "Done: this chat gets the approvals, the agents' questions and the end of routines. To answer a question, reply to its message."
          )
        )
        return
      }
      if (m.chat.id !== this.chat.id) return
      const conv = m.reply_to_message && this.questions.get(m.reply_to_message.message_id)
      if (conv) {
        this.deps.answer(conv, m.text)
        await this.send(L('Mandei a sua resposta.', 'I sent your answer.'), { reply_to_message_id: m.message_id })
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
    const r = (await this.api('sendMessage', { chat_id: this.chat.id, text: clip(text), ...extra }).catch((e: unknown) => console.error('[telegram]', e))) as { message_id?: number } | undefined
    return r?.message_id
  }

  // ---------- what goes to the phone ----------

  async approvalAsked(ap: Approval, agentName: string): Promise<void> {
    await this.send(`${L(`${agentName} pede aprovação`, `${agentName} asks for approval`)}\n\n${approvalText(ap)}`, {
      reply_markup: { inline_keyboard: [[{ text: L('Aprovar', 'Approve'), callback_data: `ap:${ap.id}:ok` }, { text: L('Recusar', 'Refuse'), callback_data: `ap:${ap.id}:no` }]] }
    })
  }

  async questionAsked(msg: Message, agentName: string, where: string): Promise<void> {
    if (!msg.run?.question) return
    const id = await this.send(
      L(`${agentName} pergunta (${where}):\n\n${msg.run.question}\n\nResponda a esta mensagem.`, `${agentName} asks (${where}):\n\n${msg.run.question}\n\nReply to this message.`),
      { reply_markup: { force_reply: true, input_field_placeholder: L('Sua resposta', 'Your answer') } }
    )
    if (id) this.questions.set(id, msg.conversationId)
  }

  async notice(title: string, body: string): Promise<void> {
    for (const chunk of splitIntoChunks(`${title}\n\n${body}`, MAX_TEXT)) await this.send(chunk)
  }
}

function approvalText(ap: Approval): string {
  const args = JSON.stringify(ap.args, null, 1)
  return `${ap.connectorName} · ${ap.tool}${ap.why ? `\n${L('Motivo', 'Reason')}: ${ap.why}` : ''}\n\n${args.length > 1500 ? `${args.slice(0, 1500)}…` : args}`
}

const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)

// Cuts at the last line break that fits, and drops it; a line longer than maxLength is cut at maxLength.
export function splitIntoChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxLength) {
    const lineBreak = remaining.lastIndexOf('\n', maxLength)
    const endsAtLineBreak = lineBreak > 0
    const end = endsAtLineBreak ? lineBreak : maxLength

    chunks.push(remaining.slice(0, end))
    remaining = remaining.slice(endsAtLineBreak ? end + 1 : end)
  }

  chunks.push(remaining)
  return chunks
}
