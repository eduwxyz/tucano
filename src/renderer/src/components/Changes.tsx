// What a reply changed in the person's code: one card per repository (or folder without git), the
// files with their lines added and removed, and each file's diff, asked of the core only when it's
// opened. Each file can be kept or undone (put back as it was before the reply), or all at once.
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { CHANGES_KEEP_DAYS, type ChangeSet, type FileChange, type FileReview } from '../../../shared/types'
import { call } from '../rpc'
import { confirmDialog } from './Dialogs'
import { Icon } from './ui'

const DiffView = lazy(() => import('./DiffView'))

const SPLIT_KEY = 'tucano.diffSplit'
const splitAtFirst = (): boolean => {
  try {
    return localStorage.getItem(SPLIT_KEY) === '1'
  } catch {
    return false
  }
}

type Loaded = { patch: string; truncated?: boolean } | { error: string } | 'loading'

export function ChangesCard({ set }: { set: ChangeSet }): ReactNode {
  const [files, setFiles] = useState<FileChange[]>(set.files)
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [diffs, setDiffs] = useState<Record<string, Loaded>>({})
  const [split, setSplit] = useState(splitAtFirst)
  // What was decided comes with the message (for everyone who sees it); this is what's on its way.
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [problem, setProblem] = useState<Record<string, string>>({})
  const review: Record<string, FileReview> = set.review ?? {}
  const rest = set.total - files.length
  const live = !set.expired
  const undecided = set.total - Object.keys(review).length

  const decide = async (decision: 'keep' | 'undo', paths?: string[], force = false): Promise<void> => {
    const keys = paths ?? ['*']
    setBusy((b) => ({ ...b, ...Object.fromEntries(keys.map((k) => [k, true])) }))
    setProblem((p) => Object.fromEntries(Object.entries(p).filter(([k]) => !paths || !paths.includes(k))))
    try {
      const r = await call('reviewChange', { id: set.id, decision, ...(paths ? { paths } : {}), ...(force ? { force } : {}) })
      if ('error' in r) {
        setProblem((p) => ({ ...p, [keys[0]!]: r.error === 'missing' ? L('A pasta não existe mais.', 'The folder no longer exists.') : L('Esse diff não está mais guardado.', 'This diff is no longer kept.') }))
        return
      }
      setProblem((p) => ({ ...p, ...Object.fromEntries(r.changed.map((x) => [x, 'changed' as const])), ...Object.fromEntries(r.failed.map((x) => [x, 'failed' as const])) }))
    } catch (e) {
      setProblem((p) => ({ ...p, [keys[0]!]: e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e) }))
    } finally {
      setBusy((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !keys.includes(k))))
    }
  }

  // Every keep and undo is asked first, saying what happens to the file: undoing can't be taken back.
  const ask = async (decision: 'keep' | 'undo', file?: FileChange, force = false): Promise<void> => {
    const name = file ? file.path.split('/').pop()! : ''
    const all = undecided === 1 ? L('O arquivo ainda não revisado', 'The file not reviewed yet') : L(`Os ${undecided} arquivos ainda não revisados`, `The ${undecided} files not reviewed yet`)
    const final = L('Isso não dá pra desfazer depois.', "This can't be taken back.")
    const ok = await confirmDialog(
      decision === 'keep'
        ? {
            title: file ? L(`Manter ${name}?`, `Keep ${name}?`) : L('Manter as mudanças?', 'Keep the changes?'),
            body: file
              ? L('O arquivo fica como essa resposta deixou. Dá pra desfazer depois, enquanto o diff estiver guardado.', 'The file stays as this reply left it. You can still undo it later, while the diff is kept.')
              : L(`${all} ficam como essa resposta deixou. Dá pra desfazer cada um depois.`, `${all} stay as this reply left them. You can still undo each one later.`),
            confirm: L('Manter', 'Keep')
          }
        : {
            title: file ? (force ? L(`Desfazer ${name} assim mesmo?`, `Undo ${name} anyway?`) : L(`Desfazer ${name}?`, `Undo ${name}?`)) : L('Desfazer as mudanças?', 'Undo the changes?'),
            body: file
              ? `${undoText(file)}${force ? `\n\n${L('Ele mudou de novo depois dessa resposta: essas mudanças mais novas se perdem também.', 'It changed again after this reply: those newer changes are lost too.')}` : ''}\n\n${final}`
              : `${L(`${all} voltam a ser como eram antes dessa resposta. Um arquivo que mudou de novo depois dela fica como está.`, `${all} go back to how they were before this reply. A file that changed again after it is left as it is.`)}\n\n${final}`,
            confirm: force ? L('Desfazer assim mesmo', 'Undo anyway') : L('Desfazer', 'Undo'),
            danger: true
          }
    )
    if (ok) await decide(decision, file ? [file.path] : undefined, force)
  }

  const toggle = (f: FileChange): void => {
    const now = !open[f.path]
    setOpen((o) => ({ ...o, [f.path]: now }))
    // Opened once, it stays loaded; one that failed is asked again.
    const had = diffs[f.path]
    if (!now || f.binary || had === 'loading' || (had && !('error' in had))) return
    setDiffs((d) => ({ ...d, [f.path]: 'loading' }))
    call('changeDiff', { id: set.id, path: f.path }).then(
      (r) => setDiffs((d) => ({ ...d, [f.path]: r })),
      () => setDiffs((d) => ({ ...d, [f.path]: { error: 'failed' } }))
    )
  }

  const showMore = (): void => {
    setMore('loading')
    call('changeFiles', { id: set.id, offset: files.length }).then(
      (next) => (setFiles((f) => [...f, ...next]), setMore('idle')),
      () => setMore('failed')
    )
  }

  const chooseSplit = (on: boolean): void => {
    setSplit(on)
    try {
      localStorage.setItem(SPLIT_KEY, on ? '1' : '0')
    } catch {
      // kept for this window only
    }
  }

  return (
    <section className="changes" aria-label={L('Arquivos alterados', 'Files changed')}>
      <header className="changes__head">
        <Icon name="edit" size={14} />
        <span className="changes__title">
          {set.total === 1 ? L('1 arquivo alterado', '1 file changed') : L(`${set.total} arquivos alterados`, `${set.total} files changed`)}
        </span>
        <Counts added={set.added} removed={set.removed} />
        <span className="changes__layout" role="group" aria-label={L('Visualização do diff', 'Diff view')}>
          <button className={`changes__layout-btn${split ? '' : ' is-on'}`} aria-pressed={!split} onClick={() => chooseSplit(false)}>
            {L('Unificado', 'Unified')}
          </button>
          <button className={`changes__layout-btn${split ? ' is-on' : ''}`} aria-pressed={split} onClick={() => chooseSplit(true)}>
            {L('Lado a lado', 'Split')}
          </button>
        </span>
      </header>
      <div className="changes__where">
        <span className="changes__repo" title={set.root}>
          <Icon name="folder" size={13} />
          {repoName(set.root)}
        </span>
        {set.branch && (
          <span className="changes__branch" title={set.fromBranch ? L(`Começou em ${set.fromBranch} e terminou em ${set.branch}`, `Started on ${set.fromBranch} and ended on ${set.branch}`) : L(`Branch ${set.branch}`, `Branch ${set.branch}`)}>
            <Icon name="branch" size={13} />
            {set.fromBranch && (
              <>
                <span className="changes__branch-from">{set.fromBranch}</span>
                <span aria-hidden>→</span>
              </>
            )}
            <span className="changes__branch-name">{set.branch}</span>
          </span>
        )}
        {set.plain && (
          <span className="changes__plain" title={L('Essa pasta não usa git: o Tucano guarda as versões dela por conta própria.', "This folder doesn't use git: Tucano keeps its versions on its own.")}>
            {L('sem git', 'no git')}
          </span>
        )}
        <code className="changes__root" title={set.root}>
          <bdi dir="ltr">{set.root}</bdi>
        </code>
      </div>
      {set.expired && (
        <div className="changes__note">
          {L(`Mais de ${CHANGES_KEEP_DAYS} dias atrás: os diffs dessa resposta não estão mais guardados.`, `Over ${CHANGES_KEEP_DAYS} days ago: this reply's diffs are no longer kept.`)}
        </div>
      )}
      <ul className="changes__files">
        {files.map((f) => (
          <li key={f.path} className={`changes__item${open[f.path] ? ' is-open' : ''}${review[f.path] === 'undone' ? ' is-undone' : ''}`}>
            <div className="changes__row">
              <button className="changes__file" aria-expanded={!!open[f.path]} onClick={() => toggle(f)}>
                <span className="changes__chev">
                  <Icon name="chevron" size={12} />
                </span>
                <KindBadge kind={f.kind} />
                <span className="changes__path" title={f.from ? `${f.from} → ${f.path}` : f.path}>
                  {f.from && <span className="changes__from">{f.from} → </span>}
                  {f.path}
                </span>
                {f.binary ? <span className="changes__binary">{L('binário', 'binary')}</span> : <Counts added={f.added} removed={f.removed} />}
              </button>
              {live && <FileActions state={review[f.path]} busy={!!busy[f.path] || !!busy['*']} onKeep={() => void ask('keep', f)} onUndo={() => void ask('undo', f)} />}
            </div>
            {problem[f.path] && (
              <div className="changes__note changes__note--error changes__problem">
                {problem[f.path] === 'changed' ? (
                  <>
                    <span>{L('Esse arquivo mudou de novo depois dessa resposta: desfazer apaga isso também.', 'This file changed again after this reply: undoing loses that too.')}</span>
                    <button className="btn btn--xs btn--danger" onClick={() => void ask('undo', f, true)}>
                      {L('Desfazer assim mesmo', 'Undo anyway')}
                    </button>
                  </>
                ) : problem[f.path] === 'failed' ? (
                  L('Não deu pra desfazer esse arquivo.', "Couldn't undo this file.")
                ) : (
                  problem[f.path]
                )}
              </div>
            )}
            {open[f.path] && <FileBody file={f} loaded={diffs[f.path]} split={split} />}
          </li>
        ))}
      </ul>
      {rest > 0 && (
        <button className="changes__more" disabled={more === 'loading'} onClick={showMore}>
          {more === 'loading'
            ? L('Carregando…', 'Loading…')
            : more === 'failed'
              ? L('Não carregou. Tentar de novo', "Didn't load. Try again")
              : rest === 1
                ? L('Mostrar mais 1 arquivo', 'Show 1 more file')
                : L(`Mostrar mais ${rest} arquivos`, `Show ${rest} more files`)}
        </button>
      )}
      {live && undecided > 0 && (
        <footer className="changes__review">
          <span className="changes__review-left">
            {undecided === 1 ? L('1 arquivo pra revisar', '1 file to review') : L(`${undecided} arquivos pra revisar`, `${undecided} files to review`)}
          </span>
          {problem['*'] && <span className="changes__review-error">{problem['*']}</span>}
          <button className="btn btn--xs btn--ghost" disabled={!!busy['*']} onClick={() => void ask('undo')}>
            <Icon name="undo" size={12} />
            {L('Desfazer tudo', 'Undo all')}
          </button>
          <button className="btn btn--xs btn--primary" disabled={!!busy['*']} onClick={() => void ask('keep')}>
            <Icon name="check" size={12} />
            {L('Manter tudo', 'Keep all')}
          </button>
        </footer>
      )}
    </section>
  )
}

