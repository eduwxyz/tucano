// Jev, TypeSafe's decision model, as an optional router (spec §2): it answers
// "who replies?" as a typed choice in well under a second, where a CLI turn
// takes several. It needs the user's own TypeSafe key, and each decision sends
// the channel's recent messages to TypeSafe, so it's off unless chosen.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import type { Decision } from '../shared/questions'
import type { Agent, Connector, Message, Person } from '../shared/types'
import type { ThreadDigest } from './memory'
import { describeAgent, MAX_ROUTED, REPLY_JSON, ROUTER_HISTORY, routerPrompt } from './router'

export const JEV_MODEL = 'jev' // the routerModel value that picks it
export const JEV_SECRET = 'typesafe:key'
const API = 'https://api.typesafe.ai/v1'
const NOBODY = '__ninguem' // can't clash with a handle: handles never start with "_"
const EVERYONE = '__todos'
const SECOND_AT = 0.3 // a second agent is called when the model gives it at least this
const TIMEOUT_MS = 10_000

type Fetch = typeof fetch

const noAnswer = (): string => L('o TypeSafe não respondeu', "TypeSafe didn't answer")
const badFormat = (): string => L('resposta do TypeSafe fora do formato', "TypeSafe's answer wasn't in the format")

function failure(status: number): string {
  if (status === 401 || status === 403) return L('a chave do TypeSafe não vale mais', 'the TypeSafe key is no longer valid')
  if (status === 429) return L('o TypeSafe pediu pra esperar (limite de uso)', 'TypeSafe asked to wait (usage limit)')
  return L(`o TypeSafe respondeu ${status}`, `TypeSafe answered ${status}`)
}

