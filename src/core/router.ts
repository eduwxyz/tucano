// The router picks who answers a channel message nobody was mentioned in. It
// only chooses speakers: it grants nothing and never sees tools, just which
// connectors each agent may use, so a question about Linear goes to whoever
// can read Linear. It also screens an agent's reply that mentions others, so a
// "thanks, @bia" doesn't wake her up.
import { L } from '../shared/lang'
import { MENTION } from '../shared/mention-text'
import { CODE_SPANS, type Agent, type Connector, type Message, type Person } from '../shared/types'
import type { Engine, TurnShape, Usage } from './engines/types'
import type { ThreadDigest } from './memory'

export const ROUTER_HISTORY = 10
export const MAX_ROUTED = 2

export const routerSystem = (): string =>
  L(
    [
      'Você decide quais agentes de um chat de trabalho devem responder à última mensagem humana.',
      'Responda SOMENTE com JSON, sem texto em volta, no formato {"handles": ["..."], "todos": false, "reason": "..."}:',
      `- "handles": de 0 a ${MAX_ROUTED} handles, só da lista de agentes; prefira 1.`,
      '- "todos": true quando a mensagem é pro grupo todo (um cumprimento, "pessoal", uma pergunta pra todos, uma apresentação): aí todos os agentes respondem.',
      '- "reason": um motivo de até 12 palavras, em português.',
      'Se a mensagem depende de um sistema externo (ex.: Linear, GitHub), prefira quem tem acesso a ele; se ninguém tem, escolha pelo papel.',
      'Uma resposta curta a uma pergunta ou pedido de um agente ("pode", "sim", "pode disparar", "manda ver") vai pra esse agente, mesmo quando a pergunta está numa mensagem anterior do canal ou em outra thread: é ele quem está esperando.',
      'Um cumprimento nunca fica sem resposta. Lista vazia (e "todos" falso) só quando ninguém precisa responder: agradecimento, recado, conversa já encerrada.'
    ].join('\n'),
    [
      'You decide which agents in a work chat should answer the last human message.',
      'Reply ONLY with JSON, no text around it, in the format {"handles": ["..."], "everyone": false, "reason": "..."}:',
      `- "handles": 0 to ${MAX_ROUTED} handles, only from the list of agents; prefer 1.`,
      '- "everyone": true when the message is for the whole group (a greeting, "everyone", a question for all, an introduction): then every agent answers.',
      '- "reason": a reason of up to 12 words, in English.',
      'If the message depends on an external system (e.g. Linear, GitHub), prefer whoever has access to it; if no one does, choose by role.',
      'A short answer to an agent\'s question or request ("yes", "go ahead", "you can run it", "do it") goes to that agent, even when the question is in an earlier message of the channel or in another thread: that agent is the one waiting.',
      "A greeting never goes unanswered. An empty list (and \"everyone\" false) only when no one needs to answer: a thank-you, a note, a conversation that's already over."
    ].join('\n')
  )

const grantLabel = (g: 'read' | 'read_write'): string => (g === 'read' ? L('só leitura', 'read-only') : L('leitura e escrita', 'read and write'))

// "Lia, Engenharia: Ajuda com código. · acessa: Linear (só leitura)"
export function describeAgent(a: Agent, connectors: Connector[] = []): string {
  const about = a.instructions.split('\n')[0]?.slice(0, 140)
  const access = connectors.flatMap((c) => {
    const g = a.grants[c.id]
    return g === 'read' || g === 'read_write' ? [`${c.name} (${grantLabel(g)})`] : []
  })
  return `${a.name}${a.role ? `, ${a.role}` : ''}${about ? `: ${about}` : ''} · ${L('acessa', 'uses')}: ${access.join(', ') || L('nenhum sistema externo', 'no external system')}`
}

export const REPLY_JSON = (): string => L('Responda só com o JSON.', 'Reply with the JSON only.')

const said = (m: Message): boolean => !!m.text.trim() && m.author.kind !== 'system'

// A long message as its opening and its end: a question or a request is usually at the end of a
// long reply ("…posso disparar agora?"), and the router needs it to know who is waiting for an answer.
export const opensAndEnds = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const half = Math.floor((max - 5) / 2)
  return `${t.slice(0, half).trimEnd()} […] ${t.slice(-half).trimStart()}`
}

