// What the Tuca has besides building agents: a look at how the workspace is doing (ver_estado),
// and proposals for what already exists (an agent's change, a routine, a channel). A proposal is a
// card with Aplicar and Descartar, like his new agents: nothing changes until the person applies it.
// He sees settings, statuses and error messages, never what was said in a conversation.
import { L } from '../shared/lang'
import { channelName, dateAt, ENGINES, modelInfo, nextRun, validTime, type Schedule, type Agent, type AgentChanges, type Approval, type Connector, type Conversation, type Effort, type GrantLevel, type Routine, type Settings, type Proposal, type AgentDraft, proposalsOf } from '../shared/types'
import type { ToolDef } from './gateway'
import { dateArg } from './routines'

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh']
const DAY = 24 * 3_600_000

// ---------- ver_estado ----------

// The areas ver_estado can be asked for, in English: the enum is in the model's prompt, and a
// Portuguese enum in an English workspace teaches the model Portuguese words for the app. The names
// that came before them keep working, so a memory or a prompt that already says "agentes" resolves.
const AREAS = ['all', 'harnesses', 'connectors', 'agents', 'routines', 'failures'] as const
type Area = (typeof AREAS)[number]
const AREA_ALIASES: Record<string, Area> = {
  tudo: 'all',
  motores: 'harnesses',
  conectores: 'connectors',
  agentes: 'agents',
  rotinas: 'routines',
  falhas: 'failures'
}

export const VER_ESTADO: ToolDef = {
  name: 'ver_estado',
  get description() {
    return L(
      'Mostra como este workspace está: motores e logins, conectores e seus erros, agentes (modelo, limite, acessos), rotinas (próxima, última, erro) e as respostas que falharam nos últimos 7 dias, com a mensagem de erro. Use antes de dizer por que algo não funciona. Não mostra o conteúdo das conversas.',
      "Shows how this workspace is doing: harnesses and sign-ins, connectors and their errors, agents (model, limit, access), routines (next, last, error) and the replies that failed in the last 7 days, with the error. Use it before saying why something doesn't work. It doesn't show what was said in conversations."
    )
  },
  get inputSchema() {
    return { type: 'object' as const, properties: { area: { type: 'string', enum: [...AREAS] } } }
  }
}

export interface StateInput {
  settings: Settings
  connectors: Connector[]
  agents: Agent[] // the team, archived ones too (said so)
  conversations: Conversation[]
  routines: Routine[]
  approvals: Approval[]
  failures: { agentId: string; conversationId: string; at: number; status: string; error?: string }[]
  lastRun: (r: Routine) => { status?: string; error?: string } | undefined // the routine's last reply, how it ended
  now: number
}

const when = (at: number | undefined, now: number): string => {
  if (!at) return L('nunca', 'never')
  const d = new Date(at)
  const ago = now - at
  const rel = ago >= 0 ? (ago < 3_600_000 ? L(`há ${Math.max(1, Math.round(ago / 60_000))} min`, `${Math.max(1, Math.round(ago / 60_000))} min ago`) : ago < DAY ? L(`há ${Math.round(ago / 3_600_000)} h`, `${Math.round(ago / 3_600_000)} h ago`) : L(`há ${Math.round(ago / DAY)} dias`, `${Math.round(ago / DAY)} days ago`)) : ''
  return `${d.toISOString().slice(0, 16).replace('T', ' ')}${rel ? ` (${rel})` : ''}`
}

