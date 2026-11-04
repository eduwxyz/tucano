// An agent hands a task (or a question) to another with `delegar`: someone on
// the team it coordinates, or any colleague whose answer it needs. Its turn
// ends right after; the other agent works on what it was sent; once every task
// of that turn is settled, the agent gets the results back in a new turn of its
// own, to check them, send corrections or report to the person. Nobody polls.
// Everything one request sets off shares a token budget (`requestBudget`).
import { L } from '../shared/lang'
import { REQUEST_BUDGET, type Agent, type Conversation, type Delegation, type Message, type RunStatus } from '../shared/types'
import type { ToolDef } from './gateway'

export const DELEGAR = 'delegar'
export const MAX_DELEGATIONS = 4 // tasks one reply may hand out
export const MAX_DELEGATION_DEPTH = 3 // levels of agents above a delegate
export const MAX_TEAM_ROUNDS = 4 // times in a row an agent may send work again after its results came back
const MAX_RESULT_CHARS = 6000 // of a reply written elsewhere, handed back

// A reply still on its way: its task isn't settled yet.
const PENDING: RunStatus[] = ['working', 'waiting_input', 'waiting_approval']

// Everyone it may hand work to: the active agents, not the Tuca, not itself.
export function colleaguesOf(agent: Agent, agents: Agent[]): Agent[] {
  return agents.filter((a) => a.id !== agent.id && !a.archived && a.kind !== 'tuca')
}

// The ones it coordinates, among them.
export function teamOf(agent: Agent, colleagues: Agent[]): Agent[] {
  return colleagues.filter((a) => agent.team?.includes(a.id))
}

export const PEDIR_AJUDA = 'pedir_ajuda'

// Asking a channel instead of someone by name, as a person would: "anyone know X?". It opens a thread there,
// the router picks who can help, and what they answer comes back like a delegated task's result.
export function pedirAjudaTool(channels: Pick<Conversation, 'name'>[]): ToolDef {
  return {
    name: PEDIR_AJUDA,
    description: L(
      'Pergunta num canal quem pode ajudar, como uma pessoa faria ("alguém sabe X?"): use quando você não sabe a resposta, ou o pedido não é da sua área, e não sabe quem sabe (se sabe, use delegar). Abre uma thread no canal; quem puder ajudar responde lá, e a resposta volta pra você numa nova mensagem, como uma tarefa delegada. Escreva a pergunta com o contexto que alguém de fora precisa. Depois ENCERRE a sua resposta com uma frase dizendo onde perguntou.',
      'Asks a channel who can help, as a person would ("anyone know X?"): use it when you don’t know the answer, or the request isn’t your area, and you don’t know who does (if you do, use delegar). It opens a thread in the channel; whoever can help answers there, and the answer comes back to you in a new message, like a delegated task. Write the question with the context someone outside needs. Then END your reply with one sentence saying where you asked.'
    ),
    inputSchema: {
      type: 'object',
      properties: {
        canal: { type: 'string', enum: channels.map((c) => c.name), description: L('O canal onde perguntar, sem o #.', 'The channel to ask in, without the #.') },
        pergunta: { type: 'string', description: L('A pergunta, com o contexto que quem responder precisa.', 'The question, with the context whoever answers needs.') }
      },
      required: ['canal', 'pergunta']
    }
  }
}

export function delegarTool(reachable: Agent[]): ToolDef {
  return {
    name: DELEGAR,
    description: L(
      `Passa uma tarefa ou uma pergunta a outro agente: alguém da sua equipe, ou um colega quando você precisa da resposta dele pra terminar. Volta na hora: ele trabalha depois que você encerrar a sua resposta. Uma chamada por agente, até ${MAX_DELEGATIONS} por resposta; tarefas independentes rodam em paralelo. Ele só vê o que você mandar: passe o contexto, os dados, o formato e o que conferir. Depois de delegar tudo, ENCERRE a sua resposta com uma frase dizendo o que mandou pra quem. Os resultados voltam pra você sozinhos, numa nova mensagem: não espere, não prometa acompanhar, não chame de novo pra saber se terminou.`,
      `Hands a task or a question to another agent: someone on your team, or a colleague when you need their answer to finish. It returns right away: they work after you end your reply. One call per agent, up to ${MAX_DELEGATIONS} per reply; independent tasks run in parallel. They only see what you send: pass the context, the data, the format and what to check. After delegating everything, END your reply with one sentence saying what you sent to whom. The results come back to you on their own, in a new message: don't wait, don't promise to follow up, don't call again to see if it's done.`
    ),
    inputSchema: {
      type: 'object',
      properties: {
        agente: { type: 'string', enum: reachable.map((a) => a.handle), description: L('O @handle de quem faz, sem o @.', 'The @handle of who does it, without the @.') },
        tarefa: { type: 'string', description: L('O que fazer ou responder, com todo o contexto que ele precisa.', 'What to do or answer, with all the context they need.') },
        pronto_quando: { type: 'string', description: L('Opcional: o que precisa ser verdade pra contar como feito, em uma ou duas frases.', 'Optional: what must be true for it to count as done, in one or two sentences.') }
      },
      required: ['agente', 'tarefa']
    }
  }
}

