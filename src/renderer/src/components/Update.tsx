// A newer Tucano: the Tuca says so from his row in the sidebar once it's downloaded, the state in
// Settings, and what's new once it's running. The main process looks and downloads (src/main/updates.ts).
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import changelog from '../../../../CHANGELOG.md?raw'
import { L, lang, locale } from '../../../shared/lang'
import { newsPages, newsSince, type NewsPage } from '../../../shared/release-notes'
import type { UpdateState } from '../../../shared/types'
import { updateSettings, useStore, workingAgents } from '../store'
import { Modal } from './Modal'
import { ago, Icon, TucaMark } from './ui'

const RELEASES = 'https://github.com/eduwxyz/tucano/releases'

let current: UpdateState | null = null
const listeners = new Set<() => void>()
let watching = false

function watch(): void {
  if (watching || !window.tucano?.updateState) return
  watching = true
  const set = (s: UpdateState): void => {
    current = s
    listeners.forEach((l) => l())
  }
  void window.tucano.updateState().then(set)
  window.tucano.onUpdate(set)
}

export function useUpdate(): UpdateState | null {
  watch()
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}

const notes = (version?: string): string => (version ? `${RELEASES}/tag/v${version}` : RELEASES)

// How many agents are in the middle of a reply: restarting now would cut them off.
const useWorking = (): number => useStore((s) => workingAgents(s).size)

const workingNote = (n: number): string => (n === 1 ? L('1 agente trabalhando: reinicie quando ele terminar.', '1 agent working: restart once it’s done.') : L(`${n} agentes trabalhando: reinicie quando terminarem.`, `${n} agents working: restart once they’re done.`))

// His words come out a letter at a time, once per text, as if he were typing them; with reduced motion,
// all at once. `typing`: still going.
function useTyped(text: string, ms = 30): { shown: string; typing: boolean } {
  const still = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [n, setN] = useState(still ? text.length : 0)
  useEffect(() => {
    if (still) return setN(text.length)
    setN(0)
    const t = setInterval(() => setN((k) => (k >= text.length ? (clearInterval(t), k) : k + 1)), ms)
    return () => clearInterval(t)
  }, [text, ms, still])
  return { shown: text.slice(0, n), typing: n < text.length }
}

// Whether the Tuca is typing the note right now: his row in the sidebar (Sidebar.tsx) moves his beak
// meanwhile. One Tuca: the note speaks from his row, it doesn't draw another.
let talking = false
const talkers = new Set<() => void>()
const setTalking = (on: boolean): void => {
  if (talking === on) return
  talking = on
  talkers.forEach((l) => l())
}
export function useTucaCall(): { calling: boolean; talking: boolean } {
  const calling = useUpdate()?.status === 'ready'
  const now = useSyncExternalStore(
    (l) => {
      talkers.add(l)
      return () => talkers.delete(l)
    },
    () => talking
  )
  return { calling, talking: calling && now }
}