export function workspaceState(area: unknown, x: StateInput): string {
  const asked = String(area ?? '')
  const want = (AREAS as readonly string[]).includes(asked) ? (asked as Area) : (AREA_ALIASES[asked] ?? 'all')
  const show = (a: Area): boolean => want === 'all' || want === a
  const s = x.settings
  const agentName = (id: string): string => x.agents.find((a) => a.id === id)?.name ?? (id === 'router' ? 'router' : L('agente removido', 'removed agent'))
  const where = (id: string): string => {
    const c = x.conversations.find((c) => c.id === id)
    return !c ? L('conversa removida', 'removed conversation') : c.kind === 'dm' ? L(`DM com ${agentName(c.name)}`, `DM with ${agentName(c.name)}`) : `#${c.name}`
  }
  const out: string[] = [
    `${L('Workspace', 'Workspace')}: ${s.workspaceLabel || s.workspaceName}${s.paused ? L(' · PAUSADO: nenhum agente começa a trabalhar e nenhuma rotina roda', ' · PAUSED: no agent starts working and no routine runs') : ''}${s.quietHours ? L(` · horário de silêncio ${s.quietHours.from}–${s.quietHours.to}`, ` · quiet hours ${s.quietHours.from}–${s.quietHours.to}`) : ''}`
  ]
  if (show('harnesses')) {
    const lines = (Object.keys(s.engines) as (keyof typeof ENGINES)[]).map((e) => {
      const st = s.engines[e]
      const state = st.off ? L('desligado na introdução', 'turned off in the introduction') : !st.installed ? L('não instalado', 'not installed') : st.loggedIn ? L(`pronto${st.account ? ` (${st.account})` : ''}`, `ready${st.account ? ` (${st.account})` : ''}`) : L('instalado, sem login', 'installed, not signed in')
      return `- ${ENGINES[e].label}: ${state}${st.version ? ` · v${st.version}` : ''}${st.route === 'gateway' ? L(` · pelo gateway ${st.gateway ?? ''}`, ` · through gateway ${st.gateway ?? ''}`) : ''}${st.warning ? ` · ${st.warning}` : ''}`
    })
    const accounts = (s.accounts ?? []).map((a) => `- ${a.name} (${ENGINES[a.engine].label}): ${a.loggedIn ? L('com login', 'signed in') : L('sem login', 'not signed in')}`)
    out.push(`## ${L('Motores', 'Harnesses')}\n${lines.join('\n')}${accounts.length ? `\n${L('Contas extras', 'Extra accounts')}:\n${accounts.join('\n')}` : ''}\n${L('Roteador', 'Router')}: ${s.routerModel} · ${L('memória', 'memory')}: ${s.memoryModel} (${s.memoryLearning})`)
  }
  if (show('connectors')) {
    const status: Record<Connector['status'], string> = { connected: L('conectado', 'connected'), connecting: L('conectando', 'connecting'), needs_auth: L('pede login', 'needs sign-in'), error: L('com erro', 'error'), disconnected: L('desconectado', 'disconnected') }
    const lines = x.connectors.map((c) => `- ${c.name}: ${status[c.status]}${c.error ? ` · ${c.error}` : ''}`)
    out.push(`## ${L('Conectores', 'Connectors')}\n${lines.join('\n') || L('nenhum adicionado', 'none added')}`)
  }
  if (show('agents')) {
    const lines = x.agents.map((a) => {
      const m = modelInfo(a.modelId)
      const grants = Object.entries(a.grants).map(([id, g]) => `${x.connectors.find((c) => c.id === id)?.name ?? id} (${g === 'read_write' ? L('escrita', 'write') : g === 'read' ? L('leitura', 'read') : g})`)
      const pct = a.limit ? Math.round((a.used / a.limit) * 100) : 0
      const pending = x.approvals.filter((p) => p.agentId === a.id && p.state === 'pending').length
      return `- ${a.name} (@${a.handle}${a.role ? `, ${a.role}` : ''})${a.archived ? L(' · ARQUIVADO', ' · ARCHIVED') : ''}: ${m ? `${ENGINES[m.engine].label} · ${m.label}` : a.modelId} · ${L('esforço', 'effort')} ${a.effort} · ${L(`${pct}% do limite do mês`, `${pct}% of the month's limit`)}${pct >= 100 ? L(' (ESGOTADO)', ' (USED UP)') : ''} · ${grants.length ? grants.join(', ') : L('sem conectores', 'no connectors')} · ${a.web !== false ? 'web' : L('sem web', 'no web')}${a.computer ? ` · ${a.computerKind === 'mac' ? L('este computador', 'this computer') : 'Docker'}` : ''}${a.browser ? L(' · navegador', ' · browser') : ''}${pending ? L(` · ${pending} aprovação(ões) esperando`, ` · ${pending} approval(s) waiting`) : ''}`
    })
    out.push(`## ${L('Agentes', 'Agents')}\n${lines.join('\n') || L('nenhum ainda', 'none yet')}`)
  }
  if (show('routines')) {
    const lines = x.routines.map((r) => {
      const last = x.lastRun(r)
      const t = r.trigger
      const kind = t?.kind === 'webhook' ? L('chamada local (webhook)', 'local call (webhook)') : t?.kind === 'poll' ? L(`quando aparece algo em ${x.connectors.find((c) => c.id === t.connectorId)?.name ?? t.connectorId} · ${t.tool}, a cada ${t.everyMinutes} min`, `when something new shows in ${x.connectors.find((c) => c.id === t.connectorId)?.name ?? t.connectorId} · ${t.tool}, every ${t.everyMinutes} min`) : `${r.schedule.date ?? (r.schedule.monthDay !== undefined ? L(`dia ${r.schedule.monthDay} de todo mês`, `day ${r.schedule.monthDay} of every month`) : r.schedule.days.join(','))} ${r.schedule.time}${r.schedule.once ? L(' (uma vez)', ' (once)') : ''}`
      return `- ${r.name} (${agentName(r.agentId)}, ${where(r.conversationId)}): ${r.enabled ? L('ligada', 'on') : L('desligada', 'off')} · ${kind} · ${L('próxima', 'next')} ${r.enabled && r.nextAt ? when(r.nextAt, x.now) : '—'} · ${L('última', 'last')} ${when(r.lastAt, x.now)}${last?.status ? ` (${last.status}${last.error ? `: ${last.error}` : ''})` : ''}${t?.kind === 'poll' && t.error ? L(` · erro ao checar: ${t.error}`, ` · check error: ${t.error}`) : ''}`
    })
    out.push(`## ${L('Rotinas', 'Routines')}\n${lines.join('\n') || L('nenhuma', 'none')}`)
  }
  if (show('failures')) {
    const lines = x.failures.map((f) => `- ${when(f.at, x.now)} · ${agentName(f.agentId)} · ${where(f.conversationId)} · ${f.status}${f.error ? `: ${f.error}` : ''}`)
    out.push(`## ${L('Respostas que falharam (7 dias)', 'Replies that failed (7 days)')}\n${lines.join('\n') || L('nenhuma', 'none')}`)
  }
  return out.join('\n\n')
}

