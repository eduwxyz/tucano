// Memory: what the agents remember, as a page to read. Each memory is just its
// sentence; where it came from and what to do with it show on hover.
import { L, locale } from '../../../shared/lang'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  addMemory,
  agentById,
  confirmMemory,
  decideMemory,
  editMemory,
  forgetMemory,
  isStale,
  navigate,
  purgeMemory,
  splitForPrompt,
  useStore,
  STALE_DAYS,
  type Agent,
  type Memory,
  isTeam,
  personScope
} from '../store'
import { Sheet } from './Pages'
import { ago, AgentAvatar, Icon } from './ui'

const norm = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

type Tab = 'all' | 'me' | 'review' | 'forgotten' | string // or an agent id

export function MemoryPage(): ReactNode {
  const memories = useStore((s) => s.memories)
  const agents = useStore((s) => s.agents.filter(isTeam))
  const me = useStore((s) => s.me.name)
  // "You": this person's own memories (the core keeps them under their scope).
  const mine = personScope(useStore((s) => s.you))
  const [tab, setTab] = useState<Tab>('all')
  const [q, setQ] = useState('')
  const [finding, setFinding] = useState(false)
  const find = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (finding) find.current?.focus()
  }, [finding])

  const hit = (m: Memory): boolean => !q.trim() || norm(m.text).includes(norm(q.trim()))
  const pending = memories.filter((m) => m.state === 'pending')
  const stale = memories.filter((m) => isStale(m))
  const forgotten = memories.filter((m) => m.state === 'forgotten')
  const activeIn = (scope: string): Memory[] => memories.filter((m) => m.scope === scope && m.state === 'active' && !isStale(m)).sort((a, b) => b.confirmedAt - a.confirmedAt)
  const withNotes = agents.filter((a) => memories.some((m) => m.scope === a.id && m.state === 'active'))
  const groups: { scope: string; agent?: Agent }[] = [{ scope: mine }, ...withNotes.map((a) => ({ scope: a.id, agent: a }))]
  const shown = tab === 'all' ? groups : groups.filter((g) => g.scope === (tab === 'me' ? mine : tab))
  const review = pending.length + stale.length

  // The strip holds a tab per bot, and there is no limit on bots, so it scrolls inside the bar
  // instead of running past the page. The tab picked comes back to the middle of the strip: with a
  // dozen bots the one clicked would otherwise sit under an edge or outside the view. The arrows
  // walk the same strip a screenful at a time, for a person reading along it.
  const strip = useRef<HTMLDivElement>(null)
  const [over, setOver] = useState({ back: 0, on: 0 })
  const measure = (): void => {
    const s = strip.current
    if (!s) return
    setOver({ back: s.scrollLeft, on: s.scrollWidth - s.clientWidth - s.scrollLeft })
  }
  useEffect(() => {
    measure()
  }, [withNotes.length, forgotten.length, finding])
  useEffect(() => {
    const on = (): void => measure()
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  // Selecting is where the sliding happens: the chosen tab is put in the middle, whether the click
  // came from a tab or from an arrow that only moved the strip.
  useEffect(() => {
    const s = strip.current
    const el = s?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)
    if (!s || !el) return
    // The strip fits: there is no middle to bring the tab to. Written this way so a host without
    // layout, where both widths are absent, also leaves the strip alone.
    if (!(s.scrollWidth > s.clientWidth)) return
    const box = el.getBoundingClientRect()
    const own = s.getBoundingClientRect()
    const middle = s.scrollLeft + (box.left - own.left) - (s.clientWidth - box.width) / 2
    s.scrollTo({ left: Math.max(0, middle), behavior: 'smooth' })
  }, [tab])
  const page = (by: 1 | -1): void => {
    const s = strip.current
    if (!s) return
    s.scrollBy({ left: by * Math.max(160, s.clientWidth - 48), behavior: 'smooth' })
  }

  const tabBtn = (id: Tab, label: ReactNode): ReactNode => (
    <button key={id} data-tab={id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
      {label}
    </button>
  )

  return (
    <Sheet title={L('Memória', 'Memory')} lede={L('O que os agentes sabem sobre você e o seu trabalho.', 'What the agents know about you and your work.')}>
      <nav className="tabs-line">
        <div className="tabs-line__strip" ref={strip} onScroll={measure}>
          {tabBtn('all', L('Tudo', 'All'))}
          {tabBtn('me', L('Você', 'You'))}
          {withNotes.map((a) =>
            tabBtn(
              a.id,
              <>
                <AgentAvatar agent={a} size={14} /> {a.name}
              </>
            )
          )}
          {forgotten.length > 0 && tabBtn('forgotten', L('Esquecidas', 'Forgotten'))}
        </div>
        {over.back > 1 && (
          <button className="tabs-line__page tabs-line__page--back" aria-label={L('Abas anteriores', 'Earlier tabs')} title={L('Abas anteriores', 'Earlier tabs')} onClick={() => page(-1)}>
            <Icon name="chevron" size={16} />
          </button>
        )}
        {over.on > 1 && (
          <button className="tabs-line__page" aria-label={L('Mais abas', 'More tabs')} title={L('Mais abas', 'More tabs')} onClick={() => page(1)}>
            <Icon name="chevron" size={16} />
          </button>
        )}
        {finding || q ? (
          <label className="tabs-line__find">
            <Icon name="search" size={13} />
            <input ref={find} value={q} placeholder={L('Buscar', 'Search')} onChange={(e) => setQ(e.target.value)} onBlur={() => !q && setFinding(false)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setFinding(false))} />
          </label>
        ) : (
          <button className="tabs-line__icon" title={L('Buscar', 'Search')} onClick={() => setFinding(true)}>
            <Icon name="search" size={14} />
          </button>
        )}
      </nav>

      {review > 0 && tab !== 'review' && tab !== 'forgotten' && (
        <div className="notice-line">
          <span>
            <b>{review}</b> {review === 1 ? L('memória esperando', 'memory waiting for') : L('memórias esperando', 'memories waiting for')} {L('você', 'you')}
          </span>
          <button onClick={() => setTab('review')}>{L('Revisar', 'Review')}</button>
        </div>
      )}

      {tab === 'review' ? (
        <>
          {pending.length > 0 && (
            <ReadGroup title={L('Novas', 'New')} lead={L('Só entram na memória se você guardar.', 'They only go into memory if you keep them.')}>
              {pending.map((m) => (
                <Line key={m.id} memory={m} shown>
                  <button className="text-btn text-btn--strong" onClick={() => decideMemory(m.id, true)}>
                    {L('Guardar', 'Keep')}
                  </button>
                  <button className="text-btn" onClick={() => decideMemory(m.id, false)}>
                    {L('Descartar', 'Discard')}
                  </button>
                </Line>
              ))}
            </ReadGroup>
          )}
          {stale.length > 0 && (
            <ReadGroup title={L('Ainda valem?', 'Still true?')} lead={L(`Sem confirmação há mais de ${STALE_DAYS} dias. Continuam no prompt até você decidir.`, `Not confirmed in over ${STALE_DAYS} days. They stay in the prompt until you decide.`)}>
              {stale.map((m) => (
                <Line key={m.id} memory={m} shown>
                  <button className="text-btn text-btn--strong" onClick={() => confirmMemory(m.id)}>
                    {L('Ainda vale', 'Still true')}
                  </button>
                  <button className="text-btn" onClick={() => forgetMemory(m.id)}>
                    {L('Esquecer', 'Forget')}
                  </button>
                </Line>
              ))}
            </ReadGroup>
          )}
          {review === 0 && <p className="read-empty">{L('Nada esperando você.', 'Nothing waiting for you.')}</p>}
          <button className="text-btn read-back" onClick={() => setTab('all')}>
            {L('← Voltar', '← Back')}
          </button>
        </>
      ) : tab === 'forgotten' ? (
        <ReadGroup title={L('Esquecidas', 'Forgotten')} lead={L('Saíram do prompt. O registro impede que sejam aprendidas de novo; apagar de vez remove até ele.', 'Out of the prompt. The record keeps them from being learned again; deleting for good removes even that.')}>
          {forgotten.filter(hit).map((m) => (
            <Line key={m.id} memory={m}>
              <button className="text-btn" onClick={() => purgeMemory(m.id)}>
                {L('Apagar de vez', 'Delete for good')}
              </button>
            </Line>
          ))}
        </ReadGroup>
      ) : (
        <>
          {shown.map((g) => {
            const list = activeIn(g.scope).filter(hit)
            if (q.trim() && list.length === 0) return null
            return (
              <ReadGroup
                key={g.scope}
                title={
                  g.agent ? (
                    <button className="row row--center" onClick={() => navigate({ kind: 'agent', id: g.agent!.id })}>
                      <AgentAvatar agent={g.agent} size={14} /> {L(`Notas de ${g.agent.name}`, `${g.agent.name}'s notes`)}
                    </button>
                  ) : (
                    L('Você', 'You')
                  )
                }
                lead={g.agent ? L(`Só ${g.agent.name} vê.`, `Only ${g.agent.name} sees these.`) : undefined}
              >
                {g.scope === mine && !q.trim() && <Add me={me} />}
                {list.map((m) => (
                  <EditableLine key={m.id} memory={m} />
                ))}
              </ReadGroup>
            )
          })}
          {q.trim() && shown.every((g) => activeIn(g.scope).filter(hit).length === 0) && <p className="read-empty">{L('Nenhuma memória com', 'No memory with')} “{q.trim()}”.</p>}
        </>
      )}
    </Sheet>
  )
}

