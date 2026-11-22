// A classifier as the router (spec §2): it answers "who replies?" as a typed choice in well under a
// second, where a CLI turn takes several. Which model pair does it is the person's choice in
// Settings › Classifiers (src/shared/classifiers.ts); this file writes the questions, and each
// decision sends the channel's recent messages to that provider, so it's off unless chosen.
import { randomUUID } from 'node:crypto'
import type { ClassifierConfig } from '../shared/classifiers'
import { JEV_CLASSIFIER, providerSpec } from '../shared/classifiers'
import { L } from '../shared/lang'
import type { Agent, Connector, Message, Person } from '../shared/types'
import { ask, badFormat, checkClassifierKey, failure, noAnswer, type ClassifierAnswers, type ClassifierQuestion } from './classifiers'
import type { ThreadDigest } from './memory'
import { describeAgent, MAX_ROUTED, REPLY_JSON, routerPrompt } from './router'

export const JEV_MODEL = 'jev' // the routerModel value that picks the routing classifier
export const JEV_SECRET = 'typesafe:key' // the key an install from before Settings › Classifiers saved
const API = 'https://api.typesafe.ai/v1'
const NOBODY = '__ninguem' // can't clash with a handle: handles never start with "_"
const EVERYONE = '__todos'
const SECOND_AT = 0.3 // a second agent is called when the model gives it at least this
const TIMEOUT_MS = 10_000

type Fetch = typeof fetch

// The classifier a call runs on: the one chosen for that job, or Jev, as before the section existed.
const targetOf = (t?: ClassifierConfig): ClassifierConfig => t ?? JEV_CLASSIFIER

// "o TypeSafe", "OpenRouter": the provider as it reads mid-sentence.
const inSentence = (t: ClassifierConfig): { pt: string; en: string } =>
  t.provider === 'typesafe' ? { pt: 'o TypeSafe', en: 'TypeSafe' } : { pt: providerSpec(t.provider).label, en: providerSpec(t.provider).label }

const failed = (a: ClassifierAnswers | { error: string }): a is { error: string } => typeof (a as { error?: unknown }).error === 'string'

// Checks a key before it's saved: Jev's own check, for an install that still has only that one.
export async function checkJevKey(key: string, f: Fetch = fetch): Promise<void> {
  return checkClassifierKey(JEV_CLASSIFIER, key, f)
}

export async function routeJev(opts: {
  key: string
  target?: ClassifierConfig
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
  const target = targetOf(opts.target)
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

  const questions: ClassifierQuestion[] = [
    {
      name: 'who',
      type: 'choice',
      instructions: L(
        'Qual agente do canal deve responder à última mensagem humana? Se ela depende de um sistema externo (Linear, GitHub…), prefira quem tem acesso a ele; senão, escolha pelo papel.',
        'Which agent in the channel should answer the last human message? If it depends on an external system (Linear, GitHub…), prefer whoever has access to it; otherwise, choose by role.'
      ),
      criteria
    }
  ]
  const answers = await ask({ target, key: opts.key, state, questions, timeoutMs: TIMEOUT_MS, fetch: opts.fetch })
  if (failed(answers)) return { error: answers.error, ms: ms() }

  const who = answers['who']
  if (typeof who?.choice !== 'string') return { error: badFormat(target.provider), ms: ms() }
  const probs = who.probabilities ?? {}
  const pct = (h: string): string => `${Math.round((probs[h] ?? 0) * 100)}%`
  if (who.choice === NOBODY) return { agents: [], reason: `${target.name}, ${pct(NOBODY)}`, ms: ms() }
  if (who.choice === EVERYONE) return { agents: [...agents], reason: `${target.name}, ${pct(EVERYONE)}`, ms: ms() }

  const first = agents.find((a) => a.handle === who.choice)
  if (!first) return { error: L(`${inSentence(target).pt} escolheu alguém fora do canal`, `${inSentence(target).en} picked someone outside the channel`), ms: ms() }
  const second = agents
    .filter((a) => a !== first && (probs[a.handle] ?? 0) >= SECOND_AT)
    .sort((a, b) => (probs[b.handle] ?? 0) - (probs[a.handle] ?? 0))[0]
  const picked = [first, ...(second ? [second] : [])].slice(0, MAX_ROUTED)
  return { agents: picked, reason: `${target.name}, ${picked.map((a) => pct(a.handle)).join(L(' e ', ' and '))}`, ms: ms() }
}

// ---------- the browser (spec §24) ----------
// The agent says what to click in words; the classifier finds it on the page. First among the
// page's elements (a choice over their labels), and, when none fits, on the screen itself: a Box
// over the screenshot, which only TypeSafe reads.

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
  target: string // what the agent asked for, in words
  classifier?: ClassifierConfig // the model pair that looks; Jev when unset
  page: { url: string; title: string }
  elements: PageElement[]
  fetch?: Fetch
}): Promise<{ ref: number; p: number } | { error: string }> {
  const classifier = targetOf(opts.classifier)
  const criteria: Record<string, string> = {}
  for (const e of opts.elements) criteria[`e${e.ref}`] = describe(e)
  criteria[NONE] = L('Nenhum destes elementos é o que foi pedido.', 'None of these elements is what was asked for.')
  const questions: ClassifierQuestion[] = [
    {
      name: 'alvo',
      type: 'choice',
      instructions: L('Qual elemento da página é o `pedido`? Prefira os que estão na tela.', 'Which element of the page is the `pedido`? Prefer the ones on screen.'),
      criteria
    }
  ]
  const answers = await ask({ target: classifier, key: opts.key, state: { pagina: opts.page.title, endereco: opts.page.url, pedido: opts.target }, questions, timeoutMs: BROWSER_TIMEOUT_MS, fetch: opts.fetch })
  if (failed(answers)) return { error: answers.error }
  const answer = answers['alvo']
  const choice = answer?.choice
  if (typeof choice !== 'string') return { error: badFormat(classifier.provider) }
  if (choice === NONE) return { error: L('nenhum elemento da página bate', 'no element on the page matches') }
  const ref = Number(choice.slice(1))
  if (!opts.elements.some((e) => e.ref === ref))
    return { error: L(`${inSentence(classifier).pt} escolheu um elemento que não existe`, `${inSentence(classifier).en} picked an element that doesn't exist`) }
  return { ref, p: answer?.probabilities?.[choice] ?? 0 }
}

// Where on the screenshot the target is, as fractions of its width and height. Only TypeSafe reads
// a screenshot, so another classifier says so and the browser stays with the page's own text.
export async function jevBox(opts: {
  key: string
  target: string // what the agent asked for, in words
  classifier?: ClassifierConfig
  jpeg: string
  fetch?: Fetch
}): Promise<{ x: number; y: number; confidence: number } | { error: string }> {
  const classifier = targetOf(opts.classifier)
  if (!providerSpec(classifier.provider).box)
    return { error: L(`${providerSpec(classifier.provider).label} não acha no print da tela`, `${providerSpec(classifier.provider).label} doesn't find things in a screenshot`) }
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
    return { error: noAnswer('typesafe') }
  }
  if (!res.ok) return { error: failure(res.status, 'typesafe') }
  const body = (await res.json().catch(() => null)) as { answers?: { alvo?: { box?: { top: number; bottom: number; left: number; right: number }; confidence?: number } } } | null
  const box = body?.answers?.alvo?.box
  if (!box || ![box.top, box.bottom, box.left, box.right].every((n) => typeof n === 'number')) return { error: badFormat('typesafe') }
  return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2, confidence: body?.answers?.alvo?.confidence ?? 0 }
}
