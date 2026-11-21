// The Cofre: keys the agents use by name, one command at a time (src/core/vault.ts). A value goes in
// once and never comes back to a screen: a key reads as its name, its last characters, the agents that
// may use it and whether each use asks first. In a team there are two drawers: the team's (an admin's
// to make and give out) and each person's own (theirs alone, used only in work they asked for).
import { L, locale } from '../../../shared/lang'
import { keyNameError, parseEnv, type EnvLine, type VaultKey, type VaultUse } from '../../../shared/vault'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { agentById, amAdmin, importVaultKeys, isTeam, navigate, personById, removeVaultKey, saveVaultKey, setVaultKeyAgent, teamMode, useStore, vaultKeys, vaultUses, type Agent } from '../store'
import { confirmDialog } from './Dialogs'
import { Modal } from './Modal'
import { Field, Page, Toggle } from './Pages'
import { AgentAvatar, Icon } from './ui'

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const when = (at: number): string => new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function VaultPage({ tab = 'keys' }: { tab?: 'keys' | 'log' }): ReactNode {
  const [keys, setKeys] = useState<VaultKey[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<VaultKey | 'new' | 'new-mine' | null>(null)
  const [importing, setImporting] = useState(false)
  const admin = useStore(amAdmin)
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const load = (): void => void vaultKeys().then(setKeys, (e: unknown) => setError(errorOf(e)))
  useEffect(load, [])

  const teamKeys = (keys ?? []).filter((k) => !k.owner)
  const mine = (keys ?? []).filter((k) => k.owner === you)
  // A member makes only their own; alone, everything is just "Cofre".
  const newKey = (): void => setEditing(team && !admin ? 'new-mine' : 'new')
  const remove = (k: VaultKey): void =>
    void confirmDialog({
      title: L(`Apagar ${k.name}?`, `Delete ${k.name}?`),
      body: L('Os agentes deixam de poder usar essa chave, e o valor sai do chaveiro do sistema. Um conector que aponta pra ela para de conectar. Não dá pra desfazer.', 'The agents can no longer use this key, and its value leaves the system keychain. A connector pointing to it stops connecting. This can’t be undone.'),
      confirm: L(`Apagar ${k.name}`, `Delete ${k.name}`),
      danger: true
    }).then((ok) => {
      if (ok) void removeVaultKey(k.id).then(load, (e: unknown) => setError(errorOf(e)))
    })

  const list = (items: VaultKey[], canChange: boolean): ReactNode =>
    items.length === 0 ? null : (
      <div className="table vault-keys">
        {items.map((k) => (
          <KeyRow key={k.id} k={k} canChange={canChange} onEdit={() => setEditing(k)} onRemove={() => remove(k)} />
        ))}
      </div>
    )

  return (
    <Page
      title={L('Cofre', 'Cofre')}
      subtitle={L(
        'Chaves que os agentes usam pelo nome, só no comando que pede. O valor nunca volta pra tela nem pro modelo: no que o comando imprime, aparece como [cofre:NOME].',
        'Keys the agents use by name, only in the command that asks for them. The value never comes back to the screen or to the model: in what the command prints, it shows as [cofre:NAME].'
      )}
      actions={
        tab === 'keys' && (
          <>
            <button className="btn btn--sm btn--ghost" onClick={() => setImporting(true)}>
              {L('Importar .env', 'Import .env')}
            </button>
            <button className="btn btn--sm btn--primary" onClick={newKey}>
              <Icon name="plus" size={14} /> {L('Nova chave', 'New key')}
            </button>
          </>
        )
      }
    >
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'keys'} className={tab === 'keys' ? 'is-active' : ''} onClick={() => navigate({ kind: 'vault', tab: 'keys' })}>
          {L('Chaves', 'Keys')}
        </button>
        <button role="tab" aria-selected={tab === 'log'} className={tab === 'log' ? 'is-active' : ''} onClick={() => navigate({ kind: 'vault', tab: 'log' })}>
          {L('Registro', 'Log')}
        </button>
      </div>
      {error && <p className="note note--error">{error}</p>}
      {tab === 'log' ? (
        <UsesLog />
      ) : keys === null ? null : !team ? (
        teamKeys.length ? list(teamKeys, true) : <Empty onNew={newKey} />
      ) : (
        <>
          <section className="vault-drawer">
            <header className="vault-drawer__head">
              <h3>{L('Do time', 'The team’s')}</h3>
              <span className="muted small">{admin ? L('Você cria e libera; os agentes usam em qualquer trabalho.', 'You make and give them out; the agents use them in any work.') : L('Só um admin cria e libera essas.', 'Only an admin makes and gives these out.')}</span>
            </header>
            {list(teamKeys, admin) ?? <p className="muted small">{L('Nenhuma chave do time ainda.', 'No team keys yet.')}</p>}
          </section>
          <section className="vault-drawer">
            <header className="vault-drawer__head">
              <h3>{L('Minhas', 'Mine')}</h3>
              <span className="muted small">{L('Só você vê. Um agente só usa num trabalho que você pediu.', 'Only you see them. An agent uses one only in work you asked for.')}</span>
              <button className="link link--quiet" onClick={() => setEditing('new-mine')}>
                {L('Nova chave minha…', 'New key of mine…')}
              </button>
            </header>
            {list(mine, true) ?? <p className="muted small">{L('Nenhuma chave sua.', 'No keys of yours.')}</p>}
          </section>
        </>
      )}
      {editing && <KeyEditor k={typeof editing === 'string' ? undefined : editing} mine={editing === 'new-mine'} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
      {importing && <ImportEnv have={keys ?? []} mine={team && !admin} onClose={() => setImporting(false)} onSaved={() => (setImporting(false), load())} />}
    </Page>
  )
}

function Empty({ onNew }: { onNew: () => void }): ReactNode {
  return (
    <div className="empty-card">
      <Icon name="key" size={22} />
      <p>{L('Nenhuma chave ainda. Salve aqui a chave de uma API (Stripe, OpenAI, um banco) e libere pro agente que vai usar: ele usa pelo nome, num comando, e nunca vê o valor.', 'No keys yet. Save an API key here (Stripe, OpenAI, a database) and give it to the agent that will use it: it uses it by name, in a command, and never sees the value.')}</p>
      <button className="btn btn--sm btn--primary" onClick={onNew}>
        {L('Nova chave', 'New key')}
      </button>
    </div>
  )
}

function KeyRow({ k, canChange, onEdit, onRemove }: { k: VaultKey; canChange: boolean; onEdit: () => void; onRemove: () => void }): ReactNode {
  const agents = useStore((s) => k.agents.map((id) => agentById(s, id)).filter((a): a is Agent => !!a && !a.archived))
  return (
    <div className="table__row vault-key">
      <Icon name="key" size={14} />
      <span className="grow vault-key__main">
        <code className="vault-key__name">{k.name}</code>
        <span className="muted small vault-key__hint">{k.hint}</span>
        {k.approve && <span className="tag tag--warn">{L('pede aprovação', 'asks approval')}</span>}
        {k.note && <span className="muted small vault-key__note">{k.note}</span>}
      </span>
      <span className="vault-key__agents" title={agents.map((a) => a.name).join(', ')}>
        {agents.length ? agents.slice(0, 5).map((a) => <AgentAvatar key={a.id} agent={a} size={20} />) : <span className="muted small">{L('nenhum agente', 'no agent')}</span>}
        {agents.length > 5 && <span className="muted small">+{agents.length - 5}</span>}
      </span>
      <span className="muted small vault-key__used">{k.usedAt ? L(`usada ${when(k.usedAt)}`, `used ${when(k.usedAt)}`) : L('nunca usada', 'never used')}</span>
      {canChange && (
        <>
          <button className="btn btn--sm btn--ghost" onClick={onEdit}>
            {L('Editar', 'Edit')}
          </button>
          <button className="icon-btn icon-btn--sm" title={L('Apagar', 'Delete')} aria-label={L(`Apagar ${k.name}`, `Delete ${k.name}`)} onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        </>
      )}
    </div>
  )
}

function KeyEditor({ k, mine, onClose, onSaved }: { k?: VaultKey; mine: boolean; onClose: () => void; onSaved: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const [name, setName] = useState(k?.name ?? '')
  const [value, setValue] = useState('')
  const [chosen, setChosen] = useState<string[]>(k?.agents ?? [])
  const [approve, setApprove] = useState(k?.approve ?? false)
  const [note, setNote] = useState(k?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const nameError = name.trim() ? keyNameError(name.trim()) : undefined
  const save = (): void => {
    setBusy(true)
    setError('')
    saveVaultKey({ ...(k ? { id: k.id } : {}), name: name.trim(), ...(value ? { value } : {}), ...(mine ? { mine } : {}), agents: chosen, approve, ...(note.trim() ? { note: note.trim() } : {}) })
      .then(onSaved, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false))
  }
  const toggle = (id: string): void => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  return (
    <Modal title={k ? L(`Editar ${k.name}`, `Edit ${k.name}`) : mine ? L('Nova chave sua', 'New key of yours') : L('Nova chave', 'New key')} onClose={onClose}>
      <form
        className="vault-editor"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) save()
        }}
      >
        <Field label={L('Nome', 'Name')} error={nameError} hint={L('Como o agente chama a chave, igual a uma variável de ambiente: STRIPE_KEY, OPENAI_API_KEY.', 'What the agent calls the key, like an environment variable: STRIPE_KEY, OPENAI_API_KEY.')}>
          <input autoFocus={!k} spellCheck={false} autoComplete="off" value={name} placeholder="STRIPE_KEY" onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s-]+/g, '_'))} />
        </Field>
        <Field label={L('Valor', 'Value')} hint={k ? L(`Salvo: ${k.hint}. Deixe vazio pra manter; cole outro pra trocar.`, `Saved: ${k.hint}. Leave empty to keep it; paste another to replace it.`) : L('Fica cifrado no chaveiro do sistema e nunca mais aparece. Um op://Cofre/Item/campo vem do 1Password na hora do uso.', 'It stays encrypted in the system keychain and never shows again. An op://Vault/Item/field comes from 1Password at the moment of use.')}>
          <input type="password" autoFocus={!!k} spellCheck={false} autoComplete="new-password" value={value} placeholder={k ? k.hint : L('Cole a chave', 'Paste the key')} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <Field label={L('Agentes que podem usar', 'Agents that may use it')} group hint={chosen.length ? undefined : L('Nenhum ainda: a chave fica guardada até você liberar.', 'None yet: the key stays put until you give it out.')}>
          <div className="vault-editor__agents">
            {agents.map((a) => (
              <label key={a.id} className={`chip ${chosen.includes(a.id) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={chosen.includes(a.id)} onChange={() => toggle(a.id)} />
                <AgentAvatar agent={a} size={16} /> {a.name}
                {!a.computer && <span className="muted small"> · {L('sem computador', 'no computer')}</span>}
              </label>
            ))}
          </div>
        </Field>
        <label className="lrow">
          <span className="lrow__label">
            <span className="lrow__name">{L('Pedir aprovação a cada uso', 'Ask for approval each use')}</span>
            <span className="lrow__sub">{L('O comando espera alguém aprovar, com o comando inteiro à vista. Pra chaves que mexem em dinheiro ou em produção.', 'The command waits for someone to approve, with the whole command in view. For keys that touch money or production.')}</span>
          </span>
          <Toggle on={approve} onChange={setApprove} label={L('Pedir aprovação a cada uso', 'Ask for approval each use')} />
        </label>
        <Field label={L('Nota (opcional)', 'Note (optional)')}>
          <input value={note} maxLength={300} placeholder={L('Ex.: conta de produção da loja', 'E.g. the store’s production account')} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <p className="note note--error">{error}</p>}
        <footer className="modal__foot">
          <span className="grow" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !name.trim() || !!nameError || (!k && !value)}>
            {k ? L('Salvar', 'Save') : L('Guardar no Cofre', 'Keep in the Cofre')}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// An .env pasted here is read here: the core gets only the lines to save. Each new name goes in for no
// agent; a name already saved is left alone unless its box is checked.
function ImportEnv({ have, mine, onClose, onSaved }: { have: VaultKey[]; mine: boolean; onClose: () => void; onSaved: () => void }): ReactNode {
  const you = useStore((s) => s.you)
  const [text, setText] = useState('')
  const [replace, setReplace] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lines: EnvLine[] = useMemo(() => parseEnv(text), [text])
  const drawer = have.filter((k) => (mine ? k.owner === you : !k.owner))
  const exists = (n: string): boolean => drawer.some((k) => k.name === n)
  const good = lines.filter((l) => !l.error)
  const saving = good.filter((l) => !exists(l.name) || replace.includes(l.name))
  const save = (): void => {
    setBusy(true)
    setError('')
    importVaultKeys(
      saving.map((l) => ({ name: l.name, value: l.value })),
      replace,
      mine
    )
      .then(onSaved, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Modal title={L('Importar .env', 'Import .env')} onClose={onClose}>
      <p className="small modal__lead">{L('Cole o conteúdo do arquivo. Cada NOME=valor vira uma chave, sem nenhum agente liberado: você escolhe depois.', 'Paste the file’s content. Each NAME=value becomes a key, given to no agent: you choose afterwards.')}</p>
      <textarea className="vault-import__text" rows={6} spellCheck={false} autoFocus value={text} placeholder={'STRIPE_KEY=sk_live_…\nDATABASE_URL=postgres://…'} onChange={(e) => setText(e.target.value)} />
      {lines.length > 0 && (
        <div className="table vault-import__lines">
          {lines.map((l) => (
            <div key={l.name} className="table__row">
              <code className="grow">{l.name}</code>
              {l.error ? (
                <span className="tag tag--danger" title={l.error}>
                  {L('não entra', 'skipped')}
                </span>
              ) : exists(l.name) ? (
                <label className="row small">
                  <input type="checkbox" checked={replace.includes(l.name)} onChange={(e) => setReplace((r) => (e.target.checked ? [...r, l.name] : r.filter((x) => x !== l.name)))} />
                  {L('já existe: trocar o valor', 'already saved: replace the value')}
                </label>
              ) : (
                <span className="tag tag--ok">{L('nova', 'new')}</span>
              )}
            </div>
          ))}
        </div>
      )}
      {error && <p className="note note--error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy || !saving.length} onClick={save}>
          {saving.length === 1 ? L('Guardar 1 chave', 'Keep 1 key') : L(`Guardar ${saving.length} chaves`, `Keep ${saving.length} keys`)}
        </button>
      </footer>
    </Modal>
  )
}

function UsesLog(): ReactNode {
  const [uses, setUses] = useState<VaultUse[] | null>(null)
  const s = useStore((st) => ({ agents: st.agents, people: st.people }))
  useEffect(() => void vaultUses().then(setUses, () => setUses([])), [])
  if (!uses) return null
  if (!uses.length) return <p className="muted">{L('Nenhuma chave foi usada ainda. Cada uso aparece aqui: qual chave, qual agente, pra quem e onde.', 'No key was used yet. Each use shows here: which key, which agent, for whom and where.')}</p>
  const via = { bash: L('comando', 'command'), service: L('serviço', 'service'), connector: L('conector', 'connector') }
  return (
    <div className="table vault-log">
      {uses.map((u) => {
        const agent = s.agents.find((a) => a.id === u.agentId)
        const person = personById(s, u.personId)
        return (
          <div key={u.id} className="table__row">
            <span className="muted small vault-log__at">{when(u.at)}</span>
            <code>{u.name}</code>
            <span className="grow small">
              {agent ? agent.name : L('agente removido', 'removed agent')} · {via[u.via]}
              {person ? L(` · pra ${person.name}`, ` · for ${person.name}`) : ''}
            </span>
            {u.conversationId && (
              <button className="link link--quiet small" onClick={() => navigate({ kind: 'conversation', id: u.conversationId!, ...(u.messageId ? { message: u.messageId } : {}) })}>
                {L('Ver na conversa', 'See in the conversation')}
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

// On an agent's page: the keys of the Cofre it may use, each to give or take back (the person's own
// keys and, for an admin, the team's). The values stay in the Cofre.
export function AgentVaultKeys({ agentId, name }: { agentId: string; name: string }): ReactNode {
  const [keys, setKeys] = useState<VaultKey[] | null>(null)
  const [error, setError] = useState('')
  const admin = useStore(amAdmin)
  const you = useStore((s) => s.you)
  useEffect(() => void vaultKeys().then(setKeys, () => setKeys([])), [agentId])
  if (!keys) return null
  const mayChange = (k: VaultKey): boolean => (k.owner ? k.owner === you : admin)
  const flip = (k: VaultKey, on: boolean): void => {
    setError('')
    void setVaultKeyAgent(k.id, agentId, on).then(
      (next) => setKeys((ks) => ks?.map((x) => (x.id === next.id ? next : x)) ?? null),
      (e: unknown) => setError(errorOf(e))
    )
  }
  return (
    <div className="vault-agent">
      {keys.length === 0 ? (
        <p className="muted small">
          {L('Nenhuma chave no Cofre ainda.', 'No keys in the Cofre yet.')}{' '}
          <button type="button" className="link" onClick={() => navigate({ kind: 'vault' })}>
            {L('Abrir o Cofre', 'Open the Cofre')}
          </button>
        </p>
      ) : (
        <div className="vault-editor__agents">
          {keys.map((k) => {
            const on = k.agents.includes(agentId)
            return (
              <label key={k.id} className={`chip ${on ? 'is-on' : ''}`} title={k.owner ? L('Sua chave: só em trabalho que você pedir', 'Your key: only in work you ask for') : undefined}>
                <input type="checkbox" checked={on} disabled={!mayChange(k)} onChange={(e) => flip(k, e.target.checked)} />
                <code>{k.name}</code>
                {k.owner && <span className="muted small"> · {L('sua', 'yours')}</span>}
                {k.approve && <span className="muted small"> · {L('pede aprovação', 'asks approval')}</span>}
              </label>
            )
          })}
        </div>
      )}
      {error && <p className="note note--error">{error}</p>}
      <p className="hint">{L(`${name} usa pelo nome, num comando do computador dele, e nunca vê o valor.`, `${name} uses them by name, in a command on its computer, and never sees the value.`)}</p>
    </div>
  )
}
