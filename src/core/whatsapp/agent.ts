// What agents do with WhatsApp: the three tools (list, read, send), the judging of every send
// against the number's limits, and the sending itself, one message at a time per number. The
// service in index.ts owns the numbers and hands this class what it needs (the host).
import { L } from '../../shared/lang'
import { UserError } from '../../shared/errors'
import { ALL_CHATS, accessFor, dayStart, judgeSend, phoneDigits, type SendVerdict, type WhatsAppChat, type WhatsAppNumber } from '../../shared/whatsapp'
import * as cloud from './cloud'
import { jidPhone, Unconfirmed, type QrDriver, type QrStatus } from './qr'
import type { NumberRow, WhatsAppStore } from './store'
import { linesOf, pick, READ_DEFAULT, READ_MAX, refusalText, stamp, str, templateOf, type Template } from './tools'

export interface ToolOutcome {
  text: string
  isError?: boolean
  outside?: boolean // it read other people's text
  step: { label: string; detail: string }
  // Present when the send waits for a person: nothing was sent.
  approval?: { args: Record<string, unknown>; why: string; detail: string }
}

export interface Runtime {
  driver?: QrDriver
  view: QrStatus // what the QR link says about itself
  error?: string // the official API: what Meta last refused
  paused: Map<string, number> // conversation → agents stay quiet until (someone answered from the phone)
  tail: Promise<unknown> // sends of this number go one at a time
}

// What the service lends: its store, the live state of each number and the screen's refresh.
export interface Host {
  store(): WhatsAppStore
  rt(id: string): Runtime
  keys: Map<string, cloud.CloudCreds>
  cloudOk(): boolean
  view(n: NumberRow, since: number): WhatsAppNumber
  stub(id: string): WhatsAppChat
  changed(): void
  fail(e: unknown): void
}

interface Target {
  id: string
  name: string
  kind: 'contact' | 'group'
  phone?: string
}

export const generic = (): string => L('Algo deu errado com o WhatsApp. Nada foi enviado. Tente de novo em instantes.', 'Something went wrong with WhatsApp. Nothing was sent. Try again in a moment.')
const notConnected = (): UserError => new UserError(L('Esse número não está conectado ao WhatsApp agora. Conecte-o e tente de novo.', "That number isn't connected to WhatsApp right now. Connect it and try again."))

export class AgentTools {
  constructor(private h: Host) {}

  // ---------- sending ----------

  private judge(n: NumberRow, agentId: string, chatId: string, text: string, template: boolean): SendVerdict {
    const now = Date.now()
    const since = dayStart(now)
    const known = this.h.store().chat(n.id, chatId)
    const until = this.h.rt(n.id).paused.get(chatId)
    return judgeSend({
      kind: n.kind,
      settings: n.settings,
      access: accessFor(this.h.store().access(n.id), agentId, chatId),
      sentToday: this.h.store().sentToday(n.id, since),
      newToday: this.h.store().newToday(n.id, since),
      text,
      template,
      chat: { ...(known?.inboundAt !== undefined ? { inboundAt: known.inboundAt } : {}), ...(until && until > now ? { pausedUntil: until } : {}), contactedToday: this.h.store().contactedToday(n.id, chatId, since) },
      now
    })
  }

  private refusal(n: NumberRow, chat: string, why: Parameters<typeof refusalText>[0]): string {
    return refusalText(why, { chat, number: n.name, daily: n.settings.dailyLimit, newChats: n.settings.newChatsLimit })
  }

  // One send at a time per number, judged again at the moment it goes (the day may have filled up while it waited).
  private deliver(n: NumberRow, agentId: string, target: Target, text: string, tpl?: Template): Promise<string> {
    const r = this.h.rt(n.id)
    const run = r.tail.then(async () => {
      const v = this.judge(n, agentId, target.id, text, !!tpl)
      if (!v.ok) throw new UserError(this.refusal(n, target.name, v.why))
      // Read before the send: a conversation nobody had written in yet is a new one for the day's limit, even after they answer.
      const first = this.h.store().chat(n.id, target.id)?.inboundAt === undefined
      let id: string
      try {
        if (n.kind === 'qr') {
          if (!r.driver || r.view.status !== 'connected') throw notConnected()
          id = await r.driver.send(target.id, text)
        } else {
          const keys = this.h.keys.get(n.id)
          if (!keys || !this.h.cloudOk()) throw notConnected()
          id = tpl ? await cloud.sendTemplate(keys, target.id, tpl.nome, tpl.idioma, tpl.variaveis) : await cloud.sendText(keys, target.id, text)
        }
      } catch (e) {
        // Not confirmed in time: it may have left, so it is kept (it counts toward the limits) and the agent is still told not to resend.
        if (e instanceof Unconfirmed) this.record(n, agentId, target, e.id, text, tpl, first)
        throw e
      }
      // The message has left: from here on, a failure is logged, never reported to the agent as a failed send.
      this.record(n, agentId, target, id, text, tpl, first)
      return this.reply(n, target)
    })
    r.tail = run.catch(() => undefined)
    return run
  }

