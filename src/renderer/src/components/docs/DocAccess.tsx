// "Quem entra em <pasta>": who sees and who changes what is in a folder, people and agents, with the
// result said in plain words as it is picked. Only an owner or an admin gets here; the core checks again.
import { useMemo, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { accessInWords, effectiveAccess } from '../../../../shared/doc-access'
import { noAccess, type AgentLevel, type DocFolder, type DocLevel, type DocsTree, type FolderAccess } from '../../../../shared/docs'
import { headsOf, reportsOf, sectorName } from '../../../../shared/org'
import { call } from '../../rpc'
import { initials, isTeam, toast, useStore, type Agent } from '../../store'
import { message } from '../Invite'
import { Modal } from '../Modal'
import { AgentAvatar, Icon, MeAvatar } from '../ui'

// A choice of three, the first one being "no".
function Seg({ labels, value, onChange, floor = 0, label }: { labels: [string, string, string]; value: number; onChange: (n: number) => void; floor?: number; label: string }): ReactNode {
  return (
    <span className="dc-seg" role="radiogroup" aria-label={label}>
      {labels.map((l, i) => (
        <button key={i} type="button" role="radio" aria-checked={i === value} disabled={i < floor} className={`${i === value ? 'is-on' : ''} ${i === 0 ? 'is-no' : ''}`} onClick={() => onChange(i)}>
          {l}
        </button>
      ))}
    </span>
  )
}

const PEOPLE = (): [string, string, string] => [L('Não vê', "Can't see"), L('Vê', 'Sees'), L('Edita', 'Edits')]
const AGENTS = (): [string, string, string] => [L('Não lê', "Can't read"), L('Lê', 'Reads'), L('Lê e guarda', 'Reads and saves')]
const PL: (DocLevel | undefined)[] = [undefined, 'view', 'edit']
const AL: (AgentLevel | undefined)[] = [undefined, 'read', 'write']
const num = (l: DocLevel | AgentLevel | undefined): number => (l === 'view' || l === 'read' ? 1 : l === 'edit' || l === 'write' ? 2 : 0)

function put<T extends string>(rec: Record<string, T>, id: string, level: T | undefined): Record<string, T> {
  const rest = { ...rec }
  delete rest[id]
  return level ? { ...rest, [id]: level } : rest
}

export function DocAccessDialog({ folder, tree, onClose }: { folder: DocFolder; tree: DocsTree; onClose: () => void }): ReactNode {
  const people = useStore((s) => s.people)
  const you = useStore((s) => s.you)
  const agents = useStore((s) => s.agents.filter(isTeam))
  const here = useMemo(() => effectiveAccess(tree.folders, folder.id), [tree, folder.id])
  const up = useMemo(() => (folder.parentId ? effectiveAccess(tree.folders, folder.parentId).access : noAccess()), [tree, folder.parentId])
  const [inherit, setInherit] = useState(folder.access === null && !!folder.parentId)
  const [draft, setDraft] = useState<FolderAccess>(() => ({ ...here.access, people: { ...here.access.people }, sectors: { ...here.access.sectors }, agents: { ...here.access.agents } }))
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const edit = (next: Partial<FolderAccess>): void => (setDraft((d) => ({ ...d, ...next })), setError(''))

  // A personal folder is never shared.
  if (here.privateTo)
    return (
      <Modal title={L(`Quem entra em ${folder.name}`, `Who gets into ${folder.name}`)} onClose={onClose}>
        <p className="modal__lead">{L('Só você vê esta pasta.', 'Only you can see this folder.')}</p>
        <footer className="modal__foot">
          <span className="grow" />
          <button className="btn btn--primary btn--sm" onClick={onClose}>
            {L('Entendi', 'Got it')}
          </button>
        </footer>
      </Modal>
    )

  const heads = headsOf(agents)
  const sectors = heads.map((head) => ({ head, members: [head, ...reportsOf(agents, head.id)].filter(isTeam) }))
  const inSector = new Set(sectors.flatMap((s) => s.members.map((m) => m.id)))
  const loose = agents.filter((a) => !inSector.has(a.id))

  const members = people.filter((p) => p.role === 'member')
  const staff = people.filter((p) => p.role !== 'member')
  const everyone = num(draft.everyone)
  const level = (id: string): number => Math.max(everyone, num(draft.people[id]))
  const allAgents = num(draft.allAgents)
  const agentLevel = (head: Agent | undefined, a: Agent): number => Math.max(allAgents, num(draft.agents[a.id]), head ? num(draft.sectors[head.id]) : 0)

  const shown = inherit ? up : draft
  const words = accessInWords(shown, { people, agents: agents.map((a) => ({ id: a.id, name: a.name, sectorName: heads.some((h) => h.id === a.id) ? a.sectorName : undefined })), me: you })
  // What is stored; a top folder with nothing set is the same as no one picked yet.
  const stored = folder.access ?? (folder.parentId ? null : here.access)
  const changed = inherit ? folder.access !== null : JSON.stringify(draft) !== JSON.stringify(stored)

  const save = (): void => {
    setBusy(true)
    call('docFolderSave', { id: folder.id, parentId: folder.parentId, name: folder.name, rule: folder.rule, access: inherit ? null : draft }).then(
      () => (toast(L('Acesso salvo.', 'Access saved.')), onClose()),
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }

  const sectorRow = (head: Agent, list: Agent[]): ReactNode => {
    const names = list.filter((m) => m.id !== head.id).map((m) => m.name)
    const isOpen = open[head.id] ?? false
    return (
      <div key={head.id} className="dc-acc-sector">
        <div className="dc-acc">
          <AgentAvatar agent={head} size={26} still />
          <span className="dc-acc__who">
            {sectorName(head, L('Setor de', 'Sector of'))}
            <span>{names.length ? L(`${head.name} e ${names.length === 1 ? names[0] : `mais ${names.length}`}`, `${head.name} and ${names.length === 1 ? names[0] : `${names.length} more`}`) : head.name}</span>
          </span>
          <Seg label={sectorName(head, L('Setor de', 'Sector of'))} labels={AGENTS()} value={Math.max(allAgents, num(draft.sectors[head.id]))} floor={allAgents} onChange={(n) => edit({ sectors: put(draft.sectors, head.id, AL[n]) })} />
        </div>
        {list.length > 1 && (
          <button type="button" className="text-btn dc-acc__more" aria-expanded={isOpen} onClick={() => setOpen({ ...open, [head.id]: !isOpen })}>
            {isOpen ? L('Fechar', 'Close') : L('Escolher agente por agente', 'Pick agent by agent')}
          </button>
        )}
        {isOpen && list.map((a) => agentRow(head, a))}
      </div>
    )
  }
  const agentRow = (head: Agent | undefined, a: Agent): ReactNode => (
    <div key={a.id} className="dc-acc dc-acc--agent">
      <AgentAvatar agent={a} size={22} still />
      <span className="dc-acc__who">{a.name}</span>
      <Seg label={a.name} labels={AGENTS()} value={agentLevel(head, a)} floor={head ? num(draft.sectors[head.id]) : 0} onChange={(n) => edit({ agents: put(draft.agents, a.id, AL[n]) })} />
    </div>
  )

  return (
    <Modal title={L(`Quem entra em ${folder.name}`, `Who gets into ${folder.name}`)} onClose={onClose} className="dc-access">
      <p className="modal__lead">{L('Vale para a pasta e tudo que está dentro dela.', 'Applies to the folder and everything inside it.')}</p>

      {folder.parentId && (
        <label className="dc-inherit">
          <input type="checkbox" checked={inherit} onChange={(e) => setInherit(e.target.checked)} />
          <span>
            <strong>{L('Usar o mesmo acesso da pasta de cima', 'Use the same access as the folder above')}</strong>
            <span>{L('Se a de cima mudar, esta muda junto.', 'If the one above changes, this one does too.')}</span>
          </span>
        </label>
      )}

      {!inherit && (
        <div className="dc-access__body">
          <h4 className="dc-eyebrow">{L('Pessoas', 'People')}</h4>
          {staff.map((p) => (
            <div key={p.id} className="dc-acc">
              <MeAvatar initials={initials(p.name)} size={26} />
              <span className="dc-acc__who">
                {p.name}
                <span>{p.role === 'owner' ? L('Dono · vê tudo sempre', 'Owner · always sees everything') : L('Admin · vê tudo sempre', 'Admin · always sees everything')}</span>
              </span>
              <span className="chip">{L('Tudo', 'Everything')}</span>
            </div>
          ))}
          <div className="dc-acc">
            <span className="dc-acc__ico">
              <Icon name="users" size={14} />
            </span>
            <span className="dc-acc__who">
              {L('Todo o time', 'The whole team')}
              <span>{L('Todas as pessoas, de uma vez', 'Every person at once')}</span>
            </span>
            <Seg label={L('Todo o time', 'The whole team')} labels={PEOPLE()} value={everyone} onChange={(n) => edit({ everyone: PL[n] })} />
          </div>
          {members.map((p) => (
            <div key={p.id} className="dc-acc">
              <MeAvatar initials={initials(p.name)} size={26} />
              <span className="dc-acc__who">{p.id === you ? L(`${p.name} (você)`, `${p.name} (you)`) : p.name}</span>
              <Seg label={p.name} labels={PEOPLE()} value={level(p.id)} floor={everyone} onChange={(n) => edit({ people: put(draft.people, p.id, PL[n]) })} />
            </div>
          ))}

          <h4 className="dc-eyebrow">{L('Agentes', 'Agents')}</h4>
          <div className="dc-acc">
            <span className="dc-acc__ico">
              <Icon name="zap" size={14} />
            </span>
            <span className="dc-acc__who">
              {L('Todos os agentes', 'All agents')}
              <span>{L('Vale também para agentes criados depois.', 'Also applies to agents created later.')}</span>
            </span>
            <Seg label={L('Todos os agentes', 'All agents')} labels={AGENTS()} value={allAgents} onChange={(n) => edit({ allAgents: AL[n] })} />
          </div>
          {sectors.length === 0 && loose.length === 0 && <p className="muted small">{L('Ainda não há agentes. Eles aparecem aqui quando você montar o time.', 'There are no agents yet. They show up here once you build the team.')}</p>}
          {sectors.map(({ head, members: list }) => sectorRow(head, list))}
          {loose.length > 0 && (
            <div className="dc-acc-sector">
              <button type="button" className="text-btn dc-acc__more" aria-expanded={open['_loose'] ?? false} onClick={() => setOpen({ ...open, _loose: !open['_loose'] })}>
                {open['_loose'] ? L('Fechar os outros agentes', 'Close the other agents') : L(`Outros agentes (${loose.length})`, `Other agents (${loose.length})`)}
              </button>
              {open['_loose'] && loose.map((a) => agentRow(undefined, a))}
            </div>
          )}
        </div>
      )}

      <div className="dc-plain" aria-live="polite">
        <Icon name="eye" size={14} />
        <span>
          {inherit && L('Vai valer o mesmo que na pasta de cima. ', 'It will follow the folder above. ')}
          {words}
          {!inherit && <> {L('Quem fica de fora não acha o arquivo nem pela busca, e os agentes dessa pessoa também não leem.', "Whoever is left out can't find the files, not even by searching, and their agents can't read them either.")}</>}
        </span>
      </div>
      {error && <p className="note note--error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy || !changed} onClick={save}>
          {busy ? L('Salvando…', 'Saving…') : L('Salvar', 'Save')}
        </button>
      </footer>
    </Modal>
  )
}
