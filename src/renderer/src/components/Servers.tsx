// Settings › Servers: Tucanos that run on a server (yours, or your company's), each opened in a
// window of its own. Desktop only; the pairing link comes from the server (`server.js link`).
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { confirmDialog } from './Dialogs'
import { Card } from './Pages'
import { Icon } from './ui'

type Server = { id: string; name: string; origin: string; open: boolean }

export const hasServers = (): boolean => !!window.tucano?.servers

export function ServersCard(): ReactNode {
  const api = window.tucano.servers!
  const [list, setList] = useState<Server[]>([])
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const load = (): void => void api.list().then((l) => alive && setList(l))
    load()
    api.onChanged(load)
    return () => {
      alive = false
    }
  }, [api])

  const connect = async (): Promise<void> => {
    setError('')
    setBusy(true)
    const r = await api.pair(link).finally(() => setBusy(false))
    if (r === 'paired') return setLink('')
    if (r === 'invalid') setError(L('Esse não é um link de conexão. Ele começa com tucano://connect e sai do servidor.', "That's not a connection link. It starts with tucano://connect and comes from the server."))
  }
  const forget = async (s: Server): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Esquecer o Tucano em ${s.name}?`, `Forget the Tucano at ${s.name}?`),
      body: L('Só este computador esquece o acesso. O Tucano do servidor continua lá, com tudo.', 'Only this computer forgets the access. The Tucano on the server stays there, with everything.'),
      confirm: L('Esquecer', 'Forget'),
      danger: true
    })
    if (ok) await api.forget(s.id)
  }

  return (
    <>
      <Card
        title={L('Servidores', 'Servers')}
        lead={L(
          'Um Tucano que roda num servidor, ligado o tempo todo, aberto aqui como um app. Cada um abre na própria janela, com os agentes e as conversas de lá; nada deste computador vai pra ele.',
          'A Tucano running on a server, always on, opened here like an app. Each one opens in its own window, with its agents and conversations; nothing on this computer goes to it.'
        )}
      >
        <div className="key-row">
          <Icon name="laptop" />
          <div className="grow">
            <strong>{L('Este computador', 'This computer')}</strong>
            <p className="muted small">{L('O Tucano desta janela: os agentes, as rotinas e os apps deste computador.', 'The Tucano in this window: the agents, routines and apps of this computer.')}</p>
          </div>
        </div>
        {list.map((s) => (
          <div key={s.id} className="key-row">
            <Icon name="globe" />
            <div className="grow">
              <strong>{s.name}</strong>
              <p className="muted small">{s.open ? L('Aberto numa janela', 'Open in a window') : L('Pareado com este computador', 'Paired with this computer')}</p>
            </div>
            <div className="row">
              <button className="btn btn--sm btn--primary" onClick={() => api.open(s.id)}>
                {s.open ? L('Mostrar', 'Show') : L('Abrir', 'Open')}
              </button>
              <button className="btn btn--sm btn--ghost" onClick={() => void forget(s)}>
                {L('Esquecer', 'Forget')}
              </button>
            </div>
          </div>
        ))}
      </Card>
      <Card
        title={L('Conectar a um servidor', 'Connect to a server')}
        lead={L(
          'Cole o link de conexão que o servidor deu (tucano://connect…). Quem tem o link controla os agentes de lá: cole só links seus ou de quem você confia.',
          'Paste the connection link the server gave you (tucano://connect…). Whoever has the link controls the agents there: paste only links of your own or from someone you trust.'
        )}
      >
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            if (link.trim() && !busy) void connect()
          }}
        >
          <input className="grow" type="password" autoComplete="off" spellCheck={false} placeholder="tucano://connect?url=…" value={link} onChange={(e) => (setLink(e.target.value), setError(''))} />
          <button className="btn btn--sm btn--primary" type="submit" disabled={!link.trim() || busy}>
            {L('Conectar', 'Connect')}
          </button>
        </form>
        {error && <p className="note note--error">{error}</p>}
      </Card>
    </>
  )
}
