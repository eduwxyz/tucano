// The small pieces Documentos is made of: the file badge, a row, who did it, the folder picker and
// the name dialog. No data of their own except the picker, which reads the folders.
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import type { Doc, DocFolder, DocKind, DocsTree } from '../../../../shared/docs'
import { sectorOf } from '../../../../shared/org'
import { call } from '../../rpc'
import { initials, type State } from '../../store'
import { message } from '../Invite'
import type { MenuItem, MenuState } from '../Dialogs'
import { Modal } from '../Modal'
import { Field } from '../Pages'
import { ago, AgentAvatar, Icon, MeAvatar } from '../ui'
import type { useDocUpload } from './upload'
import { childFolders, folderColor, kindWords, mayEdit, pathText, useActors, useDocs, type Who } from './useDocs'

// ---------- badge ----------

const BADGE: Record<DocKind, [string, string]> = {
  pdf: ['PDF', 'rose'],
  docx: ['DOC', 'indigo'],
  xlsx: ['XLS', 'green'],
  csv: ['CSV', 'green'],
  markdown: ['MD', 'graphite'],
  text: ['TXT', 'graphite'],
  html: ['HTML', 'amber'],
  image: ['IMG', 'violet']
}

export function FileBadge({ kind, size = 36 }: { kind: DocKind; size?: number }): ReactNode {
  const [label, color] = BADGE[kind]
  return (
    <span className="dc-badge" style={{ ['--c' as string]: `var(--c-${color})`, width: size, height: size }} title={kindWords(kind)}>
      {label}
    </span>
  )
}

// ---------- text ----------

// A search snippet: **word** marks what matched; it shows as a highlight, never as asterisks.
export function Snippet({ text }: { text: string }): ReactNode {
  return (
    <>
      {text.split('**').map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))}
    </>
  )
}

export function WhoAvatar({ who, size = 20 }: { who: Who; size?: number }): ReactNode {
  if (who.agent) return <AgentAvatar agent={who.agent} size={size} still />
  if (who.outside)
    return (
      <span className="dc-outside" style={{ width: size, height: size }}>
        <Icon name="folder" size={Math.round(size * 0.6)} />
      </span>
    )
  return <MeAvatar initials={initials(who.name)} size={size} />
}

// Where a menu of a button opens: under it, its right edge on the button's.
export const menuAt = (e: MouseEvent<HTMLElement>, items: MenuItem[]): NonNullable<MenuState> => {
  const r = e.currentTarget.getBoundingClientRect()
  return { x: r.right - 230, y: r.bottom + 4, items }
}

// ---------- the states a screen can be in ----------

export function DocsLoading({ label }: { label?: string }): ReactNode {
  return (
    <div className="dc-state" role="status">
      <span className="dc-spinner" />
      <p>{label ?? L('Abrindo seus documentos…', 'Opening your documents…')}</p>
    </div>
  )
}

// No alert icon in the set: the lock stays. The raw error goes last, small and muted.
export function DocsError({ title = L('Não consegui abrir seus documentos.', "I couldn't open your documents."), text, onRetry }: { title?: string; text: string; onRetry: () => void }): ReactNode {
  return (
    <div className="dc-state">
      <Icon name="lock" size={22} />
      <p className="dc-state__title">{title}</p>
      <p className="small muted">{text}</p>
      <button className="btn" onClick={onRetry}>
        {L('Tentar de novo', 'Try again')}
      </button>
    </div>
  )
}

