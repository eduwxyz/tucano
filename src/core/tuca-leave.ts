// When no one on the team does what the person asked, the Tuca doesn't say it can't be done, and doesn't
// make a colleague nobody asked for: he asks whether he may do it himself (fazer_eu_mesmo), saying what
// he will use. The question is a card like any other (src/shared/questions.ts) with three answers: this
// once, from now on for that kind of thing, or a colleague instead. What the person allowed is kept as
// theirs (a leave), never on him: each person's Tuca has only what that person let him, and for a reply
// he works with it as if it were his own (withLeaves). A kind of thing he keeps doing himself is worth a
// colleague: at the third time he is told to suggest one.
// A colleague who did not finish their part is the one case of team work he may ask leave for (`instead`):
// the card then has two answers, this once or wait for them. Never "from now on": that would have him do
// that colleague's kind of work for good, with the colleague back.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import type { Answer, Decision } from '../shared/questions'
import type { Agent, Connector, GrantLevel, LeaveAsk, TucaLeave } from '../shared/types'
import type { ToolDef } from './gateway'

export const SUGGEST_AT = 3 // times the same kind of thing came to him before he suggests a colleague for it
const WHAT_MAX = 140 // the question is read at a glance (MAX_QUESTION_LENGTH), with its opening
const KIND_MAX = 60

export const FAZER_EU: ToolDef = {
  name: 'fazer_eu_mesmo',
  get description() {
    return L(
      'Pede licença pra você mesmo fazer um trabalho que ninguém do time faz, dizendo o que vai usar. Vira um card com três respostas: pode fazer (só desta vez), pode e não precisa perguntar de novo pra esse tipo de coisa, ou a pessoa prefere um colega pra isso. Com a licença, você continua numa nova mensagem, já com o que pediu pra usar (a web, os conectores). Um tipo de coisa que ela já liberou (veja "O que você pode fazer você mesmo") passa direto, sem card: chame com o mesmo "tipo", escrito igual, antes de fazer. Nunca use pra trabalho que alguém do time faz: isso é pedir. A exceção é a parte de um colega que não terminou e que ninguém mais do time faz: diga quem em "no_lugar_de", e o card pergunta só se você faz desta vez ou se a pessoa espera o colega.',
      'Asks leave for you to do a piece of work yourself that no one on the team does, saying what you will use. It becomes a card with three answers: go ahead (this once), go ahead and no need to ask again for this kind of thing, or the person prefers a colleague for it. With leave, you go on in a new message, already with what you asked to use (the web, the connectors). A kind of thing they already allowed (see "What you may do yourself") goes straight through, with no card: call it with the same "tipo", written the same, before doing it. Never use it for work someone on the team does: that is pedir. The exception is the part of a colleague who did not finish, which no one else on the team does: say who in "no_lugar_de", and the card asks only whether you do it this once or the person waits for the colleague.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        o_que: { type: 'string', maxLength: WHAT_MAX, description: L('O que você vai fazer, em uma frase, como a pessoa vai ler no card ("Pesquisar o preço dos concorrentes e montar uma tabela").', 'What you will do, in one sentence, as the person will read it on the card ("Look up the competitors\' prices and put them in a table").') },
        tipo: { type: 'string', maxLength: KIND_MAX, description: L('O tipo de coisa, em poucas palavras e sem os detalhes deste pedido ("pesquisa de preços"). Se já existe um igual em "O que você pode fazer você mesmo", escreva igual.', 'The kind of thing, in a few words and without this request\'s details ("price research"). If the same one is already in "What you may do yourself", write it the same.') },
        web: { type: 'boolean', description: L('Se vai buscar e ler páginas da web.', 'Whether you will search and read web pages.') },
        no_lugar_de: { type: 'string', description: L('Só quando a parte era de um colega que não terminou: o nome dele, como veio no aviso de que não terminou.', "Only when the part was a colleague's who did not finish: their name, as it came in the notice that they did not finish.") },
        conectores: {
          type: 'array',
          description: L('Os sistemas que vai usar, da lista "Conectores". Leitura por padrão.', 'The systems you will use, from the "Connectors" list. Read-only by default (nivel "escrita" to write).'),
          items: { type: 'object', properties: { conector: { type: 'string' }, nivel: { type: 'string', enum: ['leitura', 'escrita'] } }, required: ['conector'] }
        }
      },
      required: ['o_que', 'tipo']
    }
  }
}

