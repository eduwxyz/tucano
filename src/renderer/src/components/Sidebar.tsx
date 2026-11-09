import { L } from '../../../shared/lang'
import { usedShare } from '../../../shared/limits'
import { headsOf, sectorName, sectorOf } from '../../../shared/org'
import { isWaiting, mineIn, waitingIn, waitingTitle, type Waiting } from './waiting'
import { memo, useCallback, useId, useMemo, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import {
  agentById,
  archiveAgent,
  isWorking,
  messagesIn,
  openTuca,
  isTeam,
  deleteConversation,
  clearHistory,
  markRead,
  navigate,
  openDialog,
  setTab,
  openDm,
  pendingApprovals,
  shortcut,
  updateSettings,
  useStore,
  amAdmin,
  amOwner,
  canEditChannel,
  inboxCount,
  initials,
  personById,
  roleLabel,
  teamMode,
  youPerson,
  type Agent,
  type Conversation,
  type Message,
  type State,
  type View
} from '../store'
import type { SidebarPart } from '../../../shared/onboarding'
import { addGroup, arrange, moveChannel, nudgeChannel, removeGroup, renameGroup, type ChannelLayout } from '../../../shared/channel-layout'
import { call } from '../rpc'
import { SurveyLine } from './Feedback'
import { ContextMenu, confirmDialog, type MenuItem, type MenuState } from './Dialogs'
import { FoldToggle, useFold } from './Fold'
import { MissionsCard, useSidebarParts } from './Missions'
import { UpdateNote } from './Update'
import { SidebarFoot, WorkspaceMenu } from './Workspaces'
import { Glyph, hubOf, hubTab, hubTitle, openHub, useHubTabs, type HubId } from './Hubs'
import { AgentAvatar, Icon, MeAvatar, TucaMark, useJustEnded, type IconName } from './ui'
import { setHidden, topLabel, useAvailable, useHidden, useWaitingIn, type TopItem } from './sidebar-top'

// The wiki stays lit on any of its pages.
const same = (a: View | null, b: View): boolean => (b.kind === 'wiki' ? a?.kind === 'wiki' : JSON.stringify(a) === JSON.stringify(b))

// `fresh`: a mission just brought it (a new install's short sidebar): tagged until it's opened.
function NavItem({ view, icon, label, badge, fresh }: { view: View; icon: IconName; label: string; badge?: number; fresh?: () => void }): ReactNode {
  const active = useStore((s) => same(s.view, view))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${fresh ? 'is-fresh' : ''}`} onClick={() => (fresh?.(), navigate(view))}>
      <Icon name={icon} />
      <span className="nav-item__label">{label}</span>
      {badge ? (
        <span key={badge} className="badge">
          {badge}
        </span>
      ) : fresh ? (
        <span className="nav-item__new">{L('NOVO', 'NEW')}</span>
      ) : null}
    </button>
  )
}

// The Tuca is a screen, not one of the agents: here at the top, and behind the "+" for a new agent.
function TucaItem(): ReactNode {
  return (
    <button className="nav-item" data-coach="tuca" onClick={openTuca} title={L('Monte um agente conversando com o Tuca', 'Build an agent by chatting with Tuca')}>
      <TucaMark size={18} />
      <span className="nav-item__label">Tuca</span>
      <span className="nav-item__meta">{L('te ajuda', 'helps you')}</span>
    </button>
  )
}

function Section({ id, label, unread = 0, waiting, action, children }: { id: string; label: string; unread?: number; waiting?: boolean; action?: ReactNode; children: ReactNode }): ReactNode {
  const { open, toggle } = useFold(`section:${id}`)
  return (
    <div className={`section ${open ? '' : 'is-folded'}`}>
      <div className="section__head">
        <FoldToggle open={open} onToggle={toggle}>
          {label}
        </FoldToggle>
        {/* A closed section still says when something in it is waiting. */}
        {!open && waiting && <WaitingMark title={L('Um agente está esperando você aqui', 'An agent is waiting for you in here')} />}
        {!open && unread > 0 && (
          <span key={unread} className="badge badge--soft">
            {unread}
          </span>
        )}
        {action}
      </div>
      {children}
    </div>
  )
}

// A group folds like the sections, in the same list (Fold.tsx), and keeps showing the channel you're in.
function GroupFold({ id, label, unread, waiting, head, naming, children }: { id: string; label: string; unread: number; waiting?: boolean; head: HTMLAttributes<HTMLDivElement>; naming?: ReactNode; children: ReactNode }): ReactNode {
  const { open, toggle } = useFold(`group:${id}`)
  return (
    <div className={`channel-group ${open ? '' : 'is-folded'}`}>
      {naming || (
        <div className="channel-group__head" {...head}>
          <FoldToggle open={open} onToggle={toggle}>
            {label}
          </FoldToggle>
          {!open && waiting && <WaitingMark title={L('Um agente está esperando você aqui', 'An agent is waiting for you in here')} />}
          {!open && unread > 0 && <span className="badge badge--soft">{unread}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

const unreadIn = (conversations: { unread?: number }[]): number => conversations.reduce((sum, c) => sum + (c.unread ?? 0), 0)

// An agent waits on me there (a question, an approval): it shows instead of the working dot, since it's my turn.
// A solid speech bubble with the "?" cut out of it, so it reads on any row (hovered, active).
function WaitingMark({ title }: { title: string }): ReactNode {
  const mask = `waiting-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <span className="waiting-mark" title={title} aria-label={title}>
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <mask id={mask}>
          <rect width="24" height="24" fill="white" />
          <path d="M9.6 9.2a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.7" fill="none" stroke="black" strokeWidth="2.1" strokeLinecap="round" />
          <circle cx="12" cy="16.3" r="1.2" fill="black" />
        </mask>
        <path mask={`url(#${mask})`} fill="currentColor" d="M12 2.5c5.5 0 9.5 3.9 9.5 8.8s-4 8.8-9.5 8.8c-1.2 0-2.4-.2-3.5-.5L3.5 21.5l1.4-4.3C3.4 15.7 2.5 13.6 2.5 11.3 2.5 6.4 6.5 2.5 12 2.5Z" />
      </svg>
    </span>
  )
}

