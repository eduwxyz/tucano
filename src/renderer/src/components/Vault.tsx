// Settings › Vault: secrets the agents use by reference ({{vault:name}}) and never see
// (src/core/vault). Listed by name; a value is typed once and never shown again: editing writes a
// new one over it. The vault opens on its own; the recovery code is for a computer whose key is gone.
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { VAULT_FIELDS, VAULT_KINDS, type VaultItem, type VaultItemInput, type VaultKind, type VaultStatus, type VaultUse } from '../../../shared/types'
import { agentById, amOwner, useStore, vaultCreate, vaultList, vaultNewRecoveryCode, vaultRecover, vaultRecoverySaved, vaultRemove, vaultReset, vaultSave, vaultStatus, vaultUses } from '../store'
import { confirmDialog } from './Dialogs'
import { Modal } from './Modal'
import { Card, Field, Toggle } from './Pages'
import { Select } from './Select'
import { AccessPicker } from './skills/SkillPeople'
import { AgentAvatar, ago, Icon, useCountdown, WarnBox } from './ui'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))

export const kindLabel = (k: VaultKind): string =>
  ({
    api_key: 'API key',
    token: 'Token',
    password: L('Senha', 'Password'),
    login: L('Login (usuário e senha)', 'Login (username and password)'),
    url: L('URL secreta', 'Secret URL'),
    note: L('Nota secreta', 'Secret note')
  })[k]

const fieldLabel = (kind: VaultKind, f: string): string =>
  f === 'username' ? L('Usuário', 'Username') : f === 'password' ? L('Senha', 'Password') : kind === 'url' ? 'URL' : kind === 'note' ? L('Texto', 'Text') : L('Valor', 'Value')

export function VaultPane(): ReactNode {
  const rev = useStore((s) => s.vaultRev)
  const owner = useStore(amOwner)
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [items, setItems] = useState<VaultItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null) // a recovery code just made: shown once
  useEffect(() => {
    let live = true
    void vaultStatus().then(
      (s) => {
        if (!live) return
        setStatus(s)
        if (s.state === 'open') void vaultList().then((l) => live && setItems(l), () => {})
        else setItems([])
      },
      (e: unknown) => live && setError(message(e))
    )
    return () => {
      live = false
    }
  }, [rev])

  if (error) return <Card title={L('Cofre', 'Vault')}><p className="field__error">{error}</p></Card>
  if (!status) return null
  return (
    <>
      {status.state === 'empty' && <Empty owner={owner} onCode={setCode} />}
      {status.state === 'needs_recovery' && <Recover owner={owner} count={status.count} onCode={setCode} />}
      {status.state === 'unavailable' && (
        <Card title={L('Cofre', 'Vault')} lead={L('O cofre não consegue abrir neste computador agora.', "The vault can't open on this computer right now.")}>
          <p className="field__error">{status.problem}</p>
          <Technical>
            <p>{L('O cofre guarda a chave dele no chaveiro do sistema (Chaves no Mac, a proteção de dados do Windows, o GNOME Keyring ou o KWallet no Linux). Sem um chaveiro aberto, o Tucano não guarda segredos, pra nunca deixá-los sem cifrar.', "The vault keeps its key in the system's keychain (the Mac's Keychain, Windows data protection, GNOME Keyring or KWallet on Linux). With no keychain open, Tucano keeps no secrets, so they're never left unencrypted.")}</p>
          </Technical>
        </Card>
      )}
      {status.state === 'open' && <Open status={status} items={items} owner={owner} onCode={setCode} />}
      {code && <RecoveryCode code={code} onClose={() => setCode(null)} />}
    </>
  )
}

// The technical part, folded at the end: what the screen says simply, said exactly.
function Technical({ children }: { children: ReactNode }): ReactNode {
  return (
    <details className="vault-tech">
      <summary>{L('Detalhes técnicos', 'Technical details')}</summary>
      <div className="vault-tech__body">{children}</div>
    </details>
  )
}

