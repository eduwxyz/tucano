import { L } from '../../../shared/lang'
import { isWaiting, waitingIn, waitingTitle } from './waiting'
import { useCallback, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import {
  agentById,
  archiveAgent,
  openTuca,
  isTeam,
  deleteConversation,
  markRead,
  navigate,
  openDialog,
  openDm,
  pendingApprovals,
  pendingMemories,
  shortcut,
  updateSettings,
  useStore,
  type Agent,
  type View
} from '../store'
import { addGroup, arrange, moveChannel, nudgeChannel, removeGroup, renameGroup, type ChannelLayout } from '../../../shared/channel-layout'
import { call } from '../rpc'
import { ContextMenu, confirmDialog, type MenuItem, type MenuState } from './Dialogs'
import { FoldToggle, useFold } from './Fold'
import { GettingStarted } from './Onboarding'
import { UpdateNote } from './Update'
import { WorkspaceSelector } from './Workspaces'
import { AgentAvatar, Icon, TucaMark, useJustEnded, type IconName } from './ui'

// The wiki stays lit on any of its pages.
const same = (a: View | null, b: View): boolean => (b.kind === 'wiki' ? a?.kind === 'wiki' : JSON.stringify(a) === JSON.stringify(b))

function NavItem({ view, icon, label, badge }: { view: View; icon: IconName; label: string; badge?: number }): ReactNode {
  const active = useStore((s) => same(s.view, view))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate(view)}>
      <Icon name={icon} />
      <span className="nav-item__label">{label}</span>
      {badge ? (
        <span key={badge} className="badge">
          {badge}
        </span>
      ) : null}
    </button>
  )
}

