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
import type { UplinkStatus } from '../../../shared/node-link'
import { FoldToggle } from './Fold'

type Server = { id: string; name: string; origin: string; open: boolean; node: boolean }

export const hasServers = (): boolean => !!window.tucano?.servers

export function ServersCard(): ReactNode {
  const api = window.tucano.servers!
  const node = useNodeInfo()
  const links = node?.links ?? []
  const main = useStore((s) => s.defaultWorkspace)
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
          <div key={s.id} className="server-row">
            <div className="key-row">
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
            <Lend server={s} status={links.find((l) => l.serverId === s.id)} main={main} folders={node?.folders ?? []} />
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

// What this computer lends the servers it's lent to, and how each line is doing: from the core, live.
function useNodeInfo(): NodeInfo | null {
  const live = useStore((s) => s.node)
  const [first, setFirst] = useState<NodeInfo | null>(null)
  useEffect(() => {
    void call('nodeInfo').then(setFirst, () => {})
  }, [])
  return live ?? first
}

const LINK: Record<UplinkStatus['state'], { pt: string; en: string; tone: string }> = {
  connected: { pt: 'Conectado: os agentes de lá podem usar este computador quando trabalham pra você.', en: 'Connected: its agents can use this computer when they work for you.', tone: 'is-ok' },
  connecting: { pt: 'Conectando…', en: 'Connecting…', tone: '' },
  refused: { pt: '', en: '', tone: 'is-bad' },
  outdated: { pt: '', en: '', tone: 'is-bad' },
  error: { pt: '', en: '', tone: 'is-bad' }
}

// Under a server: lend it this computer (its terminal, the folders lent below, its browser and apps), or stop.
// Asked once, with what it means; off, the line hangs up at once. On, what's left is right under it: a folder
// (asked for at once when there's none) and the agents, picked on the server, one click away.
function Lend({ server, status, main, folders }: { server: Server; status?: UplinkStatus; main: boolean; folders: string[] }): ReactNode {
  const api = window.tucano.servers!
  const [error, setError] = useState('')
  const pick = (window.tucano as { pickFolder?: () => Promise<string | null> } | undefined)?.pickFolder // desktop only
  const lendFolder = async (): Promise<void> => {
    setError('')
    const path = await pick?.()
    if (path) await call('addNodeFolder', { path }).catch((e: unknown) => setError(why(e)))
  }
  const turn = async (on: boolean): Promise<void> => {
    if (on) {
      const ok = await confirmDialog({
        title: L(`Deixar o Tucano em ${server.name} usar este computador?`, `Let the Tucano at ${server.name} use this computer?`),
        body: L(
          'Os agentes de lá passam a usar o terminal, as pastas que você emprestar, o navegador e os apps deste computador, só quando trabalham pra você, com as aprovações configuradas lá. Funciona enquanto este app estiver aberto. Desligue aqui a qualquer hora.',
          'Its agents get to use this computer’s terminal, the folders you lend, its browser and apps, only when they work for you, under the approvals set there. It works while this app is open. Turn it off here any time.'
        ),
        confirm: L('Deixar usar', 'Let it')
      })
      if (!ok) return
    }
    api.setNode(server.id, on)
    // The file tools reach only lent folders: with none, the first is asked for right away (the person may cancel).
    if (on && main && !folders.length) await lendFolder()
  }
  const shown = status && server.node ? LINK[status.state] : undefined
  const connected = server.node && status?.state === 'connected'
  return (
    <div className="server-lend">
      <Toggle on={server.node} label={L(`Deixar ${server.name} usar este computador`, `Let ${server.name} use this computer`)} onChange={(on) => void turn(on)} />
      <div className="grow">
        <span className="small">{L('Deixar este servidor usar este computador', 'Let this server use this computer')}</span>
        {server.node && !main && <p className="muted small">{L('Quem empresta é o workspace principal: as pastas e os apps estão nas Configurações dele.', 'The main workspace lends it: the folders and apps are in its Settings.')}</p>}
        {shown && (
          <p className={`small server-lend__state ${shown.tone}`} role={shown.tone === 'is-bad' ? 'alert' : undefined}>
            {status!.error ?? L(shown.pt, shown.en)}
          </p>
        )}
        {server.node && main && (
          <div className="server-lend__next">
            <div className="server-lend__step">
              <Icon name={folders.length ? 'check' : 'folder'} size={14} />
              <span className="small grow">
                {folders.length
                  ? L(`Pastas: ${folders.map(shortPath).join(', ')}`, `Folders: ${folders.map(shortPath).join(', ')}`)
                  : L('Nenhuma pasta ainda: empreste a dos seus projetos.', 'No folders yet: lend your projects’ folder.')}
              </span>
              {pick && (
                <button className={`btn btn--sm ${folders.length ? 'btn--ghost' : 'btn--primary'}`} onClick={() => void lendFolder()}>
                  {folders.length ? L('Outra pasta', 'Another folder') : L('Emprestar uma pasta', 'Lend a folder')}
                </button>
              )}
            </div>
            <div className="server-lend__step">
              <Icon name="users" size={14} />
              <span className="small grow">{L('Escolha, no servidor, os agentes que usam este computador.', 'Pick, on the server, the agents that use this computer.')}</span>
              {api.openAgents && (
                <button className="btn btn--sm btn--primary" disabled={!connected} title={connected ? undefined : L('Assim que conectar', 'Once it connects')} onClick={() => api.openAgents!(server.id)}>
                  {L('Escolher os agentes', 'Pick the agents')}
                </button>
              )}
            </div>
            {error && <p className="note note--error">{error}</p>}
          </div>
        )}
      </div>
    </div>
  )
}

// What this computer lends the servers it's lent to (docs/local-node.md): the folders their file tools reach, the
// apps, and a log of what they ran here. The terminal, the browser and the local connectors come along by themselves.
export function NodeCard(): ReactNode {
  const live = useNodeInfo()
  const [info, setInfo] = useState<NodeInfo | null>(null)
  const servers = useServers()
  const main = useStore((s) => s.defaultWorkspace)
  // Once the agents live on the server, the ones here would answer and run routines a second time.
  const paused = useStore((s) => !!s.settings.paused)
  const running = useStore((s) => s.routines.filter((r) => r.enabled).length)
  useEffect(() => setInfo(live), [live])
  const lent = servers.filter((s) => s.node)
  if (!info || !main || !lent.length) return null
  return (
    <Card
      title={L('O que este computador empresta', 'What this computer lends')}
      lead={L(
        `Pra ${lent.map((s) => s.name).join(', ')}: o terminal, o navegador e os conectores deste computador vão junto; as pastas e os apps, só os de baixo. Tudo segue as aprovações configuradas no servidor.`,
        `To ${lent.map((s) => s.name).join(', ')}: this computer’s terminal, browser and connectors come along; folders and apps, only the ones below. Everything follows the approvals set on the server.`
      )}
    >
      {!paused && (
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
      <div className="node-card">
        <NodeFolders info={info} onChange={setInfo} />
        {/* The apps the servers' agents may use here (Premiere, Notes…), each to read or to change: the
            same picker as an agent's page. */}
        <div className="node-card__apps">
          <span className="field__label">{L('Apps que ele empresta', 'Apps it lends')}</span>
          <AppsCard apps={info.apps} onChange={(apps) => void call('setNode', { apps }).then(setInfo, () => {})} />
        </div>
        <NodeLog />
      </div>
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
          ? L('As ferramentas de arquivo do servidor só alcançam estas pastas. O terminal alcança o que você alcança, com as mesmas aprovações de um agente neste computador.', "The server's file tools only reach these folders. The terminal reaches what you reach, under the same approvals as an agent on this computer.")
          : L('Nenhuma pasta ainda: as ferramentas de arquivo do servidor não leem nem gravam nada aqui. Empreste as pastas dos seus projetos. O terminal alcança o que você alcança, com as mesmas aprovações de um agente neste computador.', "No folders yet: the server's file tools don't read or write anything here. Lend your projects' folders. The terminal reaches what you reach, under the same approvals as an agent on this computer.")}
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
