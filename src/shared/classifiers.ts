// A classifier is a model that answers typed questions about a piece of text: one option out of a
// fixed set, a yes or no, a position on a scale. It never writes a sentence, so it answers in a few
// hundred milliseconds and hands back a probability for every option, which is what a decision made
// in code needs. TypeSafe's Jev was the first one Tucano used; the same job is done by OpenAI's
// Luna (Decisions API), Google's Gemini Decision 1, and Jev itself through OpenRouter.
//
// One classifier is chosen per job (src/shared/classifiers.ts `ClassifierJob`): who replies in a
// channel, and what an agent should click in a page.
import { L } from './lang'
import type { Settings } from './types'

export type ClassifierProvider = 'typesafe' | 'openrouter' | 'openai' | 'gemini'

// Where a classifier is used. A job has at most one classifier, and unassigned means off.
export type ClassifierJob = 'routing' | 'browser'

export interface ClassifierConfig {
  id: string
  name: string
  provider: ClassifierProvider
  model: string
}

export interface ProviderSpec {
  provider: ClassifierProvider
  label: string // the vendor, as the person knows it
  defaultName: string // what a new classifier of this provider is called until the person renames it
  model: string // the model a new classifier of this provider starts with
  models: string[] // the ones worth offering, the default first
  box: boolean // can find a place on a screenshot (only TypeSafe does)
  keyHint: () => string
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    provider: 'typesafe',
    label: 'TypeSafe',
    defaultName: 'Jev',
    model: 'jev-latest',
    models: ['jev-latest', 'jev-1.14.0', 'jev-1.13.0'],
    box: true,
    keyHint: () => L('A chave do console do TypeSafe. Também acha o elemento pelo print da tela.', 'The key from the TypeSafe console. It also finds an element from the screenshot.')
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    defaultName: 'Jev (OpenRouter)',
    model: 'typesafe/jev-1.13',
    models: ['typesafe/jev-1.13'],
    box: false,
    keyHint: () => L('A chave do OpenRouter serve para o Jev, cobrado na mesma fatura dos outros modelos.', 'An OpenRouter key serves Jev, billed on the same invoice as the other models.')
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    defaultName: 'Luna',
    model: 'gpt-6-luna',
    models: ['gpt-6-luna'],
    box: false,
    keyHint: () => L('A chave da OpenAI, com a Decisions API liberada na organização.', 'The OpenAI key, with the Decisions API enabled for the organization.')
  },
  {
    provider: 'gemini',
    label: 'Google',
    defaultName: 'Gemini Decision',
    model: 'gemini-decision-1',
    models: ['gemini-decision-1'],
    box: false,
    keyHint: () => L('A chave do Google AI Studio, com a Decisions API liberada.', 'The Google AI Studio key, with the Decisions API enabled.')
  }
]

export const providerSpec = (p: ClassifierProvider): ProviderSpec => PROVIDERS.find((s) => s.provider === p) ?? PROVIDERS[0]!

// The classifier an install from before this section had: one TypeSafe Jev.
export const JEV_CLASSIFIER: ClassifierConfig = { id: 'jev', name: 'Jev', provider: 'typesafe', model: 'jev-latest' }

const MAX_CLASSIFIERS = 20

// The jobs the Classifier Uses card offers, one selector each.
export const CLASSIFIER_JOBS: readonly ClassifierJob[] = ['routing', 'browser']

export const jobLabel = (job: ClassifierJob): string =>
  job === 'routing' ? L('Quem responde no canal', 'Who replies in a channel') : L('O que o agente clica na página', 'What an agent clicks in a page')

export const jobAbout = (job: ClassifierJob): string =>
  job === 'routing'
    ? L(
        'Lê a conversa e escolhe quem responde, no lugar do modelo pequeno do roteador.',
        'Reads the conversation and picks who replies, in place of the router’s small model.'
      )
    : L(
        'Acha o elemento que o agente pediu (“o botão Buscar”). O print da tela, que resolve os casos sem texto, só o TypeSafe lê.',
        'Finds the element the agent asked for (“the Search button”). The screenshot, which handles the cases without text, only TypeSafe reads.'
      )

type ClassifierSettings = Pick<Settings, 'classifiers' | 'classifierJobs' | 'jevKey' | 'routerModel' | 'browserJev'>

