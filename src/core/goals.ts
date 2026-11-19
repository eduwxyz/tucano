// A goal: a person writes "/objetivo …" in a channel, and the agents there work on it by themselves,
// passing the turn to each other with @ (build, review, fix, review again), past the usual limit of
// replies in a row, until one of them marks it done with concluir_objetivo. It stops sooner when it
// reaches GOAL_MAX_TURNS replies, when an agent says the same thing again (it's going around in
// circles), or when a reply neither passes the turn nor ends it. Each way out leaves a line in the
// channel. A goal lives in memory: if the app closes, it ends there, like any chain of replies.
import { L } from '../shared/lang'
import type { ToolDef } from './gateway'

export const GOAL_MAX_TURNS = 12

export type GoalState = 'running' | 'done' | 'capped' | 'stuck' | 'dropped' | 'cut'

export interface Goal {
  id: string // the message that set it
  text: string // what it asks, without the command
  conversationId: string
  threadId?: string
  turns: number // agent replies so far
  state: GoalState
  result?: string // what concluir_objetivo said
  by?: string // the agent that ended it
  last: Map<string, string> // each agent's last reply, to see one going around in circles
}

// "/objetivo …" or "/goal …" at the start of a message: the goal's text, '' when nothing follows,
// undefined when it isn't one.
export function goalText(typed: string): string | undefined {
  const m = /^\s*\/(objetivo|goal)\b\s*([\s\S]*)$/i.exec(typed)
  return m ? m[2]!.trim() : undefined
}

export const CONCLUIR_OBJETIVO: ToolDef = {
  name: 'concluir_objetivo',
  get description() {
    return L(
      'Marca o objetivo deste canal como cumprido e encerra o trabalho do time nele. Use só quando o objetivo estiver feito e conferido de verdade (testado, revisado, aprovado), nunca pra parar no meio. Depois, escreva o resultado na sua resposta e não passe a vez a ninguém.',
      "Marks this channel's goal as done and ends the team's work on it. Use it only when the goal is really done and checked (tested, reviewed, approved), never to stop halfway. Then write the result in your reply and don't pass the turn to anyone."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        resultado: { type: 'string', maxLength: 2_000, description: L('O que ficou pronto e como foi conferido, em poucas linhas.', 'What got done and how it was checked, in a few lines.') }
      },
      required: ['resultado']
    }
  }
}

// What every agent working on a goal is told, on each of its replies.
export function goalTask(g: Goal, me: string): string {
  const left = Math.max(0, GOAL_MAX_TURNS - g.turns)
  return L(
    `Isto é um objetivo que ${me} deu ao time, e vocês trabalham nele sozinhos até cumprir, sem esperar ${me}: “${g.text}”.\nA cada resposta, faça a sua parte de verdade (com as suas ferramentas, não só descrevendo) e passe a vez com @ a quem deve agir em seguida: quem revisa, quem corrige, quem confere de novo. Quem revisa diz o que está bom e o que precisa mudar, com precisão; quem corrige corrige e devolve pra revisão. Quando o objetivo estiver feito e conferido, chame concluir_objetivo com o resultado em vez de passar a vez. Não declare pronto o que ninguém conferiu, e não repita uma resposta: se travou, diga o que falta e a quem. Restam ${left} respostas do time pra este objetivo.`,
    `This is a goal ${me} gave the team, and you work on it by yourselves until it's done, without waiting for ${me}: “${g.text}”.\nOn each reply, do your part for real (with your tools, not just describing it) and pass the turn with @ to whoever should act next: who reviews, who fixes, who checks again. Whoever reviews says what is good and what must change, precisely; whoever fixes fixes it and hands it back for review. When the goal is done and checked, call concluir_objetivo with the result instead of passing the turn. Don't declare done what nobody checked, and don't repeat a reply: if you're stuck, say what's missing and to whom. The team has ${left} replies left for this goal.`
  )
}

// The same reply, read loosely: spacing, case and punctuation don't make it a different one.
export const sameReply = (a: string, b: string): boolean => {
  const loose = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return !!loose(a) && loose(a) === loose(b)
}

// The line left in the channel when a goal ends, by how it ended.
export function goalEnd(g: Goal, agentName: string): string {
  switch (g.state) {
    case 'done':
      return L(`**Objetivo cumprido**, por ${agentName}, em ${g.turns} ${g.turns === 1 ? 'resposta' : 'respostas'}.`, `**Goal done**, by ${agentName}, in ${g.turns} ${g.turns === 1 ? 'reply' : 'replies'}.`)
    case 'capped':
      return L(
        `Parei o objetivo em ${GOAL_MAX_TURNS} respostas, o limite, sem ninguém marcar como cumprido. Pra seguir, escreva /objetivo de novo, dizendo o que falta.`,
        `I stopped the goal at ${GOAL_MAX_TURNS} replies, the limit, with nobody marking it done. To go on, write /goal again, saying what's left.`
      )
    case 'stuck':
      return L(
        `Parei o objetivo: ${agentName} repetiu a mesma resposta, e parecia que o time estava andando em círculos. Pra seguir, escreva /objetivo de novo, dizendo como destravar.`,
        `I stopped the goal: ${agentName} repeated the same reply, and the team seemed to be going around in circles. To go on, write /goal again, saying how to get unstuck.`
      )
    case 'cut':
      return L(
        `O objetivo parou: a resposta de ${agentName} não terminou (falhou, foi parada ou chegou no limite). Pra seguir, escreva /objetivo de novo.`,
        `The goal stopped: ${agentName}'s reply didn't finish (it failed, was stopped or hit its limit). To go on, write /goal again.`
      )
    default:
      return L(
        `O objetivo parou sem ser cumprido: ${agentName} não passou a vez a ninguém nem marcou como cumprido. Pra seguir, escreva /objetivo de novo.`,
        `The goal stopped without being done: ${agentName} neither passed the turn nor marked it done. To go on, write /goal again.`
      )
  }
}
