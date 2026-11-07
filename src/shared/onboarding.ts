// The guided first run, as data and plain rules: the goals the Tuca offers and the agent each one
// starts (no model call, so the person never waits on one), which AI is ready, the models picked for
// the work behind the scenes, and the missions that make the sidebar grow on a new install.
import { L } from './lang'
import { codexValue, customModel, ENGINE_IDS, MODELS, type AgentColor, type EngineId, type EngineStatus, type Settings } from './types'
import type { Autonomy } from './actions'

// ---------- the goals ----------

export const GOAL_IDS = ['week', 'research', 'write', 'customers', 'sheets', 'code'] as const
export type GoalId = (typeof GOAL_IDS)[number]

export interface Goal {
  id: GoalId | 'own' // own: the person's own words, matched to none
  title: string // the tile
  name: string // the agent's
  role: string // short, for the sidebar
  tagline: string // under the name, as the person reads it ("Organiza a sua semana")
  color: AgentColor
  web: boolean
  instructions: string
  does: string[] // what it does, in plain words, one line each (how far it goes alone is chosen apart)
  task: string // the first message, after its @
  connector?: { id: string; label: string } // a catalog entry worth offering, optional
}

export const GOALS = (): Goal[] => [
  {
    id: 'week',
    title: L('Organizar minha semana', 'Organize my week'),
    name: 'Lia',
    role: L('Agenda', 'Planning'),
    tagline: L('Organiza a sua semana', 'Organizes your week'),
    color: 'violet',
    web: true,
    instructions: L(
      'Você ajuda a pessoa a organizar a semana: compromissos, tarefas e prioridades.\nAntes de montar um plano, pergunta o que ela tem pra fazer e o que não pode atrasar.\nEntrega o plano por dia, em listas curtas, deixando folga pro imprevisto.\nQuando algo não cabe, diz o que sugere adiar e por quê.\nPesquisa na internet só quando precisa (um endereço, um horário de funcionamento).\nAntes de enviar, apagar ou marcar algo em nome dela, pede o ok.',
      'You help the person organize their week: appointments, tasks and priorities.\nBefore making a plan, you ask what they have to do and what can’t slip.\nYou deliver the plan by day, in short lists, leaving room for the unexpected.\nWhen something doesn’t fit, you say what you’d push back and why.\nYou search the web only when needed (an address, opening hours).\nBefore sending, deleting or booking anything for them, you ask first.'
    ),
    does: [L('Monta a sua semana a partir do que você contar', 'Plans your week from what you tell it'), L('Pesquisa na internet quando precisa', 'Searches the web when it needs to'), L('Te pergunta quando tiver dúvida', 'Asks you when it isn’t sure')],
    task: L('me ajuda a planejar a semana. Antes, me pergunta o que eu tenho pra fazer.', 'help me plan my week. First, ask me what I have to do.'),
    connector: { id: 'google-calendar', label: L('Ver a sua agenda do Google', 'See your Google Calendar') }
  },
  {
    id: 'research',
    title: L('Pesquisar e resumir', 'Research and summarize'),
    name: 'Iris',
    role: L('Pesquisa', 'Research'),
    tagline: L('Pesquisa e resume pra você', 'Researches and sums up for you'),
    color: 'sky',
    web: true,
    instructions: L(
      'Você pesquisa na web antes de responder e cita as fontes com links.\nResume em tópicos curtos, separando o que é fato do que é opinião.\nQuando as fontes discordam, mostra as duas versões.\nDiz com clareza quando não achou nada confiável, em vez de chutar.\nPergunta o objetivo da pesquisa quando ele não estiver claro.',
      'You search the web before answering and cite your sources with links.\nYou sum up in short bullet points, separating fact from opinion.\nWhen sources disagree, you show both sides.\nYou say plainly when you found nothing reliable, instead of guessing.\nYou ask what the research is for when that isn’t clear.'
    ),
    does: [L('Busca na internet e lê as fontes por você', 'Searches the web and reads the sources for you'), L('Resume em tópicos curtos, com os links', 'Sums up in short points, with the links'), L('Diz quando não achou nada confiável', 'Says when it found nothing reliable')],
    task: L('quais foram as 3 notícias mais importantes da minha área nesta semana? Antes, me pergunta qual é a minha área.', 'what were the 3 most important stories in my field this week? First, ask me what my field is.')
  },
  {
    id: 'write',
    title: L('Escrever e-mails e posts', 'Write emails and posts'),
    name: 'Nina',
    role: L('Textos', 'Writing'),
    tagline: L('Escreve e-mails e posts no seu tom', 'Writes emails and posts in your voice'),
    color: 'rose',
    web: true,
    instructions: L(
      'Você escreve e-mails, posts e textos no tom da pessoa: leve, curto e sem jargão.\nEntrega o rascunho pronto pra usar, e no máximo duas versões quando o tom não estiver claro.\nPergunta pra quem é o texto e o que ele precisa conseguir, se ela não disser.\nNunca envia nem publica nada sozinho: entrega o texto e espera o ok.',
      'You write emails, posts and copy in the person’s voice: light, short and jargon-free.\nYou deliver a ready-to-use draft, and at most two versions when the tone isn’t clear.\nYou ask who the text is for and what it needs to achieve, if they don’t say.\nYou never send or publish anything on your own: you hand over the text and wait for the ok.'
    ),
    does: [L('Escreve rascunhos prontos pra usar', 'Writes ready-to-use drafts'), L('Ajusta o tom ao que você pedir', 'Adjusts the tone to what you ask'), L('Te pergunta pra quem é o texto', 'Asks you who the text is for')],
    task: L('me ajuda a escrever um e-mail. Antes, me pergunta pra quem é e o que eu quero dizer.', 'help me write an email. First, ask me who it’s for and what I want to say.'),
    connector: { id: 'gmail', label: L('Ler e rascunhar no seu Gmail', 'Read and draft in your Gmail') }
  },
  {
    id: 'customers',
    title: L('Responder clientes', 'Reply to customers'),
    name: 'Duda',
    role: L('Atendimento', 'Support'),
    tagline: L('Ajuda a responder os seus clientes', 'Helps you reply to your customers'),
    color: 'teal',
    web: false,
    instructions: L(
      'Você ajuda a pessoa a responder clientes com rapidez e simpatia.\nEscreve a resposta pronta, curta e educada, no tom da marca dela.\nQuando falta uma informação (preço, prazo, política de troca), pergunta em vez de inventar.\nGuarda as respostas que funcionam pra usar de novo.\nNunca envia nada a um cliente sem o ok da pessoa.',
      'You help the person reply to customers quickly and kindly.\nYou write the reply ready to send, short and polite, in their brand’s voice.\nWhen a piece of information is missing (price, timing, return policy), you ask instead of making it up.\nYou keep the replies that work, to use again.\nYou never send anything to a customer without the person’s ok.'
    ),
    does: [L('Escreve respostas prontas pros seus clientes', 'Writes ready replies for your customers'), L('Pergunta quando falta uma informação', 'Asks when a piece of information is missing'), L('Aprende o jeito da sua marca', 'Learns your brand’s way of talking')],
    task: L('me ajuda a responder os meus clientes. Antes, me pergunta o que eu vendo e as dúvidas que mais chegam.', 'help me reply to my customers. First, ask me what I sell and the questions I get most.'),
    connector: { id: 'gmail', label: L('Ler os e-mails dos clientes no Gmail', 'Read customer emails in Gmail') }
  },
  {
    id: 'sheets',
    title: L('Cuidar de planilhas', 'Handle spreadsheets'),
    name: 'Theo',
    role: L('Planilhas', 'Spreadsheets'),
    tagline: L('Cuida das suas planilhas', 'Looks after your spreadsheets'),
    color: 'amber',
    web: false,
    instructions: L(
      'Você ajuda com planilhas: organizar dados, fazer contas, montar fórmulas e resumir o que os números dizem.\nMostra a conta ou a fórmula que usou, pra pessoa conferir.\nQuando os dados parecem errados ou incompletos, avisa antes de seguir.\nExplica em português simples, sem jargão de planilha.',
      'You help with spreadsheets: organizing data, doing the math, building formulas and summing up what the numbers say.\nYou show the calculation or formula you used, so the person can check it.\nWhen the data looks wrong or incomplete, you say so before going on.\nYou explain in plain words, without spreadsheet jargon.'
    ),
    does: [L('Monta fórmulas e faz as contas', 'Builds formulas and does the math'), L('Mostra como chegou em cada número', 'Shows how it got each number'), L('Avisa quando os dados parecem errados', 'Warns you when the data looks wrong')],
    task: L('me ajuda com uma planilha. Antes, me pergunta o que ela tem e o que eu quero descobrir.', 'help me with a spreadsheet. First, ask me what’s in it and what I want to find out.'),
    connector: { id: 'google-sheets', label: L('Abrir as suas planilhas do Google', 'Open your Google Sheets') }
  },
  {
    id: 'code',
    title: L('Programar', 'Code'),
    name: 'Leo',
    role: L('Código', 'Code'),
    tagline: L('Programa com você', 'Codes with you'),
    color: 'indigo',
    web: true,
    instructions: L(
      'Você ajuda com código, arquitetura e bugs.\nExplica o raciocínio em poucas linhas e mostra código quando ajuda.\nAntes de propor uma mudança grande, descreve o plano e pergunta.\nQuando não tem certeza de como algo funciona no projeto da pessoa, pergunta em vez de supor.',
      'You help with code, architecture and bugs.\nYou explain your reasoning in a few lines and show code when it helps.\nBefore proposing a big change, you describe the plan and ask.\nWhen you aren’t sure how something works in the person’s project, you ask instead of assuming.'
    ),
    does: [L('Explica, escreve e revisa código', 'Explains, writes and reviews code'), L('Descreve o plano antes de algo grande', 'Describes the plan before anything big'), L('Pesquisa a documentação quando precisa', 'Looks up the docs when it needs to')],
    task: L('me ajuda num projeto. Antes, me pergunta em que linguagem ele é e o que eu quero fazer.', 'help me with a project. First, ask me what language it’s in and what I want to do.'),
    connector: { id: 'github', label: L('Ver os seus repositórios no GitHub', 'See your GitHub repositories') }
  }
]

