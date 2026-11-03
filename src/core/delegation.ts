// An agent that coordinates a team (a "manager") hands tasks to its agents
// with `delegar`. The manager's turn ends right after; each delegate works in
// the same conversation, on what it was sent; once every task of that turn is
// settled, the manager gets the results back in a new turn of its own, to check
// them, send corrections or answer the person. Nobody polls or waits.
// Any agent can also call a colleague with `chamar_colega` (a question, or a
// part of the work it needs to finish): the same round trip, outside a team.
import { L } from '../shared/lang'
import type { Agent, Delegation, Message, RunStatus } from '../shared/types'
import type { ToolDef } from './gateway'

export const DELEGAR = 'delegar'
export const CHAMAR = 'chamar_colega'
export const MAX_DELEGATIONS = 4 // tasks one reply may hand out
export const MAX_DELEGATION_DEPTH = 3 // levels of managers above a delegate
export const MAX_TEAM_ROUNDS = 4 // times in a row a manager may send work again after its results came back
const MAX_RESULT_CHARS = 6000 // of a reply written elsewhere, handed back to the manager

// A reply still on its way: its task isn't settled yet.
const PENDING: RunStatus[] = ['working', 'waiting_input', 'waiting_approval']

// The agents an agent may hand tasks to right now.
export function teamOf(agent: Agent, agents: Agent[]): Agent[] {
  return (agent.team ?? []).flatMap((id) => {
    const a = agents.find((x) => x.id === id)
    return a && a.id !== agent.id && !a.archived && a.kind !== 'tuca' ? [a] : []
  })
}

// Everyone else it may call: the active agents, not the Tuca, not itself.
export function colleaguesOf(agent: Agent, agents: Agent[]): Agent[] {
  return agents.filter((a) => a.id !== agent.id && !a.archived && a.kind !== 'tuca')
}

export function chamarTool(colleagues: Agent[]): ToolDef {
  return {
    name: CHAMAR,
    description: L(
      `Pede ajuda a um colega quando você precisa da resposta dele pra terminar: uma pergunta da área dele, uma conferência ou uma parte do trabalho. Volta na hora: o colega responde aqui na conversa depois que você encerrar a sua resposta, e você é chamado de novo, sozinho, com o que ele disse, pra continuar. Ele só vê o que você mandar (e esta conversa a partir de agora): diga o contexto e o que precisa. Depois de chamar, ENCERRE a sua resposta com uma frase dizendo quem chamou e por quê; não espere nem chame de novo pra saber se respondeu.`,
      `Asks a colleague for help when you need their answer to finish: a question in their area, a check or a part of the work. It returns right away: the colleague answers here in the conversation after you end your reply, and you're called again, on your own, with what they said, to go on. They only see what you send (and this conversation from now on): give the context and what you need. After calling, END your reply with one sentence saying who you called and why; don't wait or call again to see if they answered.`
    ),
    inputSchema: {
      type: 'object',
      properties: {
        agente: { type: 'string', enum: colleagues.map((a) => a.handle), description: L('O @handle do colega, sem o @.', "The colleague's @handle, without the @.") },
        pedido: { type: 'string', description: L('O que você precisa dele, com o contexto.', 'What you need from them, with the context.') }
      },
      required: ['agente', 'pedido']
    }
  }
}

// Who else is in the workspace, for an agent that may call them (the team, when it has one, is listed apart).
// `where`: in a channel or a DM between agents an @ in its reply hands the turn too; the person's DM stays
// theirs, so from there and on a task, colleagues are reached only through the tools.
export function colleaguesSection(me: string, colleagues: Agent[], opts: { where: 'open' | 'dm' | 'task' }): string {
  return [
    L('## Seus colegas', '## Your colleagues'),
    L(`Outros agentes do Tucano, que você pode chamar de qualquer conversa:`, `Other agents in Tucano, whom you can call from any conversation:`),
    ...colleagues.map((a) => `- ${a.name} (@${a.handle})${a.role ? `, ${a.role}` : ''}`),
    opts.where === 'dm'
      ? L(
          `Esta DM é só sua com ${me}: ninguém mais lê nem escreve aqui, e uma menção com @ não chama ninguém. Quando precisar de um colega, use chamar_colega: o pedido vai pra uma DM entre você e ele, ele responde lá, e você é chamado de novo aqui com a resposta, pra contar a ${me}.`,
          `This DM is just yours with ${me}: no one else reads or writes here, and an @ mention calls no one. When you need a colleague, use chamar_colega: the request goes to a DM between you and them, they answer there, and you're called again here with the answer, to tell ${me}.`
        )
      : opts.where === 'open'
      ? L(
          `Dois jeitos: pra passar a vez a quem deve seguir a conversa, mencione-o com @handle na sua resposta e ele responde em seguida, aqui. Quando você precisa da resposta dele pra terminar o que está fazendo, use chamar_colega: você é chamado de novo com o que ele disse. Chame só quando ajudar de verdade; pra só falar de alguém, escreva o nome sem @.`,
          `Two ways: to hand the turn to whoever should carry the conversation on, mention them with @handle in your reply and they answer next, here. When you need their answer to finish what you're doing, use chamar_colega: you're called again with what they said. Only call when it really helps; to just talk about someone, write the name without @.`
        )
      : L(
          `Enquanto trabalha neste pedido, fale com eles só com chamar_colega (uma menção com @ não chega a ninguém): você é chamado de novo com o que disserem. Não chame quem pediu este trabalho a você: termine, e a sua resposta volta pra essa pessoa.`,
          `While you work on this request, talk to them only with chamar_colega (an @ mention reaches no one): you're called again with what they say. Don't call whoever asked you for this work: finish, and your reply goes back to them.`
        )
  ].join('\n')
}