  // Writes the sent message down as the agent's. A failure here is logged: the message has already gone.
  private record(n: NumberRow, agentId: string, target: Target, id: string, text: string, tpl: Template | undefined, first: boolean): void {
    try {
      const known = this.h.store().chat(n.id, target.id)
      const at = Date.now()
      this.h.store().upsertChat(n.id, { id: target.id, kind: target.kind, ...(known ? {} : { name: target.name }), ...(target.phone ? { phone: target.phone } : {}), lastAt: at })
      this.h.store().addMessage(n.id, { id, chat: target.id, fromMe: true, text: tpl ? `[${tpl.nome}] ${tpl.variaveis.join(' · ')}`.trim() : text, at, agentId, first })
      this.h.changed()
    } catch (e) {
      this.h.fail(e)
    }
  }

  // What the agent reads back after a send: it went, and how many messages the number can still send today.
  private reply(n: NumberRow, target: Target): string {
    try {
      const left = Math.max(0, n.settings.dailyLimit - this.h.store().sentToday(n.id, dayStart(Date.now())))
      return L(`Enviado para "${target.name}" pelo número "${n.name}". Ainda dá para enviar ${left} mensagens hoje nesse número.`, `Sent to "${target.name}" from the number "${n.name}". You can still send ${left} messages today from that number.`)
    } catch (e) {
      this.h.fail(e)
      return L(`Enviado para "${target.name}" pelo número "${n.name}".`, `Sent to "${target.name}" from the number "${n.name}".`)
    }
  }

  // ---------- what an agent does ----------

  private agentNumbers(agentId: string): NumberRow[] {
    return this.h.store().numbers().filter((n) => this.h.store().access(n.id).some((a) => a.agentId === agentId))
  }

  // The conversations of a number that this agent may use: its own rows, or every one when it has the "all" row.
  private usable(n: NumberRow, agentId: string): WhatsAppChat[] {
    const rows = this.h.store().access(n.id).filter((a) => a.agentId === agentId)
    if (rows.some((a) => a.chat === ALL_CHATS)) return this.h.store().chats(n.id)
    return rows.map((a) => this.h.store().chat(n.id, a.chat) ?? this.h.stub(a.chat))
  }

  private pickNumber(agentId: string, query: string): NumberRow {
    const mine = this.agentNumbers(agentId)
    if (!query && mine.length === 1) return mine[0]!
    if (!query) throw new UserError(L('Diga qual número usar (numero). Veja whatsapp_conversas.', 'Say which number to use (numero). See whatsapp_conversas.'))
    return pick(mine, query, 'number')
  }

  async call(agent: { id: string; name: string }, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const label = name === 'whatsapp_ler' ? L('Ler no WhatsApp', 'Read on WhatsApp') : name === 'whatsapp_enviar' ? L('Enviar no WhatsApp', 'Send on WhatsApp') : L('Ver conversas do WhatsApp', 'See WhatsApp conversations')
    const a = args && typeof args === 'object' ? args : {}
    try {
      if (name === 'whatsapp_conversas') return this.listTool(agent.id, label)
      if (name === 'whatsapp_ler') return this.readTool(agent.id, a, label)
      if (name === 'whatsapp_enviar') return await this.sendTool(agent.id, a, label)
      return { text: L('Essa ferramenta de WhatsApp não existe.', "That WhatsApp tool doesn't exist."), isError: true, step: { label, detail: name } }
    } catch (e) {
      if (!(e instanceof UserError)) this.h.fail(e)
      return { text: e instanceof UserError ? e.message : generic(), isError: true, step: { label, detail: str(a['numero']) || name } }
    }
  }

