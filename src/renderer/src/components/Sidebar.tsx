import { L } from '../../../shared/lang'
import { useCallback, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
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
import { ContextMenu, type MenuItem, type MenuState } from './Dialogs'
import { FoldToggle, useFold } from './Fold'
import { GettingStarted } from './Onboarding'
import { UpdateNote } from './Update'
import { AgentAvatar, Icon, TucaMark, type IconName } from './ui'

// The wiki stays lit on any of its pages.
const same = (a: View | null, b: View): boolean => (b.kind === 'wiki' ? a?.kind === 'wiki' : JSON.stringify(a) === JSON.stringify(b))

function NavItem({ view, icon, label, badge }: { view: View; icon: IconName; label: string; badge?: number }): ReactNode {
  const active = useStore((s) => same(s.view, view))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate(view)}>
      <Icon name={icon} />
      <span className="nav-item__label">{label}</span>
      {badge ? <span className="badge">{badge}</span> : null}
    </button>
  )
}

// The Tuca is a screen, not one of the agents: here at the top, and behind the "+" for a new agent.
function TucaItem(): ReactNode {
  return (
    <button className="nav-item" onClick={openTuca} title={L('Monte um agente conversando com o Tuca', 'Build an agent by chatting with Tuca')}>
      <TucaMark size={18} />
      <span className="nav-item__label">Tuca</span>
      <span className="nav-item__meta">{L('monta agentes', 'builds agents')}</span>
    </button>
  )
}

function Section({ id, label, unread = 0, action, children }: { id: string; label: string; unread?: number; action?: ReactNode; children: ReactNode }): ReactNode {
  const { open, toggle } = useFold(`section:${id}`)
  return (
    <div className={`section ${open ? '' : 'is-folded'}`}>
      <div className="section__head">
        <FoldToggle open={open} onToggle={toggle}>
          {label}
        </FoldToggle>
        {/* A closed section still says when something in it is waiting. */}
        {!open && unread > 0 && <span className="badge badge--soft">{unread}</span>}
        {action}
      </div>
      {children}
    </div>
  )
}

// A group folds like the sections, in the same list (Fold.tsx), and keeps showing the channel you're in.
function GroupFold({ id, label, unread, head, naming, children }: { id: string; label: string; unread: number; head: HTMLAttributes<HTMLDivElement>; naming?: ReactNode; children: ReactNode }): ReactNode {
  const { open, toggle } = useFold(`group:${id}`)
  return (
    <div className={`channel-group ${open ? '' : 'is-folded'}`}>
      {naming || (
        <div className="channel-group__head" {...head}>
          <FoldToggle open={open} onToggle={toggle}>
            {label}
          </FoldToggle>
          {!open && unread > 0 && <span className="badge badge--soft">{unread}</span>}
        </div>
      )}
      {children}
    </div>
  )
}

const unreadIn = (conversations: { unread?: number }[]): number => conversations.reduce((sum, c) => sum + (c.unread ?? 0), 0)

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
    { label: L('Renomear…', 'Rename…'), icon: 'edit', onClick: () => openDialog({ kind: 'rename', id: c.id }) },
    { label: L('Mudar o tema…', 'Change the topic…'), icon: 'hash', onClick: () => openDialog({ kind: 'topic', id: c.id }) },
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
      onClick: () => {
        if (confirm(L(`Excluir #${c.name}?\n\nAs mensagens e as rotinas que postam nele vão junto. Os agentes continuam existindo. Não dá pra desfazer.`, `Delete #${c.name}?\n\nIts messages and the routines that post in it go too. The agents stay. This can't be undone.`))) void deleteConversation(c.id)
      }
    }
  ]
  const dmMenu = (id: string, agentId: string, agentName: string): MenuItem[] => [
    { label: L(`Ver ${agentName}`, `See ${agentName}`), icon: 'eye', onClick: () => navigate({ kind: 'agent', id: agentId }) },
    { label: L('Marcar como lido', 'Mark as read'), icon: 'check', onClick: () => markRead(id) },
    wikiItem(id, s.conversations.find((x) => x.id === id)?.wikiCapture !== false),
    'separator',
    {
      label: L('Apagar a conversa…', 'Delete the conversation…'),
      icon: 'trash',
      danger: true,
      onClick: () => {
        if (confirm(L(`Apagar a conversa com ${agentName}?\n\nAs mensagens e as rotinas desta DM vão junto. ${agentName} continua existindo.`, `Delete the conversation with ${agentName}?\n\nThe messages and routines of this DM go too. ${agentName} stays.`))) void deleteConversation(id)
      }
    }
  ]
  const agentMenu = (agentId: string, agentName: string): MenuItem[] => [
    { label: L('Mandar mensagem', 'Send a message'), icon: 'send', onClick: () => void openDm(agentId) },
    { label: L('Editar', 'Edit'), icon: 'edit', onClick: () => navigate({ kind: 'agent', id: agentId }) },
    'separator',
    {
      label: L('Arquivar…', 'Archive…'),
      icon: 'trash',
      danger: true,
      onClick: () => {
        if (confirm(L(`Arquivar ${agentName}?\n\nSai da barra lateral e para de responder; as rotinas dele desligam. O histórico e os recibos ficam, e dá pra reativar em "Arquivados", no fim da lista de agentes.`, `Archive ${agentName}?\n\nIt leaves the sidebar and stops replying; its routines turn off. History and receipts stay, and you can bring it back from "Archived", at the end of the agent list.`))) void archiveAgent(agentId, true)
      }
    }
  ]

  const isDark =
    s.settings.theme === 'dark' || (s.settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <aside className="sidebar">
      <div className="sidebar__drag" />
      <div className="workspace">
        <span className="workspace__logo">{s.settings.workspaceName.slice(0, 1)}</span>
        <span className="workspace__name">{s.settings.workspaceName}</span>
        <button
          className={`icon-btn ${s.settings.paused ? 'is-paused' : ''}`}
          title={s.settings.paused ? L('Retomar os agentes', 'Resume the agents') : L('Pausar tudo: nenhum agente começa a trabalhar e nenhuma rotina roda', 'Pause everything: no agent starts working and no routine runs')}
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
        <Section id="dms" label={L('Mensagens diretas', 'Direct messages')} unread={unreadIn(dms)}>
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
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <Icon name="hash" />
      <span className="nav-item__label">{name}</span>
      {working && <span className="pulse" title={L('Trabalhando', 'Working')} />}
      {unread ? <span className="badge badge--soft">{unread}</span> : null}
    </button>
  )
}

function DmItem({ id, agent, unread }: { id: string; agent: Agent; unread?: number }): ReactNode {
  const name = agent.name
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
  const working = useStore((s) => s.messages.some((m) => m.conversationId === id && m.run?.status === 'working'))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <AgentAvatar agent={agent} size={18} busy={working} />
      <span className="nav-item__label">{name}</span>
      {working && <span className="pulse" title={L('Trabalhando', 'Working')} />}
      {unread ? <span className="badge badge--soft">{unread}</span> : null}
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
      {pct >= 0.8 && <span className={`dot ${pct >= 1 ? 'dot--danger' : 'dot--warn'}`} title={L('Orçamento acima de 80%', 'Budget above 80%')} />}
    </button>
  )
}
