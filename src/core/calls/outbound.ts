// An agent calls a person. Everything that must be true before a call goes out is checked here, and each thing
// missing is a sentence that says what to do (the agent reads it and tells the person who asked).
import { randomUUID } from 'node:crypto'
import { L } from '../../shared/lang'
import { errorFor, UserError } from '../../shared/errors'
import { CALL_LIMITS, openNow, type CallSettings } from '../../shared/calls'
import { dayStart } from '../../shared/whatsapp'
import * as cloud from '../whatsapp/cloud'
import type { CallRow } from '../whatsapp/store'
import type { CallsDeps, NumberView } from './index'
import { digits, MAX_LIVE, STATE_KEY, text } from './common'
import { buildPrompt, braceSafe, defaultGreeting } from './prompt'
import { FIRST_VAR, PROMPT_VAR, type ProviderState, type VoiceProvider } from './provider'

const ASK_AGAIN_MS = 24 * 3_600_000
// After someone declines calls, the agent doesn't ask again for a week: asking again at once is nagging.
const DECLINED_MS = 7 * 24 * 3_600_000
const PERMISSION_DEFAULT_MS = 72 * 3_600_000 // how long Meta's temporary permission lasts when it says nothing

// What the service class lends: it owns the timers, the card and the sealed state.
export interface OutboundCtx {
  deps: CallsDeps
  service: VoiceProvider
  asked: Map<string, number> // when a person was last asked for permission, so the request isn't repeated
  rejected: Map<string, number> // when a person last declined calls, per number and chat
  settingsOf(n: NumberView): CallSettings
  providerState(numberId: string): Promise<ProviderState | undefined>
  recent(numberId: string, agentId: string, chat: string): { fromMe: boolean; text: string }[]
  open(row: CallRow): void // keeps the call, posts its card and follows it when it is on
  log(e: unknown): void
}

// The agent's `dial` tool: the answer is a sentence either way, so the agent can tell the person what happened.
export async function dialAgent(c: OutboundCtx, agentId: string, args: Record<string, unknown>): Promise<{ ok: boolean; text: string }> {
  try {
    return { ok: true, text: await place(c, agentId, args) }
  } catch (e) {
    if (!(e instanceof UserError)) c.log(e)
    return { ok: false, text: errorFor(e, true) }
  }
}

// The person's answer to "may we call you" (it comes by Meta's webhook): kept as the number's permission, and the request is forgotten.
export function answerPermission(c: OutboundCtx, numberId: string, chat: string, reply: { accepted: boolean; until?: number }): void {
  try {
    const key = `${numberId}:${chat}`
    c.deps.store.setCallPermission(numberId, chat, reply.accepted ? (reply.until ?? Date.now() + PERMISSION_DEFAULT_MS) : null)
    c.asked.delete(key) // a refusal lets the next request go out at once, but place waits DECLINED_MS after it
    if (reply.accepted) c.rejected.delete(key)
    else c.rejected.set(key, Date.now())
    c.deps.changed()
  } catch (e) {
    c.log(e)
  }
}

