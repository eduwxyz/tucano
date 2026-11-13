// The people of a Tucano with a team: the first access's name, Settings › Pessoas and
// Settings › Atividade, and the "Só um admin…" note where an action is the admins'.
import qrcode from 'qrcode-generator'
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import {
  amAdmin,
  amOwner,
  createInvite,
  delegating,
  doneNaming,
  initials,
  inviteLink,
  listInvites,
  myDevices,
  loadActivity,
  personById,
  purgePerson,
  removedPeople,
  removeDevice,
  removePerson,
  revokeInvite,
  roleLabel,
  setDelegation,
  setMyName,
  setRole,
  toast,
  useStore,
  windowless,
  youPerson,
  type ActivityEntry,
  type Device,
  type Invite,
  type Person,
  type State
} from '../store'
import { toolWords } from './Conversation'
import { confirmDialog } from './Dialogs'
import { Modal } from './Modal'
import { Card, Field } from './Pages'
import { ago, Icon, MeAvatar, time } from './ui'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

// Where an action is the admins', a short line says so instead of a button that fails.
export function AdminOnly({ children }: { children: ReactNode }): ReactNode {
  return (
    <p className="admin-only muted small">
      <Icon name="shield" size={13} /> {children}
    </p>
  )
}

// ---------- the first access ----------