// Checks a key before it's saved.
export async function checkJevKey(key: string, f: Fetch = fetch): Promise<void> {
  let res: Response
  try {
    res = await f(`${API}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new Error(L('Não consegui falar com o TypeSafe. Confira a internet e tente de novo.', "I couldn't reach TypeSafe. Check the internet and try again."))
  }
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? L('O TypeSafe recusou essa chave.', 'TypeSafe refused that key.') : L(`O TypeSafe respondeu ${res.status}.`, `TypeSafe answered ${res.status}.`))
}

export async function routeJev(opts: {
  key: string
  messages: Message[]
  agents: Agent[]
  me: string
  people?: Pick<Person, 'id' | 'name'>[]
  connectors?: Connector[]
  thread?: Message
  threads?: ThreadDigest[]
  fetch?: Fetch
}): Promise<{ agents: Agent[]; reason: string; ms: number } | { error: string; ms: number }> {
  const started = Date.now()
  const ms = (): number => Date.now() - started
  const { agents } = opts
  // The same roster and conversation the CLI router reads, as the state; the agents are the options.
  const prompt = routerPrompt(opts)
  const state = prompt.endsWith(REPLY_JSON()) ? prompt.slice(0, -REPLY_JSON().length).trimEnd() : prompt
  const criteria: Record<string, string> = {}
  for (const a of agents) criteria[a.handle] = describeAgent(a, opts.connectors)
  criteria[EVERYONE] = L(
    'Todos: a mensagem é pro grupo todo (um cumprimento, "pessoal", uma pergunta pra todos, uma apresentação).',
    'Everyone: the message is for the whole group (a greeting, "everyone", a question for all, an introduction).'
  )
  criteria[NOBODY] = L(
    'Ninguém: a mensagem não pede nada a nenhum agente (agradecimento, recado, conversa já encerrada). Nunca um cumprimento.',
    "No one: the message asks nothing of any agent (a thank-you, a note, a conversation that's already over). Never a greeting."
  )

  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: {
          who: {
            type: 'choice',
            instructions: L(
              'Qual agente do canal deve responder à última mensagem humana? Se ela depende de um sistema externo (Linear, GitHub…), prefira quem tem acesso a ele; senão, escolha pelo papel.',
              'Which agent in the channel should answer the last human message? If it depends on an external system (Linear, GitHub…), prefer whoever has access to it; otherwise, choose by role.'
            ),
            criteria
          }
        }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return { error: noAnswer(), ms: ms() }
  }
  if (!res.ok) return { error: failure(res.status), ms: ms() }

  const body = (await res.json().catch(() => null)) as { answers?: { who?: { choice?: unknown; probabilities?: Record<string, number> } } } | null
  const who = body?.answers?.who
  if (typeof who?.choice !== 'string') return { error: badFormat(), ms: ms() }
  const probs = who.probabilities ?? {}
  const pct = (h: string): string => `${Math.round((probs[h] ?? 0) * 100)}%`
  if (who.choice === NOBODY) return { agents: [], reason: `Jev, ${pct(NOBODY)}`, ms: ms() }
  if (who.choice === EVERYONE) return { agents: [...agents], reason: `Jev, ${pct(EVERYONE)}`, ms: ms() }

  const first = agents.find((a) => a.handle === who.choice)
  if (!first) return { error: L('o TypeSafe escolheu alguém fora do canal', 'TypeSafe picked someone outside the channel'), ms: ms() }
  const second = agents
    .filter((a) => a !== first && (probs[a.handle] ?? 0) >= SECOND_AT)
    .sort((a, b) => (probs[b.handle] ?? 0) - (probs[a.handle] ?? 0))[0]
  const picked = [first, ...(second ? [second] : [])].slice(0, MAX_ROUTED)
  return { agents: picked, reason: `Jev, ${picked.map((a) => pct(a.handle)).join(L(' e ', ' and '))}`, ms: ms() }
}

// ---------- listening: the expensive agents ----------
// An agent in listen mode sits in the room and out of the roster: before the router picks, one
// cheap question says whether this message is about what that agent does, and whether the agents
// already there can handle it. Only then does it join — so the expensive model is paid for when
// the work calls for it, and not for every message in the room.
export const LISTEN_NONE = '__ninguem'
const LISTEN_YES = '__sim'
const LISTEN_NO = '__nao'

export async function listenJev(opts: {
  key: string
  messages: Message[]
  trigger: Message
  listeners: Agent[]
  answering: Agent[]
  me: string
  people?: Pick<Person, 'id' | 'name'>[]
  connectors?: Connector[]
  fetch?: Fetch
}): Promise<{ agents: Agent[]; reason: string; ms: number } | { error: string; ms: number }> {
  const started = Date.now()
  const ms = (): number => Date.now() - started
  const { listeners, answering, connectors = [] } = opts
  const everyone = [...listeners, ...answering]
  const name = (m: Message): string =>
    m.author.kind === 'person'
      ? (opts.people?.find((p) => m.author.kind === 'person' && p.id === m.author.id)?.name ?? opts.me)
      : m.author.kind === 'routine'
        ? L(`rotina de ${opts.me}`, `${opts.me}'s routine`)
        : (everyone.find((a) => m.author.kind === 'agent' && a.id === m.author.id)?.name ?? L('agente', 'agent'))
  const line = (m: Message): string => `[${name(m)}] ${m.text.replace(/\s+/g, ' ').trim().slice(0, 600)}`
  // The message that came in, then what was said before it, oldest first: the last line is the one
  // the question is about.
  const recent = opts.messages.filter((m) => !!m.text.trim() && m.author.kind !== 'system' && m.id !== opts.trigger.id).slice(-ROUTER_HISTORY)
  const state = [
    L('Agentes que escutam este canal (só entram quando a mensagem precisa do que só eles fazem):', 'Agents listening in this channel (they join only when the message needs what only they do):'),
    ...listeners.map((a) => `- ${a.handle}: ${describeAgent(a, connectors)}`),
    '',
    L('Agentes já no canal, que respondem sem ser chamados:', 'Agents already in the channel, who answer without being called:'),
    ...(answering.length ? answering.map((a) => `- ${a.handle}: ${describeAgent(a, connectors)}`) : [L('- ninguém', '- no one')]),
    '',
    L('Conversa (a última é a que acabou de chegar):', 'Conversation (the last one just arrived):'),
    ...recent.map(line),
    line(opts.trigger)
  ].join('\n')

  const criteria: Record<string, string> = {}
  for (const a of listeners) criteria[a.handle] = describeAgent(a, connectors)
  criteria[LISTEN_NONE] = L(
    'Ninguém: a mensagem não pede nada do que só um destes agentes faz, ou quem já está no canal resolve.',
    'No one: the message asks nothing of what only one of these agents does, or whoever is already in the channel handles it.'
  )

  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state,
        questions: {
          who: {
            type: 'choice',
            instructions: L(
              'Qual destes agentes, que estão só escutando, precisa entrar nesta mensagem? Escolha um só se o pedido exigir a especialidade, o modelo caro ou o acesso que só ele tem, e ninguém no canal der conta. Na dúvida, ninguém.',
              'Which of these agents, who are only listening, does this message need? Pick one only if the request needs the specialty, the expensive model or the access only that agent has, and no one in the channel can handle it. When in doubt, no one.'
            ),
            criteria
          },
          needed: {
            type: 'choice',
            instructions: L(
              'Quem já está no canal (ou ninguém) dá conta desta mensagem, sem o agente escolhido?',
              'Can whoever is already in the channel (or no one) handle this message, without the agent you picked?'
            ),
            criteria: {
              [LISTEN_YES]: L('Sim: os que estão no canal dão conta, ou a mensagem não pede trabalho.', 'Yes: whoever is in the channel handles it, or the message asks for no work.'),
              [LISTEN_NO]: L('Não: falta o que só o agente escolhido faz.', 'No: what only the agent you picked does is missing.')
            }
          }
        }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return { error: noAnswer(), ms: ms() }
  }
  if (!res.ok) return { error: failure(res.status), ms: ms() }

  const body = (await res.json().catch(() => null)) as {
    answers?: { who?: { choice?: unknown; probabilities?: Record<string, number> }; needed?: { choice?: unknown } }
  } | null
  const who = body?.answers?.who
  const needed = body?.answers?.needed
  if (typeof who?.choice !== 'string' || typeof needed?.choice !== 'string') return { error: badFormat(), ms: ms() }
  const pct = (h: string): string => `${Math.round((who?.probabilities?.[h] ?? 0) * 100)}%`
  const picked = listeners.find((a) => a.handle === who.choice)
  if (who.choice === LISTEN_NONE || !picked) return { agents: [], reason: '', ms: ms() }
  // It's the right agent for the subject, but the room can do without it: it stays out.
  if (needed.choice !== LISTEN_NO) return { agents: [], reason: L(`o ${picked.name} caberia, mas quem está no canal dá conta`, `${picked.name} would fit, but whoever is in the channel handles it`), ms: ms() }
  return { agents: [picked], reason: `${picked.name}, ${pct(picked.handle)}`, ms: ms() }
}

// ---------- the decisions an agent asks (ask_user) ----------
// A question can offer two or three ways forward and the person has to pick one. One cheap typed
// question per decision says which option Jev would pick, and the card shows it as a pill. It never
// picks for anybody: "none" is a real answer, for a choice that's the person's own.
export const RECOMMEND_NONE = '__nenhuma'
const RECOMMEND_TIMEOUT_MS = 8_000
const CONTEXT_MAX = 1_200

type Suggested = number | null

// One decision, one question. `state` is what the agent said, then the decision itself.
async function recommendOne(opts: { key: string; state: string; decision: Decision; fetch?: Fetch }): Promise<Suggested | { error: string }> {
  const options = opts.decision.options ?? []
  const criteria: Record<string, string> = {}
  options.forEach((o, j) => {
    criteria[`o${j}`] = o.description ? `${o.label} — ${o.description}` : o.label
  })
  criteria[RECOMMEND_NONE] = L(
    'Nenhuma: nenhuma opção é claramente melhor, ou a escolha é da própria pessoa (gosto, preferência, algo que só ela sabe).',
    "None: no option is clearly better, or the choice is the person's own (taste, preference, something only they know)."
  )
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state: opts.state,
        questions: {
          pick: {
            type: 'choice',
            instructions: L(
              'Qual opção desta decisão é a melhor pra pessoa escolher? Prefira o que a pergunta e o contexto apontam: o mais direto e o de menor risco. Se empatarem, ou se a escolha for da pessoa, escolha Nenhuma.',
              'Which option of this decision is the best for the person to pick? Prefer what the question and the context point to: the most direct, the lowest risk. If they tie, or the choice is the person\'s own, pick None.'
            ),
            criteria
          }
        }
      }),
      signal: AbortSignal.timeout(RECOMMEND_TIMEOUT_MS)
    })
  } catch {
    return { error: noAnswer() }
  }
  if (!res.ok) return { error: failure(res.status) }
  const body = (await res.json().catch(() => null)) as { answers?: { pick?: { choice?: unknown } } } | null
  const choice = body?.answers?.pick?.choice
  if (typeof choice !== 'string') return { error: badFormat() }
  if (choice === RECOMMEND_NONE) return null
  const j = options.findIndex((_, i) => choice === `o${i}`)
  return j >= 0 ? j : { error: L('o TypeSafe escolheu uma opção que não existe', "TypeSafe picked an option that doesn't exist") }
}