  private listTool(agentId: string, label: string): ToolOutcome {
    const since = dayStart(Date.now())
    const lines: string[] = []
    for (const n of this.agentNumbers(agentId)) {
      const v = this.h.view(n, since)
      const state = v.status === 'connected' ? L('conectado', 'connected') : v.status === 'disconnected' ? L('desconectado', 'disconnected') : L('conectando', 'connecting')
      const kind = n.kind === 'cloud' ? L('API oficial', 'official API') : L('QR code', 'QR code')
      lines.push(L(`Número "${n.name}" (id ${n.id}) · ${kind} · ${state}${n.description ? ` · serve para: ${n.description}` : ''}`, `Number "${n.name}" (id ${n.id}) · ${kind} · ${state}${n.description ? ` · used for: ${n.description}` : ''}`))
      lines.push(L(`  Hoje: ${v.sentToday} de ${n.settings.dailyLimit} mensagens enviadas (restam ${Math.max(0, n.settings.dailyLimit - v.sentToday)}); ${v.newToday} de ${n.settings.newChatsLimit} conversas novas.`, `  Today: ${v.sentToday} of ${n.settings.dailyLimit} messages sent (${Math.max(0, n.settings.dailyLimit - v.sentToday)} left); ${v.newToday} of ${n.settings.newChatsLimit} new conversations.`))
      const access = this.h.store().access(n.id)
      const all = access.some((x) => x.agentId === agentId && x.chat === ALL_CHATS)
      const chats = this.usable(n, agentId).slice(0, 30)
      if (all) lines.push(L('  Todas as conversas deste número estão abertas pra você (aqui, as 30 mais recentes; ache outras pelo nome).', '  Every conversation of this number is open to you (here, the 30 latest; find others by name).'))
      for (const c of chats) {
        const level = accessFor(access, agentId, c.id)?.level === 'reply' ? L('pode responder', 'can answer') : L('só leitura', 'read only')
        lines.push(L(`  - "${c.name}" (id ${c.id}) · ${c.kind === 'group' ? 'grupo' : 'contato'} · ${level}${c.lastAt ? ` · última mensagem ${stamp(c.lastAt)}` : ''}`, `  - "${c.name}" (id ${c.id}) · ${c.kind === 'group' ? 'group' : 'contact'} · ${level}${c.lastAt ? ` · last message ${stamp(c.lastAt)}` : ''}`))
      }
      if (!chats.length && !all) lines.push(L('  Nenhuma conversa liberada ainda.', '  No conversation open yet.'))
    }
    return { text: lines.length ? lines.join('\n') : L('Nenhum número de WhatsApp está liberado pra você.', 'No WhatsApp number is open to you.'), step: { label, detail: '' } }
  }

  private readTool(agentId: string, args: Record<string, unknown>, label: string): ToolOutcome {
    const n = this.pickNumber(agentId, str(args['numero']))
    const q = str(args['conversa'])
    if (!q) throw new UserError(L('Diga qual conversa ler (conversa). Veja whatsapp_conversas.', 'Say which conversation to read (conversa). See whatsapp_conversas.'))
    const chat = pick(this.usable(n, agentId), q, 'chat')
    const asked = Number(args['quantidade'])
    const count = Number.isFinite(asked) && asked >= 1 ? Math.min(READ_MAX, Math.floor(asked)) : READ_DEFAULT
    const messages = this.h.store().messages(n.id, chat.id, count)
    const text = messages.length ? linesOf(messages, chat.name) : L('Nenhuma mensagem guardada nessa conversa ainda (só as que chegaram depois da liberação ficam guardadas).', 'No message kept in this conversation yet (only those that arrived after it was opened are kept).')
    return { text, outside: true, step: { label, detail: `${n.name} · ${chat.name}` } }
  }

  // Starting a conversation with someone new: only for an agent that may answer everyone on the number.
  private async newTarget(n: NumberRow, agentId: string, phone: string): Promise<Target> {
    const digits = phoneDigits(phone)
    if (!digits) throw new UserError(L('Esse telefone não parece válido. Use o número com código do país, ex.: 5511900000000.', 'That phone does not look valid. Use the number with country code, e.g. 5511900000000.'))
    if (!this.h.store().access(n.id).some((a) => a.agentId === agentId && a.chat === ALL_CHATS && a.level === 'reply')) {
      throw new UserError(L('Para começar uma conversa com alguém novo, o número precisa estar aberto a todas as conversas pra você, com permissão de responder. Peça a um administrador.', 'To start a conversation with someone new, the number must be open to all conversations for you, with permission to answer. Ask an admin.'))
    }
    let id = digits
    if (n.kind === 'qr') {
      const r = this.h.rt(n.id)
      if (!r.driver || r.view.status !== 'connected') throw notConnected()
      const jid = await r.driver.resolvePhone(digits)
      if (!jid) throw new UserError(L(`O número ${digits} não está no WhatsApp. Nada foi enviado.`, `The number ${digits} isn't on WhatsApp. Nothing was sent.`))
      id = jid
    }
    return this.h.store().chat(n.id, id) ?? { id, name: digits, kind: 'contact', phone: digits }
  }