// How the vault keeps secrets, for whoever wants to know.
function HowItWorks(): ReactNode {
  return (
    <Technical>
      <ul>
        <li>{L('Os agentes escrevem {{vault:nome}} e o app põe o valor só na hora de usar. O que volta (respostas, erros, páginas) vem com o valor trocado por [vault:nome], inclusive em base64, hex e URL. Nem o agente nem o modelo de IA recebem o valor.', 'Agents write {{vault:name}} and the app puts the value in only when it\'s used. What comes back (responses, errors, pages) has the value replaced by [vault:name], in base64, hex and URL form too. Neither the agent nor the AI model gets the value.')}</li>
        <li>{L('Cada valor é cifrado com AES-256-GCM por uma chave do cofre. Essa chave fica guardada de duas formas: pela chave deste computador, no chaveiro do sistema (por isso o cofre abre sozinho), e pelo código de recuperação (Argon2id). Uma cópia dos dados ou um backup não abre sem uma das duas.', "Each value is encrypted with AES-256-GCM by a vault key. That key is kept two ways: by this computer's key, in the system keychain (that's why the vault opens on its own), and by the recovery code (Argon2id). A copy of the data or a backup doesn't open without one of them.")}</li>
        <li>{L('Os nomes, descrições, hosts e quem usa cada segredo ficam legíveis no banco e nos backups; só os valores são cifrados.', 'Names, descriptions, hosts and who uses each secret are readable in the database and in backups; only the values are encrypted.')}</li>
        <li>{L('Com o Tucano aberto, quem controla este computador (o root, o administrador) ainda pode ler a memória dele. Nenhum cofre que abre sozinho evita isso.', 'While Tucano is open, whoever controls this computer (root, the administrator) can still read its memory. No vault that opens on its own prevents that.')}</li>
      </ul>
    </Technical>
  )
}