// Who waits on me in a conversation, as the hint says it: a string, so the sidebar redraws only when it changes.
// With a team, only what waits on me (my inbox), not a question to someone else or an approval for them.
const waitsIn = (s: State, conversationId: string): Waiting => waitingIn(messagesIn(s, conversationId), conversationId, teamMode(s) ? { key: s.inbox, test: mineIn(s.inbox) } : undefined)
const anyWaiting = (s: State, ids: string[]): boolean => ids.some((id) => isWaiting(waitsIn(s, id)))
const useWaitingTitle = (conversationId: string | undefined): string =>
  useStore((s) => (conversationId ? waitingTitle(waitsIn(s, conversationId), (agentId) => agentById(s, agentId)?.name ?? L('Um agente', 'An agent')) : ''))

// How many things wait on me in a conversation (questions and approvals), read once per change of its messages.
const counted = new WeakMap<Message[], { mine: unknown; n: number }>()
function waitingCount(s: State, conversationId: string): number {
  const list = messagesIn(s, conversationId)
  const mine = teamMode(s) ? s.inbox : undefined
  const had = counted.get(list)
  if (had && had.mine === mine) return had.n
  const test = mine ? mineIn(mine) : undefined
  const n = list.filter((m) => m.author.kind === 'agent' && (m.run?.status === 'waiting_input' || m.run?.status === 'waiting_approval') && (!test || test(m))).length
  counted.set(list, { mine, n })
  return n
}
const waitingTotal = (s: State, ids: string[]): number => ids.reduce((n, id) => n + (id ? waitingCount(s, id) : 0), 0)