export const goalById = (id: string): Goal | undefined => GOALS().find((g) => g.id === id)

// Words that point to each goal, without accents, in both languages: the person's own words go to the
// goal they name most; none, and they get a helper made from what they said.
const WORDS: Record<GoalId, string[]> = {
  week: ['semana', 'agenda', 'calendar', 'organiz', 'tarefa', 'compromisso', 'lembr', 'prazo', 'rotina', 'planej', 'week', 'schedule', 'task', 'remind', 'deadline', 'planning'],
  research: ['pesquis', 'resum', 'noticia', 'estud', 'compar', 'descobr', 'research', 'summar', 'news', 'study', 'compare', 'find out', 'learn'],
  write: ['escrev', 'e-mail', 'email', 'post', 'texto', 'linkedin', 'newsletter', 'artigo', 'legenda', 'write', 'blog', 'article', 'caption', 'copy'],
  customers: ['client', 'atend', 'respond', 'whatsapp', 'instagram', 'loja', 'venda', 'suporte', 'pedido', 'customer', 'support', 'reply', 'store', 'shop', 'order', 'sales'],
  sheets: ['planilh', 'excel', 'sheets', 'tabela', 'financ', 'orcamento', 'gasto', 'numero', 'spreadsheet', 'table', 'budget', 'expense', 'invoice', 'numbers'],
  code: ['program', 'codigo', 'bug', 'site', 'aplicativo', 'deploy', 'github', 'script', 'code', 'coding', 'software', 'api', 'app']
}

