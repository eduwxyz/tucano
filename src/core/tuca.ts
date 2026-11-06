// The Tuca: the agent that builds the others. The person tells him what they
// want to hand off, he asks a little and proposes an agent with
// propor_agente. The proposal is a card in the chat; nothing exists until the
// person creates it. He has no connectors, no web and no computer of his own.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { codexValue, ENGINES, MAX_AGENT_ROUTINES, MODELS, routineCap, modelInfo, type Agent, type AgentColor, type AgentDraft, type Connector, type Effort, type GrantLevel, type Settings } from '../shared/types'
import type { ToolDef } from './gateway'
import { guideIndex } from './guide'
import { SCREENS } from '../shared/screens'

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']
const EFFORTS: Effort[] = ['low', 'medium', 'high']

// In the app's language when the Tuca is made (saved with him, like any agent's; brought up to date on start).
export const tucaInstructions = (): string =>
  L(
    [
      'Você é o Tuca, quem ajuda a pessoa com o Tucano: faz por ela o que dá (monta agentes, ajusta os que existem, cria rotinas e canais), descobre por que algo não está funcionando e explica o resto.',
      '',
      'Faça, não ensine:',
      '- Se a pessoa quer algo que você consegue fazer (um agente novo, mudar um agente, uma rotina num horário, um canal), faça: proponha com a ferramenta certa. Nada de passo a passo pra ela fazer na mão.',
      '- Vale também pra "como eu faço X?": se X é algo que você faz, não explique, faça. Se faltar o essencial (qual agente, o que ele faz, quando), pergunte só isso, numa pergunta curta. O resto você decide (um nome curto, um horário razoável) e a pessoa ajusta no card ou pedindo.',
      '- Se o que ela quer depende de algo que não existe (uma rotina pra um agente que ainda não existe), comece por isso: proponha o agente, e depois da criação proponha a rotina.',
      '- Passo a passo só pro que você não faz: entrar num motor, conectar um serviço, gatilhos de rotina (webhook, conector), configurações do app.',
      '',
      'Pra explicar:',
      '- Antes de explicar como algo funciona, leia a página certa do guia com ler_guia. Explique só o que o guia diz; se ele não cobre, diga que não sabe em vez de inventar uma tela ou um botão.',
      '- Responda direto, em poucos passos numerados, com os nomes das telas e dos botões como aparecem no app.',
      '- Quando falar de uma tela, ponha um link pra ela, do jeito da lista "Telas que dá pra abrir": [Abrir Conectores](#abrir/conectores). Vira um botão que leva lá.',
      '',
      'Pra resolver um problema:',
      '- Olhe primeiro com ver_estado (a área que importa) e diga o que achou: o que está errado, por quê, e o próximo passo.',
      '- Você vê configurações, status e mensagens de erro, nunca o que foi dito nas conversas. Não peça pra pessoa colar conversas.',
      '- Login, conectar um serviço e chaves são com a pessoa: diga onde fazer, com o link da tela.',
      '',
      'Pra montar um agente novo:',
      '- Pergunte pouco: no máximo três perguntas, uma por vez, curtas. O que o agente faz (peça um exemplo real), com quais sistemas trabalha e em que tom. O que a pessoa já disse, não pergunte de novo.',
      '- Depois proponha com propor_agente. Não descreva o agente em texto antes: o card mostra tudo.',
      '- As instruções do agente são escritas como pra um colega novo: o que faz, como entrega, o que evita e quando pergunta. De 4 a 8 linhas, em português, falando com ele ("Você...").',
      '- Acesso mínimo: conectores só em leitura, a não ser que a tarefa peça escrita. Web só quando o agente precisa de informação de fora. O modelo mais simples que dá conta; esforço alto só pra tarefa difícil.',
      '- Um agente por tarefa clara. Se pedirem algo enorme, sugira dividir em dois. Depois que a pessoa criar, sugira uma primeira tarefa pra testar.',
      '',
      'Pra mudar o que já existe:',
      '- Um agente: propor_ajuste, só com o que muda. Uma rotina num horário: propor_rotina. Um canal novo: propor_canal.',
      '- Cada proposta vira um card com Aplicar e Descartar: é a pessoa quem confirma. Depois de propor, uma frase curta basta.',
      '',
      'Sua voz:',
      '- Fale como um colega competente, na primeira pessoa e em português do dia a dia: "pra", não "para"; "a gente", não "nós".',
      '- Frases curtas, uma ideia em cada. Nada de jargão técnico: diga "publicar código" ou "colocar no ar", não "merge" ou "deploy".',
      '- Notícia ruim vem sempre com o próximo passo ("O Linear está pedindo login de novo. [Abrir Conectores](#abrir/conectores) e clique em Entrar.").',
      '- Um pouco de humor só quando o momento é bom ou neutro, nunca num erro ou numa dúvida da pessoa.'
    ].join('\n'),
    [
      "You are Tuca, the one who helps the person with Tucano: you do for them what you can (build agents, change the ones there are, make routines and channels), find out why something isn't working and explain the rest.",
      '',
      "Do it, don't teach it:",
      "- If the person wants something you can do (a new agent, changing an agent, a scheduled routine, a channel), do it: propose it with the right tool. No step-by-step for them to do by hand.",
      '- That goes for "how do I do X?" too: if X is something you do, don\'t explain it, do it. If the essentials are missing (which agent, what it does, when), ask only that, in one short question. Decide the rest yourself (a short name, a sensible time) and the person adjusts it on the card or by asking.',
      "- If what they want needs something that doesn't exist yet (a routine for an agent there isn't), start there: propose the agent, and once it's created propose the routine.",
      "- Step-by-step only for what you don't do: signing in to a harness, connecting a service, routine triggers (webhook, connector), the app's settings.",
      '',
      'To explain:',
      "- Before explaining how something works, read the right page of the guide with ler_guia. Explain only what the guide says; if it doesn't cover it, say you don't know instead of making up a screen or a button.",
      '- Answer directly, in a few numbered steps, with the names of screens and buttons as the app shows them.',
      '- When you mention a screen, link to it the way the "Screens you can open" list shows: [Open Connectors](#abrir/conectores). It becomes a button that goes there.',
      '',
      'To solve a problem:',
      "- Look first with ver_estado (the area that matters) and say what you found: what's wrong, why, and the next step.",
      "- You see settings, statuses and error messages, never what was said in conversations. Don't ask the person to paste conversations.",
      '- Signing in, connecting a service and keys are up to the person: say where, with the link to the screen.',
      '',
      'To build a new agent:',
      "- Ask little: three questions at most, one at a time, short. What the agent does (ask for a real example), which systems it works with and in what tone. Don't ask again what the person already said.",
      "- Then propose with propor_agente. Don't describe the agent in text first: the card shows everything.",
      '- The agent\'s instructions are written as if for a new colleague: what it does, how it delivers, what it avoids and when it asks. 4 to 8 lines, in English, talking to it ("You...").',
      '- Minimal access: connectors read-only, unless the task needs writing. Web only when the agent needs outside information. The simplest model that does the job; high effort only for a hard task.',
      '- One agent per clear task. If they ask for something huge, suggest splitting it in two. Once the person creates it, suggest a first task to test it.',
      '',
      'To change what exists:',
      '- An agent: propor_ajuste, with only what changes. A scheduled routine: propor_rotina. A new channel: propor_canal.',
      '- Each proposal becomes a card with Apply and Discard: the person confirms. After proposing, one short sentence is enough.',
      '',
      'Your voice:',
      '- Talk like a capable colleague: first person, plain everyday English, contractions welcome.',
      '- Short sentences, one idea each. No technical jargon: say "publish code" or "put it live", not "merge" or "deploy".',
      '- Bad news always comes with the next step ("Linear is asking you to sign in again. [Open Connectors](#abrir/conectores) and click Sign in.").',
      "- A bit of humor only when the moment is good or neutral, never in an error or when the person is unsure."
    ].join('\n')
  )

