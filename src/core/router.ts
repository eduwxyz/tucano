// The router picks who answers a channel message nobody was mentioned in, and
// in what order: a plan is the layers of who answers, everyone in a layer at
// once and the next layer only after the one before, so it reads what they
// wrote. It only chooses speakers: it grants nothing and never sees tools, just
// which connectors each agent may use, so a question about Linear goes to
// whoever can read Linear. It also screens an agent's reply that mentions
// others, so a "thanks, @bia" doesn't wake her up.
import { L } from '../shared/lang'
import type { Agent, Connector, Message } from '../shared/types'
import type { Engine, TurnShape, Usage } from './engines/types'
import type { ThreadDigest } from './memory'

export const ROUTER_HISTORY = 10
export const MAX_ROUTED = 2 // agents in one layer, answering at once
export const MAX_LAYERS = 2 // layers in one plan: who answers at once, then who waits for them
export const MAX_PLANNED = 3 // agents in one plan, counting every layer

// The router's answer: the layers of who answers, in order. One layer is the
// old "who answers" (all at once); a second layer waits for the first, so it
// reads what it wrote. An empty plan is nobody.
export type TurnPlan = Agent[][]
export const planAgents = (plan: TurnPlan): Agent[] => plan.flat()

// What an agent of a plan is told about it: the layers, which one is theirs, and that the next
// one waits for them. A layer that knows another answers after it hands over what it found
// instead of the finished work, which is what happened twice over in the same thread. A plan of
// one layer has no order to keep, so nobody is told anything and the reply reads as it always
// did. Empty string: nothing to say to this agent.
export function planBrief(plan: TurnPlan, agent: Agent, reason: string): string {
  const layers = plan.filter((l) => l.length > 0)
  const mine = layers.findIndex((l) => l.some((a) => a.id === agent.id))
  if (layers.length < 2 || mine < 0) return ''
  const names = (l: Agent[]): string => l.map((a) => a.name).join(L(' e ', ' and '))
  const layer = (i: number): string => L(`${i + 1}ª camada`, `layer ${i + 1}`)
  return [
    L(`O roteador dividiu esta mensagem em ${layers.length} camadas, uma depois da outra:`, `The router split this message into ${layers.length} layers, one after the other:`),
    ...layers.map((l, i) => `- ${layer(i)}: ${names(l)}`),
    mine === 0
      ? L('Você é da 1ª camada, e responde agora. A camada seguinte só começa quando a sua terminar, e aí lê o que ficou escrito aqui.', 'You are in the 1st layer, answering now. The next layer only starts when yours is done, and then reads what was written here.')
      : L(`Você é da ${layer(mine)}, e responde agora, depois da camada anterior, que já escreveu acima.`, `You are in ${layer(mine)}, answering now, after the layer before, which already wrote above.`),
    reason ? L(`Motivo do plano: ${reason}`, `Plan reason: ${reason}`) : ''
  ]
    .filter(Boolean)
    .join('\n')
}

