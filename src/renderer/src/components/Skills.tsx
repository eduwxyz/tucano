// Skills: library navigation; each editor and review flow has its own component.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { useStore, amAdmin, loadReport, archiveSkill, removeSkill, type Skill, type SkillInput, type SkillReport } from '../store'
import { Sheet } from './Pages'
import { AdminOnly } from './People'
import { Icon } from './ui'
import { confirmDialog } from './Dialogs'
import { Modal } from './Modal'
import { SkillPage } from './skills/SkillPage'
import { AddFromTerminal } from './skills/SkillImport'
import { SkillForm } from './skills/SkillForm'
import { Proposal } from './skills/SkillProposal'
import { Who, result, from } from './skills/SkillPeople'
export { AgentPicker } from './skills/SkillPeople'

type Place = { kind: 'list' } | { kind: 'skill'; id: string } | { kind: 'review' }

export function SkillsPage(): ReactNode {
  return <Skills admin={useStore(amAdmin)} />
}

function Skills({ admin }: { admin: boolean }): ReactNode {
  const skills = useStore((s) => s.skills)
  const [place, setPlace] = useState<Place>({ kind: 'list' })
  const [draft, setDraft] = useState<SkillInput | null>(null)
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [stats, setStats] = useState<SkillReport[]>([])
  useEffect(() => {
    if (admin) void loadReport().then((r) => setStats(r.skills), () => {})
  }, [skills.length, admin])

  const pending = skills.filter((k) => k.state === 'pending')
  const active = skills.filter((k) => k.state === 'active')
  const archived = skills.filter((k) => k.state === 'archived')
  const open = place.kind === 'skill' ? active.find((k) => k.id === place.id) : undefined
  const edit = (k: Skill): void => setDraft({ id: k.id, name: k.name, description: k.description, body: k.body, agents: k.agents, source: k.source })
  const toList = (): void => setPlace({ kind: 'list' })

  const form = draft && (
    <Modal title={draft.id ? L('Editar skill', 'Edit skill') : L('Nova skill', 'New skill')} variant="form" onClose={() => setDraft(null)}>
      <SkillForm key={draft.id ?? 'new'} draft={draft} onChange={setDraft} onClose={() => setDraft(null)} />
    </Modal>
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
        admin && (
          <>
            <button className="text-btn" onClick={() => setAdding(true)}>
              {L('Buscar skills existentes', 'Find existing skills')}
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => setDraft({ name: '', description: '', body: '', agents: [] })}>
              <Icon name="plus" size={14} /> {L('Nova skill', 'New skill')}
            </button>
          </>
        )
      }
    >
      {!admin && <AdminOnly>{L('Só um admin cria, aprova ou muda skills.', 'Only an admin creates, approves or changes skills.')}</AdminOnly>}
      {admin && pending.length > 0 && (
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

      {admin && archived.length > 0 && (
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
                  {L('Reativar', 'Reactivate')}
                </button>
                <button
                  className="text-btn"
                  onClick={() =>
                    void confirmDialog({
                      title: L(`Apagar a skill “${k.name}”?`, `Delete the skill “${k.name}”?`),
                      body: L('Ela some da lista e nenhum agente volta a usar. Não dá pra desfazer.', "It leaves the list and no agent uses it again. This can't be undone."),
                      confirm: L(`Apagar “${k.name}”`, `Delete “${k.name}”`),
                      danger: true
                    }).then((ok) => ok && removeSkill(k.id))
                  }
                >
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
