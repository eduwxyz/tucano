// Jev, TypeSafe's decision model, as an optional router (spec §2): it answers
// "who replies?" as a typed choice in well under a second, where a CLI turn
// takes several. It can't write a plan in one answer, so it builds the same
// plan the CLI router does by asking again for each layer: one question per
// layer, the state of the next one naming who is already answering. It needs
// the user's own TypeSafe key, and each decision sends the channel's recent
// messages to TypeSafe, so it's off unless chosen.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import type { Agent, Connector, Message } from '../shared/types'
import type { ThreadDigest } from './memory'
import { describeAgent, MAX_LAYERS, MAX_PLANNED, REPLY_JSON, routerPrompt, type TurnPlan } from './router'

export const JEV_MODEL = 'jev' // the routerModel value that picks it
export const JEV_SECRET = 'typesafe:key'
const API = 'https://api.typesafe.ai/v1'
const NOBODY = '__ninguem' // can't clash with a handle: handles never start with "_"
const EVERYONE = '__todos'
const DONE = '__encerrar' // "no one else", any later layer's way out
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

// One typed choice against TypeSafe: the same question name every round, so the
// caller only cares about the answer.
async function choose(opts: { key: string; state: string; instructions: string; criteria: Record<string, string>; fetch?: Fetch }): Promise<{ choice: string; probabilities: Record<string, number> } | { error: string }> {
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(`${API}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state: opts.state,
        questions: { who: { type: 'choice', instructions: opts.instructions, criteria: opts.criteria } }
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch {
    return { error: noAnswer() }
  }
  if (!res.ok) return { error: failure(res.status) }
  const body = (await res.json().catch(() => null)) as { answers?: { who?: { choice?: unknown; probabilities?: Record<string, number> } } } | null
  const who = body?.answers?.who
  if (typeof who?.choice !== 'string') return { error: badFormat() }
  return { choice: who.choice, probabilities: who.probabilities ?? {} }
}

export async function routeJev(opts: {
  key: string
  messages: Message[]
  agents: Agent[]
  me: string
  connectors?: Connector[]
  thread?: Message
  threads?: ThreadDigest[]
  fetch?: Fetch
}): Promise<{ plan: TurnPlan; reason: string; ms: number } | { error: string; ms: number }> {
  const started = Date.now()
  const ms = (): number => Date.now() - started
  const { agents } = opts
  // The same roster and conversation the CLI router reads, as the state; the agents are the options.
  const prompt = routerPrompt(opts)
  const state = prompt.endsWith(REPLY_JSON()) ? prompt.slice(0, -REPLY_JSON().length).trimEnd() : prompt
  const and = L(' e ', ' and ')

  const plan: TurnPlan = []
  const why: string[] = []
  let speaking: Agent[] = []
  let total = 0
  // One question per layer: the first one picks who answers now, the next asks who still needs to,
  // knowing who is already answering. The last layer is the one whose answer ends the plan.
  for (let layer = 0; layer < MAX_LAYERS && total < MAX_PLANNED; layer++) {
    const rest = agents.filter((a) => !speaking.includes(a))
    if (!rest.length) break
    const criteria: Record<string, string> = {}
    for (const a of rest) criteria[a.handle] = describeAgent(a, opts.connectors)
    if (layer === 0) {
      criteria[EVERYONE] = L(
        'Todos: a mensagem é pro grupo todo (um cumprimento, "pessoal", uma pergunta pra todos, uma apresentação).',
        'Everyone: the message is for the whole group (a greeting, "everyone", a question for all, an introduction).'
      )
      criteria[NOBODY] = L(
        'Ninguém: a mensagem não pede nada a nenhum agente (agradecimento, recado, conversa já encerrada). Nunca um cumprimento.',
        "No one: the message asks nothing of any agent (a thank-you, a note, a conversation that's already over). Never a greeting."
      )
    } else {
      criteria[DONE] = L(
        `Ninguém mais: ${speaking.map((a) => a.name).join(and)} resolvem a mensagem, ninguém precisa responder depois deles.`,
        `No one else: ${speaking.map((a) => a.name).join(and)} settle the message, no one needs to answer after them.`
      )
    }
    const asked = await choose({
      key: opts.key,
      state: layer === 0 ? state : `${state}\n\n${L(`Vão responder agora: ${speaking.map((a) => a.name).join(and)}.`, `Answering now: ${speaking.map((a) => a.name).join(and)}.`)}`,
      instructions:
        layer === 0
          ? L(
              'Qual agente do canal deve responder à última mensagem humana? Se ela depende de um sistema externo (Linear, GitHub…), prefira quem tem acesso a ele; senão, escolha pelo papel.',
              'Which agent in the channel should answer the last human message? If it depends on an external system (Linear, GitHub…), prefer whoever has access to it; otherwise, choose by role.'
            )
          : L(
              'Depois de quem já vai responder, quem mais precisa responder à última mensagem humana? Só quem precisa do que eles escreverem (um localiza e o outro escreve, um decide e o outro faz). Se a mensagem já está resolvida, escolha "Ninguém mais".',
              'After whoever is already answering, who else needs to answer the last human message? Only whoever needs what they write (one finds and the other writes, one decides and the other does). If the message is already settled, choose "No one else".'
            ),
      criteria,
      fetch: opts.fetch
    })
    if ('error' in asked) return { error: asked.error, ms: ms() }
    const { choice, probabilities: probs } = asked
    const pct = (h: string): string => `${Math.round((probs[h] ?? 0) * 100)}%`
    if (choice === NOBODY) return { plan: [], reason: `Jev, ${pct(NOBODY)}`, ms: ms() }
    if (choice === EVERYONE) return { plan: [[...agents]], reason: `Jev, ${pct(EVERYONE)}`, ms: ms() }
    if (choice === DONE) break
    const first = rest.find((a) => a.handle === choice)
    if (!first) return { error: L('o TypeSafe escolheu alguém fora do canal', 'TypeSafe picked someone outside the channel'), ms: ms() }
    const second = rest
      .filter((a) => a !== first && (probs[a.handle] ?? 0) >= SECOND_AT)
      .sort((a, b) => (probs[b.handle] ?? 0) - (probs[a.handle] ?? 0))[0]
    // Nobody speaks twice, and the plan never grows past the ceiling.
    const picked = [first, ...(second ? [second] : [])].slice(0, MAX_PLANNED - total)
    plan.push(picked)
    speaking = [...speaking, ...picked]
    total += picked.length
    why.push(picked.map((a) => pct(a.handle)).join(and))
  }
  const reason = why.length ? `Jev, ${why.join(L(' · depois ', ' · then '))}` : `Jev, ${L('ninguém', 'no one')}`
  return { plan, reason, ms: ms() }
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
