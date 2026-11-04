// A newer Tucano: a note at the foot of the sidebar once it's downloaded, and the
// state in Settings. The main process looks and downloads (src/main/updates.ts).
import { useSyncExternalStore, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { UpdateState } from '../../../shared/types'
import { useStore } from '../store'
import { ago } from './ui'

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

function useUpdate(): UpdateState | null {
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
const useWorking = (): number => useStore((s) => new Set(s.messages.filter((m) => m.run?.status === 'working' && m.author.kind === 'agent').map((m) => (m.author.kind === 'agent' ? m.author.id : ''))).size)

const workingNote = (n: number): string => (n === 1 ? L('1 agente trabalhando: reinicie quando ele terminar.', '1 agent working: restart once it’s done.') : L(`${n} agentes trabalhando: reinicie quando terminarem.`, `${n} agents working: restart once they’re done.`))

export function UpdateNote(): ReactNode {
  const u = useUpdate()
  const working = useWorking()
  if (u?.status !== 'ready') return null
  return (
    <div className="update-note">
      <div className="update-note__text">
        <strong>{L(`Tucano ${u.next} pronto`, `Tucano ${u.next} is ready`)}</strong>
        {working > 0 ? (
          <span className="muted small">{workingNote(working)}</span>
        ) : (
          <a href={notes(u.next)} target="_blank" rel="noreferrer">
            {L('O que mudou', 'What’s new')}
          </a>
        )}
      </div>
      <button className={`btn btn--sm ${working > 0 ? '' : 'btn--primary'}`} onClick={() => window.tucano.installUpdate()}>
        {working > 0 ? L('Reiniciar mesmo assim', 'Restart anyway') : L('Reiniciar', 'Restart')}
      </button>
    </div>
  )
}

function status(u: UpdateState): string {
  switch (u.status) {
    case 'off':
      return L('As atualizações funcionam no app instalado.', 'Updates work in the installed app.')
    case 'checking':
      return L('Procurando uma versão nova…', 'Looking for a new version…')
    case 'downloading':
      return L(`Baixando o Tucano ${u.next}… ${u.percent ?? 0}%`, `Downloading Tucano ${u.next}… ${u.percent ?? 0}%`)
    case 'ready':
      return L(`O Tucano ${u.next} está pronto. Ele entra quando você reiniciar ou fechar o app.`, `Tucano ${u.next} is ready. It goes in when you restart or quit the app.`)
    case 'error':
      return u.errorKind === 'other'
        ? L('Não deu pra atualizar sozinho. Baixe a versão nova em Releases.', 'Couldn’t update on its own. Download the new version from Releases.')
        : u.errorKind === 'offline'
          ? L('Sem internet pra procurar uma versão nova. O Tucano tenta de novo sozinho mais tarde.', 'No internet to look for a new version. Tucano tries again on its own later.')
          : L('Não deu pra procurar uma versão nova agora. Tente de novo mais tarde.', 'Couldn’t look for a new version just now. Try again later.')
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
