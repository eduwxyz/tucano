// Small windows over the app (a channel's members and settings) and the
// right-click menu. Which window is open lives in the store, so the sidebar's
// menu and the channel's header open the same ones.
import { L } from '../../../shared/lang'
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent as KeyEvent, type ReactNode } from 'react'
import { agentById, amAdmin, archiveAgent, canEditChannel, isTeam, openTuca, createChannel, finishConnectorAuth, getState, navigate, openDialog, openDm, renameChannel, setChannelMembers, setThreads, setTopic, shortcut, useStore, type Conversation, type State, type View } from '../store'
import { AgentAvatar, Icon, type IconName } from './ui'
import { WorkspaceManager } from './WorkspaceManager'
import { Modal } from './Modal'
import { LoginHost } from './LoginTerminal'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))

export function Dialogs(): ReactNode {
  return (
    <>
      <DialogBody />
      <ConfirmHost />
      <LoginHost />
    </>
  )
}

// ---------- asking before something is deleted, archived or removed ----------
// confirmDialog({ title, body, confirm, danger }) opens a small window over the app and
// resolves true when the person clicks the confirm button (named with the verb and the
// thing: “Excluir #lancamento”), false on Cancelar, Esc or a click outside. danger is for
// what can't be undone: red button, and Cancelar holds the focus so Enter doesn't destroy.
type Ask = { title: string; body?: string; confirm: string; danger?: boolean; resolve: (ok: boolean) => void }
let asking: Ask | null = null
const askListeners = new Set<() => void>()
const setAsking = (a: Ask | null): void => {
  asking = a
  askListeners.forEach((l) => l())
}

export function confirmDialog(o: { title: string; body?: string; confirm: string; danger?: boolean }): Promise<boolean> {
  asking?.resolve(false)
  return new Promise((resolve) => setAsking({ ...o, resolve }))
}

function ConfirmHost(): ReactNode {
  const ask = useSyncExternalStore(
    (l) => {
      askListeners.add(l)
      return () => askListeners.delete(l)
    },
    () => asking
  )
  if (!ask) return null
  const answer = (ok: boolean): void => {
    if (asking !== ask) return
    setAsking(null)
    ask.resolve(ok)
  }
  return (
    <Modal title={ask.title} onClose={() => answer(false)}>
      {ask.body?.split('\n\n').map((p, i) => (
        <p key={i} className="small modal__lead">
          {p}
        </p>
      ))}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" autoFocus={ask.danger} onClick={() => answer(false)}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className={`btn btn--sm ${ask.danger ? 'btn--danger' : 'btn--primary'}`} autoFocus={!ask.danger} onClick={() => answer(true)}>
          {ask.confirm}
        </button>
      </footer>
    </Modal>
  )
}

function DialogBody(): ReactNode {
  const dialog = useStore((s) => s.dialog)
  const conv = useStore((s) => (s.dialog && 'id' in s.dialog ? s.conversations.find((c) => c.id === (s.dialog as { id: string }).id) : undefined))
  const close = (): void => openDialog(null)
  if (dialog?.kind === 'workspaces') return <WorkspaceManager onClose={close} create={dialog.create} />
  if (dialog?.kind === 'search') return <Search onClose={close} />
  if (dialog?.kind === 'archived') return <Archived onClose={close} />
  if (dialog?.kind === 'oauth') return <OAuthDialog id={dialog.id} url={dialog.url} onClose={close} />
  if (dialog?.kind === 'new-channel') return <SettingsDialog onClose={() => getState().dialog?.kind === 'new-channel' && close()} />
  if (!dialog || !conv) return null
  if (dialog.kind === 'members') return <MembersDialog id={conv.id} name={conv.name} members={conv.members} onClose={close} />
  return <SettingsDialog conv={conv} onClose={close} />
}