// Who wrote a message, as the router reads it.
// A person's message reads with their name (one not in `people`, as `me`).
type People = Pick<Person, 'id' | 'name'>[]
const speaker =
  (agents: Agent[], me: string, people?: People) =>
  (m: Message): string =>
    m.author.kind === 'person'
      ? (people?.find((p) => m.author.kind === 'person' && p.id === m.author.id)?.name ?? me)
      : m.author.kind === 'routine'
        ? L(`rotina de ${me}`, `${me}'s routine`)
        : (agents.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? L('agente', 'agent'))

// `thread`: the message that started the thread the last message is in; `messages` are then
// that thread, and `threads` the conversation's other threads, a line each (who took what).
// `team`: more than one person talks here; what they say to each other isn't for the agents.
export function routerPrompt(opts: { messages: Message[]; agents: Agent[]; me: string; people?: People; connectors?: Connector[]; thread?: Message; threads?: ThreadDigest[]; team?: boolean }): string {
  const { messages, agents, me, people, connectors = [], thread, threads = [], team } = opts
  const roster = agents.map((a) => `- ${a.handle}: ${describeAgent(a, connectors)}`)
  const name = speaker(agents, me, people)
  const recent = messages.filter((m) => said(m) && m.id !== thread?.id).slice(-ROUTER_HISTORY)
  const lines = [...(thread && said(thread) ? [thread] : []), ...recent].map((m) => `[${name(m)}] ${opensAndEnds(m.text, 800)}`)
  // Who answered what elsewhere, so a follow-up goes to whoever handled the subject, and how an
  // agent's last word there ended: a question there may be what this message answers.
  const others = threads
    .filter((t) => t.root && said(t.root))
    .map((t) => {
      const who = t.agents.map((id) => agents.find((a) => a.id === id)?.name ?? L('agente', 'agent')).join(', ')
      const last = t.last && t.last.id !== t.root!.id && t.last.author.kind === 'agent' ? ` · ${L('por último', 'last')} [${name(t.last)}] ${opensAndEnds(t.last.text, 300)}` : ''
      return `- [${name(t.root!)}] ${opensAndEnds(t.root!.text, 300)} → ${who || L('sem resposta', 'no reply')}${last}`
    })
  return [
    L('Agentes no canal:', 'Agents in the channel:'),
    ...roster,
    '',
    ...(others.length ? [L('Antes, no canal (outras threads e mensagens, das mais antigas pras mais novas: quem respondeu cada uma e como terminou):', 'Earlier in the channel (other threads and messages, oldest to newest: who answered each and how it ended):'), ...others, ''] : []),
    thread
      ? L('Thread (a primeira mensagem abriu a thread; a última é a que precisa de resposta):', 'Thread (the first message started it; the last one is the one that needs an answer):')
      : L('Conversa (a última é a que precisa de resposta):', 'Conversation (the last one is the one that needs an answer):'),
    ...lines,
    '',
    ...(team
      ? [
          L(
            'Aqui conversam várias pessoas. Um cumprimento ou recado entre as pessoas, sem pergunta nem pedido pros agentes ("bom dia", "chego às 10", "@Ana valeu"), não precisa de agente: lista vazia e "todos" falso. Isso vale no lugar da regra do cumprimento.',
            'Several people talk here. A greeting or note between the people, with no question or request for the agents ("good morning", "in at 10", "@Ana thanks"), needs no agent: empty list and "everyone" false. This replaces the greeting rule.'
          ),
          ''
        ]
      : []),
    REPLY_JSON()
  ].join('\n')
}