// "Pesquisa de Preços " and "pesquisa de precos" are the same kind of thing. Letters and digits of any
// script count (a kind named in another alphabet is still a kind); the rest is spacing.
export const kindKey = (kind: string): string =>
  kind
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

// A fazer_eu_mesmo call as what it asks leave for, or what to fix. `admin`: whether the person he works for
// may give access to a connector at all (a member can't: that is an admin's, like any agent's connectors).
// `unfinished`: the colleagues whose part did not get done in this conversation, by name. Only in the place
// of one of them may he ask leave for work the team does.
export function leaveFrom(args: Record<string, unknown>, ctx: { connectors: Connector[]; admin: boolean; unfinished?: string[] }): { ask?: LeaveAsk; error?: string } {
  const text = (k: string, max: number): string => (typeof args[k] === 'string' ? (args[k] as string).replace(/\s+/g, ' ').trim().slice(0, max) : '')
  const what = text('o_que', WHAT_MAX)
  const kind = text('tipo', KIND_MAX)
  if (!what || !kindKey(kind)) return { error: L('Faltou o_que (o que você vai fazer) ou tipo (o tipo de coisa, em poucas palavras).', 'Missing o_que (what you will do) or tipo (the kind of thing, in a few words).') }
  const whose = text('no_lugar_de', 80)
  const instead = whose ? (ctx.unfinished ?? []).find((n) => kindKey(n) === kindKey(whose)) : undefined
  if (whose && !instead)
    return {
      error: L(
        `${whose} não deixou parte nenhuma sem terminar nesta conversa. "no_lugar_de" é só pro colega que não terminou a parte dele; o trabalho que alguém do time faz você passa com pedir.`,
        `${whose} left no part unfinished in this conversation. "no_lugar_de" is only for the colleague who did not finish their part; work someone on the team does you hand over with pedir.`
      )
    }
  const grants: Record<string, GrantLevel> = {}
  const unknown: string[] = []
  for (const c of Array.isArray(args['conectores']) ? (args['conectores'] as unknown[]) : []) {
    const r = (c ?? {}) as Record<string, unknown>
    const wanted = String(r['conector'] ?? '').trim()
    if (/^(?:a )?(?:web|internet)$/i.test(wanted)) continue // the web is its own argument: said here, it is only ignored
    const found = ctx.connectors.find((x) => x.name.toLowerCase() === wanted.toLowerCase())
    if (!found) unknown.push(wanted)
    else grants[found.id] = r['nivel'] === 'escrita' ? 'read_write' : 'read'
  }
  if (unknown.length) {
    const names = unknown.map((u) => `"${u}"`).join(', ')
    return {
      error: L(
        `Não existe conector ${names}. Use só os da lista "Conectores"; se o serviço não está conectado, diga à pessoa que ele precisa ser conectado antes.`,
        `There's no connector ${names}. Use only the ones in the "Connectors" list; if the service isn't connected, tell the person it has to be connected first.`
      )
    }
  }
  if (Object.keys(grants).length && !ctx.admin)
    return {
      error: L(
        'Quem você está ajudando não é admin, e só um admin libera um conector. Peça só o que dá pra fazer sem conector (a web), ou diga que um admin precisa liberar.',
        "The person you're helping isn't an admin, and only an admin gives access to a connector. Ask only for what can be done without one (the web), or say an admin has to allow it."
      )
    }
  const web = args['web'] === true || (Array.isArray(args['conectores']) && (args['conectores'] as unknown[]).some((c) => /^(?:a )?(?:web|internet)$/i.test(String((c as Record<string, unknown> | null)?.['conector'] ?? '').trim())))
  return { ask: { kind, what, ...(web ? { web: true } : {}), ...(Object.keys(grants).length ? { grants } : {}), ...(instead ? { instead } : {}) } }
}

// What a leave lets him use, as people read it: "a web, Gmail (leitura)".
export function leaveTools(ask: Pick<LeaveAsk, 'web' | 'grants'>, connectors: Pick<Connector, 'id' | 'name'>[]): string {
  const list = [
    ...(ask.web ? [L('a web', 'the web')] : []),
    ...Object.entries(ask.grants ?? {}).map(([id, g]) => `${connectors.find((c) => c.id === id)?.name ?? L('um conector removido', 'a removed connector')} (${g === 'read_write' ? L('leitura e escrita', 'read and write') : L('leitura', 'read')})`)
  ]
  return list.join(', ') || L('nada além de escrever', 'nothing but writing')
}