function ReadGroup({ title, lead, children }: { title: ReactNode; lead?: string; children: ReactNode }): ReactNode {
  return (
    <section className="read-group">
      <h2>
        {title}
        {lead && <span>{lead}</span>}
      </h2>
      {children}
    </section>
  )
}

// Where it came from, when, and whether it's in the prompt: one quiet line.
function Meta({ memory, searchable }: { memory: Memory; searchable?: boolean }): ReactNode {
  const agent = useStore((s) => (memory.agentId ? agentById(s, memory.agentId) : undefined))
  const conv = useStore((s) => s.conversations.find((c) => c.id === memory.conversationId))
  const dmWith = useStore((s) => (conv?.kind === 'dm' ? agentById(s, conv.name)?.name : undefined))
  const who = memory.origin === 'agent' ? L(`${agent?.name ?? 'Um agente'} ${memory.state === 'pending' ? 'quer guardar' : 'guardou'}`, `${agent?.name ?? 'An agent'} ${memory.state === 'pending' ? 'wants to keep this' : 'kept this'}`) : memory.origin === 'extraction' ? L('Aprendida', 'Learned') : L('Você escreveu', 'You wrote this')
  return (
    <span className="read-line__meta-text">
      {who}
      {conv && (
        <>
          {' '}
          <button onClick={() => navigate({ kind: 'conversation', id: conv.id })}>{conv.kind === 'channel' ? L(`em #${conv.name}`, `in #${conv.name}`) : L(`na DM com ${dmWith ?? 'agente'}`, `in the DM with ${dmWith ?? 'an agent'}`)}</button>
        </>
      )}
      {' · '}
      <span title={new Date(memory.createdAt).toLocaleString(locale())}>{ago(memory.createdAt)}</span>
      {searchable && <span title={L('Fora do prompt: os agentes acham com buscar_memorias.', 'Out of the prompt: agents find it with buscar_memorias.')}>{L(' · por busca', ' · by search')}</span>}
    </span>
  )
}