const plain = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

// The goal the person's words name most (ties go to the first in the list), or none. A word counts
// at the start of one of theirs ("organiz" in "organizar"), never inside another ("app" in "happy").
export function goalFromText(text: string): GoalId | undefined {
  const t = plain(text)
  const has = (w: string): boolean => new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)
  let best: GoalId | undefined
  let score = 0
  for (const id of GOAL_IDS) {
    const n = WORDS[id].filter(has).length
    if (n > score) (best = id), (score = n)
  }
  return best
}

// What the person typed, as an agent: the goal it names, with their words added to what it knows and
// sent as its first task; matched to nothing, a helper that starts from those words.
export function goalForText(text: string): Goal {
  const said = text.trim().replace(/\s+/g, ' ')
  const id = goalFromText(said)
  const base = id ? goalById(id)! : ownGoal()
  const note = L(`O que a pessoa contou que precisa: "${said}"`, `What the person said they need: "${said}"`)
  return { ...base, instructions: `${base.instructions}\n${note}`, task: firstTaskFrom(said) }
}

const ownGoal = (): Goal => ({
  id: 'own',
  title: '',
  name: 'Bia',
  role: L('Assistente', 'Assistant'),
  tagline: L('Ajuda no que você pediu', 'Helps with what you asked'),
  color: 'green',
  web: true,
  instructions: L(
    'Você ajuda a pessoa com o que ela pediu, do jeito mais simples que funcionar.\nAntes de começar, pergunta o que falta pra entender a tarefa.\nResponde em listas curtas e fáceis de seguir.\nAntes de enviar, apagar ou pagar algo em nome dela, pede o ok.',
    'You help the person with what they asked, in the simplest way that works.\nBefore starting, you ask what’s missing to understand the task.\nYou answer in short, easy-to-follow lists.\nBefore sending, deleting or paying for anything on their behalf, you ask first.'
  ),
  does: [L('Ajuda no que você pediu', 'Helps with what you asked'), L('Pesquisa na internet quando precisa', 'Searches the web when it needs to'), L('Te pergunta quando tiver dúvida', 'Asks you when it isn’t sure')],
  task: ''
})