// The three answers, in the order the card shows them: what `leaveChoice` reads back. In a colleague's
// place there are two: this once, or wait for them.
export type LeaveChoice = 'once' | 'always' | 'colleague' | 'wait'
const CHOICES: LeaveChoice[] = ['once', 'always', 'colleague']
const INSTEAD: LeaveChoice[] = ['once', 'wait']
const labels = (): string[] => [L('Pode fazer', 'Go ahead'), L('Pode, e não precisa perguntar de novo pra esse tipo de coisa', 'Go ahead, and no need to ask again for this kind of thing'), L('Prefiro um colega pra isso', "I'd rather have a colleague for this")]
const waitLabel = (): string => L('Prefiro esperar', "I'd rather wait")

// The card: one decision, the first answer recommended (the card goes on with it in one click).
export function leaveDecision(ask: LeaveAsk, connectors: Pick<Connector, 'id' | 'name'>[]): Decision {
  const [once, always, colleague] = labels()
  if (ask.instead)
    return {
      question: `${L(`${ask.instead} não terminou. Posso fazer eu mesmo desta vez?`, `${ask.instead} did not finish. May I do it myself this once?`)} ${ask.what}`.slice(0, 200),
      kind: 'single',
      options: [
        { label: once!, description: L(`Só desta vez. Vou usar: ${leaveTools(ask, connectors)}.`, `This once. I'll use: ${leaveTools(ask, connectors)}.`).slice(0, 200), recommended: true },
        { label: waitLabel(), description: L(`Fica com ${ask.instead}: é só me pedir de novo quando estiver resolvido.`, `It stays with ${ask.instead}: just ask me again once it is sorted out.`).slice(0, 200) }
      ]
    }
  return {
    question: `${L('Ninguém do time faz isso ainda. Posso fazer eu mesmo?', 'No one on the team does this yet. May I do it myself?')} ${ask.what}`.slice(0, 200),
    kind: 'single',
    options: [
      { label: once!, description: L(`Só desta vez. Vou usar: ${leaveTools(ask, connectors)}.`, `This once. I'll use: ${leaveTools(ask, connectors)}.`).slice(0, 200), recommended: true },
      { label: always!, description: L(`Vale pra: ${ask.kind}.`, `It holds for: ${ask.kind}.`).slice(0, 200) },
      { label: colleague!, description: L('Eu monto um colega com esse trabalho e passo o pedido a ele.', 'I build a colleague with this job and pass the request to them.') }
    ]
  }
}

// Which of the three the person picked: on the card (the option's index), or by writing its words (a phone,
// a harness). Anything else they wrote is just their message: nothing is allowed by it.
// A pick sent together with something written in the field allows nothing either: what they wrote may narrow
// or take back what they picked ("só desta vez", "sem o Linear"), and he reads both and asks again.
// `instead`: the card asked in a colleague's place, with its two answers; no other one is read from it.
export function leaveChoice(answers: (Answer | null)[] | undefined, typed: string, instead = false): LeaveChoice | undefined {
  const choices = instead ? INSTEAD : CHOICES
  const picked = answers?.[0]?.chosen
  const said = typed.trim().replace(/[.!\s]+$/, '').toLowerCase()
  if (!said) return picked?.length === 1 && !answers?.[0]?.other ? choices[picked[0]!] : undefined
  // In either language: the card may have been drawn in one and answered from an app in the other.
  const all: [LeaveChoice, string][] = [
    ['once', 'Pode fazer'],
    ['once', 'Go ahead'],
    ['always', 'Pode, e não precisa perguntar de novo pra esse tipo de coisa'],
    ['always', 'Go ahead, and no need to ask again for this kind of thing'],
    ['colleague', 'Prefiro um colega pra isso'],
    ['colleague', "I'd rather have a colleague for this"],
    ['wait', 'Prefiro esperar'],
    ['wait', "I'd rather wait"]
  ]
  const found = all.find(([, label]) => label.toLowerCase() === said)?.[0]
  return found && choices.includes(found) ? found : undefined
}