// A hub's row: Conhecimento or Operação. It shows while one of its tabs does, lit on any of them,
// with what waits inside it, and opens where the person left it.
function HubNavItem({ hub, icon }: { hub: HubId; icon: 'knowledge' | 'operations' }): ReactNode {
  const tabs = useHubTabs(hub)
  const active = useStore((s) => hubOf(hubTab(s.view)) === hub)
  if (!tabs.length) return null
  const badge = tabs.reduce((n, t) => n + t.badge, 0)
  const fresh = tabs.some((t) => t.fresh) && !active
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${fresh ? 'is-fresh' : ''}`} data-hub={hub} onClick={() => openHub(hub, tabs)}>
      <Glyph name={icon} />
      <span className="nav-item__label">{hubTitle(hub)}</span>
      {badge ? (
        <span key={badge} className="badge">
          {badge}
        </span>
      ) : fresh ? (
        <span className="nav-item__new">{L('NOVO', 'NEW')}</span>
      ) : null}
    </button>
  )
}

// One item at the top of the sidebar, with what it can do besides opening: a right click or its "•••"
// opens a menu that takes it out of the sidebar (sidebar-top.ts). `back`: Aprovações, taken out, back
// while something waits on the person, with a line that says so.
function TopRow({ item, back, onMenu, children }: { item: TopItem; back?: boolean; onMenu: (at: { x: number; y: number }, items: MenuItem[]) => void; children: ReactNode }): ReactNode {
  const row = useRef<HTMLDivElement>(null)
  const team = useStore(teamMode)
  const items = (): MenuItem[] => [
    { label: L('Abrir', 'Open'), icon: 'expand', onClick: () => row.current?.querySelector<HTMLButtonElement>('.nav-item')?.click() },
    { label: L('Tirar da barra', 'Take out of the sidebar'), icon: 'hide', onClick: () => setHidden(item, true) }
  ]
  return (
    <div
      ref={row}
      className={`top-row ${back ? 'is-back' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu({ x: e.clientX, y: e.clientY }, items())
      }}
    >
      {children}
      {!back && (
        <button
          type="button"
          className="icon-btn icon-btn--sm top-row__more"
          title={L(`Mais opções: ${topLabel(item, team)}`, `More options: ${topLabel(item, team)}`)}
          aria-label={L(`Mais opções: ${topLabel(item, team)}`, `More options: ${topLabel(item, team)}`)}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            onMenu({ x: r.left, y: r.bottom + 4 }, items())
          }}
        >
          <Icon name="more" size={14} />
        </button>
      )}
      {back && <p className="top-row__back">{L('Você tinha tirado da barra. Some de novo quando nada esperar por você.', 'You took it out of the sidebar. It goes again once nothing waits on you.')}</p>}
    </div>
  )
}

