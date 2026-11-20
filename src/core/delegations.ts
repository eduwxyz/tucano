// Work handed down the tree (src/shared/org.ts). An agent with others below it gets `pedir`: the ask
// becomes a thread in the channel of whoever does it, opened by a message in the asker's name. When
// that thread comes to rest (a reply nobody takes further), what it ended with goes back to where
// the ask came from, and the asker gets the turn again, once for everything that came back together.
// A question left there goes up to the asker instead of to a person: it answers what it knows from
// its own conversation, and takes the rest to the person itself. Nothing else changes: approvals,
// limits and what each agent may do stay each agent's own.
import { L, locale } from '../shared/lang'
import { bossOf, channelsOf, directReports, entriesOf, headsOf, looseColleaguesOf, peersOf, reportsOf, sectorName, sectorOf, type AskKind } from '../shared/org'
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
      'Passa um trabalho a um agente do seu time (os que respondem a você: veja "Seu time"), a um colega (veja "Seus colegas"), ao seu chefe ou ao chefe do seu setor (só o que você não consegue fazer ou que não é do seu setor: veja "Seu chefe" e "Chefe do seu setor") ou, se você chefia um setor, ao chefe de outro setor (veja "Outros setores"). Vira uma thread no canal dele, ou na DM dele, em seu nome, e ele começa na hora. Quando terminar, a resposta dele volta pra esta conversa e você é chamado de novo, sem precisar esperar nem conferir. Escreva o pedido inteiro: quem recebe não lê esta conversa. Um pedido por agente e por assunto; pode chamar mais de uma vez na mesma resposta pra dividir um trabalho. Se isto continua ou completa um pedido seu, em aberto ou que já voltou, passe o código dele em "continuar": segue na mesma thread, sem abrir outra. Depois de pedir, encerre a resposta sem texto: quem pediu vê, embaixo da mensagem, a quem você pediu e como está.',
      'Hands a piece of work to an agent of your team (those who answer to you: see "Your team"), to a colleague (see "Your colleagues"), to your boss or to your sector\'s head (only what you cannot do or what is not your sector\'s job: see "Your boss" and "Your sector\'s head") or, if you head a sector, to the head of another sector (see "Other sectors"). It becomes a thread in their channel, or in their DM, in your name, and they start right away. When they finish, their answer comes back to this conversation and you are called again, with no need to wait or check. Write the whole request: whoever gets it does not read this conversation. One request per agent and subject; you may call it more than once in the same reply to split a job. If this continues or adds to a request of yours, open or already back, pass its code in "continuar": it goes on in the same thread, without opening another. After asking, end your reply with no text: whoever asked sees, under their message, whom you asked and how it stands.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        para: { type: 'string', description: L('O agente que faz: o @handle ou o nome, como em "Seu time", "Seus colegas", "Seu chefe", "Chefe do seu setor" ou "Outros setores".', 'The agent who does it: the @handle or the name, as in "Your team", "Your colleagues", "Your boss", "Your sector\'s head" or "Other sectors".') },
        pedido: { type: 'string', maxLength: TEXT_MAX, description: L('O que fazer, com tudo o que ele precisa saber pra fazer sem perguntar.', 'What to do, with everything they need to know to do it without asking.') },
        pronto: { type: 'string', maxLength: DONE_MAX, description: L('Opcional, só quando não for óbvio pelo pedido: o que conta como terminado, em uma frase ("PR aberto com teste"). Quem recebe lê; não aparece na conversa.', 'Optional, only when the request doesn\'t make it obvious: what counts as finished, in one sentence ("PR open with a test"). Whoever gets it reads it; it doesn\'t show in the conversation.') },
        continuar: {
          type: 'string',
          description: L(
            'Opcional: o código de um pedido seu (em "Pedidos seus em aberto" ou em "Pedidos que já voltaram aqui"), quando isto continua ou completa o mesmo assunto com o mesmo agente. O pedido segue na mesma thread, e ele vê o que já fez lá; um em aberto recebe isto como mais uma coisa a fazer nele.',
            'Optional: the code of a request of yours (in "Your open requests" or in "Requests that came back here"), when this continues or adds to the same subject with the same agent. The request goes on in the same thread, and they see what they already did there; an open one takes this as one more thing to do in it.'
          )
        },
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
export function askTask(from: Agent, me: string, done?: string, kind: AskKind = 'down', sector?: string, head = true): string {
  const until = done ? ` ${L(`Conta como terminado: ${done.replace(/[.\s]+$/, '')}.`, `It counts as finished when: ${done.replace(/[.\s]+$/, '')}.`)}` : ''
  // How the message above is introduced: whose it is, and what is expected of whoever gets it.
  const intro = {
    down: L(`um pedido de ${from.name}, a quem você responde. Faça o que ela pede.`, `a request from ${from.name}, whom you answer to. Do what it asks.`),
    peer: L(`um pedido de ${from.name}, seu colega de time. Faça o que ela pede.`, `a request from ${from.name}, your teammate. Do what it asks.`),
    // Only a sector's head takes it elsewhere; a boss in the middle solves it or says what is left.
    up: head
      ? L(`de ${from.name}, do seu time, que passou isto a você: resolva, ou leve ao setor certo.`, `from ${from.name}, of your team, who passed this up to you: solve it, or take it to the right sector.`)
      : L(`de ${from.name}, do seu time, que passou isto a você: resolva, ou responda dizendo o que falta.`, `from ${from.name}, of your team, who passed this up to you: solve it, or answer saying what is left.`),
    sector: L(`um pedido do ${sector ?? 'outro setor'}, via ${from.name}: decida quem do seu setor faz; se não for do seu setor, responda dizendo por quê.`, `a request from ${sector ?? 'another sector'}, via ${from.name}: decide who in your sector does it; if it is not your sector's, answer saying why.`)
  }[kind]
  return L(
    `A mensagem acima é ${intro} Quando terminar, sua resposta final nesta thread volta sozinha pra ${from.name}, que não leu o resto daqui: escreva nela o resultado inteiro, com o que fez, o que achou e o que falta. Não mencione ${from.name} pra avisar, nem deixe um recado à parte pra ele: a resposta é uma só, e ${me} também a lê. Não pare pra confirmar o que dá pra decidir: o que estiver em aberto e tiver um jeito sensato de fazer, decida, siga e diga na resposta o que escolheu. Pergunte só o que impede de continuar de verdade. Aí use ask_user: a pergunta vai pra ${from.name}, não pra ${me}; uma pergunta só, com a sua recomendação, e escreva na resposta o que você já tem antes de perguntar, porque isso volta junto com a pergunta. O que pedir aprovação continua pedindo, como sempre.`,
    `The message above is ${intro} When you finish, your final reply in this thread goes back to ${from.name} by itself, and they did not read the rest of it: write the whole result there, with what you did, what you found and what is left. Do not mention ${from.name} to let them know, nor leave a separate note for them: there is one answer, and ${me} reads it too. Don't stop to confirm what you can decide: what is open and has a sensible way of doing it, decide, go on and say in the reply what you chose. Ask only what really keeps you from going on. Then use ask_user: the question goes to ${from.name}, not to ${me}; one question, with your recommendation, and write what you already have in the reply before asking, because it goes back with the question. What asks for approval still asks, as always.`
  ) + until
}

