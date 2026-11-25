// What the Tuca changes inside the app goes in by itself when his reply ends, and its card offers
// Desfazer: making agents, teams, channels and routines, and changing an agent's name, role,
// instructions, model, effort or web. Every click it saves was an interruption for something that
// only touches the app's own setup and is easy to take back. What grants access or spends money (a
// connector's reach, the month's limit) still waits on a card for the person to confirm.
// This holds the rules for both halves and for taking a change back safely; index.ts applies them.
import { L } from '../shared/lang'
import { UNDO_HOURS, proposalsOf, type Agent, type AgentChanges, type AgentDraft, type Proposal, type Routine, type Run, type Settings } from '../shared/types'

export const UNDO_MS = UNDO_HOURS * 3_600_000

// An agent's fields that grant access or spend money: they always wait for a click.
const ACCESS: readonly string[] = ['grants', 'limit']
const isAccess = (k: string): boolean => ACCESS.includes(k)

// Whether the Tuca's changes apply by themselves: on unless turned off, and never in the
// introduction, where his card fills the first agent's form instead of making one.
export const appliesNow = (s: Pick<Settings, 'tucaApplyNow' | 'onboarding'>): boolean => s.tucaApplyNow !== false && s.onboarding?.done !== false

type AgentProposal = Extract<Proposal, { kind: 'agent' }>
const pick = (c: AgentChanges | undefined, keep: (k: string) => boolean): AgentChanges => Object.fromEntries(Object.entries(c ?? {}).filter(([k]) => keep(k))) as AgentChanges

// A change to an agent, in two: what stays inside the app (applied now) and what grants access
// (a card of its own). Either may be missing.
export function splitChange(p: AgentProposal): { inside?: AgentProposal; access?: AgentProposal } {
  const inside = pick(p.changes, (k) => !isAccess(k))
  const access = pick(p.changes, isAccess)
  if (!Object.keys(access).length) return { inside: p }
  if (!Object.keys(inside).length) return { access: p }
  return {
    inside: { ...p, changes: inside, before: pick(p.before, (k) => !isAccess(k)) },
    access: { kind: 'agent', agentId: p.agentId, changes: access, before: pick(p.before, isAccess), ...(p.reason ? { reason: p.reason } : {}) }
  }
}

// A new agent's connectors, as the card to confirm them once it exists (none: no card).
export function accessCard(agentId: string, d: Pick<AgentDraft, 'name' | 'grants'>): Proposal | undefined {
  if (!Object.keys(d.grants).length) return undefined
  return {
    kind: 'agent',
    agentId,
    changes: { grants: d.grants },
    before: { grants: {} },
    reason: L(`${d.name} já existe; o acesso aos conectores só vale quando você confirmar.`, `${d.name} already exists; access to the connectors only counts once you confirm it.`)
  }
}

// The same value however its keys were ordered.
const stable = (v: unknown): string => JSON.stringify(v ?? null, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x))

// What an agent looked like right after it was made: if any of it changes, someone worked on it
// since, and deleting it would throw that away. Its connectors are left out: confirming the access
// card is part of the same proposal, and taking the agent back takes that access away too.
export const agentStamp = (a: Agent): string =>
  stable({ name: a.name, handle: a.handle, role: a.role, color: a.color, instructions: a.instructions, modelId: a.modelId, effort: a.effort, web: a.web !== false, limit: a.limit, computer: !!a.computer, browser: !!a.browser, autonomy: a.autonomy, actionRules: a.actionRules, memory: a.memory, archived: !!a.archived, folders: a.folders ?? [], reportsTo: a.reportsTo })
// A routine's, the same way. On or off is left out: a one-time routine turns itself off once it ran.
export const routineStamp = (r: Routine): string => stable({ name: r.name, agentId: r.agentId, conversationId: r.conversationId, prompt: r.prompt, schedule: r.schedule, trigger: r.trigger, scope: r.scope })

// The fields an applied change set that the agent no longer has: someone changed them since.
export function changedSince(agent: Agent, changes: AgentChanges): (keyof AgentChanges)[] {
  const norm = (k: string, v: unknown): unknown => (k === 'web' ? v !== false : v)
  return (Object.keys(changes) as (keyof AgentChanges)[]).filter((k) => stable(norm(k, agent[k])) !== stable(norm(k, changes[k])))
}