function FileActions({ state, busy, onKeep, onUndo }: { state?: FileReview; busy: boolean; onKeep: () => void; onUndo: () => void }): ReactNode {
  if (state === 'undone')
    return (
      <span className="changes__state changes__state--undone">
        <Icon name="undo" size={12} />
        {L('Desfeito', 'Undone')}
      </span>
    )
  return (
    <span className="changes__actions">
      {state === 'kept' ? (
        <span className="changes__state changes__state--kept">
          <Icon name="check" size={12} />
          {L('Mantido', 'Kept')}
        </span>
      ) : (
        <button className="changes__act" disabled={busy} title={L('Manter', 'Keep')} aria-label={L('Manter', 'Keep')} onClick={onKeep}>
          <Icon name="check" size={13} />
        </button>
      )}
      <button className="changes__act changes__act--undo" disabled={busy} title={L('Desfazer: voltar como era antes', 'Undo: put it back as it was')} aria-label={L('Desfazer', 'Undo')} onClick={onUndo}>
        <Icon name="undo" size={13} />
      </button>
    </span>
  )
}

function FileBody({ file, loaded, split }: { file: FileChange; loaded: Loaded | undefined; split: boolean }): ReactNode {
  if (file.binary) return <div className="changes__note">{L('Arquivo binário: não há linhas pra mostrar.', 'Binary file: no lines to show.')}</div>
  if (!loaded || loaded === 'loading') return <div className="changes__note">{L('Carregando o diff…', 'Loading the diff…')}</div>
  if ('error' in loaded)
    return (
      <div className="changes__note changes__note--error">
        {loaded.error === 'gone'
          ? L('Esse diff não está mais guardado no repositório.', 'This diff is no longer kept in the repository.')
          : loaded.error === 'missing'
            ? L('A pasta do repositório não existe mais.', "The repository's folder no longer exists.")
            : L('Não deu pra ler o diff.', "Couldn't read the diff.")}
      </div>
    )
  if (!loaded.patch.trim()) return <div className="changes__note">{L('Só mudou o nome ou as permissões do arquivo.', 'Only the name or the permissions changed.')}</div>
  return (
    <div className="changes__diff">
      <Suspense fallback={<div className="changes__note">{L('Carregando o diff…', 'Loading the diff…')}</div>}>
        <DiffView patch={loaded.patch} split={split} />
      </Suspense>
      {loaded.truncated && <div className="changes__note">{L('Diff grande demais: mostrando só o começo.', 'Diff too large: showing only the start.')}</div>}
    </div>
  )
}

