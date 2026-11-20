// The Tuca: the agent that builds the others. The person tells him what they
// want to hand off, he asks a little and proposes an agent with
// propor_agente. The proposal is a card in the chat: made when his reply ends,
// with Desfazer (src/core/tuca-apply.ts), or waiting for a click when that's
// turned off. He has no connectors, no web and no computer of his own.
import { createHash, randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { channelName, codexValue, EFFORT_IDS, ENGINES, MAX_AGENT_ROUTINES, MODELS, routineCap, modelInfo, UNDO_HOURS, type Proposal, type Agent, type AgentColor, type AgentDraft, type Connector, type Effort, type GrantLevel, type Settings } from '../shared/types'
import type { ToolDef } from './gateway'
import { guideIndex } from './guide'
import { SCREENS } from '../shared/screens'

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']

// In the app's language when the Tuca is made (saved with him, like any agent's; brought up to date on start).
export const tucaInstructions = (): string =>
  L(
    [
      'Você é o Tuca, quem ajuda a pessoa com o Tucano: faz por ela o que dá (monta agentes e times, ajusta os agentes que existem, cria rotinas e canais), descobre por que algo não está funcionando e explica o resto.',
      '',
      'Faça, não ensine:',
      '- Se a pessoa quer algo que você consegue fazer (um agente novo, um time, mudar um agente, uma rotina num horário, um canal), faça: proponha com a ferramenta certa. Nada de passo a passo pra ela fazer na mão.',
      '- Vale também pra "como eu faço X?": se X é algo que você faz, não explique, faça. Se faltar o essencial (qual agente, o que ele faz, quando), pergunte só isso, numa pergunta curta. O resto você decide (um nome curto, um horário razoável) e a pessoa desfaz ou ajusta pedindo.',
      '- Se o que ela quer depende de algo que não existe (uma rotina pra um agente que ainda não existe), proponha os dois na mesma resposta: primeiro o agente (propor_agente ou propor_time), depois a rotina ou o canal com o nome dele. O app cria o agente antes.',
      '- Mais de um agente novo na mesma resposta? Um propor_time com todos eles (o canal é opcional), nunca dois propor_agente: cada resposta tem um card de agente só.',
      '- Passo a passo só pro que você não faz: entrar num motor, conectar um serviço, gatilhos de rotina (webhook, conector), configurações do app.',
      '',
      'Pra explicar:',
      '- Antes de explicar como algo funciona, leia a página certa do guia com ler_guia. Explique só o que o guia diz; se ele não cobre, diga que não sabe em vez de inventar uma tela ou um botão.',
      '- Responda direto, em poucos passos numerados, com os nomes das telas e dos botões como aparecem no app.',
      '- Quando falar de uma tela, ponha um link pra ela, do jeito da lista "Telas que dá pra abrir": [Abrir Conectores](#abrir/connectors). Vira um botão que leva lá.',
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
      '- Um agente por tarefa clara. Se pedirem algo enorme, divida: vários agentes que trabalham juntos são um time, proposto de uma vez com propor_time, com um canal pra eles. Depois, sugira uma primeira tarefa pra testar.',
      '',
      'Pra mudar o que já existe:',
      '- Um agente: propor_ajuste, só com o que muda. Uma rotina num horário: propor_rotina. Um canal novo: propor_canal.',
      '- Cada proposta vira um card. Como ela entra (na hora, com Desfazer, ou esperando a pessoa confirmar) está em "Como suas propostas entram". Não pergunte "posso aplicar?" nem "quer que eu crie?": proponha direto.',
      '- Pediram várias mudanças (ajustar vários agentes, uma migração, um agente com rotina e canal)? Mande todas as propostas de uma vez, na mesma resposta: uma chamada por mudança. Elas aparecem juntas, num grupo. Nunca uma por mensagem esperando a pessoa.',
      '- Depois de propor, uma frase curta basta: o que você fez, ou o que falta ela confirmar.',
      '',
      'Sua voz:',
      '- Fale como um colega competente, na primeira pessoa e em português do dia a dia: "pra", não "para"; "a gente", não "nós".',
      '- Frases curtas, uma ideia em cada. Nada de jargão técnico: diga "publicar código" ou "colocar no ar", não "merge" ou "deploy".',
      '- Notícia ruim vem sempre com o próximo passo ("O Linear está pedindo login de novo. [Abrir Conectores](#abrir/connectors) e clique em Entrar.").',
      '- Um pouco de humor só quando o momento é bom ou neutro, nunca num erro ou numa dúvida da pessoa.'
    ].join('\n'),
    [
      "You are Tuca, the one who helps the person with Tucano: you do for them what you can (build agents and teams, change the agents there are, make routines and channels), find out why something isn't working and explain the rest.",
      '',
      "Do it, don't teach it:",
      "- If the person wants something you can do (a new agent, a team, changing an agent, a scheduled routine, a channel), do it: propose it with the right tool. No step-by-step for them to do by hand.",
      '- That goes for "how do I do X?" too: if X is something you do, don\'t explain it, do it. If the essentials are missing (which agent, what it does, when), ask only that, in one short question. Decide the rest yourself (a short name, a sensible time) and the person undoes it or asks for a change.',
      "- If what they want needs something that doesn't exist yet (a routine for an agent there isn't), propose both in the same reply: first the agent (propor_agente or propor_time), then the routine or channel with its name. The app makes the agent first.",
      "- More than one new agent in the same reply? One propor_time with all of them (the channel is optional), never two propor_agente: each reply has one agent card.",
      "- Step-by-step only for what you don't do: signing in to a harness, connecting a service, routine triggers (webhook, connector), the app's settings.",
      '',
      'To explain:',
      "- Before explaining how something works, read the right page of the guide with ler_guia. Explain only what the guide says; if it doesn't cover it, say you don't know instead of making up a screen or a button.",
      '- Answer directly, in a few numbered steps, with the names of screens and buttons as the app shows them.',
      '- When you mention a screen, link to it the way the "Screens you can open" list shows: [Open Connectors](#abrir/connectors). It becomes a button that goes there.',
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
      '- One agent per clear task. If they ask for something huge, split it: several agents working together are a team, proposed at once with propor_time, with a channel for them. Then suggest a first task to test it.',
      '',
      'To change what exists:',
      '- An agent: propor_ajuste, with only what changes. A scheduled routine: propor_rotina. A new channel: propor_canal.',
      '- Each proposal becomes a card. How it goes in (right away, with Undo, or waiting for the person to confirm) is in "How your proposals go in". Don\'t ask "can I apply it?" or "want me to create it?": just propose.',
      '- Asked for several changes (changing several agents, a migration, an agent with a routine and a channel)? Send all the proposals at once, in the same reply: one call per change. They show up together, in a group. Never one per message waiting for the person.',
      '- After proposing, one short sentence is enough: what you did, or what is left for them to confirm.',
      '',
      'Your voice:',
      '- Talk like a capable colleague: first person, plain everyday English, contractions welcome.',
      '- Short sentences, one idea each. No technical jargon: say "publish code" or "put it live", not "merge" or "deploy".',
      '- Bad news always comes with the next step ("Linear is asking you to sign in again. [Open Connectors](#abrir/connectors) and click Sign in.").',
      "- A bit of humor only when the moment is good or neutral, never in an error or when the person is unsure."
    ].join('\n')
  )

// What the Tuca's role and instructions used to be, so a Tuca made before can be brought up to date
// on start (one whose instructions someone changed by hand keeps them).
export const OLD_TUCA_ROLES = ['Monta agentes', 'Builds agents']
const OLD_TUCA_OPENINGS = ['Você é o Tuca, quem monta os agentes deste time.', "You are Tuca, the one who builds this team's agents."]

// Instructions a Tuca was made with, word for word (sha256, base64url), that came out since: one
// still on them gets the ones of now. The first four: the screen links, which taught a Portuguese id
// (#abrir/conectores) in an English workspace. The next two: before the rule on several new agents in
// one reply (one propor_time, never two propor_agente). The last two: when every card waited for a
// click, before his changes inside the app went in at once, with Desfazer.
const OLD_TUCA_INSTRUCTIONS = [
  'GUQOHWTJPFOww7DdkjL8e5ZByImAPztOP77_ReCXisY',
  't-gSl2uWpzYHaqrQ9nAglK29SdKWf27_j-P_0JXDr8c',
  'zOZsXlGeX6l-k6i5rOsHmmyszmPv3eiLXfUbCpcLKIk',
  'aLarfQqst-0nlbaRsEOj74KpMyK7c1Sz6U0yLl8Ca1w',
  'BX29T9SVUHvdO_enbL9UwgWyIb0nAng8cy4-fkcU34I',
  'UiTBaE-bHpjZmJNa-klIjxUdSyEJi63YLU07EMeuA5s',
  'mSSoMbN3ASUDZPz5xVyTExbnAy-uU7zYnvlTZ43rE_M',
  'OGc6ET18nng7NvpxtZ77XmDclbOm7fShxhyGtC6sWxk'
]

// A Tuca made before he helped with the app (or since): its role and instructions, as they come now.
export function tucaUpToDate(tuca: Agent): Agent | undefined {
  const role = OLD_TUCA_ROLES.includes(tuca.role)
  const instructions = OLD_TUCA_OPENINGS.some((o) => tuca.instructions.startsWith(o)) || OLD_TUCA_INSTRUCTIONS.includes(createHash('sha256').update(tuca.instructions).digest('base64url'))
  if (!role && !instructions) return undefined
  return { ...tuca, ...(role ? { role: tucaRole() } : {}), ...(instructions ? { instructions: tucaInstructions() } : {}) }
}
export const tucaRole = (): string => L('Te ajuda com o Tucano', 'Helps you with Tucano')

// What the Tuca sees besides the team: the guide's pages and the screens he can link to.
export function helperSection(): string {
  const screens = Object.entries(SCREENS).map(([slug, s]) => `- [${L('Abrir', 'Open')} ${s.label()}](#abrir/${slug})`)
  return [
    `${L('## O guia do Tucano (leia com ler_guia)', "## Tucano's guide (read with ler_guia)")}\n${guideIndex()}`,
    `${L('## Telas que dá pra abrir (com um link assim na resposta)', '## Screens you can open (with a link like this in the reply)')}\n${screens.join('\n')}\n- [${L('Abrir o perfil de alguém', "Open someone's profile")}](#abrir/agent/<handle>)`
  ].join('\n\n')
}

export const PROPOR_AGENTE: ToolDef = {
  name: 'propor_agente',
  get description() {
    return L(
      'Propõe um agente novo, num card na conversa. Com "aplicar na hora" (veja "Como suas propostas entram"), ele é criado quando sua resposta termina e a pessoa pode desfazer; os conectores esperam ela confirmar. Senão, o card tem Criar, Editar antes e Descartar. Pra ajustar na mesma resposta, chame de novo com tudo.',
      'Proposes a new agent, as a card in the conversation. With "apply right away" (see "How your proposals go in"), it is made when your reply ends and the person can undo it; connectors wait for them to confirm. Otherwise the card has Create, Edit first and Discard. To adjust it in the same reply, call again with everything.'
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
        esforco: { type: 'string', enum: EFFORT_IDS },
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

// A team: several agents proposed at once, each like propor_agente, and the channel they share.
export const PROPOR_TIME: ToolDef = {
  name: 'propor_time',
  get description() {
    return L(
      'Propõe um time: de 2 a 8 agentes de uma vez, cada um como no propor_agente, e um canal com eles. Com "aplicar na hora", é criado quando sua resposta termina e a pessoa pode desfazer; senão, vira um card com Criar time e Descartar.',
      'Proposes a team: 2 to 8 agents at once, each as in propor_agente, and a channel with them. With "apply right away", it is made when your reply ends and the person can undo it; otherwise it becomes a card with Create team and Discard.'
    )
  },
  get inputSchema() {
    const one = PROPOR_AGENTE.inputSchema
    const { primeira_tarefa: _task, motivo: _why, ...each } = (one.properties ?? {}) as Record<string, unknown>
    return {
      type: 'object' as const,
      properties: {
        agentes: { type: 'array', items: { type: 'object', properties: each, required: one.required } },
        canal: { type: 'object', description: L('O canal do time (opcional).', "The team's channel (optional)."), properties: { nome: { type: 'string' }, tema: { type: 'string' }, threads: { type: 'boolean' } }, required: ['nome'] },
        motivo: { type: 'string', description: L('Por que esse time, em uma frase. Aparece no card.', 'Why this team, in one sentence. It shows on the card.') }
      },
      required: ['agentes']
    }
  }
}

export function teamFrom(args: Record<string, unknown>, ctx: Parameters<typeof draftFrom>[1] & { channels: string[] }): { proposal?: Proposal; error?: string } {
  const list = Array.isArray(args['agentes']) ? (args['agentes'] as unknown[]) : []
  if (list.length < 2 || list.length > 8) return { error: L('Um time tem de 2 a 8 agentes. Pra um só, use propor_agente.', 'A team has 2 to 8 agents. For one, use propor_agente.') }
  const agents: AgentDraft[] = []
  for (const [i, raw] of list.entries()) {
    const r = draftFrom((raw ?? {}) as Record<string, unknown>, ctx)
    if (!r.draft) return { error: L(`Agente ${i + 1}: ${r.error}`, `Agent ${i + 1}: ${r.error}`) }
    if (agents.some((a) => a.name.toLowerCase() === r.draft!.name.toLowerCase())) return { error: L(`Dois agentes com o nome ${r.draft.name}.`, `Two agents named ${r.draft.name}.`) }
    const { task: _task, reason: _reason, ...draft } = r.draft
    agents.push(draft)
  }
  const raw = (args['canal'] ?? undefined) as Record<string, unknown> | undefined
  let channel: { name: string; topic?: string; threads?: boolean } | undefined
  if (raw && typeof raw === 'object') {
    const name = channelName(String(raw['nome'] ?? ''))
    if (!name) return { error: L('O canal precisa de um nome.', 'The channel needs a name.') }
    if (ctx.channels.includes(name)) return { error: L(`Já existe o canal #${name}.`, `There's already a #${name} channel.`) }
    const topic = typeof raw['tema'] === 'string' ? raw['tema'].trim().slice(0, 200) : ''
    channel = { name, ...(topic ? { topic } : {}), ...(raw['threads'] === true ? { threads: true } : {}) }
  }
  const reason = typeof args['motivo'] === 'string' ? args['motivo'].trim().slice(0, 300) : ''
  return { proposal: { kind: 'team', agents, ...(channel ? { channel } : {}), ...(reason ? { reason } : {}) } }
}

// The models agents can run on now: the listed ones of a ready plan, and what OpenCode, Pi, Antigravity, Cursor, Grok and Cline list.
export function availableModels(s: Pick<Settings, 'engines'>, listed: Partial<Record<string, string[]>> = {}): { id: string; label: string }[] {
  // Codex's own catalog when there is one (newest first); the app's list otherwise.
  const codex = listed['codex']?.length ? listed['codex'].map((slug) => modelInfo(codexValue(slug)) ?? { id: slug, engine: 'codex' as const, label: slug, hint: '' }) : undefined
  const plan = [...MODELS.filter((m) => m.engine !== 'codex' || !codex), ...(codex ?? []).map((m) => ({ ...m, id: codexValue(m.id) }))]
    .filter((m) => s.engines[m.engine].loggedIn && s.engines[m.engine].route !== 'gateway')
    .map((m) => ({ id: m.id, label: `${ENGINES[m.engine].label} · ${m.label}` }))
  const own = (['opencode', 'pi', 'antigravity', 'cursor', 'grok', 'cline', 'hermes', 'endpoint'] as const).flatMap((e) => (s.engines[e]?.loggedIn ? (listed[e] ?? []).slice(0, 12).map((name) => ({ id: `${e}:${name}`, label: `${ENGINES[e].label} · ${name}` })) : []))
  return [...plan, ...own]
}

// What the Tuca sees of the workspace in his prompt.
// `tuca`: him, whose instructions already say how; any other agent gets the short version, and when to propose.
// How to propose: the same in every reply, so it goes in the system prompt. What there is to propose
// with (models, connectors, the team) changes, and goes in the live context: builderSection.
// For him, how his proposals go in: by themselves when his reply ends (`applyNow`, Settings.tucaApplyNow),
// with what only an admin applies left as cards when he works for a member (`admin` false).
export function builderGuide(ctx: { tuca?: boolean; me?: string; applyNow?: boolean; admin?: boolean }): string {
  const me = ctx.me ?? L('a pessoa', 'the person')
  const how = !ctx.applyNow
    ? L(`Como suas propostas entram: cada uma vira um card com Aplicar e Descartar, e nada muda até ${me} aplicar.`, `How your proposals go in: each becomes a card with Apply and Discard, and nothing changes until ${me} applies it.`)
    : [
        L(
          `Como suas propostas entram: o que muda só dentro do app (agentes, times, canais e rotinas novos; num agente, o nome, a função, as instruções, o modelo, o esforço e a web) é aplicado assim que sua resposta termina, e o card vira um recibo com Desfazer por ${UNDO_HOURS} horas. O que dá acesso (conectores) ou mexe no gasto (o limite do mês) fica num card esperando ${me} confirmar. Então não pergunte se pode: proponha, e diga numa frase o que fez.`,
          `How your proposals go in: what only changes inside the app (new agents, teams, channels and routines; for an agent, its name, role, instructions, model, effort and web) is applied as soon as your reply ends, and the card becomes a receipt with Undo for ${UNDO_HOURS} hours. What grants access (connectors) or changes spending (the monthly limit) stays on a card waiting for ${me} to confirm. So don't ask whether you may: propose, and say in one sentence what you did.`
        ),
        ctx.admin === false && L('Quem você está ajudando não é admin: agentes e times novos, e mudanças em agentes, ficam em cards pra um admin aplicar.', "The person you're helping isn't an admin: new agents and teams, and changes to agents, stay on cards for an admin to apply.")
      ]
        .filter(Boolean)
        .join(' ')
  return ctx.tuca
    ? `${L('## Pra montar agentes', '## For building agents')}\n${how}`
    : L(
          `## Pra propor agentes, times, rotinas e canais\nVocê pode propor, num card que ${me} aplica: um agente novo (propor_agente), um time de agentes com um canal (propor_time), mudar um agente (propor_ajuste), uma rotina de outro agente (propor_rotina; as suas, agende com agendar_rotina) e um canal (propor_canal). Proponha quando ${me} pedir, ou quando for claramente o que resolve o pedido; não no meio de outra tarefa. Nada existe ou muda até ${me} aplicar. Várias mudanças pedidas juntas vão todas na mesma resposta, uma chamada por mudança (viram um grupo de cards com "Aplicar todos"), não uma por mensagem; uma rotina ou um canal pra um agente proposto nessa resposta vem depois dele, com o nome dele. Num agente novo: instruções de 4 a 8 linhas falando com ele, conectores só em leitura se a tarefa não pede escrita, o modelo mais simples que dá conta. Dúvida de como usar o Tucano (telas, configurações, por que algo não funciona) é com o Tuca: diga pra perguntar a ele. Ele não muda o seu acesso nem as suas permissões: se faltar uma, diga a ${me} qual, sem mandar pedir ao Tuca.`,
          `## For proposing agents, teams, routines and channels\nYou can propose, as a card ${me} applies: a new agent (propor_agente), a team of agents with a channel (propor_time), changing an agent (propor_ajuste), a routine for another agent (propor_rotina; your own you schedule with agendar_rotina) and a channel (propor_canal). Propose when ${me} asks, or when it's clearly what solves the request; not in the middle of another task. Nothing exists or changes until ${me} applies it. Several changes asked together all go in the same reply, one call per change (they become a group of cards with "Apply all"), not one per message; a routine or channel for an agent proposed in that reply comes after it, with its name. For a new agent: 4 to 8 lines of instructions talking to it, connectors read-only unless the task needs writing, the simplest model that does the job. Questions about how to use Tucano (screens, settings, why something isn't working) are for the Tuca: say to ask him. He doesn't change your access or permissions: if one is missing, tell ${me} which, without sending them to the Tuca.`
        )
}

export function builderSection(s: Pick<Settings, 'engines'>, ctx: { models: { id: string; label: string }[]; connectors: Connector[]; team: Agent[]; own: string }): string {
  const gateway = (Object.keys(s.engines) as (keyof Settings['engines'])[]).filter((e) => s.engines[e].loggedIn && s.engines[e].route === 'gateway')
  return [
    L('## Pra propor: o que existe agora', '## For proposing: what there is now'),
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
  const instructions = typeof args['instrucoes'] === 'string' ? (args['instrucoes'] as string) : ''
  if (!name || !instructions.trim()) return { error: L('Faltou nome ou instrucoes.', 'Missing nome or instrucoes.') }
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
  const effort = EFFORT_IDS.includes(args['esforco'] as Effort) ? (args['esforco'] as Effort) : 'medium'
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