const cut = (text: string): string =>
  text.length <= RESULT_MAX ? text : `${text.slice(0, RESULT_MAX)}\n\n${L(`[… cortado: o resto está na thread do pedido, ${text.length - RESULT_MAX} caracteres a mais]`, `[… cut: the rest is in the request's thread, ${text.length - RESULT_MAX} more characters]`)}`

// Where a request was delivered, as it's named in a list ("#dados", "DM") and in a sentence ("em #dados", "na DM").
// A channel when its agent is in one; otherwise the DM its agent has with whoever the work is for.
type Place = Pick<Conversation, 'kind' | 'name'> | undefined
export const placeOf = (c: Place): string => (!c ? '?' : c.kind === 'dm' ? 'DM' : `#${c.name}`)
export const inPlace = (c: Place): string => (c?.kind === 'dm' ? L('na DM dele', 'in their DM') : L(`em ${placeOf(c)}`, `in ${placeOf(c)}`))

export interface Returned {
  d: Delegation
  to: string // the name of whoever was doing it
  channel: string // where it was delivered, as placeOf names it
  what: 'done' | 'failed' | 'cancelled' | 'asking' | 'late'
  why?: string // a failure's reason
  text?: string // what it ended with (done), or what it wrote before asking (asking)
  question?: string // what it asks (asking)
}

// What came back, quoted in the asker's task: nothing of it is a message where the asker works.
const quoted = (text: string): string =>
  cut(text.trim())
    .split('\n')
    .map((l) => `  > ${l}`)
    .join('\n')

// What the asker is told when it gets the turn back: each thing that came back, by its code, and what to do with it.
export function returnTask(returned: Returned[], open: { d: Delegation; to: string; channel: string; parked?: boolean }[], me: string): string {
  const line = (r: Returned): string => {
    const head = `- [${codeOf(r.d)}] ${r.to}, ${r.channel}`
    if (r.what === 'done')
      return `${head}: ${L('terminou. O que respondeu', 'finished. What they answered')}${r.text?.trim() ? `:\n${quoted(r.text)}` : ` ${L('está na thread do pedido', 'is in the request\'s thread')}.`}`
    if (r.what === 'failed') return `${head}: ${L(`não terminou${r.why ? ` (${r.why.replace(/[.\s]+$/, '')})` : ''}. Diga isso a ${me}, e peça de novo se fizer sentido`, `did not finish${r.why ? ` (${r.why.replace(/[.\s]+$/, '')})` : ''}. Tell ${me} so, and ask again if it makes sense`)}.`
    if (r.what === 'cancelled') return `${head}: ${L('foi parado antes de terminar', 'was stopped before it finished')}.`
    if (r.what === 'late') return `${head}: ${L(`passou do prazo e ainda não terminou. Diga a ${me}; pra desistir, use cancelar_pedido`, `is past its deadline and has not finished. Tell ${me}; to give up, use cancelar_pedido`)}.`
    const so = r.text?.trim() ? `\n${L('O que escreveu até agora', 'What it wrote so far')}:\n${quoted(r.text)}` : ''
    const q = r.question?.trim() ? `\n${L('A pergunta', 'The question')}:\n${quoted(r.question)}` : ''
    return `${head}: ${L(
      `deixou uma pergunta e espera.${so}${q}\nSe você sabe a resposta por esta conversa ou pela sua memória, responda com responder_pedido e encerre sem texto: ${me} não precisa ler nada disso. Se é decisão de ${me}, pergunte a ${me} com ask_user, dizendo o que ${r.to} recomenda, e quando ${me} responder repasse com responder_pedido`,
      `left a question and waits.${so}${q}\nIf you know the answer from this conversation or your memory, answer with responder_pedido and end with no text: ${me} needs to read none of it. If it is ${me}'s decision, ask ${me} with ask_user, saying what ${r.to} recommends, and when ${me} answers pass it on with responder_pedido`
    )}.`
  }
  const still = open.length ? `\n\n${L('Ainda em andamento', 'Still going')}: ${open.map((o) => `[${codeOf(o.d)}] ${o.to}, ${o.channel}${o.parked ? ` (${L(`parado numa aprovação que espera ${me}, que ${me} vê embaixo da sua mensagem`, `held on an approval that waits for ${me}, which ${me} sees under your message`)})` : ''}`).join('; ')}.` : ''
  const close = returned.some((r) => r.what === 'asking')
    ? ''
    : `\n\n${L(
        `${open.length ? `Diga a ${me} o que já voltou, em poucas linhas, e o que ainda está andando.` : `Feche o assunto com ${me}: diga o resultado em poucas linhas, com o que importa de cada resposta, e o que precisa de decisão. Não copie as respostas inteiras: cada uma fica na thread do pedido, que ${me} abre pela linha embaixo da sua mensagem. Se falta ${me} escolher algo pra você seguir, pergunte com ask_user (com as opções), não no texto.`}`,
        `${open.length ? `Tell ${me} what has come back, in a few lines, and what is still going.` : `Close the subject with ${me}: say the result in a few lines, with what matters from each answer, and what needs a decision. Do not copy the answers whole: each stays in the request's thread, which ${me} opens from the line under your message. If ${me} has to choose something for you to go on, ask with ask_user (with the options), not in the text.`}`
      )}`
  return `${L('Voltou do que você pediu ao seu time', 'Back from what you asked of your team')}:\n${returned.map(line).join('\n')}${still}${close}`
}

// The asker's view of whom it may hand work to, for the live context: who answers to it and who answers
// to the same agent as it does, what each does and reaches, the channels each works in (with their
// topic: where a subject belongs) and what is still open.
export function teamSection(opts: { agent: Agent; agents: Agent[]; conversations: Conversation[]; connectors: Connector[]; open: Delegation[]; ended?: Delegation[]; me: string }): string | undefined {
  const { agent, agents, conversations, connectors, open, ended = [], me } = opts
  const team = reportsOf(agents, agent.id)
  const boss = bossOf(agents, agent)
  const heads = headsOf(agents)
  const isHead = heads.some((h) => h.id === agent.id)
  const isEntry = entriesOf(agents).some((e) => e.id === agent.id)
  // Another sector's head that answers to the same agent is told as a sector, below, not as a colleague.
  const peers = peersOf(agents, agent.id).filter((p) => !team.some((t) => t.id === p.id) && !(isHead && heads.some((h) => h.id === p.id)))
  // In no tree: the others in none are its colleagues, with no one over any of them.
  const loose = looseColleaguesOf(agents, agent.id)
  if (!team.length && !peers.length && !loose.length && !boss && !isHead) return undefined
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
    ? `\n\n${L('Pedidos seus em aberto (o que completa um destes vai com pedir e "continuar" com o código, não num pedido novo)', 'Your open requests (what adds to one of these goes with pedir and "continuar" set to its code, not in a new request)')}:\n${asked
        .map((d) => `- [${codeOf(d)}] ${name(d.to)}, ${channel(d.conversationId)}, ${L('desde', 'since')} ${clock(d.createdAt)}${d.dueAt ? `, ${L('prazo', 'by')} ${clock(d.dueAt)}` : ''}${d.asking ? `, ${L('esperando uma resposta sua', 'waiting for an answer from you')}` : ''}: ${d.text.replace(/\s+/g, ' ').slice(0, 140)}`)
        .join('\n')}`
    : ''
  const place = L(
    `O pedido fica no canal dele onde o assunto mora (o tema de cada canal diz). Se o assunto não é de nenhum canal dele (algo sobre ele mesmo, um recado, uma coisa pessoal de ${me}), peça com canal "dm": vai pra DM dele com ${me}. Na dúvida, o canal.`,
    `The request stays in their channel where the subject lives (each channel's topic says). If the subject belongs to none of their channels (something about themselves, a message to pass on, something personal to ${me}), ask with canal "dm": it goes to their DM with ${me}. In doubt, the channel.`
  )
  const mine = team.length
    ? `${L(
        `## Seu time\nEstes agentes respondem a você. Quando ${me} pedir algo que é do trabalho de um deles, não faça você: passe com pedir, a quem faz aquilo. ${place} Divida o que for de mais de um. Cada um tem os próprios acessos e pede as próprias aprovações a ${me}. Você não precisa acompanhar: a resposta volta pra onde você pediu, e você é chamado. As dúvidas de quem recebe também chegam a você, não a ${me}: no pedido, diga pra perguntar a você. Depois de pedir, encerre sem texto: ${me} vê embaixo da mensagem dele a quem você pediu e como está, e você fala com ${me} quando o trabalho voltar. Só o que você mesmo sabe responder, responda direto.`,
        `## Your team\nThese agents answer to you. When ${me} asks for something that is one of theirs to do, do not do it yourself: hand it over with pedir, to whoever does that. ${place} Split what belongs to more than one. Each has their own access and asks ${me} for their own approvals. You need not follow up: the answer comes back to where you asked, and you are called. The doubts of whoever gets it also come to you, not to ${me}: in the request, say to ask you. After asking, end with no text: ${me} sees under their message whom you asked and how it stands, and you talk to ${me} when the work comes back. Only what you can answer yourself, answer directly.`
      )}\n${team.map((a) => row(a, true)).join('\n')}`
    : ''
  const beside = peers.length
    ? `${L(
        `## Seus colegas\nEstes agentes respondem ao mesmo agente que você. Quando precisar de algo que é do trabalho de um deles pra terminar o seu, ou quando ${me} pedir que você fale com um deles, peça com pedir: a resposta volta pra cá e você é chamado. Não repasse a um colega o que foi pedido a você, e não peça de volta a quem te pediu.${team.length ? '' : ` ${place}`}`,
        `## Your colleagues\nThese agents answer to the same agent as you. When you need something that is one of theirs to do in order to finish yours, or when ${me} asks you to talk to one of them, ask with pedir: the answer comes back here and you are called. Do not pass on to a colleague what was asked of you, and do not ask back whoever asked you.${team.length ? '' : ` ${place}`}`
      )}\n${peers.map((a) => row(a, false)).join('\n')}`
    : ''
  const side = loose.length
    ? `${L(
        `## Seus colegas\nVocês são um time sem chefe: qualquer um pode pedir trabalho ao outro. Quando uma parte do que ${me} pediu é claramente do trabalho de um deles (pelo papel), ou você precisa do resultado dele pra terminar o seu, passe essa parte com pedir, com tudo o que ele precisa saber: ele começa na hora, a resposta volta pra cá e você é chamado de novo pra juntar tudo. Se o pedido de ${me} já nomeia quem faz cada parte, siga essa divisão. O que você mesmo faz bem, faça você: peça só o que é de outro. Não repasse inteiro o que pediram a você, e não peça de volta a quem te pediu. Pra só passar a vez neste canal, sem precisar da resposta de volta, basta mencionar com @. ${place}`,
        `## Your colleagues\nYou are a team with no boss: anyone may ask another for work. When a part of what ${me} asked is clearly one of theirs to do (by their role), or you need their result to finish yours, hand that part over with pedir, with everything they need to know: they start right away, the answer comes back here and you are called again to put it all together. If ${me}'s request already names who does each part, follow that split. What you do well yourself, do it: ask only what is someone else's. Do not pass on whole what was asked of you, and do not ask back whoever asked you. To just hand over the turn in this channel, with no need for the answer back, mentioning with @ is enough. ${place}`
      )}\n${loose.map((a) => row(a, false)).join('\n')}`
    : ''
  // Its sector's head, when that isn't its boss: what isn't the sector's goes straight there, past whoever is between.
  const top = boss && !isHead ? sectorOf(agents, agent.id) : undefined
  const far = top && top.id !== boss?.id ? top : undefined
  const who = (a: Agent): string => `@${a.handle} · ${a.name}${a.role ? `, ${a.role.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`
  const up = boss
    ? `${
        far
          ? L(
              `## Seu chefe\n${who(boss)}. Passe a ele com pedir só o que você não consegue fazer, dizendo por quê. Nunca passe pra cima o que o próprio chefe pediu a você: responda a ele.\n\n## Chefe do seu setor\n${who(far)}. O que não é do trabalho do seu setor vai direto a ele com pedir, dizendo por quê, sem passar por quem está no meio: só ele pede a outro setor.`,
              `## Your boss\n${who(boss)}. Pass to them with pedir only what you can't do, saying why. Never pass up what your boss itself asked you: answer it.\n\n## Your sector's head\n${who(far)}. What isn't your sector's job goes straight to them with pedir, saying why, past whoever is in between: only they ask another sector.`
            )
          : L(
              `## Seu chefe\n${who(boss)}. Passe a ele com pedir só o que não é do trabalho do seu setor ou que você não consegue fazer, dizendo por quê. Nunca passe pra cima o que o próprio chefe pediu a você: responda a ele.`,
              `## Your boss\n${who(boss)}. Pass to them with pedir only what isn't your sector's job or what you can't do, saying why. Never pass up what your boss itself asked you: answer it.`
            )
      }`
    : ''
  const does = (a: Agent): string => a.sectorDoes?.replace(/\s+/g, ' ').trim() || L('não descrito', 'not described')
  const sectors = isHead
    ? `${L(
        `## Seu setor\nSeu setor: ${sectorName(agent)} · resolve: ${does(agent)}`,
        `## Your sector\nYour sector: ${sectorName(agent, 'Sector of')} · solves: ${does(agent)}`
      )}${
        heads.some((h) => h.id !== agent.id)
          ? `\n\n${L(
              `## Outros setores\nSó o chefe de um setor pede a outro setor, e sempre ao chefe dele. Peça só o que é claramente deles. Se um pedido de outro setor não é do seu, responda dizendo por quê. Se nenhum setor cuida do assunto, pergunte a ${me} com ask_user.`,
              `## Other sectors\nOnly a sector's head asks another sector, and always its head. Ask only what is clearly theirs. If a request from another sector isn't yours, answer saying why. If no sector handles the subject, ask ${me} with ask_user.`
            )}\n${heads.filter((h) => h.id !== agent.id).map((h) => `- @${h.handle} · ${sectorName(h, L('Setor de', 'Sector of'))} · ${L('resolve', 'solves')}: ${does(h)}`).join('\n')}`
          : ''
      }`
    : ''
  // The entry point: the person talks to it, and each team below it is a sector with a head of its own.
  const below = isEntry
    ? `${L(
        `## Os setores\nVocê é a porta de entrada: ${me} fala com você, e você passa cada parte ao setor certo. Cada time é um setor, com um chefe. O que é de um setor, peça ao chefe dele, que decide quem do setor faz; não peça direto a quem está abaixo dele. Quando um pedido envolve mais de um setor, passe as partes ao mesmo tempo.`,
        `## The sectors\nYou are the entry point: ${me} talks to you, and you pass each part to the sector it belongs to. Each team is a sector, with a head. What is a sector's, ask its head, who decides who in the sector does it; do not ask those below the head directly. When a request involves more than one sector, pass the parts at the same time.`
      )}\n${heads.map((h) => `- @${h.handle} · ${sectorName(h, L('Setor de', 'Sector of'))} · ${L('resolve', 'solves')}: ${does(h)}`).join('\n')}`
    : ''
  // What came back to this very place: a follow-up on one of these goes on in its thread, with what was done there in view.
  const back = ended.filter((d) => d.from === agent.id && d.state !== 'open').slice(-5)
  const again = back.length
    ? `\n\n${L(
        `## Pedidos que já voltaram aqui\nSe o que ${me} pede agora continua um destes assuntos, com o mesmo agente, peça com pedir e "continuar" com o código: segue na mesma thread, e ele vê o que já fez. Assunto novo, pedido novo.`,
        `## Requests that came back here\nIf what ${me} asks now continues one of these subjects, with the same agent, ask with pedir and "continuar" set to its code: it goes on in the same thread, and they see what they already did. A new subject, a new request.`
      )}\n${back.map((d) => `- [${codeOf(d)}] ${name(d.to)}, ${channel(d.conversationId)}, ${d.state === 'done' ? L('terminou', 'finished') : d.state === 'failed' ? L('não terminou', 'did not finish') : L('foi parado', 'was stopped')}: ${d.text.replace(/\s+/g, ' ').slice(0, 140)}`).join('\n')}`
    : ''
  return `${[mine, beside, side, up, sectors, below].filter(Boolean).join('\n\n')}${going}${again}`
}