export function delegarTool(team: Agent[]): ToolDef {
  return {
    name: DELEGAR,
    description: L(
      `Entrega uma tarefa a alguém da sua equipe. Volta na hora: a pessoa trabalha depois que você encerrar a sua resposta. Uma chamada por pessoa, até ${MAX_DELEGATIONS} por resposta; tarefas independentes rodam em paralelo. Ela só vê o que você mandar (e esta conversa a partir de agora): passe o contexto, os dados, o formato e o que conferir. Depois de delegar tudo, ENCERRE a sua resposta com uma frase dizendo o que mandou pra quem. Os resultados voltam pra você sozinhos, numa nova mensagem: não espere, não prometa acompanhar, não chame de novo pra saber se terminou.`,
      `Hands a task to someone on your team. It returns right away: they work after you end your reply. One call per person, up to ${MAX_DELEGATIONS} per reply; independent tasks run in parallel. They only see what you send (and this conversation from now on): pass the context, the data, the format and what to check. After delegating everything, END your reply with one sentence saying what you sent to whom. The results come back to you on their own, in a new message: don't wait, don't promise to follow up, don't call again to see if it's done.`
    ),
    inputSchema: {
      type: 'object',
      properties: {
        agente: { type: 'string', enum: team.map((a) => a.handle), description: L('O @handle de quem faz, sem o @.', 'The @handle of who does it, without the @.') },
        tarefa: { type: 'string', description: L('O que fazer, com todo o contexto que a pessoa precisa.', 'What to do, with all the context they need.') },
        pronto_quando: { type: 'string', description: L('Opcional: o que precisa ser verdade pra contar como feito, em uma ou duas frases.', 'Optional: what must be true for it to count as done, in one or two sentences.') }
      },
      required: ['agente', 'tarefa']
    }
  }
}

// The manager's view of its team, in its system prompt.
export function teamSection(me: string, team: Agent[]): string {
  return [
    L('## Sua equipe', '## Your team'),
    L(
      `Você coordena estes agentes. ${me} fala com você, e você divide o trabalho:`,
      `You coordinate these agents. ${me} talks to you, and you split up the work:`
    ),
    ...team.map((a) => `- ${a.name} (@${a.handle})${a.role ? `, ${a.role}` : ''}${a.instructions.trim() ? `: ${a.instructions.trim().split('\n')[0]!.slice(0, 160)}` : ''}`),
    L(
      `Quando um pedido tiver partes que alguém da equipe faz melhor, ou que dá pra fazer em paralelo, delegue com a ferramenta delegar. Pergunta simples ou rápida, responda você mesmo. Depois de delegar, encerre a resposta: os resultados voltam pra você numa nova mensagem. Quando voltarem, confira contra o que ${me} pediu; se algo faltar ou estiver errado, delegue a correção dizendo exatamente o que mudar; se estiver certo, dê a ${me} o retorno: o resultado, quem fez o quê, o que foi decidido e aplicado, e o que ficou pendente. ${me} só lê o seu retorno, não as conversas da equipe.`,
      `When a request has parts someone on the team does better, or that can run in parallel, delegate them with the delegar tool. For a simple or quick question, answer it yourself. After delegating, end your reply: the results come back to you in a new message. When they do, check them against what ${me} asked; if something is missing or wrong, delegate the fix saying exactly what to change; if it's right, report back to ${me}: the result, who did what, what was decided and applied, and what's left. ${me} only reads your report, not the team's conversations.`
    )
  ].join('\n')
}

// What a delegate is told about where it is, in its system prompt.
export function delegatedWhere(me: string, manager: Pick<Agent, 'name' | 'handle'>, colleague?: boolean): string {
  if (colleague)
    return L(
      `${manager.name} (@${manager.handle}) chamou você pra ajudar. A sua resposta volta pra ${manager.name}, que continua de onde parou; ${me} pode acompanhar.`,
      `${manager.name} (@${manager.handle}) called you in to help. Your reply goes back to ${manager.name}, who picks up where they left off; ${me} can follow along.`
    )
  return L(
    `Você está trabalhando numa tarefa que ${manager.name} (@${manager.handle}) delegou a você. Sua resposta volta pra ${manager.name}, que junta o trabalho da equipe e responde a ${me}.`,
    `You're working on a task ${manager.name} (@${manager.handle}) delegated to you. Your reply goes back to ${manager.name}, who pulls the team's work together and answers ${me}.`
  )
}

