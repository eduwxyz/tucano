// Missões: what's worth trying after the first message, each one checking itself off when it
// happens (as "Primeiros passos" did). On a new install each also brings a part of the sidebar,
// which starts short; a part with something in it shows anyway, and "Mostrar tudo de uma vez" ends it.
import { L } from '../../../shared/lang'
import { freshParts, MISSIONS, missionsDone, partShows, shortSidebar, type MissionFacts, type MissionId, type SidebarPart } from '../../../shared/onboarding'
import type { ReactNode } from 'react'
import { getState, isTeam, navigate, openTuca, updateSettings, useStore, type State, type View } from '../store'
import { Icon, TucaMark } from './ui'

// Whether one of the team's agents (not the Tuca) finished a reply, and whether an agent's question
// was answered: read once per change of the messages.
const talked = new WeakMap<State['messages'], { replied: boolean; answered: boolean }>()
function conversationFacts(s: State): { replied: boolean; answered: boolean } {
  const had = talked.get(s.messages)
  if (had) return had
  const team = new Set(s.agents.filter(isTeam).map((a) => a.id))
  const out = { replied: false, answered: false }
  for (const list of Object.values(s.messages))
    for (const m of list) {
      if (m.author.kind !== 'agent' || !m.run) continue
      if (m.run.status === 'done' && team.has(m.author.id)) out.replied = true
      if (m.run.question && m.run.status !== 'waiting_input') out.answered = true
    }
  talked.set(s.messages, out)
  return out
}

// What the missions look at, as values: the sidebar redraws only when one changes.
export const missionFacts = (s: State): MissionFacts => {
  const c = conversationFacts(s)
  return {
    replied: c.replied,
    decided: c.answered || s.approvals.some((a) => a.state !== 'pending'),
    connectors: s.connectors.length,
    agents: s.agents.filter(isTeam).length,
    routines: s.routines.length,
    memories: s.memories.filter((m) => m.state === 'active').length
  }
}

export function useMissions(): { facts: MissionFacts; done: Set<MissionId> } {
  // A plain object of values: the store keeps it while it's the same, so nothing redraws for nothing.
  const facts = useStore(missionFacts)
  return { facts, done: missionsDone(facts) }
}

// Which parts of the sidebar show, and which a mission just brought (tagged new until opened).
export function useSidebarParts(): { shows: (p: SidebarPart) => boolean; fresh: (p: SidebarPart) => boolean; seen: (p: SidebarPart) => void } {
  const onboarding = useStore((s) => s.settings.onboarding)
  const has = useStore((s) => `${s.memories.length > 0}|${s.routines.length > 0}|${s.skills.length > 0}|${s.connectors.length > 0}|${s.conversations.filter((c) => c.kind === 'channel').length > 1}`)
  const { done } = useMissions()
  const [memory, routines, skills, connectors, channels] = has.split('|').map((x) => x === 'true')
  const content: Partial<Record<SidebarPart, boolean>> = { memory, routines, skills, connectors, channels }
  const newOnes = freshParts(onboarding, done)
  return {
    shows: (p) => partShows(p, onboarding, done, content),
    fresh: (p) => newOnes.includes(p),
    seen: (p) => {
      const o = getState().settings.onboarding
      if (o && shortSidebar(o) && !(o.seen ?? []).includes(p)) updateSettings({ onboarding: { ...o, seen: [...(o.seen ?? []), p] } })
    }
  }
}

const agentName = (s: State): string => s.agents.find(isTeam)?.name ?? L('seu agente', 'your agent')

const go = (id: MissionId): View | 'tuca' => {
  const s = getState()
  const channel = s.conversations.find((c) => c.id === s.settings.onboarding?.channel) ?? s.conversations.find((c) => c.kind === 'channel')
  if (id === 'talk') return channel ? { kind: 'conversation', id: channel.id } : 'tuca'
  if (id === 'approve') return { kind: 'approvals' }
  if (id === 'connect') return { kind: 'connectors' }
  if (id === 'second') return 'tuca'
  if (id === 'auto') return { kind: 'routines' }
  return { kind: 'memory' }
}
const doIt = (id: MissionId): void => {
  const to = go(id)
  if (to === 'tuca') openTuca()
  else navigate(to)
}

// "Fale com a Lia" as the rest of a sentence: only its first letter goes down (names keep theirs).
const lower = (t: string): string => t.charAt(0).toLowerCase() + t.slice(1)