const FIELDS = (): Record<string, string> => ({ name: L('o nome', 'the name'), role: L('a função', 'the role'), instructions: L('as instruções', 'the instructions'), modelId: L('o modelo', 'the model'), effort: L('o esforço', 'the effort'), web: L('a web', 'the web'), grants: L('os conectores', 'the connectors'), limit: L('o limite', 'the limit') })
const list = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${L('e', 'and')} ${xs.at(-1)}`)

// Why it can't be taken back, said so instead of undoing blindly, with what to do instead.
export const undoErrors = {
  expired: (): string => L(`Passou o prazo pra desfazer (${UNDO_HOURS} horas). Dá pra mudar à mão.`, `The ${UNDO_HOURS}-hour undo period has expired. You can still change it manually.`),
  nothing: (): string => L('Não tem nada pra desfazer aqui.', "There's nothing to undo here."),
  changed: (name: string, fields: string[]): string =>
    L(
      `Mudaram ${list(fields.map((f) => FIELDS()[f] ?? f))} de ${name} depois disso. Desfazer agora apagaria essa mudança: ajuste na página dele.`,
      `${name}'s ${list(fields.map((f) => (FIELDS()[f] ?? f).replace(/^the /, '')))} changed since. Undoing now would throw that away: change it on their page.`
    ),
  edited: (name: string): string => L(`${name} foi ajustado depois de criado. Desfazer agora apagaria esses ajustes: se não quiser mais, arquive na página dele.`, `${name} was adjusted after it was made. Undoing now would throw that away: if you don't want it any more, archive it on its page.`),
  archived: (name: string): string => L(`${name} foi arquivado depois disso: reative na lista de agentes, se quiser.`, `${name} has since been archived. Reactivate it from the agents list if needed.`),
  worked: (name: string): string => L(`${name} já começou a trabalhar. Desfazer apagaria o que foi feito: se não quiser mais, arquive na página dele.`, `${name} has already started working. Undoing would delete what was done: if you don't want it any more, archive it on its page.`),
  boss: (name: string): string => L(`Já tem agentes respondendo a ${name} no organograma. Mude isso antes, ou arquive ${name} na página dele.`, `Agents already answer to ${name} in the org chart. Change that first, or archive ${name} on its page.`),
  routine: (name: string, routine: string): string => L(`${name} já tem a rotina “${routine}”, criada depois. Apague ela em Rotinas antes.`, `${name} already has the routine “${routine}”, made since. Delete it in Routines first.`),
  routineChanged: (routine: string): string => L(`A rotina “${routine}” mudou depois disso. Desfazer agora apagaria essa mudança: apague em Rotinas, se quiser.`, `The routine “${routine}” changed since. Undoing now would throw that away: delete it in Routines if you want.`),
  talked: (channel: string): string => L(`Já tem conversa em #${channel}. Desfazer apagaria o que foi dito: se quiser, apague o canal à mão.`, `There's already talk in #${channel}. Undoing would delete what was said: delete the channel by hand if you want.`)
}

// ---------- a card is settled once ----------

// A reply's cards as the stored message has them, put back on the running reply's own copy before
// that copy is saved again. A reply saves its whole message on every step from what it holds, so a
// card the person applied or discarded while it was still working (the core settles it on the stored
// message) went back to "Create" with the next step, and a second click made the same agents twice.
// Cards are matched by id: the core is the only one that changes a card the reply already saved, and
// one the reply proposed since is only in its copy.
export function keepDecided(run: Run, stored: Run | undefined): Run {
  if (!stored) return run
  const saved = new Map(proposalsOf(stored).flatMap((p) => (p.id ? [[p.id, p] as const] : [])))
  const proposals = run.proposals?.map((p) => (p.id && saved.get(p.id)) || p)
  const draft = run.agentDraft?.id && stored.agentDraft?.id === run.agentDraft.id ? stored.agentDraft : run.agentDraft
  return { ...run, ...(proposals ? { proposals } : {}), ...(draft ? { agentDraft: draft } : {}) }
}

// The cards of a reply that were settled (applied, discarded, undone), kept when it's tried again:
// what they made exists, and a card back at "Create" would make it twice.
export function decidedCards(run: Run | undefined): Pick<Run, 'proposals' | 'agentDraft'> {
  const proposals = proposalsOf(run).filter((p) => p.state)
  return { ...(proposals.length ? { proposals } : {}), ...(run?.agentDraft?.state ? { agentDraft: run.agentDraft } : {}) }
}