// Who it can hand work to, in its system prompt. `where`: the person's DM stays theirs, and on a task it
// never hands work back up, so both say how the others are reached.
export function teamSection(me: string, team: Agent[], others: Agent[], where: 'dm' | 'task' | 'open'): string {
  const line = (a: Agent, about: boolean): string => `- ${a.name} (@${a.handle})${a.role ? `, ${a.role}` : ''}${about && a.instructions.trim() ? `: ${a.instructions.trim().split('\n')[0]!.slice(0, 160)}` : ''}`
  return [
    L('## Sua equipe e seus colegas', '## Your team and your colleagues'),
    team.length > 0 && L(`Você coordena estes agentes: ${me} fala com você, e você divide o trabalho.`, `You coordinate these agents: ${me} talks to you, and you split up the work.`),
    ...team.map((a) => line(a, true)),
    others.length > 0 && (team.length ? L('Outros colegas, pra quando precisar da resposta deles:', 'Other colleagues, for when you need their answer:') : L('Colegas, pra quando precisar da resposta deles:', 'Colleagues, for when you need their answer:')),
    ...others.map((a) => line(a, false)),
    team.length > 0 &&
      L(
        `Quando um pedido tiver partes que alguém da equipe faz melhor, ou que dá pra fazer em paralelo, delegue com a ferramenta delegar. Pergunta simples ou rápida, responda você mesmo. Quando os resultados voltarem, confira contra o que ${me} pediu, delegue a correção do que faltar, e dê a ${me} o retorno.`,
        `When a request has parts someone on the team does better, or that can run in parallel, delegate them with the delegar tool. For a simple or quick question, answer it yourself. When the results come back, check them against what ${me} asked, delegate the fix for what's missing, and report back to ${me}.`
      ),
    where === 'dm' &&
      L(
        `Esta DM é só sua com ${me}: ninguém mais lê nem escreve aqui, e uma menção com @ não chama ninguém. O que você delega vai pra uma DM entre você e o outro agente, e você é chamado de novo aqui com a resposta.`,
        `This DM is just yours with ${me}: no one else reads or writes here, and an @ mention calls no one. What you delegate goes to a DM between you and the other agent, and you're called again here with the answer.`
      ),
    where === 'task' &&
      L(
        `Enquanto trabalha neste pedido, chame os outros só com delegar (uma menção com @ não chega a ninguém). Não chame quem te passou este trabalho: termine, e a sua resposta volta pra essa pessoa.`,
        `While you work on this request, reach the others only with delegar (an @ mention reaches no one). Don't call whoever handed you this work: finish, and your reply goes back to them.`
      )
  ]
    .filter(Boolean)
    .join('\n')
}

// Called at once with other agents (several @ in one message, or the router picking two): they answer in turn,
// in the thread. The first splits the work; the next ones do only what was left to them, or say it's covered.
export function togetherSection(me: string, before: Agent[], after: Agent[]): string {
  const tag = (a: Agent): string => `${a.name} (@${a.handle}${a.role ? `, ${a.role}` : ''})`
  const list = (as: Agent[]): string => as.map(tag).join(L(' e ', ' and '))
  const head = L('## Chamado junto com outros agentes', '## Called together with other agents')
  if (!before.length)
    return [
      head,
      L(
        `${me} chamou você junto com ${list(after)}. Vocês respondem um de cada vez, nesta thread, e você é o primeiro. Comece dividindo o trabalho: em uma linha, diga o que você vai fazer e o que fica com cada um, pelo papel de cada um. Depois faça só a sua parte; a dos outros, eles fazem em seguida. Se o pedido é uma coisa só, que um faz sozinho, diga quem faz (você, se for o seu papel) e que os outros não precisam repetir.`,
        `${me} called you together with ${list(after)}. You answer one at a time, in this thread, and you go first. Start by splitting the work: in one line, say what you'll do and what goes to each of the others, by their roles. Then do only your part; they do theirs right after you. If the request is a single thing one of you does alone, say who does it (you, if it's your role) and that the others needn't repeat it.`
      )
    ].join('\n')
  return [
    head,
    L(
      `${me} chamou você junto com ${list([...before, ...after])}. Vocês respondem um de cada vez, nesta thread: ${list(before)} já respondeu, logo acima, e pode ter dividido o trabalho. Faça só a parte que ficou com você. Não refaça nem repita o que já foi feito ou dito; se o pedido já está coberto, diga isso em uma frase e pare.`,
      `${me} called you together with ${list([...before, ...after])}. You answer one at a time, in this thread: ${list(before)} already answered, right above, and may have split the work. Do only the part left to you. Don't redo or repeat what was already done or said; if the request is already covered, say so in one sentence and stop.`
    )
  ].join('\n')
}

