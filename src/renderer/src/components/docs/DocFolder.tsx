// One folder: where it is, who sees it, what it is for (its rule), the folders in it and the files.
// Drop files anywhere on it to keep them here.
import { useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { approvalNeeded } from '../../../../shared/doc-access'
import type { DocFolder, DocsTree } from '../../../../shared/docs'
import { call } from '../../rpc'
import { amAdmin, navigate, toast, useStore } from '../../store'
import { message } from '../Invite'
import { confirmDialog, ContextMenu, type MenuItem, type MenuState } from '../Dialogs'
import { Modal } from '../Modal'
import { Icon } from '../ui'
import { DocAccessDialog } from './DocAccess'
import { AskAnswer, SearchBox, useAsk } from './DocAsk'
import { useDocActions } from './DocActions'
import { DocResults } from './DocResults'
import { DocTrash } from './DocTrash'
import { DocRow, NameDialog, Sending, menuAt } from './doc-ui'
import { ACCEPT, type useDocUpload } from './upload'
import { childFolders, countIn, docsIn, folderColor, mayEdit, trail, type AccessWords } from './useDocs'

export function DocFolderView({ tree, folder, words, upload }: { tree: DocsTree; folder: DocFolder; words: AccessWords; upload: ReturnType<typeof useDocUpload> }): ReactNode {
  const admin = useStore(amAdmin)
  const may = mayEdit(tree, folder.id)
  const [menu, setMenu] = useState<MenuState>(null)
  const [naming, setNaming] = useState(false)
  const [access, setAccess] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [dropping, setDropping] = useState(0)
  const [query, setQuery] = useState('')
  const asking = useAsk({ folderId: folder.id })
  const input = useRef<HTMLInputElement>(null)
  const actions = useDocActions()
  const subs = childFolders(tree, folder.id)
  const files = docsIn(tree, folder.id)
  const color = folderColor(tree, folder.id)
  const asks = approvalNeeded(tree.folders, folder.id)
  const search = query.trim()
  const path = trail(tree, folder.id)

  const keep = (list: File[]): void => {
    if (!may) return toast(L('Você só pode ler esta pasta.', 'You can only read this folder.'))
    if (list.length) void upload.send(folder.id, folder.name, list)
  }
  // The page never opens a dropped file itself, even when the person can only read here.
  const drop = {
    onDragEnter: (e: React.DragEvent) => may && e.dataTransfer.types.includes('Files') && setDropping((n) => n + 1),
    onDragLeave: () => may && setDropping((n) => Math.max(0, n - 1)),
    onDragOver: (e: React.DragEvent) => e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropping(0)
      if (!may) return toast(L('Você pode ver esta pasta, mas não guardar nela.', 'You can see this folder, but not save to it.'))
      keep([...e.dataTransfer.files])
    }
  }
  // Only a folder the person can change and that isn't a personal root gets the menu.
  const canMenu = may && !(folder.privateTo && !folder.parentId)
  const removeFolder = async (): Promise<void> => {
    if (files.length || subs.length) return toast(L('Esvazie a pasta antes de apagar.', 'Empty the folder before deleting it.'))
    if (!(await confirmDialog({ title: L(`Apagar a pasta "${folder.name}"?`, `Delete the folder "${folder.name}"?`), confirm: L('Apagar pasta', 'Delete folder'), danger: true }))) return
    try {
      await call('docFolderRemove', { id: folder.id })
      toast(L('Pasta apagada.', 'Folder deleted.'))
      navigate(folder.parentId ? { kind: 'documents', folder: folder.parentId } : { kind: 'documents' })
    } catch (e) {
      toast(`${L('Não consegui apagar a pasta.', "I couldn't delete the folder.")} ${message(e)}`.trim())
    }
  }
  // Owner and admins: a folder asks for approval of what the agents keep in it. When a folder above already asks,
  // this one follows it (even if it is set here too), so there is nothing to switch here.
  const fromAbove = (): boolean => {
    const seen = new Set<string>()
    for (let id: string | null = folder.parentId; id && !seen.has(id); ) {
      seen.add(id)
      const f = tree.folders.find((x) => x.id === id)
      if (!f || f.privateTo) return false
      if (f.needsApproval) return true
      id = f.parentId
    }
    return false
  }
  const approvalItem = (): MenuItem[] => {
    if (!admin || folder.privateTo || fromAbove()) return []
    const on = folder.needsApproval
    return [
      {
        label: on ? L('Não pedir mais aprovação', 'Stop asking for approval') : L('Pedir aprovação nesta pasta', 'Ask for approval in this folder'),
        icon: 'check' as const,
        onClick: () =>
          void call('docFolderSave', { id: folder.id, parentId: folder.parentId, name: folder.name, rule: folder.rule, needsApproval: !on }).then(
            () => toast(on ? L('Pronto. O que os agentes guardarem aqui não espera mais aprovação.', 'Done. What agents save here no longer waits for approval.') : L('Pronto. O que os agentes guardarem aqui espera o seu sim.', 'Done. What agents save here now waits for a yes.')),
            (e: unknown) => toast(`${L('Não consegui mudar isso.', "I couldn't change that.")} ${message(e)}`.trim())
          )
      }
    ]
  }
  const open = (id: string): void => navigate({ kind: 'documents', folder: folder.id, doc: id })
  const newFolder = async (name: string): Promise<void> => {
    const f = await call('docFolderSave', { parentId: folder.id, name, rule: '' })
    toast(L('Pasta criada.', 'Folder created.'))
    navigate({ kind: 'documents', folder: f.id })
  }

  return (
    <div className="dc-page dc-dropzone" {...drop}>
      <div className="dc-page__inner">
        <nav className="dc-crumbs" aria-label={L('Onde você está', 'Where you are')}>
          <button onClick={() => navigate({ kind: 'documents' })}>{L('Documentos', 'Documents')}</button>
          {path.map((f, i) => (
            <span key={f.id} className="dc-crumbs__step">
              <Icon name="chevron" size={12} />
              {i === path.length - 1 ? <b>{f.name}</b> : <button onClick={() => navigate({ kind: 'documents', folder: f.id })}>{f.name}</button>}
            </span>
          ))}
        </nav>

        <div className="dc-fhead">
          <span className="dc-folder__ico dc-folder__ico--lg" style={{ ['--c' as string]: color }}>
            <Icon name={folder.privateTo ? 'lock' : 'folder'} size={18} />
          </span>
          <h3>{folder.name}</h3>
          <button className="btn btn--sm btn--ghost" onClick={() => setAccess(true)} title={L('Quem vê esta pasta', 'Who sees this folder')}>
            <Icon name="lock" size={13} /> {words.short(folder.id)}
          </button>
          {may ? (
            <button className="btn btn--sm btn--primary" onClick={(e) => setMenu(menuAt(e, [{ label: L('Nova pasta aqui dentro', 'New folder in here'), icon: 'folder' as const, onClick: () => setNaming(true) }, { label: L('Enviar arquivo', 'Send a file'), icon: 'clip' as const, onClick: () => input.current?.click() }]))}>
              <Icon name="plus" size={13} /> {L('Novo', 'New')}
            </button>
          ) : (
            <span className="chip dc-chip">{L('Só para ler', 'Read only')}</span>
          )}
          {canMenu && (
            <button className="icon-btn" title={L('Mais opções da pasta', 'More folder options')} aria-label={L('Mais opções da pasta', 'More folder options')} onClick={(e) => setMenu(menuAt(e, [{ label: L('Renomear pasta', 'Rename folder'), icon: 'edit' as const, onClick: () => setRenaming(true) }, ...approvalItem(), { label: L('Apagar pasta', 'Delete folder'), icon: 'trash' as const, danger: true, onClick: () => void removeFolder() }]))}>
              <Icon name="more" size={16} />
            </button>
          )}
        </div>

        <RuleLine folder={folder} may={may} />
        {asks && (
          <p className="dc-approval-line">
            <Icon name="check" size={13} /> {L('O que os agentes guardam aqui espera o sim de uma pessoa.', "What agents save here waits for a person's yes.")}
            {!folder.needsApproval && <em> {L('(vem da pasta de cima)', '(comes from the folder above)')}</em>}
          </p>
        )}
        <div className="dc-folder-ask">
          <SearchBox
            value={query}
            onChange={(v) => (setQuery(v), asking.clear())}
            onAsk={() => asking.ask(query)}
            busy={asking.state.status === 'busy'}
            placeholder={L(`Procure ou pergunte algo em ${folder.name}`, `Find or ask something in ${folder.name}`)}
            label={L('Procurar ou perguntar nesta pasta', 'Find or ask in this folder')}
          />
        </div>
        <Sending upload={upload} folderId={folder.id} />
        {search && (
          <>
            <AskAnswer asking={asking} tree={tree} />
            {!asking.answering && <DocResults tree={tree} query={search} folderId={folder.id} />}
          </>
        )}

        {!search && subs.length > 0 && (
          <div className="dc-subs">
            {subs.map((f) => {
              const n = countIn(tree, f.id)
              return (
                <button key={f.id} className="dc-sub" style={{ ['--c' as string]: folderColor(tree, f.id) }} onClick={() => navigate({ kind: 'documents', folder: f.id })}>
                  <Icon name="folder" size={15} />
                  <span>{f.name}</span>
                  <em>{n}</em>
                </button>
              )
            })}
          </div>
        )}

        {search ? null : files.length > 0 ? (
          <>
            <h2 className="dc-eyebrow">{files.length === 1 ? L('1 arquivo', '1 file') : L(`${files.length} arquivos`, `${files.length} files`)}</h2>
            <div className="dc-list">
              {files.map((d) => (
                <DocRow key={d.id} doc={d} onOpen={() => open(d.id)} onMenu={(e) => setMenu(menuAt(e, actions.items(d, may, () => open(d.id))))} />
              ))}
            </div>
          </>
        ) : (
          subs.length === 0 &&
          !upload.sending.some((s) => s.folderId === folder.id) && (
            <div className="dc-empty dc-empty--folder">
              <span className="dc-empty__ico">
                <Icon name="clip" size={22} />
              </span>
              <h2>{may ? L('Esta pasta está vazia', 'This folder is empty') : L('Ainda não há arquivos aqui', 'No files here yet')}</h2>
              {may && <p>{L('Arraste arquivos para cá, ou escolha no computador.', 'Drag files in here, or pick them on your computer.')}</p>}
              {may && (
                <div className="dc-empty__actions">
                  <button className="btn btn--primary" onClick={() => input.current?.click()}>
                    <Icon name="clip" size={14} /> {L('Enviar arquivo', 'Send a file')}
                  </button>
                </div>
              )}
            </div>
          )
        )}

        {!search && <DocTrash docs={docsIn(tree, folder.id, true)} may={may} />}
      </div>

      {dropping > 0 && (
        <div className="dc-drop">
          <Icon name="down" size={22} />
          <strong>{L(`Solte para guardar em ${folder.name}`, `Drop to keep in ${folder.name}`)}</strong>
        </div>
      )}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      <input ref={input} type="file" multiple hidden accept={ACCEPT} onChange={(e) => (keep([...(e.target.files ?? [])]), (e.target.value = ''))} />
      {actions.dialogs}
      {naming && <NameDialog title={L(`Nova pasta em ${folder.name}`, `New folder in ${folder.name}`)} label={L('Nome da pasta', 'Folder name')} confirm={L('Criar pasta', 'Create folder')} onSubmit={newFolder} onClose={() => setNaming(false)} />}
      {renaming && (
        <NameDialog
          title={L('Renomear pasta', 'Rename folder')}
          label={L('Nome da pasta', 'Folder name')}
          initial={folder.name}
          confirm={L('Renomear', 'Rename')}
          onSubmit={async (name) => {
            // No access in the save: the folder keeps who sees it.
            await call('docFolderSave', { id: folder.id, parentId: folder.parentId, name, rule: folder.rule })
            toast(L('Nome mudado.', 'Renamed.'))
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {access && (admin ? <DocAccessDialog folder={folder} tree={tree} onClose={() => setAccess(false)} /> : <AccessInfo folder={folder} words={words} onClose={() => setAccess(false)} />)}
    </div>
  )
}

// For everyone who isn't an admin: who sees the folder, no buttons to change it.
function AccessInfo({ folder, words, onClose }: { folder: DocFolder; words: AccessWords; onClose: () => void }): ReactNode {
  return (
    <Modal title={L(`Quem vê ${folder.name}`, `Who sees ${folder.name}`)} onClose={onClose}>
      <p className="modal__lead">{words.long(folder.id)}</p>
      {!folder.privateTo && <p className="small muted">{L('Quem administra o Tucano pode mudar isso.', 'Whoever runs Tucano can change this.')}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--primary btn--sm" onClick={onClose}>
          {L('Entendi', 'Got it')}
        </button>
      </footer>
    </Modal>
  )
}

// ---------- the rule ----------

// The folder's rule is one line; "ver tudo" opens it. Whoever may write here may change it: the agents read it
// before they keep a file in this folder.
function RuleLine({ folder, may }: { folder: DocFolder; may: boolean }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(folder.rule)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const rule = folder.rule.trim()
  const save = (): void => {
    setBusy(true)
    call('docFolderSave', { id: folder.id, parentId: folder.parentId, name: folder.name, rule: text.trim() }).then(
      () => (toast(L('Regra salva.', 'Rule saved.')), setEditing(false), setBusy(false)),
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }
  if (editing)
    return (
      <div className="dc-rule is-editing">
        <label>
          <span className="dc-rule__title">{L('Regra da pasta', 'Folder rule')}</span>
          <textarea
            autoFocus
            rows={4}
            maxLength={5000}
            value={text}
            placeholder={L('Ex.: contratos assinados, nome com a data, o financeiro confere.', 'E.g. signed contracts, name with the date, finance checks.')}
            onChange={(e) => (setText(e.target.value), setError(''))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (setEditing(false), setText(folder.rule), setError(''))
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy && text.trim() !== rule) save()
            }}
          />
        </label>
        <p className="small muted">{L('Os agentes leem esta regra antes de guardar um arquivo aqui.', 'The agents read this rule before they keep a file here.')}</p>
        {error && <p className="note note--error">{error}</p>}
        <div className="dc-rule__actions">
          <button className="btn btn--sm" onClick={() => (setEditing(false), setText(folder.rule), setError(''))}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button className="btn btn--sm btn--primary" disabled={busy || text.trim() === rule} onClick={save}>
            {busy ? L('Salvando…', 'Saving…') : L('Salvar', 'Save')}
          </button>
        </div>
      </div>
    )
  if (!rule)
    return may ? (
      <button className="dc-rule dc-rule--empty" onClick={() => (setText(''), setEditing(true))}>
        <Icon name="spark" size={15} /> {L('Escrever a regra desta pasta', "Write this folder's rule")}
      </button>
    ) : null
  const long = rule.includes('\n') || rule.length > 110
  return (
    <details className="dc-rule">
      <summary>
        <Icon name="spark" size={15} />
        <span>
          <b>{L('Regra da pasta:', 'Folder rule:')}</b> {rule.split('\n')[0]}
        </span>
        {long && <em>{L('ver tudo', 'see all')}</em>}
      </summary>
      <div className="dc-rule__full">
        <p>{rule}</p>
        {may && (
          <button className="text-btn" onClick={() => (setText(folder.rule), setEditing(true))}>
            <Icon name="edit" size={12} /> {L('Mudar a regra', 'Change the rule')}
          </button>
        )}
      </div>
    </details>
  )
}
