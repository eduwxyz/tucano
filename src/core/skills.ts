// Skills (spec §18): recipes an agent follows for a kind of task. Each agent
// sees the names and when to use them in its prompt, and reads a body with
// ler_skill when a task matches. Agents propose new skills and changes with
// propor_skill; those wait for me, with a diff, and every change keeps the
// version before it, so any can be undone.
import { randomUUID } from 'node:crypto'
import { L } from '../shared/lang'
import { MAX_SKILL_BODY_LENGTH, skillLengthNote, tooLongSkill } from '../shared/skills'
import type { CoreEvent } from '../shared/rpc'
import { skillApplies, type Agent, type Skill, type SkillInput } from '../shared/types'
import type { Db } from './db'
import type { ToolDef } from './gateway'
import { frontmatter, readLinked } from './local-skills'
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'

const MAX_PENDING = 5 // per agent, so an agent can't flood the review

export const LER_SKILL: ToolDef = {
  name: 'ler_skill',
  get description() {
    return L(
      'Lê a receita completa de uma das suas skills. Leia antes de uma tarefa que bate com o "quando usar" dela, e siga.',
      'Reads the full recipe of one of your skills. Read it before a task that matches its "when to use", and follow it.'
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        nome: { type: 'string', description: L('O nome da skill, como na lista.', "The skill's name, as in the list.") },
        arquivo: {
          type: 'string',
          description: L('Um dos arquivos de apoio que a receita lista (ex.: "estilo.md"). Sem ele, lê a receita.', 'One of the supporting files the recipe lists (e.g. "style.md"). Without it, reads the recipe.')
        }
      },
      required: ['nome']
    }
  }
}

export const PROPOR_SKILL: ToolDef = {
  name: 'propor_skill',
  get description() {
    return L(
      'Propõe uma skill nova, ou uma mudança numa sua, quando descobrir um jeito de fazer algo que vale repetir: resolveu em vários passos, saiu de um beco sem saída, ou foi corrigido. Ela só vale depois que o usuário aprovar.',
      "Proposes a new skill, or a change to one of yours, when you find a way of doing something worth repeating: you solved it in several steps, got out of a dead end, or were corrected. It only counts once the user approves it."
    )
  },
  get inputSchema() {
    return {
      type: 'object' as const,
      properties: {
        nome: {
          type: 'string',
          description: L('Curto, com hífens (ex.: "testes-do-core"). O nome de uma skill existente propõe uma mudança nela.', 'Short, with hyphens (e.g. "core-tests"). The name of an existing skill proposes a change to it.')
        },
        quando_usar: { type: 'string', description: L('Em uma frase, em que tipo de tarefa usar.', 'In one sentence, what kind of task to use it for.') },
        receita: {
          type: 'string',
          description: L(
            'Os passos, em Markdown: comandos exatos, armadilhas, como conferir. A receita inteira, não só o que muda: ao mudar uma skill, leia antes com ler_skill e mantenha cada passo, comando e flag que continua valendo.',
            "The steps, in Markdown: exact commands, pitfalls, how to check. The whole recipe, not just what changes: when changing a skill, read it first with ler_skill and keep every step, command and flag that still holds."
          )
        },
        motivo: { type: 'string', description: L('Por que, em uma frase. Aparece pro usuário na revisão.', 'Why, in one sentence. The user sees it in the review.') }
      },
      required: ['nome', 'quando_usar', 'receita']
    }
  }
}

// The files next to a linked skill's SKILL.md, for the agent to open with ler_skill.
function filesNote(source: string): string {
  try {
    const dir = dirname(source)
    const files = readdirSync(dir).filter((f) => /\.(md|txt|json|ya?ml|csv)$/.test(f) && f !== 'SKILL.md')
    return files.length
      ? `\n\n---\n${L('Arquivos de apoio desta skill (leia com ler_skill e o campo arquivo quando a receita mandar)', "This skill's supporting files (read them with ler_skill and the arquivo field when the recipe says so)")}: ${files.join(', ')}`
      : ''
  } catch {
    return ''
  }
}

export const SKILL_TOOL_NAMES = new Set([LER_SKILL.name, PROPOR_SKILL.name])

const exists = (name: string): string => L(`Já existe uma skill chamada ${name}.`, `There's already a skill called ${name}.`)

export const skillName = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

// ---------- who follows what, by agent ----------

