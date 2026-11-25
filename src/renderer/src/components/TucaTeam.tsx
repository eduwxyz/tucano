// Beside the Tuca's conversation, in the full app: the team he passes the requests to. Whoever has a
// part of the request in hand comes first, with what was asked and how it stands, and its work one
// click away. Everyone else is at rest, by what they do.
import type { ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { messagesIn, navigate, openThread, useStore, type Agent } from '../store'
import { teamLine, teamRows, type TeamRow } from '../tuca-screen'
import { AgentAvatar, Icon } from './ui'

export function TeamSide({ conversationId, tucaId, onBuild }: { conversationId: string; tucaId: string; onBuild: () => void }): ReactNode {
  // As text: the rows are made new at every look, and a string is the same while nothing in them changed.
  const found = useStore((s) => JSON.stringify(teamRows(s, tucaId, conversationId, messagesIn(s, conversationId)).map((r) => ({ id: r.agent.id, asked: r.asked }))))
  const agents = useStore((s) => s.agents)
  const rows = (JSON.parse(found) as { id: string; asked?: TeamRow['asked'] }[]).flatMap((r): TeamRow[] => {
    const agent = agents.find((a) => a.id === r.id)
    return agent ? [{ agent, ...(r.asked ? { asked: r.asked } : {}) }] : []
  })
  const open = (r: TeamRow): void => {
    if (!r.asked) return navigate({ kind: 'agent', id: r.agent.id })
    navigate({ kind: 'conversation', id: r.asked.conversationId, message: r.asked.open })
    openThread(r.asked.open)
  }
  const does = (a: Agent): string => a.role.trim() || L('Agente', 'Agent')
  return (
    <div className="onb-tc__card onb-tc__team">
      <div className="onb-tc__card-head">
        <span className="onb-tc__team-mark" aria-hidden>
          <Icon name="users" size={17} />
        </span>
        <div className="grow">
          <strong>{L('Seu time', 'Your team')}</strong>
          <span className="muted small">{teamLine(rows)}</span>
        </div>
      </div>
      <ul className="onb-tc__mates">
        {rows.map((r) => (
          <li key={r.agent.id}>
            <button className={`onb-tc__mate ${r.asked ? 'is-asked' : ''}`} onClick={() => open(r)} title={r.asked ? L(`Ver o trabalho de ${r.agent.name}`, `See ${r.agent.name}'s work`) : L(`Ver ${r.agent.name}`, `See ${r.agent.name}`)}>
              <AgentAvatar agent={r.agent} size={32} busy={r.asked?.tone === 'live'} />
              <span className="onb-tc__mate-text">
                <span className="onb-tc__mate-top">
                  <span className="onb-tc__mate-name">{r.agent.name}</span>
                  {r.asked && (
                    <span className={`request-note__state ${r.asked.tone === 'live' ? 'is-live' : r.asked.tone === 'done' ? 'is-done' : r.asked.tone === 'warn' ? 'is-warn' : ''}`}>
                      <i />
                      {r.asked.label}
                    </span>
                  )}
                </span>
                <span className="onb-tc__mate-sub">{r.asked ? r.asked.text : does(r.agent)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="onb-tc__actions">
        <button className="btn onb-tc__go" onClick={onBuild} title={L('Monta um agente novo com o Tuca: a proposta aparece aqui ao lado', 'Builds a new agent with Tuca: the proposal shows up here beside the chat')}>
          <Icon name="plus" size={13} /> {L('Novo agente', 'New agent')}
        </button>
      </div>
    </div>
  )
}