// One pick per decision, in the order asked: an index into its options, or null. Decisions with a
// single option (or none: a text answer) are skipped without a call — they have nothing to pick
// between, and the card's own "Something else" row is never one of them.
export async function recommendOptions(opts: {
  key: string
  questions: Decision[]
  context?: string
  fetch?: Fetch
}): Promise<{ picks: Suggested[]; ms: number } | { error: string; ms: number }> {
  const started = Date.now()
  const ms = (): number => Date.now() - started
  const worth = opts.questions.map((q) => (q.options?.length ?? 0) >= 2)
  if (!worth.some(Boolean)) return { picks: opts.questions.map(() => null), ms: ms() }
  const context = (opts.context ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_MAX)
  const picks = await Promise.all(
    opts.questions.map((decision, i) => {
      if (!worth[i]) return Promise.resolve(null as Suggested)
      const options = (decision.options ?? []).map((o, j) => `${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ''}`).join('\n')
      const state = [
        ...(context ? [L('O que o agente disse antes da pergunta:', 'What the agent said before asking:'), context, ''] : []),
        L('A pergunta:', 'The question:'),
        decision.question,
        '',
        L('As opções:', 'The options:'),
        options
      ].join('\n')
      return recommendOne({ key: opts.key, state, decision, fetch: opts.fetch })
    })
  )
  const problem = picks.find((p): p is { error: string } => !!p && typeof p === 'object')
  if (problem) return { error: problem.error, ms: ms() }
  return { picks: picks as Suggested[], ms: ms() }
}

