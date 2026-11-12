// What a reply changed in the person's code: one card per repository, the files with their lines
// added and removed, and each file's diff, asked of the core only when it's opened.
import { lazy, Suspense, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { ChangeSet, FileChange } from '../../../shared/types'
import { call } from '../rpc'
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
  const rest = set.total - files.length

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
        <code className="changes__root" title={set.root}>
          <bdi dir="ltr">{set.root}</bdi>
        </code>
      </div>
      <ul className="changes__files">
        {files.map((f) => (
          <li key={f.path} className={`changes__item${open[f.path] ? ' is-open' : ''}`}>
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
    </section>
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