function Empty({ owner, onCode }: { owner: boolean; onCode: (c: string) => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = (): void => {
    setBusy(true)
    setError(null)
    vaultCreate().then(
      (r) => onCode(r.recoveryCode),
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }
  return (
    <Card title={L('Cofre', 'Vault')} lead={L('Guarde senhas, chaves de API e links secretos pros agentes usarem sem ver o valor. Você escolhe quais agentes usam cada um.', 'Keep passwords, API keys and secret links for the agents to use without seeing the value. You pick which agents use each one.')}>
      <div className="row">
        {owner ? (
          <button className="btn btn--primary btn--sm" disabled={busy} onClick={create}>
            <Icon name="lock" size={14} /> {L('Criar o cofre', 'Create the vault')}
          </button>
        ) : (
          <span className="hint">{L('Só o dono do Tucano cria o cofre.', "Only the Tucano's owner creates the vault.")}</span>
        )}
        {error && <span className="field__error">{error}</span>}
      </div>
      <HowItWorks />
    </Card>
  )
}

function Recover({ owner, count, onCode }: { owner: boolean; count: number; onCode: (c: string) => void }): ReactNode {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const open = (): void => {
    setBusy(true)
    setError(null)
    vaultRecover(code).then(
      () => setCode(''),
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }
  const restart = (keepItems: boolean): void =>
    void confirmDialog(
      keepItems
        ? {
            title: L('Recomeçar mantendo os itens?', 'Start over keeping the items?'),
            body: L('Os itens continuam na lista, com nome, descrição e quem usa. Os valores antigos se perdem: você digita cada um de novo, e cada item volta a funcionar assim que for salvo.', 'The items stay on the list, with their name, description and who uses them. The old values are lost: you type each one again, and each item works again as soon as it is saved.'),
            confirm: L('Recomeçar mantendo os itens', 'Start over keeping the items')
          }
        : {
            title: L('Começar do zero?', 'Start from scratch?'),
            body: L('Todos os itens são apagados e o cofre fica vazio. Não dá pra desfazer.', "Every item is deleted and the vault is left empty. This can't be undone."),
            confirm: L('Apagar tudo e começar do zero', 'Delete everything and start from scratch'),
            danger: true
          }
    ).then((ok) => {
      if (!ok) return
      setBusy(true)
      vaultReset(keepItems).then(
        (r) => onCode(r.recoveryCode),
        (e: unknown) => (setError(message(e)), setBusy(false))
      )
    })
  const n = count === 1 ? L('1 segredo', '1 secret') : L(`${count} segredos`, `${count} secrets`)
  return (
    <Card
      title={L('O cofre está trancado neste computador', 'The vault is locked on this computer')}
      lead={L(`Os ${n} vieram de outro computador ou de um backup. Enquanto o cofre estiver trancado, os agentes não conseguem usá-los.`, `The ${n} came from another computer or a backup. While the vault is locked, the agents can't use them.`)}
    >
      {owner ? (
        <>
          <Field label={L('Tem o código de recuperação? Digite aqui', 'Have the recovery code? Type it here')} hint={error ? undefined : L('Tudo volta como estava, sem digitar nenhuma senha de novo.', 'Everything comes back as it was, without typing any password again.')} error={error}>
            <input className="mono" autoComplete="off" spellCheck={false} value={code} placeholder="TUCANO-XXXXXX-XXXXXX-…" onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && code.trim() && open()} />
          </Field>
          <div className="row">
            <button className="btn btn--primary btn--sm" disabled={busy || !code.trim()} onClick={open}>
              {L('Destravar', 'Unlock')}
            </button>
          </div>
          <div className="vault-choices">
            <strong>{L('Não tem o código?', "Don't have the code?")}</strong>
            <div className="vault-choice">
              <div>
                <span>{L('Recomeçar mantendo os itens', 'Start over keeping the items')}</span>
                <span className="hint">{L('Os nomes e quem usa cada um ficam. Você só digita as senhas de novo.', 'The names and who uses each stay. You just type the passwords again.')}</span>
              </div>
              <button className="btn btn--sm" disabled={busy} onClick={() => restart(true)}>
                {L('Recomeçar', 'Start over')}
              </button>
            </div>
            <div className="vault-choice">
              <div>
                <span>{L('Começar do zero', 'Start from scratch')}</span>
                <span className="hint">{L('Apaga tudo e deixa o cofre vazio.', 'Deletes everything and leaves the vault empty.')}</span>
              </div>
              <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => restart(false)}>
                {L('Começar do zero', 'Start from scratch')}
              </button>
            </div>
          </div>
        </>
      ) : (
        <span className="hint">{L('Peça ao dono do Tucano pra destravar o cofre.', "Ask the Tucano's owner to unlock the vault.")}</span>
      )}
      <Technical>
        <ul>
          <li>{L('Por que trancou: o cofre abre sozinho com uma chave guardada no chaveiro do sistema do computador onde foi criado. Essa chave não vai no backup, de propósito; assim, um backup copiado não abre os segredos.', "Why it locked: the vault opens on its own with a key kept in the system keychain of the computer it was made on. That key doesn't go in the backup, on purpose; that way, a copied backup doesn't open the secrets.")}</li>
          <li>{L('O código de recuperação (160 bits aleatórios, derivado com Argon2id) abre a chave do cofre. Ao destravar, este computador ganha uma chave própria no chaveiro e o cofre volta a abrir sozinho aqui. O mesmo código continua valendo.', 'The recovery code (160 random bits, derived with Argon2id) opens the vault key. Once unlocked, this computer gets its own key in the keychain and the vault opens on its own here again. The same code keeps working.')}</li>
          <li>{L('Recomeçar (com ou sem os itens) cria uma chave nova e um código de recuperação novo. Os valores antigos ficam impossíveis de abrir, mesmo que o código antigo apareça depois.', 'Starting over (with or without the items) makes a new key and a new recovery code. The old values become impossible to open, even if the old code turns up later.')}</li>
          <li>{L('Itens mantidos ficam marcados "sem valor"; um agente que tentar usar um deles recebe um aviso pra pedir que o valor seja salvo de novo.', 'Kept items are marked "no value"; an agent that tries to use one is told to ask for the value to be saved again.')}</li>
        </ul>
      </Technical>
    </Card>
  )
}

// Shown once: copy it, then type its last group to say it's kept.
const LOCK_SECONDS = 5
function RecoveryCode({ code, onClose }: { code: string; onClose: () => void }): ReactNode {
  const [typed, setTyped] = useState('')
  const [copied, setCopied] = useState(false)
  const last = code.split('-').at(-1) ?? ''
  const ok = typed.trim().toUpperCase() === last
  const done = (): void => void vaultRecoverySaved().then(onClose, onClose)
  // Shown only once: for the first seconds nothing closes it (✕, Esc, a click outside, "Later").
  const wait = useCountdown(LOCK_SECONDS)
  const locked = wait > 0
  return (
    <Modal title={L('Código de recuperação', 'Recovery code')} onClose={onClose} locked={locked}>
      <p>
        {L(
          'Guarde este código num lugar seguro fora deste computador (um gerenciador de senhas, papel). Ele abre o cofre num computador novo ou depois de restaurar um backup. Ele aparece só agora.',
          'Keep this code somewhere safe off this computer (a password manager, paper). It opens the vault on a new computer or after restoring a backup. It shows only now.'
        )}
      </p>
      <div className="vault-code-row">
        <code className="mono vault-code">{code}</code>
        <button className="icon-btn icon-btn--sm" title={L('Copiar', 'Copy')} onClick={() => void navigator.clipboard?.writeText(code).then(() => setCopied(true), () => {})}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      </div>
      <Field label={L(`Pra confirmar, digite o último bloco (${last.length} caracteres)`, `To confirm, type the last group (${last.length} characters)`)}>
        <input className="mono" autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ok && done()} />
      </Field>
      <div className="row row--between">
        <button className="btn btn--sm btn--ghost" disabled={locked} onClick={onClose}>
          {locked ? L(`Depois (${wait})`, `Later (${wait})`) : L('Depois', 'Later')}
        </button>
        <button className="btn btn--sm btn--primary" disabled={!ok} onClick={done}>
          {L('Já guardei', "I've kept it")}
        </button>
      </div>
    </Modal>
  )
}