// The active skills an agent follows, by name. A skill with an empty `agents` is everyone's.
export function skillsOf(skills: Skill[], agentId: string): string[] {
  return skills.filter((s) => skillApplies(s, agentId)).map((s) => s.name).sort()
}

// "Every active skill", as a whole-list assignment says it.
export const EVERYONE = '*'

// The whole list a bot follows, the way a proposal carries it: the names it keeps, or "*" for every
// active skill. Reads back as "*" when the list is every one of them, so the same assignment written
// two ways is one assignment.
export function skillList(skills: Skill[], agentId: string): string[] {
  const mine = skillsOf(skills, agentId)
  return mine.length > 0 && mine.length === skills.filter((s) => s.state === 'active').length ? [EVERYONE] : mine
}

// Turning "these are the skills this bot follows" into the per-skill `agents` lists the app stores
// (the same rule the agent page's checkboxes follow: one skill, everyone who has it, or "*").
// `writes` are the skills that change; `unknown` are names that aren't active skills; `alone` names a
// skill that could only be taken away by leaving it with no one, which the app has no way to say.
export function assignSkills(
  skills: Skill[],
  agentId: string,
  teamIds: string[],
  names: string[]
): { writes: { id: string; agents: string[] }[]; unknown: string[]; alone?: string } {
  const active = skills.filter((s) => s.state === 'active')
  const all = names.length === 1 && names[0] === EVERYONE
  const known = new Map(active.map((s) => [s.name, s]))
  const unknown = all ? [] : names.filter((n) => !known.has(n))
  if (unknown.length) return { writes: [], unknown }
  const want = new Set(all ? active.map((s) => s.name) : names)
  const writes: { id: string; agents: string[] }[] = []
  for (const s of active) {
    const has = skillApplies(s, agentId)
    const should = want.has(s.name)
    if (should === has) continue
    if (should) {
      // Everyone's already: nothing to write. Otherwise, add this agent.
      if (s.agents.length === 0) continue
      const agents = [...new Set([...s.agents, agentId])]
      writes.push({ id: s.id, agents: agents.length >= teamIds.length && teamIds.every((id) => agents.includes(id)) ? [] : agents })
    } else {
      const from = s.agents.length === 0 ? teamIds : s.agents
      const agents = from.filter((id) => id !== agentId)
      // Left with nobody: empty means everyone, so this bot can't be left out of it.
      if (agents.length === 0) return { writes: [], unknown, alone: s.name }
      writes.push({ id: s.id, agents })
    }
  }
  return { writes, unknown }
}

type Outcome = { reply: string; error?: boolean; skill?: Skill }

export class Skills {
  constructor(private deps: { db: Db; emit: (e: CoreEvent) => void; notify?: (title: string, body: string) => void; now?: () => number }) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private store(k: Skill): Skill {
    this.deps.db.saveSkill(k)
    this.deps.emit({ type: 'skill', skill: k })
    return k
  }

  private drop(id: string): void {
    this.deps.db.removeSkill(id)
    this.deps.emit({ type: 'skill_removed', id })
  }

  // Active skills this agent follows, for its prompt.
  forAgent(agentId: string): Skill[] {
    return this.deps.db.skills().filter((s) => skillApplies(s, agentId))
  }

  // The whole list a bot follows, from a proposal: what it keeps, and nothing else.
  assign(agentId: string, names: string[]): { changed: Skill[]; unknown: string[]; alone?: string } {
    const teamIds = this.deps.db.agents().filter((a) => !a.archived && a.kind !== 'tuca').map((a) => a.id)
    const r = assignSkills(this.deps.db.skills(), agentId, teamIds, names)
    if (r.alone || r.unknown.length) return { changed: [], ...r }
    const changed: Skill[] = []
    for (const w of r.writes) {
      const k = this.deps.db.skill(w.id)
      if (k) changed.push(this.store({ ...k, agents: w.agents, updatedAt: this.now() }))
    }
    return { changed, unknown: [] }
  }

  private active(name: string, except?: string): Skill | undefined {
    return this.deps.db.skills().find((s) => s.state === 'active' && s.name === name && s.id !== except)
  }