// The first message from what the person said: lower-case start (it follows the @), and a nudge to ask first.
function firstTaskFrom(said: string): string {
  const s = said.replace(/[.!?…]+$/, '')
  const body = s ? s[0]!.toLowerCase() + s.slice(1) : ''
  return body ? `${body}. ${L('Antes de começar, me pergunta o que precisar.', 'Before you start, ask me whatever you need.')}` : ''
}

// ---------- the AI ----------

// Whether the agents have something to think with yet: still being checked, ready, or nothing.
export type AiState = 'checking' | 'ready' | 'none'

export function aiState(engines: Record<EngineId, EngineStatus>): AiState {
  const all = ENGINE_IDS.map((e) => engines[e])
  if (all.some((s) => s.loggedIn && !s.soon && !s.off)) return 'ready'
  return all.some((s) => s.checking) ? 'checking' : 'none'
}

// Installed but not signed in (Codex runs on a login of Tucano's own): one click away.
export const needsSignIn = (engines: Record<EngineId, EngineStatus>): EngineId[] => (['claude', 'codex'] as const).filter((e) => engines[e].installed && !engines[e].loggedIn && !engines[e].soon)

// The models for the two small jobs behind the scenes (who replies in a channel, and memory),
// picked for the person: the fastest one of a ready harness. A gateway names its own models,
// so there the person picks (undefined).
const FAST = /haiku|mini|flash|lite|fast|luna|spark|small/i

export function backgroundModel(engines: Record<EngineId, EngineStatus>, listed: Partial<Record<EngineId, string[]>> = {}): string | undefined {
  const ready = (e: EngineId): boolean => engines[e].loggedIn && !engines[e].soon && !engines[e].off && engines[e].route !== 'gateway'
  if (ready('claude')) return 'haiku'
  if (ready('codex')) {
    const catalog = listed.codex ?? []
    const fast = catalog.find((m) => FAST.test(m)) ?? catalog[0]
    return fast ? codexValue(fast) : MODELS.find((m) => m.engine === 'codex')!.id
  }
  for (const e of ENGINE_IDS) {
    if (e === 'claude' || e === 'codex' || !ready(e)) continue
    const models = listed[e] ?? []
    const pick = models.find((m) => FAST.test(m)) ?? models[0]
    if (pick) return customModel(e, pick)
  }
  return undefined
}