// ---------- proposals ----------

const reasonProp = () => ({ motivo: { type: 'string', description: L('Por que, em uma frase. Aparece no card.', 'Why, in one sentence. It shows on the card.') } })
const agentProp = () => ({ agente: { type: 'string', description: L('O @handle do agente.', "The agent's @handle.") } })
// propor_rotina and propor_canal may also name an agent proposed just before, in the same reply.
const agentOrNewProp = () => ({ agente: { type: 'string', description: L('O @handle do agente, ou o nome de um agente proposto antes nesta mesma resposta (propor_agente ou propor_time): a rotina é criada depois dele.', "The agent's @handle, or the name of an agent proposed earlier in this same reply (propor_agente or propor_time): the routine is made after it.") } })

export const PROPOR_AJUSTE: ToolDef = {
  name: 'propor_ajuste',
  get description() {
    return L(
      'Propõe mudar um agente que já existe. Vira um card com o antes e o depois, Aplicar e Descartar: nada muda até a pessoa aplicar. Mande só o que muda; instruções vão inteiras.',
      'Proposes changing an agent that exists. It becomes a card with before and after, Apply and Discard: nothing changes until the person applies it. Send only what changes; instructions go whole.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        ...agentProp(),
        nome: { type: 'string' },
        funcao: { type: 'string' },
        instrucoes: { type: 'string', description: L('As instruções novas, inteiras.', 'The new instructions, whole.') },
        modelo: { type: 'string', description: L('O id de um modelo da lista "Modelos que dá pra usar".', 'The id of a model from the "Models you can use" list.') },
        esforco: { type: 'string', enum: EFFORTS },
        web: { type: 'boolean' },
        conectores: {
          type: 'array',
          description: L('A lista inteira de conectores que ele passa a ter (os de fora saem). Leitura por padrão.', 'The whole list of connectors it gets (the ones left out go). Read-only by default.'),
          items: { type: 'object', properties: { conector: { type: 'string' }, nivel: { type: 'string', enum: ['leitura', 'escrita'] } }, required: ['conector'] }
        },
        limite: { type: 'number', description: L('O limite do mês, em tokens.', "The month's limit, in tokens.") },
        ...reasonProp()
      },
      required: ['agente']
    }
  }
}