export const handoffSystem = (): string =>
  L(
    [
      'Um agente de um chat de trabalho escreveu uma resposta que menciona outros agentes. Você decide quais deles precisam agir por causa dela.',
      'Responda SOMENTE com JSON, sem texto em volta, no formato {"handles": ["..."], "reason": "..."}:',
      '- "handles": só handles da lista de agentes mencionados.',
      '- "reason": um motivo de até 12 palavras, em português.',
      'Passe a vez para: um pedido, uma pergunta, uma tarefa, uma revisão, uma decisão que alguém está esperando.',
      'Não passe a vez para: agradecimento, confirmação ("combinado", "valeu", "ok", 👍), menção que só dá crédito ou informa, recado sem pedido, ficar esperando o aviso ou o resultado de alguém ("Fico esperando o aviso do Léo").',
      'Na dúvida, passe a vez.'
    ].join('\n'),
    [
      'An agent in a work chat wrote a reply that mentions other agents. You decide which of them need to act because of it.',
      'Reply ONLY with JSON, no text around it, in the format {"handles": ["..."], "reason": "..."}:',
      '- "handles": only handles from the list of mentioned agents.',
      '- "reason": a reason of up to 12 words, in English.',
      'Hand the turn over for: a request, a question, a task, a review, a decision someone is waiting on.',
      "Do not hand it over for: thanks, an acknowledgement (\"agreed\", \"thanks\", \"ok\", 👍), a mention that only credits or informs, a note with no ask, waiting for someone's update or result (\"I'll wait for Léo's heads-up\").",
      'When in doubt, hand the turn over.'
    ].join('\n')
  )

// A long reply goes to the hand-off screen as its opening plus the lines around each mention
// of a candidate, so an ask written at the end of a long plan ("@rafa, I need two decisions")
// is what gets judged. What's left out shows as "[…]". A short reply goes in whole.
const REPLY_MAX = 3000
const OPENING = 1000
const BEFORE = 600
const AFTER = 1200
// A cut moves to the nearest line break when one is this close, so lines arrive whole.
const SNAP = 200

const lineStart = (t: string, i: number): number => {
  const n = t.lastIndexOf('\n', i)
  return n >= 0 && i - n <= SNAP ? n + 1 : i
}
const lineEnd = (t: string, i: number): number => {
  const n = t.indexOf('\n', i)
  return n >= 0 && n - i <= SNAP ? n : i
}

export function replyExcerpt(reply: string, handles: string[]): string {
  const text = reply.trim()
  if (text.length <= REPLY_MAX) return text
  const wanted = new Set(handles.map((h) => h.toLowerCase()))
  // Same rule as `mentioned`: a handle inside code doesn't count. Blanking keeps the offsets.
  const plain = text.replace(CODE_SPANS, (s) => ' '.repeat(s.length))
  // The first and the last mention of each candidate: the ask is usually one of them, and a reply
  // that names someone on every line still goes in bounded.
  const at = new Map<string, number[]>()
  for (const m of plain.matchAll(MENTION)) {
    const h = m[2]!.toLowerCase()
    if (!wanted.has(h)) continue
    const i = m.index + m[1]!.length
    const seen = at.get(h)
    if (!seen) at.set(h, [i])
    else seen[1] = i
  }
  const spans: [number, number][] = [[0, lineEnd(text, OPENING)]]
  for (const i of [...at.values()].flat()) spans.push([lineStart(text, Math.max(0, i - BEFORE)), lineEnd(text, Math.min(text.length, i + AFTER))])
  spans.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [from, to] of spans) {
    const last = merged[merged.length - 1]
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else merged.push([from, to])
  }
  const parts = merged.map(([from, to]) => text.slice(from, to).trim())
  const end = merged[merged.length - 1]![1]
  return parts.join('\n[…]\n') + (end < text.length ? '\n[…]' : '')
}

// The reply sits between <reply> tags so it can't be confused with the roster or the history.
export function handoffPrompt(opts: { reply: string; author: Agent; candidates: Agent[]; messages: Message[]; members: Agent[]; me: string; people?: People; connectors?: Connector[]; busy?: Agent[] }): string {
  const { reply, author, candidates, messages, members, me, people, connectors = [], busy = [] } = opts
  const name = speaker(members, me, people)
  const excerpt = replyExcerpt(reply, candidates.map((a) => a.handle))
  const cut = excerpt !== reply.trim()
  return [
    L('Agentes mencionados:', 'Mentioned agents:'),
    ...candidates.map((a) => `- ${a.handle}: ${describeAgent(a, connectors)}`),
    ...(busy.length
      ? [
          L(
            `Já estão respondendo aqui: ${busy.map((a) => a.name).join(', ')}. Só passe a vez para eles se a resposta trouxer algo novo pra eles (decisão, pedido, correção).`,
            `Already replying here: ${busy.map((a) => a.name).join(', ')}. Only hand them the turn if the reply brings them something new (a decision, a request, a correction).`
          )
        ]
      : []),
    '',
    L('Conversa recente:', 'Recent conversation:'),
    ...messages.filter(said).slice(-ROUTER_HISTORY).map((m) => `[${name(m)}] ${m.text.trim().slice(0, 600)}`),
    '',
    cut
      ? L(
          `Resposta de ${author.name} que você avalia (longa: vão o começo e os trechos com as menções; […] marca o que ficou de fora):`,
          `${author.name}'s reply you are judging (long: its opening and the parts with the mentions; […] marks what was left out):`
        )
      : L(`Resposta de ${author.name} que você avalia:`, `${author.name}'s reply you are judging:`),
    '<reply>',
    excerpt,
    '</reply>',
    '',
    REPLY_JSON()
  ].join('\n')
}

