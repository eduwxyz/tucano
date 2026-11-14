// What a member sees of the team: the dialog behind "Editar acesso" in Settings › Pessoas, and the
// same choice (AccessChoice) inside a new invite. The server enforces it; this only picks.
import { useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { cleanAccess, EVERYTHING, visibleAgentIds } from '../../../shared/access'
import { headsOf, reportsOf, sectorName } from '../../../shared/org'
import { isTeam, setPersonAccess, toast, useStore, type Agent, type Person, type PersonAccess } from '../store'
import { message } from './Invite'
import { Modal } from './Modal'
import { AgentAvatar, Icon } from './ui'

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name
const sameAccess = (a: PersonAccess, b: PersonAccess): boolean => a.mode === b.mode && JSON.stringify([[...a.sectors].sort(), [...a.agents].sort(), [...a.channels].sort()]) === JSON.stringify([[...b.sectors].sort(), [...b.agents].sort(), [...b.channels].sort()])
const sentence = (xs: string[]): string => (xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} ${L('e', 'and')} ${xs[xs.length - 1]}`)
// A short list of names: the first few, then "e mais 3".
const some = (xs: string[], max = 4): string[] => (xs.length > max ? [...xs.slice(0, max), L(`mais ${xs.length - max}`, `${xs.length - max} more`)] : xs)

function Box({ state }: { state: 'on' | 'part' | 'off' }): ReactNode {
  return <span className={`access-box ${state === 'off' ? '' : `access-box--${state}`}`}>{state === 'on' ? <Icon name="check" size={12} /> : state === 'part' ? '–' : ''}</span>
}

// The two big cards, and under "Só o que eu escolher" the pickers and the plain-words result.
// `who`: the person's first name; unset in an invite (nobody yet).
export function AccessChoice({ value, onChange, who }: { value: PersonAccess; onChange: (a: PersonAccess) => void; who?: string }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const channels = useStore((s) => s.conversations.filter((c) => c.kind === 'channel'))
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const picked = value.mode === 'picked'
  const heads = headsOf(agents)
  const sectors = heads.map((h) => ({ head: h, members: [h, ...reportsOf(agents, h.id)].filter(isTeam) }))
  const inSector = new Set(sectors.flatMap((s) => s.members.map((m) => m.id)))
  const loose = agents.filter((a) => !inSector.has(a.id))
  const set = (patch: Partial<PersonAccess>): void => onChange({ ...value, ...patch })

  const sectorOn = (head: Agent): boolean => value.sectors.includes(head.id)
  const agentOn = (head: Agent | undefined, a: Agent): boolean => value.agents.includes(a.id) || (!!head && sectorOn(head))
  const toggleSector = (head: Agent, members: Agent[]): void => {
    const ids = new Set(members.map((m) => m.id))
    if (sectorOn(head)) return set({ sectors: value.sectors.filter((x) => x !== head.id) })
    set({ sectors: [...value.sectors, head.id], agents: value.agents.filter((x) => !ids.has(x)) })
  }
  const toggleAgent = (head: Agent | undefined, members: Agent[], a: Agent): void => {
    if (head && sectorOn(head)) {
      // Unchecking one of a whole sector: the sector becomes its other agents, one by one.
      return set({ sectors: value.sectors.filter((x) => x !== head.id), agents: [...value.agents, ...members.filter((m) => m.id !== a.id).map((m) => m.id)] })
    }
    const next = value.agents.includes(a.id) ? value.agents.filter((x) => x !== a.id) : [...value.agents, a.id]
    // Every agent marked one by one is the whole sector: keep it as the sector, so newcomers are in too.
    if (head && members.every((m) => next.includes(m.id))) {
      const ids = new Set(members.map((m) => m.id))
      return set({ sectors: [...value.sectors, head.id], agents: next.filter((x) => !ids.has(x)) })
    }
    set({ agents: next })
  }
  const toggleChannel = (id: string): void => set({ channels: value.channels.includes(id) ? value.channels.filter((x) => x !== id) : [...value.channels, id] })

  // The result, in words, from the same rule the server applies.
  const seen = visibleAgentIds({ role: 'member', access: value }, agents)
  const seenAgents = agents.filter((a) => seen?.has(a.id)).map((a) => a.name)
  const hiddenAgents = agents.length - seenAgents.length
  const seenRooms = channels.filter((c) => value.channels.includes(c.id)).map((c) => `#${c.name}`)
  const hiddenRooms = channels.length - seenRooms.length
  const count = (n: number, one: string, many: string, oneEn: string, manyEn: string): string => (n === 1 ? L(`1 ${one}`, `1 ${oneEn}`) : L(`${n} ${many}`, `${n} ${manyEn}`))
  const hiddenText = [hiddenAgents > 0 ? count(hiddenAgents, 'agente', 'agentes', 'agent', 'agents') : '', hiddenRooms > 0 ? count(hiddenRooms, 'canal', 'canais', 'channel', 'channels') : ''].filter(Boolean)
  const seeing = [...seenAgents, ...seenRooms]

  const mode = (m: PersonAccess['mode'], title: string, text: string): ReactNode => (
    <button type="button" role="radio" aria-checked={value.mode === m} className={`access-mode ${value.mode === m ? 'is-on' : ''}`} onClick={() => set({ mode: m })}>
      <span className="access-radio" />
      <span className="access-mode__text">
        <strong>{title}</strong>
        <span>{text}</span>
      </span>
    </button>
  )

  const agentGrid = (head: Agent | undefined, members: Agent[]): ReactNode => (
    <div className="access-agents">
      {members.map((a) => (
        <button type="button" key={a.id} role="checkbox" aria-checked={agentOn(head, a)} className={`access-agent ${agentOn(head, a) ? 'is-on' : ''}`} onClick={() => toggleAgent(head, members, a)}>
          <Box state={agentOn(head, a) ? 'on' : 'off'} />
          <AgentAvatar agent={a} size={24} still />
          <span className="access-agent__text">
            <strong>{a.name}</strong>
            {a.role && <span>{a.role}</span>}
          </span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="access">
      <div className="access-modes" role="radiogroup" aria-label={L('O que a pessoa vê', 'What they see')}>
        {mode('all', L('Vê tudo', 'Sees everything'), L('Todos os agentes e canais, como hoje.', 'All agents and channels, as today.'))}
        {mode('picked', L('Só o que eu escolher', 'Only what I pick'), L(`${who ? firstName(who) : 'A pessoa'} vê só o que você marcar.`, `${who ? firstName(who) : 'They'} see only what you mark.`))}
      </div>

      {picked && (
        <>
          <section>
            <div className="access-label">{L('Setores e agentes', 'Sectors and agents')}</div>
            <div className="access-hint">{L('Marque o setor inteiro, ou só alguns agentes dele. Quem entrar depois num setor marcado aparece sozinho.', 'Mark a whole sector, or just some of its agents. Whoever joins a marked sector later shows up on their own.')}</div>
            {agents.length === 0 ? (
              <p className="access-empty">{L('Ainda não há agentes. Eles aparecem aqui quando você montar o time.', 'There are no agents yet. They show up here once you build the team.')}</p>
            ) : (
              <>
                {sectors.map(({ head, members }) => {
                  const marked = members.filter((m) => agentOn(head, m)).length
                  const state = sectorOn(head) ? 'on' : marked > 0 ? 'part' : 'off'
                  const isOpen = open[head.id] ?? false
                  const others = members.filter((m) => m.id !== head.id)
                  return (
                    <div key={head.id} className="access-sector">
                      <div className="access-sector__head">
                        <button type="button" role="checkbox" aria-checked={state === 'part' ? 'mixed' : state === 'on'} aria-label={sectorName(head)} className="access-sector__check" onClick={() => toggleSector(head, members)}>
                          <Box state={state} />
                        </button>
                        <button type="button" className="access-sector__open" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [head.id]: !isOpen })}>
                          <span className="access-sector__name">
                            <strong>{sectorName(head)}</strong>
                            <span>{others.length === 0 ? head.name : others.length === 1 ? sentence([head.name, others[0]!.name]) : L(`${head.name} e mais ${others.length}`, `${head.name} and ${others.length} more`)}</span>
                          </span>
                          <span className="access-count">{L(`${marked} de ${members.length}`, `${marked} of ${members.length}`)}</span>
                          <span className={`access-chev ${isOpen ? 'is-open' : ''}`}><Icon name="down" size={14} /></span>
                        </button>
                      </div>
                      {isOpen && agentGrid(head, members)}
                    </div>
                  )
                })}
                {loose.length > 0 && (
                  <div className="access-sector">
                    <div className="access-sector__head">
                      <button type="button" className="access-sector__open" aria-expanded={open['_loose'] ?? false} onClick={() => setOpen({ ...open, _loose: !open['_loose'] })}>
                        <span className="access-sector__name">
                          <strong>{L('Outros agentes', 'Other agents')}</strong>
                          <span>{L('Fora de qualquer setor', 'Not in any sector')}</span>
                        </span>
                        <span className="access-count">{L(`${loose.filter((a) => agentOn(undefined, a)).length} de ${loose.length}`, `${loose.filter((a) => agentOn(undefined, a)).length} of ${loose.length}`)}</span>
                        <span className={`access-chev ${open['_loose'] ? 'is-open' : ''}`}><Icon name="down" size={14} /></span>
                      </button>
                    </div>
                    {open['_loose'] && agentGrid(undefined, loose)}
                  </div>
                )}
                {sectors.length === 0 && loose.length > 0 && <p className="access-hint">{L('Ainda não há setores: marque os agentes um a um.', 'There are no sectors yet: mark the agents one by one.')}</p>}
              </>
            )}
          </section>

          <section>
            <div className="access-label">{L('Canais', 'Channels')}</div>
            <div className="access-hint">{who ? L(`${firstName(who)} lê tudo o que é dito nos canais que vê.`, `${firstName(who)} reads everything said in the channels they see.`) : L('A pessoa lê tudo o que é dito nos canais que vê.', 'They read everything said in the channels they see.')}</div>
            {channels.length === 0 ? (
              <p className="access-empty">{L('Ainda não há canais.', 'There are no channels yet.')}</p>
            ) : (
              <div className="access-channels">
                {channels.map((c) => (
                  <button type="button" key={c.id} role="checkbox" aria-checked={value.channels.includes(c.id)} className={`access-channel ${value.channels.includes(c.id) ? 'is-on' : ''}`} onClick={() => toggleChannel(c.id)}>
                    <Box state={value.channels.includes(c.id) ? 'on' : 'off'} />#{c.name}
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <div className="access-result" aria-live="polite">
        {!picked ? (
          <span>{who ? L(`${firstName(who)} vê tudo, como hoje.`, `${firstName(who)} sees everything, as today.`) : L('Quem entrar vê tudo, como hoje.', 'Whoever joins sees everything, as today.')}</span>
        ) : (
          <>
            <span>
              {who ? firstName(who) : L('Quem entrar', 'Whoever joins')} {L('vai ver:', 'will see:')} {seeing.length ? <strong>{sentence(some(seeing, 5))}</strong> : <strong>{L('nenhum agente nem canal', 'no agent or channel')}</strong>}.
            </span>
            {hiddenText.length > 0 && (
              <span className="access-no">
                {L('Não vai ver:', "Won't see:")} {sentence(hiddenText)}. {L(`Os agentes que ficam de fora também não são chamados a pedido dessa pessoa.`, 'The agents left out are not called on this person’s behalf either.')}
              </span>
            )}
          </>
        )}
      </div>
      <p className="access-fine">{L('O dono e os admins sempre veem tudo. O Tuca aparece para todos.', 'The owner and admins always see everything. Tuca shows up for everyone.')}</p>
    </div>
  )
}

// "Editar acesso": one choice, one Save.
export function PersonAccessDialog({ person, onClose }: { person: Person; onClose: () => void }): ReactNode {
  const agentIds = useStore((s) => s.agents.filter(isTeam).map((a) => a.id)).join(',')
  const channelIds = useStore((s) => s.conversations.filter((c) => c.kind === 'channel').map((c) => c.id)).join(',')
  const start = cleanAccess(person.access ?? EVERYTHING, agentIds ? agentIds.split(',') : [], channelIds ? channelIds.split(',') : [])
  const [draft, setDraft] = useState<PersonAccess>(start)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const name = firstName(person.name)
  const save = (): void => {
    setBusy(true)
    const next = draft.mode === 'all' ? EVERYTHING : draft
    void setPersonAccess(person.id, next).then(
      () => (toast(L(`Acesso de ${name} salvo.`, `${name}'s access saved.`)), onClose()),
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }
  return (
    <Modal title={L(`O que ${name} vê`, `What ${name} sees`)} onClose={onClose} className="access-dialog">
      <AccessChoice value={draft} onChange={(a) => (setDraft(a), setError(''))} who={name} />
      {error && <p className="note note--error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy || sameAccess(draft, start)} onClick={save}>
          {L('Salvar', 'Save')}
        </button>
      </footer>
    </Modal>
  )
}
