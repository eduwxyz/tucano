import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { PhoneState } from '../rpc'
import { toast, useStore, youPerson } from '../store'
import { Card } from './Pages'
import { MyDevices, Qr } from './People'
import { Icon } from './ui'

// Seu iPhone (desktop only): the Tucano app on the phone, over the home Wi-Fi, as you
// (src/main/home-phone.ts). Off until turned on; a QR code with a one-time code pairs a phone.
export function HomePhoneCard(): ReactNode {
  const api = window.tucano.phone
  const [state, setState] = useState<PhoneState>()
  const [code, setCode] = useState<{ link: string; expiresAt: number } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [paired, setPaired] = useState(false)
  // The phones paired with this computer: each one a key of the owner's (people.deviceKey).
  const devices = useStore(youPerson)?.devices ?? 0

  useEffect(() => {
    if (!api) return
    void api.state().then(setState)
    return api.onChanged(setState)
  }, [])
  // A phone came on the line while the code was up: it was used.
  useEffect(() => {
    if (code && (state?.connected ?? 0) > 0) {
      setCode(null)
      setPaired(true)
    }
  }, [state?.connected])
  useEffect(() => {
    if (!code) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(tick)
  }, [code])

  if (!api) return null
  const fail = (e: unknown): void => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
  const connect = (): void => {
    setBusy(true)
    setError('')
    setPaired(false)
    api
      .code()
      .then((c) => {
        if (!c) throw new Error(L('Não consegui abrir a conexão.', "I couldn't open the connection."))
        setCode(c)
        setNow(Date.now())
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const turnOff = (): void => {
    setBusy(true)
    setCode(null)
    setPaired(false)
    api
      .set(false)
      .then((s) => s && setState(s))
      .catch(fail)
      .finally(() => setBusy(false))
  }
  const copy = (text: string): void =>
    void navigator.clipboard.writeText(text).then(
      () => toast(L('Copiado', 'Copied')),
      () => toast(L('Não consegui copiar.', "I couldn't copy."))
    )
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0
  const on = !!state?.on
  const firewall =
    navigator.platform.startsWith('Win')
      ? L('Se o Windows perguntar se o Tucano pode usar a rede, permita nas redes privadas.', 'If Windows asks whether Tucano may use the network, allow it on private networks.')
      : navigator.platform.startsWith('Linux') || navigator.userAgent.includes('Linux')
        ? L('Se o computador tiver firewall (ufw, firewalld), libere a porta mostrada abaixo na rede de casa.', 'If this computer has a firewall (ufw, firewalld), open the port shown below on the home network.')
        : L('Se o Mac perguntar se o Tucano pode aceitar conexões, clique em Permitir.', 'If the Mac asks whether Tucano may accept connections, click Allow.')

  return (
    <Card
      title={L('Seu iPhone', 'Your iPhone')}
      lead={L(
        'Use o Tucano no iPhone com tudo daqui: suas conversas, aprovações e as perguntas dos agentes. Funciona no Wi-Fi de casa, com o computador ligado.',
        'Use Tucano on your iPhone with everything here: your conversations, approvals and the questions agents ask you. It works on your home Wi-Fi, with this computer on.'
      )}
      action={
        !code ? (
          <button className="btn btn--primary btn--sm" disabled={busy} onClick={connect}>
            <Icon name="plus" size={14} /> {on ? L('Conectar outro iPhone', 'Connect another iPhone') : L('Conectar meu iPhone', 'Connect my iPhone')}
          </button>
        ) : undefined
      }
    >
      {code &&
        (left === 0 ? (
          <div className="row">
            <span className="small grow">{L('Esse código passou do prazo.', 'This code has expired.')}</span>
            <button className="btn btn--sm btn--primary" onClick={connect}>
              {L('Gerar outro', 'Make another')}
            </button>
          </div>
        ) : (
          <div className="device-pair">
            <Qr text={code.link} />
            <div className="device-pair__text">
              <ol className="small steps-list">
                <li>{L('Deixe o iPhone no mesmo Wi-Fi que este computador.', 'Put the iPhone on the same Wi-Fi as this computer.')}</li>
                <li>{L('Abra o app do Tucano, toque no ícone de QR code e aponte pra cá.', 'Open the Tucano app, tap the QR code icon and point it here.')}</li>
                <li>{L('Quando o iPhone pedir acesso à rede local, toque em Permitir.', 'When the iPhone asks for local network access, tap Allow.')}</li>
              </ol>
              <p className="muted small">
                {L('Vale uma vez, por mais', 'Good once, for')} {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}. {firewall}
              </p>
              <div className="device-pair__actions">
                <button className="btn btn--sm btn--ghost" onClick={() => copy(code.link)}>
                  <Icon name="copy" size={13} /> {L('Copiar link', 'Copy link')}
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => setCode(null)}>
                  {L('Cancelar', 'Cancel')}
                </button>
              </div>
            </div>
          </div>
        ))}
      {paired && <p className="small">{L('Pronto: o iPhone está conectado.', 'Done: the iPhone is connected.')}</p>}
      {on && !code && (
        <div className="row">
          <span className="small grow muted">
            {state!.connected > 0
              ? state!.connected === 1
                ? L('1 iPhone conectado agora', '1 iPhone connected now')
                : L(`${state!.connected} iPhones conectados agora`, `${state!.connected} iPhones connected now`)
              : L('Ligado. Nenhum iPhone conectado agora.', 'On. No iPhone connected right now.')}{' '}
            · <span className="mono">{state!.address}</span>
            {state!.workspace ? ` · ${state!.workspace}` : ''}
          </span>
          <button className="btn btn--sm btn--ghost" disabled={busy} onClick={turnOff}>
            {L('Desligar', 'Turn off')}
          </button>
        </div>
      )}
      {!code && devices > 0 && (
        <MyDevices
          count={devices}
          refresh={state?.connected}
          lead={L(`Pareados com este computador: ${devices} aparelho${devices > 1 ? 's' : ''}. Desconectar tira o acesso na hora.`, `Paired with this computer: ${devices} device${devices > 1 ? 's' : ''}. Disconnecting takes the access away at once.`)}
        />
      )}
      {on && (
        <p className="muted small">
          {L('Fora de casa, o iPhone não alcança este computador. Pra levar o time junto, use o Tucano Pro.', "Away from home, the iPhone can't reach this computer. To take your team along, use Tucano Pro.")}
        </p>
      )}
      {(error || state?.error) && (
        <p className="field__error" role="alert">
          {error || state?.error}
        </p>
      )}
    </Card>
  )
}