// What is configured. An install from before the section has no list: it had one Jev, if it was
// ever switched on anywhere, and that is what it keeps.
export function classifierList(s: ClassifierSettings): ClassifierConfig[] {
  if (s.classifiers) return s.classifiers
  const used = !!s.jevKey || s.routerModel === 'jev' || !!s.browserJev
  return used ? [{ ...JEV_CLASSIFIER }] : []
}

// Which classifier serves each job. The old switches become job assignments once, on the way in —
// and only to a classifier that is in the list, so a row deleted from it never leaves a job pointing
// at nothing.
export function classifierJobsOf(s: ClassifierSettings): Partial<Record<ClassifierJob, string>> {
  if (s.classifierJobs) return s.classifierJobs
  const known = classifierList(s).some((c) => c.id === JEV_CLASSIFIER.id)
  const jobs: Partial<Record<ClassifierJob, string>> = {}
  if (known && s.routerModel === 'jev') jobs.routing = JEV_CLASSIFIER.id
  if (known && s.browserJev) jobs.browser = JEV_CLASSIFIER.id
  return jobs
}

// The classifier a job runs on, or undefined when the job is off.
export function classifierFor(s: ClassifierSettings, job: ClassifierJob): ClassifierConfig | undefined {
  const id = classifierJobsOf(s)[job]
  return id ? classifierList(s).find((c) => c.id === id) : undefined
}

// A settings patch's rows, checked: real providers, sane text, no id twice. A row keeps the provider
// it was saved with, because its key was checked against that provider and must never be sent to
// another one by editing the row.
export function cleanClassifiers(raw: unknown, before: readonly ClassifierConfig[]): ClassifierConfig[] {
  if (!Array.isArray(raw) || raw.length > MAX_CLASSIFIERS) throw new Error('Invalid classifiers')
  const seen = new Set<string>()
  return raw.map((row: unknown) => {
    const { id, name, provider, model } = (row ?? {}) as Record<string, unknown>
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id) || seen.has(id)) throw new Error('Invalid classifier id')
    if (!PROVIDERS.some((p) => p.provider === provider)) throw new Error('Invalid classifier provider')
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid classifier name')
    if (typeof model !== 'string' || !model.trim() || model.length > 120) throw new Error('Invalid classifier model')
    const saved = before.find((c) => c.id === id)
    if (saved && saved.provider !== provider) throw new Error('A classifier keeps its provider')
    seen.add(id)
    return { id, name: name.trim(), provider: provider as ClassifierProvider, model: model.trim() }
  })
}

// Only the jobs that exist, each pointing at a row the list holds.
export function cleanClassifierJobs(raw: unknown, list: readonly ClassifierConfig[]): Partial<Record<ClassifierJob, string>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid classifier jobs')
  const jobs: Partial<Record<ClassifierJob, string>> = {}
  for (const job of CLASSIFIER_JOBS) {
    const id = (raw as Record<string, unknown>)[job]
    if (typeof id === 'string' && list.some((c) => c.id === id)) jobs[job] = id
  }
  return jobs
}

// A row's name, with the provider's when the person renamed it to something of their own.
export function classifierLabel(c: ClassifierConfig): string {
  const spec = providerSpec(c.provider)
  return c.name === spec.label ? `${spec.label} · ${c.model}` : `${c.name} · ${spec.label}`
}

// What a job sends out and to whom, in a phrase that reads after "Outside the gateway:" too. Only a
// provider that reads screenshots is ever sent one.
export function jobNotice(job: ClassifierJob, c: ClassifierConfig): string {
  const spec = providerSpec(c.provider)
  if (job === 'routing')
    return L(
      `cada mensagem sem @menção manda as mensagens recentes do canal para ${spec.label} escolher quem responde, cobrado na sua conta de lá. Se falhar, o modelo do roteador decide.`,
      `every message without an @mention sends the channel’s recent messages to ${spec.label} to pick who replies, billed to your account there. If it fails, the router’s model decides.`
    )
  return spec.box
    ? L(
        `cada clique que o texto não resolve manda para ${spec.label} a lista de elementos da página e, às vezes, o print dela, inclusive em áreas logadas.`,
        `every click text can’t resolve sends ${spec.label} the page’s element list and sometimes its screenshot, including signed-in areas.`
      )
    : L(
        `cada clique que o texto não resolve manda para ${spec.label} a lista de elementos da página, inclusive em áreas logadas. O print da tela não vai.`,
        `every click text can’t resolve sends ${spec.label} the page’s element list, including signed-in areas. The screenshot isn’t sent.`
      )
}
