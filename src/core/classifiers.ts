// One question shape, four providers. Everything in the app that wants a decision ("who replies?",
// "which element did they mean?") asks here in the same words, and this module writes the request
// each provider expects and reads its answer back into the same shape. That is the whole point of
// the Classifiers section: the job is written once, the model pair behind it is the person's choice.
//
// Providers, as they stand today:
// - TypeSafe      POST https://api.typesafe.ai/v1/systemone              { model, state, questions: { id: { type, instructions, criteria } } }
// - OpenRouter    POST https://openrouter.ai/api/v1/systemone            the same body, model typesafe/jev-1.13
// - OpenAI        POST https://api.openai.com/v1/decisions               { model, input, questions: [ { type, name, instructions, choices|levels } ] }
// - Google        POST https://generativelanguage.googleapis.com/v1beta/decisions  { model, input, questions: { id: { type, instructions, criteria } } }
// TypeSafe and OpenRouter answer under the question ids; OpenAI answers an array in question order.
import { L } from '../shared/lang'
import type { ClassifierConfig, ClassifierProvider } from '../shared/classifiers'
import { providerSpec } from '../shared/classifiers'

type Fetch = typeof fetch

// The one question shape: a choice among options (criteria: option → when it applies), a yes/no
// (criteria: true/false descriptions), or a score on ordered levels (criteria: levels, low to high).
export interface ClassifierQuestion {
  name: string
  type: 'choice' | 'yesno' | 'score'
  instructions: string
  criteria?: Record<string, string> | string[]
}

export interface ClassifierAnswer {
  choice?: string
  probability?: number // a yes/no: how likely the answer is yes
  score?: number // a position on the levels, between 0 and the top level
  probabilities?: Record<string, number>
}

export type ClassifierAnswers = Record<string, ClassifierAnswer>

export const API: Record<ClassifierProvider, string> = {
  typesafe: 'https://api.typesafe.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta'
}

// The vendor as it reads in a sentence: TypeSafe, OpenRouter, OpenAI, Google.
const vendorOf = (p: ClassifierProvider): string => providerSpec(p).label

export const noAnswer = (p: ClassifierProvider): string => L(`o ${vendorOf(p)} não respondeu`, `${vendorOf(p)} didn't answer`)

export const badFormat = (p: ClassifierProvider): string =>
  L(`resposta do ${vendorOf(p)} fora do formato`, `${vendorOf(p)}'s answer wasn't in the format`)

export function failure(status: number, p: ClassifierProvider): string {
  const v = vendorOf(p)
  if (status === 401 || status === 403) return L(`a chave do ${v} não vale mais`, `the ${v} key is no longer valid`)
  if (status === 429) return L(`o ${v} pediu pra esperar (limite de uso)`, `${v} asked to wait (usage limit)`)
  return L(`o ${v} respondeu ${status}`, `${v} answered ${status}`)
}

// The secret store key of a classifier's own key: one per classifier, so two Jevs on two accounts
// (a work TypeSafe and a personal one) don't share it.
export const classifierSecret = (id: string): string => `classifier:${id}:key`

// ---------- the request, per provider ----------

type Request = { url: string; headers: Record<string, string>; payload: unknown }

// State is what the questions are about. TypeSafe and OpenRouter take it as text or JSON;
// OpenAI and Google want a string, so an object goes in as JSON text.
const asText = (state: unknown): string => (typeof state === 'string' ? state : JSON.stringify(state))

const asMap = (questions: ClassifierQuestion[]): Record<string, unknown> =>
  Object.fromEntries(
    questions.map((q) => [
      q.name,
      {
        type: q.type === 'yesno' ? 'noul' : q.type,
        instructions: q.instructions,
        ...(q.criteria ? { criteria: q.criteria } : {})
      }
    ])
  )

// OpenAI's questions are an array, its choices and levels are lists of objects, and a yes/no has no
// criteria field at all: what true and false mean goes into the question itself.
const asOpenAiQuestions = (questions: ClassifierQuestion[]): unknown[] =>
  questions.map((q) => {
    if (q.type === 'choice') {
      const criteria = (q.criteria ?? {}) as Record<string, string>
      return { type: 'choice', name: q.name, instructions: q.instructions, choices: Object.entries(criteria).map(([value, description]) => ({ value, description })) }
    }
    if (q.type === 'score') {
      const levels = Array.isArray(q.criteria) ? q.criteria : Object.values((q.criteria ?? {}) as Record<string, string>)
      return { type: 'score', name: q.name, instructions: q.instructions, levels: levels.map((label) => ({ label })) }
    }
    const criteria = (q.criteria ?? {}) as Record<string, string>
    const said = [criteria['true_description'], criteria['false_description']].filter(Boolean)
    return {
      type: 'predicate',
      name: q.name,
      instructions: said.length ? `${q.instructions} ${L('Vale sim quando:', 'Yes when:')} ${said[0]} ${L('Não quando:', 'No when:')} ${said[1]}` : q.instructions
    }
  })

