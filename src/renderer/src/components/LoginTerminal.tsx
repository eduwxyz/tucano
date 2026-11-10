// A harness's sign-in on Tucano as a server, from the browser (src/core/login-terminal.ts): the CLI's
// login runs in the server's own terminal, and this window shows its screen, the page to open and
// the code to type there, and sends back what the person types (a code to paste, a menu's arrows).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ENGINES, loginEngine, loginInput, loginScreen, openExternal, refreshEngines, showLogin, stopLogin, toast, useLoginShown, type LoginKey, type LoginScreen } from '../store'
import { Modal } from './Modal'
import { Icon } from './ui'

const copy = (text: string): void =>
  void navigator.clipboard.writeText(text).then(
    () => toast(L('Copiado', 'Copied')),
    () => toast(L('Não consegui copiar.', "I couldn't copy."))
  )

export function LoginHost(): ReactNode {
  const shown = useLoginShown()
  return shown ? <LoginWindow key={shown.id} first={shown} /> : null
}

function LoginWindow({ first }: { first: LoginScreen }): ReactNode {
  const [s, setS] = useState(first)
  const [text, setText] = useState('')
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)
  const label = ENGINES[s.engine].label
  const running = s.state === 'running'

  useEffect(() => {
    if (!running) return
    timer.current = setInterval(() => {
      void loginScreen().then((now) => {
        if (!now) return
        // Another sign-in started (one at a time): this one is over.
        if (now.id !== first.id) return setS((was) => ({ ...was, state: 'cancelled', error: L('Outro login começou no lugar deste.', 'Another sign-in took its place.') }))
        setS(now)
        if (now.state === 'done') refreshEngines()
      })
    }, 800)
    return () => clearInterval(timer.current)
  }, [running, first.id])

  const send = (input: { text?: string; key?: LoginKey; enter?: boolean }): void =>
    void loginInput(s.id, input).then((now) => now && setS(now))
  const close = (): void => {
    if (running) stopLogin(s.id)
    showLogin(null)
  }
  const again = (): void => void loginEngine(s.engine)

  return (
    <Modal title={L(`Entrar no ${label}`, `Sign in to ${label}`)} onClose={close} className="login-term">
      {s.state === 'done' ? (
        <p className="note note--ok">
          <Icon name="check" size={14} /> {L(`Pronto: o ${label} está conectado.`, `Done: ${label} is connected.`)}
        </p>
      ) : (
        <>
          <p className="small modal__lead">
            {s.hint ??
              (s.code
                ? L('Abra a página, entre na sua conta e digite o código abaixo.', 'Open the page, sign in to your account and type the code below.')
                : L('Abra a página e entre na sua conta. Se ela mostrar um código no fim, cole aqui embaixo.', 'Open the page and sign in to your account. If it shows a code at the end, paste it below.'))}
          </p>
          {(s.url || s.code) && (
            <div className="login-term__go">
              {s.url && (
                <button className="btn btn--primary btn--sm" onClick={() => openExternal(s.url!)}>
                  {L('Abrir a página de login', 'Open the sign-in page')}
                </button>
              )}
              {s.url && (
                <button className="btn btn--ghost btn--sm" onClick={() => copy(s.url!)}>
                  <Icon name="copy" size={13} /> {L('Copiar link', 'Copy link')}
                </button>
              )}
              {s.code && (
                <button className="login-term__code" onClick={() => copy(s.code!)} title={L('Copiar o código', 'Copy the code')}>
                  <span className="mono">{s.code}</span> <Icon name="copy" size={13} />
                </button>
              )}
            </div>
          )}
        </>
      )}
      <pre className="login-term__screen" aria-label={L('A tela do login', 'The sign-in screen')} aria-live="polite">
        {s.lines.join('\n') || L('Abrindo…', 'Opening…')}
      </pre>
      {running && (
        <>
          <form
            className="row login-term__type"
            onSubmit={(e) => {
              e.preventDefault()
              send({ text, enter: true })
              setText('')
            }}
          >
            <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={L('Cole o código ou digite aqui', 'Paste the code or type here')} autoComplete="off" spellCheck={false} />
            <button className="btn btn--sm" type="submit">
              {L('Enviar', 'Send')}
            </button>
          </form>
          <div className="login-term__keys" aria-label={L('Teclas', 'Keys')}>
            {(
              [
                ['up', '↑', L('Para cima', 'Up')],
                ['down', '↓', L('Para baixo', 'Down')],
                ['enter', 'Enter', 'Enter'],
                ['esc', 'Esc', 'Esc']
              ] as const
            ).map(([key, face, name]) => (
              <button key={key} className="btn btn--ghost btn--sm" aria-label={name} onClick={() => send({ key })}>
                {face}
              </button>
            ))}
          </div>
        </>
      )}
      {(s.state === 'failed' || s.state === 'cancelled') && (
        <div className="row">
          <span className="small grow field__error">{s.error ?? L('O login foi interrompido.', 'The sign-in was stopped.')}</span>
          <button className="btn btn--sm btn--primary" onClick={again}>
            {L('Tentar de novo', 'Try again')}
          </button>
        </div>
      )}
      {!running && (
        <div className="row row--end">
          <button className="btn btn--sm" onClick={close}>
            {L('Fechar', 'Close')}
          </button>
        </div>
      )}
    </Modal>
  )
}