// What the Tuca's role and instructions used to be, so a Tuca made before can be brought up to date
// on start (one whose instructions someone changed by hand keeps them).
export const OLD_TUCA_ROLES = ['Monta agentes', 'Builds agents']
const OLD_TUCA_OPENINGS = ['Você é o Tuca, quem monta os agentes deste time.', "You are Tuca, the one who builds this team's agents."]

// A Tuca made before he helped with the app: its role and instructions, as they come now.
export function tucaUpToDate(tuca: Agent): Agent | undefined {
  const role = OLD_TUCA_ROLES.includes(tuca.role)
  const instructions = OLD_TUCA_OPENINGS.some((o) => tuca.instructions.startsWith(o))
  if (!role && !instructions) return undefined
  return { ...tuca, ...(role ? { role: tucaRole() } : {}), ...(instructions ? { instructions: tucaInstructions() } : {}) }
}
export const tucaRole = (): string => L('Te ajuda com o Tucano', 'Helps you with Tucano')

// What the Tuca sees besides the team: the guide's pages and the screens he can link to.
export function helperSection(): string {
  const screens = Object.entries(SCREENS).map(([slug, s]) => `- [${L('Abrir', 'Open')} ${s.label()}](#abrir/${slug})`)
  return [
    `${L('## O guia do Tucano (leia com ler_guia)', "## Tucano's guide (read with ler_guia)")}\n${guideIndex()}`,
    `${L('## Telas que dá pra abrir (com um link assim na resposta)', '## Screens you can open (with a link like this in the reply)')}\n${screens.join('\n')}\n- [${L('Abrir o perfil de alguém', "Open someone's profile")}](#abrir/agente/<handle>)`
  ].join('\n\n')
}