// What a delegate is told about where it is, in its system prompt.
export function delegatedWhere(me: string, by: Pick<Agent, 'name' | 'handle'>, asked?: string): string {
  if (asked)
    return L(
      `${by.name} (@${by.handle}) perguntou em #${asked} quem pode ajudar, e você foi chamado pra responder. A sua resposta volta pra ${by.name}, que continua o pedido de ${me}. Se outro agente já respondeu na thread, acrescente só o que falta, ou concorde em uma frase.`,
      `${by.name} (@${by.handle}) asked in #${asked} who can help, and you were called to answer. Your reply goes back to ${by.name}, who goes on with ${me}'s request. If another agent already answered in the thread, add only what's missing, or agree in one sentence.`
    )
  return L(
    `Você está trabalhando num pedido que ${by.name} (@${by.handle}) te passou. A sua resposta volta pra ${by.name}, que continua de onde parou e responde a ${me}.`,
    `You're working on a request ${by.name} (@${by.handle}) handed you. Your reply goes back to ${by.name}, who picks up where they left off and answers ${me}.`
  )
}

// What a delegate's turn is asked, each time it works on its task (the first, after a question, after an approval).
export function briefFor(d: Delegation, by: Pick<Agent, 'name' | 'handle'> | undefined, me: string, then?: string): string {
  const who = by ? `${by.name} (@${by.handle})` : L('O agente que chamou você', 'The agent that called you')
  return [
    d.asked ? L(`${who} perguntou em #${d.asked}:`, `${who} asked in #${d.asked}:`) : L(`${who} te passou isto:`, `${who} handed you this:`),
    `<${L('tarefa', 'task')}>\n${d.task}\n</${L('tarefa', 'task')}>`,
    d.doneWhen && L(`Pronto quando: ${d.doneWhen}`, `Done when: ${d.doneWhen}`),
    L(
      `Faça do começo ao fim e termine com o resultado completo: a sua resposta é o que volta pra ${by?.name ?? 'quem pediu'}. Se faltar algo que só ${me} sabe, pergunte com ask_user. Não mencione ninguém com @.`,
      `Do it start to finish and end with the complete result: your reply is what goes back to ${by?.name ?? 'whoever asked'}. If you need something only ${me} knows, ask with ask_user. Don't mention anyone with @.`
    ),
    then
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Whether a delegate's latest reply on its task leaves it settled: finished one way or another, and not
// waiting on work it handed out itself.
export function settled(latest: Message | undefined): boolean {
  return !!latest?.run && !PENDING.includes(latest.run.status) && (!latest.run.delegated?.length || !!latest.run.released)
}

const outcomeOf = (m: Message): string => {
  const run = m.run!
  switch (run.status) {
    case 'done':
      return L('terminou', 'finished')
    case 'paused':
      return L('pausou no teto de gasto da resposta, com parte do trabalho', 'paused at its reply cap, with part of the work')
    case 'limit_reached':
      return L('parou no limite de tokens do mês', "stopped at the month's token limit")
    case 'stopped':
      return L(`foi parado por quem usa o app`, 'was stopped by the person')
    case 'interrupted':
      return L('foi interrompido (o app fechou)', 'was interrupted (the app closed)')
    default:
      return L(`falhou${run.error ? `: ${run.error}` : ''}`, `failed${run.error ? `: ${run.error}` : ''}`)
  }
}

// "1,2 mi", "850 mil"
const tokens = (n: number): string => (n >= 1_000_000 ? L(`${(n / 1_000_000).toFixed(1).replace('.', ',')} mi`, `${(n / 1_000_000).toFixed(1)}M`) : L(`${Math.round(n / 1000)} mil`, `${Math.round(n / 1000)}k`))

// When one request has spent its budget: no more work goes out, and the agents finish with what they have.
export function requestCap(spent: number, budget = REQUEST_BUDGET): string | undefined {
  return spent >= budget
    ? L(`Este pedido já gastou ${tokens(spent)} tokens somando todos os agentes, o teto é ${tokens(budget)}.`, `This request has spent ${tokens(spent)} tokens across every agent; the cap is ${tokens(budget)}.`)
    : undefined
}

// The report back to the person once the work is done: the person never saw the work, only this.
export function reportGuide(me: string): string {
  return L(
    `Quando estiver pronto, dê a ${me} o retorno do trabalho, que é tudo o que ${me} vai ler (as conversas com os outros agentes ficam em outro lugar):\n1. O resultado, direto: a resposta ao que ${me} pediu.\n2. Quem fez o quê: uma linha por agente, com o que entregou.\n3. O que foi decidido, e por quê, quando houve escolha.\n4. O que foi aplicado de fato e onde (arquivo, sistema, PR, mensagem enviada); se nada foi aplicado, diga.\n5. O que ficou pendente, falhou ou precisa de uma decisão de ${me}.\nUse os números, textos, links e nomes de arquivo que vieram nas respostas. Não diga que algo foi feito se nenhuma resposta mostra isso.`,
    `When it's ready, give ${me} the report on the work, which is all ${me} will read (the conversations with the other agents are elsewhere):\n1. The result, plainly: the answer to what ${me} asked.\n2. Who did what: one line per agent, with what they delivered.\n3. What was decided, and why, where there was a choice.\n4. What was actually applied and where (file, system, PR, message sent); if nothing was applied, say so.\n5. What's left, failed or needs a decision from ${me}.\nUse the numbers, texts, links and file names that came in the replies. Don't say something was done if no reply shows it.`
  )
}

// What an agent's turn is asked when the work it handed out comes back.
// `elsewhere`: the reply was written in another conversation (the DM between the two agents), so it goes in
// here in full, clipped; one written here is already in the transcript. `capped`: the request's budget is spent.
export function resultsTask(me: string, results: { agent: Pick<Agent, 'name' | 'handle'> | undefined; message: Message; elsewhere?: boolean }[], round: number, capped?: string, unanswered: { task: string; where: string }[] = []): string {
  const stop = capped ?? (round >= MAX_TEAM_ROUNDS ? L(`Você já mandou trabalho de volta ${round} vezes seguidas.`, `You've sent work back ${round} times in a row.`) : undefined)
  return [
    L('Voltou o que você delegou:', 'What you delegated is back:'),
    results
      .map(({ agent, message, elsewhere }) => {
        const who = agent ? `${agent.name} (@${agent.handle})` : L('agente removido', 'removed agent')
        const head = `- ${who} ${outcomeOf(message)}. ${L('Tarefa', 'Task')}: ${message.run!.delegation!.task.replace(/\s+/g, ' ').slice(0, 240)}`
        if (!elsewhere) return head
        const text = message.text.trim()
        const said = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n${L('[… cortado]', '[… cut]')}` : text
        return `${head}\n${L('Resposta', 'Reply')}:\n<${L('resposta', 'reply')}>\n${said || L('(sem texto)', '(no text)')}\n</${L('resposta', 'reply')}>`
      })
      .join('\n\n'),
    unanswered.length > 0 &&
      unanswered
        .map((u) => L(`- Ninguém em #${u.where} pôde ajudar com: ${u.task.replace(/\s+/g, ' ').slice(0, 240)}`, `- No one in #${u.where} could help with: ${u.task.replace(/\s+/g, ' ').slice(0, 240)}`))
        .join('\n'),
    results.some((r) => !r.elsewhere) && L('As respostas sem texto aqui estão acima, na conversa.', 'The replies without their text here are above, in the conversation.'),
    stop
      ? L(`${stop} Não delegue mais: dê a ${me} o retorno com o que tem.`, `${stop} Don't delegate any more: give ${me} the report with what you have.`)
      : L(
          `Confira os resultados contra o que ${me} pediu. Se algo faltar ou estiver errado, delegue a correção dizendo exatamente o que mudar, e diga a ${me} em uma frase o que voltou pra quem e por quê.`,
          `Check the results against what ${me} asked. If something is missing or wrong, delegate the fix saying exactly what to change, and tell ${me} in one sentence what went back to whom and why.`
        ),
    reportGuide(me)
  ]
    .filter(Boolean)
    .join('\n\n')
}