// Files on their way up (any folder) and what was refused, as the page's own quiet lines.
export function Sending({ upload, folderId }: { upload: ReturnType<typeof useDocUpload>; folderId?: string }): ReactNode {
  const going = upload.sending.filter((s) => !folderId || s.folderId === folderId)
  if (!going.length && !upload.refused.length) return null
  return (
    <div className="dc-sending" aria-live="polite">
      {going.map((s) => (
        <div key={s.key} className="dc-send">
          <span className="dc-spinner" />
          <span className="dc-send__name">{s.name}</span>
          <span className="dc-send__state">{L('Enviando…', 'Sending…')}</span>
          <span className="dc-send__bar" />
        </div>
      ))}
      {upload.refused.map((r) => (
        <div key={r.key} className="dc-refused" role="alert">
          <Icon name="hand" size={14} />
          <span>{r.text}</span>
          <button className="icon-btn icon-btn--sm" title={L('Fechar aviso', 'Close notice')} onClick={() => upload.dismiss(r.key)}>
            <Icon name="x" size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ---------- a row ----------

export function DocRow({ doc, folderPath, snippet, onOpen, onMenu, trailing }: { doc: Doc; folderPath?: string; snippet?: string; onOpen?: () => void; onMenu?: (e: MouseEvent<HTMLButtonElement>) => void; trailing?: ReactNode }): ReactNode {
  const who = useActors()(doc.updatedBy)
  return (
    <div className="dc-row">
      <button className="dc-row__main" onClick={onOpen} disabled={!onOpen}>
        <FileBadge kind={doc.kind} />
        <span className="dc-row__body">
          <strong>{doc.name}</strong>
          <span>{snippet ? <Snippet text={snippet} /> : doc.summary || kindWords(doc.kind)}</span>
          {folderPath && <em className="dc-row__where">{folderPath}</em>}
        </span>
        <span className="dc-row__who" title={who.name}>
          <WhoAvatar who={who} />
        </span>
        <span className="dc-row__when">{ago(doc.updatedAt)}</span>
      </button>
      {trailing}
      {onMenu && (
        <button className="icon-btn dc-row__more" title={L('Mais opções', 'More options')} aria-label={L('Mais opções', 'More options')} onClick={onMenu}>
          <Icon name="more" size={16} />
        </button>
      )}
    </div>
  )
}

// ---------- a name ----------

// One name to type: a new folder, a renamed file or folder. What goes wrong is said in the window.
export function NameDialog({ title, label, initial = '', hint, confirm, onSubmit, onClose }: { title: string; label: string; initial?: string; hint?: string; confirm: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }): ReactNode {
  const [name, setName] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const go = (): void => {
    const clean = name.trim()
    if (!clean || busy) return
    setBusy(true)
    onSubmit(clean).then(onClose, (e: unknown) => (setError(message(e)), setBusy(false)))
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <Field label={label} hint={hint} error={error || null}>
          <input autoFocus value={name} maxLength={200} onChange={(e) => (setName(e.target.value), setError(''))} onFocus={(e) => e.currentTarget.select()} />
        </Field>
        <footer className="modal__foot">
          <span className="grow" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !name.trim()}>
            {confirm}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

// ---------- the folder picker ----------

// Folders in order, each with how deep it is: the ones this person may change, under their parents.
function pickable(tree: DocsTree): { folder: DocFolder; depth: number }[] {
  const out: { folder: DocFolder; depth: number }[] = []
  const walk = (parentId: string | null, depth: number): void => {
    for (const f of childFolders(tree, parentId)) {
      const may = mayEdit(tree, f.id)
      if (may) out.push({ folder: f, depth })
      walk(f.id, may ? depth + 1 : depth)
    }
  }
  walk(null, 0)
  return out
}

// Where a file goes: the folders this person may write in, as an indented list, with a suggestion
// already marked and a way to make a new folder right there.
export function FolderPicker({ title, confirm, suggest, current, onPick, onClose }: { title: string; confirm: string; suggest?: string | null; current?: string; onPick: (folderId: string) => Promise<void>; onClose: () => void }): ReactNode {
  const { tree, loading, error, retry } = useDocs()
  const [chosen, setChosen] = useState<string | null>(suggest ?? null)
  const [made, setMade] = useState<Set<string>>(new Set())
  const [naming, setNaming] = useState(false)
  const [fresh, setFresh] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const rows = useMemo(() => (tree ? pickable(tree) : []), [tree])
  const ok = (id: string | null): id is string => !!id && (made.has(id) || rows.some((r) => r.folder.id === id))
  // Nothing marked yet: the first one the person may write in.
  useEffect(() => {
    if (chosen === null && rows[0]) setChosen(rows[0].folder.id)
  }, [rows, chosen])

  const create = (): void => {
    const name = fresh.trim()
    if (!name || !chosen || busy) return
    setBusy(true)
    call('docFolderSave', { parentId: chosen, name, rule: '' }).then(
      (f) => (setMade((m) => new Set(m).add(f.id)), setChosen(f.id), setNaming(false), setFresh(''), setBusy(false)),
      (e: unknown) => (setProblem(message(e)), setBusy(false))
    )
  }
  const pick = (): void => {
    if (!ok(chosen) || busy) return
    setBusy(true)
    onPick(chosen).then(onClose, (e: unknown) => (setProblem(message(e)), setBusy(false)))
  }
  const name = tree && chosen ? pathText(tree, chosen) : ''

  return (
    <Modal title={title} onClose={onClose} className="dc-picker">
      {loading && <DocsLoading label={L('Procurando as pastas…', 'Looking for the folders…')} />}
      {error && <DocsError text={error} onRetry={retry} />}
      {tree && rows.length === 0 && !made.size && (
        <div className="dc-state">
          <Icon name="folder" size={22} />
          <p className="dc-state__title">{L('Você ainda não pode guardar em nenhuma pasta', "You can't keep files in any folder yet")}</p>
          <p>{L('Peça a quem administra o Tucano para liberar uma pasta para você.', 'Ask whoever runs Tucano to open a folder for you.')}</p>
        </div>
      )}
      {tree && rows.length > 0 && (
        <>
          <p className="small muted dc-picker__lead">{L('Escolha a pasta.', 'Pick the folder.')}</p>
          <div className="dc-picker__list" role="radiogroup" aria-label={title}>
            {rows.map(({ folder, depth }) => (
              <button
                key={folder.id}
                role="radio"
                aria-checked={chosen === folder.id}
                className={`dc-pick ${chosen === folder.id ? 'is-on' : ''}`}
                style={{ paddingLeft: 10 + depth * 18, ['--c' as string]: folderColor(tree, folder.id) }}
                onClick={() => (setChosen(folder.id), setNaming(false), setProblem(''))}
              >
                <span className="dc-pick__ico">
                  <Icon name={folder.privateTo ? 'lock' : 'folder'} size={14} />
                </span>
                <span className="dc-pick__name">{folder.name}</span>
                {suggest === folder.id && <span className="dc-pick__hint">{L('sugerida', 'suggested')}</span>}
                {current === folder.id && <span className="dc-pick__hint">{L('está aqui', 'is here')}</span>}
                {chosen === folder.id && <Icon name="check" size={14} />}
              </button>
            ))}
            {[...made].filter((id) => !rows.some((r) => r.folder.id === id)).map((id) => (
              <div key={id} className="dc-pick is-on">
                <span className="dc-pick__ico">
                  <Icon name="folder" size={14} />
                </span>
                <span className="dc-pick__name">{L('Pasta nova', 'New folder')}</span>
                <Icon name="check" size={14} />
              </div>
            ))}
          </div>
          {naming ? (
            <form
              className="dc-picker__new"
              onSubmit={(e) => {
                e.preventDefault()
                create()
              }}
            >
              <input autoFocus aria-label={L('Nome da pasta nova', 'New folder name')} placeholder={L(`Nome da pasta dentro de ${tree.folders.find((f) => f.id === chosen)?.name ?? '…'}`, `Folder name inside ${tree.folders.find((f) => f.id === chosen)?.name ?? '…'}`)} value={fresh} maxLength={120} onChange={(e) => setFresh(e.target.value)} />
              <button type="submit" className="btn btn--sm" disabled={busy || !fresh.trim()}>
                {L('Criar', 'Create')}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setNaming(false)}>
                {L('Agora não', 'Not now')}
              </button>
            </form>
          ) : (
            <button className="text-btn dc-picker__add" disabled={!ok(chosen)} onClick={() => setNaming(true)}>
              <Icon name="plus" size={13} /> {L('Nova pasta aqui', 'New folder here')}
            </button>
          )}
        </>
      )}
      {problem && <p className="note note--error">{problem}</p>}
      <footer className="modal__foot">
        <span className="muted small dc-picker__where">{name && L(`Vai para ${name}`, `Goes to ${name}`)}</span>
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={busy || !ok(chosen) || chosen === current} onClick={pick}>
          {confirm}
        </button>
      </footer>
    </Modal>
  )
}

// The folder where the file of an agent's chat would go by itself: the one its sector writes in, if the
// person may write there too, else their own personal one.
export function suggestFolder(tree: DocsTree, state: Pick<State, 'agents' | 'you'>, agentId: string | undefined): string | null {
  const personal = tree.folders.find((f) => f.privateTo === state.you && !f.parentId)?.id ?? null
  if (!agentId) return personal
  const agent = state.agents.find((a) => a.id === agentId)
  if (!agent) return personal
  const mine = tree.folders.filter((f) => !f.privateTo && mayEdit(tree, f.id) && (f.access?.agents[agentId] === 'write' || Object.entries(f.access?.sectors ?? {}).some(([head, level]) => level === 'write' && sectorOf(state.agents, agentId)?.id === head)))
  // The one nearest the top.
  mine.sort((a, b) => depthOf(tree, a) - depthOf(tree, b))
  return mine[0]?.id ?? personal
}

const depthOf = (tree: DocsTree, f: DocFolder): number => {
  let n = 0
  for (let p = f; p.parentId && n < 50; n++) {
    const up = tree.folders.find((x) => x.id === p.parentId)
    if (!up) break
    p = up
  }
  return n
}
