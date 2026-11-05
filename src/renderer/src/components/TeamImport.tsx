// Importing a team's .md file (spec §21): the first time it brings the team in; a newer file of
// the same team comes as an update to review, item by item, with a diff. What I changed here is
// kept unless I pick the team's version.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { TeamChange, TeamChoice, TeamItemKind, TeamPackageInfo, TeamUpdate } from '../../../shared/types'
import { forgetTeam, importTeam, teams } from '../store'
import { confirmDialog, Modal } from './Dialogs'
import { Diff } from './Skills'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

const KIND: Record<TeamItemKind, () => string> = {
  agent: () => L('Agente', 'Agent'),
  skill: () => 'Skill',
  routine: () => L('Rotina', 'Routine'),
  channel: () => L('Canal', 'Channel'),
  connector: () => L('Conector', 'Connector'),
  context: () => L('Contexto', 'Context')
}

const FIELD: Record<string, () => string> = {
  instructions: () => L('Instruções', 'Instructions'),
  model: () => L('Modelo', 'Model'),
  effort: () => L('Esforço', 'Effort'),
  role: () => L('Papel', 'Role'),
  name: () => L('Nome', 'Name'),
  handle: () => '@',
  color: () => L('Cor', 'Color'),
  customColor: () => L('Cor', 'Color'),
  avatar: () => L('Rosto', 'Face'),
  web: () => L('Busca na web', 'Web search'),
  browser: () => L('Navegador', 'Browser'),
  wiki: () => 'Wiki',
  grants: () => L('Acessos', 'Access'),
  team: () => L('Coordena', 'Coordinates'),
  description: () => L('Quando usar', 'When to use'),
  body: () => L('Receita', 'Recipe'),
  agents: () => L('Agentes', 'Agents'),
  members: () => L('Agentes', 'Agents'),
  topic: () => L('Tema', 'Topic'),
  schedule: () => L('Agenda', 'Schedule'),
  trigger: () => L('Gatilho', 'Trigger'),
  where: () => L('Onde', 'Where'),
  prompt: () => L('O que fazer', 'What to do'),
  agent: () => L('Agente', 'Agent'),
  url: () => L('Endereço', 'Address'),
  command: () => L('Comando', 'Command'),
  args: () => L('Argumentos', 'Arguments'),
  envKeys: () => L('Variáveis', 'Variables'),
  auth: () => L('Login', 'Sign-in'),
  kind: () => L('Tipo', 'Kind'),
  text: () => L('Texto', 'Text')
}
const LONG = new Set(['instructions', 'body', 'prompt', 'text'])

function show(v: unknown): string {
  if (v === undefined || v === null || v === '') return '—'
  if (typeof v === 'boolean') return v ? L('sim', 'yes') : L('não', 'no')
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.length ? v.map(show).join(', ') : '—'
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    return entries.length ? entries.map(([k, x]) => `${k}: ${show(x)}`).join(' · ') : '—'
  }
  return String(v)
}

const CHOICES: Record<TeamChange['status'], { value: TeamChoice; label: () => string }[]> = {
  new: [
    { value: 'package', label: () => L('Adicionar', 'Add') },
    { value: 'later', label: () => L('Depois', 'Later') },
    { value: 'mine', label: () => L('Não quero', 'Not for me') }
  ],
  update: [
    { value: 'package', label: () => L('Aplicar', 'Apply') },
    { value: 'later', label: () => L('Depois', 'Later') }
  ],
  conflict: [
    { value: 'package', label: () => L('Usar a do time', 'Use the team’s') },
    { value: 'mine', label: () => L('Manter a minha', 'Keep mine') },
    { value: 'later', label: () => L('Depois', 'Later') }
  ],
  removed: [
    { value: 'package', label: () => L('Tirar daqui', 'Remove here') },
    { value: 'mine', label: () => L('Manter', 'Keep') },
    { value: 'later', label: () => L('Depois', 'Later') }
  ]
}
// A conflict or a removal waits for me to pick; the rest comes in unless I say otherwise.
const defaultChoice = (c: TeamChange): TeamChoice => (c.status === 'conflict' || c.status === 'removed' ? 'later' : 'package')

const STATUS: Record<TeamChange['status'], { tag: string; label: () => string }> = {
  new: { tag: 'tag--ok', label: () => L('novo', 'new') },
  update: { tag: 'tag--agent', label: () => L('mudou no time', 'changed by the team') },
  conflict: { tag: 'tag--warn', label: () => L('mudou aqui e no time', 'changed here and by the team') },
  removed: { tag: 'tag--danger', label: () => L('saiu do time', 'left the team') }
}