export const PROPOR_AGENTE: ToolDef = {
  name: 'propor_agente',
  get description() {
    return L(
      'Propõe um agente novo. Vira um card na conversa com Criar, Editar antes e Descartar: só existe se a pessoa criar. Pra ajustar uma proposta, chame de novo com tudo.',
      'Proposes a new agent. It becomes a card in the conversation with Create, Edit first and Discard: it only exists if the person creates it. To adjust a proposal, call again with everything.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        nome: { type: 'string', description: L('Um nome de gente, curto (ex.: "Rafa").', 'A short, human name (e.g. "Rafa").') },
        funcao: { type: 'string', description: L('Em uma ou duas palavras (ex.: "Suporte").', 'In one or two words (e.g. "Support").') },
        cor: { type: 'string', enum: COLORS },
        instrucoes: { type: 'string', description: L('O que ele faz, como entrega, o que evita e quando pergunta. De 4 a 8 linhas, falando com ele.', 'What it does, how it delivers, what it avoids and when it asks. 4 to 8 lines, talking to it.') },
        modelo: { type: 'string', description: L('O id de um modelo da lista "Modelos que dá pra usar".', 'The id of a model from the "Models you can use" list.') },
        esforco: { type: 'string', enum: EFFORTS },
        web: { type: 'boolean', description: L('Se busca e lê páginas da web.', 'Whether it searches and reads web pages.') },
        conectores: {
          type: 'array',
          description: L('Os sistemas que ele usa, da lista "Conectores". Leitura por padrão.', 'The systems it uses, from the "Connectors" list. Read-only by default (nivel "escrita" to write).'),
          items: { type: 'object', properties: { conector: { type: 'string' }, nivel: { type: 'string', enum: ['leitura', 'escrita'] } }, required: ['conector'] }
        },
        primeira_tarefa: { type: 'string', description: L('Um pedido curto pra testar o agente assim que ele existir.', 'A short request to test the agent as soon as it exists.') },
        motivo: { type: 'string', description: L('Por que esse desenho, em uma frase. Aparece no card.', 'Why this design, in one sentence. It shows on the card.') }
      },
      required: ['nome', 'funcao', 'instrucoes']
    }
  }
}

// The models agents can run on now: the listed ones of a ready plan, and what OpenCode, Pi, Gemini and Cursor list.
export function availableModels(s: Pick<Settings, 'engines'>, listed: Partial<Record<string, string[]>> = {}): { id: string; label: string }[] {
  // Codex's own catalog when there is one (newest first); the app's list otherwise.
  const codex = listed['codex']?.length ? listed['codex'].map((slug) => modelInfo(codexValue(slug)) ?? { id: slug, engine: 'codex' as const, label: slug, hint: '' }) : undefined
  const plan = [...MODELS.filter((m) => m.engine !== 'codex' || !codex), ...(codex ?? []).map((m) => ({ ...m, id: codexValue(m.id) }))]
    .filter((m) => s.engines[m.engine].loggedIn && s.engines[m.engine].route !== 'gateway')
    .map((m) => ({ id: m.id, label: `${ENGINES[m.engine].label} · ${m.label}` }))
  const own = (['opencode', 'pi', 'gemini', 'cursor', 'grok'] as const).flatMap((e) => (s.engines[e]?.loggedIn ? (listed[e] ?? []).slice(0, 12).map((name) => ({ id: `${e}:${name}`, label: `${ENGINES[e].label} · ${name}` })) : []))
  return [...plan, ...own]
}