// The Tuca telling it, in a speech bubble under his row in the sidebar, its tail toward him: what's
// ready, typed out, then what to do. The bubble takes its full size from the start (the whole text
// under the typed one, unseen), so the sidebar doesn't move while he types. `alone`: his row is out of
// the sidebar, so the note brings him.
export function UpdateNote({ alone }: { alone?: boolean }): ReactNode {
  const u = useUpdate()
  const working = useWorking()
  const said = u?.status === 'ready' ? L(`Chegou o Tucano ${u.next}! Quer reiniciar pra usar?`, `Tucano ${u.next} is here! Restart to use it?`) : ''
  const { shown, typing } = useTyped(said)
  useEffect(() => {
    setTalking(typing && !!said)
    return () => setTalking(false)
  }, [typing, said])
  if (u?.status !== 'ready') return null
  return (
    <div className={`update-note ${alone ? 'update-note--alone' : ''}`} role="status">
      {alone && <TucaMark size={24} busy={typing} />}
      <div className="update-note__bubble">
        <p className="update-note__said">
          <span className="sr-only">{said}</span>
          <span className="update-note__ghost" aria-hidden="true">
            {said}
          </span>
          <span aria-hidden="true">
            {shown}
            {typing && <span className="update-note__caret" />}
          </span>
        </p>
        <div className={`update-note__after ${typing ? 'is-waiting' : ''}`}>
          {working > 0 && <span className="muted small">{workingNote(working)}</span>}
          <div className="update-note__acts">
            {working === 0 && (
              <a href={notes(u.next)} target="_blank" rel="noreferrer">
                {L('O que mudou', 'Changed')}
              </a>
            )}
            <button className={`btn btn--sm ${working > 0 ? '' : 'btn--primary'}`} tabIndex={typing ? -1 : 0} onClick={() => window.tucano.installUpdate()}>
              {working > 0 ? L('Reiniciar mesmo assim', 'Restart anyway') : L('Reiniciar', 'Restart')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function status(u: UpdateState): string {
  switch (u.status) {
    case 'off':
      return L('As atualizações funcionam no app instalado.', 'Updates work in the installed app.')
    case 'checking':
      return L('Procurando uma versão nova…', "Checking for updates…")
    case 'downloading':
      return L(`Baixando o Tucano ${u.next}… ${u.percent ?? 0}%`, `Downloading Tucano ${u.next}… ${u.percent ?? 0}%`)
    case 'ready':
      return L(`O Tucano ${u.next} está pronto. Ele entra quando você reiniciar ou fechar o app.`, `Tucano ${u.next} is ready. Restart or quit to install.`)
    case 'error':
      return u.errorKind === 'other'
        ? L('Não deu pra atualizar sozinho. Baixe a versão nova em Releases.', "Couldn’t update on its own. Download the latest version from Releases.")
        : u.errorKind === 'offline'
          ? L('Sem internet pra procurar uma versão nova. O Tucano tenta de novo sozinho mais tarde.', "No internet connection. Tucano will try checking for updates again later.")
          : L('Não deu pra procurar uma versão nova agora. Tente de novo mais tarde.', 'Couldn’t check for updates. Try again later.')
    default:
      return u.checkedAt
        ? L(`É a versão mais recente. Conferido ${ago(u.checkedAt)}.`, `It’s the latest version. Checked ${ago(u.checkedAt)}.`)
        : L('O Tucano procura versões novas sozinho e avisa quando uma estiver pronta.', 'Tucano looks for new versions by itself and tells you when one is ready.')
  }
}

export function UpdateSettings(): ReactNode {
  const u = useUpdate()
  const working = useWorking()
  if (!u) return null
  const busy = u.status === 'checking' || u.status === 'downloading'
  return (
    <div className="field">
      <span className="hint">
        {L(`Você está na versão ${u.version}. `, `You’re on version ${u.version}. `)}
        {status(u)}
        {u.status === 'ready' && working > 0 && ` ${workingNote(working)}`}
      </span>
      <div className="row">
        {u.status === 'ready' ? (
          <button className={`btn btn--sm ${working > 0 ? '' : 'btn--primary'}`} onClick={() => window.tucano.installUpdate()}>
            {working > 0 ? L('Reiniciar mesmo assim', 'Restart anyway') : L('Reiniciar e atualizar', 'Restart and update')}
          </button>
        ) : (
          <button className="btn btn--sm" disabled={u.status === 'off' || busy} onClick={() => window.tucano.checkUpdates()}>
            {L('Procurar atualizações', 'Check for updates')}
          </button>
        )}
        {u.status === 'error' && u.errorKind === 'other' && (
          <a className="btn btn--sm btn--primary" href={`${RELEASES}/latest`} target="_blank" rel="noreferrer">
            {L('Baixar em Releases', 'Download from Releases')}
          </a>
        )}
        <a className="link" href={notes(u.status === 'ready' ? u.next : u.version)} target="_blank" rel="noreferrer">
          {L('Notas da versão', 'Release notes')}
        </a>
      </div>
    </div>
  )
}

const KINDS = (): Record<string, string> => ({ Added: L('Novidades', 'New'), Changed: L('O que mudou', 'Changed'), Fixed: L('Correções', 'Fixed'), Removed: L('Saiu', 'Removed'), Security: L('Segurança', 'Security') })

const day = (date?: string): string => (date ? new Date(`${date}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'long' }) : '')

const inline = (md: string): ReactNode => (
  <Markdown allowedElements={['strong', 'em', 'code', 'p']} unwrapDisallowed>
    {md}
  </Markdown>
)

// One page of the news: a few topics of one version (its summary in Portuguese, the first sentence
// of each item otherwise). The full notes are on GitHub.
function NewsPageView({ p, titled }: { p: NewsPage; titled: boolean }): ReactNode {
  return (
    <section className="whats-new__release">
      {titled && (
        <h3>
          {p.release.version} <span className="muted">· {day(p.release.date)}</span>
        </h3>
      )}
      {p.intro && <p>{inline(p.intro)}</p>}
      {p.groups.map((g, i) => (
        <div key={i}>
          {g.kind && <h4>{KINDS()[g.kind] ?? g.kind}</h4>}
          <ul>
            {g.items.map((item, j) => (
              <li key={j}>{inline(item)}</li>
            ))}
          </ul>
        </div>
      ))}
      {p.outro && <p className="muted whats-new__thanks">{inline(p.outro)}</p>}
    </section>
  )
}

// After an update, once: what came in since the version I last saw (a new install saw its own).
export function WhatsNew(): ReactNode {
  const version = useUpdate()?.version
  const seen = useStore((s) => s.settings.seenVersion)
  const news = useMemo(() => (version && seen !== version ? newsSince(changelog, version, seen) : []), [version, seen])
  const pages = useMemo(() => newsPages(news, lang() === 'pt'), [news])
  const [page, setPage] = useState(0)
  const [closed, setClosed] = useState(false)
  // A version with nothing written (or an older one, after going back): seen, quietly.
  useEffect(() => {
    if (version && seen !== version && news.length === 0) updateSettings({ seenVersion: version })
  }, [version, seen, news.length])
  const open = !!version && !closed && news.length > 0
  // ← and → turn the pages (before the page's own keys: the routines' calendar turns weeks with them).
  useEffect(() => {
    if (!open || pages.length < 2) return
    const keys = (e: KeyboardEvent): void => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
      e.stopImmediatePropagation()
      e.preventDefault()
      setPage((n) => Math.min(pages.length - 1, Math.max(0, n + (e.key === 'ArrowRight' ? 1 : -1))))
    }
    window.addEventListener('keydown', keys, true)
    return () => window.removeEventListener('keydown', keys, true)
  }, [open, pages.length])
  if (!open) return null
  const close = (): void => {
    setClosed(true)
    updateSettings({ seenVersion: version })
  }
  const at = Math.min(page, pages.length - 1)
  const last = at === pages.length - 1
  return (
    <Modal title={L(`Novidades do Tucano ${version}`, `What’s new in Tucano ${version}`)} onClose={close} className="whats-new">
      <div className={`whats-new__body ${pages.length > 1 ? 'whats-new__body--paged' : ''}`}>
        <NewsPageView p={pages[at]!} titled={news.length > 1} />
      </div>
      <footer className="modal__foot">
        <a className="link" href={notes(version)} target="_blank" rel="noreferrer">
          {L('Ver as notas completas', 'See the full notes')}
        </a>
        <span className="grow" />
        {pages.length > 1 && (
          <div className="whats-new__pager">
            <button className="icon-btn icon-btn--sm whats-new__back" disabled={at === 0} title={L('Anterior', 'Previous')} aria-label={L('Anterior', 'Previous')} onClick={() => setPage(at - 1)}>
              <Icon name="chevron" size={14} />
            </button>
            <span className="small muted" aria-live="polite">{L(`${at + 1} de ${pages.length}`, `${at + 1} of ${pages.length}`)}</span>
            <button className="icon-btn icon-btn--sm" disabled={last} title={L('Próxima', 'Next')} aria-label={L('Próxima', 'Next')} onClick={() => setPage(at + 1)}>
              <Icon name="chevron" size={14} />
            </button>
          </div>
        )}
        <button className="btn btn--primary btn--sm" autoFocus onClick={last ? close : () => setPage(at + 1)}>
          {last ? L('Entendi', 'Got it') : L('Próxima', 'Next')}
        </button>
      </footer>
    </Modal>
  )
}