export function TeamImportDialog({ text, update, onClose, onDone }: { text: string; update: TeamUpdate; onClose: () => void; onDone: (note: string) => void }): ReactNode {
  const [choices, setChoices] = useState<Record<string, TeamChoice>>(() => Object.fromEntries(update.changes.map((c) => [c.key, defaultChoice(c)])))
  const [open, setOpen] = useState<string | null>(update.changes.length === 1 ? update.changes[0]!.key : null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = (): void => {
    setBusy(true)
    importTeam(text, choices)
      .then(onDone, (e: unknown) => setError(message(e)))
      .finally(() => setBusy(false))
  }
  const count = Object.values(choices).filter((c) => c !== 'later').length
  return (
    <Modal title={update.seen ? L(`O que mudou em ${update.name}`, `What changed in ${update.name}`) : L(`Importar ${update.name}`, `Import ${update.name}`)} onClose={onClose} className="team-update">
      <p className="muted small modal__lead">
        {update.seen
          ? L(
              `Revisão ${update.revision} do arquivo. Escolha o que entra. Onde você mudou algo aqui e o time também, nada muda até você escolher um lado; o resto que você mudou aqui fica como está.`,
              `The file's revision ${update.revision}. Pick what comes in. Where you changed something here and so did the team, nothing changes until you pick a side; the rest you changed here stays as it is.`
            )
          : L(
              'Escolha o que entra. O que já existe aqui com o mesmo @ ou nome vira o mesmo item, e a versão do arquivo aparece como mudança. Da próxima vez que importar um arquivo deste time, só o que mudou aparece.',
              'Pick what comes in. What already exists here with the same @ or name becomes the same item, and the file’s version shows as a change. Next time you import a file of this team, only what changed shows up.'
            )}
      </p>
      {update.revision < update.seen && (
        <p className="small field__error">
          {L(
            `Esse arquivo é mais antigo (revisão ${update.revision}) que o último deste time que passou por aqui (revisão ${update.seen}): o que aparece como mudança pode ser só a versão de antes.`,
            `This file is older (revision ${update.revision}) than the last one of this team seen here (revision ${update.seen}): what shows as a change may just be the earlier version.`
          )}
        </p>
      )}
      <div className="team-update__list">
        {update.changes.map((c) => (
          <div key={c.key} className={`team-change ${open === c.key ? 'is-open' : ''}`}>
            <div className="row row--center team-change__head">
              <button className="team-change__title grow" onClick={() => setOpen(open === c.key ? null : c.key)} aria-expanded={open === c.key}>
                <span className="muted small">{KIND[c.kind]()}</span> <strong>{c.title}</strong> <span className={`tag ${STATUS[c.status].tag}`}>{STATUS[c.status].label()}</span>
                {c.status !== 'removed' && c.status !== 'new' && <span className="muted small"> · {c.fields.map((f) => FIELD[f.name]?.() ?? f.name).join(', ')}</span>}
              </button>
              <div className="row team-change__choices" role="radiogroup" aria-label={c.title}>
                {CHOICES[c.status].map((o) => (
                  <button key={o.value} role="radio" aria-checked={choices[c.key] === o.value} className={`chip ${choices[c.key] === o.value ? 'is-on' : ''}`} onClick={() => setChoices({ ...choices, [c.key]: o.value })}>
                    {o.label()}
                  </button>
                ))}
              </div>
            </div>
            {open === c.key && c.fields.length > 0 && (
              <div className="team-change__fields">
                {c.fields.map((f) => (
                  <div key={f.name} className="team-change__field">
                    <div className="small">
                      <strong>{FIELD[f.name]?.() ?? f.name}</strong>
                      {f.conflict && <span className="tag tag--warn"> {L('os dois mudaram', 'both changed')}</span>}
                      {c.status !== 'new' && LONG.has(f.name) && <span className="muted"> · {L('− o daqui, + o do time', '− yours here, + the team’s')}</span>}
                    </div>
                    {c.status === 'new' ? (
                      LONG.has(f.name) ? <pre className="diff">{show(f.theirs)}</pre> : <div className="small">{show(f.theirs)}</div>
                    ) : LONG.has(f.name) ? (
                      <Diff before={typeof f.mine === 'string' ? f.mine : show(f.mine)} after={typeof f.theirs === 'string' ? f.theirs : show(f.theirs)} />
                    ) : (
                      <div className="small team-change__values">
                        <span className="diff__del">{show(f.mine)}</span> → <span className="diff__add">{show(f.theirs)}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {error && <p className="field__error">{error}</p>}
      <footer className="modal__foot">
        <span className="muted small grow">{L('Rotinas novas entram desligadas. Conectores novos pedem o seu login.', 'New routines come in off. New connectors ask for your sign-in.')}</span>
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Fechar', 'Close')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy || !count} onClick={apply}>
          {L(`Aplicar ${count}`, `Apply ${count}`)}
        </button>
      </footer>
    </Modal>
  )
}

// The teams imported or exported here, and what differs here from each one's last file.
export function KnownTeams({ version }: { version: number }): ReactNode {
  const [list, setList] = useState<TeamPackageInfo[]>([])
  const refresh = (): void => void teams().then(setList, () => undefined)
  useEffect(refresh, [version])
  const forget = async (t: TeamPackageInfo): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Esquecer ${t.name}?`, `Forget ${t.name}?`),
      body: L('Nada muda aqui. O próximo arquivo desse time entra como um time novo, casando agentes por @ e o resto por nome.', 'Nothing changes here. The next file of that team comes in as a new team, matching agents by @ and the rest by name.'),
      confirm: L('Esquecer', 'Forget')
    })
    if (ok) void forgetTeam(t.id).then(refresh)
  }
  if (!list.length) return null
  return (
    <div className="team-known">
      {list.map((t) => (
        <div key={t.id} className="row row--center small team-known__row">
          <span className="grow">
            <strong>{t.name}</strong> <span className="muted">· {L(`revisão ${t.revision}`, `revision ${t.revision}`)}</span>
            {t.changedHere.length > 0 && (
              <span className="muted">
                {' '}
                · {L('diferente aqui:', 'different here:')} {t.changedHere.map((c) => c.title).join(', ')}
              </span>
            )}
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => void forget(t)}>
            {L('Esquecer', 'Forget')}
          </button>
        </div>
      ))}
    </div>
  )
}
