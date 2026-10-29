// Skills (spec §18): recipes the agents follow, kept like pages to read. Agents
// propose; I approve, edit, and undo any change from the history.
import { L } from '../../../shared/lang'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  agentById,
  archiveSkill,
  decideSkill,
  linkSkill,
  loadReport,
  localSkills,
  navigate,
  removeSkill,
  restoreSkill,
  saveSkill,
  skillVersions,
  useStore,
  type LocalSkill,
  type Skill,
  type SkillInput,
  type SkillReport,
  type SkillVersion,
  isTeam
} from '../store'
import { Card, Field, Sheet } from './Pages'
import { ago, AgentAvatar, Icon, time } from './ui'

type Place = { kind: 'list' } | { kind: 'skill'; id: string } | { kind: 'review' }

// "lida 3 vezes · todas terminaram bem"
function result(r?: SkillReport): string {
  const n = r?.reads.replies ?? 0
  if (!r || n === 0) return L('ainda não foi lida', 'not read yet')
  const ok = r.reads.ok
  return L(
    `lida ${n} ${n === 1 ? 'vez' : 'vezes'} · ${ok === n ? (n === 1 ? 'terminou bem' : 'todas terminaram bem') : `${Math.round((ok / n) * 100)}% terminaram bem`}`,
    `read ${n} ${n === 1 ? 'time' : 'times'} · ${ok === n ? (n === 1 ? 'it ended well' : 'all ended well') : `${Math.round((ok / n) * 100)}% ended well`}`
  )
}

const from = (k: Skill): string => (k.source ? L(`do seu ${k.source.includes('/.codex/') ? 'Codex' : 'Claude Code'}`, `from your ${k.source.includes('/.codex/') ? 'Codex' : 'Claude Code'}`) : L(`mudou ${ago(k.updatedAt)}`, `changed ${ago(k.updatedAt)}`))

export function SkillsPage(): ReactNode {
  const skills = useStore((s) => s.skills)
  const [place, setPlace] = useState<Place>({ kind: 'list' })
  const [draft, setDraft] = useState<SkillInput | null>(null)
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [stats, setStats] = useState<SkillReport[]>([])
  useEffect(() => {
    void loadReport().then((r) => setStats(r.skills))
  }, [skills.length])

  const pending = skills.filter((k) => k.state === 'pending')
  const active = skills.filter((k) => k.state === 'active')
  const archived = skills.filter((k) => k.state === 'archived')
  const open = place.kind === 'skill' ? active.find((k) => k.id === place.id) : undefined
  const edit = (k: Skill): void => setDraft({ id: k.id, name: k.name, description: k.description, body: k.body, agents: k.agents, source: k.source })
  const toList = (): void => setPlace({ kind: 'list' })

  const form = draft && (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && setDraft(null)}>
      <div className="form-modal">
        <SkillForm key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
      </div>
    </div>
  )

  if (open)
    return (
      <>
        <SkillPage skill={open} stat={stats.find((x) => x.skillId === open.id)} onBack={toList} onEdit={() => edit(open)} />
        {form}
      </>
    )

  if (place.kind === 'review' && pending.length > 0)
    return (
      <Sheet back={{ label: 'Skills', onClick: toList }} title={L('Propostas', 'Proposals')} lede={L('Dos agentes. Só entram em uso se você aprovar.', 'From the agents. They only go into use if you approve.')}>
        {pending.map((k) => (
          <Proposal key={k.id} proposal={k} />
        ))}
      </Sheet>
    )

  return (
    <Sheet
      title="Skills"
      lede={L('Receitas que os agentes seguem pra um tipo de tarefa.', 'Recipes the agents follow for a kind of task.')}
      actions={
        <>
          <button className="text-btn" onClick={() => setAdding(true)}>
            {L('Buscar skills existentes', 'Find existing skills')}
          </button>
          <button className="btn btn--primary btn--sm" onClick={() => setDraft({ name: '', description: '', body: '', agents: [] })}>
            <Icon name="plus" size={14} /> {L('Nova skill', 'New skill')}
          </button>
        </>
      }
    >
      {pending.length > 0 && (
        <div className="notice-line">
          <span>
            <b>{pending.length}</b> {pending.length === 1 ? L('proposta dos agentes esperando você', 'proposal from the agents waiting for you') : L('propostas dos agentes esperando você', 'proposals from the agents waiting for you')}
          </span>
          <button onClick={() => setPlace({ kind: 'review' })}>{L('Revisar', 'Review')}</button>
        </div>
      )}

      {active.length === 0 ? (
        <div className="read-empty">
          <p>{L('Nenhuma skill em uso ainda.', 'No skills in use yet.')}</p>
          <p>{L('Escreva uma, traga uma das que você já usa no terminal, ou deixe os agentes proporem: quando resolverem algo em vários passos, eles sugerem guardar o caminho.', 'Write one, bring one you already use in the terminal, or let the agents propose: when they solve something in several steps, they suggest keeping the path.')}</p>
        </div>
      ) : (
        <section className="read-group">
          <h2>{L('Em uso', 'In use')}</h2>
          {active.map((k) => (
            <button key={k.id} className="skill-line" onClick={() => setPlace({ kind: 'skill', id: k.id })}>
              <span className="skill-line__body">
                <strong>{k.name}</strong>
                <span className="skill-line__desc">{k.description}</span>
                <span className="skill-line__meta">
                  <Who ids={k.agents} /> · {result(stats.find((x) => x.skillId === k.id))} · {from(k)}
                </span>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          ))}
        </section>
      )}

      {archived.length > 0 && (
        <section className="read-group">
          <h2>
            <button onClick={() => setShowArchived(!showArchived)}>
              {L('Arquivadas', 'Archived')} ({archived.length}) {showArchived ? '▾' : '▸'}
            </button>
          </h2>
          {showArchived &&
            archived.map((k) => (
              <div key={k.id} className="skill-line skill-line--off">
                <span className="skill-line__body">
                  <strong>{k.name}</strong>
                  <span className="skill-line__desc">{k.description}</span>
                </span>
                <button className="text-btn" onClick={() => archiveSkill(k.id, false)}>
                  {L('Reativar', 'Bring back')}
                </button>
                <button className="text-btn" onClick={() => removeSkill(k.id)}>
                  {L('Apagar', 'Delete')}
                </button>
              </div>
            ))}
        </section>
      )}

      {adding && <AddFromTerminal onClose={() => setAdding(false)} />}
      {form}
    </Sheet>
  )
}