function Line({ memory, searchable, shown, children }: { memory: Memory; searchable?: boolean; shown?: boolean; children?: ReactNode }): ReactNode {
  const previous = useStore((s) => (memory.replaces ? s.memories.find((m) => m.id === memory.replaces) : undefined))
  const [showPrev, setShowPrev] = useState(false)
  return (
    <div className={`read-line ${shown ? 'is-shown' : ''}`}>
      <p>{memory.text}</p>
      {showPrev && previous && <p className="read-line__prev">{L('Antes', 'Before')}: {previous.text}</p>}
      <div className="read-line__meta">
        <Meta memory={memory} searchable={searchable} />
        {previous && (
          <button className="text-btn" onClick={() => setShowPrev(!showPrev)}>
            {showPrev ? L('Esconder a anterior', 'Hide the previous one') : L('Ver a anterior', 'See the previous one')}
          </button>
        )}
        <span className="grow" />
        {children}
      </div>
    </div>
  )
}

function EditableLine({ memory }: { memory: Memory }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(memory.text)
  const searchable = useStore((s) => splitForPrompt(s.memories.filter((m) => m.scope === memory.scope && m.state === 'active')).searchable.some((m) => m.id === memory.id))
  if (editing)
    return (
      <form
        className="read-line is-editing"
        onSubmit={(e) => {
          e.preventDefault()
          editMemory(memory.id, text)
          setEditing(false)
        }}
      >
        <textarea
          rows={2}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false), setText(memory.text)
            if (e.key === 'Enter' && !e.shiftKey && text.trim()) e.preventDefault(), editMemory(memory.id, text), setEditing(false)
          }}
        />
        <div className="read-line__meta is-on">
          <span className="read-line__meta-text">{L('Enter salva · Esc cancela', 'Enter saves · Esc cancels')}</span>
          <span className="grow" />
          <button type="button" className="text-btn" onClick={() => (setEditing(false), setText(memory.text))}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button className="text-btn text-btn--strong" disabled={!text.trim()}>
            {L('Salvar', 'Save')}
          </button>
        </div>
      </form>
    )
  return (
    <Line memory={memory} searchable={searchable}>
      <button className="text-btn" onClick={() => setEditing(true)}>
        {L('Editar', 'Edit')}
      </button>
      <button className="text-btn" onClick={() => forgetMemory(memory.id)}>
        {L('Esquecer', 'Forget')}
      </button>
    </Line>
  )
}

function Add({ me }: { me: string }): ReactNode {
  const [text, setText] = useState('')
  return (
    <form
      className="read-add"
      onSubmit={(e) => {
        e.preventDefault()
        if (!text.trim()) return
        addMemory('me', text)
        setText('')
      }}
    >
      <Icon name="plus" size={15} />
      <input value={text} placeholder={L(`Ensinar algo sobre você. Ex.: ${me} prefere PRs pequenos.`, `Teach it something about you. E.g. ${me} prefers small PRs.`)} onChange={(e) => setText(e.target.value)} />
      {text.trim() && <span className="read-add__hint">{L('Enter guarda', 'Enter keeps it')}</span>}
    </form>
  )
}