// What a delegate's turn is asked, each time it works on its task (the first, after a question, after an approval).
export function briefFor(d: Delegation, manager: Pick<Agent, 'name' | 'handle'> | undefined, me: string, then?: string): string {
  const who = manager ? `${manager.name} (@${manager.handle})` : L('O agente que chamou você', 'The agent that called you')
  return [
    d.kind === 'colega' ? L(`${who} pediu a sua ajuda:`, `${who} asked for your help:`) : L(`${who} delegou esta tarefa a você:`, `${who} delegated this task to you:`),
    `<${L('tarefa', 'task')}>\n${d.task}\n</${L('tarefa', 'task')}>`,
    d.doneWhen && L(`Pronto quando: ${d.doneWhen}`, `Done when: ${d.doneWhen}`),
    L(
      `Faça do começo ao fim e termine com o resultado completo: a sua resposta é o que volta pra ${manager?.name ?? 'quem pediu'}. Se faltar algo que só ${me} sabe, pergunte com ask_user; se precisar de outro colega, chame com chamar_colega. Não mencione ninguém com @.`,
      `Do it start to finish and end with the complete result: your reply is what goes back to ${manager?.name ?? 'whoever asked'}. If you need something only ${me} knows, ask with ask_user; if you need another colleague, call them with chamar_colega. Don't mention anyone with @.`
    ),
    then
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Whether a delegate's latest reply on its task leaves it settled: finished one way or another, and not
// waiting on a team of its own.
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

// The report back to the person once the team's work is done: ${me} never saw the work, only this.
export function reportGuide(me: string): string {
  return L(
    `Quando estiver pronto, dê a ${me} o retorno do trabalho, que é tudo o que ${me} vai ler (as conversas da equipe ficam em outro lugar):\n1. O resultado, direto: a resposta ao que ${me} pediu.\n2. Quem fez o quê: uma linha por pessoa da equipe, com o que entregou.\n3. O que foi decidido, e por quê, quando houve escolha.\n4. O que foi aplicado de fato e onde (arquivo, sistema, PR, mensagem enviada); se nada foi aplicado, diga.\n5. O que ficou pendente, falhou ou precisa de uma decisão de ${me}.\nUse os números, textos, links e nomes de arquivo que vieram nas respostas. Não diga que algo foi feito se nenhuma resposta mostra isso.`,
    `When it's ready, give ${me} the report on the work, which is all ${me} will read (the team's conversations are elsewhere):\n1. The result, plainly: the answer to what ${me} asked.\n2. Who did what: one line per team member, with what they delivered.\n3. What was decided, and why, where there was a choice.\n4. What was actually applied and where (file, system, PR, message sent); if nothing was applied, say so.\n5. What's left, failed or needs a decision from ${me}.\nUse the numbers, texts, links and file names that came in the replies. Don't say something was done if no reply shows it.`
  )
}

// What the manager's turn is asked when its team's results come back.
// `elsewhere`: the reply was written in another conversation (the DM between the two agents), so it goes in
// here in full, clipped; one written here is already in the transcript.
export function resultsTask(me: string, results: { agent: Pick<Agent, 'name' | 'handle'> | undefined; message: Message; elsewhere?: boolean }[], round: number): string {
  return [
    L('Voltou o que você pediu à equipe e aos colegas:', 'What you asked of your team and colleagues is back:'),
    results
      .map(({ agent, message, elsewhere }) => {
        const who = agent ? `${agent.name} (@${agent.handle})` : L('agente removido', 'removed agent')
        const head = `- ${who} ${outcomeOf(message)}. ${message.run!.delegation!.kind === 'colega' ? L('Pedido', 'Request') : L('Tarefa', 'Task')}: ${message.run!.delegation!.task.replace(/\s+/g, ' ').slice(0, 240)}`
        if (!elsewhere) return head
        const text = message.text.trim()
        const said = text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n${L('[… cortado]', '[… cut]')}` : text
        return `${head}\n${L('Resposta', 'Reply')}:\n<${L('resposta', 'reply')}>\n${said || L('(sem texto)', '(no text)')}\n</${L('resposta', 'reply')}>`
      })
      .join('\n\n'),
    results.some((r) => !r.elsewhere) && L('As respostas sem texto aqui estão acima, na conversa.', 'The replies without their text here are above, in the conversation.'),
    round >= MAX_TEAM_ROUNDS
      ? L(
          `Você já mandou trabalho de volta ${round} vezes seguidas: não delegue mais. Dê a ${me} o retorno com o que tem.`,
          `You've sent work back ${round} times in a row: don't delegate any more. Give ${me} the report with what you have.`
        )
      : L(
          `Confira os resultados contra o que ${me} pediu. Se algo faltar ou estiver errado, delegue a correção dizendo exatamente o que mudar, e diga a ${me} em uma frase o que voltou pra quem e por quê.`,
          `Check the results against what ${me} asked. If something is missing or wrong, delegate the fix saying exactly what to change, and tell ${me} in one sentence what went back to whom and why.`
        ),
    reportGuide(me)
  ]
    .filter(Boolean)
    .join('\n\n')
}
