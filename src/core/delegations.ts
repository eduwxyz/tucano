// Work handed down the tree (src/shared/org.ts). An agent with others below it gets `pedir`: the ask
// becomes a thread in the channel of whoever does it, opened by a message in the asker's name. When
// that thread comes to rest (a reply nobody takes further), what it ended with goes back to where
// the ask came from, and the asker gets the turn again, once for everything that came back together.
// A question left there goes up to the asker instead of to a person: it answers what it knows from
// its own conversation, and takes the rest to the person itself. Nothing else changes: approvals,
// limits and what each agent may do stay each agent's own.
import { L, locale } from '../shared/lang'
import { channelsOf, directReports, peersOf, reportsOf } from '../shared/org'
import type { Agent, Connector, Conversation, Delegation } from '../shared/types'
import type { ToolDef } from './gateway'
import { describeAgent } from './router'

export const MAX_DELEGATIONS_PER_REPLY = 5
export const MAX_OPEN_DELEGATIONS = 12 // per asker, everywhere
const RESULT_MAX = 8_000 // what goes back to the asker's conversation; the thread keeps it whole
const TEXT_MAX = 6_000
const DONE_MAX = 600
const DUE_MAX_HOURS = 24 * 14

export const PEDIR: ToolDef = {
  name: 'pedir',
  get description() {
    return L(
      'Passa um trabalho a um agente do seu time (os que respondem a você: veja "Seu time") ou a um colega (quem responde ao mesmo agente que você: veja "Seus colegas"). Vira uma thread no canal dele, ou na DM dele, em seu nome, e ele começa na hora. Quando terminar, a resposta dele volta pra esta conversa e você é chamado de novo, sem precisar esperar nem conferir. Escreva o pedido inteiro: quem recebe não lê esta conversa. Um pedido por agente e por assunto; pode chamar mais de uma vez na mesma resposta pra dividir um trabalho. Depois de pedir, encerre dizendo em poucas linhas o que pediu a quem e em que canal.',
      'Hands a piece of work to an agent of your team (those who answer to you: see "Your team") or to a colleague (who answers to the same agent as you: see "Your colleagues"). It becomes a thread in their channel, or in their DM, in your name, and they start right away. When they finish, their answer comes back to this conversation and you are called again, with no need to wait or check. Write the whole request: whoever gets it does not read this conversation. One request per agent and subject; you may call it more than once in the same reply to split a job. After asking, end by saying in a few lines what you asked of whom and in which channel.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        para: { type: 'string', description: L('O agente que faz: o @handle ou o nome, como em "Seu time" ou "Seus colegas".', 'The agent who does it: the @handle or the name, as in "Your team" or "Your colleagues".') },
        pedido: { type: 'string', maxLength: TEXT_MAX, description: L('O que fazer, com tudo o que ele precisa saber pra fazer sem perguntar.', 'What to do, with everything they need to know to do it without asking.') },
        pronto: { type: 'string', maxLength: DONE_MAX, description: L('Opcional, só quando não for óbvio pelo pedido: o que conta como terminado, em uma frase ("PR aberto com teste"). Quem recebe lê; não aparece na conversa.', 'Optional, only when the request doesn\'t make it obvious: what counts as finished, in one sentence ("PR open with a test"). Whoever gets it reads it; it doesn\'t show in the conversation.') },
        prazo_horas: { type: 'number', description: L('Em quantas horas você quer isso (opcional). Passou disso sem terminar, você é avisado.', 'In how many hours you want it (optional). Past that without an end, you are told.') },
        canal: {
          type: 'string',
          description: L(
            'Onde o pedido fica. O nome de um canal dele, quando o assunto é o tema desse canal. "dm" quando o assunto não é de nenhum canal dele (algo sobre ele mesmo, um recado, uma coisa pessoal de quem pediu): vai pra DM dele com quem pediu. Na dúvida, ou sem dizer nada: o primeiro canal dele.',
            'Where the request stays. The name of one of their channels, when the subject is that channel\'s topic. "dm" when the subject belongs to none of their channels (something about themselves, a message to pass on, something personal to whoever asked): it goes to their DM with whoever asked. In doubt, or with nothing said: their first channel.'
          )
        }
      },
      required: ['para', 'pedido']
    }
  }
}