export const PROPOR_ROTINA: ToolDef = {
  name: 'propor_rotina',
  get description() {
    return L(
      'Cria uma rotina num horário pra um agente (um pedido que ele faz sozinho nos dias e na hora escolhidos, numa data específica ou todo mês num dia), como um card com Aplicar e Descartar. Use em vez de explicar como criar uma rotina. Gatilhos (webhook, conector) a pessoa liga em Rotinas.',
      'Makes a scheduled routine for an agent (a request it does on its own on the chosen days and time, on a specific date, or every month on a day), as a card with Apply and Discard. Use it instead of explaining how to make a routine. Triggers (webhook, connector) the person sets in Routines.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        ...agentOrNewProp(),
        nome: { type: 'string', description: L('Curto (ex.: "Resumo do dia").', 'Short (e.g. "Daily summary").') },
        pedido: { type: 'string', description: L('O que o agente faz a cada vez, como um pedido a ele.', 'What the agent does each time, as a request to it.') },
        onde: { type: 'string', description: L('"dm" (a DM com o agente, o padrão) ou o nome de um canal de que ele participa.', '"dm" (the DM with the agent, the default) or the name of a channel it is in.') },
        dias: { type: 'array', items: { type: 'number' }, description: L('0 = domingo … 6 = sábado. Não precisa com data ou dia_do_mes.', '0 = Sunday … 6 = Saturday. Not needed with data or dia_do_mes.') },
        hora: { type: 'string', description: L('"HH:MM", hora deste computador. Pode faltar se data já traz a hora.', '"HH:MM", this computer\'s time. May be left out when data has the time.') },
        data: { type: 'string', description: L('Uma data específica, ISO ("2026-11-17" ou "2026-11-17T09:00"): roda uma vez só, nesse dia. Não pode ter passado.', 'A specific date, ISO ("2026-11-17" or "2026-11-17T09:00"): runs once, on that day. It can\'t be past.') },
        dia_do_mes: { type: 'number', description: L('1 a 31: todo mês nesse dia (num mês mais curto, no último).', '1 to 31: every month on that day (in a shorter month, on its last).') },
        uma_vez: { type: 'boolean', description: L('Roda na próxima vez e desliga.', 'Runs next time, then turns off.') },
        ...reasonProp()
      },
      required: ['agente', 'nome', 'pedido']
    }
  }
}

export const PROPOR_CANAL: ToolDef = {
  name: 'propor_canal',
  get description() {
    return L('Propõe um canal novo, com os agentes que ficam nele. Vira um card com Aplicar e Descartar.', 'Proposes a new channel, with the agents in it. It becomes a card with Apply and Discard.')
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        nome: { type: 'string' },
        tema: { type: 'string', description: L('Uma linha dizendo pra que ele serve.', 'One line saying what it is for.') },
        agentes: { type: 'array', items: { type: 'string' }, description: L('Os @handles dos agentes (ou o nome de um proposto antes nesta mesma resposta: entra quando for criado).', "The agents' @handles (or the name of one proposed earlier in this same reply: it joins once made).") },
        threads: { type: 'boolean', description: L('Se cada mensagem abre uma thread (o padrão é responder na conversa).', 'Whether each message opens a thread (by default they answer in the conversation).') },
        ...reasonProp()
      },
      required: ['nome', 'agentes']
    }
  }
}

export interface ProposalCtx {
  agents: Agent[] // the team, not archived
  conversations: Conversation[]
  connectors: Connector[]
  usable: (modelId: string) => boolean
  pending?: string[] // names of the agents proposed earlier in this same reply (a new-agent card, a team): not made yet
}