// The agent's own model: the everyday one of the first ready harness on a plan, or the first it lists.
export function agentModel(engines: Record<EngineId, EngineStatus>, listed: Partial<Record<EngineId, string[]>> = {}): string | undefined {
  const ready = (e: EngineId): boolean => engines[e].loggedIn && !engines[e].soon && !engines[e].off && engines[e].route !== 'gateway'
  if (ready('claude')) return 'sonnet'
  if (ready('codex')) return MODELS.find((m) => m.engine === 'codex')!.id
  for (const e of ENGINE_IDS) {
    const first = listed[e]?.[0]
    if (e !== 'claude' && e !== 'codex' && ready(e) && first) return customModel(e, first)
  }
  return undefined
}

// ---------- missions ----------

export const MISSION_IDS = ['talk', 'approve', 'connect', 'second', 'auto', 'remember'] as const
export type MissionId = (typeof MISSION_IDS)[number]

// The parts of the sidebar a new install starts without, each brought by a mission or by having something in it.
export type SidebarPart = 'memory' | 'wiki' | 'routines' | 'skills' | 'report' | 'usage' | 'connectors' | 'channels'

// What the missions look at, from the app's state (the renderer works it out).
export interface MissionFacts {
  replied: boolean // an agent finished a reply
  decided: boolean // an approval decided, or an agent's question answered
  connectors: number
  agents: number // the team's, not the Tuca
  routines: number
  memories: number // kept (active)
}

export interface Mission {
  id: MissionId
  title: (agent: string) => string
  how: string
  unlocks: SidebarPart[]
  unlockName: string // what it brings, as the sidebar names it
  done: (f: MissionFacts) => boolean
}

export const MISSIONS = (): Mission[] => [
  { id: 'talk', title: (a) => L(`Fale com ${a}`, `Talk to ${a}`), how: L('Mande uma mensagem e veja a resposta chegar.', 'Send a message and watch the reply come in.'), unlocks: ['usage', 'report'], unlockName: L('Uso e limites', 'Usage and limits'), done: (f) => f.replied },
  { id: 'approve', title: () => L('Aprove algo', 'Approve something'), how: L('Quando um agente quer fazer algo por conta própria, ele pede. Responda um pedido.', 'When an agent wants to do something on its own, it asks. Answer one request.'), unlocks: [], unlockName: '', done: (f) => f.decided },
  { id: 'connect', title: () => L('Conecte uma conta', 'Connect an account'), how: L('Sua agenda, seu e-mail ou outra ferramenta, pros agentes lerem por você.', 'Your calendar, email or another tool, for the agents to read for you.'), unlocks: ['connectors'], unlockName: L('Conectores', 'Connectors'), done: (f) => f.connectors > 0 },
  { id: 'second', title: () => L('Monte um segundo agente', 'Build a second agent'), how: L('Dois agentes num canal trabalham juntos.', 'Two agents in a channel work together.'), unlocks: ['channels', 'skills'], unlockName: L('Canais', 'Channels'), done: (f) => f.agents >= 2 },
  { id: 'auto', title: () => L('Deixe algo no automático', 'Put something on autopilot'), how: L('Uma tarefa que roda sozinha, todo dia ou toda semana.', 'A task that runs on its own, every day or every week.'), unlocks: ['routines'], unlockName: L('Rotinas', 'Routines'), done: (f) => f.routines > 0 },
  { id: 'remember', title: () => L('Guarde algo que importa', 'Keep something that matters'), how: L('O que o time precisa saber sempre, num lugar só.', 'What the team always needs to know, in one place.'), unlocks: ['memory', 'wiki'], unlockName: L('Memória e Wiki', 'Memory and Wiki'), done: (f) => f.memories > 0 }
]

export const missionsDone = (f: MissionFacts): Set<MissionId> => new Set(MISSIONS().filter((m) => m.done(f)).map((m) => m.id))

// The short sidebar is a new install's alone (never an existing one's), until "Mostrar tudo de uma vez".
export const shortSidebar = (o: Settings['onboarding']): boolean => !!o?.fresh && !o.showAll