export const RESPONDER_PEDIDO: ToolDef = {
  name: 'responder_pedido',
  get description() {
    return L(
      'Responde a pergunta que um agente do seu time deixou num pedido seu. A resposta vai pra thread dele, em seu nome, e ele continua. Responda só com o que você sabe por esta conversa ou pela sua memória; o que for decisão de quem te pediu (dinheiro, um cliente, algo que sai daqui), pergunte antes com ask_user e repasse depois.',
      "Answers the question an agent of your team left on a request of yours. The answer goes to their thread, in your name, and they go on. Answer only with what you know from this conversation or your memory; what is a decision of whoever asked you (money, a customer, something that leaves here), ask first with ask_user and pass it on after."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: L('O código do pedido, entre colchetes na lista.', "The request's code, in brackets in the list.") },
        resposta: { type: 'string', maxLength: TEXT_MAX, description: L('A resposta, inteira: ele não lê esta conversa.', 'The answer, whole: they do not read this conversation.') }
      },
      required: ['id', 'resposta']
    }
  }
}

export const CANCELAR_PEDIDO: ToolDef = {
  name: 'cancelar_pedido',
  get description() {
    return L(
      'Cancela um pedido seu que ainda está em aberto: quem estava fazendo para, e o que ele tinha pedido adiante para também.',
      'Cancels a request of yours that is still open: whoever was doing it stops, and so does what they had asked further down.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: { id: { type: 'string', description: L('O código do pedido, entre colchetes na lista.', "The request's code, in brackets in the list.") }, motivo: { type: 'string', description: L('Por que, em uma frase (opcional).', 'Why, in one sentence (optional).') } },
      required: ['id']
    }
  }
}

export const DELEGATION_TOOLS = [PEDIR, RESPONDER_PEDIDO, CANCELAR_PEDIDO]
export const DELEGATION_TOOL_NAMES = new Set(DELEGATION_TOOLS.map((t) => t.name))

// The code an agent names a request by: short enough to copy, long enough to tell its own apart.
export const codeOf = (d: Pick<Delegation, 'id'>): string => d.id.slice(0, 8)
export const byCode = (list: Delegation[], code: unknown): Delegation | undefined => {
  const c = typeof code === 'string' ? code.trim().replace(/^\[|\]$/g, '').toLowerCase() : ''
  return c.length >= 4 ? list.find((d) => d.id === c) ?? (list.filter((d) => d.id.startsWith(c)).length === 1 ? list.find((d) => d.id.startsWith(c)) : undefined) : undefined
}

const clock = (at: number): string => new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

// "Clara", "@clara", "clara" → the one of the team it names (a name two share names no one).
export function teamMember(team: Agent[], who: unknown): Agent | undefined {
  const w = typeof who === 'string' ? who.trim().replace(/^@/, '').toLowerCase() : ''
  if (!w) return undefined
  const byHandle = team.find((a) => a.handle.toLowerCase() === w)
  if (byHandle) return byHandle
  const byName = team.filter((a) => a.name.toLowerCase() === w)
  return byName.length === 1 ? byName[0] : undefined
}

// "dm", "DM", "na dm" → the request is for the agent's DM, not a channel.
export const wantsDm = (name: unknown): boolean => typeof name === 'string' && /^(na |in (the |their )?)?(dm|direct|direta)$/i.test(name.trim())