export async function place(c: OutboundCtx, agentId: string, args: Record<string, unknown>): Promise<string> {
  const { deps } = c
  const agent = deps.agent(agentId)
  if (!agent || agent.archived) throw new UserError(L('Esse agente não existe mais.', 'That agent no longer exists.'))
  const ref = text(args['numero'])
  const n = deps.numbers().find((x) => x.kind === 'cloud' && (x.id === ref || x.name.toLowerCase() === ref.toLowerCase() || (digits(ref) !== '' && digits(x.phone) === digits(ref))))
  if (!n) throw new UserError(L('Não achei esse número de WhatsApp (só números da API oficial ligam).', "I can't find that WhatsApp number (only official API numbers can call)."))
  const settings = c.settingsOf(n)
  const store = deps.store
  if (!settings.enabled || !store.hasAuth(n.id, STATE_KEY)) throw new UserError(L('As ligações não estão ligadas neste número.', 'Calls are not turned on for this number.'))
  if (!settings.outbound) throw new UserError(L('Este número não deixa os agentes ligarem para as pessoas. Quem cuida dele pode ligar essa opção na tela do número.', "This number doesn't let agents call people. Whoever runs it can turn that on in the number's screen."))
  const asked = text(args['conversa'])
  const chat = store.chats(n.id).find((x) => x.kind === 'contact' && (x.id === asked || x.name.toLowerCase() === asked.toLowerCase() || (digits(asked) !== '' && (digits(x.phone) === digits(asked) || digits(x.id) === digits(asked)))))
  if (!chat) throw new UserError(L('Não achei essa conversa. Ligações só vão para contatos que já têm conversa neste número.', "I can't find that conversation. Calls only go to contacts that already have a conversation on this number."))
  if (deps.access(n.id, agentId, chat.id) !== 'reply') throw new UserError(L('Você não pode responder essa conversa, então também não pode ligar para ela.', "You can't reply in that conversation, so you can't call it either."))
  const phone = digits(chat.phone ?? chat.id.split('@')[0])
  if (!phone) throw new UserError(L('Não sei o telefone dessa pessoa.', "I don't know that person's phone."))
  const now = Date.now()
  if (!openNow(settings.hours, now)) throw new UserError(L('Agora é fora do horário de ligações deste número. Tente dentro do horário.', "It's outside this number's call hours now. Try within the hours."))
  if (store.minutesToday(n.id, dayStart(now)) >= settings.minutesPerDay) throw new UserError(L('Os minutos de ligação de hoje deste número acabaram. Tente amanhã.', "Today's call minutes for this number are used up. Try tomorrow."))
  if (store.outboundToday(n.id, dayStart(now)) >= CALL_LIMITS.outboundPerDay) throw new UserError(L(`Já foram ${CALL_LIMITS.outboundPerDay} ligações feitas hoje por este número. Tente amanhã.`, `${CALL_LIMITS.outboundPerDay} calls were already placed from this number today. Try tomorrow.`))
  if (store.liveCalls(n.id, now - (settings.minutesPerCall + 5) * 60_000).length >= MAX_LIVE) throw new UserError(L('Já há ligações demais acontecendo neste número. Tente em instantes.', 'There are too many calls going on at this number. Try in a moment.'))
  const reason = text(args['motivo']).slice(0, 300)
  const keys = deps.cloud(n.id)
  if (!keys) throw new UserError(L('Não achei a chave da API oficial deste número.', "I can't find this number's official API key."))
  // Without the person's permission Meta refuses the call: the request goes by message, and the answer comes back by webhook.
  if (!store.callPermission(n.id, chat.id, now)) {
    const key = `${n.id}:${chat.id}`
    const declined = c.rejected.get(key)
    if (declined !== undefined && now - declined < DECLINED_MS) throw new UserError(L('Essa pessoa recusou ligações. Não peça de novo por enquanto.', "This person declined calls. Don't ask again for now."))
    if (now - (c.asked.get(key) ?? 0) < ASK_AGAIN_MS) throw new UserError(L('Já pedi a essa pessoa para permitir ligações e estou esperando a resposta. Tente de novo depois que ela aceitar.', "I already asked this person to allow calls and I'm waiting for the answer. Try again after they accept."))
    // The request is a message like any other, so it counts against the number's daily message limit.
    if (store.sentToday(n.id, dayStart(now)) >= n.settings.dailyLimit) throw new UserError(L('As mensagens de hoje deste número acabaram, então não posso pedir permissão para ligar. Tente amanhã.', "This number's messages for today are used up, so I can't ask for permission to call. Try tomorrow."))
    const ask = L(`${agent.name} (${deps.workspace()}) gostaria de ligar para você pelo WhatsApp${reason ? `: ${reason}` : ''}. Você permite?`, `${agent.name} (${deps.workspace()}) would like to call you on WhatsApp${reason ? `: ${reason}` : ''}. Do you allow it?`)
    const id = await cloud.askCallPermission(keys, phone, ask)
    c.asked.set(key, now)
    store.addMessage(n.id, { id, chat: chat.id, fromMe: true, text: ask, at: now, agentId }) // counted like any message the agent sends
    deps.changed()
    throw new UserError(L('Essa pessoa ainda não permitiu ligações. Mandei o pedido de permissão por mensagem. Só tente ligar de novo depois que ela disser que aceitou: nada avisa você sozinho.', "This person hasn't allowed calls yet. I sent the permission request by message. Try calling again only after they say they accepted: nothing tells you on its own."))
  }
  const made = await c.providerState(n.id)
  if (!made) throw new UserError(L('As ligações deste número precisam ser ligadas de novo na tela do número.', "This number's calls need to be turned on again in the number's screen."))
  const lang = deps.language() === 'pt' ? 'pt' : 'en'
  const prompt = buildPrompt({ agent, team: deps.workspace(), person: { name: chat.name, phone }, numberName: n.name, recent: c.recent(n.id, agentId, chat.id), language: lang, minutesPerCall: settings.minutesPerCall, direction: 'out', reason })
  const first = braceSafe(defaultGreeting({ name: agent.name, language: lang, direction: 'out', person: chat.name }))
  const { conversationId } = await c.service.dial(made, { to: `+${phone}`, variables: { [PROMPT_VAR]: prompt, [FIRST_VAR]: first } })
  c.open({
    id: randomUUID(),
    numberId: n.id,
    chat: chat.id,
    agentId,
    ...(conversationId ? { conversationId } : {}),
    direction: 'out',
    state: conversationId ? 'live' : 'done',
    startedAt: now,
    seconds: 0,
    agreed: [],
    turns: [],
    ...(conversationId ? {} : { note: L('A ligação foi pedida, mas não consegui acompanhar o que foi dito.', "The call was requested, but I couldn't follow what was said.") })
  })
  return L(`Estou ligando para ${chat.name}. Quando terminar, o resumo aparece na sua conversa.`, `I'm calling ${chat.name}. When it ends, the summary shows up in your conversation.`)
}