// Whether a part of the sidebar shows: always, outside the short sidebar; in it, once its mission
// is done or once it has something in it.
export function partShows(part: SidebarPart, o: Settings['onboarding'], done: Set<MissionId>, has: Partial<Record<SidebarPart, boolean>> = {}): boolean {
  if (!shortSidebar(o) || has[part]) return true
  return MISSIONS().some((m) => m.unlocks.includes(part) && done.has(m.id))
}

// What a mission just brought that the person hasn't opened yet: marked new in the sidebar.
export const freshParts = (o: Settings['onboarding'], done: Set<MissionId>): SidebarPart[] =>
  shortSidebar(o) ? MISSIONS().filter((m) => done.has(m.id)).flatMap((m) => m.unlocks).filter((p) => !(o?.seen ?? []).includes(p)) : []

// ---------- the tour ----------

// The marks over the real screens, in the order they can come: the first message, the first request
// (whenever an agent makes one), the Tuca, and the missions.
export type TourMark = 'first' | 'ask' | 'tuca' | 'missions'

export const tourOn = (o: Settings['onboarding'], mark: TourMark): boolean => !!o?.tour && !o.tour.skipped && !(o.tour.done ?? []).includes(mark)

// "Tour · 2 de 3": the marks after the first message, numbered as they come.
export const tourCount = (o: Settings['onboarding'], withMissions: boolean): { at: number; of: number } => {
  const after = (o?.tour?.done ?? []).filter((m) => m !== 'first').length
  return { at: after + 1, of: withMissions ? 3 : 2 }
}

// ---------- how far the first agent goes on its own ----------
// "Quanto {nome} faz por conta própria?": three plain answers, each one of the autonomy levels
// (src/shared/actions.ts). Normal is the recommended one and comes picked.

export const FIRST_AUTONOMY: Autonomy = 'normal'

export interface AutonomyChoice {
  level: Autonomy
  title: string
  recommended?: boolean
}

export const AUTONOMY_CHOICES = (): AutonomyChoice[] => [
  { level: 'careful', title: L('Me pergunta antes de mudar qualquer coisa', 'Asks me before changing anything') },
  { level: 'normal', title: L('Faz o dia a dia por conta própria e pergunta antes do que importa', 'Handles the day to day and asks before what matters'), recommended: true },
  { level: 'free', title: L('Faz tudo por conta própria, até enviar e pagar', 'Does everything on its own, even sending and paying') }
]

// What still asks, in one line. True to verdict(): a high-risk action (or an app action that can't be
// placed) asks at any level, and with the outside-content guard on (the default), what goes out after
// reading something from outside asks too.
export function autonomyChoiceHint(level: Autonomy, guard = true): string {
  if (level === 'careful') return L('Pede antes de escrever num app, enviar, apagar ou clicar no que é arriscado. Ler e pesquisar nunca pede.', 'Asks before writing in an app, sending, deleting or a risky click. Reading and searching never ask.')
  if (level === 'normal') return L('Lê, pesquisa e organiza sem pedir. Pede antes de enviar, apagar, publicar, pagar ou clicar no que é arriscado.', 'Reads, searches and organizes without asking. Asks before sending, deleting, publishing, paying or a risky click.')
  return guard
    ? L('Ainda pede o que é de alto risco e, depois de ler algo de fora (um e-mail, uma página), antes de enviar, publicar, pagar ou apagar.', 'Still asks for what’s high risk and, after reading something from outside (an email, a page), before sending, publishing, paying or deleting.')
    : L('Ainda pede o que é de alto risco. O resto faz sem perguntar.', 'Still asks for what’s high risk. Everything else it does without asking.')
}

// What the agent keeps: Normal while Settings say Normal is left unset ("Padrão"), so the agent follows
// later changes in Settings; any other answer (or Normal when Settings say otherwise) is its own.
export const storedAutonomy = (choice: Autonomy, settingsLevel: Autonomy | undefined): Autonomy | undefined => (choice === 'normal' && (settingsLevel ?? 'normal') === 'normal' ? undefined : choice)

// The answer shown for an agent: its own level, else Settings', else Normal.
export const autonomyChosen = (agentLevel: Autonomy | undefined, settingsLevel: Autonomy | undefined): Autonomy => agentLevel ?? settingsLevel ?? 'normal'