// One skill as a page: when to use it, who does, how it's going, the recipe and its history.
function SkillPage({ skill: k, stat, onBack, onEdit }: { skill: Skill; stat?: SkillReport; onBack: () => void; onEdit: () => void }): ReactNode {
  const [picking, setPicking] = useState(false)
  const setAgents = (agents: string[]): void => void saveSkill({ id: k.id, name: k.name, description: k.description, body: k.body, agents, source: k.source })
  const changed = stat?.changedAt && stat.before && stat.since && stat.before.replies + stat.since.replies > 0
  const pct = (r: { replies: number; ok: number }): string => (r.replies ? `${Math.round((r.ok / r.replies) * 100)}%` : '—')
  return (
    <Sheet
      back={{ label: 'Skills', onClick: onBack }}
      title={k.name}
      lede={k.description}
      actions={
        <>
          <button className="text-btn" onClick={onEdit}>
            {L('Editar', 'Edit')}
          </button>
          <button className="text-btn" onClick={() => (archiveSkill(k.id, true), onBack())}>
            {L('Arquivar', 'Archive')}
          </button>
        </>
      }
    >
      <dl className="skill-facts">
        <div>
          <dt>{L('Quem usa', 'Who uses it')}</dt>
          <dd>
            <Who ids={k.agents} />
            <button className="text-btn" onClick={() => setPicking(!picking)}>
              {picking ? L('pronto', 'done') : L('mudar', 'change')}
            </button>
          </dd>
        </div>
        <div>
          <dt>{L('Como está indo', 'How it’s going')}</dt>
          <dd>
            {result(stat)}
            {changed && (
              <span className="muted">
                {' '}
                · {L('desde a última mudança', 'since the last change')}, {pct(stat.before!)} → {pct(stat.since!)}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt>{L('De onde', 'Source')}</dt>
          <dd>{k.source ? <span title={k.source}>{L(`Lida do arquivo, ${from(k)}: o que você muda lá vale na próxima vez`, `Read from the file, ${from(k)}: what you change there applies next time`)}</span> : L(`Escrita aqui, ${from(k)}`, `Written here, ${from(k)}`)}</dd>
        </div>
      </dl>
      {picking && (
        <div className="skill-pick">
          <AgentPicker value={k.agents} onChange={setAgents} />
        </div>
      )}
      <section className="read-group">
        <h2>{L('Receita', 'Recipe')}</h2>
        {k.body.trim() ? (
          <article className="recipe">
            <Markdown remarkPlugins={[remarkGfm]}>{k.body}</Markdown>
          </article>
        ) : (
          <p className="read-empty">{L(`A receita é lida de ${k.source} a cada uso.`, `The recipe is read from ${k.source} on every use.`)}</p>
        )}
      </section>
      {!k.source && (
        <section className="read-group">
          <h2>{L('Histórico', 'History')}</h2>
          <History skill={k} />
        </section>
      )}
    </Sheet>
  )
}

// Who uses a skill, as faces and names.
function Who({ ids }: { ids: string[] }): ReactNode {
  const agents = useStore((s) => ids.map((id) => agentById(s, id)).filter((a) => !!a))
  if (ids.length === 0) return <span className="who">{L('todos os agentes', 'all agents')}</span>
  return (
    <span className="who">
      {agents.map((a) => (
        <span key={a.id} className="who__one">
          <AgentAvatar agent={a} size={14} /> {a.name}
        </span>
      ))}
    </span>
  )
}

// The skills of the user's Claude Code (and its plugins) and Codex: find one, say who uses it.
function AddFromTerminal({ onClose }: { onClose: () => void }): ReactNode {
  const skills = useStore((s) => s.skills)
  const [found, setFound] = useState<LocalSkill[] | null>(null)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const [picked, setPicked] = useState<LocalSkill | null>(null)
  const [agents, setAgents] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void localSkills().then(setFound, () => setFound([]))
  }, [])
  const needle = q.trim().toLowerCase()
  const shown = (found ?? []).filter((l) => !needle || `${l.name} ${l.description} ${l.origin}`.toLowerCase().includes(needle))
  const linked = (l: LocalSkill): boolean => skills.some((k) => k.source === l.source && k.state === 'active')
  useEffect(() => setAt(0), [q])
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const use = (): void => {
    if (!picked) return
    setError(null)
    linkSkill(picked.source, agents).then(onClose, (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
  }

  return (
    <div className="modal modal--top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search skill-add" role="dialog" aria-label={L('Buscar skills existentes', 'Find existing skills')}>
        {!picked ? (
          <>
            <div className="search__input">
              <Icon name="search" />
              <input
                autoFocus
                value={q}
                placeholder={L('Buscar nas skills do seu Claude Code e do Codex', 'Search the skills of your Claude Code and Codex')}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') onClose()
                  else if (e.key === 'ArrowDown') e.preventDefault(), setAt(Math.min(shown.length - 1, at + 1))
                  else if (e.key === 'ArrowUp') e.preventDefault(), setAt(Math.max(0, at - 1))
                  else if (e.key === 'Enter' && shown[at] && !linked(shown[at]!)) setPicked(shown[at]!)
                }}
              />
            </div>
            <div className="skill-add__list" ref={list}>
              {!found && <p className="skill-add__none">{L('Procurando…', 'Looking…')}</p>}
              {found && shown.length === 0 && <p className="skill-add__none">{L('Nenhuma skill com', 'No skill matching')} “{q.trim()}”.</p>}
              {shown.map((l, i) => {
                const on = linked(l)
                return (
                  <button key={l.source} className={`skill-add__item ${i === at ? 'is-at' : ''}`} disabled={on} onMouseEnter={() => setAt(i)} onClick={() => setPicked(l)}>
                    <span className="skill-add__head">
                      <strong>{l.name}</strong>
                      <span>{l.origin}</span>
                      {l.scripts && <span className="warn-text">{L('precisa de computador', 'needs a computer')}</span>}
                      {on && <span className="tag tag--ok">{L('em uso', 'in use')}</span>}
                    </span>
                    <span className="skill-add__desc">{l.description}</span>
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="skill-add__step">
            <button className="text-btn" onClick={() => setPicked(null)}>
              {L('← Voltar', '← Back')}
            </button>
            <h3>{picked.name}</h3>
            <p>{picked.description}</p>
            {picked.scripts && <p className="warn-text small">{L('Tem scripts: só roda com um agente que tenha computador (Linux ou este computador).', 'It has scripts: it only runs with an agent that has a computer (Linux or this computer).')}</p>}
            <span className="skill-add__label">{L('Quem usa?', 'Who uses it?')}</span>
            <AgentPicker value={agents} onChange={setAgents} />
            {error && <p className="note note--error">{error}</p>}
            <div className="skill-add__acts">
              <span className="muted small">{L('Lida direto do arquivo: o que você mudar nela vale na próxima vez.', 'Read straight from the file: what you change in it applies next time.')}</span>
              <button className="btn btn--primary btn--sm" onClick={use}>
                {L('Usar', 'Use')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Who uses a skill: every agent, or the ones picked (always at least one;
// an empty list means everyone).
export function AgentPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const everyone = value.length === 0
  const toggle = (id: string): void => {
    const next = value.includes(id) ? value.filter((x) => x !== id) : [...value, id]
    if (next.length) onChange(next)
  }
  return (
    <div className="agent-picker">
      <div className="segmented">
        <button type="button" className={everyone ? 'is-active' : ''} onClick={() => onChange([])}>
          {L('Todos os agentes', 'All agents')}
        </button>
        <button type="button" className={everyone ? '' : 'is-active'} onClick={() => everyone && onChange(agents.map((a) => a.id))}>
          {L('Só alguns', 'Only some')}
        </button>
      </div>
      {!everyone && (
        <div className="agent-picker__list">
          {agents.map((a) => {
            const on = value.includes(a.id)
            return (
              <button key={a.id} type="button" className={`agent-pill ${on ? 'is-on' : ''}`} title={on && value.length === 1 ? L('Pelo menos um agente usa a skill', 'At least one agent uses the skill') : undefined} onClick={() => toggle(a.id)}>
                <AgentAvatar agent={a} size={18} />
                {a.name}
                {on && <Icon name="check" size={12} />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

function History({ skill }: { skill: Skill }): ReactNode {
  const [versions, setVersions] = useState<SkillVersion[] | null>(null)
  const [showing, setShowing] = useState<number | null>(null)
  const who = useStore((s) => (by: string) => (by === 'me' ? s.me.name : (agentById(s, by)?.name ?? L('agente', 'agent'))))
  useEffect(() => {
    void skillVersions(skill.id).then(setVersions)
  }, [skill.id, skill.updatedAt])
  if (!versions) return <p className="muted small">{L('Carregando…', 'Loading…')}</p>
  if (versions.length === 0) return <p className="muted small">{L('Nenhuma mudança ainda: esta é a primeira versão.', 'No changes yet: this is the first version.')}</p>
  return (
    <div className="skill__history">
      {versions.map((v) => (
        <div key={v.id}>
          <div className="row row--center small">
            <span className="grow">
              {L('Antes de', 'Before')} {time(v.at)} <span className="muted">· {v.by === 'me' ? L(`mudada por ${who(v.by)}`, `changed by ${who(v.by)}`) : L(`mudada por uma proposta de ${who(v.by)}`, `changed by a proposal from ${who(v.by)}`)}</span>
            </span>
            <button className="link small" onClick={() => setShowing(showing === v.id ? null : v.id)}>
              {showing === v.id ? L('esconder', 'hide') : L('o que mudou', 'what changed')}
            </button>
            <button className="btn btn--xs" onClick={() => restoreSkill(skill.id, v.id)}>
              {L('Voltar a esta', 'Restore this one')}
            </button>
          </div>
          {showing === v.id && <Diff before={`${v.description}\n\n${v.body}`} after={`${skill.description}\n\n${skill.body}`} />}
        </div>
      ))}
    </div>
  )
}

function Proposal({ proposal: p }: { proposal: Skill }): ReactNode {
  const agent = useStore((s) => (p.proposedBy ? agentById(s, p.proposedBy) : undefined))
  const current = useStore((s) => (p.replaces ? s.skills.find((k) => k.id === p.replaces) : undefined))
  return (
    <section className="proposal">
      <header>
        {agent && <AgentAvatar agent={agent} size={20} />}
        <strong>{current ? L(`Mudar ${p.name}`, `Change ${p.name}`) : L(`Nova: ${p.name}`, `New: ${p.name}`)}</strong>
        <span>
          {L(`${agent?.name ?? 'Um agente'} propôs ${ago(p.createdAt)}`, `${agent?.name ?? 'An agent'} proposed ${ago(p.createdAt)}`)}
        </span>
      </header>
      {p.reason && <p className="proposal__why">“{p.reason}”</p>}
      {current ? (
        <Diff before={`${current.description}\n\n${current.body}`} after={`${p.description}\n\n${p.body}`} />
      ) : (
        <>
          <p className="proposal__when">
            <span>{L('Quando usar:', 'When to use:')}</span> {p.description}
          </p>
          <article className="recipe recipe--box">
            <Markdown remarkPlugins={[remarkGfm]}>{p.body}</Markdown>
          </article>
          <p className="proposal__who">
            {L('Vale pra', 'For')} <Who ids={p.agents} />. {L('Depois de aprovar, dá pra liberar pra outros agentes.', 'After approving, you can open it to other agents.')}
          </p>
        </>
      )}
      <div className="proposal__acts">
        <button className="btn btn--sm btn--primary" onClick={() => decideSkill(p.id, true)}>
          {L('Aprovar', 'Approve')}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => decideSkill(p.id, false)}>
          {L('Recusar', 'Refuse')}
        </button>
      </div>
    </section>
  )
}

// Line by line: what was removed and what was added.
function Diff({ before, after }: { before: string; after: string }): ReactNode {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence, enough for recipes of a few hundred lines.
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const lines: { kind: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    // Removed lines before the ones that replace them.
    if (i < n && j < m && a[i] === b[j]) lines.push({ kind: ' ', text: a[i++]! }), j++
    else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push({ kind: '-', text: a[i++]! })
    else lines.push({ kind: '+', text: b[j++]! })
  }
  return (
    <pre className="diff">
      {lines.map((l, k) => (
        <div key={k} className={l.kind === '+' ? 'diff__add' : l.kind === '-' ? 'diff__del' : 'diff__same'}>
          {l.kind} {l.text}
        </div>
      ))}
    </pre>
  )
}

function SkillForm({ draft, onChange, onClose }: { draft: SkillInput; onChange: (d: SkillInput) => void; onClose: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<SkillInput>): void => onChange({ ...draft, ...patch })
  const save = (): void => {
    setError(null)
    saveSkill(draft).then(onClose, (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e)))
  }
  return (
    <div className="agent-form">
      <Card title={draft.id ? L(`Editar ${draft.name}`, `Edit ${draft.name}`) : L('Nova skill', 'New skill')}>
        <div className="grid2">
          <Field label={L('Nome', 'Name')} hint={L('Curto, vira algo como testes-do-core.', 'Short; becomes something like core-tests.')}>
            <input autoFocus value={draft.name} placeholder={L('testes do core', 'core tests')} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label={L('Quando usar', 'When to use')} hint={L('Uma frase. Vai no prompt de cada agente.', 'One sentence. It goes in every agent’s prompt.')}>
            <input value={draft.description} placeholder={L('Ao rodar ou consertar os testes do Core', 'When running or fixing the Core tests')} onChange={(e) => set({ description: e.target.value })} />
          </Field>
        </div>
        {draft.source ? (
          <p className="hint">
            {L('Ligada a', 'Linked to')} <span className="mono">{draft.source}</span>: {L('a receita muda lá, e os agentes leem sempre a versão de agora. Aqui você escolhe quem usa.', 'the recipe changes there, and agents always read the current version. Here you pick who uses it.')}
          </p>
        ) : (
          <Field label={L('Receita', 'Recipe')} hint={L('Os passos, em Markdown: comandos exatos, armadilhas, como conferir.', 'The steps, in Markdown: exact commands, pitfalls, how to check.')}>
            <textarea rows={10} className="mono" value={draft.body} onChange={(e) => set({ body: e.target.value })} />
          </Field>
        )}
        <Field label={L('Quem usa', 'Who uses it')}>
          <AgentPicker value={draft.agents} onChange={(agents) => set({ agents })} />
        </Field>
        <div className="row row--between">
          <span className="hint">{draft.id ? L('A versão de agora fica no histórico: dá pra voltar.', 'The current version stays in the history: you can go back.') : ''}</span>
          <div className="row">
            {error && <span className="field__error">{error}</span>}
            <button className="btn btn--sm btn--ghost" onClick={onClose}>
              {L('Cancelar', 'Cancel')}
            </button>
            <button className="btn btn--sm btn--primary" disabled={!draft.source && (!draft.name.trim() || !draft.description.trim() || !draft.body.trim())} onClick={save}>
              {draft.id ? L('Salvar', 'Save') : L('Criar skill', 'Create skill')}
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
