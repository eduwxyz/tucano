// Settings › Servers: Tucanos that run on a server (yours, or your company's), shown in this
// window over the app. Desktop only; the pairing link comes from the server (`server.js link`).
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { pairProblem } from '../../../shared/servers'
import { confirmDialog } from './Dialogs'
import { Card, Toggle } from './Pages'
import { Icon } from './ui'
import { AppsCard } from './Apps'
import { call } from '../rpc'
import { updateSettings, useStore } from '../store'
import type { NodeInfo, NodeLogEntry } from '../../../shared/types'
import { FoldToggle } from './Fold'

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
          'Um Tucano que roda num servidor, ligado o tempo todo, aberto aqui mesmo: escolha na lista do topo da barra lateral, e volte pela faixa de cima. Os agentes e as conversas são os de lá; nada deste computador vai pra ele.',
          'A Tucano running on a server, always on, opened right here: pick it in the list at the top of the sidebar, and come back from the bar above it. The agents and conversations are the server’s; nothing on this computer goes to it.'
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
          'Paste the connection link the server gave you (tucano://connect…, or the browser sign-in link, with ?code=). Whoever has the link controls the agents there: paste only links of your own or from someone you trust.'
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

// This computer as a node of a server's Tucano (docs/plan-local-node.md): the server's agents reach this
// machine's terminal and files like a connector, with the same autonomy and approvals as here. Off by
// default; the way in is a private network (Tailscale), with the key below.
export function NodeCard(): ReactNode {
  const [info, setInfo] = useState<NodeInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  // Once the agents live on the server, the ones here would answer and run routines a second time.
  const paused = useStore((s) => !!s.settings.paused)
  const running = useStore((s) => s.routines.filter((r) => r.enabled).length)
  useEffect(() => {
    void call('nodeInfo').then(setInfo, () => {})
  }, [])
  if (!info) return null
  const run = (p: Promise<NodeInfo>): void => {
    setBusy(true)
    void p.then(setInfo, () => {}).finally(() => setBusy(false))
  }
  const copy = (text: string): void => void navigator.clipboard.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))
  return (
    <Card
      title={L('Este computador como nó', 'This computer as a node')}
      lead={L('Os agentes de um Tucano num servidor usam o terminal, os arquivos, os conectores, o navegador e os apps deste computador, com a mesma autonomia daqui.', "The agents of a Tucano on a server use this computer's terminal, files, connectors, browser and apps, with the same autonomy as here.")}
      action={<Toggle on={info.on} disabled={busy} label={L('Este computador como nó', 'This computer as a node')} onChange={(on) => run(call('setNode', { on }))} />}
    >
      {info.error && <p className="field__error">{info.error}</p>}
      {info.on && !paused && (
        // No duplicates: the agents and routines that moved to the server stop here. The node keeps serving.
        <div className="node-card__twice">
          <span>
            {running
              ? L(`${running} ${running === 1 ? 'rotina ligada roda' : 'rotinas ligadas rodam'} também aqui. Se os agentes moram no servidor, pause este computador pra nada rodar duas vezes; ele continua emprestando terminal, arquivos e apps.`, `${running} enabled ${running === 1 ? 'routine runs' : 'routines run'} here too. If the agents live on the server, pause this computer so nothing runs twice; it keeps lending its terminal, files and apps.`)
              : L('Se os agentes moram no servidor, pause este computador pra nada responder duas vezes; ele continua emprestando terminal, arquivos e apps.', 'If the agents live on the server, pause this computer so nothing answers twice; it keeps lending its terminal, files and apps.')}
          </span>
          <button className="btn btn--sm" onClick={() => updateSettings({ paused: true })}>
            {L('Pausar este computador', 'Pause this computer')}
          </button>
        </div>
      )}
      {info.on && info.running && (
        <div className="node-card">
          <div className="node-card__row">
            <span className="muted small">{L('Escutando em', 'Listening on')}</span>
            <code>http://127.0.0.1:{info.port}/mcp</code>
          </div>
          {info.key && (
            <div className="node-card__row">
              <span className="muted small">{L('Chave', 'Key')}</span>
              <code className="node-card__key">{info.key.slice(0, 6)}…{info.key.slice(-4)}</code>
              <button className="btn btn--sm" onClick={() => copy(info.key!)}>
                {copied ? L('Copiada', 'Copied') : L('Copiar', 'Copy')}
              </button>
              <button
                className="btn btn--sm btn--ghost"
                disabled={busy}
                onClick={() =>
                  void confirmDialog({
                    title: L('Trocar a chave?', 'Change the key?'),
                    body: L('A chave atual para de funcionar: cole a nova no conector do servidor.', "The current key stops working: paste the new one into the server's connector."),
                    confirm: L('Trocar a chave', 'Change the key')
                  }).then((ok) => ok && run(call('rotateNodeKey')))
                }
              >
                {L('Trocar', 'Change')}
              </button>
            </div>
          )}
          <ol className="small node-card__steps">
            <li>
              {L('Neste computador, com o Tailscale aberto:', 'On this computer, with Tailscale open:')} <code>tailscale serve --bg {info.port}</code>
            </li>
            <li>{L('No Tucano do servidor: Conectores › Adicionar personalizado › Remoto, com o endereço https://<este-computador>.<sua-rede>.ts.net/mcp e autenticação Token, colando a chave.', "In the server's Tucano: Connectors › Add custom › Remote, with the address https://<this-computer>.<your-tailnet>.ts.net/mcp and Token authentication, pasting the key.")}</li>
            <li>{L('Dê acesso aos agentes que vão usar este computador, em Ferramentas.', 'Give access to the agents that will use this computer, under Tools.')}</li>
          </ol>
          <p className="node-card__twice">{L('Use tailscale serve, nunca tailscale funnel: o funnel abre este computador pra internet inteira.', 'Use tailscale serve, never tailscale funnel: funnel opens this computer to the whole internet.')}</p>
          <NodeFolders info={info} onChange={setInfo} />
          <NodeLog />
          {/* The apps the server's agents may use here (Premiere, Notes…), each to read or to change: the
              same picker as an agent's page. Its connectors and browser come with the node on their own. */}
          <div className="node-card__apps">
            <span className="field__label">{L('Apps que ele empresta', 'Apps it lends')}</span>
            <AppsCard apps={info.apps} onChange={(apps) => run(call('setNode', { on: info.on, apps }))} />
          </div>
        </div>
      )}
    </Card>
  )
}