export const routerSystem = (): string =>
  L(
    [
      'Você decide quais agentes de um chat de trabalho devem responder à última mensagem humana, e em que ordem.',
      'Responda SOMENTE com JSON, sem texto em volta, no formato {"plano": [["..."], ["..."]], "todos": false, "reason": "..."}:',
      `- "plano": de 0 a ${MAX_LAYERS} camadas, cada uma com 0 a ${MAX_ROUTED} handles (no máximo ${MAX_PLANNED} handles no plano todo), só da lista de agentes. Todos os agentes de uma camada respondem ao mesmo tempo; a camada seguinte só começa quando a anterior terminar, e aí já lê o que ela escreveu.`,
      '- Prefira 1 agente. Use 2 handles na mesma camada quando as respostas não dependem uma da outra (dois assuntos, dois sistemas diferentes). Use 2 camadas quando a segunda precisa do que a primeira escrever: um acha e o outro escreve, um decide e o outro faz, um faz e o outro revisa.',
      '- "todos": true quando a mensagem é pro grupo todo (um cumprimento, "pessoal", uma pergunta pra todos, uma apresentação): aí todos os agentes respondem, numa camada só.',
      '- "reason": um motivo de até 12 palavras, em português.',
      'Se a mensagem depende de um sistema externo (ex.: Linear, GitHub), prefira quem tem acesso a ele; se ninguém tem, escolha pelo papel.',
      'Um cumprimento nunca fica sem resposta. Plano vazio (e "todos" falso) só quando ninguém precisa responder: agradecimento, recado, conversa já encerrada.'
    ].join('\n'),
    [
      'You decide which agents in a work chat should answer the last human message, and in what order.',
      'Reply ONLY with JSON, no text around it, in the format {"plano": [["..."], ["..."]], "everyone": false, "reason": "..."}:',
      `- "plano": 0 to ${MAX_LAYERS} layers, each with 0 to ${MAX_ROUTED} handles (at most ${MAX_PLANNED} handles in the whole plan), only from the list of agents. Every agent in a layer answers at once; the next layer only starts when the one before is done, and then it reads what it wrote.`,
      '- Prefer 1 agent. Use 2 handles in the same layer when the replies do not depend on each other (two subjects, two different systems). Use 2 layers when the second needs what the first writes: one finds and the other writes, one decides and the other does, one does and the other reviews.',
      '- "everyone": true when the message is for the whole group (a greeting, "everyone", a question for all, an introduction): then every agent answers, in a single layer.',
      '- "reason": a reason of up to 12 words, in English.',
      'If the message depends on an external system (e.g. Linear, GitHub), prefer whoever has access to it; if no one does, choose by role.',
      "A greeting never goes unanswered. An empty plan (and \"everyone\" false) only when no one needs to answer: a thank-you, a note, a conversation that's already over."
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

// Who wrote a message, as the router reads it.
const speaker =
  (agents: Agent[], me: string) =>
  (m: Message): string =>
    m.author.kind === 'me'
      ? me
      : m.author.kind === 'routine'
        ? L(`rotina de ${me}`, `${me}'s routine`)
        : (agents.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? L('agente', 'agent'))

// `thread`: the message that started the thread the last message is in; `messages` are then
// that thread, and `threads` the conversation's other threads, a line each (who took what).
export function routerPrompt(opts: { messages: Message[]; agents: Agent[]; me: string; connectors?: Connector[]; thread?: Message; threads?: ThreadDigest[] }): string {
  const { messages, agents, me, connectors = [], thread, threads = [] } = opts
  const roster = agents.map((a) => `- ${a.handle}: ${describeAgent(a, connectors)}`)
  const name = speaker(agents, me)
  const recent = messages.filter((m) => said(m) && m.id !== thread?.id).slice(-ROUTER_HISTORY)
  const lines = [...(thread && said(thread) ? [thread] : []), ...recent].map((m) => `[${name(m)}] ${m.text.trim().slice(0, 600)}`)
  // Who answered what elsewhere, so a follow-up goes to whoever handled the subject.
  const others = threads
    .filter((t) => t.root && said(t.root))
    .map((t) => {
      const who = t.agents.map((id) => agents.find((a) => a.id === id)?.name ?? L('agente', 'agent')).join(', ')
      return `- [${name(t.root!)}] ${t.root!.text.replace(/\s+/g, ' ').trim().slice(0, 200)} → ${who || L('sem resposta', 'no reply')}`
    })
  return [
    L('Agentes no canal:', 'Agents in the channel:'),
    ...roster,
    '',
    ...(others.length ? [L('Outras threads recentes (outros assuntos, só contexto: quem respondeu cada uma):', 'Other recent threads (other subjects, context only: who answered each):'), ...others, ''] : []),
    thread
      ? L('Thread (a primeira mensagem abriu a thread; a última é a que precisa de resposta):', 'Thread (the first message started it; the last one is the one that needs an answer):')
      : L('Conversa (a última é a que precisa de resposta):', 'Conversation (the last one is the one that needs an answer):'),
    ...lines,
    '',
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

// The reply sits between <reply> tags so it can't be confused with the roster or the history.
export function handoffPrompt(opts: { reply: string; author: Agent; candidates: Agent[]; messages: Message[]; members: Agent[]; me: string; connectors?: Connector[]; busy?: Agent[] }): string {
  const { reply, author, candidates, messages, members, me, connectors = [], busy = [] } = opts
  const name = speaker(members, me)
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
    L(`Resposta de ${author.name} que você avalia:`, `${author.name}'s reply you are judging:`),
    '<reply>',
    reply.trim().slice(0, 3000),
    '</reply>',
    '',
    REPLY_JSON()
  ].join('\n')
}

// Lenient: models sometimes wrap JSON in a code fence or add a line around it.
// `max` caps the handles in one layer (a hand-off passes how many were mentioned).
export function parseRoute(text: string, agents: Agent[], max = MAX_ROUTED): { plan: TurnPlan; reason: string } | null {
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!json) return null
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  if (!data || typeof data !== 'object') return null
  const { plano, plan: layers, handles, reason, todos, everyone } = data as { plano?: unknown; plan?: unknown; handles?: unknown; reason?: unknown; todos?: unknown; everyone?: unknown }
  const why = typeof reason === 'string' ? reason.trim() : ''
  // A message for the whole group: every agent in the channel answers, in one layer.
  if (todos === true || everyone === true) return { plan: [agents.slice()], reason: why }
  // "plano" is the layers; "handles" is what the older prompt asked for: everyone at once.
  const raw = Array.isArray(plano) ? plano : Array.isArray(layers) ? layers : Array.isArray(handles) ? [handles] : null
  if (!raw) return null
  const plan: TurnPlan = []
  const taken = new Set<string>()
  let total = 0
  for (const layer of raw) {
    if (plan.length >= MAX_LAYERS || total >= MAX_PLANNED) break
    if (!Array.isArray(layer)) continue
    const picked: Agent[] = []
    for (const h of layer) {
      if (typeof h !== 'string') continue
      const a = agents.find((x) => x.handle.toLowerCase() === h.replace(/^@/, '').toLowerCase())
      if (a && !taken.has(a.id) && !picked.includes(a)) picked.push(a)
    }
    if (!picked.length) continue
    const kept = picked.slice(0, Math.min(max, MAX_PLANNED - total))
    for (const a of kept) taken.add(a.id)
    plan.push(kept)
    total += kept.length
  }
  return { plan, reason: why }
}

// The router's turn without its prompt: the same for every message, so its process can start ahead.
export const routerTurn = (model: string, cwd: string): TurnShape => ({ model, effort: 'low', system: routerSystem(), cwd })

export async function route(opts: {
  engine: Engine
  model: string
  messages: Message[]
  agents: Agent[]
  me: string
  connectors?: Connector[]
  thread?: Message
  threads?: ThreadDigest[]
  cwd: string
}): Promise<{ plan: TurnPlan; reason: string; usage?: Usage; ms: number } | { error: string; usage?: Usage; ms: number }> {
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
  // A reply may mention up to three agents, and each one asked needs the turn: they all answer at once.
  const parsed = parseRoute(text, opts.candidates, opts.candidates.length)
  return parsed ? { agents: planAgents(parsed.plan), reason: parsed.reason, usage, ms } : { error: L('resposta do router fora do formato', "the router's answer wasn't in the format"), usage, ms }
}