// A channel's name, topic and where its agents answer; a DM's, only where. Without `conv`, a new channel.
function SettingsDialog({ conv, onClose }: { conv?: Conversation; onClose: () => void }): ReactNode {
  const dmName = useStore((s) => (conv?.kind === 'dm' && conv.members[0] ? agentById(s, conv.members[0])?.name : undefined))
  const channel = conv?.kind !== 'dm'
  // Its name and topic are its maker's and the admins'; anyone else only sees them.
  const editable = useStore((s) => !conv || canEditChannel(s, conv))
  const [name, setName] = useState(conv?.name ?? '')
  const [topic, setTopicText] = useState(conv?.topic ?? '')
  const [threads, setThreadsOn] = useState(!!conv?.threads)
  const [error, setError] = useState<string | null>(null)
  // Saving with no name: the field shakes and goes red, instead of nothing happening.
  const [invalid, setInvalid] = useState(false)
  const [shaking, setShaking] = useState(false)
  const save = (): void => {
    if (channel && !name.trim()) return void (setInvalid(true), setShaking(true))
    const done = !conv
      ? createChannel(name, threads)
      : Promise.all([
          channel && editable && name.trim() !== conv.name ? renameChannel(conv.id, name) : undefined,
          channel && editable && topic.trim() !== (conv.topic ?? '') ? setTopic(conv.id, topic) : undefined,
          editable && threads !== !!conv.threads ? setThreads(conv.id, threads) : undefined
        ])
    done.then(onClose, (e: unknown) => setError(message(e)))
  }
  const enter = (e: KeyEvent): void => void (e.key === 'Enter' && save())
  const choices = [
    { on: false, label: L('Na conversa, como um chat', 'In the conversation, like a chat'), about: L('As respostas vêm logo abaixo da mensagem.', 'Answers come right below the message.') },
    { on: true, label: L('Em threads, uma por mensagem', 'In threads, one per message'), about: L('Cada mensagem abre uma thread na lateral, com as respostas dela.', 'Each message opens a thread on the side, with its answers.') }
  ]
  const title = !conv ? L('Novo canal', 'New channel') : channel ? L(`Configurações de #${conv.name}`, `#${conv.name} settings`) : L(`Conversa com ${dmName ?? 'o agente'}`, `Conversation with ${dmName ?? 'the agent'}`)
  return (
    <Modal title={title} onClose={onClose}>
      {channel && (
        <label className="field">
          <span className="field__label">{L('Nome', 'Name')}</span>
          <span className={`row row--center modal__input ${invalid ? 'is-invalid' : ''} ${shaking ? 'is-shaking' : ''}`} onAnimationEnd={() => setShaking(false)}>
            <span className="muted">#</span>
            <input autoFocus className="grow" value={name} readOnly={!editable} onChange={(e) => (setName(e.target.value), setInvalid(false))} onKeyDown={enter} />
          </span>
          <span className="hint">
            {conv
              ? L('Minúsculas e hífens: “Lançamento do App” vira lancamento-do-app.', 'Lowercase and hyphens: “App Launch” becomes app-launch.')
              : L('Minúsculas e hífens: “Squad Pagamentos” vira squad-pagamentos. Depois você escolhe os agentes.', 'Lowercase and hyphens: “Payments Squad” becomes payments-squad. You pick the agents next.')}
          </span>
        </label>
      )}
      {channel && conv && (
        <label className="field">
          <span className="field__label">{L('Tema', 'Topic')}</span>
          <span className="row row--center modal__input">
            <input className="grow" value={topic} readOnly={!editable} onChange={(e) => setTopicText(e.target.value)} onKeyDown={enter} />
          </span>
          <span className="hint">
            {editable
              ? L('Uma linha no topo do canal dizendo pra que ele serve. Vazio, some.', 'One line at the top of the channel saying what it is for. Empty, it goes away.')
              : L('O nome, o tema e os agentes, quem muda é quem criou o canal ou um admin.', 'The name, topic and agents are changed by whoever created the channel or an admin.')}
          </span>
        </label>
      )}
      {editable && <div className="field">
        <span className="field__label" id="answers-where">
          {L('Onde os agentes respondem', 'Where the agents answer')}
        </span>
        <div className="choices" role="radiogroup" aria-labelledby="answers-where">
          {choices.map((c) => (
            <button key={String(c.on)} type="button" role="radio" aria-checked={threads === c.on} className={`choice ${threads === c.on ? 'is-on' : ''}`} onClick={() => setThreadsOn(c.on)}>
              <b>{c.label}</b>
              <small>{c.about}</small>
            </button>
          ))}
        </div>
        <span className="hint">{L('Dá pra abrir uma thread numa mensagem quando quiser, nos dois jeitos.', 'You can open a thread on a message whenever you want, either way.')}</span>
      </div>}
      {error && <p className="field__error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={channel && !name.trim()} onClick={save}>
          {conv ? L('Salvar', 'Save') : L('Criar canal', 'Create channel')}
        </button>
      </footer>
    </Modal>
  )
}

// Who is in the channel: a row per agent, on or off, saved together.
function MembersDialog({ id, name, members, onClose }: { id: string; name: string; members: string[]; onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter(isTeam))
  const [picked, setPicked] = useState<string[]>(members)
  const [error, setError] = useState<string | null>(null)
  const toggle = (a: string): void => setPicked(picked.includes(a) ? picked.filter((x) => x !== a) : [...picked, a])
  const changed = picked.length !== members.length || picked.some((a) => !members.includes(a))
  // Archived agents can't be shown, so they don't show up in the count either (they stay picked: saving keeps them in the channel).
  const inRoom = picked.filter((a) => agents.some((x) => x.id === a))
  return (
    <Modal title={L(`Agentes em #${name}`, `Agents in #${name}`)} onClose={onClose}>
      <p className="muted small modal__lead">{L('Quem está no canal lê a conversa e pode responder. Pra chamar alguém específico, use @.', 'Whoever is in the channel reads the conversation and can reply. To call on someone specific, use @.')}</p>
      <div className="member-list">
        {agents.map((a) => {
          const on = picked.includes(a.id)
          return (
            <button key={a.id} className={`member ${on ? 'is-on' : ''}`} onClick={() => toggle(a.id)}>
              <AgentAvatar agent={a} size={28} />
              <span className="member__text grow">
                <strong>{a.name}</strong>
                <span className="muted small">
                  @{a.handle}
                  {a.role ? ` · ${a.role}` : ''}
                </span>
              </span>
              <span className="member__check">{on && <Icon name="check" size={13} />}</span>
            </button>
          )
        })}
      </div>
      {error && <p className="field__error">{error}</p>}
      <footer className="modal__foot">
        <span className="muted small">
          {inRoom.length} {inRoom.length === 1 ? L('agente', 'agent') : L('agentes', 'agents')}
        </span>
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" disabled={!changed} onClick={() => setChannelMembers(id, picked).then(onClose, (e: unknown) => setError(message(e)))}>
          {L('Salvar', 'Save')}
        </button>
      </footer>
    </Modal>
  )
}

// Signing a connector in on a server: the authorization page opens here, and its
// last stop (the server's loopback, which this browser can't reach) is pasted back.
function OAuthDialog({ id, url, onClose }: { id: string; url: string; onClose: () => void }): ReactNode {
  const name = useStore((s) => s.connectors.find((c) => c.id === id)?.name ?? L('o conector', 'the connector'))
  // Connected some other way (the callback reached the server after all): nothing left to paste.
  const connected = useStore((s) => s.connectors.find((c) => c.id === id)?.status === 'connected')
  useEffect(() => {
    if (connected) onClose()
  }, [connected, onClose])
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // A server on its https address gets the provider's answer itself (src/server's /oauth/callback):
  // nothing to paste, this closes when the connector is in.
  const automatic = (() => {
    try {
      return !!new URL(url).searchParams.get('redirect_uri')?.startsWith(`${location.origin}/oauth/callback`)
    } catch {
      return false
    }
  })()
  const finish = (): void => {
    if (!pasted.trim() || busy) return
    setBusy(true)
    setError(null)
    finishConnectorAuth(pasted).then(
      (ok) => (ok ? onClose() : (setError(L('Esse pedido de autorização expirou. Feche e clique em Conectar de novo.', 'This authorization request expired. Close this and click Connect again.')), setBusy(false))),
      (e: unknown) => (setError(message(e)), setBusy(false))
    )
  }
  return (
    <Modal title={L(`Conectar ${name}`, `Connect ${name}`)} onClose={onClose}>
      <p className="small modal__lead">
        {L('1. Abra a página de autorização e permita o acesso.', '1. Open the authorization page and allow access.')}
      </p>
      <p>
        <a className="btn btn--primary btn--sm" href={url} target="_blank" rel="noopener noreferrer">
          {L('Abrir a página de autorização', 'Open the authorization page')}
        </a>
      </p>
      {automatic ? (
        <p className="small muted">{L('2. Depois de permitir, volte pra cá: o Tucano conecta sozinho e esta janela fecha.', '2. After you allow it, come back here: Tucano connects on its own and this closes.')}</p>
      ) : (
        <label className="field">
          <span className="field__label">{L('2. Cole aqui o endereço em que ela terminou', '2. Paste the address it ended on')}</span>
          <span className="row row--center modal__input">
            <input autoFocus className="grow" placeholder="http://127.0.0.1:…/oauth/callback?code=…" value={pasted} onChange={(e) => setPasted(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && finish()} />
          </span>
          <span className="hint">
            {L(
              'Depois de permitir, o navegador vai pra um endereço que começa com http://127.0.0.1 e mostra que a página não abre. É normal: o Tucano está no servidor. Copie o endereço inteiro da barra e cole aqui.',
              'After you allow it, the browser goes to an address starting with http://127.0.0.1 and says the page can’t be reached. That’s expected: Tucano is on the server. Copy the whole address from the bar and paste it here.'
            )}
          </span>
        </label>
      )}
      {error && <p className="field__error">{error}</p>}
      <footer className="modal__foot">
        <span className="grow" />
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        {!automatic && (
          <button className="btn btn--primary btn--sm" disabled={!pasted.trim() || busy} onClick={finish}>
            {L('Concluir', 'Finish')}
          </button>
        )}
      </footer>
    </Modal>
  )
}

// The agents taken out of the sidebar, to see or bring back.
function Archived({ onClose }: { onClose: () => void }): ReactNode {
  const agents = useStore((s) => s.agents.filter((a) => a.archived))
  return (
    <Modal title={L('Agentes arquivados', 'Archived agents')} onClose={onClose}>
      <p className="muted small modal__lead">{L('Não respondem, não rodam rotinas e não são escolhidos pra responder nos canais. O histórico e os recibos continuam. Reativado, o agente volta aos canais em que estava; as rotinas dele você liga de novo em Rotinas.', 'They don’t reply, don’t run routines and aren’t picked to answer in channels. History and receipts stay. Once reactivated, an agent returns to the channels it was in; you turn its routines back on in Routines.')}</p>
      {agents.length === 0 ? (
        <p className="muted small">{L('Nenhum agente arquivado.', 'No archived agents.')}</p>
      ) : (
        <div className="member-list">
          {agents.map((a) => (
            <div key={a.id} className="member">
              <AgentAvatar agent={a} size={28} />
              <span className="member__text grow">
                <strong>{a.name}</strong>
                <span className="muted small">
                  @{a.handle}
                  {a.role ? ` · ${a.role}` : ''}
                </span>
              </span>
              <button
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  onClose()
                  navigate({ kind: 'agent', id: a.id })
                }}
              >
                {L('Ver', 'See')}
              </button>
              <button className="btn btn--sm" onClick={() => void archiveAgent(a.id, false)}>
                {L('Reativar', 'Reactivate')}
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// ---------- ⌘K: go anywhere by typing ----------

type Hit = { key: string; label: string; detail: string; icon?: IconName; agent?: string; go: () => void }

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

// The report and the usage are the admins' screens, as in the sidebar.
const PAGES = (admin = true): { label: string; view: View; icon: IconName }[] => [
  { label: L('Aprovações', 'Approvals'), view: { kind: 'approvals' }, icon: 'shield' },
  { label: L('Memória', 'Memory'), view: { kind: 'memory' }, icon: 'book' },
  { label: 'Wiki', view: { kind: 'wiki' }, icon: 'layers' },
  { label: L('Rotinas', 'Routines'), view: { kind: 'routines' }, icon: 'clock' },
  { label: 'Skills', view: { kind: 'skills' }, icon: 'layers' },
  { label: L('Time', 'Team'), view: { kind: 'org' }, icon: 'users' },
  ...(admin
    ? ([
        { label: L('Boletim', 'Report'), view: { kind: 'report' }, icon: 'report' },
        { label: L('Uso e limites', 'Usage and limits'), view: { kind: 'usage' }, icon: 'chart' }
      ] as const)
    : []),
  { label: L('Conectores', 'Connectors'), view: { kind: 'connectors' }, icon: 'plug' },
  { label: L('Configurações', 'Settings'), view: { kind: 'settings' }, icon: 'gear' }
]

function hits(s: State): Hit[] {
  const agents = s.agents.filter(isTeam)
  return [
    ...s.conversations.filter((c) => c.kind === 'channel').map((c): Hit => ({ key: c.id, label: `#${c.name}`, detail: c.topic ?? L('canal', 'channel'), icon: 'hash', go: () => navigate({ kind: 'conversation', id: c.id }) })),
    ...agents.map((a): Hit => ({ key: `dm-${a.id}`, label: a.name, detail: `${L('conversa', 'conversation')}${a.role ? ` · ${a.role}` : ''}`, agent: a.id, go: () => void openDm(a.id) })),
    ...agents.map((a): Hit => ({ key: `agent-${a.id}`, label: L(`${a.name}: configurar`, `${a.name}: settings`), detail: `@${a.handle}`, icon: 'edit', go: () => navigate({ kind: 'agent', id: a.id }) })),
    ...PAGES(amAdmin(s)).map((p): Hit => ({ key: p.label, label: p.label, detail: L('tela', 'page'), icon: p.icon, go: () => navigate(p.view) })),
    { key: 'new-channel', label: L('Novo canal', 'New channel'), detail: shortcut(getState().platform, 'N'), icon: 'plus', go: () => openDialog({ kind: 'new-channel' }) },
    // Making agents is the admins'.
    ...(amAdmin(s)
      ? [
          { key: 'tuca', label: L('Tuca: montar um agente', 'Tuca: build an agent'), detail: L('conversa', 'conversation'), icon: 'plus' as const, go: openTuca },
          { key: 'new-agent', label: L('Novo agente (formulário)', 'New agent (form)'), detail: L('ação', 'action'), icon: 'plus' as const, go: () => navigate({ kind: 'new-agent' }) }
        ]
      : [])
  ]
}

function Search({ onClose }: { onClose: () => void }): ReactNode {
  const all = useStore(hits)
  const state = useStore((s) => s)
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const query = fold(q.trim().replace(/^[#@]/, ''))
  const list = (query ? all.filter((h) => fold(`${h.label} ${h.detail}`).includes(query)).sort((a, b) => Number(!fold(a.label).replace(/^#/, '').startsWith(query)) - Number(!fold(b.label).replace(/^#/, '').startsWith(query))) : all).slice(0, 12)
  const pick = (h: Hit | undefined): void => {
    if (!h) return
    onClose()
    h.go()
  }
  return (
    <div className="modal modal--top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search" role="dialog" aria-label={L('Ir pra', 'Go to')}>
        <div className="search__input">
          <Icon name="spark" size={16} />
          <input
            autoFocus
            value={q}
            placeholder={L('Ir pra um canal, agente ou tela…', 'Go to a channel, agent or page…')}
            onChange={(e) => {
              setQ(e.target.value)
              setAt(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') setAt(Math.min(at + 1, list.length - 1))
              else if (e.key === 'ArrowUp') setAt(Math.max(at - 1, 0))
              else if (e.key === 'Enter') pick(list[at])
              else if (e.key === 'Escape') onClose()
              else return
              e.preventDefault()
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="search__list">
          {list.length === 0 && <p className="muted small search__none">{L('Nada com', 'Nothing matching')} “{q}”.</p>}
          {list.map((h, i) => {
            const agent = h.agent ? agentById(state, h.agent) : undefined
            return (
              <button key={h.key} className={`search__hit ${i === at ? 'is-on' : ''}`} onMouseEnter={() => setAt(i)} onClick={() => pick(h)}>
                {agent ? <AgentAvatar agent={agent} size={18} /> : <Icon name={h.icon ?? 'hash'} size={15} />}
                <span className="grow">{h.label}</span>
                <span className="muted small">{h.detail}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ---------- the right-click menu ----------

export type MenuItem = { label: string; icon?: IconName; danger?: boolean; onClick: () => void } | 'separator'
export type MenuState = { x: number; y: number; items: MenuItem[] } | null

export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    // Keep it on screen.
    const r = ref.current?.getBoundingClientRect()
    setPos({ x: Math.min(menu.x, window.innerWidth - (r?.width ?? 220) - 8), y: Math.min(menu.y, window.innerHeight - (r?.height ?? 200) - 8) })
    const close = (): void => onClose()
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', esc)
    }
  }, [menu, onClose])
  if (!menu) return null
  return (
    <div ref={ref} className="menu" role="menu" style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y }} onMouseDown={(e) => e.stopPropagation()}>
      {menu.items.map((it, i) =>
        it === 'separator' ? (
          <div key={i} className="menu__sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu__item ${it.danger ? 'is-danger' : ''}`}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon && <Icon name={it.icon} size={14} />}
            {it.label}
          </button>
        )
      )}
    </div>
  )
}