// At the bottom of the sidebar: how many are done, and the next one.
export function MissionsCard(): ReactNode {
  const { done } = useMissions()
  const name = useStore(agentName)
  const onboarding = useStore((s) => s.settings.onboarding)
  const active = useStore((s) => s.view?.kind === 'missions')
  const all = MISSIONS()
  const count = all.filter((m) => done.has(m.id)).length
  const next = all.find((m) => !done.has(m.id))
  const brought = freshParts(onboarding, done)
  const latest = [...all].reverse().find((m) => done.has(m.id) && m.unlocks.some((p) => brought.includes(p)))
  const line = latest ? L(`Você liberou ${latest.unlockName}`, `You unlocked ${latest.unlockName}`) : next ? L(`Próxima: ${lower(next.title(name))}`, `Next: ${lower(next.title(name))}`) : L('Você conhece o Tucano inteiro', 'You know all of Tucano')
  return (
    <button className={`missions-card ${active ? 'is-active' : ''} ${latest ? 'is-new' : ''}`} data-coach="missions" onClick={() => navigate({ kind: 'missions' })}>
      <span className="missions-ring" style={{ background: `conic-gradient(var(--m-accent) 0 ${(count / all.length) * 100}%, var(--m-track) ${(count / all.length) * 100}% 100%)` }} aria-hidden>
        <span>
          {count}/{all.length}
        </span>
      </span>
      <span className="missions-card__text">
        <b>{L('Missões', 'Missions')}</b>
        <span>{line}</span>
      </span>
      <span className="sr-only">{L(`${count} de ${all.length} feitas`, `${count} of ${all.length} done`)}</span>
    </button>
  )
}

export function MissionsPage(): ReactNode {
  const { done } = useMissions()
  const name = useStore(agentName)
  const onboarding = useStore((s) => s.settings.onboarding)
  const all = MISSIONS()
  const next = all.find((m) => !done.has(m.id))
  const short = shortSidebar(onboarding)
  return (
    <div className="missions">
      <div className="missions__head">
        <div>
          <h1>{L('Missões', 'Missions')}</h1>
          <p>{short ? L('Cada uma te mostra uma parte do Tucano, e ela aparece na barra quando você chega lá.', 'Each one shows you a part of Tucano, and it shows up in the sidebar when you get there.') : L('Cada uma te mostra uma parte do Tucano e se marca sozinha quando você usa.', 'Each one shows you a part of Tucano and checks itself off when you use it.')}</p>
        </div>
        {short && (
          <button className="missions-link" onClick={() => updateSettings({ onboarding: { ...onboarding!, showAll: true } })}>
            {L('Mostrar tudo de uma vez', 'Show everything at once')}
          </button>
        )}
      </div>
      <ol className="missions__grid">
        {all.map((m, i) => {
          const isDone = done.has(m.id)
          const isNext = m === next
          return (
            <li key={m.id} className={`mission ${isDone ? 'is-done' : isNext ? 'is-next' : ''}`}>
              {isDone ? (
                <span className="mission__check" aria-hidden>
                  <Icon name="check" size={16} />
                </span>
              ) : (
                <span className="mission__n" aria-hidden>
                  {i + 1}
                </span>
              )}
              <b>{m.title(name)}</b>
              {isDone ? (
                <span className="mission__state">{m.unlocks.length && short ? L(`Feita · liberou ${m.unlockName}`, `Done · unlocked ${m.unlockName}`) : L('Feita', 'Done')}</span>
              ) : (
                <span className="mission__how">
                  {m.how}
                  {m.unlocks.length > 0 && short && (
                    <>
                      {' '}
                      {L('Libera', 'Unlocks')} <b>{m.unlockName}</b>.
                    </>
                  )}
                </span>
              )}
              {!isDone && (
                <button className={`mission__go ${isNext ? '' : 'is-quiet'}`} onClick={() => doIt(m.id)}>
                  {L('Fazer agora', 'Do it now')}
                  <span className="sr-only">: {m.title(name)}</span>
                </button>
              )}
            </li>
          )
        })}
      </ol>
      <div className="missions__help">
        <TucaMark size={40} />
        <span className="grow">
          {L('Travou em alguma? Me chama no ', 'Stuck on one? Call me at ')}
          <b>Tuca</b>
          {L(', no topo da barra. Eu faço com você.', ', at the top of the sidebar. I’ll do it with you.')}
        </span>
        <button className="missions-link" onClick={openTuca}>
          {L('Chamar o Tuca', 'Call Tuca')}
        </button>
      </div>
      <p className="missions__foot">
        <button className="missions-link missions-link--quiet" onClick={() => (updateSettings({ onboarding: { ...(onboarding ?? { done: true }), checklistHidden: true } }), navigate({ kind: 'approvals' }))}>
          {L('Esconder as missões', 'Hide the missions')}
        </button>{' '}
        <span>{L('Voltam em Configurações.', 'They come back in Settings.')}</span>
      </p>
    </div>
  )
}
