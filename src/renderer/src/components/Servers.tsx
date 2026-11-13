// Settings › Servers: Tucanos that run on a server (yours, or your company's), shown in this
// window over the app. Desktop only; the pairing link comes from the server (`server.js link`).
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { pairProblem } from '../../../shared/servers'
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
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api])

  const connect = async (): Promise<void> => {
    setError('')
    setBusy(true)
    const r = await api.pair(link).finally(() => setBusy(false))
    if (r === 'paired') return setLink('')
    if (r === 'invalid' || r === 'used' || r === 'unreachable') {
      const p = pairProblem(r)
      setError(`${p.title}. ${p.detail}`)
    }
  }
  const forget = async (s: Server): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Esquecer o Tucano em ${s.name}?`, `Forget the Tucano at ${s.name}?`),
      body: L('Só este computador esquece o acesso. O Tucano do servidor continua lá, com tudo.', "Remove access from this computer. The server and its data stay unchanged."),
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
          'Um Tucano que roda num servidor, ligado o tempo todo, aberto aqui mesmo: escolha na lista do topo da barra lateral, e volte pela faixa de cima. Os agentes e as conversas são os de lá; nada deste computador vai pra ele.',
          "Open a server workspace from the sidebar switcher; return with the bar above it. Its data stays on the server. Your local workspace is not uploaded."
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
          'Cole o link de conexão que o servidor deu (tucano://connect…, ou o link de entrada do navegador, com ?code=). Quem tem o link controla os agentes de lá: cole só links seus ou de quem você confia.',
          "Paste a trusted tucano://connect… or ?code= sign-in link. Anyone with it can control the server’s agents."
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

// The servers, live: the list and which one is on screen.
export function useServers(): Server[] {
  const api = window.tucano?.servers
  const [list, setList] = useState<Server[]>([])
  useEffect(() => {
    if (!api) return
    let alive = true
    const load = (): void => void api.list().then((l) => alive && setList(l))
    load()
    const off = api.onChanged(load)
    return () => {
      alive = false
      off()
    }
  }, [api])
  return list
}

// Over a server's page, which fills the rest of the window: which Tucano it is, the other
// servers, and the way back to this computer's (src/main/servers.ts keeps BAR px for it).
export function ServerBar(): ReactNode {
  const servers = useServers()
  const on = servers.find((s) => s.open)
  if (!on) return null
  const api = window.tucano.servers!
  return (
    <div className="server-bar">
      <Icon name="globe" size={14} />
      <span className="server-bar__name">
        {L('Tucano em', 'Tucano at')} <strong>{on.name}</strong>
      </span>
      <span className="grow" />
      {servers
        .filter((s) => !s.open)
        .map((s) => (
          <button key={s.id} className="btn btn--ghost btn--sm" onClick={() => api.open(s.id)}>
            {s.name}
          </button>
        ))}
      <button className="btn btn--sm" onClick={() => api.local()}>
        <Icon name="laptop" size={14} /> {L('Voltar pra este computador', 'Back to this computer')}
      </button>
    </div>
  )
}
