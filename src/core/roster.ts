// The team, for an agent to look at. The prompt names the agents of the conversation it's answering in,
// and nothing else: in a DM that is only its own, so an agent there had no way to know who else exists
// or what their handles are. This is the small tool that answers it, and it's what makes calling one in
// (a team-up, see team-up.ts) something an agent can do on purpose instead of only repeating a handle
// the person wrote.
import { L } from '../shared/lang'
import { isTeam, type Agent } from '../shared/types'
import type { ToolDef } from './gateway'

export const EQUIPE: ToolDef = {
  name: 'equipe',
  get description() {
    return L(
      'Lista o time: o handle, o nome e o papel de cada agente, e quem já está nesta conversa. Use quando precisar de um agente que não está aqui (numa DM o prompt só lista você): mencionar o handle dele com @ na sua resposta abre um canal de equipe que leva o que já foi feito aqui.',
      "Lists the team: every agent's handle, name and role, and who is already in this conversation. Use it when you need an agent who isn't here (in a DM the prompt lists only you): mentioning their handle with @ in your reply opens a team-up channel that carries what was already done here."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        busca: {
          type: 'string',
          description: L(
            'Palavras do handle, do nome ou do papel, pra listar só quem interessa (ex.: "auditoria", "planilha"). Deixe de fora pra ver o time todo.',
            'Words of the handle, name or role, to list only the ones that matter (e.g. "audit", "spreadsheet"). Leave it out for the whole team.'
          )
        }
      }
    }
  }
}

export interface RosterCall {
  text: string
  count: number // how many agents the list came back with
}

// One call: the team as lines an agent reads. Archived agents and the Tuca are left out (they can't be
// called in), and the agent asking is marked as itself, so it doesn't call itself by accident.
export function equipeCall(opts: { agents: Agent[]; me: string; here: string[]; busca?: string }): RosterCall {
  const { agents, me, here, busca } = opts
  const words = (busca ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  const all = agents.filter((a) => isTeam(a) && a.id !== me).sort((a, b) => a.name.localeCompare(b.name))
  const found = words.length
    ? all.filter((a) => {
        const hay = `${a.handle} ${a.name} ${a.role}`.toLowerCase()
        return words.every((w) => hay.includes(w))
      })
    : all
  const listed = new Set(here)
  const lines = found.map((a) => {
    const role = a.role ? ` · ${a.role}` : ''
    const where = listed.has(a.id) ? L(' · aqui', ' · here') : ''
    return `- @${a.handle} · ${a.name}${role}${where}`
  })
  const count = found.length === 1 ? L('1 agente', '1 agent') : L(`${found.length} agentes`, `${found.length} agents`)
  const head = words.length
    ? L(`O time, do que bate com "${busca!.trim()}": ${count}.`, `The team, matching "${busca!.trim()}": ${count}.`)
    : L(`O time: ${count} (sem você).`, `The team: ${count} (not counting you).`)
  if (!found.length) {
    return {
      text: L(
        `${head} Nada bateu: tente outras palavras, ou chame sem busca pra ver o time todo.`,
        `${head} Nothing matched: try other words, or call it with no search to see the whole team.`
      ),
      count: 0
    }
  }
  const hint = L(
    'Um que não está aqui se chama escrevendo @handle na sua resposta: a conversa vira um canal de equipe que leva o que já foi feito aqui. Só chame quando precisar mesmo.',
    'One who is not here is called by writing @handle in your reply: the conversation becomes a team-up channel that carries what was already done here. Only call one when you really need to.'
  )
  return { text: `${head}\n${lines.join('\n')}\n\n${hint}`, count: found.length }
}
