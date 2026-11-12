// A classifier is a model that answers typed questions about a piece of text: one option out of a
// fixed set, a yes or no, a position on a scale. It never writes a sentence, so it answers in a few
// hundred milliseconds and hands back a probability for every option, which is what a decision made
// in code needs. TypeSafe's Jev was the first one Tucano used; the same job is done by OpenAI's
// Luna (Decisions API), Google's Gemini Decision 1, and Jev itself through OpenRouter.
//
// One classifier is chosen per job (src/shared/classifiers.ts `ClassifierJob`): who replies in a
// channel, what an agent should click in a page, and the ones Apo's own branches add on top.
import { L } from './lang'
import type { Settings } from './types'

export type ClassifierProvider = 'typesafe' | 'openrouter' | 'openai' | 'gemini'

// Where a classifier is used. A job has at most one classifier, and unassigned means off.
export type ClassifierJob = 'routing' | 'listen' | 'recommend' | 'nextSteps' | 'smart' | 'browser'

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
  keyHint: { pt: string; en: string }
}

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    provider: 'typesafe',
    label: 'TypeSafe',
    defaultName: 'Jev',
    model: 'jev-latest',
    models: ['jev-latest', 'jev-1.14.0', 'jev-1.13.0'],
    box: true,
    keyHint: {
      pt: 'A chave do console do TypeSafe. Também acha o elemento pelo print da tela.',
      en: 'The key from the TypeSafe console. It also finds an element from the screenshot.'
    }
  },
  {
    provider: 'openrouter',
    label: 'OpenRouter',
    defaultName: 'Jev (OpenRouter)',
    model: 'typesafe/jev-1.13',
    models: ['typesafe/jev-1.13'],
    box: false,
    keyHint: {
      pt: 'A chave do OpenRouter serve para o Jev, cobrado na mesma fatura dos outros modelos.',
      en: 'An OpenRouter key serves Jev, billed on the same invoice as the other models.'
    }
  },
  {
    provider: 'openai',
    label: 'OpenAI',
    defaultName: 'Luna',
    model: 'gpt-6-luna',
    models: ['gpt-6-luna'],
    box: false,
    keyHint: {
      pt: 'A chave da OpenAI, com a Decisions API liberada na organização.',
      en: 'The OpenAI key, with the Decisions API enabled for the organization.'
    }
  },
  {
    provider: 'gemini',
    label: 'Google',
    defaultName: 'Gemini Decision',
    model: 'gemini-decision-1',
    models: ['gemini-decision-1'],
    box: false,
    keyHint: {
      pt: 'A chave do Google AI Studio, com a Decisions API liberada.',
      en: 'The Google AI Studio key, with the Decisions API enabled.'
    }
  }
]

export const providerSpec = (p: ClassifierProvider): ProviderSpec => PROVIDERS.find((s) => s.provider === p) ?? PROVIDERS[0]!

// The classifier an install from before this section had: one TypeSafe Jev.
export const JEV_CLASSIFIER: ClassifierConfig = { id: 'jev', name: 'Jev', provider: 'typesafe', model: 'jev-latest' }

export const CLASSIFIER_JOBS: readonly ClassifierJob[] = ['routing', 'listen', 'recommend', 'nextSteps', 'smart', 'browser']

export const jobLabel = (job: ClassifierJob): { pt: string; en: string } =>
  ({
    routing: { pt: 'Quem responde no canal', en: 'Who replies in a channel' },
    listen: { pt: 'Quem escuta entra', en: 'Which listener joins' },
    recommend: { pt: 'A opção sugerida na pergunta', en: 'The option suggested on a question' },
    nextSteps: { pt: 'Quais próximos passos fazer', en: 'Which next steps are worth doing' },
    smart: { pt: 'Qual modelo responde', en: 'Which model answers' },
    browser: { pt: 'O que o agente clica na página', en: 'What an agent clicks in a page' }
  })[job]

export const jobAbout = (job: ClassifierJob): { pt: string; en: string } =>
  ({
    routing: {
      pt: 'Lê a conversa e escolhe quem responde, no lugar do modelo pequeno do roteador. Cada mensagem sem @menção vai pro provedor escolhido.',
      en: 'Reads the conversation and picks who replies, in place of the router’s small model. Every message without an @mention goes to the chosen provider.'
    },
    listen: {
      pt: 'Um agente em modo escuta fica fora da conversa até esta pergunta dizer que a mensagem precisa do que só ele faz.',
      en: 'An agent in listen mode stays out of the conversation until this question says the message needs what only it does.'
    },
    recommend: {
      pt: 'Marca a melhor opção no card de uma pergunta do agente. “Nenhuma” é resposta de verdade: o gosto da pessoa não é decisão de modelo.',
      en: 'Marks the best option on an agent’s question card. “None” is a real answer: the person’s taste is not a model’s call.'
    },
    nextSteps: {
      pt: 'Os próximos passos de uma resposta começam todos marcados; esta pergunta decide quais ficam.',
      en: 'A reply’s next steps all start ticked; this question decides which keep their tick.'
    },
    smart: {
      pt: 'Lê o pedido e escolhe a cadeia de modelos do roteamento inteligente: o papel, o tamanho do trabalho e a capacidade que ele merece.',
      en: 'Reads the request and picks the smart routing chain: the role, how hard the work is, and the capability it deserves.'
    },
    browser: {
      pt: 'Acha o elemento que o agente pediu (“o botão Buscar”). O print da tela, que resolve os casos sem texto, só o TypeSafe lê.',
      en: 'Finds the element the agent asked for (“the Search button”). The screenshot, which handles the cases without text, only TypeSafe reads.'
    }
  })[job]

export type ClassifierSettings = Pick<Settings, 'classifiers' | 'classifierJobs' | 'jevKey' | 'routerModel' | 'browserJev' | 'jevRecommend' | 'jevNextSteps'>

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
  if (!known) return jobs
  if (s.routerModel === 'jev') jobs.routing = JEV_CLASSIFIER.id
  if (s.browserJev) jobs.browser = JEV_CLASSIFIER.id
  // The rest answered on that one key whenever it was saved, so they keep it: an install that had
  // a key and a switch on keeps hearing, suggesting and picking models exactly as before.
  if (s.jevKey) {
    jobs.listen = JEV_CLASSIFIER.id
    if (s.jevRecommend) jobs.recommend = JEV_CLASSIFIER.id
    if (s.jevNextSteps) jobs.nextSteps = JEV_CLASSIFIER.id
    jobs.smart = JEV_CLASSIFIER.id
  }
  return jobs
}

// The classifier a job runs on, or undefined when the job is off.
export function classifierFor(s: ClassifierSettings, job: ClassifierJob): ClassifierConfig | undefined {
  const id = classifierJobsOf(s)[job]
  return id ? classifierList(s).find((c) => c.id === id) : undefined
}

// A row's name, with the provider's when the person renamed it to something of their own.
export function classifierLabel(c: ClassifierConfig): string {
  const spec = providerSpec(c.provider)
  return c.name === spec.label ? `${spec.label} · ${c.model}` : `${c.name} · ${spec.label}`
}

// What is sent where, for the notice before a job is switched on.
export const providerNote = (c: ClassifierConfig): string => {
  const spec = providerSpec(c.provider)
  return L(`o provedor ${spec.label} (${c.model})`, `the ${spec.label} provider (${c.model})`)
}