// A leave made from what was asked and how it was answered. `conversationId`: where it holds, for "this once".
export function newLeave(ask: LeaveAsk, person: string, choice: 'once' | 'always', conversationId: string, at = Date.now()): TucaLeave {
  return { id: randomUUID(), person, ...(choice === 'once' ? { conversationId } : {}), kind: ask.kind, what: ask.what, ...(ask.web ? { web: true } : {}), ...(ask.grants ? { grants: ask.grants } : {}), ...(ask.instead ? { instead: ask.instead } : {}), uses: 1, at }
}

// The leaves that hold in a conversation: the ones for good, and the ones given there.
export const leavesFor = (leaves: TucaLeave[], conversationId: string): TucaLeave[] => leaves.filter((l) => !l.conversationId || l.conversationId === conversationId)

// A connector is an admin's to give, and only while they are one: what a person allowed when they could
// holds no connector once they can't (demoted since). The web, anyone gives.
export const forRole = <T extends Pick<LeaveAsk, 'grants'>>(leaves: T[], admin: boolean): T[] => (admin ? leaves : leaves.map(({ grants: _g, ...rest }) => rest as T))

const reaches = (l: Pick<TucaLeave, 'web' | 'grants'>, ask: Pick<LeaveAsk, 'web' | 'grants'>): boolean =>
  (!ask.web || !!l.web) && Object.entries(ask.grants ?? {}).every(([id, g]) => l.grants?.[id] === 'read_write' || (g === 'read' && l.grants?.[id] === 'read'))

// The leave that already covers what he asks now: the same kind of thing, using nothing more than was allowed.
// One given for good comes before one given in this conversation. One given in a colleague's place covers
// nothing after it: that kind of thing is the colleague's, and the next time is asked again.
export function covering(leaves: TucaLeave[], ask: LeaveAsk): TucaLeave | undefined {
  const same = leaves.filter((l) => !l.instead && kindKey(l.kind) === kindKey(ask.kind) && reaches(l, ask))
  return same.find((l) => !l.conversationId) ?? same[0]
}

// How many times this kind of thing came to him and he did it himself, for this person. Not what he did in
// a colleague's place: someone on the team already does that.
export const timesDone = (leaves: TucaLeave[], kind: string): number => leaves.filter((l) => !l.instead && kindKey(l.kind) === kindKey(kind)).reduce((n, l) => n + l.uses, 0)

// Whether it is time to suggest a colleague for this kind of thing: it came SUGGEST_AT times, and he
// wasn't told before (once is enough: a suggestion at every request would be nagging).
export const shouldSuggest = (leaves: TucaLeave[], kind: string): boolean => timesDone(leaves, kind) >= SUGGEST_AT && !leaves.some((l) => kindKey(l.kind) === kindKey(kind) && l.suggested)

export const suggestNote = (kind: string, times: number, me: string): string =>
  L(
    ` É a ${times}ª vez que ${me} pede esse tipo de coisa (${kind}) e é você quem faz. Ao entregar, sugira um colega pra cuidar disso: chame next_steps com um passo só, "Montar um colega pra ${kind}". Se ${me} marcar, proponha com propor_agente.`,
    ` This is the ${times}${times === 1 ? 'st' : times === 2 ? 'nd' : times === 3 ? 'rd' : 'th'} time ${me} asks for this kind of thing (${kind}) and you are the one doing it. When you deliver, suggest a colleague to take care of it: call next_steps with a single step, "Build a colleague for ${kind}". If ${me} ticks it, propose with propor_agente.`
  )

// The Tuca as he works for this person in this reply: with the web and the connectors their leaves give.
// Only for the reply: nothing of it is saved on him.
export function withLeaves(agent: Agent, leaves: TucaLeave[]): Agent {
  if (!leaves.length) return agent
  const grants: Record<string, GrantLevel> = { ...agent.grants }
  for (const l of leaves) for (const [id, g] of Object.entries(l.grants ?? {})) if (grants[id] !== 'read_write') grants[id] = g
  return { ...agent, web: agent.web === true || leaves.some((l) => l.web), grants }
}