// The folders the node lends: the only ones the server's file tools reach here. The core refuses what
// can't be lent (outside the home folder, Library, a dot folder, Tucano's data) and says why.
const shortPath = (path: string): string => path.replace(/^\/(Users|home)\/[^/]+(?=\/|$)/, '~')
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function NodeFolders({ info, onChange }: { info: NodeInfo; onChange: (info: NodeInfo) => void }): ReactNode {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pick = (window.tucano as { pickFolder?: () => Promise<string | null> } | undefined)?.pickFolder // desktop only
  const run = (p: Promise<NodeInfo>): void => {
    setError('')
    setBusy(true)
    void p.then(onChange, (e: unknown) => setError(why(e))).finally(() => setBusy(false))
  }
  const add = (): void => void pick?.().then((path) => path && run(call('addNodeFolder', { path })))
  const folders = info.folders ?? []
  return (
    <div className="node-card__apps">
      <span className="field__label">{L('Pastas que ele empresta', 'Folders it lends')}</span>
      <p className="muted small">
        {folders.length
          ? L('As ferramentas de arquivo do servidor só alcançam estas pastas. O terminal continua sendo um terminal, e passa pelas aprovações.', "The server's file tools only reach these folders. The terminal is still a terminal, and goes through approvals.")
          : L('Nenhuma pasta: as ferramentas de arquivo do servidor não leem nem gravam nada neste computador. O terminal continua passando pelas aprovações.', "No folders: the server's file tools don't read or write anything on this computer. The terminal still goes through approvals.")}
      </p>
      {folders.length > 0 && (
        <div className="apps-list">
          {folders.map((f) => (
            <div key={f} className="apps-row">
              <Icon name="folder" />
              <code className="node-card__path grow" title={f}>
                {shortPath(f)}
              </code>
              <button className="icon-btn icon-btn--sm" title={L('Parar de emprestar', 'Stop lending')} aria-label={L(`Parar de emprestar ${shortPath(f)}`, `Stop lending ${shortPath(f)}`)} disabled={busy} onClick={() => run(call('removeNodeFolder', { path: f }))}>
                <Icon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="note note--error">{error}</p>}
      {pick && (
        <button className="btn btn--sm apps-add" disabled={busy} onClick={add}>
          <Icon name="plus" size={14} /> {folders.length ? L('Emprestar outra pasta', 'Lend another folder') : L('Emprestar uma pasta', 'Lend a folder')}
        </button>
      )}
    </div>
  )
}

// What the server ran here through the node, kept on this computer (newest first). No push: a button reloads it.
function NodeLog(): ReactNode {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<NodeLogEntry[] | null>(null)
  const [error, setError] = useState('')
  const load = (): void => {
    setError('')
    void call('nodeLog', { limit: 100 }).then(setEntries, (e: unknown) => setError(why(e)))
  }
  useEffect(() => {
    if (open && !entries) load()
  }, [open])
  const time = (at: number): string => new Date(at).toLocaleString(L('pt-BR', 'en-US'), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return (
    <div className="node-card__apps">
      <div className="node-log__head">
        <FoldToggle open={open} onToggle={() => setOpen(!open)}>
          {L('O que o servidor rodou aqui', 'What the server ran here')}
        </FoldToggle>
        {open && (
          <button className="btn btn--sm btn--ghost" onClick={load}>
            {L('Atualizar', 'Refresh')}
          </button>
        )}
      </div>
      {open && error && <p className="note note--error">{error}</p>}
      {open && entries && !entries.length && <p className="muted small">{L('Nada ainda: o servidor não rodou nada neste computador.', "Nothing yet: the server hasn't run anything on this computer.")}</p>}
      {open && entries && entries.length > 0 && (
        <div className="node-log">
          {entries.map((e, i) => (
            <div key={`${e.at}-${i}`} className={`node-log__row ${e.ok ? '' : 'is-error'}`} title={e.error}>
              <span className="muted small node-log__time">{time(e.at)}</span>
              <code className="node-log__tool">{e.tool}</code>
              <code className="node-log__summary">{e.summary}</code>
              <span className={`tag ${e.ok ? '' : 'tag--danger'}`}>{e.ok ? 'ok' : L('erro', 'error')}</span>
              {!e.ok && e.error && <span className="small node-log__error">{e.error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