// What undoing a file does to it, by what the reply did.
function undoText(f: FileChange): string {
  if (f.kind === 'added') return L('Essa resposta criou o arquivo: ele é apagado.', 'This reply created the file: it gets deleted.')
  if (f.kind === 'deleted') return L('Essa resposta apagou o arquivo: ele volta como era.', 'This reply deleted the file: it comes back as it was.')
  if (f.kind === 'renamed') return L(`Ele volta pro nome antigo, ${f.from}, como era antes dessa resposta.`, `It goes back to its old name, ${f.from}, as it was before this reply.`)
  return L('Ele volta a ser como era antes dessa resposta.', 'It goes back to how it was before this reply.')
}

function KindBadge({ kind }: { kind: FileChange['kind'] }): ReactNode {
  const [letter, label] = {
    added: ['A', L('Criado', 'Added')],
    modified: ['M', L('Alterado', 'Modified')],
    deleted: ['D', L('Apagado', 'Deleted')],
    renamed: ['R', L('Renomeado', 'Renamed')]
  }[kind]
  return (
    <span className={`changes__kind changes__kind--${kind}`} title={label}>
      {letter}
    </span>
  )
}

// The repository's folder name, from its path as the agent sees it.
const repoName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root

export function Counts({ added, removed }: { added: number; removed: number }): ReactNode {
  return (
    <span className="counts">
      {added > 0 && <span className="counts__add">+{added.toLocaleString()}</span>}
      {removed > 0 && <span className="counts__del">−{removed.toLocaleString()}</span>}
    </span>
  )
}