const blank = (): VaultItemInput => ({ name: '', kind: 'api_key', description: '', values: {}, access: { all: false, agentIds: [] }, hosts: [], scope: 'http', askEachUse: false })

function Open({ status, items, owner, onCode }: { status: VaultStatus; items: VaultItem[]; owner: boolean; onCode: (c: string) => void }): ReactNode {
  const agents = useStore((s) => s.agents)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string>('')
  const [agent, setAgent] = useState<string>('')
  const [draft, setDraft] = useState<{ input: VaultItemInput; item?: VaultItem } | null>(null)
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return items.filter(
      (i) =>
        (!q || i.name.includes(q) || i.description.toLowerCase().includes(q) || i.hosts.some((h) => h.includes(q))) &&
        (!kind || i.kind === kind) &&
        (!agent || i.access.all || i.access.agentIds.includes(agent))
    )
  }, [items, query, kind, agent])
  const newCode = (): void =>
    void confirmDialog({
      title: L('Trocar o código de recuperação?', 'Replace the recovery code?'),
      body: L(
        'Você recebe um código novo e o atual para de funcionar. Os segredos e os agentes continuam como estão.\n\nTenha onde anotar antes de continuar: o código novo aparece uma vez só. Backups feitos antes da troca continuam abrindo com o código atual.',
        'You get a new code and the current one stops working. The secrets and the agents stay as they are.\n\nHave somewhere to write it down before going on: the new code shows only once. Backups made before the change still open with the current code.'
      ),
      confirm: L('Trocar o código', 'Replace the code'),
      waitSeconds: LOCK_SECONDS
    }).then((ok) => ok && void vaultNewRecoveryCode().then((r) => onCode(r.recoveryCode)))
  const remove = (i: VaultItem): void =>
    void confirmDialog({
      title: L(`Apagar “${i.name}”?`, `Delete “${i.name}”?`),
      body: L('O valor some, e os agentes que usam {{vault:' + i.name + '}} param de conseguir.', 'The value goes, and agents using {{vault:' + i.name + '}} can no longer.'),
      confirm: L('Apagar', 'Delete'),
      danger: true
    }).then((ok) => ok && void vaultRemove(i.id))
  const edit = (i: VaultItem): void => setDraft({ item: i, input: { id: i.id, name: i.name, kind: i.kind, description: i.description, values: {}, access: i.access, hosts: i.hosts, scope: i.scope, askEachUse: i.askEachUse } })
  const team = agents.filter((a) => !a.archived && a.kind !== 'tuca')
  const missing = items.filter((i) => i.missing).length
  // When it was last used, and by whom (with several agents, the "who" is what matters).
  const usedBy = (i: VaultItem): string => {
    const who = agents.find((a) => a.id === i.lastUsedBy)?.name
    const when = ago(i.lastUsedAt!)
    return who ? L(`usado ${when} por ${who}`, `used ${when} by ${who}`) : L(`usado ${when}`, `used ${when}`)
  }
  return (
    <Card
      title={L('Cofre', 'Vault')}
      lead={L('Os agentes usam estes segredos sem ver o valor. Depois de salvo, ninguém vê o valor de novo, nem você: dá só pra trocar.', 'The agents use these secrets without seeing the value. Once saved, no one sees the value again, not even you: it can only be replaced.')}
      action={
        <div className="row">
          {owner && (
            <button className="btn btn--sm" onClick={newCode}>
              <Icon name="shield" size={14} /> {L('Trocar código de recuperação', 'Replace recovery code')}
            </button>
          )}
          <button className="btn btn--primary btn--sm" onClick={() => setDraft({ input: blank() })}>
            <Icon name="plus" size={14} /> {L('Novo segredo', 'New secret')}
          </button>
        </div>
      }
    >
      {(missing > 0 || (!status.recoverySaved && owner)) && (
        <div className="vault-alerts">
          {missing > 0 && (
            <WarnBox icon="lock" role="status">
              {missing === 1 ? L('1 segredo precisa do valor de novo pra voltar a funcionar. Use “Digitar valor” nele.', '1 secret needs its value again to work again. Use “Type value” on it.') : L(`${missing} segredos precisam do valor de novo pra voltar a funcionar. Use “Digitar valor” em cada um.`, `${missing} secrets need their value again to work again. Use “Type value” on each one.`)}
            </WarnBox>
          )}
          {!status.recoverySaved && owner && (
            <WarnBox
              icon="shield"
              role="status"
              action={
                <button className="btn btn--sm" onClick={newCode}>
                  {L('Trocar o código', 'Replace the code')}
                </button>
              }
            >
              {L('Você ainda não confirmou que guardou o código de recuperação. Sem ele, o cofre não abre em outro computador.', "You haven't confirmed you kept the recovery code. Without it, the vault won't open on another computer.")}
            </WarnBox>
          )}
        </div>
      )}
      {items.length > 0 && (
        <div className="vault-filters">
          <input type="search" aria-label={L('Buscar', 'Search')} placeholder={L('Buscar por nome, descrição ou host', 'Search by name, description or host')} value={query} onChange={(e) => setQuery(e.target.value)} />
          <Select aria-label={L('Tipo', 'Kind')} value={kind} options={[{ value: '', label: L('Todos os tipos', 'All kinds') }, ...VAULT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))]} onChange={(v) => setKind(v ?? '')} />
          <Select aria-label={L('Agente', 'Agent')} value={agent} options={[{ value: '', label: L('Todos os agentes', 'All agents') }, ...team.map((a) => ({ value: a.id, label: a.name }))]} onChange={(v) => setAgent(v ?? '')} />
        </div>
      )}
      {items.length === 0 ? (
        <div className="read-empty">
          <p>{L('Nenhum segredo ainda.', 'No secrets yet.')}</p>
          <p>{L('Adicione uma chave de API, uma senha ou um link secreto e escolha quais agentes podem usar.', 'Add an API key, a password or a secret link and pick which agents may use it.')}</p>
        </div>
      ) : shown.length === 0 ? (
        <p className="muted">{L('Nada com esse filtro.', 'Nothing with that filter.')}</p>
      ) : (
        <section className="read-group">
          {shown.map((i) => (
            <div key={i.id} className="skill-line vault-line">
              <Icon name="lock" size={16} />
              <span className="skill-line__body">
                <strong className="mono">
                  {i.name}
                  {i.missing && <span className="vault-missing">{L('sem valor', 'no value')}</span>}
                </strong>
                {i.description && <span className="skill-line__desc">{i.description}</span>}
                <span className="skill-line__meta">
                  {kindLabel(i.kind)} · <Users item={i} /> · {i.scope === 'http' ? L(`só pra ${i.hosts.join(', ')}`, `only to ${i.hosts.join(', ')}`) : L('em qualquer ferramenta', 'in any tool')}
                  {i.askEachUse && <> · {L('pede aprovação', 'asks approval')}</>}
                  {' · '}
                  {i.lastUsedAt ? usedBy(i) : L('nunca usado', 'never used')}
                </span>
              </span>
              {i.missing ? (
                <button className="btn btn--sm btn--primary" onClick={() => edit(i)}>
                  {L('Digitar valor', 'Type value')}
                </button>
              ) : (
                <button className="icon-btn icon-btn--sm" title={L('Editar', 'Edit')} onClick={() => edit(i)}>
                  <Icon name="edit" size={14} />
                </button>
              )}
              <button className="icon-btn icon-btn--sm" title={L('Apagar', 'Delete')} onClick={() => remove(i)}>
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </section>
      )}
      <HowItWorks />
      {draft && <ItemForm key={draft.item?.id ?? 'new'} initial={draft.input} item={draft.item} onClose={() => setDraft(null)} />}
    </Card>
  )
}

function Users({ item }: { item: VaultItem }): ReactNode {
  const agents = useStore((s) => (item.access.all ? [] : item.access.agentIds.map((id) => agentById(s, id)).filter((a) => !!a && !a.archived)))
  if (item.access.all) return <span>{L('todos os agentes', 'all agents')}</span>
  if (!agents.length) return <span>{L('nenhum agente', 'no agent')}</span>
  return (
    // Faces only, side by side; the name on hover (and for screen readers).
    <span className="who vault-who" aria-label={agents.map((a) => a!.name).join(', ')}>
      {agents.map((a) => (
        <span key={a!.id} className="who__one" title={a!.name}>
          <AgentAvatar agent={a!} size={16} />
        </span>
      ))}
    </span>
  )
}

function ItemForm({ initial, item, onClose }: { initial: VaultItemInput; item?: VaultItem; onClose: () => void }): ReactNode {
  const [draft, setDraft] = useState(initial)
  const [hosts, setHosts] = useState(initial.hosts.join(', '))
  const [show, setShow] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [uses, setUses] = useState<VaultUse[]>([])
  const agents = useStore((s) => s.agents)
  useEffect(() => {
    if (item) void vaultUses(item.id).then(setUses, () => {})
  }, [item])
  const set = (patch: Partial<VaultItemInput>): void => setDraft((d) => ({ ...d, ...patch }))
  const fields = VAULT_FIELDS[draft.kind]
  const keeps = !!item && item.kind === draft.kind && !item.missing // a field left empty keeps what's saved
  const typed = (f: string): string => draft.values?.[f] ?? ''
  const setValue = (f: string, v: string): void => set({ values: { ...draft.values, [f]: v } })
  const ready = draft.name.trim() && (keeps || !!typed(fields[0]!))
  const save = (): void => {
    setBusy(true)
    setError(null)
    vaultSave({ ...draft, hosts: hosts.split(/[\s,]+/).filter(Boolean) }).then(
      () => {
        setDraft((d) => ({ ...d, values: {} })) // the value leaves the page
        onClose()
      },
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }
  const input = (f: string): ReactNode => {
    const placeholder = keeps ? L('•••••••• guardado; digite pra trocar', '•••••••• saved; type to replace') : ''
    const common = { autoComplete: 'off', spellCheck: false, value: typed(f), placeholder, onChange: (e: { target: { value: string } }) => setValue(f, e.target.value) }
    if (f === 'username') return <input className="mono" type="text" {...common} />
    // Like a password field: the eye inside shows what's being typed (never the saved value, which doesn't come back).
    const eye = (
      <button type="button" className="vault-secret__eye" aria-pressed={show} title={show ? L('Esconder', 'Hide') : L('Mostrar o que estou digitando', "Show what I'm typing")} aria-label={show ? L('Esconder', 'Hide') : L('Mostrar o que estou digitando', "Show what I'm typing")} onClick={() => setShow((v) => !v)}>
        <Icon name={show ? 'eye-off' : 'eye'} size={16} />
      </button>
    )
    return (
      <span className={`vault-secret ${draft.kind === 'note' ? 'vault-secret--area' : ''}`}>
        {draft.kind === 'note' ? <textarea rows={4} className="mono" style={show ? undefined : ({ WebkitTextSecurity: 'disc' } as CSSProperties)} {...common} /> : <input className="mono" type={show ? 'text' : 'password'} {...common} />}
        {eye}
      </span>
    )
  }
  return (
    <Modal title={item ? L(`Editar ${item.name}`, `Edit ${item.name}`) : L('Novo segredo', 'New secret')} variant="form" onClose={onClose}>
      <div className="agent-form">
        <Card title={item ? L(`Editar ${item.name}`, `Edit ${item.name}`) : L('Novo segredo', 'New secret')}>
          <div className="grid2">
            <Field label={L('Nome', 'Name')} hint={L(`Os agentes usam como {{vault:${draft.name.trim().toLowerCase() || 'nome'}}}.`, `Agents use it as {{vault:${draft.name.trim().toLowerCase() || 'name'}}}.`)}>
              <input autoFocus={!item} className="mono" value={draft.name} placeholder="github_token" onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/\s+/g, '_') })} />
            </Field>
            <Field label={L('Tipo', 'Kind')} group>
              <Select aria-label={L('Tipo', 'Kind')} value={draft.kind} options={VAULT_KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} onChange={(v) => v && set({ kind: v as VaultKind, values: {} })} />
            </Field>
          </div>
          {draft.kind === 'note' && (
            // A note is sent, never read: what an agent should follow belongs in its instructions or a skill.
            <WarnBox icon="lock">
              {L(
                'O agente nunca lê esta nota. Ele só consegue enviá-la para algum lugar (uma API, um formulário, um arquivo) sem ver o conteúdo. Se são instruções que o agente deve seguir, coloque nas instruções do agente ou numa skill.',
                "The agent never reads this note. It can only send it somewhere (an API, a form, a file) without seeing what it says. If these are instructions the agent should follow, put them in the agent's instructions or in a skill."
              )}
            </WarnBox>
          )}
          <Field label={L('Pra que serve', 'What it is for')} hint={L('Vai no prompt dos agentes que usam: diga o que abre e quando usar. Nunca o valor.', 'Goes in the prompt of the agents that use it: say what it opens and when to use it. Never the value.')}>
            <input value={draft.description} maxLength={500} placeholder={L('Token do GitHub, só leitura nos repositórios do time', "GitHub token, read-only on the team's repositories")} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          {fields
            .slice()
            .reverse()
            .map((f) => (
              <Field key={f} label={fieldLabel(draft.kind, f)} hint={f === fields[0] && keeps ? L('O valor salvo nunca aparece de novo. Deixe vazio pra manter.', 'The saved value never shows again. Leave empty to keep it.') : undefined}>
                {input(f)}
              </Field>
            ))}
          <Field label={L('Onde os agentes podem usar', 'Where agents can use it')} group>
            <div className="segmented">
              <button type="button" className={draft.scope === 'http' ? 'is-active' : ''} onClick={() => set({ scope: 'http' })}>
                {L('Só em requisições HTTP (recomendado)', 'Only in HTTP requests (recommended)')}
              </button>
              <button type="button" className={draft.scope === 'any' ? 'is-active' : ''} onClick={() => set({ scope: 'any' })}>
                {L('Em qualquer ferramenta', 'In any tool')}
              </button>
            </div>
          </Field>
          <Field
            label={L('Hosts permitidos', 'Allowed hosts')}
            hint={
              draft.scope === 'http'
                ? L('Pra onde o segredo pode ir, separados por vírgula: api.github.com, *.exemplo.com. Nenhum outro recebe.', 'Where the secret may go, comma-separated: api.github.com, *.example.com. No other gets it.')
                : L('Opcional: em requisições HTTP, só pra esses. Em comandos, arquivos, navegador e conectores o segredo vai onde o agente puser: libere só pra agentes de confiança.', 'Optional: in HTTP requests, only to these. In commands, files, the browser and connectors the secret goes wherever the agent puts it: allow only trusted agents.')
            }
          >
            <input className="mono" value={hosts} placeholder="api.github.com" onChange={(e) => setHosts(e.target.value)} />
          </Field>
          <div className="vault-toggle">
            <Toggle on={draft.askEachUse} onChange={(askEachUse) => set({ askEachUse })} label={L('Pedir aprovação a cada uso', 'Ask for approval on each use')} />
            <span>{L('Pedir aprovação a cada uso', 'Ask for approval on each use')}</span>
          </div>
          <Field label={L('Quais agentes usam', 'Which agents use it')} group>
            <AccessPicker value={draft.access} onChange={(access) => set({ access })} />
          </Field>
          {uses.length > 0 && (
            <Field label={L('Últimos usos', 'Latest uses')} group>
              <ul className="muted small" style={{ margin: 0, paddingLeft: 18 }}>
                {uses.slice(0, 8).map((u) => (
                  <li key={u.id}>
                    {agents.find((a) => a.id === u.agentId)?.name ?? L('um agente', 'an agent')} · {u.tool} · {u.outcome === 'used' ? L('usou', 'used') : L('recusado', 'refused')} · {ago(u.at)}
                  </li>
                ))}
              </ul>
            </Field>
          )}
          <div className="row row--between">
            <span />
            <div className="row">
              {error && <span className="field__error">{error}</span>}
              <button className="btn btn--sm btn--ghost" onClick={onClose}>
                {L('Cancelar', 'Cancel')}
              </button>
              <button className="btn btn--sm btn--primary" disabled={busy || !ready} onClick={save}>
                {item ? L('Salvar', 'Save') : L('Guardar no cofre', 'Save to the vault')}
              </button>
            </div>
          </div>
        </Card>
      </div>
    </Modal>
  )
}