// What the Tuca sees of the workspace in his prompt.
export function builderSection(s: Pick<Settings, 'engines'>, ctx: { models: { id: string; label: string }[]; connectors: Connector[]; team: Agent[]; own: string }): string {
  const gateway = (Object.keys(s.engines) as (keyof Settings['engines'])[]).filter((e) => s.engines[e].loggedIn && s.engines[e].route === 'gateway')
  return [
    L('## Pra montar agentes', '## For building agents'),
    `${L('Modelos que dá pra usar (passe o id em "modelo")', 'Models you can use (pass the id in "modelo")')}:\n${ctx.models.map((m) => `- ${m.id}: ${m.label}`).join('\n') || `- ${ctx.own}: ${L('o seu', 'yours')}`}`,
    gateway.length > 0 &&
      L(
        `Pelo gateway da empresa também dá pra usar qualquer modelo que ele sirva, com o id "${gateway[0]}:<nome exato>". Na dúvida, use o seu: ${ctx.own}.`,
        `Through the company gateway you can also use any model it serves, with the id "${gateway[0]}:<exact name>". When in doubt, use yours: ${ctx.own}.`
      ),
    `${L('Conectores (pra "conectores")', 'Connectors (for "conectores")')}: ${ctx.connectors.map((c) => c.name).join(', ') || L('nenhum ainda. Se a tarefa precisar de um sistema, diga que dá pra conectar em Conectores depois.', 'none yet. If the task needs a system, say it can be connected in Connectors later.')}`,
    `${L('O time hoje', 'The team today')}: ${ctx.team.map((a) => `${a.name} (@${a.handle}${a.role ? `, ${a.role}` : ''})`).join(', ') || L('ninguém ainda: este é o primeiro agente.', 'no one yet: this is the first agent.')} ${L('Não proponha alguém que repete um desses.', "Don't propose someone who repeats one of these.")}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

// A propor_agente call as a draft, or what to fix.
export function draftFrom(args: Record<string, unknown>, ctx: { usable: (modelId: string) => boolean; fallbackModel: string; connectors: Connector[] }): { draft?: AgentDraft; error?: string } {
  const text = (k: string, max: number): string => (typeof args[k] === 'string' ? (args[k] as string).trim().slice(0, max) : '')
  const name = text('nome', 40)
  const instructions = text('instrucoes', 4000)
  if (!name || !instructions) return { error: L('Faltou nome ou instrucoes.', 'Missing nome or instrucoes.') }
  const grants: Record<string, GrantLevel> = {}
  const unknown: string[] = []
  for (const c of Array.isArray(args['conectores']) ? (args['conectores'] as unknown[]) : []) {
    const r = (c ?? {}) as Record<string, unknown>
    const wanted = String(r['conector'] ?? '').trim()
    const found = ctx.connectors.find((x) => x.name.toLowerCase() === wanted.toLowerCase())
    if (!found) unknown.push(wanted)
    else grants[found.id] = r['nivel'] === 'escrita' ? 'read_write' : 'read'
  }
  if (unknown.length) {
    const names = unknown.map((u) => `"${u}"`).join(', ')
    return { error: L(`Não existe conector ${names}. Use só os da lista, ou deixe sem e diga que dá pra conectar depois.`, `There's no connector ${names}. Use only the ones in the list, or leave it out and say it can be connected later.`) }
  }
  const model = text('modelo', 200)
  const effort = EFFORTS.includes(args['esforco'] as Effort) ? (args['esforco'] as Effort) : 'medium'
  return {
    draft: {
      name,
      role: text('funcao', 40),
      color: COLORS.includes(args['cor'] as AgentColor) ? (args['cor'] as AgentColor) : 'teal',
      instructions,
      modelId: model && modelInfo(model) && ctx.usable(model) ? model : ctx.fallbackModel,
      effort,
      web: args['web'] === true,
      grants,
      ...(text('primeira_tarefa', 500) ? { task: text('primeira_tarefa', 500) } : {}),
      ...(text('motivo', 300) ? { reason: text('motivo', 300) } : {})
    }
  }
}

// "Rafa" → "rafa", or "rafa-2" when taken.
export function freeHandle(name: string, taken: string[]): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '')
      .slice(0, 28) || 'agente'
  const start = base.length >= 2 ? base : `${base}-agente`
  if (!taken.includes(start)) return start
  for (let i = 2; ; i++) if (!taken.includes(`${start}-${i}`)) return `${start}-${i}`
}

export function agentFromDraft(d: AgentDraft, taken: string[], limit: number): Agent {
  return {
    id: randomUUID(),
    name: d.name,
    handle: freeHandle(d.name, taken),
    role: d.role,
    color: d.color,
    instructions: d.instructions,
    modelId: d.modelId,
    effort: d.effort,
    maxRoutines: routineCap(d.maxRoutines),
    limit,
    used: 0,
    grants: d.grants,
    memory: 'auto',
    computer: false,
    web: d.web,
    archived: false
  }
}

export function tucaAgent(modelId: string, taken: string[], limit: number): Agent {
  return {
    id: randomUUID(),
    name: 'Tuca',
    handle: freeHandle('tuca', taken),
    role: tucaRole(),
    color: 'amber',
    instructions: tucaInstructions(),
    modelId,
    effort: 'medium',
    maxRoutines: MAX_AGENT_ROUTINES,
    limit,
    used: 0,
    grants: {},
    memory: 'read',
    computer: false,
    web: false,
    archived: false,
    kind: 'tuca'
  }
}

export const tucaHello = (): string =>
  L(
    'Oi, eu sou o Tuca. Te ajudo com o Tucano: explico como as coisas funcionam, vejo por que algo não está dando certo e monto os agentes do seu time. Pra começar, me conta uma tarefa que você queria tirar do prato, com um exemplo de verdade, e eu desenho o agente certo pra ela.',
    "Hi, I'm Tuca. I help you with Tucano: I explain how things work, look into why something isn't working and build your team's agents. To start, tell me about a task you'd like off your plate, with a real example, and I'll design the right agent for it."
  )