const text = (args: Record<string, unknown>, k: string, max: number): string => (typeof args[k] === 'string' ? (args[k] as string).trim().slice(0, max) : '')
const findAgent = (ctx: ProposalCtx, raw: unknown): Agent | undefined => {
  const h = String(raw ?? '').trim().replace(/^@/, '').toLowerCase()
  return ctx.agents.find((a) => a.handle.toLowerCase() === h) ?? ctx.agents.find((a) => a.name.toLowerCase() === h)
}
// An agent proposed earlier in this reply, by name: it exists once its card is applied.
const pendingAgent = (ctx: ProposalCtx, raw: unknown): string | undefined => {
  const h = String(raw ?? '').trim().replace(/^@/, '').toLowerCase()
  return ctx.pending?.find((n) => n.toLowerCase() === h || n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-') === h)
}
const unknownAgent = (raw: unknown): string => L(`Não existe o agente "${String(raw ?? '')}". Use um @handle da lista do time.`, `There's no agent "${String(raw ?? '')}". Use a @handle from the team list.`)

function grantsFrom(raw: unknown, connectors: Connector[]): { grants?: Record<string, GrantLevel>; error?: string } {
  const grants: Record<string, GrantLevel> = {}
  const unknown: string[] = []
  for (const c of Array.isArray(raw) ? (raw as unknown[]) : []) {
    const r = (c ?? {}) as Record<string, unknown>
    const wanted = String(r['conector'] ?? '').trim()
    const found = connectors.find((x) => x.name.toLowerCase() === wanted.toLowerCase())
    if (!found) unknown.push(wanted)
    else grants[found.id] = r['nivel'] === 'escrita' ? 'read_write' : 'read'
  }
  if (unknown.length) return { error: L(`Não existe conector ${unknown.map((u) => `"${u}"`).join(', ')}. Use só os da lista.`, `There's no connector ${unknown.map((u) => `"${u}"`).join(', ')}. Use only the ones in the list.`) }
  return { grants }
}

// The agents a reply proposed so far that don't exist yet: its new-agent card, and its teams'.
export function pendingAgents(run: { agentDraft?: AgentDraft; proposal?: Proposal; proposals?: Proposal[] } | undefined): string[] {
  const teams = proposalsOf(run).flatMap((p) => (p.kind === 'team' && !p.state ? p.agents.map((a) => a.name) : []))
  return [...(run?.agentDraft && !run.agentDraft.state ? [run.agentDraft.name] : []), ...teams]
}

export function proposalFrom(tool: string, args: Record<string, unknown>, ctx: ProposalCtx): { proposal?: Proposal; error?: string } {
  const reason = text(args, 'motivo', 300) || undefined
  if (tool === PROPOR_AJUSTE.name) {
    const agent = findAgent(ctx, args['agente'])
    const pending = agent ? undefined : pendingAgent(ctx, args['agente'])
    if (pending) return { error: L(`${pending} ainda não existe: está num card desta resposta. Pra mudar, proponha ele de novo com tudo.`, `${pending} doesn't exist yet: it's in a card of this reply. To change it, propose it again with everything.`) }
    if (!agent) return { error: unknownAgent(args['agente']) }
    const changes: AgentChanges = {}
    const name = text(args, 'nome', 40)
    if (name && name !== agent.name) changes.name = name
    const role = text(args, 'funcao', 40)
    if (role && role !== agent.role) changes.role = role
    const instructions = text(args, 'instrucoes', 8000)
    if (instructions && instructions !== agent.instructions) changes.instructions = instructions
    const model = text(args, 'modelo', 200)
    if (model && model !== agent.modelId) {
      if (!modelInfo(model) || !ctx.usable(model)) return { error: L(`O modelo "${model}" não dá pra usar agora. Use um da lista.`, `The model "${model}" can't be used now. Use one from the list.`) }
      changes.modelId = model
    }
    if (EFFORTS.includes(args['esforco'] as Effort) && args['esforco'] !== agent.effort) changes.effort = args['esforco'] as Effort
    if (typeof args['web'] === 'boolean' && args['web'] !== (agent.web !== false)) changes.web = args['web']
    if (args['conectores'] !== undefined) {
      const g = grantsFrom(args['conectores'], ctx.connectors)
      if (g.error) return { error: g.error }
      if (JSON.stringify(g.grants) !== JSON.stringify(agent.grants)) changes.grants = g.grants!
    }
    if (args['limite'] !== undefined) {
      const n = Math.round(Number(args['limite']))
      if (!Number.isFinite(n) || n < 0) return { error: L('O limite é em tokens: no mínimo 1000, ou 0 para sem limite.', 'The limit is in tokens: at least 1000, or 0 for no limit.') }
      if (n !== agent.limit) changes.limit = n
    }
    if (!Object.keys(changes).length) return { error: L('Nada mudaria: mande só o que é diferente do que ele tem hoje.', 'Nothing would change: send only what differs from what it has now.') }
    const before = Object.fromEntries(Object.keys(changes).map((k) => [k, agent[k as keyof AgentChanges]])) as AgentChanges
    return { proposal: { kind: 'agent', agentId: agent.id, changes, before, ...(reason ? { reason } : {}) } }
  }
  if (tool === PROPOR_ROTINA.name) {
    const agent = findAgent(ctx, args['agente'])
    const pending = agent ? undefined : pendingAgent(ctx, args['agente'])
    if (!agent && !pending) return { error: unknownAgent(args['agente']) }
    const name = text(args, 'nome', 80)
    const prompt = text(args, 'pedido', 4000)
    if (!name || !prompt) return { error: L('Faltou nome ou pedido.', 'Missing nome or pedido.') }
    const days = [...new Set(Array.isArray(args['dias']) ? (args['dias'] as unknown[]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : [])].sort()
    const on = text(args, 'data', 40) ? dateArg(text(args, 'data', 40)) : undefined
    if (on === null) return { error: L('A data vai como "2026-11-17" ou "2026-11-17T09:00".', 'The date goes as "2026-11-17" or "2026-11-17T09:00".') }
    const monthDay = args['dia_do_mes'] === undefined || args['dia_do_mes'] === '' ? undefined : Number(args['dia_do_mes'])
    if (monthDay !== undefined && !(Number.isInteger(monthDay) && monthDay >= 1 && monthDay <= 31)) return { error: L('O dia do mês vai de 1 a 31.', 'The day of the month goes from 1 to 31.') }
    if (!on && monthDay === undefined && !days.length) return { error: L('Escolha pelo menos um dia (0 = domingo … 6 = sábado), uma data ou um dia do mês.', 'Pick at least one day (0 = Sunday … 6 = Saturday), a date or a day of the month.') }
    const time = (text(args, 'hora', 5) || on?.time || '').padStart(5, '0')
    if (!validTime(time)) return { error: L('A hora vai como "HH:MM".', 'The time goes as "HH:MM".') }
    const where = text(args, 'onde', 80).replace(/^#/, '')
    const schedule: Schedule = on
      ? { days: [new Date(dateAt(on.date, '12:00')).getDay()], time, once: true, date: on.date }
      : monthDay !== undefined
        ? { days: [0, 1, 2, 3, 4, 5, 6], time, monthDay }
        : { days, time, ...(args['uma_vez'] === true ? { once: true } : {}) }
    if (on && nextRun(schedule, Date.now()) === undefined) return { error: L(`Essa data já passou (${on.date} ${time}). Use um dia e horário que ainda vão chegar.`, `That date has already passed (${on.date} ${time}). Use a day and time still to come.`) }
    // For an agent proposed in this reply: in its DM, opened once it's made (it's in no channel yet).
    if (!agent) {
      if (where && where.toLowerCase() !== 'dm') return { error: L(`${pending} ainda não existe, então não está em nenhum canal: use a DM.`, `${pending} doesn't exist yet, so it's in no channel: use the DM.`) }
      return { proposal: { kind: 'routine', routine: { name, agentId: '', conversationId: '', prompt, schedule, enabled: true }, needs: [pending!], ...(reason ? { reason } : {}) } }
    }
    let conversationId = '' // the agent's DM: opened when the routine is applied, if it isn't yet
    if (where && where.toLowerCase() !== 'dm') {
      const c = ctx.conversations.find((c) => c.kind === 'channel' && c.name === channelName(where))
      if (!c) return { error: L(`Não existe o canal #${where}.`, `There's no #${where} channel.`) }
      if (!c.members.includes(agent.id)) return { error: L(`${agent.name} não está em #${c.name}. Use a DM, ou um canal de que ele participa.`, `${agent.name} isn't in #${c.name}. Use the DM, or a channel it's in.`) }
      conversationId = c.id
    } else conversationId = ctx.conversations.find((c) => c.kind === 'dm' && c.name === agent.id)?.id ?? ''
    return { proposal: { kind: 'routine', routine: { name, agentId: agent.id, conversationId, prompt, schedule, enabled: true }, ...(reason ? { reason } : {}) } }
  }
  if (tool === PROPOR_CANAL.name) {
    const name = channelName(text(args, 'nome', 80))
    if (!name) return { error: L('Dê um nome ao canal.', 'Give the channel a name.') }
    if (ctx.conversations.some((c) => c.kind === 'channel' && c.name === name)) return { error: L(`Já existe o canal #${name}.`, `There's already a #${name} channel.`) }
    const members: string[] = []
    const needs: string[] = [] // proposed in this reply: they join once made
    for (const raw of Array.isArray(args['agentes']) ? (args['agentes'] as unknown[]) : []) {
      const a = findAgent(ctx, raw)
      const pending = a ? undefined : pendingAgent(ctx, raw)
      if (!a && !pending) return { error: unknownAgent(raw) }
      if (a && !members.includes(a.id)) members.push(a.id)
      if (pending && !needs.includes(pending)) needs.push(pending)
    }
    if (!members.length && !needs.length) return { error: L('Diga quais agentes ficam no canal.', 'Say which agents are in the channel.') }
    const topic = text(args, 'tema', 200)
    return { proposal: { kind: 'channel', name, members, ...(topic ? { topic } : {}), ...(args['threads'] === true ? { threads: true } : {}), ...(needs.length ? { needs } : {}), ...(reason ? { reason } : {}) } }
  }
  return { error: 'unknown proposal' }
}

export const PROPOSAL_TOOLS = (): ToolDef[] => [PROPOR_AJUSTE, PROPOR_ROTINA, PROPOR_CANAL]