// "#clientes", "clientes" → that channel, among the ones the agent works in.
export function channelNamed<C extends Pick<Conversation, 'name'>>(channels: C[], name: unknown): C | undefined {
  const n = typeof name === 'string' ? name.trim().replace(/^#/, '').toLowerCase() : ''
  return n ? channels.find((c) => c.name.toLowerCase() === n) : undefined
}

// What was asked, read as the tool's arguments: the hours of a deadline within reason, text cut to size.
export function parseAsk(args: Record<string, unknown>): { text: string; done?: string; dueAt?: number } | { error: string } {
  const text = typeof args['pedido'] === 'string' ? args['pedido'].trim().slice(0, TEXT_MAX) : ''
  if (!text) return { error: L('Diga o que fazer em "pedido".', 'Say what to do in "pedido".') }
  const done = typeof args['pronto'] === 'string' ? args['pronto'].trim().slice(0, DONE_MAX) : ''
  const hours = typeof args['prazo_horas'] === 'number' && Number.isFinite(args['prazo_horas']) && args['prazo_horas'] > 0 ? Math.min(args['prazo_horas'], DUE_MAX_HOURS) : 0
  return { text, ...(done ? { done } : {}), ...(hours ? { dueAt: Date.now() + Math.round(hours * 3_600_000) } : {}) }
}

// The message that opens the thread, in the asker's name: what the one doing it reads, and what a person sees there.
export function askMessage(to: Agent, ask: { text: string; done?: string; dueAt?: number }): string {
  // What counts as finished is for whoever does it (askTask), not a line for everyone to read.
  return [`@${to.handle}, ${L('um pedido', 'a request')}:`, ask.text, ask.dueAt && `**${L('Prazo', 'By')}:** ${clock(ask.dueAt)}`].filter(Boolean).join('\n\n')
}

// What the one doing it is told beyond the thread: whose request it is, and where its answer and its doubts go.
export function askTask(from: Agent, me: string, done?: string, peer = false): string {
  const until = done ? ` ${L(`Conta como terminado: ${done.replace(/[.\s]+$/, '')}.`, `It counts as finished when: ${done.replace(/[.\s]+$/, '')}.`)}` : ''
  return L(
    `A mensagem acima é um pedido de ${from.name}, ${peer ? 'seu colega de time' : 'a quem você responde'}. Faça o que ela pede. Quando terminar, sua resposta final nesta thread volta sozinha pra ${from.name}, que não leu o resto daqui: escreva nela o resultado inteiro, com o que fez, o que achou e o que falta. Não mencione ${from.name} pra avisar, nem deixe um recado à parte pra ele: a resposta é uma só, e ${me} também a lê. Se faltar uma informação pra continuar, use ask_user: a pergunta vai pra ${from.name}, não pra ${me}; escreva na resposta o que você já tem antes de perguntar, porque isso volta junto com a pergunta. Se tiver uma recomendação, diga qual. O que pedir aprovação continua pedindo, como sempre.`,
    `The message above is a request from ${from.name}, ${peer ? 'your teammate' : 'whom you answer to'}. Do what it asks. When you finish, your final reply in this thread goes back to ${from.name} by itself, and they did not read the rest of it: write the whole result there, with what you did, what you found and what is left. Do not mention ${from.name} to let them know, nor leave a separate note for them: there is one answer, and ${me} reads it too. If a piece of information is missing to go on, use ask_user: the question goes to ${from.name}, not to ${me}; write what you already have in the reply before asking, because it goes back with the question. If you have a recommendation, say which. What asks for approval still asks, as always.`
  ) + until
}

const cut = (text: string): string =>
  text.length <= RESULT_MAX ? text : `${text.slice(0, RESULT_MAX)}\n\n${L(`[… cortado: o resto está na thread do pedido, ${text.length - RESULT_MAX} caracteres a mais]`, `[… cut: the rest is in the request's thread, ${text.length - RESULT_MAX} more characters]`)}`

// What comes back to the asker's conversation, in the name of whoever did it.
// Where a request was delivered, as it's named in a list ("#dados", "DM") and in a sentence ("em #dados", "na DM").
// A channel when its agent is in one; otherwise the DM its agent has with whoever the work is for.
type Place = Pick<Conversation, 'kind' | 'name'> | undefined
export const placeOf = (c: Place): string => (!c ? '?' : c.kind === 'dm' ? 'DM' : `#${c.name}`)
export const inPlace = (c: Place): string => (c?.kind === 'dm' ? L('na DM dele', 'in their DM') : L(`em ${placeOf(c)}`, `in ${placeOf(c)}`))
export const resultMessage = (where: Place, text: string): string => `${L(`Sobre o pedido ${inPlace(where)}`, `About the request ${inPlace(where)}`)}:\n\n${cut(text.trim())}`
// A reply that didn't end: what it has written so far still comes back, so the asker isn't left with
// only the question or only the news that it waits on an approval of theirs.
export const soFarMessage = (where: Place, text: string): string => `${L(`Até agora, sobre o pedido ${inPlace(where)}`, `So far, on the request ${inPlace(where)}`)}:\n\n${cut(text.trim())}`
export const questionMessage = (where: Place, question: string): string => `${L(`Uma pergunta sobre o pedido ${inPlace(where)}`, `A question about the request ${inPlace(where)}`)}:\n\n${question.trim()}`

export interface Returned {
  d: Delegation
  to: string // the name of whoever was doing it
  channel: string // where it was delivered, as placeOf names it
  what: 'done' | 'failed' | 'cancelled' | 'asking' | 'parked' | 'late'
  why?: string // a failure's reason
}

// What the asker is told when it gets the turn back: each thing that came back, by its code, and what to do with it.
export function returnTask(returned: Returned[], open: { d: Delegation; to: string; channel: string; parked?: boolean }[], me: string): string {
  const line = (r: Returned): string => {
    const head = `- [${codeOf(r.d)}] ${r.to}, ${r.channel}`
    if (r.what === 'done') return `${head}: ${L(`terminou. A resposta é a mensagem dele acima. ${me} vê aqui só um aviso de que ele respondeu, com um atalho pra abrir a resposta`, `finished. The answer is their message above. ${me} sees here only a note that they answered, with a shortcut to open the answer`)}.`
    if (r.what === 'failed') return `${head}: ${L(`não terminou${r.why ? ` (${r.why.replace(/[.\s]+$/, '')})` : ''}. Diga isso a ${me}, e peça de novo se fizer sentido`, `did not finish${r.why ? ` (${r.why.replace(/[.\s]+$/, '')})` : ''}. Tell ${me} so, and ask again if it makes sense`)}.`
    if (r.what === 'cancelled') return `${head}: ${L('foi parado antes de terminar', 'was stopped before it finished')}.`
    if (r.what === 'late') return `${head}: ${L(`passou do prazo e ainda não terminou. Diga a ${me}; pra desistir, use cancelar_pedido`, `is past its deadline and has not finished. Tell ${me}; to give up, use cancelar_pedido`)}.`
    if (r.what === 'parked')
      return `${head}: ${L(
        `parou numa aprovação que espera ${me}. O que ele já escreveu são as mensagens dele acima; quando ${me} decidir, ele segue, e a resposta final volta pra cá. Não refaça o que ele fez`,
        `stopped at an approval that waits for ${me}. What it has written so far is in its messages above; when ${me} decides, it goes on, and the final answer comes back here. Do not redo what it did`
      )}.`
    return `${head}: ${L(
      `deixou uma pergunta e espera: as duas mensagens dele acima são o que ele escreveu até agora e a pergunta. Se você sabe a resposta por esta conversa ou pela sua memória, responda com responder_pedido. Se é decisão de ${me}, pergunte a ${me} com ask_user, dizendo o que ${r.to} recomenda, e quando ${me} responder repasse com responder_pedido`,
      `left a question and waits: its two messages above are what it has written so far and the question. If you know the answer from this conversation or your memory, answer with responder_pedido. If it is ${me}'s decision, ask ${me} with ask_user, saying what ${r.to} recommends, and when ${me} answers pass it on with responder_pedido`
    )}.`
  }
  const still = open.length ? `\n\n${L('Ainda em andamento', 'Still going')}: ${open.map((o) => `[${codeOf(o.d)}] ${o.to}, ${o.channel}${o.parked ? ` (${L(`parado numa aprovação que espera ${me}`, `held on an approval that waits for ${me}`)})` : ''}`).join('; ')}.` : ''
  const close = returned.some((r) => r.what === 'asking')
    ? ''
    : returned.every((r) => r.what === 'parked')
      ? `\n\n${L(
          `Diga a ${me}, em poucas linhas, o que já veio disso e que o resto espera uma aprovação dele, na thread do pedido.`,
          `Tell ${me}, in a few lines, what has come of it so far and that the rest waits for their approval in the request's thread.`
        )}`
      : `\n\n${L(
        `${open.length ? `Diga a ${me} o que já voltou, em poucas linhas, e o que ainda está andando${open.some((o) => o.parked) ? ` (e o que espera uma aprovação dele, na thread do pedido)` : ''}.` : `Feche o assunto com ${me}: diga o resultado em poucas linhas, com o que importa de cada resposta, e o que precisa de decisão. Não copie as respostas inteiras: ${me} abre cada uma pelo atalho. Não diga que elas não chegaram. Se falta ${me} escolher algo pra você seguir, pergunte com ask_user (com as opções), não no texto.`}`,
        `${open.length ? `Tell ${me} what has come back, in a few lines, and what is still going${open.some((o) => o.parked) ? ` (and what waits for their approval, in the request's thread)` : ''}.` : `Close the subject with ${me}: say the result in a few lines, with what matters from each answer, and what needs a decision. Do not copy the answers whole: ${me} opens each one by the shortcut. Do not say they did not arrive. If ${me} has to choose something for you to go on, ask with ask_user (with the options), not in the text.`}`
      )}`
  return `${L('Voltou do que você pediu ao seu time', 'Back from what you asked of your team')}:\n${returned.map(line).join('\n')}${still}${close}`
}

// The asker's view of whom it may hand work to, for the live context: who answers to it and who answers
// to the same agent as it does, what each does and reaches, the channels each works in (with their
// topic: where a subject belongs) and what is still open.
export function teamSection(opts: { agent: Agent; agents: Agent[]; conversations: Conversation[]; connectors: Connector[]; open: Delegation[]; me: string }): string | undefined {
  const { agent, agents, conversations, connectors, open, me } = opts
  const team = reportsOf(agents, agent.id)
  const peers = peersOf(agents, agent.id).filter((p) => !team.some((t) => t.id === p.id))
  if (!team.length && !peers.length) return undefined
  const direct = new Set(directReports(agents, agent.id).map((a) => a.id))
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? L('agente removido', 'removed agent')
  const channel = (id: string): string => placeOf(conversations.find((c) => c.id === id))
  const row = (a: Agent, mine: boolean): string => {
    const channels = channelsOf(conversations, a.id)
    const where = channels.length ? channels.map((c) => `#${c.name}${c.topic ? ` (${c.topic.replace(/\s+/g, ' ').slice(0, 100)})` : ''}`).join(', ') : L('nenhum: o pedido chega na DM dele', 'none: a request arrives in their DM')
    const under = !mine || direct.has(a.id) ? '' : ` · ${L('abaixo de', 'under')} ${name(a.reportsTo!)}`
    return `- @${a.handle} · ${describeAgent(a, connectors)}${under} · ${L('canais', 'channels')}: ${where}`
  }
  const asked = open.filter((d) => d.from === agent.id)
  const going = asked.length
    ? `\n\n${L('Pedidos seus em aberto', 'Your open requests')}:\n${asked
        .map((d) => `- [${codeOf(d)}] ${name(d.to)}, ${channel(d.conversationId)}, ${L('desde', 'since')} ${clock(d.createdAt)}${d.dueAt ? `, ${L('prazo', 'by')} ${clock(d.dueAt)}` : ''}${d.asking ? `, ${L('esperando uma resposta sua', 'waiting for an answer from you')}` : ''}: ${d.text.replace(/\s+/g, ' ').slice(0, 140)}`)
        .join('\n')}`
    : ''
  const place = L(
    `O pedido fica no canal dele onde o assunto mora (o tema de cada canal diz). Se o assunto não é de nenhum canal dele (algo sobre ele mesmo, um recado, uma coisa pessoal de ${me}), peça com canal "dm": vai pra DM dele com ${me}. Na dúvida, o canal.`,
    `The request stays in their channel where the subject lives (each channel's topic says). If the subject belongs to none of their channels (something about themselves, a message to pass on, something personal to ${me}), ask with canal "dm": it goes to their DM with ${me}. In doubt, the channel.`
  )
  const mine = team.length
    ? `${L(
        `## Seu time\nEstes agentes respondem a você. Quando ${me} pedir algo que é do trabalho de um deles, não faça você: passe com pedir, a quem faz aquilo. ${place} Divida o que for de mais de um. Cada um tem os próprios acessos e pede as próprias aprovações a ${me}. Você não precisa acompanhar: a resposta volta pra onde você pediu, e você é chamado. As dúvidas de quem recebe também chegam a você, não a ${me}: no pedido, diga pra perguntar a você. Depois de pedir, diga a ${me} o plano: o que pediu a quem e onde. Só o que você mesmo sabe responder, responda direto.`,
        `## Your team\nThese agents answer to you. When ${me} asks for something that is one of theirs to do, do not do it yourself: hand it over with pedir, to whoever does that. ${place} Split what belongs to more than one. Each has their own access and asks ${me} for their own approvals. You need not follow up: the answer comes back to where you asked, and you are called. The doubts of whoever gets it also come to you, not to ${me}: in the request, say to ask you. After asking, tell ${me} the plan: what you asked of whom and where. Only what you can answer yourself, answer directly.`
      )}\n${team.map((a) => row(a, true)).join('\n')}`
    : ''
  const beside = peers.length
    ? `${L(
        `## Seus colegas\nEstes agentes respondem ao mesmo agente que você. Quando precisar de algo que é do trabalho de um deles pra terminar o seu, ou quando ${me} pedir que você fale com um deles, peça com pedir: a resposta volta pra cá e você é chamado. Não repasse a um colega o que foi pedido a você, e não peça de volta a quem te pediu.${team.length ? '' : ` ${place}`}`,
        `## Your colleagues\nThese agents answer to the same agent as you. When you need something that is one of theirs to do in order to finish yours, or when ${me} asks you to talk to one of them, ask with pedir: the answer comes back here and you are called. Do not pass on to a colleague what was asked of you, and do not ask back whoever asked you.${team.length ? '' : ` ${place}`}`
      )}\n${peers.map((a) => row(a, false)).join('\n')}`
    : ''
  return `${[mine, beside].filter(Boolean).join('\n\n')}${going}`
}