// What he is told when the person answers the card: what to do next, in so many words.
export function leaveTask(ask: LeaveAsk, choice: LeaveChoice, ctx: { me: string; connectors: Pick<Connector, 'id' | 'name'>[]; suggest?: number }): string {
  const tools = leaveTools(ask, ctx.connectors)
  const me = ctx.me
  if (choice === 'wait')
    return L(
      `${me} prefere esperar ${ask.instead ?? ''}. Não faça essa parte. Diga em uma frase que ela fica com ${ask.instead ?? ''} e que é só pedir de novo quando estiver resolvido, e encerre sem chamar ferramenta nenhuma.`,
      `${me} would rather wait for ${ask.instead ?? ''}. Do not do that part. Say in one sentence that it stays with ${ask.instead ?? ''} and that they just have to ask again once it is sorted out, and end without calling any tool.`
    )
  if (choice === 'colleague')
    return L(
      `${me} prefere um colega pra isso. Proponha um com propor_agente, com o que ele precisa pra fazer isto: "${ask.what}" (${tools}). Diga em uma frase que, criado, você passa o pedido a ele; e quando ele existir, passe com pedir.`,
      `${me} would rather have a colleague for this. Propose one with propor_agente, with what they need to do this: "${ask.what}" (${tools}). Say in one sentence that, once made, you pass the request to them; and when they exist, hand it over with pedir.`
    )
  const scope =
    choice === 'always'
      ? L(`${me} deixou você fazer isto você mesmo, e não precisa perguntar de novo pra esse tipo de coisa (${ask.kind})`, `${me} let you do this yourself, and you need not ask again for this kind of thing (${ask.kind})`)
      : ask.instead
        ? L(`${me} deixou você fazer isto você mesmo, desta vez, no lugar de ${ask.instead}`, `${me} let you do this yourself, this once, in ${ask.instead}'s place`)
        : L(`${me} deixou você fazer isto você mesmo, desta vez`, `${me} let you do this yourself, this once`)
  return `${scope}: "${ask.what}". ${L(`Você já tem o que pediu pra usar (${tools}). Faça agora e entregue o resultado, sem perguntar de novo.`, `You already have what you asked to use (${tools}). Do it now and deliver the result, without asking again.`)}${ctx.suggest ? suggestNote(ask.kind, ctx.suggest, me) : ''}`
}

// What he sees of his leaves in a conversation (live: it changes when the person answers a card or takes one back).
export function leaveSection(leaves: TucaLeave[], ctx: { me: string; conversationId: string; connectors: Pick<Connector, 'id' | 'name'>[] }): string {
  const { me } = ctx
  const row = (l: TucaLeave): string => `- ${l.kind} · ${L('usando', 'using')}: ${leaveTools(l, ctx.connectors)}${l.uses > 1 ? L(` · feito ${l.uses} vezes`, ` · done ${l.uses} times`) : ''}`
  // What was given in a colleague's place is no kind of thing he may do himself: it is not listed.
  const standing = leaves.filter((l) => !l.conversationId && !l.instead)
  const here = leaves.filter((l) => l.conversationId === ctx.conversationId && !l.instead)
  const head = L('## O que você pode fazer você mesmo', '## What you may do yourself')
  if (!standing.length && !here.length)
    return `${head}\n${L(
      `Nada ainda. Quando ninguém do time fizer o que ${me} pediu, pergunte com fazer_eu_mesmo: você não tem a web nem conector nenhum sem a licença de ${me}.`,
      `Nothing yet. When no one on the team does what ${me} asked, ask with fazer_eu_mesmo: you have no web and no connector without ${me}'s leave.`
    )}`
  return [
    head,
    standing.length &&
      `${L(
        `${me} já deixou, e não precisa perguntar de novo. Antes de fazer algo de um destes tipos, chame fazer_eu_mesmo com o mesmo "tipo", escrito igual: passa direto, sem card.`,
        `${me} already allowed these, with no need to ask again. Before doing something of one of these kinds, call fazer_eu_mesmo with the same "tipo", written the same: it goes straight through, with no card.`
      )}\n${standing.map(row).join('\n')}`,
    here.length && `${L('Só nesta conversa', 'In this conversation only')}:\n${here.map(row).join('\n')}`,
    L(`Qualquer outro tipo de coisa que ninguém do time faz, pergunte com fazer_eu_mesmo antes.`, `Any other kind of thing no one on the team does, ask with fazer_eu_mesmo first.`)
  ]
    .filter(Boolean)
    .join('\n')
}
