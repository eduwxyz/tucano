// The Cofre: keys the agents use by name, one command at a time, and site logins the app types into
// their browsers (src/core/vault.ts). A value goes in once and never comes back to a screen: a key reads
// as its name, its last characters, the agents that may use it and whether each use asks first; a login
// as its site and username. In a team there are two drawers: the team's (an admin's to make and give
// out) and each person's own (theirs alone, used only in work they asked for). And the card an agent's
// pedir_chave leaves in the chat, where anyone in it pastes what's missing.
import { L, locale } from '../../../shared/lang'
import { keyNameError, loginOrigin, parseEnv, type EnvLine, type KeyRequestAnswer, type VaultKey, type VaultLogin, type VaultUse } from '../../../shared/vault'
import type { Approval } from '../../../shared/types'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { agentById, amAdmin, answerKeyRequest, canDecide, decideApproval, importVaultKeys, isTeam, navigate, personById, personName, removeVaultKey, removeVaultLogin, saveVaultKey, saveVaultLogin, setVaultKeyAgent, setVaultLoginAgent, teamMode, useStore, vaultKeys, vaultLogins, vaultUses, type Agent } from '../store'
import { confirmDialog } from './Dialogs'
import { Modal } from './Modal'
import { Field, Page, Toggle } from './Pages'
import { AgentAvatar, Icon } from './ui'

const errorOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const when = (at: number): string => new Date(at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function VaultPage({ tab = 'keys' }: { tab?: 'keys' | 'logins' | 'log' }): ReactNode {
  const [keys, setKeys] = useState<VaultKey[] | null>(null)
  const [logins, setLogins] = useState<VaultLogin[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<VaultKey | 'new' | 'new-mine' | null>(null)
  const [editingLogin, setEditingLogin] = useState<VaultLogin | 'new' | 'new-mine' | null>(null)
  const [importing, setImporting] = useState(false)
  const admin = useStore(amAdmin)
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const load = (): void => {
    void vaultKeys().then(setKeys, (e: unknown) => setError(errorOf(e)))
    void vaultLogins().then(setLogins, (e: unknown) => setError(errorOf(e)))
  }
  useEffect(load, [])

  // A member makes only their own; alone, everything is just "Cofre".
  const newKey = (): void => setEditing(team && !admin ? 'new-mine' : 'new')
  const newLogin = (): void => setEditingLogin(team && !admin ? 'new-mine' : 'new')
  const remove = (k: VaultKey): void =>
    void confirmDialog({
      title: L(`Apagar ${k.name}?`, `Delete ${k.name}?`),
      body: L('Os agentes deixam de poder usar essa chave, e o valor sai do chaveiro do sistema. Um conector que aponta pra ela para de conectar. Não dá pra desfazer.', 'Agents can no longer use this key, and its value is removed from the system keychain. A connector using it will stop connecting. This cannot be undone.'),
      confirm: L(`Apagar ${k.name}`, `Delete ${k.name}`),
      danger: true
    }).then((ok) => {
      if (ok) void removeVaultKey(k.id).then(load, (e: unknown) => setError(errorOf(e)))
    })
  const removeLogin = (l: VaultLogin): void =>
    void confirmDialog({
      title: L(`Apagar o login de ${host(l.origin)}?`, `Delete the login for ${host(l.origin)}?`),
      body: L('Os agentes deixam de entrar sozinhos nesse site, e a senha sai do chaveiro do sistema. O que já está logado no navegador deles continua até sair.', 'Agents will no longer sign in to this site automatically, and the password is removed from the system keychain. Existing browser sessions remain signed in until signed out.'),
      confirm: L('Apagar', 'Delete'),
      danger: true
    }).then((ok) => {
      if (ok) void removeVaultLogin(l.id).then(load, (e: unknown) => setError(errorOf(e)))
    })

  const keyList = (items: VaultKey[], canChange: boolean): ReactNode =>
    items.length === 0 ? null : (
      <div className="table vault-keys">
        {items.map((k) => (
          <KeyRow key={k.id} k={k} canChange={canChange} onEdit={() => setEditing(k)} onRemove={() => remove(k)} />
        ))}
      </div>
    )
  const loginList = (items: VaultLogin[], canChange: boolean): ReactNode =>
    items.length === 0 ? null : (
      <div className="table vault-keys">
        {items.map((l) => (
          <LoginRow key={l.id} l={l} canChange={canChange} onEdit={() => setEditingLogin(l)} onRemove={() => removeLogin(l)} />
        ))}
      </div>
    )
  // The two drawers, in a team; alone, one list.
  const drawers = <T extends { owner?: string }>(items: T[], list: (items: T[], canChange: boolean) => ReactNode, empty: ReactNode, words: { none: string; noneMine: string; newMine: string }, onNewMine: () => void): ReactNode => {
    const teamItems = items.filter((k) => !k.owner)
    const mine = items.filter((k) => k.owner === you)
    if (!team) return teamItems.length ? list(teamItems, true) : empty
    return (
      <>
        <section className="vault-drawer">
          <header className="vault-drawer__head">
            <h3>{L('Do time', 'The team’s')}</h3>
            <span className="muted small">{admin ? L('Você cria e libera; os agentes usam em qualquer trabalho.', 'You make and give them out; the agents use them in any work.') : L('Só um admin cria e libera esses.', 'Only an admin makes and gives these out.')}</span>
          </header>
          {list(teamItems, admin) ?? <p className="muted small">{words.none}</p>}
        </section>
        <section className="vault-drawer">
          <header className="vault-drawer__head">
            <h3>{L('Minhas', 'Mine')}</h3>
            <span className="muted small">{L('Só você vê. Um agente só usa num trabalho que você pediu.', 'Only you see them. An agent uses one only in work you asked for.')}</span>
            <button className="link link--quiet" onClick={onNewMine}>
              {words.newMine}
            </button>
          </header>
          {list(mine, true) ?? <p className="muted small">{words.noneMine}</p>}
        </section>
      </>
    )
  }

  const tabButton = (id: 'keys' | 'logins' | 'log', label: string): ReactNode => (
    <button role="tab" aria-selected={tab === id} className={tab === id ? 'is-active' : ''} onClick={() => navigate({ kind: 'vault', tab: id })}>
      {label}
    </button>
  )
  return (
    <Page
      title={L('Cofre', 'Vault')}
      subtitle={L(
        'Chaves e logins que os agentes usam sem nunca ver: uma chave pelo nome, só no comando que pede (no que ele imprime, aparece como [cofre:NOME]); um login, digitado pelo app no site exato.',
        'Keys and logins the agents use without ever seeing them: a key by name, only in the command that asks for it (in what it prints, it shows as [cofre:NAME]); a login, typed by the app on the exact site.'
      )}
      actions={
        tab === 'keys' ? (
          <>
            <button className="btn btn--sm btn--ghost" onClick={() => setImporting(true)}>
              {L('Importar .env', 'Import .env')}
            </button>
            <button className="btn btn--sm btn--primary" onClick={newKey}>
              <Icon name="plus" size={14} /> {L('Nova chave', 'New key')}
            </button>
          </>
        ) : tab === 'logins' ? (
          <button className="btn btn--sm btn--primary" onClick={newLogin}>
            <Icon name="plus" size={14} /> {L('Novo login', 'New login')}
          </button>
        ) : undefined
      }
    >
      <div className="tabs" role="tablist">
        {tabButton('keys', L('Chaves', 'Keys'))}
        {tabButton('logins', L('Logins', 'Logins'))}
        {tabButton('log', L('Registro', 'Log'))}
      </div>
      {error && <p className="note note--error">{error}</p>}
      {tab === 'log' ? (
        <UsesLog />
      ) : tab === 'logins' ? (
        logins === null ? null : (
          drawers(logins, loginList, <EmptyLogins onNew={newLogin} />, { none: L('Nenhum login do time ainda.', 'No team logins yet.'), noneMine: L('Nenhum login seu.', 'You have no logins yet.'), newMine: L('Novo login meu…', 'New personal login…') }, () => setEditingLogin('new-mine'))
        )
      ) : keys === null ? null : (
        drawers(keys, keyList, <Empty onNew={newKey} />, { none: L('Nenhuma chave do time ainda.', 'No team keys yet.'), noneMine: L('Nenhuma chave sua.', 'You have no keys yet.'), newMine: L('Nova chave minha…', 'New personal key…') }, () => setEditing('new-mine'))
      )}
      {editing && <KeyEditor k={typeof editing === 'string' ? undefined : editing} mine={editing === 'new-mine'} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
      {editingLogin && <LoginEditor l={typeof editingLogin === 'string' ? undefined : editingLogin} mine={editingLogin === 'new-mine'} onClose={() => setEditingLogin(null)} onSaved={() => (setEditingLogin(null), load())} />}
      {importing && <ImportEnv have={keys ?? []} mine={team && !admin} onClose={() => setImporting(false)} onSaved={() => (setImporting(false), load())} />}
    </Page>
  )
}

const host = (origin: string): string => origin.replace(/^https:\/\//, '')

function EmptyLogins({ onNew }: { onNew: () => void }): ReactNode {
  return (
    <div className="empty-card">
      <Icon name="lock" size={22} />
      <p>{L('Nenhum login ainda. Salve aqui o usuário e a senha de um site e libere pro agente com navegador: o app digita no site exato, e ele nunca vê a senha.', 'No logins yet. Save a site’s username and password here and give it to an agent with a browser: the app types it on the exact site, and it never sees the password.')}</p>
      <button className="btn btn--sm btn--primary" onClick={onNew}>
        {L('Novo login', 'New login')}
      </button>
    </div>
  )
}

function LoginRow({ l, canChange, onEdit, onRemove }: { l: VaultLogin; canChange: boolean; onEdit: () => void; onRemove: () => void }): ReactNode {
  const agents = useStore((s) => l.agents.map((id) => agentById(s, id)).filter((a): a is Agent => !!a && !a.archived))
  return (
    <div className="table__row vault-key">
      <Icon name="lock" size={14} />
      <span className="grow vault-key__main">
        <span className="vault-key__name">{host(l.origin)}</span>
        <span className="muted small vault-key__hint">{l.username}</span>
        {l.note && <span className="muted small vault-key__note">{l.note}</span>}
      </span>
      <span className="vault-key__agents" title={agents.map((a) => a.name).join(', ')}>
        {agents.length ? agents.slice(0, 5).map((a) => <AgentAvatar key={a.id} agent={a} size={20} />) : <span className="muted small">{L('nenhum agente', 'no agent')}</span>}
        {agents.length > 5 && <span className="muted small">+{agents.length - 5}</span>}
      </span>
      <span className="muted small vault-key__used">{l.usedAt ? L(`usado ${when(l.usedAt)}`, `used ${when(l.usedAt)}`) : L('nunca usado', 'never used')}</span>
      {canChange && (
        <>
          <button className="btn btn--sm btn--ghost" onClick={onEdit}>
            {L('Editar', 'Edit')}
          </button>
          <button className="icon-btn icon-btn--sm" title={L('Apagar', 'Delete')} aria-label={L(`Apagar o login de ${host(l.origin)}`, `Delete the login for ${host(l.origin)}`)} onClick={onRemove}>
            <Icon name="trash" size={14} />
          </button>
        </>
      )}
    </div>
  )
}

export function LoginEditor({ l, mine, agentId, onClose, onSaved }: { l?: VaultLogin; mine: boolean; agentId?: string; onClose: () => void; onSaved: (l: VaultLogin) => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const [site, setSite] = useState(l ? host(l.origin) : '')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [chosen, setChosen] = useState<string[]>(l?.agents ?? (agentId ? [agentId] : []))
  const [note, setNote] = useState(l?.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const siteError = site.trim() && !loginOrigin(site) ? L('Use o endereço do site, com https: conta.exemplo.com.br.', 'Enter the site address with HTTPS, for example https://account.example.com.') : undefined
  const save = (): void => {
    setBusy(true)
    setError('')
    saveVaultLogin({ ...(l ? { id: l.id } : {}), site: site.trim(), ...(username.trim() ? { username: username.trim() } : {}), ...(password ? { password } : {}), ...(mine ? { mine } : {}), agents: chosen, ...(note.trim() ? { note: note.trim() } : {}) })
      .then(onSaved, (e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false))
  }
  const toggle = (id: string): void => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  return (
    <Modal title={l ? L(`Editar o login de ${host(l.origin)}`, `Edit the login for ${host(l.origin)}`) : mine ? L('Novo login seu', 'New personal login') : L('Novo login', 'New login')} onClose={onClose}>
      <form
        className="vault-editor"
        onSubmit={(e) => {
          e.preventDefault()
          if (!busy) save()
        }}
      >
        <Field label={L('Site', 'Site')} error={siteError} hint={L('O app só digita no endereço exato deste site.', 'The app only types it at this site’s exact address.')}>
          <input autoFocus={!l} spellCheck={false} autoComplete="off" value={site} placeholder="conta.exemplo.com.br" onChange={(e) => setSite(e.target.value)} />
        </Field>
        <Field label={L('Usuário ou email', 'Username or email')} hint={l ? L(`Salvo: ${l.username}. Deixe vazio pra manter.`, `Saved: ${l.username}. Leave empty to keep it.`) : undefined}>
          <input spellCheck={false} autoComplete="off" value={username} placeholder={l?.username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label={L('Senha', 'Password')} hint={l ? L('Deixe vazio pra manter; digite outra pra trocar.', 'Leave empty to keep it; type another to replace it.') : L('Fica cifrada no chaveiro do sistema. Um op://Cofre/Item/senha vem do 1Password na hora.', 'The password stays encrypted in the system keychain. An op://Vault/Item/password reference is read from 1Password when used.')}>
          <input type="password" spellCheck={false} autoComplete="new-password" value={password} placeholder={L('Senha ou op://…', 'Password or op://…')} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label={L('Agentes que podem usar', 'Agents that may use it')} group hint={L('Cada agente tem um login por site: liberar este tira o outro.', 'Each agent can have one login per site. Assigning this login replaces its existing login for that site.')}>
          <div className="vault-editor__agents">
            {agents.map((a) => (
              <label key={a.id} className={`chip ${chosen.includes(a.id) ? 'is-on' : ''}`}>
                <input type="checkbox" checked={chosen.includes(a.id)} onChange={() => toggle(a.id)} />
                <AgentAvatar agent={a} size={16} /> {a.name}
                {!a.browser && <span className="muted small"> · {L('sem navegador', 'no browser')}</span>}
              </label>
            ))}
          </div>
        </Field>
        <Field label={L('Nota (opcional)', 'Note (optional)')}>
          <input value={note} maxLength={300} placeholder={L('Ex.: conta da empresa', 'E.g. the company’s account')} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {error && <p className="note note--error">{error}</p>}
        <footer className="modal__foot">
          <span className="grow" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !site.trim() || !!siteError || (!l && (!username.trim() || !password))}>
            {l ? L('Salvar', 'Save') : L('Guardar no Cofre', 'Keep in the Vault')}
          </button>
        </footer>
      </form>
    </Modal>
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
    <Modal title={k ? L(`Editar ${k.name}`, `Edit ${k.name}`) : mine ? L('Nova chave sua', 'New personal key') : L('Nova chave', 'New key')} onClose={onClose}>
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
        <Field label={L('Agentes que podem usar', 'Agents that may use it')} group hint={chosen.length ? undefined : L('Nenhum ainda: a chave fica guardada até você liberar.', 'No agents selected. The key remains unassigned until you choose an agent.')}>
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
            <span className="lrow__sub">{L('O comando espera alguém aprovar, com o comando inteiro à vista. Pra chaves que mexem em dinheiro ou em produção.', 'The command waits for approval, and the full command is shown to the approver. Use this for keys that affect money or production.')}</span>
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
            {k ? L('Salvar', 'Save') : L('Guardar no Cofre', 'Keep in the Vault')}
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
      <p className="small modal__lead">{L('Cole o conteúdo do arquivo. Cada NOME=valor vira uma chave, sem nenhum agente liberado: você escolhe depois.', 'Paste the file contents. Each NAME=value becomes a key without an assigned agent; you choose agents afterwards.')}</p>
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
  if (!uses.length) return <p className="muted">{L('Nada do Cofre foi usado ainda. Cada uso aparece aqui: qual chave ou login, qual agente, pra quem e onde.', 'No Vault items have been used yet. Each use shows the key or login, agent, who it was used for and where.')}</p>
  const via = { bash: L('comando', 'command'), service: L('serviço', 'service'), connector: L('conector', 'connector'), login: L('login no navegador', 'browser sign-in') }
  return (
    <div className="table vault-log">
      {uses.map((u) => {
        const agent = s.agents.find((a) => a.id === u.agentId)
        const person = personById(s, u.personId)
        return (
          <div key={u.id} className="table__row">
            <span className="muted small vault-log__at">{when(u.at)}</span>
            {u.via === 'login' ? <span>{host(u.name)}</span> : <code>{u.name}</code>}
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
          {L('Nenhuma chave no Cofre ainda.', 'No keys in the Vault yet.')}{' '}
          <button type="button" className="link" onClick={() => navigate({ kind: 'vault' })}>
            {L('Abrir o Cofre', 'Open the Vault')}
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

// On an agent's page, by its browser: the Cofre's logins it may use, each to give or take back, and a
// new one saved straight for it.
export function AgentVaultLogins({ agentId, name }: { agentId: string; name: string }): ReactNode {
  const [logins, setLogins] = useState<VaultLogin[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const admin = useStore(amAdmin)
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const load = (): void => void vaultLogins().then(setLogins, () => setLogins([]))
  useEffect(load, [agentId])
  if (!logins) return null
  const mayChange = (l: VaultLogin): boolean => (l.owner ? l.owner === you : admin)
  const flip = (l: VaultLogin, on: boolean): void => {
    setError('')
    void setVaultLoginAgent(l.id, agentId, on).then(load, (e: unknown) => setError(errorOf(e)))
  }
  return (
    <div className="vault-agent">
      {logins.length > 0 && (
        <div className="vault-editor__agents">
          {logins.map((l) => {
            const on = l.agents.includes(agentId)
            return (
              <label key={l.id} className={`chip ${on ? 'is-on' : ''}`} title={l.owner ? L('Seu login: só em trabalho que você pedir', 'Your login: only in work you ask for') : undefined}>
                <input type="checkbox" checked={on} disabled={!mayChange(l)} onChange={(e) => flip(l, e.target.checked)} />
                {host(l.origin)}
                <span className="muted small"> · {l.username}</span>
                {l.owner && <span className="muted small"> · {L('seu', 'yours')}</span>}
              </label>
            )
          })}
        </div>
      )}
      <button type="button" className="link link--quiet" onClick={() => setAdding(true)}>
        {L('Salvar um login…', 'Save a login…')}
      </button>
      {error && <p className="note note--error">{error}</p>}
      <p className="hint">{L(`${name} entra sozinho nesses sites: o app digita no endereço exato, e ele nunca vê a senha.`, `${name} signs in to these sites on its own: the app types it at the exact address, and it never sees the password.`)}</p>
      {adding && <LoginEditor mine={team && !admin} agentId={agentId} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), load())} />}
    </div>
  )
}

// The card pedir_chave leaves in the chat: anyone in the conversation pastes the key (or the site's login)
// there, into the Cofre, without it passing through the agent or the chat; or gives one already saved
// (the team's: an admin). Pasted, it's the person's own unless an admin keeps it for the team.
export function KeyRequestCard({ approval, compact }: { approval: Approval; compact?: boolean }): ReactNode {
  const agent = useStore((s) => agentById(s, approval.agentId))
  const admin = useStore(amAdmin)
  const team = useStore(teamMode)
  const you = useStore((s) => s.you)
  const mayRefuse = useStore((s) => canDecide(s, approval))
  const requester = useStore((s) => (approval.requestedBy ? personName(s, approval.requestedBy) : ''))
  const decidedBy = useStore((s) => (approval.decidedBy ? personName(s, approval.decidedBy) : ''))
  const nome = typeof approval.args['nome'] === 'string' ? approval.args['nome'] : undefined
  const site = typeof approval.args['site'] === 'string' ? approval.args['site'] : ''
  const [saved, setSaved] = useState<{ id: string; owner?: string; label: string }[]>([])
  const [value, setValue] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [forTeam, setForTeam] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = approval.state === 'pending'
  useEffect(() => {
    if (!pending) return
    if (nome) void vaultKeys().then((ks) => setSaved(ks.filter((k) => k.name === nome && !k.agents.includes(approval.agentId)).map((k) => ({ id: k.id, ...(k.owner ? { owner: k.owner } : {}), label: k.hint }))), () => {})
    else void vaultLogins().then((ls) => setSaved(ls.filter((l) => l.origin === site && !l.agents.includes(approval.agentId)).map((l) => ({ id: l.id, ...(l.owner ? { owner: l.owner } : {}), label: l.username }))), () => {})
  }, [pending, nome, site, approval.agentId])
  const send = (answer: Omit<KeyRequestAnswer, 'id'>): void => {
    setBusy(true)
    setError('')
    answerKeyRequest({ id: approval.id, ...answer })
      .catch((e: unknown) => setError(errorOf(e)))
      .finally(() => setBusy(false))
  }
  const who = agent?.name ?? L('O agente', 'The agent')
  const ready = nome ? !!value.trim() : !!username.trim() && !!password
  const ownWords = !team ? '' : admin && forTeam ? L('Fica entre as do time.', 'Saved with the team’s items.') : approval.requestedBy && approval.requestedBy !== you ? L(`Fica entre as suas: ${who} só usa no que você pedir, e este pedido é de ${requester}.`, `Saved with your items. ${who} can use it only for work you request. This request is from ${requester}.`) : L(`Fica entre as suas: ${who} usa no que você pedir.`, `Saved with your items. ${who} can use it for work you request.`)
  return (
    <div className={`approval approval--${approval.state} key-request ${compact ? 'approval--compact' : ''}`}>
      <div className="approval__head">
        <span className="approval__badge">
          <Icon name={nome ? 'key' : 'lock'} size={13} />
          {pending ? L('Esperando uma chave', 'Waiting for a key') : approval.state === 'approved' ? L('No Cofre', 'In the Vault') : approval.state === 'refused' ? L('Recusado', 'Refused') : L('Expirado', 'Expired')}
        </span>
      </div>
      <div className="approval__title">
        {who} {L('pede', 'asks for')} {nome ? <>{L('a chave', 'the key')} <code>{nome}</code></> : <>{L('o login de', 'the login for')} <strong>{host(site)}</strong></>}
      </div>
      {approval.why && <p className="approval__why">{approval.why}</p>}
      {pending ? (
        <>
          {saved.map((k) =>
            (k.owner ? k.owner === you : admin) ? (
              <div key={k.id} className="row key-request__saved">
                <span className="grow small">
                  {k.owner ? L('Você já tem uma no Cofre', 'You already have one in the Vault') : L('Já tem uma do time no Cofre', 'A team item is already in the Vault')} <span className="muted">({k.label})</span>
                </span>
                <button className="btn btn--sm" disabled={busy} onClick={() => send({ existing: k.id })}>
                  {L(`Liberar pra ${who}`, `Give it to ${who}`)}
                </button>
              </div>
            ) : (
              <p key={k.id} className="muted small">
                {L('Já tem uma do time no Cofre: só um admin libera.', 'A team item is already in the Vault. Only an admin can assign it.')}
              </p>
            )
          )}
          <form
            className="key-request__form"
            onSubmit={(e) => {
              e.preventDefault()
              if (!busy && ready) send(nome ? { value, ...(forTeam ? { team: true } : {}) } : { username, password, ...(forTeam ? { team: true } : {}) })
            }}
          >
            {nome ? (
              <input type="password" aria-label={L(`Valor de ${nome}`, `Value of ${nome}`)} spellCheck={false} autoComplete="new-password" placeholder={L('Cole a chave (ou op://…)', 'Paste the key (or op://…)')} value={value} onChange={(e) => setValue(e.target.value)} />
            ) : (
              <>
                <input aria-label={L('Usuário ou email', 'Username or email')} spellCheck={false} autoComplete="off" placeholder={L('Usuário ou email', 'Username or email')} value={username} onChange={(e) => setUsername(e.target.value)} />
                <input type="password" aria-label={L('Senha', 'Password')} autoComplete="new-password" placeholder={L('Senha (ou op://…)', 'Password (or op://…)')} value={password} onChange={(e) => setPassword(e.target.value)} />
              </>
            )}
            {team && admin && (
              <label className="row small">
                <input type="checkbox" checked={forTeam} onChange={(e) => setForTeam(e.target.checked)} /> {L('Salvar no time', 'Keep it for the team')}
              </label>
            )}
            <div className="row approval__buttons">
              <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !ready}>
                {L('Guardar no Cofre e liberar', 'Save in the Vault and assign')}
              </button>
              {mayRefuse && (
                <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={() => decideApproval(approval.id, 'refused')}>
                  {L('Recusar', 'Refuse')}
                </button>
              )}
            </div>
          </form>
          <p className="approval__bound">
            {L(`Vai direto pro Cofre, cifrado: não aparece na conversa, e ${who} nunca vê.`, `Saved directly in the Vault, encrypted. It does not appear in the conversation, and ${who} never sees it.`)} {ownWords}
          </p>
          {error && <p className="note note--error">{error}</p>}
        </>
      ) : (
        <div className="approval__decided">
          {approval.state === 'expired' ? L('Expirou sem resposta', 'Expired without an answer') : approval.state === 'approved' ? L(`Guardado por ${decidedBy}`, `Kept by ${decidedBy}`) : L(`Recusado por ${decidedBy}`, `Refused by ${decidedBy}`)}
          {approval.outcome ? ` · ${approval.outcome}` : ''}
        </div>
      )}
    </div>
  )
}
