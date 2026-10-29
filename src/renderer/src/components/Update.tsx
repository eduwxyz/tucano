// A newer Tucano: a note at the foot of the sidebar once it's downloaded, and the
// state in Settings. The main process looks and downloads (src/main/updates.ts).
import { useSyncExternalStore, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { UpdateState } from '../../../shared/types'
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

export function UpdateNote(): ReactNode {
  const u = useUpdate()
  if (u?.status !== 'ready') return null
  return (
    <div className="update-note">
      <div className="update-note__text">
        <strong>{L(`Tucano ${u.next} pronto`, `Tucano ${u.next} is ready`)}</strong>
        <a href={notes(u.next)} target="_blank" rel="noreferrer">
          {L('O que mudou', 'What’s new')}
        </a>
      </div>
      <button className="btn btn--primary btn--sm" onClick={() => window.tucano.installUpdate()}>
        {L('Reiniciar', 'Restart')}
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
      return L('Não deu pra procurar uma versão nova agora. Tente de novo mais tarde.', 'Couldn’t look for a new version just now. Try again later.')
    default:
      return u.checkedAt
        ? L(`É a versão mais recente. Conferido ${ago(u.checkedAt)}.`, `It’s the latest version. Checked ${ago(u.checkedAt)}.`)
        : L('O Tucano procura versões novas sozinho e avisa quando uma estiver pronta.', 'Tucano looks for new versions by itself and tells you when one is ready.')
  }
}

export function UpdateSettings(): ReactNode {
  const u = useUpdate()
  if (!u) return null
  const busy = u.status === 'checking' || u.status === 'downloading'
  return (
    <div className="field">
      <span className="hint">
        {L(`Você está na versão ${u.version}. `, `You’re on version ${u.version}. `)}
        {status(u)}
      </span>
      <div className="row">
        {u.status === 'ready' ? (
          <button className="btn btn--primary btn--sm" onClick={() => window.tucano.installUpdate()}>
            {L('Reiniciar e atualizar', 'Restart and update')}
          </button>
        ) : (
          <button className="btn btn--sm" disabled={u.status === 'off' || busy} onClick={() => window.tucano.checkUpdates()}>
            {L('Procurar atualizações', 'Check for updates')}
          </button>
        )}
        <a className="link" href={notes(u.status === 'ready' ? u.next : u.version)} target="_blank" rel="noreferrer">
          {L('Notas da versão', 'Release notes')}
        </a>
      </div>
    </div>
  )
}
