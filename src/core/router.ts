// The router picks who answers a channel message nobody was mentioned in. It
// only chooses speakers: it grants nothing and never sees tools, just which
// connectors each agent may use, so a question about Linear goes to whoever
// can read Linear.
import { L } from '../shared/lang'
import type { Agent, Connector, Message } from '../shared/types'
import type { Engine, Usage } from './engines/types'
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
      'Um cumprimento nunca fica sem resposta. Lista vazia (e "todos" falso) só quando ninguém precisa responder: agradecimento, recado, conversa já encerrada.'
    ].join('\n'),
    [
      'You decide which agents in a work chat should answer the last human message.',
      'Reply ONLY with JSON, no text around it, in the format {"handles": ["..."], "everyone": false, "reason": "..."}:',
      `- "handles": 0 to ${MAX_ROUTED} handles, only from the list of agents; prefer 1.`,
      '- "everyone": true when the message is for the whole group (a greeting, "everyone", a question for all, an introduction): then every agent answers.',
      '- "reason": a reason of up to 12 words, in English.',
      'If the message depends on an external system (e.g. Linear, GitHub), prefer whoever has access to it; if no one does, choose by role.',
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

// `thread`: the message that started the thread the last message is in; `messages` are then
// that thread, and `threads` the conversation's other threads, a line each (who took what).
export function routerPrompt(opts: { messages: Message[]; agents: Agent[]; me: string; connectors?: Connector[]; thread?: Message; threads?: ThreadDigest[] }): string {
  const { messages, agents, me, connectors = [], thread, threads = [] } = opts
  const roster = agents.map((a) => `- ${a.handle}: ${describeAgent(a, connectors)}`)
  const said = (m: Message): boolean => !!m.text.trim() && m.author.kind !== 'system'
  const name = (m: Message): string =>
    m.author.kind === 'me'
      ? me
      : m.author.kind === 'routine'
        ? L(`rotina de ${me}`, `${me}'s routine`)
        : (agents.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? L('agente', 'agent'))
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

// Lenient: models sometimes wrap JSON in a code fence or add a line around it.
export function parseRoute(text: string, agents: Agent[]): { agents: Agent[]; reason: string } | null {
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
  return { agents: picked.slice(0, MAX_ROUTED), reason: why }
}

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
}): Promise<{ agents: Agent[]; reason: string; usage?: Usage; ms: number } | { error: string; usage?: Usage; ms: number }> {
  const started = Date.now()
  let text = ''
  let usage: Usage | undefined
  let error: string | undefined
  for await (const ev of opts.engine.run({
    model: opts.model,
    effort: 'low',
    system: routerSystem(),
    prompt: routerPrompt(opts),
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
  const parsed = parseRoute(text, opts.agents)
  return parsed ? { ...parsed, usage, ms } : { error: L('resposta do router fora do formato', "the router's answer wasn't in the format"), usage, ms }
}