function request(target: ClassifierConfig, key: string, state: unknown, questions: ClassifierQuestion[]): Request {
  const spec = providerSpec(target.provider)
  const model = target.model || spec.model
  if (target.provider === 'openai') {
    return {
      url: `${API.openai}/decisions`,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      payload: { model, input: asText(state), questions: asOpenAiQuestions(questions) }
    }
  }
  if (target.provider === 'gemini') {
    return {
      url: `${API.gemini}/decisions`,
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      payload: { model, input: asText(state), questions: asMap(questions) }
    }
  }
  // TypeSafe, and OpenRouter's mirror of it: the same body, a different base URL.
  return {
    url: `${API[target.provider]}/systemone`,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    payload: { model, state, questions: asMap(questions) }
  }
}

// ---------- the answer, per provider ----------

type RawAnswer = { type?: string; name?: string | null; choice?: unknown; noul?: unknown; probability?: unknown; score?: unknown; probabilities?: unknown }

const probabilitiesOf = (raw: unknown): Record<string, number> | undefined => {
  if (!raw) return undefined
  // TypeSafe, OpenRouter and Google: { option: probability }. OpenAI: [ { value, probability } ].
  if (Array.isArray(raw)) {
    const out: Record<string, number> = {}
    for (const e of raw as { value?: unknown; probability?: unknown }[]) if (typeof e.value === 'string' && typeof e.probability === 'number') out[e.value] = e.probability
    return Object.keys(out).length ? out : undefined
  }
  if (typeof raw !== 'object') return undefined
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'number') out[k] = v
  return Object.keys(out).length ? out : undefined
}

const answerOf = (raw: RawAnswer): ClassifierAnswer => ({
  ...(typeof raw.choice === 'string' ? { choice: raw.choice } : {}),
  ...(typeof raw.noul === 'number' ? { probability: raw.noul } : typeof raw.probability === 'number' ? { probability: raw.probability } : {}),
  ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
  ...(probabilitiesOf(raw.probabilities) ? { probabilities: probabilitiesOf(raw.probabilities)! } : {})
})

// ---------- the one call ----------

export async function ask(opts: {
  target: ClassifierConfig
  key: string
  state: unknown
  questions: ClassifierQuestion[]
  timeoutMs: number
  fetch?: Fetch
  signal?: AbortSignal // the caller's own deadline, when it has one; the timeout still applies
}): Promise<ClassifierAnswers | { error: string }> {
  const { target } = opts
  const req = request(target, opts.key, opts.state, opts.questions)
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout
  let res: Response
  try {
    res = await (opts.fetch ?? fetch)(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.payload), signal })
  } catch {
    return { error: noAnswer(target.provider) }
  }
  if (!res.ok) return { error: failure(res.status, target.provider) }
  const body = (await res.json().catch(() => null)) as { answers?: unknown } | null
  const answers = body?.answers
  if (!answers) return { error: badFormat(target.provider) }
  const out: ClassifierAnswers = {}
  if (Array.isArray(answers)) {
    // OpenAI: one answer per question, in the order asked, each carrying its name.
    for (const raw of answers as RawAnswer[]) if (typeof raw.name === 'string') out[raw.name] = answerOf(raw)
  } else if (typeof answers === 'object') {
    for (const [name, raw] of Object.entries(answers as Record<string, RawAnswer>)) out[name] = answerOf(raw ?? {})
  }
  return Object.keys(out).length ? out : { error: badFormat(target.provider) }
}

// ---------- checking a key before it's saved ----------

// Each provider has one cheap call that says whether the key works: its own key or model listing.
export async function checkClassifierKey(target: ClassifierConfig, key: string, f: Fetch = fetch): Promise<void> {
  const spec = providerSpec(target.provider)
  const v = spec.label
  const url =
    target.provider === 'typesafe'
      ? `${API.typesafe}/models`
      : target.provider === 'openrouter'
        ? `${API.openrouter}/key`
        : target.provider === 'openai'
          ? `${API.openai}/models`
          : `${API.gemini}/models`
  const headers: Record<string, string> = target.provider === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` }
  const typesafe = target.provider === 'typesafe'
  let res: Response
  try {
    res = await f(url, { headers, signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new Error(
      typesafe
        ? L('Não consegui falar com o TypeSafe. Confira a internet e tente de novo.', "I couldn't reach TypeSafe. Check the internet and try again.")
        : L(`Não consegui falar com ${v}. Confira a internet e tente de novo.`, `I couldn't reach ${v}. Check the internet and try again.`)
    )
  }
  if (!res.ok) {
    // TypeSafe keeps the wording the app has used since it was the only classifier.
    if (typesafe) throw new Error(res.status === 401 || res.status === 403 ? L('O TypeSafe recusou essa chave.', 'TypeSafe refused that key.') : L(`O TypeSafe respondeu ${res.status}.`, `TypeSafe answered ${res.status}.`))
    throw new Error(res.status === 401 || res.status === 403 ? L(`${v} recusou essa chave.`, `${v} refused that key.`) : L(`${v} respondeu ${res.status}.`, `${v} answered ${res.status}.`))
  }
}