  // Me, from the Skills page: takes effect right away, keeping the version before.
  save(input: SkillInput): Skill {
    const name = skillName(input.name)
    const prev = input.id ? this.deps.db.skill(input.id) : undefined
    // A linked skill is edited in Claude Code or Codex; here only who uses it changes.
    if (prev?.source) return this.store({ ...prev, agents: [...new Set(input.agents)], updatedAt: this.now() })
    const description = input.description.trim()
    const body = input.body.trim()
    if (!name) throw new Error(L('Dê um nome pra skill.', 'Give the skill a name.'))
    if (!description) throw new Error(L('Diga quando usar.', 'Say when to use it.'))
    if (!body) throw new Error(L('Escreva a receita.', 'Write the recipe.'))
    if (body.length > MAX_SKILL_BODY_LENGTH) throw new Error(tooLongSkill())
    if (this.active(name, input.id)) throw new Error(exists(name))
    if (prev && prev.state === 'active' && (prev.name !== name || prev.description !== description || prev.body !== body)) this.keep(prev, 'me')
    const at = this.now()
    return this.store({ ...prev, id: prev?.id ?? randomUUID(), name, description, body, agents: [...new Set(input.agents)], state: 'active', replaces: undefined, proposedBy: undefined, reason: undefined, createdAt: prev?.createdAt ?? at, updatedAt: at })
  }

  private keep(k: Skill, by: string): void {
    this.deps.db.addSkillVersion({ skillId: k.id, name: k.name, description: k.description, body: k.body, by, at: this.now() })
  }

  // Me: a skill of my Claude Code or Codex, linked to its file (for all agents unless I pick some).
  link(source: string, agents: string[]): Skill {
    const linked = this.deps.db.skills().find((s) => s.source === source && s.state !== 'pending')
    if (linked) return this.store({ ...linked, state: 'active', agents: [...new Set(agents)], updatedAt: this.now() })
    let text: string
    try {
      text = readFileSync(source, 'utf8')
    } catch {
      throw new Error(L('Não consegui ler essa skill.', "I couldn't read that skill."))
    }
    const fm = frontmatter(text)
    const name = skillName(fm.name || basename(dirname(source)) || '')
    if (!name) throw new Error(L('Essa skill não tem nome.', "That skill has no name."))
    if (this.active(name)) throw new Error(exists(name))
    if (fm.body.trim().length > MAX_SKILL_BODY_LENGTH) throw new Error(tooLongSkill())
    const at = this.now()
    return this.store({ id: randomUUID(), name, description: fm.description || name, body: fm.body.trim(), agents: [...new Set(agents)], state: 'active', source, createdAt: at, updatedAt: at })
  }

  // `ler_skill`: a linked one is read from its file now, and can open its other files.
  read(agent: Agent, args: Record<string, unknown>): Outcome {
    const name = skillName(String(args['nome'] ?? ''))
    const k = this.forAgent(agent.id).find((s) => s.name === name)
    if (!k) return { reply: L(`Você não tem uma skill chamada "${name}".`, `You don't have a skill called "${name}".`), error: true }
    if (!k.source) return { reply: `# ${k.name}\n${L('Quando usar', 'When to use')}: ${k.description}\n\n${k.body}`, skill: k }
    const file = typeof args['arquivo'] === 'string' && args['arquivo'].trim() ? args['arquivo'].trim() : undefined
    try {
      if (file) return { reply: `# ${k.name} · ${file}\n\n${readLinked(k.source, file)}`, skill: k }
      const body = readLinked(k.source)
      if (body.length > MAX_SKILL_BODY_LENGTH) return { reply: tooLongSkill(), error: true }
      if (body !== k.body) this.store({ ...k, body }) // the page shows the version the agents read
      return { reply: `# ${k.name}\n${L('Quando usar', 'When to use')}: ${k.description}\n\n${body}${filesNote(k.source)}`, skill: k }
    } catch (e) {
      return {
        reply: file
          ? L(`Não consegui ler ${file}: ${e instanceof Error ? e.message : String(e)}`, `I couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}`)
          : L(`O arquivo dessa skill não está mais em ${k.source}.`, `This skill's file is no longer at ${k.source}.`),
        error: true
      }
    }
  }