// A server's first access: what the agents call the owner, asked once (prefilled with the settings' name).
export function NameModal(): ReactNode {
  const show = useStore((s) => s.needsName)
  const prefill = useStore((s) => s.settings.workspaceName)
  const [name, setName] = useState(prefill)
  const [error, setError] = useState('')
  if (!show) return null
  const save = (): void => {
    if (!name.trim()) return setError(L('Diga seu nome.', 'Tell us your name.'))
    setMyName(name.trim()).then(doneNaming, (e: unknown) => setError(message(e)))
  }
  return (
    <Modal title={L('Como os agentes te chamam?', 'What should the agents call you?')} onClose={doneNaming}>
      <p className="small modal__lead">{L('É o nome que os agentes usam com você e que as outras pessoas do Tucano veem.', 'It’s the name the agents use with you, and the one the other people in this Tucano see.')}</p>
      <label className="field">
        <span className="field__label">{L('Seu nome', 'Your name')}</span>
        <input autoFocus value={name} maxLength={60} onChange={(e) => (setName(e.target.value), setError(''))} onKeyDown={(e) => e.key === 'Enter' && save()} />
      </label>
      {error && <p className="note note--error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--primary btn--sm" onClick={save}>
          {L('Salvar', 'Save')}
        </button>
      </footer>
    </Modal>
  )
}

// ---------- Settings › Pessoas ----------

const seenLine = (p: Person): string => {
  const parts: string[] = []
  if (p.seenAt) parts.push(L(`visto ${ago(p.seenAt)}`, `seen ${ago(p.seenAt)}`))
  if (p.devices) parts.push(L(`${p.devices} aparelho${p.devices > 1 ? 's' : ''}`, `${p.devices} device${p.devices > 1 ? 's' : ''}`))
  return parts.join(' · ')
}

// Who may change a person's role or remove them: admins manage members; only the owner manages
// admins (or makes one); no one, the owner or themselves. The same rule as the core's.
const manages = (me: Person | undefined, p: Person): boolean => !!me && p.role !== 'owner' && p.id !== me.id && (me.role === 'owner' || (me.role === 'admin' && p.role === 'member'))

const dateInput = (t: number): string => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function PeoplePane(): ReactNode {
  const people = useStore((s) => s.people)
  const me = useStore(youPerson)
  const admin = useStore(amAdmin)
  const owner = useStore(amOwner)
  const team = useStore((s) => s.settings.workspaceLabel || s.settings.workspaceName)
  const agents = useStore((s) => s.agents.filter((a) => !a.archived && a.kind !== 'tuca'))
  const [inviting, setInviting] = useState(false)
  const [invites, setInvites] = useState<Invite[]>([])
  const [removed, setRemoved] = useState<(Person & { removedAt: number })[]>([])
  const reload = (): void => {
    if (!admin) return
    void listInvites().then(setInvites, () => {})
    void removedPeople().then(setRemoved, () => {})
  }
  useEffect(reload, [admin, people.length])
  const now = Date.now()
  const pending = invites.filter((i) => !i.usedAt && i.expiresAt > now)
  const ownsAgents = (p: Person): string[] => agents.filter((a) => a.owner === p.id).map((a) => a.name)

  const remove = (p: Person): void =>
    void confirmDialog({
      title: L(`Remover ${p.name}?`, `Remove ${p.name}?`),
      body: removalText(p.name),
      confirm: L(`Remover ${p.name}`, `Remove ${p.name}`),
      danger: true
    }).then((ok) => {
      if (ok) void removePerson(p.id).then(reload, (e: unknown) => toast(message(e)))
    })

  return (
    <>
      <MeCard />
      {windowless() && <PhoneCard />}

      <Card
        title={L(`Pessoas ${team ? `de ${team}` : 'do Tucano'}`, `People ${team ? `of ${team}` : 'in this Tucano'}`)}
        lead={L('Quem tem acesso a este Tucano e o que cada um pode fazer. As DMs de cada pessoa são só dela.', 'Who has access to this Tucano and what each one can do. Each person’s DMs are theirs alone.')}
        action={
          admin && !inviting ? (
            <button className="btn btn--primary btn--sm" onClick={() => setInviting(true)}>
              <Icon name="plus" size={14} /> {L('Convidar', 'Invite')}
            </button>
          ) : undefined
        }
      >
        <div className="table people-list">
          {people.map((p) => {
            const owned = ownsAgents(p)
            return (
              <div key={p.id} className="table__row person-row">
                <MeAvatar initials={initials(p.name)} size={30} />
                <div className="grow person-row__who">
                  <span>
                    <strong>{p.name}</strong>
                    {p.id === me?.id && <span className="muted"> {L('(você)', '(you)')}</span>}
                    {p.about && <span className="muted"> · {p.about}</span>}
                  </span>
                  <span className="muted small">
                    {[seenLine(p), owned.length ? L(`dono de ${owned.join(', ')}`, `owns ${owned.join(', ')}`) : '', p.delegateTo && delegating(p, p.delegateTo) ? L(`coberto por ${personById({ people }, p.delegateTo)?.name ?? '…'}`, `covered by ${personById({ people }, p.delegateTo)?.name ?? '…'}`) : '']
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
                {manages(me, p) ? (
                  <select className="person-row__role" aria-label={L(`Papel de ${p.name}`, `${p.name}'s role`)} value={p.role} onChange={(e) => void setRole(p.id, e.target.value as 'admin' | 'member').catch((err: unknown) => toast(message(err)))}>
                    <option value="member">{roleLabel('member')}</option>
                    {/* Only the owner makes an admin. */}
                    {(owner || p.role === 'admin') && <option value="admin">{roleLabel('admin')}</option>}
                  </select>
                ) : (
                  <span className={`tag ${p.role === 'owner' ? 'tag--agent' : ''}`}>{roleLabel(p.role)}</span>
                )}
                {manages(me, p) && (
                  <button className="btn btn--ghost btn--sm" onClick={() => remove(p)}>
                    {L('Remover', 'Remove')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {!admin && <AdminOnly>{L('Só um admin convida, muda o papel ou remove alguém.', 'Only an admin invites, changes roles or removes someone.')}</AdminOnly>}
      </Card>

      {admin && inviting && <InviteCard onClose={() => (setInviting(false), reload())} owner={owner} />}

      {admin && pending.length > 0 && (
        <Card title={L('Convites pendentes', 'Pending invites')}>
          <div className="table">
            {pending.map((i) => {
              const days = Math.max(1, Math.ceil((i.expiresAt - now) / 86_400_000))
              const back = i.restore ? removed.find((r) => r.id === i.restore)?.name : undefined
              return (
                <div key={i.id} className="table__row">
                  <div className="grow person-row__who">
                    <strong>{back ? L(`Convite pra ${back} voltar`, `Invite for ${back} to come back`) : i.role === 'admin' ? L('Convite de admin', 'Admin invite') : L('Convite de membro', 'Member invite')}{i.about ? <span className="muted"> · {i.about}</span> : null}</strong>
                    <span className="muted small">
                      {L(`criado por ${personById({ people }, i.createdBy)?.name ?? '…'} · expira em ${days} dia${days > 1 ? 's' : ''}`, `created by ${personById({ people }, i.createdBy)?.name ?? '…'} · expires in ${days} day${days > 1 ? 's' : ''}`)}
                    </span>
                  </div>
                  <span className="tag">{roleLabel(i.role)}</span>
                  {canRevoke(i, me) && (
                    <button className="btn btn--ghost btn--sm" onClick={() => void revokeInvite(i.id).then(reload, (e: unknown) => toast(message(e)))}>
                      {L('Revogar', 'Revoke')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {admin && removed.length > 0 && (
        <Card title={L('Removidos', 'Removed')} lead={L('As DMs e as memórias de quem saiu ficam 30 dias, caso a pessoa volte. Depois são apagadas.', 'The DMs and memories of who left are kept 30 days, in case they come back. Then they’re deleted.')}>
          <div className="table">
            {removed.map((p) => {
              const left = Math.max(0, 30 - Math.floor((now - p.removedAt) / 86_400_000))
              return (
                <div key={p.id} className="table__row">
                  <MeAvatar initials={initials(p.name)} size={26} />
                  <div className="grow person-row__who">
                    <strong>{p.name}</strong>
                    <span className="muted small">{L(`removido ${ago(p.removedAt)} · apagado em ${left} dia${left === 1 ? '' : 's'}`, `removed ${ago(p.removedAt)} · deleted in ${left} day${left === 1 ? '' : 's'}`)}</span>
                  </div>
                  <InviteBack person={p} owner={owner} onDone={reload} />
                  {owner && (
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() =>
                        void confirmDialog({
                          title: L(`Apagar os dados de ${p.name} agora?`, `Delete ${p.name}'s data now?`),
                          body: L(`As DMs e as memórias de ${p.name} somem agora, sem esperar os 30 dias. O que ${p.name} disse nos canais fica, com o nome. Não dá pra desfazer.`, `${p.name}'s DMs and memories go now, without waiting the 30 days. What ${p.name} said in channels stays, with their name. This can't be undone.`),
                          confirm: L('Apagar agora', 'Delete now'),
                          danger: true
                        }).then((ok) => {
                          if (ok) void purgePerson(p.id).then(reload, (e: unknown) => toast(message(e)))
                        })
                      }
                    >
                      {L('Apagar agora', 'Delete now')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </Card>
      )}
    </>
  )
}

// A removed person back: an invite that restores them (same DMs and memories).
function InviteBack({ person, owner, onDone }: { person: Person; owner: boolean; onDone: () => void }): ReactNode {
  const [link, setLink] = useState('')
  if (person.role === 'admin' && !owner) return null
  if (link) return <CopyLink link={link} />
  return (
    <button
      className="btn btn--sm"
      onClick={() =>
        void createInvite(person.role === 'admin' ? 'admin' : 'member', person.about, person.id).then(
          (r) => (setLink(inviteLink(r.code)), onDone()),
          (e: unknown) => toast(message(e))
        )
      }
    >
      {L('Convidar de volta', 'Invite back')}
    </button>
  )
}

function CopyLink({ link }: { link: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = (): void =>
    void navigator.clipboard.writeText(link).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1600)),
      () => toast(L('Não consegui copiar. Selecione o link e copie.', "I couldn't copy. Select the link and copy it."))
    )
  return (
    <div className="row invite-link">
      <input className="grow mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label={L('Link do convite', 'Invite link')} />
      <button className="btn btn--sm" onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? L('Copiado', 'Copied') : L('Copiar link', 'Copy link')}
      </button>
    </div>
  )
}

function InviteCard({ onClose, owner }: { onClose: () => void; owner: boolean }): ReactNode {
  const [role, setRoleChoice] = useState<'member' | 'admin'>('member')
  const [about, setAbout] = useState('')
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const make = (): void =>
    void createInvite(role, about.trim()).then(
      (r) => setLink(inviteLink(r.code)),
      (e: unknown) => setError(message(e))
    )
  return (
    <Card title={L('Convidar alguém', 'Invite someone')} lead={L('O link vale uma vez, por 7 dias. Quem usa entra com o próprio nome, no navegador ou no app.', 'The link works once, for 7 days. Whoever uses it comes in with their own name, in the browser or the app.')}>
      <div className="grid2">
        <Field label={L('Papel', 'Role')} hint={role === 'admin' ? L('Admins mexem em agentes, conectores, skills, configurações e pessoas.', 'Admins handle agents, connectors, skills, settings and people.') : L('Membros conversam, criam canais e rotinas pra si.', 'Members chat, create channels and their own routines.')}>
          <select value={role} disabled={!!link} onChange={(e) => setRoleChoice(e.target.value as 'member' | 'admin')}>
            <option value="member">{roleLabel('member')}</option>
            {owner && <option value="admin">{roleLabel('admin')}</option>}
          </select>
        </Field>
        <Field label={L('O que faz', 'What they do')} hint={L('Pros agentes saberem com quem falam. A pessoa pode mudar depois.', 'So the agents know who they talk to. They can change it later.')}>
          <input value={about} disabled={!!link} maxLength={200} placeholder={L('Ex.: cuida do financeiro', 'E.g. handles finance')} onChange={(e) => setAbout(e.target.value)} />
        </Field>
      </div>
      {link ? (
        <Field label={L('Link do convite', 'Invite link')} hint={L('Mande por onde preferir. Ele some daqui quando você fechar: um novo convite gera outro link.', 'Send it however you like. It leaves this screen when you close it: a new invite makes another link.')}>
          <CopyLink link={link} />
        </Field>
      ) : null}
      {error && <p className="note note--error">{error}</p>}
      <div className="row row--end">
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {link ? L('Fechar', 'Close') : L('Cancelar', 'Cancel')}
        </button>
        {!link && (
          <button className="btn btn--primary btn--sm" onClick={make}>
            {L('Criar convite', 'Create invite')}
          </button>
        )}
      </div>
    </Card>
  )
}

// ---------- Conectar um celular ----------

type PairCode = { code: string; link: string; browser: string; expiresAt: number }

// The link as a QR code, drawn here: nothing about it leaves the page.
export function Qr({ text }: { text: string }): ReactNode {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  return <div className="device-qr" role="img" aria-label={L('QR code de conexão', 'Connection QR code')} dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }} />
}

// On a server: the Tucano app on a phone signs in as me with a one-time code (src/server/pair-codes.ts).
// Each phone gets a key of its own; removing someone ends all of theirs.
function PhoneCard(): ReactNode {
  const me = useStore(youPerson)
  const [code, setCode] = useState<PairCode | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const devices = me?.devices ?? 0
  const [before, setBefore] = useState(devices)
  useEffect(() => {
    if (!code) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [code])
  // A new device of mine arrived (the people event counts keys): the code was used.
  useEffect(() => {
    if (code && devices > before) setCode(null)
  }, [devices])
  const make = (): void => {
    setError('')
    setBefore(devices)
    void fetch('./pair/new', { method: 'POST' })
      .then((r) => (r.ok ? (r.json() as Promise<PairCode>) : Promise.reject(new Error(String(r.status)))))
      .then((c) => (setCode(c), setNow(Date.now())))
      .catch(() => setError(L('Não consegui gerar o código. Tente de novo.', "I couldn't make the code. Try again.")))
  }
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0
  const copy = (text: string): void =>
    void navigator.clipboard.writeText(text).then(
      () => toast(L('Copiado', 'Copied')),
      () => toast(L('Não consegui copiar.', "I couldn't copy."))
    )
  return (
    <Card
      title={L('Conectar um celular', 'Connect a phone')}
      lead={L('Use o Tucano no iPhone com a sua conta daqui: suas DMs, suas aprovações e as perguntas que os agentes fazem pra você.', 'Use Tucano on an iPhone with your account here: your DMs, your approvals and the questions agents ask you.')}
      action={
        !code ? (
          <button className="btn btn--primary btn--sm" onClick={make}>
            <Icon name="plus" size={14} /> {L('Gerar código', 'Make a code')}
          </button>
        ) : undefined
      }
    >
      {code &&
        (left === 0 ? (
          <div className="row">
            <span className="small grow">{L('Esse código passou do prazo.', 'This code has expired.')}</span>
            <button className="btn btn--sm btn--primary" onClick={make}>
              {L('Gerar outro', 'Make another')}
            </button>
          </div>
        ) : (
          <div className="device-pair">
            <Qr text={code.link} />
            <div className="device-pair__text">
              <ol className="small steps-list">
                <li>{L('No iPhone, abra a Câmera ou o app do Tucano e aponte pro código.', 'On the iPhone, open the Camera or the Tucano app and point it at the code.')}</li>
                <li>{L('Toque em Abrir no Tucano e confirme.', 'Tap Open in Tucano and confirm.')}</li>
              </ol>
              <p className="muted small">
                {L('Vale uma vez, por mais', 'Good once, for')} {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.
              </p>
              <div className="device-pair__actions">
                <button className="btn btn--sm btn--ghost" onClick={() => copy(code.link)}>
                  <Icon name="copy" size={13} /> {L('Copiar link do app', 'Copy the app link')}
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => copy(code.browser)}>
                  <Icon name="globe" size={13} /> {L('Copiar link do navegador', 'Copy the browser link')}
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => setCode(null)}>
                  {L('Cancelar', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        ))}
      {!code && devices > 0 && <MyDevices count={devices} />}
      {error && <p className="note note--error">{error}</p>}
    </Card>
  )
}

// The browsers and phones signed in as me, each one disconnectable: on a server, under Conectar um
// celular; on a desktop, the iPhones paired over the home Wi-Fi, under Seu iPhone (HomePhone.tsx).
// One that never signed in was made by something that opened a pairing link before its person did
// (a chat's preview, say). `lead`: the line above the list; `refresh`: fetch again when it changes.
export function MyDevices({ count, lead, refresh }: { count: number; lead?: string; refresh?: unknown }): ReactNode {
  const [list, setList] = useState<Device[]>([])
  const reload = (): void => void myDevices().then(setList, () => {})
  useEffect(reload, [count, refresh])
  const disconnect = (d: Device): void => {
    const go = (): void => void removeDevice(d.id).then(reload, (e: unknown) => toast(message(e)))
    if (!d.current) return go()
    void confirmDialog({
      title: L('Desconectar este navegador?', 'Disconnect this browser?'),
      body: L('Ele sai da sua conta agora. Pra voltar, gere um código em outro aparelho conectado ou peça um novo convite.', "It signs out of your account now. To come back, make a code on another connected device or ask for a new invite."),
      confirm: L('Desconectar', 'Disconnect'),
      danger: true
    }).then((ok) => ok && go())
  }
  return (
    <>
      <p className="muted small">{lead ?? L(`Você está conectado em ${count} aparelho${count > 1 ? 's' : ''}.`, `You're signed in on ${count} device${count > 1 ? 's' : ''}.`)}</p>
      {list.length > 0 && (
        <div className="table">
          {list.map((d) => (
            <div key={d.id} className="table__row">
              <div className="grow person-row__who">
                <span>
                  <strong>{d.label === 'convite' ? L('Navegador do convite', 'Browser from the invite') : d.label}</strong>
                  {d.current && <span className="muted"> {L('(este)', '(this one)')}</span>}
                </span>
                <span className="muted small">
                  {[L(`adicionado ${ago(d.createdAt)}`, `added ${ago(d.createdAt)}`), d.seenAt ? L(`visto ${ago(d.seenAt)}`, `seen ${ago(d.seenAt)}`) : L('nunca usado', 'never used')].join(' · ')}
                </span>
              </div>
              <button className="btn btn--ghost btn--sm" onClick={() => disconnect(d)}>
                {L('Desconectar', 'Disconnect')}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// My own: the name the agents call me, what I do, and who covers for me while I'm away.
function MeCard(): ReactNode {
  const me = useStore(youPerson)
  const people = useStore((s) => s.people)
  const [name, setName] = useState(me?.name ?? '')
  const [about, setAbout] = useState(me?.about ?? '')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const others = people.filter((p) => p.id !== me?.id)
  const covering = me?.delegateTo && delegating(me, me.delegateTo) ? personById({ people }, me.delegateTo) : undefined
  const [to, setTo] = useState(others[0]?.id ?? '')
  const [until, setUntil] = useState(dateInput(Date.now() + 7 * 86_400_000))
  useEffect(() => {
    setName(me?.name ?? '')
    setAbout(me?.about ?? '')
  }, [me?.name, me?.about])
  if (!me) return null
  const dirty = name.trim() !== me.name || about.trim() !== me.about
  const save = (): void =>
    void setMyName(name.trim(), about.trim()).then(
      () => (setSaved(true), setError(''), setTimeout(() => setSaved(false), 1600)),
      (e: unknown) => setError(message(e))
    )
  const cover = (): void => {
    const end = new Date(`${until}T23:59:59`).getTime()
    void setDelegation(to, end).catch((e: unknown) => toast(message(e)))
  }
  return (
    <Card title={L('Você', 'You')}>
      <div className="grid2">
        <Field label={L('Como os agentes te chamam', 'What the agents call you')}>
          <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={L('O que você faz', 'What you do')} hint={L('Os agentes leem isso pra saber com quem falam.', 'The agents read this to know who they talk to.')}>
          <input value={about} maxLength={200} placeholder={L('Ex.: cuida do financeiro', 'E.g. handles finance')} onChange={(e) => setAbout(e.target.value)} />
        </Field>
      </div>
      <div className="row row--end">
        {error && <span className="note note--error">{error}</span>}
        {saved && <span className="note note--ok">{L('Salvo', 'Saved')}</span>}
        <button className="btn btn--sm" disabled={!dirty || !name.trim()} onClick={save}>
          {L('Salvar', 'Save')}
        </button>
      </div>
      {others.length > 0 && (
        <div className="key-row">
          <Icon name="users" />
          <div className="grow">
            <strong>{L('Quem me cobre', 'Who covers for me')}</strong>
            <p className="muted small">
              {covering
                ? L(`${covering.name} responde e aprova por você até ${time(me.delegateUntil!)}.`, `${covering.name} answers and approves for you until ${time(me.delegateUntil!)}.`)
                : L('Enquanto você estiver fora, alguém responde às perguntas e decide as aprovações que seriam suas.', 'While you’re away, someone answers the questions and decides the approvals that would be yours.')}
            </p>
            {!covering && (
              <div className="row row--center cover-row">
                <select value={to} aria-label={L('Quem', 'Who')} onChange={(e) => setTo(e.target.value)}>
                  {others.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <span className="small muted">{L('até', 'until')}</span>
                <input type="date" value={until} min={dateInput(Date.now())} onChange={(e) => setUntil(e.target.value)} />
              </div>
            )}
          </div>
          {covering ? (
            <button className="btn btn--sm" onClick={() => void setDelegation(null).catch((e: unknown) => toast(message(e)))}>
              {L('Voltei', 'I’m back')}
            </button>
          ) : (
            <button className="btn btn--sm" disabled={!to || !until} onClick={cover}>
              {L('Combinar', 'Set')}
            </button>
          )}
        </div>
      )}
    </Card>
  )
}

// ---------- Settings › Atividade ----------

const KINDS = (): [string, string][] => [
  ['', L('Tudo', 'Everything')],
  ['person', L('Pessoas', 'People')],
  ['invite', L('Convites', 'Invites')],
  ['approval', L('Aprovações', 'Approvals')],
  ['agent', L('Agentes', 'Agents')],
  ['connector', L('Conectores', 'Connectors')],
  ['skill', 'Skills'],
  ['routine', L('Rotinas', 'Routines')],
  ['channel', L('Canais', 'Channels')],
  ['proposal', L('Propostas', 'Proposals')]
]

// What removing someone does, said before it's done. A DM's routines stay with its person (off) for
// the 30 days, like the DM; the others go to the owner (db.handOver).
export const removalText = (name: string): string =>
  L(
    `O acesso de ${name} acaba agora, em todos os aparelhos. Os agentes e as rotinas fora das DMs passam pro dono do Tucano; as aprovações pendentes ficam com os admins.\n\nAs DMs de ${name} (com as rotinas que estão nelas, paradas) e as memórias ficam guardadas por 30 dias: um novo convite que traz a pessoa de volta devolve tudo. Depois disso, são apagadas.`,
    `${name}'s access ends now, on every device. Their agents and the routines outside DMs go to the Tucano's owner; pending approvals go to the admins.\n\n${name}'s DMs (with the routines in them, stopped) and memories are kept for 30 days: an invite that brings them back restores everything. After that, they're deleted.`
  )

// "Ana aprovou um pedido de Leo", in words, from what the log kept. Tools as the approval card says them.
// Only the owner manages admins: an admin's invite is theirs to revoke.
export const canRevoke = (invite: Pick<Invite, 'role'>, me: Pick<Person, 'role'> | undefined): boolean => !!me && (me.role === 'owner' || (me.role === 'admin' && invite.role !== 'admin'))

export function activityText(e: ActivityEntry, s: Pick<State, 'people' | 'agents'>, removed: Map<string, string>): string {
  const d = e.detail ?? {}
  const who = (id: unknown): string => (typeof id === 'string' ? (personById(s, id)?.name ?? removed.get(id) ?? L('alguém', 'someone')) : L('alguém', 'someone'))
  const agent = (id: unknown): string => (typeof id === 'string' ? (s.agents.find((a) => a.id === id)?.name ?? L('um agente', 'an agent')) : L('um agente', 'an agent'))
  const named = typeof d['name'] === 'string' ? (d['name'] as string) : ''
  const role = (r: unknown): string => (r === 'admin' || r === 'member' || r === 'owner' ? roleLabel(r).toLowerCase() : String(r))
  const tool = toolWords(String(d['tool'] ?? ''))
  switch (e.kind) {
    case 'person.joined':
      return L(`entrou como ${role(d['role'])}`, `joined as ${role(d['role'])}`)
    case 'person.restored':
      return L('voltou ao Tucano', 'came back')
    case 'person.removed':
      return L(`removeu ${named || who(e.target)}`, `removed ${named || who(e.target)}`)
    case 'person.role':
      return L(`mudou o papel de ${who(e.target)} pra ${role(d['to'])}`, `changed ${who(e.target)}'s role to ${role(d['to'])}`)
    case 'person.delegation':
      return d['to'] ? L(`pediu pra ${who(d['to'])} cobrir até ${typeof d['until'] === 'number' ? time(d['until']) : '…'}`, `asked ${who(d['to'])} to cover until ${typeof d['until'] === 'number' ? time(d['until']) : '…'}`) : L('voltou a responder por si', 'is answering for themselves again')
    case 'person.purged':
      return L(`apagou os dados de ${named || who(e.target)}`, `deleted ${named || who(e.target)}'s data`)
    case 'invite.created':
      return d['restore'] ? L(`convidou ${who(d['restore'])} de volta`, `invited ${who(d['restore'])} back`) : L(`criou um convite de ${role(d['role'])}`, `created a ${role(d['role'])} invite`)
    case 'invite.revoked':
      return L('revogou um convite', 'revoked an invite')
    case 'approval.decided':
      return L(`${d['decision'] === 'approved' ? 'aprovou' : 'recusou'} ${agent(d['agentId'])} usar ${tool} no ${String(d['connector'] ?? '')}`, `${d['decision'] === 'approved' ? 'approved' : 'refused'} ${agent(d['agentId'])} using ${tool} in ${String(d['connector'] ?? '')}`)
    case 'approval.always':
      return L(`deixou usar ${tool} no ${String(d['connector'] ?? '')} sem pedir`, `allowed ${tool} in ${String(d['connector'] ?? '')} without asking`)
    case 'proposal.forwarded':
      return L('pediu a um admin pra aplicar uma proposta do Tuca', 'asked an admin to apply a Tuca proposal')
    case 'team.imported':
      return L('importou um time', 'imported a team')
    case 'wiki.source_removed':
      return typeof d['title'] === 'string' ? L(`apagou a fonte “${d['title']}” da wiki`, `deleted the source “${d['title']}” from the wiki`) : d['private'] ? L('apagou uma fonte da wiki que veio de uma conversa privada', 'deleted a wiki source that came from a private conversation') : L('apagou uma fonte da wiki', 'deleted a wiki source')
    case 'channel.deleted':
      return named ? L(`excluiu o canal #${named}`, `deleted the #${named} channel`) : L('excluiu um canal', 'deleted a channel')
    case 'dm.deleted':
      return L('apagou uma conversa privada', 'deleted a private conversation')
    case 'channel.summary_edited':
      return L('editou o resumo de um canal', "edited a channel's summary")
    case 'db.optimized':
      return typeof d['before'] === 'number' && typeof d['after'] === 'number'
        ? L(
            `reescreveu o arquivo do Tucano (${(d['before'] / 1024 ** 2).toFixed(1)} MB → ${(d['after'] / 1024 ** 2).toFixed(1)} MB)`,
            `rebuilt the Tucano's file (${(d['before'] / 1024 ** 2).toFixed(1)} MB → ${(d['after'] / 1024 ** 2).toFixed(1)} MB)`
          )
        : L('reescreveu o arquivo do Tucano', "rebuilt the Tucano's file")
  }
  const [thing, verb] = e.kind.split('.')
  const noun = ({ agent: L('o agente', 'agent'), connector: L('o conector', 'connector'), skill: L('a skill', 'skill'), routine: L('a rotina', 'routine'), channel: L('o canal', 'channel') } as Record<string, string>)[thing ?? ''] ?? thing
  const did = ({ created: L('criou', 'created'), updated: L('mudou', 'changed'), removed: L('removeu', 'removed'), archived: L('arquivou', 'archived'), restored: L('reativou', 'restored'), decided: L('decidiu', 'decided') } as Record<string, string>)[verb ?? ''] ?? verb
  return `${did} ${noun}${named ? ` ${thing === 'channel' ? '#' : ''}${named}` : ''}`
}

export function ActivityPane(): ReactNode {
  const s = useStore((st) => ({ people: st.people, agents: st.agents }))
  const [personId, setPersonId] = useState('')
  const [kind, setKind] = useState('')
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [more, setMore] = useState(false)
  const [removed, setRemoved] = useState<Map<string, string>>(new Map())
  const PAGE = 50
  const load = (before?: number): void =>
    void loadActivity({ ...(personId ? { personId } : {}), ...(kind ? { kind } : {}), ...(before ? { before } : {}) }).then(
      (page) => {
        setEntries((cur) => (before ? [...cur, ...page] : page))
        setMore(page.length >= PAGE)
      },
      (e: unknown) => toast(message(e))
    )
  useEffect(() => load(), [personId, kind])
  useEffect(() => void removedPeople().then((r) => setRemoved(new Map(r.map((p) => [p.id, p.name]))), () => {}), [])
  const name = (id?: string): string => (id ? (personById(s, id)?.name ?? removed.get(id) ?? L('Alguém', 'Someone')) : 'Tucano')
  return (
    <Card title={L('Atividade', 'Activity')} lead={L('Quem fez o quê no Tucano. O que se diz nas DMs nunca aparece aqui.', 'Who did what in this Tucano. What’s said in DMs never shows here.')}>
      <div className="row activity-filters">
        <select value={personId} aria-label={L('Pessoa', 'Person')} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">{L('Todas as pessoas', 'Everyone')}</option>
          {s.people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={kind} aria-label={L('Tipo', 'Kind')} onChange={(e) => setKind(e.target.value)}>
          {KINDS().map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {entries.length === 0 ? (
        <p className="muted small">{L('Nada por aqui ainda.', 'Nothing here yet.')}</p>
      ) : (
        <div className="table activity-list">
          {entries.map((e) => (
            <div key={e.id} className="table__row">
              {e.personId ? <MeAvatar initials={initials(name(e.personId))} size={24} /> : <span className="activity-list__app"><Icon name="clock" size={13} /></span>}
              <span className="grow">
                <strong>{name(e.personId)}</strong> {activityText(e, s, removed)}
              </span>
              <span className="muted small">{time(e.at)}</span>
            </div>
          ))}
        </div>
      )}
      {more && (
        <div className="row row--center">
          <button className="btn btn--ghost btn--sm" onClick={() => load(entries.at(-1)?.at)}>
            {L('Mais antigos', 'Older')}
          </button>
        </div>
      )}
    </Card>
  )
}