  private async sendTool(agentId: string, args: Record<string, unknown>, label: string): Promise<ToolOutcome> {
    const n = this.pickNumber(agentId, str(args['numero']))
    const text = typeof args['texto'] === 'string' ? args['texto'] : ''
    const tpl = templateOf(args['modelo'])
    if (tpl && n.kind !== 'cloud') throw new UserError(L('Modelo só existe na API oficial. Neste número, envie o texto em "texto".', 'Templates only exist on the official API. On this number, send the text in "texto".'))
    const conversa = str(args['conversa'])
    const telefone = str(args['telefone'])
    if (!conversa && !telefone) throw new UserError(L('Diga para quem enviar: conversa (uma que já existe) ou telefone (alguém novo).', 'Say who to send to: conversa (an existing one) or telefone (someone new).'))
    const target: Target = conversa ? pick(this.usable(n, agentId), conversa, 'chat', true) : await this.newTarget(n, agentId, telefone)
    const step = { label, detail: `${n.name} · ${target.name}` }
    const v = this.judge(n, agentId, target.id, text, !!tpl)
    if (!v.ok) return { text: this.refusal(n, target.name, v.why), isError: true, step }
    if (v.ask) {
      const approval = {
        args: { numero_id: n.id, numero: n.name, conversa_id: target.id, conversa: target.name, texto: text, ...(tpl ? { modelo: tpl } : {}), ...(v.firstContact ? { primeiro_contato: true } : {}) },
        why: v.firstContact ? L(`Primeira mensagem para ${target.name}, que nunca escreveu para este número.`, `First message to ${target.name}, who never wrote to this number.`) : L(`Mensagem para ${target.name} pelo número ${n.name}.`, `Message to ${target.name} from the number ${n.name}.`),
        detail: tpl ? `${tpl.nome} (${tpl.idioma})${tpl.variaveis.length ? `: ${tpl.variaveis.join(' · ')}` : ''}` : text
      }
      return { text: L('Essa mensagem espera a aprovação de uma pessoa antes de sair. Nada foi enviado ainda; você será avisado da decisão.', 'This message waits for a person to approve it before it leaves. Nothing was sent yet; you will be told the decision.'), step, approval }
    }
    return { text: await this.deliver(n, agentId, target, text, tpl), step }
  }

  // Sends exactly what was approved. Access, the day's limit and the connection are checked again now.
  async approved(agentId: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
    try {
      const n = this.h.store().number(str(args['numero_id']))
      if (!n) return { ok: false, text: L('Esse número de WhatsApp não existe mais. Nada foi enviado.', 'That WhatsApp number no longer exists. Nothing was sent.') }
      const id = str(args['conversa_id'])
      const text = typeof args['texto'] === 'string' ? args['texto'] : ''
      const tpl = templateOf(args['modelo'])
      if (!id) return { ok: false, text: generic() }
      const name = this.h.store().chat(n.id, id)?.name ?? (str(args['conversa']) || id.split('@')[0] || id)
      const v = this.judge(n, agentId, id, text, !!tpl)
      if (!v.ok) return { ok: false, text: this.refusal(n, name, v.why) }
      const target: Target = this.h.store().chat(n.id, id) ?? { id, name, kind: id.endsWith('@g.us') ? 'group' : 'contact', ...(jidPhone(id) ? { phone: jidPhone(id) } : {}) }
      return { ok: true, text: await this.deliver(n, agentId, target, text, tpl) }
    } catch (e) {
      if (!(e instanceof UserError)) this.h.fail(e)
      return { ok: false, text: e instanceof UserError ? e.message : generic() }
    }
  }

  // "Always allow": that conversation's sends go alone from now on.
  always(agentId: string, args: Record<string, unknown>): void {
    try {
      const n = this.h.store().number(str(args['numero_id']))
      const chat = str(args['conversa_id'])
      if (!n || !chat || accessFor(this.h.store().access(n.id), agentId, chat)?.level !== 'reply') return
      this.h.store().setSend(n.id, agentId, chat, 'reply', 'auto')
      this.h.changed()
    } catch (e) {
      this.h.fail(e)
    }
  }

  // The sentence of a decision: what is being asked to send, and where.
  what(args: Record<string, unknown>): string {
    const text = typeof args['texto'] === 'string' ? args['texto'].trim() : ''
    const tpl = templateOf(args['modelo'])
    const shown = tpl ? tpl.nome : text.length > 80 ? `${text.slice(0, 80)}…` : text
    const chat = str(args['conversa']) || str(args['conversa_id'])
    const number = str(args['numero']) || str(args['numero_id'])
    return tpl ? L(`enviar o modelo "${shown}" para ${chat} pelo número ${number}`, `send the template "${shown}" to ${chat} from the number ${number}`) : L(`enviar "${shown}" para ${chat} pelo número ${number}`, `send "${shown}" to ${chat} from the number ${number}`)
  }
}