// Under the top items, what the person took out of them: one quiet line ("2 escondidos") that opens
// to those items, dimmed, each going back to its place on a click. Where they were, not in a menu.
function Tucked({ items }: { items: TopItem[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const team = useStore(teamMode)
  const glyph = (i: TopItem): ReactNode =>
    i === 'tuca' ? <TucaMark size={18} /> : i === 'approvals' ? <Icon name="shield" /> : i === 'board' ? <Icon name="board" /> : <Glyph name={i} />
  return (
    <div className={`tucked ${open ? 'is-open' : ''}`}>
      <button type="button" className="tucked__toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" size={11} />
        {items.length === 1 ? L('1 escondido', '1 hidden') : L(`${items.length} escondidos`, `${items.length} hidden`)}
      </button>
      {open &&
        items.map((i) => (
          <button key={i} type="button" className="nav-item tucked__item" title={L('Voltar pra barra', 'Put it back in the sidebar')} onClick={() => setHidden(i, false)}>
            {glyph(i)}
            <span className="nav-item__label">{topLabel(i, team)}</span>
            <span className="tucked__back">{L('voltar', 'put back')}</span>
          </button>
        ))}
    </div>
  )
}

// The agents grouped by sector (src/shared/org.ts), each head first; those in no sector last. No sectors: no groups.
interface AgentGroup {
  id: string
  name: string
  agents: Agent[]
}
function groupAgents(agents: Agent[]): AgentGroup[] | null {
  const heads = headsOf(agents)
  if (!heads.length) return null
  const team = agents.filter(isTeam)
  const of = new Map(team.map((a) => [a.id, sectorOf(agents, a.id)?.id]))
  const groups: AgentGroup[] = heads.map((h) => ({ id: h.id, name: sectorName(h, L('Setor de', 'Sector of')), agents: [h, ...team.filter((a) => a.id !== h.id && of.get(a.id) === h.id)] }))
  const loose = team.filter((a) => !of.get(a.id))
  if (loose.length) groups.push({ id: 'none', name: L('Sem setor', 'No sector'), agents: loose })
  return groups
}

export function Sidebar(): ReactNode {
  // Only what it draws: the whole state changes with every step an agent takes.
  const conversations = useStore((s) => s.conversations)
  const agents = useStore((s) => s.agents)
  const settings = useStore((s) => s.settings)
  const platform = useStore((s) => s.platform)
  const people = useStore((s) => s.people)
  const you = useStore((s) => s.you)
  // With a team: who I am, what waits on me, and only what my role may change.
  const team = teamMode({ people })
  const admin = amAdmin({ people, you })
  const owner = amOwner({ people, you })
  const me = youPerson({ people, you })
  // A new install's sidebar starts short and grows with the missions (Missions.tsx).
  const parts = useSidebarParts()
  const fresh = (p: SidebarPart): (() => void) | undefined => (parts.fresh(p) ? () => parts.seen(p) : undefined)
  const pending = useStore((s) => (teamMode(s) ? inboxCount(s) : pendingApprovals(s).length))
  const agentOf = (id: string): Agent | undefined => agents.find((a) => a.id === id)
  const channels = conversations.filter((c) => c.kind === 'channel')
  const dms = conversations.filter((c) => c.kind === 'dm' && agentOf(c.name)?.kind !== 'tuca')
  // Each agent's DM with me: what its row opens, and where its unread, working and waiting come from.
  const dmOf = new Map<string, Conversation>()
  for (const c of dms) if (!dmOf.has(c.name) || c.owner === you) dmOf.set(c.name, c)
  const teamAgents = agents.filter(isTeam)
  // An archived agent leaves the list, but a DM with it stays reachable, quietly, at the end.
  const archivedWithDm = agents.filter((a) => a.archived && a.kind !== 'tuca' && dmOf.has(a.id))
  const groups = useMemo(() => groupAgents(agents), [agents])
  const [menu, setMenu] = useState<MenuState>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const menuAt = useCallback((at: { x: number; y: number }, items: MenuItem[]) => setMenu({ ...at, items }), [])
  // The top of the sidebar: what this one has, less what the person took out (Aprovações back while something waits).
  const hidden = useHidden()
  const available = useAvailable()
  const waitingIn = useWaitingIn()
  const shows = (i: TopItem): boolean => available.includes(i) && !hidden.includes(i)
  // Taken out, but something waits on the person in it: back, marked, until nothing does.
  const back = (i: TopItem): boolean => available.includes(i) && hidden.includes(i) && (waitingIn[i] ?? 0) > 0
  const tucked = available.filter((i) => hidden.includes(i) && !back(i))
  const open = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  // The order and groups are the person's: the core only keeps them.
  const layout = settings.channelLayout
  const arranged = arrange(channels, layout)
  // Folded, a section or group still says an agent waits on me in it: values, so only a change redraws.
  const channelsWaiting = useStore((s) => anyWaiting(s, channels.map((c) => c.id)))
  const waitingGroups = useStore((s) => arranged.groups.filter((g) => anyWaiting(s, g.channels.map((c) => c.id))).map((g) => g.id).join(' ')).split(' ')
  const dmsWaiting = useStore((s) => anyWaiting(s, dms.map((c) => c.id)))
  const whole: ChannelLayout = { loose: arranged.loose.map((c) => c.id), groups: arranged.groups.map((g) => ({ ...g, channels: g.channels.map((c) => c.id) })) }
  const saveLayout = (next: ChannelLayout): void => updateSettings({ channelLayout: next })
  const [naming, setNaming] = useState<string | null>(null)
  const newGroup = (channelId: string): void => {
    const id = crypto.randomUUID()
    saveLayout(moveChannel(channels, addGroup(layout, { id, name: L('Novo grupo', 'New group') }), channelId, { group: id }))
    setNaming(id)
  }
  const dragged = useRef<string | null>(null)
  const accept = (e: React.DragEvent): void => {
    if (dragged.current) e.preventDefault()
  }
  const dropOn = (to: { group?: string; before?: string }) => ({
    onDragEnter: accept,
    onDragOver: accept,
    onDrop: (e: React.DragEvent): void => {
      const id = dragged.current
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      dragged.current = null
      saveLayout(moveChannel(channels, layout, id, to))
    }
  })
  const channelRow = (c: (typeof channels)[number], group?: string): ReactNode => (
    <div
      key={c.id}
      draggable
      onDragStart={(e) => {
        dragged.current = c.id
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', c.name)
      }}
      onDragEnd={() => (dragged.current = null)}
      onContextMenu={(e) => open(e, channelMenu(c))}
      {...dropOn({ group, before: c.id })}
    >
      <ChannelItem id={c.id} name={c.name} unread={c.unread} />
    </div>
  )
  // The wiki's curator reads every conversation; one can be kept out (a personal DM, say).
  const wikiItem = (id: string, on: boolean): MenuItem => ({
    label: on ? L('Não guardar na wiki', "Don't keep in the wiki") : L('Voltar a guardar na wiki', 'Keep in the wiki again'),
    icon: 'layers',
    onClick: () => void call('setWikiCapture', { conversationId: id, on: !on })
  })
  // The history out of sight, the conversation kept: same DM, same channel, same place in the list.
  const clearItem = (id: string, what: string, whatEn: string): MenuItem => ({
    label: L('Limpar o histórico…', 'Clear the history…'),
    icon: 'spark',
    onClick: () =>
      void confirmDialog({
        title: L(`Limpar o histórico ${what}?`, `Clear the history of ${whatEn}?`),
        body: L(
          'Some da tela e do que o agente lê, e ele começa do zero na próxima mensagem. As mensagens continuam guardadas: os recibos, os custos e as aprovações que apontam pra elas ficam como estão. Não dá pra desfazer pela tela.',
          'It leaves the screen and what the agent reads, and it starts from nothing on the next message. The messages stay stored: the receipts, the costs and the approvals that point at them are kept as they are. It cannot be undone from the screen.'
        ),
        confirm: L('Limpar o histórico', 'Clear the history')
      }).then((ok) => {
        if (ok) void clearHistory(id)
      })
  })
  const channelMenu = (c: (typeof channels)[number]): MenuItem[] => [
    ...(canEditChannel({ people, you }, c) ? [{ label: L('Adicionar ou remover agentes…', 'Add or remove agents…'), icon: 'users' as const, onClick: () => openDialog({ kind: 'members', id: c.id }) }] : []),
    { label: L('Configurações do canal…', 'Channel settings…'), icon: 'gear', onClick: () => openDialog({ kind: 'settings', id: c.id }) },
    ...(c.unread ? [{ label: L('Marcar como lido', 'Mark as read'), icon: 'check' as const, onClick: () => markRead(c.id) }] : []),
    ...(canEditChannel({ people, you }, c) ? [wikiItem(c.id, c.wikiCapture !== false)] : []),
    ...channelMenuRest(c)
  ]
  const channelMenuRest = (c: (typeof channels)[number]): MenuItem[] => [
    'separator',
    { label: L('Mover para cima', 'Move up'), onClick: () => saveLayout(nudgeChannel(channels, layout, c.id, -1)) },
    { label: L('Mover para baixo', 'Move down'), onClick: () => saveLayout(nudgeChannel(channels, layout, c.id, 1)) },
    ...arranged.groups.filter((g) => !g.channels.includes(c)).map((g): MenuItem => ({ label: L(`Mover para ${g.name}`, `Move to ${g.name}`), onClick: () => saveLayout(moveChannel(channels, layout, c.id, { group: g.id })) })),
    ...(arranged.groups.some((g) => g.channels.includes(c)) ? [{ label: L('Tirar do grupo', 'Take out of the group'), onClick: () => saveLayout(moveChannel(channels, layout, c.id, {})) }] : []),
    { label: L('Novo grupo com este canal', 'New group with this channel'), icon: 'plus', onClick: () => newGroup(c.id) },
    ...(admin ? channelDelete(c) : [])
  ]
  const channelDelete = (c: (typeof channels)[number]): MenuItem[] => [
    clearItem(c.id, `do canal #${c.name}`, `#${c.name}`),
    'separator',
    {
      label: L('Excluir canal…', 'Delete channel…'),
      icon: 'trash',
      danger: true,
      onClick: () =>
        void confirmDialog({
          title: L(`Excluir #${c.name}?`, `Delete #${c.name}?`),
          body: L('As mensagens e as rotinas que postam nele vão junto. Os agentes continuam no time. Não dá pra desfazer.', "Its messages and the routines that post in it go too. The agents stay on the team. This can't be undone."),
          confirm: L(`Excluir #${c.name}`, `Delete #${c.name}`),
          danger: true
        }).then((ok) => {
          if (ok) void deleteConversation(c.id)
        })
    }
  ]
  // One menu for an agent's row: what the DM's menu had and what the agent's had.
  const agentMenu = (agent: Agent, dm: Conversation | undefined): MenuItem[] => [
    { label: L('Mandar mensagem', 'Send a message'), icon: 'send', onClick: () => void openDm(agent.id) },
    admin && !agent.archived
      ? { label: L('Editar', 'Edit'), icon: 'edit', onClick: () => navigate({ kind: 'agent', id: agent.id }) }
      : { label: L(`Ver ${agent.name}`, `See ${agent.name}`), icon: 'eye', onClick: () => navigate({ kind: 'agent', id: agent.id }) },
    ...(dm ? dmMenu(dm, agent.name) : []),
    ...(admin && !agent.archived ? agentArchive(agent.id, agent.name) : [])
  ]
  const dmMenu = (dm: Conversation, agentName: string): MenuItem[] => [
    { label: L('Marcar como lido', 'Mark as read'), icon: 'check', onClick: () => markRead(dm.id) },
    { label: L('Configurações da conversa…', 'Conversation settings…'), icon: 'gear', onClick: () => openDialog({ kind: 'settings', id: dm.id }) },
    wikiItem(dm.id, dm.wikiCapture !== false),
    clearItem(dm.id, `da conversa com ${agentName}`, `the conversation with ${agentName}`),
    'separator',
    {
      label: L('Apagar a conversa…', 'Delete the conversation…'),
      icon: 'trash',
      danger: true,
      onClick: () =>
        void confirmDialog({
          title: L(`Apagar a conversa com ${agentName}?`, `Delete the conversation with ${agentName}?`),
          body: L(`As mensagens e as rotinas desta DM vão junto. ${agentName} continua no time. Não dá pra desfazer.`, `The messages and routines of this DM go too. ${agentName} stays on the team. This can't be undone.`),
          confirm: L('Apagar a conversa', 'Delete the conversation'),
          danger: true
        }).then((ok) => {
          if (ok) void deleteConversation(dm.id)
        })
    }
  ]
  const agentArchive = (agentId: string, agentName: string): MenuItem[] => [
    'separator',
    {
      label: L('Arquivar…', 'Archive…'),
      icon: 'archive',
      onClick: () =>
        void confirmDialog({
          title: L(`Arquivar ${agentName}?`, `Archive ${agentName}?`),
          body: L('Sai da barra lateral e para de responder; as rotinas dele desligam. O histórico e os recibos ficam, e dá pra reativar em "Arquivados", no fim da lista de agentes.', 'It leaves the sidebar and stops replying; its routines turn off. History and receipts stay, and you can reactivate it from "Archived", at the end of the agent list.'),
          confirm: L(`Arquivar ${agentName}`, `Archive ${agentName}`)
        }).then((ok) => {
          if (ok) void archiveAgent(agentId, true)
        })
    }
  ]
  const agentRow = (a: Agent): ReactNode => {
    const dm = dmOf.get(a.id)
    return (
      <div key={a.id} className={`agent-row ${a.archived ? 'is-archived' : ''}`} onContextMenu={(e) => open(e, agentMenu(a, dm))}>
        <AgentRow id={a.id} dm={dm?.id} unread={dm?.unread} owner={team && a.owner !== you ? personById({ people }, a.owner)?.name : undefined} />
      </div>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" />
      <div className="workspace">
        <WorkspaceMenu />
      </div>

      {team && me && (
        <button className="me-row" title={L('Seu nome e quem te cobre: Configurações › Pessoas', 'Your name and who covers for you: Settings › People')} onClick={() => (setTab('settings', 'pessoas'), navigate({ kind: 'settings' }))}>
          <MeAvatar initials={initials(me.name)} size={24} />
          <span className="me-row__who">
            <strong>{me.name}</strong>
            <span>{roleLabel(me.role)}</span>
          </span>
        </button>
      )}
      {settings.paused && (
        <button className="paused-banner" disabled={!admin} onClick={() => updateSettings({ paused: false })}>
          <Icon name="pause" size={13} /> {L('Agentes pausados', 'Agents paused')}{admin && <> · <u>{L('retomar', 'resume')}</u></>}
        </button>
      )}
      <nav className="sidebar__scroll">
        {shows('tuca') && (
          <TopRow item="tuca" onMenu={menuAt}>
            <TucaItem />
          </TopRow>
        )}
        {(shows('approvals') || back('approvals')) && (
          <TopRow item="approvals" back={back('approvals')} onMenu={menuAt}>
            <NavItem view={{ kind: 'approvals' }} icon="shield" label={topLabel('approvals', team)} badge={pending} />
          </TopRow>
        )}
        {shows('board') && (
          <TopRow item="board" onMenu={menuAt}>
            <NavItem view={{ kind: 'board' }} icon="board" label={topLabel('board', team)} fresh={fresh('board')} />
          </TopRow>
        )}
        {(shows('knowledge') || back('knowledge')) && (
          <TopRow item="knowledge" back={back('knowledge')} onMenu={menuAt}>
            <HubNavItem hub="knowledge" icon="knowledge" />
          </TopRow>
        )}
        {shows('operations') && (
          <TopRow item="operations" onMenu={menuAt}>
            <HubNavItem hub="operations" icon="operations" />
          </TopRow>
        )}
        {tucked.length > 0 && <Tucked items={tucked} />}

        <Section
          id="channels"
          label={L('Canais', 'Channels')}
          unread={unreadIn(channels)}
          waiting={channelsWaiting}
          action={
            parts.shows('channels') ? (
              <button className="icon-btn icon-btn--sm" title={L(`Novo canal (${shortcut(platform, 'N')})`, `New channel (${shortcut(platform, 'N')})`)} onClick={() => (parts.seen('channels'), openDialog({ kind: 'new-channel' }))}>
                <Icon name="plus" size={14} />
              </button>
            ) : undefined
          }
        >
          {arranged.loose.map((c) => channelRow(c))}
          {/* Dropped here, a channel goes last among those in no group. */}
          <div className="channel-drop" {...dropOn({})} />
          {arranged.groups.map((g) => (
            <GroupFold
              key={g.id}
              id={g.id}
              label={g.name}
              unread={g.channels.reduce((n, c) => n + (c.unread ?? 0), 0)}
              waiting={waitingGroups.includes(g.id)}
              head={{
                ...dropOn({ group: g.id }),
                onContextMenu: (e) =>
                  open(e, [
                    { label: L('Renomear', 'Rename'), icon: 'edit', onClick: () => setNaming(g.id) },
                    { label: L('Desfazer o grupo', 'Ungroup'), icon: 'trash', onClick: () => saveLayout(removeGroup(whole, g.id)) }
                  ])
              }}
              naming={
                naming === g.id && (
                  <input
                    className="channel-group__name"
                    autoFocus
                    defaultValue={g.name}
                    aria-label={L('Nome do grupo', 'Group name')}
                    onFocus={(e) => e.target.select()}
                    onBlur={(e) => {
                      saveLayout(renameGroup(whole, g.id, e.target.value.trim() || g.name))
                      setNaming(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') e.currentTarget.value = g.name
                      if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur()
                    }}
                  />
                )
              }
            >
              {g.channels.map((c) => channelRow(c, g.id))}
            </GroupFold>
          ))}
        </Section>

        {/* One list: an agent's row opens its DM; its page is behind the gear (or the right click). */}
        <Section
          id="agents"
          label={L('Agentes', 'Agents')}
          unread={unreadIn([...dmOf.values()])}
          waiting={dmsWaiting}
          action={
            <span className="section__actions">
              {teamAgents.length > 1 && (
                <button className="icon-btn icon-btn--sm" title={L('Organograma: quem responde a quem', 'Org chart: who answers to whom')} aria-label={L('Organograma', 'Org chart')} onClick={() => navigate({ kind: 'org' })}>
                  <Glyph name="org" size={14} />
                </button>
              )}
              {admin && (
                <button className="icon-btn icon-btn--sm" title={L('Novo agente: abre o Tuca', 'New agent: opens Tuca')} onClick={openTuca}>
                  <Icon name="plus" size={14} />
                </button>
              )}
            </span>
          }
        >
          {groups
            ? groups.map((g) => (
                <SectorGroup key={g.id} id={g.id} label={g.name} count={g.agents.length} unread={unreadIn(g.agents.map((a) => dmOf.get(a.id) ?? {}))} dms={g.agents.map((a) => dmOf.get(a.id)?.id ?? '').join(' ')}>
                  {g.agents.map(agentRow)}
                </SectorGroup>
              ))
            : teamAgents.map(agentRow)}
          {archivedWithDm.map(agentRow)}
          {agents.some((a) => a.archived) && (
            <button className="nav-item nav-item--quiet" onClick={() => openDialog({ kind: 'archived' })}>
              <Icon name="layers" />
              <span className="nav-item__label">{L('Arquivados', 'Archived')}</span>
              <span className="nav-item__meta">{agents.filter((a) => a.archived).length}</span>
            </button>
          )}
        </Section>
      </nav>

      {/* The missions set the Tucano up and walk through it: the owner's. */}
      {owner && settings.onboarding?.done && !settings.onboarding.checklistHidden && <MissionsCard />}
      <ContextMenu menu={menu} onClose={closeMenu} />
      <SurveyLine />
      <div className="sidebar__foot">
        <UpdateNote />
        <SidebarFoot />
      </div>
    </aside>
  )
}

// A sector folds like a channel group (Fold.tsx). Folded, it still says how many agents it has, how
// many messages are new in it and how many things wait on me there. `dms`: its DMs' ids, as a string.
function SectorGroup({ id, label, count, unread, dms, children }: { id: string; label: string; count: number; unread: number; dms: string; children: ReactNode }): ReactNode {
  const { open, toggle } = useFold(`sector:${id}`)
  const waiting = useStore((s) => waitingTotal(s, dms.split(' ')))
  return (
    <div className={`agent-sector ${open ? '' : 'is-folded'}`}>
      <div className="agent-sector__head">
        <FoldToggle open={open} onToggle={toggle}>
          {label}
        </FoldToggle>
        {!open && <span className="agent-sector__count">{count}</span>}
        {!open && waiting > 0 && <WaitingPill count={waiting} title={L('Um agente está esperando você aqui', 'An agent is waiting for you in here')} />}
        {!open && unread > 0 && (
          <span key={unread} className="badge badge--soft">
            {unread}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

// What waits on me (an approval, an answer): a shield and how many.
function WaitingPill({ count, title }: { count: number; title: string }): ReactNode {
  return (
    <span className="waiting-pill" title={title} aria-label={title}>
      <Icon name="shield" size={11} />
      {count}
    </span>
  )
}

const ChannelItem = memo(function ChannelItem({ id, name, unread }: { id: string; name: string; unread?: number }): ReactNode {
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
  const working = useStore((s) => isWorking(s, id))
  const waiting = useWaitingTitle(id)
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <Icon name="hash" />
      <span className="nav-item__label">{name}</span>
      {waiting ? <WaitingMark title={waiting} /> : <LiveDot working={working} />}
      {unread ? <span key={unread} className="badge badge--soft">{unread}</span> : null}
    </button>
  )
})

// Working: the dot pulses. Just finished: it turns green for a moment and fades out, instead of vanishing.
function LiveDot({ working }: { working: boolean }): ReactNode {
  const done = useJustEnded(working, 1500)
  if (!working && !done) return null
  return <span className={`pulse ${done ? 'is-done' : ''}`} title={working ? L('Trabalhando', 'Working') : undefined} />
}

// The same on an agent's row, as three dots: the agent is writing in its DM.
function WorkingDots({ working }: { working: boolean }): ReactNode {
  const done = useJustEnded(working, 1500)
  if (!working && !done) return null
  return (
    <span className={`working-dots ${done ? 'is-done' : ''}`} title={working ? L('Trabalhando', 'Working') : undefined}>
      <i />
      <i />
      <i />
    </span>
  )
}

// The agent's role, in grey after its name (cut with an ellipsis, in full on hover). With a team and
// someone else's agent, the hover says whose it is.
function RoleMeta({ role, owner }: { role: string; owner?: string }): ReactNode {
  return <span className="nav-item__meta nav-item__role" title={owner ? L(`${role ? `${role} · ` : ''}de ${owner}`, `${role ? `${role} · ` : ''}${owner}'s`) : role}>{role}</span>
}

// An agent's row: it opens its DM (made the first time), and is lit there and on the agent's page.
// Unread makes the name bold with a count; working shows three dots; waiting on me, a shield with how
// many. The role and the gear (the agent's page) show on hover or focus. `owner`: with a team, whose
// agent it is (its approvals go to them), when it isn't mine.
const AgentRow = memo(function AgentRow({ id, dm, unread, owner }: { id: string; dm?: string; unread?: number; owner?: string }): ReactNode {
  const agent = useStore((s) => agentById(s, id))
  const active = useStore((s) => (s.view?.kind === 'conversation' && !!dm && s.view.id === dm) || (s.view?.kind === 'agent' && s.view.id === id))
  const working = useStore((s) => !!dm && isWorking(s, dm))
  const waiting = useWaitingTitle(dm)
  const waits = useStore((s) => (dm ? waitingCount(s, dm) : 0))
  if (!agent) return null
  // No monthly limit, no dot: undefined share, so nothing here can read as spent.
  const pct = usedShare(agent.used, agent.limit)
  const settingsLabel = L(`Ajustes de ${agent.name}`, `${agent.name}'s settings`)
  return (
    <>
      <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => (dm ? navigate({ kind: 'conversation', id: dm }) : void openDm(id))}>
        <AgentAvatar agent={agent} size={18} busy={working} />
        <span className="nav-item__label">{agent.name}</span>
        <RoleMeta role={agent.role} owner={owner} />
        {agent.computer && agent.computerKind === 'mac' && (
          <span className="nav-item__mac" title={L('Roda no seu computador', 'Runs on your computer')}>
            <Icon name="laptop" size={12} />
          </span>
        )}
        {pct !== undefined && pct >= 0.8 && <span className={`dot ${pct >= 1 ? 'dot--danger' : 'dot--warn'}`} title={pct >= 1 ? L('Bateu o limite do mês', 'Hit the monthly limit') : L('Já usou mais de 80% do limite', 'Over 80% of the limit used')} />}
        {waits > 0 ? <WaitingPill count={waits} title={waiting} /> : <WorkingDots working={working} />}
        {unread ? (
          <span key={unread} className="badge badge--soft">
            {unread}
          </span>
        ) : null}
      </button>
      <button className="icon-btn icon-btn--sm agent-row__gear" title={settingsLabel} aria-label={settingsLabel} onClick={() => navigate({ kind: 'agent', id })}>
        <Glyph name="sliders" size={14} />
      </button>
    </>
  )
})
