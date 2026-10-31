import { L } from '../../../shared/lang'
import { useCallback, useState, type ReactNode } from 'react'
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
  type View
} from '../store'
import { ContextMenu, type MenuItem, type MenuState } from './Dialogs'
import { GettingStarted } from './Onboarding'
import { UpdateNote } from './Update'
import { AgentAvatar, Icon, TucaMark, type IconName } from './ui'

const same = (a: View | null, b: View): boolean => JSON.stringify(a) === JSON.stringify(b)

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
  const channelMenu = (c: (typeof channels)[number]): MenuItem[] => [
    { label: L('Adicionar ou remover agentes…', 'Add or remove agents…'), icon: 'users', onClick: () => openDialog({ kind: 'members', id: c.id }) },
    { label: L('Renomear…', 'Rename…'), icon: 'edit', onClick: () => openDialog({ kind: 'rename', id: c.id }) },
    { label: L('Mudar o tema…', 'Change the topic…'), icon: 'hash', onClick: () => openDialog({ kind: 'topic', id: c.id }) },
    ...(c.unread ? [{ label: L('Marcar como lido', 'Mark as read'), icon: 'check' as const, onClick: () => markRead(c.id) }] : []),
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
        <NavItem view={{ kind: 'routines' }} icon="clock" label={L('Rotinas', 'Routines')} />
        <NavItem view={{ kind: 'skills' }} icon="layers" label="Skills" badge={proposals} />
        <NavItem view={{ kind: 'report' }} icon="report" label={L('Boletim', 'Report')} />

        <div className="section">
          <div className="section__head">
            <span>{L('Canais', 'Channels')}</span>
            <button className="icon-btn icon-btn--sm" title={L(`Novo canal (${shortcut(s.platform, 'N')})`, `New channel (${shortcut(s.platform, 'N')})`)} onClick={() => openDialog({ kind: 'new-channel' })}>
              <Icon name="plus" size={14} />
            </button>
          </div>
          {channels.map((c) => (
            <div key={c.id} onContextMenu={(e) => open(e, channelMenu(c))}>
              <ChannelItem id={c.id} name={c.name} unread={c.unread} />
            </div>
          ))}
        </div>

        {dms.length > 0 && (
        <div className="section">
          <div className="section__head">
            <span>{L('Mensagens diretas', 'Direct messages')}</span>
          </div>
          {dms.map((c) => {
            const agent = agentById(s, c.name)
            if (!agent) return null
            return (
              <div key={c.id} onContextMenu={(e) => open(e, dmMenu(c.id, agent.id, agent.name))}>
                <DmItem id={c.id} name={agent.name} color={agent.color} />
              </div>
            )
          })}
        </div>
        )}

        <div className="section">
          <div className="section__head">
            <span>{L('Agentes', 'Agents')}</span>
            <button className="icon-btn icon-btn--sm" title={L('Novo agente: abre o Tuca', 'New agent: opens Tuca')} onClick={openTuca}>
              <Icon name="plus" size={14} />
            </button>
          </div>
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
        </div>
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
  return (
    <button className={`nav-item ${active ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <Icon name="hash" />
      <span className="nav-item__label">{name}</span>
      {unread ? <span className="badge badge--soft">{unread}</span> : null}
    </button>
  )
}

function DmItem({ id, name, color }: { id: string; name: string; color: Parameters<typeof AgentAvatar>[0]['agent']['color'] }): ReactNode {
  const active = useStore((s) => s.view?.kind === 'conversation' && s.view.id === id)
  const working = useStore((s) => s.messages.some((m) => m.conversationId === id && m.run?.status === 'working'))
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'conversation', id })}>
      <AgentAvatar agent={{ name, color }} size={18} busy={working} />
      <span className="nav-item__label">{name}</span>
      {working && <span className="pulse" title={L('Trabalhando', 'Working')} />}
    </button>
  )
}

function AgentItem({ id }: { id: string }): ReactNode {
  const agent = useStore((s) => agentById(s, id))
  const active = useStore((s) => s.view?.kind === 'agent' && s.view.id === id)
  const working = useStore((s) => s.messages.some((m) => m.author.kind === 'agent' && m.author.id === id && m.run?.status === 'working'))
  if (!agent) return null
  const pct = agent.limit > 0 ? agent.used / agent.limit : 1
  return (
    <button className={`nav-item ${active ? 'is-active' : ''}`} onClick={() => navigate({ kind: 'agent', id })}>
      <AgentAvatar agent={agent} size={18} busy={working} />
      <span className="nav-item__label">{agent.name}</span>
      {working ? <span className="pulse" title={L('Trabalhando', 'Working')} /> : <span className="nav-item__meta nav-item__role" title={agent.role}>{agent.role}</span>}
      {agent.computer && agent.computerKind === 'mac' && (
        <span className="nav-item__mac" title={L('Roda no seu computador', 'Runs on your computer')}>
          <Icon name="laptop" size={13} />
        </span>
      )}
      {pct >= 0.8 && <span className={`dot ${pct >= 1 ? 'dot--danger' : 'dot--warn'}`} title={L('Orçamento acima de 80%', 'Budget above 80%')} />}
    </button>
  )
}