// ---------- the browser (spec §24) ----------
// The agent says what to click in words; Jev finds it on the page. First among
// the page's elements (a Choice over their labels), and, when none fits, on the
// screen itself (a Box over the screenshot: still experimental at TypeSafe).

export interface PageElement {
  ref: number
  role: string
  label: string
  value?: string
  inView: boolean
}

const NONE = '__nenhum'
const BROWSER_TIMEOUT_MS = 8_000

const describe = (e: PageElement): string =>
  `${e.role}${e.label ? ` "${e.label}"` : L(' sem nome', ' without a name')}${e.value ? L(`, valor "${e.value}"`, `, value "${e.value}"`) : ''}${e.inView ? '' : L(' (fora da tela)', ' (off screen)')}`

export async function jevElement(opts: {
  key: string
  target: string
  page: { url: string; title: string }
  elements: PageElement[]
  fetch?: Fetch
}): Promise<{ ref: number; p: number } | { error: string }> {
  const criteria: Record<string, string> = {}
  for (const e of opts.elements) criteria[`e${e.ref}`] = describe(e)
  criteria[NONE] = L('Nenhum destes elementos é o que foi pedido.', 'None of these elements is what was asked for.')
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state: { pagina: opts.page.title, endereco: opts.page.url, pedido: opts.target },
        questions: {
          alvo: { type: 'choice', instructions: L('Qual elemento da página é o `pedido`? Prefira os que estão na tela.', 'Which element of the page is the `pedido`? Prefer the ones on screen.'), criteria }
        }
      }),
      signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS)
    })
  } catch {
    return { error: noAnswer() }
  }
  if (!res.ok) return { error: failure(res.status) }
  const body = (await res.json().catch(() => null)) as { answers?: { alvo?: { choice?: unknown; probabilities?: Record<string, number> } } } | null
  const choice = body?.answers?.alvo?.choice
  if (typeof choice !== 'string') return { error: badFormat() }
  if (choice === NONE) return { error: L('nenhum elemento da página bate', 'no element on the page matches') }
  const ref = Number(choice.slice(1))
  if (!opts.elements.some((e) => e.ref === ref)) return { error: L('o TypeSafe escolheu um elemento que não existe', "TypeSafe picked an element that doesn't exist") }
  return { ref, p: body?.answers?.alvo?.probabilities?.[choice] ?? 0 }
}

// Where on the screenshot the target is, as fractions of its width and height.
export async function jevBox(opts: { key: string; target: string; jpeg: string; fetch?: Fetch }): Promise<{ x: number; y: number; confidence: number } | { error: string }> {
  const ref = `tela-${randomUUID()}`
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json', 'TypeSafe-Danger-Zone-Images': 'true' },
      body: JSON.stringify({
        model: 'jev-preview',
        state: { tela: ref },
        assets: { [ref]: { type: 'image', format: 'jpg', data_base64: opts.jpeg } },
        questions: { alvo: { type: 'box', instructions: L(`${opts.target}, em \`tela\` (um print de página web)`, `${opts.target}, in \`tela\` (a screenshot of a web page)`) } }
      }),
      signal: AbortSignal.timeout(BROWSER_TIMEOUT_MS)
    })
  } catch {
    return { error: noAnswer() }
  }
  if (!res.ok) return { error: failure(res.status) }
  const body = (await res.json().catch(() => null)) as { answers?: { alvo?: { box?: { top: number; bottom: number; left: number; right: number }; confidence?: number } } } | null
  const box = body?.answers?.alvo?.box
  if (!box || ![box.top, box.bottom, box.left, box.right].every((n) => typeof n === 'number')) return { error: badFormat() }
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, confidence: body?.answers?.alvo?.confidence ?? 0 }
}