// Lenient: models sometimes wrap JSON in a code fence or add a line around it.
export function parseRoute(text: string, agents: Agent[], max = MAX_ROUTED): { agents: Agent[]; reason: string } | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const { handles, reason, todos, everyone } = data as { handles?: unknown; reason?: unknown; todos?: unknown; everyone?: unknown }
  const why = typeof reason === 'string' ? reason.trim() : ''
  // A message for the whole group: every agent in the channel answers.
  if (todos === true || everyone === true) return { agents: [...agents], reason: why }
  if (!Array.isArray(handles)) return null
  const picked: Agent[] = []
  for (const h of handles) {
    if (typeof h !== 'string') continue
    const a = agents.find((x) => x.handle.toLowerCase() === h.replace(/^@/, '').toLowerCase())
    if (a && !picked.includes(a)) picked.push(a)
  }
  return { agents: picked.slice(0, max), reason: why }
}

// The router's turn without its prompt: the same for every message, so its process can start ahead.
export const routerTurn = (model: string, cwd: string): TurnShape => ({ model, effort: 'low', system: routerSystem(), cwd })

export async function route(opts: {
  engine: Engine
  model: string
  messages: Message[]
  agents: Agent[]
  me: string
  people?: People
  connectors?: Connector[]
  thread?: Message
  threads?: ThreadDigest[]
  team?: boolean
  cwd: string
}): Promise<{ agents: Agent[]; reason: string; usage?: Usage; ms: number } | { error: string; usage?: Usage; ms: number }> {
  const started = Date.now()
  let text = ''
  let usage: Usage | undefined
  let error: string | undefined
  for await (const ev of opts.engine.run({ ...routerTurn(opts.model, opts.cwd), prompt: routerPrompt(opts), signal: AbortSignal.timeout(60_000) })) {
    if (ev.type === 'text') text += ev.delta
    else if (ev.type === 'done') {
      text = ev.text || text
      usage = ev.usage
    } else if (ev.type === 'error') error = ev.message
  }
  const ms = Date.now() - started
  if (error) return { error, usage, ms }
  const parsed = parseRoute(text, opts.agents)
  return parsed ? { ...parsed, usage, ms } : { error: L('resposta do router fora do formato', "the router's answer wasn't in the format"), usage, ms }
}

// Which of the agents an agent's reply mentions need to act on it. Same engine loop as route().
export async function screenHandoff(opts: {
  engine: Engine
  model: string
  reply: string
  author: Agent
  candidates: Agent[]
  messages: Message[]
  members: Agent[]
  me: string
  people?: People
  connectors?: Connector[]
  busy?: Agent[]
  cwd: string
}): Promise<{ agents: Agent[]; reason: string; usage?: Usage; ms: number } | { error: string; usage?: Usage; ms: number }> {
  const started = Date.now()
  let text = ''
  let usage: Usage | undefined
  let error: string | undefined
  for await (const ev of opts.engine.run({
    model: opts.model,
    effort: 'low',
    system: handoffSystem(),
    prompt: handoffPrompt(opts),
    cwd: opts.cwd,
    signal: AbortSignal.timeout(60_000)
  })) {
    if (ev.type === 'text') text += ev.delta
    else if (ev.type === 'done') {
      text = ev.text || text
      usage = ev.usage
    } else if (ev.type === 'error') error = ev.message
  }
  const ms = Date.now() - started
  if (error) return { error, usage, ms }
  // A reply may mention up to three agents, and each one asked needs the turn.
  const parsed = parseRoute(text, opts.candidates, opts.candidates.length)
  return parsed ? { ...parsed, usage, ms } : { error: L('resposta do router fora do formato', "the router's answer wasn't in the format"), usage, ms }
}