  // `propor_skill`: a new skill, or a change to one of its own, waiting for me.
  propose(agent: Agent, args: Record<string, unknown>): Outcome {
    const text = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
    const name = skillName(text('nome'))
    const description = text('quando_usar')
    const body = text('receita')
    if (!name || !description || !body) return { reply: L('Faltou nome, quando_usar ou receita.', 'Missing nome, quando_usar or receita.'), error: true }
    if (body.length > MAX_SKILL_BODY_LENGTH) return { reply: tooLongSkill(), error: true }
    const all = this.deps.db.skills()
    if (all.filter((s) => s.state === 'pending' && s.proposedBy === agent.id).length >= MAX_PENDING)
      return { reply: L(`Você já tem ${MAX_PENDING} propostas esperando revisão. Espere o usuário decidir.`, `You already have ${MAX_PENDING} proposals waiting for review. Wait for the user to decide.`), error: true }
    const current = this.active(name)
    if (current?.source)
      return {
        reply: L(
          `A skill "${name}" vem de um arquivo do usuário (${current.source}): ela muda lá, não aqui. Diga a ele o que mudaria.`,
          `The skill "${name}" comes from a file of the user's (${current.source}): it changes there, not here. Tell them what you'd change.`
        ),
        error: true
      }
    if (current && !skillApplies(current, agent.id)) return { reply: L(`Já existe uma skill "${name}" que não é sua: escolha outro nome.`, `There's already a skill "${name}" that isn't yours: pick another name.`), error: true }
    if (current && current.description === description && current.body === body) return { reply: L('Essa skill já está assim.', 'That skill is already like that.') }
    // A second proposal for the same thing replaces the first one still waiting.
    const waiting = all.find((s) => s.state === 'pending' && s.proposedBy === agent.id && s.name === name)
    const at = this.now()
    const k = this.store({
      id: waiting?.id ?? randomUUID(),
      name,
      description,
      body,
      agents: current ? current.agents : [agent.id],
      state: 'pending',
      replaces: current?.id,
      proposedBy: agent.id,
      reason: text('motivo') || undefined,
      createdAt: waiting?.createdAt ?? at,
      updatedAt: at
    })
    this.deps.notify?.(
      L(`${agent.name} propõe ${current ? 'mudar a skill' : 'uma skill'}`, `${agent.name} proposes ${current ? 'a change to a skill' : 'a skill'}`),
      `${name}: ${description.replace(/[.\s]+$/, '')}. ${L('Revise em Skills.', 'Review it in Skills.')}`
    )
    const note = skillLengthNote(body.length)
    return {
      reply: `${L(
        `Proposta enviada (${current ? 'mudança na skill' : 'skill nova'} "${name}"). Ela só vale depois que o usuário aprovar, na tela de Skills.`,
        `Proposal sent (${current ? 'change to the skill' : 'new skill'} "${name}"). It only counts once the user approves it, on the Skills screen.`
      )}${note ? `\n\n${note}` : ''}`,
      skill: k
    }
  }

  // A pending proposal becomes the skill (the old version is kept), or goes away.
  decide(id: string, approve: boolean): Skill | undefined {
    const p = this.deps.db.skill(id)
    if (p?.state !== 'pending') return undefined
    if (!approve) return void this.drop(id)
    const target = p.replaces ? this.deps.db.skill(p.replaces) : undefined
    if (target?.state === 'active') {
      this.keep(target, p.proposedBy ?? 'me') // replaced by that agent's proposal
      this.drop(id)
      return this.store({ ...target, description: p.description, body: p.body, updatedAt: this.now() })
    }
    if (this.active(p.name)) throw new Error(exists(p.name))
    return this.store({ ...p, state: 'active', replaces: undefined, updatedAt: this.now() })
  }

  // Back to how it was in that version; the current one is kept, so this can be undone too.
  restore(skillId: string, versionId: number): Skill | undefined {
    const k = this.deps.db.skill(skillId)
    const v = this.deps.db.skillVersions(skillId).find((x) => x.id === versionId)
    if (!k || !v) return undefined
    this.keep(k, 'me')
    return this.store({ ...k, name: this.active(v.name, k.id) ? k.name : v.name, description: v.description, body: v.body, updatedAt: this.now() })
  }

  archive(id: string, archived: boolean): Skill | undefined {
    const k = this.deps.db.skill(id)
    if (!k || k.state === 'pending') return undefined
    if (!archived && this.active(k.name, k.id)) throw new Error(exists(k.name))
    return this.store({ ...k, state: archived ? 'archived' : 'active', updatedAt: this.now() })
  }

  remove(id: string): void {
    this.drop(id)
  }
}
