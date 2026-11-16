// Settings › General › Notifications, in a browser on a server: this device's push subscription
// (public/tucano-pwa.js, src/server/webpush.ts), so notifications come with the page closed.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { Icon } from './ui'

type State = 'on' | 'ask' | 'blocked' | 'insecure' | 'unsupported' | 'off'
type WebPushApi = { state: () => Promise<State>; enable: () => Promise<State>; disable: () => Promise<State>; test: () => Promise<boolean> }
// Why a request failed (tucano-pwa.js): what kind, the HTTP status and the server's own reason.
type Failure = { code?: string; status?: number; detail?: string; message?: string }

// What went wrong, in words: the HTTP status and the server's reason, never only "try again".
export function webPushError(e: unknown): string {
  const f = (e ?? {}) as Failure
  const http = f.status ? ` (HTTP ${f.status}${f.detail ? `: ${f.detail}` : ''})` : f.detail ? ` (${f.detail})` : ''
  switch (f.code) {
    case 'network':
      return L('Sem conexão com o servidor. Confira a internet e tente de novo.', 'No connection to the server. Check the internet and try again.') + http
    case 'signin':
      return L('O login do proxy na frente do site venceu. Recarregue a página e entre de novo.', 'The sign-in of the proxy in front of the site expired. Reload the page and sign in again.') + http
    case 'denied':
      return L('O servidor não reconheceu este aparelho. Entre de novo no Tucano aqui.', 'The server didn’t recognize this device. Sign in to Tucano here again.') + http
    case 'nosub':
      return L('Este aparelho não está inscrito. Toque em Desativar e ative de novo.', 'This device isn’t subscribed. Tap Turn off and turn it on again.') + http
    case 'push':
      return L('O serviço de notificações do navegador recusou o envio.', 'The browser’s notification service refused it.') + http
    case 'http':
      return L('O servidor respondeu com erro.', 'The server answered with an error.') + http
    default:
      return L('Não deu certo', 'That didn’t work') + ` (${f.message ?? String(e)}).`
  }
}

const ACTIONS = { display: 'flex', flexWrap: 'wrap', gap: 8, flexShrink: 0 } as const

export function WebPushRow(): ReactNode {
  const wp = (window.tucano as unknown as { webPush?: WebPushApi }).webPush
  const [state, setState] = useState<State | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => void wp?.state().then(setState, () => setState('unsupported')), [wp])
  // The server turned it off (TUCANO_WEBPUSH=off), or this is the desktop app: nothing to show.
  if (!wp || !state || state === 'off') return null
  const run = (f: () => Promise<State>): void => {
    setBusy(true)
    setNote(null)
    void f()
      .then(setState, (e: unknown) => setNote(webPushError(e)))
      .finally(() => setBusy(false))
  }
  const test = (): void => {
    setBusy(true)
    setNote(null)
    void wp
      .test()
      .then(
        () => setNote(L('Mandei uma. Deve aparecer em instantes.', 'Sent one. It should show in a moment.')),
        (e: unknown) => setNote(webPushError(e))
      )
      .finally(() => setBusy(false))
  }
  const line = {
    on: L('Ativadas: os avisos chegam aqui mesmo com o Tucano fechado.', 'On: notifications come here even with Tucano closed.'),
    ask: L('Receba os avisos aqui mesmo com o Tucano fechado. No Android, instale o app pelo menu do Chrome (Instalar app).', 'Get notifications here even with Tucano closed. On Android, install the app from Chrome’s menu (Install app).'),
    blocked: L('O navegador bloqueou as notificações deste endereço. Libere nas permissões do site e recarregue a página.', 'The browser blocked notifications from this address. Allow them in the site’s permissions and reload the page.'),
    insecure: L('Só funciona por HTTPS.', 'It only works over HTTPS.'),
    unsupported: L('Este navegador não recebe notificações com a página fechada.', 'This browser doesn’t get notifications with the page closed.')
  }[state]
  return (
    <div className="key-row">
      <Icon name="phone" />
      <div className="grow">
        <strong>{L('Notificações neste aparelho', 'Notifications on this device')}</strong>
        <p className="muted small">{note ?? line}</p>
      </div>
      {state === 'ask' && (
        <div className="key-row__actions" style={ACTIONS}>
          <button className="btn btn--sm btn--primary" disabled={busy} onClick={() => run(wp.enable)}>
            {L('Ativar notificações neste aparelho', 'Turn on notifications on this device')}
          </button>
        </div>
      )}
      {state === 'on' && (
        <div className="key-row__actions" style={ACTIONS}>
          <button className="btn btn--sm" disabled={busy} onClick={test}>
            {L('Enviar teste', 'Send a test')}
          </button>
          <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => run(wp.disable)}>
            {L('Desativar', 'Turn off')}
          </button>
        </div>
      )}
    </div>
  )
}