// The Tuca is a screen, not one of the agents: here at the top, and behind the "+" for a new agent.
function TucaItem(): ReactNode {
  return (
    <button className="nav-item" onClick={openTuca} title={L('Monte um agente conversando com o Tuca', 'Build an agent by chatting with Tuca')}>
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
const useWaitingTitle = (conversationId: string): string =>
  useStore((s) => waitingTitle(waitingIn(s.messages, conversationId), (agentId) => agentById(s, agentId)?.name ?? L('Um agente', 'An agent')))

export function Sidebar(): ReactNode {
  const s = useStore((s) => s)
  const channels = s.conversations.filter((c) => c.kind === 'channel')
  const dms = s.conversations.filter((c) => c.kind === 'dm' && agentById(s, c.name)?.kind !== 'tuca')
  const pending = pendingApprovals(s).length
  const suggestions = pendingMemories(s).length
  const proposals = s.skills.filter((k) => k.state === 'pending').length
  const [menu, setMenu] = useState<MenuState>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const open = (e: React.MouseEvent, items: MenuItem[]): void => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  // The order and groups are the person's: the core only keeps them.
  const layout = s.settings.channelLayout
  const arranged = arrange(channels, layout)
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
  const channelMenu = (c: (typeof channels)[number]): MenuItem[] => [
    { label: L('Adicionar ou remover agentes…', 'Add or remove agents…'), icon: 'users', onClick: () => openDialog({ kind: 'members', id: c.id }) },
    { label: L('Configurações do canal…', 'Channel settings…'), icon: 'gear', onClick: () => openDialog({ kind: 'settings', id: c.id }) },
    ...(c.unread ? [{ label: L('Marcar como lido', 'Mark as read'), icon: 'check' as const, onClick: () => markRead(c.id) }] : []),
    wikiItem(c.id, c.wikiCapture !== false),
    'separator',
    { label: L('Mover para cima', 'Move up'), onClick: () => saveLayout(nudgeChannel(channels, layout, c.id, -1)) },
    { label: L('Mover para baixo', 'Move down'), onClick: () => saveLayout(nudgeChannel(channels, layout, c.id, 1)) },
    ...arranged.groups.filter((g) => !g.channels.includes(c)).map((g): MenuItem => ({ label: L(`Mover para ${g.name}`, `Move to ${g.name}`), onClick: () => saveLayout(moveChannel(channels, layout, c.id, { group: g.id })) })),
    ...(arranged.groups.some((g) => g.channels.includes(c)) ? [{ label: L('Tirar do grupo', 'Take out of the group'), onClick: () => saveLayout(moveChannel(channels, layout, c.id, {})) }] : []),
    { label: L('Novo grupo com este canal', 'New group with this channel'), icon: 'plus', onClick: () => newGroup(c.id) },
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
  const dmMenu = (id: string, agentId: string, agentName: string): MenuItem[] => [
    { label: L(`Ver ${agentName}`, `See ${agentName}`), icon: 'eye', onClick: () => navigate({ kind: 'agent', id: agentId }) },
    { label: L('Marcar como lido', 'Mark as read'), icon: 'check', onClick: () => markRead(id) },
    { label: L('Configurações da conversa…', 'Conversation settings…'), icon: 'gear', onClick: () => openDialog({ kind: 'settings', id }) },
    wikiItem(id, s.conversations.find((x) => x.id === id)?.wikiCapture !== false),
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
          if (ok) void deleteConversation(id)
        })
    }
  ]
  const agentMenu = (agentId: string, agentName: string): MenuItem[] => [
    { label: L('Mandar mensagem', 'Send a message'), icon: 'send', onClick: () => void openDm(agentId) },
    { label: L('Editar', 'Edit'), icon: 'edit', onClick: () => navigate({ kind: 'agent', id: agentId }) },
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

  const isDark =
    s.settings.theme === 'dark' || (s.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" />
      <div className="workspace">
        <WorkspaceSelector />
        <button
          className={`icon-btn ${s.settings.paused ? 'is-paused' : ''}`}
          title={s.settings.paused ? L('Retomar os agentes deste workspace', 'Resume agents in this workspace') : L('Pausar este workspace: nenhum agente começa a trabalhar e nenhuma rotina roda', 'Pause this workspace: no agent starts working and no routine runs')}
          onClick={() => updateSettings({ paused: !s.settings.paused })}
        >
          <Icon name={s.settings.paused ? 'play' : 'pause'} />
        </button>
        <button
          className="icon-btn"
          title={L('Trocar tema', 'Switch theme')}
          onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
        >
          <Icon name={isDark ? 'sun' : 'moon'} />
        </button>
      </div>

      {s.settings.paused && (
        <button className="paused-banner" onClick={() => updateSettings({ paused: false })}>
          <Icon name="pause" size={13} /> {L('Agentes pausados', 'Agents paused')} · <u>{L('retomar', 'resume')}</u>
        </button>
      )}
      <nav className="sidebar__scroll">
        <TucaItem />
        <NavItem view={{ kind: 'approvals' }} icon="shield" label={L('Aprovações', 'Approvals')} badge={pending} />
        <NavItem view={{ kind: 'memory' }} icon="book" label={L('Memória', 'Memory')} badge={suggestions} />
        <NavItem view={{ kind: 'wiki' }} icon="layers" label="Wiki" />
        <NavItem view={{ kind: 'routines' }} icon="clock" label={L('Rotinas', 'Routines')} />
        <NavItem view={{ kind: 'skills' }} icon="layers" label="Skills" badge={proposals} />
        <NavItem view={{ kind: 'report' }} icon="report" label={L('Boletim', 'Report')} />

        <Section
          id="channels"
          label={L('Canais', 'Channels')}
          unread={unreadIn(channels)}
          waiting={channels.some((c) => isWaiting(waitingIn(s.messages, c.id)))}
          action={
            <button className="icon-btn icon-btn--sm" title={L(`Novo canal (${shortcut(s.platform, 'N')})`, `New channel (${shortcut(s.platform, 'N')})`)} onClick={() => openDialog({ kind: 'new-channel' })}>
              <Icon name="plus" size={14} />
            </button>
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
              waiting={g.channels.some((c) => isWaiting(waitingIn(s.messages, c.id)))}
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

        {dms.length > 0 && (
        <Section id="dms" label={L('Mensagens diretas', 'Direct messages')} unread={unreadIn(dms)} waiting={dms.some((c) => isWaiting(waitingIn(s.messages, c.id)))}>
          {dms.map((c) => {
            const agent = agentById(s, c.name)
            if (!agent) return null
            return (
              <div key={c.id} onContextMenu={(e) => open(e, dmMenu(c.id, agent.id, agent.name))}>
                <DmItem id={c.id} agent={agent} unread={c.unread} />
              </div>
            )
          })}
        </Section>
        )}

        <Section
          id="agents"
          label={L('Agentes', 'Agents')}
          action={
            <button className="icon-btn icon-btn--sm" title={L('Novo agente: abre o Tuca', 'New agent: opens Tuca')} onClick={openTuca}>
              <Icon name="plus" size={14} />
            </button>
          }
        >
          {s.agents
            .filter(isTeam)
            .map((a) => (
              <div key={a.id} onContextMenu={(e) => open(e, agentMenu(a.id, a.name))}>
                <AgentItem id={a.id} />
              </div>
            ))}
          {s.agents.some((a) => a.archived) && (
            <button className="nav-item nav-item--quiet" onClick={() => openDialog({ kind: 'archived' })}>
              <Icon name="layers" />
              <span className="nav-item__label">{L('Arquivados', 'Archived')}</span>
              <span className="nav-item__meta">{s.agents.filter((a) => a.archived).length}</span>
            </button>
          )}
        </Section>
      </nav>

      {s.settings.onboarding?.done && !s.settings.onboarding.checklistHidden && <GettingStarted />}
      <ContextMenu menu={menu} onClose={closeMenu} />
      <div className="sidebar__foot">
        <UpdateNote />
        <NavItem view={{ kind: 'usage' }} icon="chart" label={L('Uso e limites', 'Usage and limits')} />
        <NavItem view={{ kind: 'connectors' }} icon="plug" label={L('Conectores', 'Connectors')} />
        <NavItem view={{ kind: 'settings' }} icon="gear" label={L('Configurações', 'Settings')} />
      </div>
    </aside>
  )
}

function ChannelItem({ id, name, unread }: { id: string; name: string; unread?: number }): ReactNode {
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
  const working = useStore((s) => s.messages.some((m) => m.conversationId === id && m.run?.status === 'working'))
  const waiting = useWaitingTitle(id)
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <Icon name="hash" />
      <span className="nav-item__label">{name}</span>
      {waiting ? <WaitingMark title={waiting} /> : <LiveDot working={working} />}
      {unread ? <span key={unread} className="badge badge--soft">{unread}</span> : null}
    </button>
  )
}

// Working: the dot pulses. Just finished: it turns green for a moment and fades out, instead of vanishing.
function LiveDot({ working }: { working: boolean }): ReactNode {
  const done = useJustEnded(working, 1500)
  if (!working && !done) return null
  return <span className={`pulse ${done ? 'is-done' : ''}`} title={working ? L('Trabalhando', 'Working') : undefined} />
}

function DmItem({ id, agent, unread }: { id: string; agent: Agent; unread?: number }): ReactNode {
  const name = agent.name
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
  const working = useStore((s) => s.messages.some((m) => m.conversationId === id && m.run?.status === 'working'))
  const waiting = useWaitingTitle(id)
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <AgentAvatar agent={agent} size={18} busy={working} />
      <span className="nav-item__label">{name}</span>
      {waiting ? <WaitingMark title={waiting} /> : <LiveDot working={working} />}
      {unread ? <span key={unread} className="badge badge--soft">{unread}</span> : null}
    </button>
  )
}

function AgentItem({ id }: { id: string }): ReactNode {
  const agent = useStore((s) => agentById(s, id))
  const active = useStore((s) => s.view?.kind === 'agent' && s.view.id === id)
  // The agent list is configuration: working shows on the thread (DM, channel),
  // never here — an agent busy in a channel would glow next to an idle DM.
  if (!agent) return null
  const pct = agent.limit > 0 ? agent.used / agent.limit : 1
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'agent', id })}>
      <AgentAvatar agent={agent} size={18} />
      <span className="nav-item__label">{agent.name}</span>
      <span className="nav-item__meta nav-item__role" title={agent.role}>{agent.role}</span>
      {agent.computer && agent.computerKind === 'mac' && (
        <span className="nav-item__mac" title={L('Roda no seu computador', 'Runs on your computer')}>
          <Icon name="laptop" size={13} />
        </span>
      )}
      {pct >= 0.8 && <span className={`dot ${pct >= 1 ? 'dot--danger' : 'dot--warn'}`} title={pct >= 1 ? L('Bateu o limite do mês', 'Hit the monthly limit') : L('Já usou mais de 80% do limite', 'Over 80% of the limit used')} />}
    </button>
  )
}
