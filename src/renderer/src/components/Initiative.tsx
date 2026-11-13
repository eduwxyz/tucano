// The proactive coordinator, as the person sees it: a line in the DM it works from, and one window
// where it is set up, watched and stopped, and where its own record answers "why did it wake?".
//
// Nothing here decides anything: every button calls the core, and the core re-checks the person's
// authorization on the way in. A page that cannot read the record says so instead of guessing.
import { L, locale } from '../../../shared/lang'
import { useEffect, useState, type ReactNode } from 'react'
import { ACTION_KINDS, actionVerb } from '../../../shared/actions'
import type { Commitment, CommitmentInput, CommitmentState, InitiativeConfig, InitiativeInput, InitiativeWake, NotifyMode } from '../../../shared/initiative'
import { checkInNow, navigate, openDialog, refreshInitiative, saveCommitment, saveInitiative, useStore } from '../store'
import { Modal } from './Modal'
import { Card, Field, Toggle } from './Pages'
import { Icon } from './ui'

// ---------- what a state or an outcome says, in a person's words ----------

const STATE = (s: CommitmentState): string =>
  s === 'open'
    ? L('em aberto', 'open')
    : s === 'in_progress'
      ? L('em andamento', 'in progress')
      : s === 'waiting_external'
        ? L('esperando outra pessoa', 'waiting on someone else')
        : s === 'waiting_user'
          ? L('esperando você', 'waiting on you')
          : s === 'done'
            ? L('concluído', 'done')
            : L('dispensado', 'dismissed')

const WHY = (w: InitiativeWake): string => {
  if (w.outcome === 'quiet') return L('conferiu, nada a avisar', 'checked, nothing to report')
  if (w.outcome === 'reported') return w.deduped ? L('repetia a conferida anterior, e não apareceu', 'repeated the check-in before it, so it stayed out') : L('escreveu na conversa', 'wrote in the conversation')
  if (w.outcome === 'failed') return L('não terminou', "didn't finish")
  if (w.outcome === 'interrupted') return L('interrompida pelo app', 'interrupted by the app')
  const why = w.why
  return why === 'revision'
    ? L('pulada: você mudou o pedido', 'skipped: you changed the brief')
    : why === 'paused'
      ? L('pulada: o app está pausado', 'skipped: the app is paused')
      : why === 'agent'
        ? L('pulada: o bot não existe mais', 'skipped: that bot is gone')
        : why === 'dm'
          ? L('pulada: a conversa não existe mais', 'skipped: that conversation is gone')
          : why === 'off'
            ? L('pulada: a iniciativa foi desligada', 'skipped: initiative was turned off')
            : why === 'error'
              ? L('pulada por um erro', 'skipped by an error')
              : L('pulada', 'skipped')
}

const when = (at: number): string => new Date(at).toLocaleString(locale(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const minutes = (ms: number): number => Math.max(0, Math.round(ms / 60_000))
// "12 min", "1 h 05": enough to know when, never a clock to set.
const until = (ms: number): string => {
  const m = minutes(ms)
  if (m < 60) return L(`${m} min`, `${m} min`)
  const h = Math.floor(m / 60)
  return L(`${h} h ${String(m % 60).padStart(2, '0')}`, `${h} h ${String(m % 60).padStart(2, '0')}`)
}

// How many tokens, in a person's words: "12 mil" in Portuguese, "12k" in English, and the same for
// millions. A number a person reads has to be in the language they chose.
const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toLocaleString(locale(), { maximumFractionDigits: 1 })} ${L('mi', 'M')}`
    : n >= 1_000
      ? `${Math.round(n / 1_000)} ${L('mil', 'k')}`
      : String(n)

// ---------- the line in the DM ----------

// A DM whose bot looks after this person: what it is doing, when it is next, and the way in.
export function InitiativeLine({ conversationId, agentId }: { conversationId?: string; agentId?: string }): ReactNode {
  const view = useStore((s) => s.initiative)
  const config = view?.config
  const mine = !!config && config.conversationId === conversationId && config.agentId === agentId
  // It keeps itself current while the conversation is open: a person watching sees the countdown move.
  // Every hook of this component sits above its returns, so a save that turns the line on cannot change
  // how many of them this render has.
  useEffect(() => {
    if (!mine) return
    const t = setInterval(() => void refreshInitiative(), 60_000)
    return () => clearInterval(t)
  }, [mine])
  if (!view) return null
  // Nobody has a coordinator yet: this DM offers the way to set one up. Once it lives somewhere, it
  // speaks only from where it lives, and the other DMs stay quiet.
  if (!mine) {
    if (config || !conversationId || !agentId) return null
    const start = L('Ligar a iniciativa deste bot', "Turn on this bot's initiative")
    return (
      <button className="initiative-line is-off" title={start} aria-label={start} onClick={() => openDialog({ kind: 'initiative', agentId, conversationId })}>
        <span className="initiative-line__dot" aria-hidden="true" />
        <span className="initiative-line__text">{L('Iniciativa', 'Initiative')}</span>
      </button>
    )
  }
  const st = view.status
  const running = !!view.wakes[0] && !view.wakes[0]!.endedAt
  const says = st.paused
    ? L('tudo pausado', 'everything paused')
    : running
      ? L('conferindo agora…', 'checking now…')
      : !config!.enabled
        ? L('iniciativa desligada', 'initiative off')
        : st.waitingOnPerson > 0
          ? L('espera você', 'waits on you')
          : st.dueAt
            ? L(`próxima em ${until(st.dueAt - Date.now())}`, `next in ${until(st.dueAt - Date.now())}`)
            : L('ligada', 'on')
  const full = L(`Iniciativa do seu bot: ${says}.`, `Your bot's initiative: ${says}.`) + ` ${L(`${st.open} em aberto, ${st.waitingOnPerson} esperando você.`, `${st.open} open, ${st.waitingOnPerson} waiting on you.`)}`
  return (
    <button className={`initiative-line ${config!.enabled ? 'is-on' : ''} ${st.waitingOnPerson > 0 ? 'is-waiting' : ''}`} title={full} aria-label={full} onClick={() => openDialog({ kind: 'initiative', ...(agentId ? { agentId } : {}), ...(conversationId ? { conversationId } : {}) })}>
      <span className={`initiative-line__dot ${running ? 'is-live' : ''}`} aria-hidden="true" />
      <span className="initiative-line__text">{says}</span>
      {st.open > 0 && <span className="initiative-line__count">{st.open}</span>}
    </button>
  )
}

// ---------- the window ----------

const DEFAULTS = (agentId: string, conversationId: string): InitiativeInput => ({
  agentId,
  conversationId,
  enabled: false,
  brief: '',
  observe: { conversations: [] },
  work: { conversations: [], kinds: [] },
  cadenceMinutes: 15,
  notify: 'material',
  dailyReviews: 24,
  dailyTokens: 2_000_000,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ''
})

const draftOf = (config: InitiativeConfig | null, agentId: string, conversationId: string): InitiativeInput => (config ? { ...config } : DEFAULTS(agentId, conversationId))

// What the page sends back: only the fields a person edits, taken from the draft.
const inputOf = (d: InitiativeInput): InitiativeInput => ({
  agentId: d.agentId,
  conversationId: d.conversationId,
  enabled: d.enabled,
  brief: d.brief,
  observe: d.observe,
  work: d.work,
  cadenceMinutes: d.cadenceMinutes,
  notify: d.notify,
  dailyReviews: d.dailyReviews,
  dailyTokens: d.dailyTokens,
  timezone: d.timezone
})

export function InitiativeDialog({ onClose, agentId: fromAgent, conversationId: fromConversation }: { onClose: () => void; agentId?: string; conversationId?: string }): ReactNode {
  const view = useStore((s) => s.initiative)
  const agents = useStore((s) => s.agents)
  const conversations = useStore((s) => s.conversations)
  const config = view?.config ?? null
  const [draft, setDraft] = useState<InitiativeInput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'save' | 'check' | 'stop'>(null)
  const [note, setNote] = useState<string | null>(null)

  // The agent whose coordinator this is: the configured one, or the first bot this person has a DM with.
  const dmOf = (id: string): string | undefined => conversations.find((c) => c.kind === 'dm' && c.members[0] === id)?.id
  const agentId = config?.agentId ?? fromAgent ?? agents.find((a) => dmOf(a.id))?.id ?? ''
  const conversationId = config?.conversationId ?? fromConversation ?? dmOf(agentId) ?? ''

  useEffect(() => {
    if (view && !draft) setDraft(draftOf(view.config, agentId, conversationId))
  }, [view, draft, agentId, conversationId])

  // While a check-in is under way, the record is read again until it ends: the page shows what it did.
  const running = !!view?.wakes[0] && !view.wakes[0].endedAt
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => void refreshInitiative(), 2_000)
    return () => clearInterval(t)
  }, [running])

  const save = async (next: InitiativeInput = draft!, close = false): Promise<void> => {
    if (!next) return
    setBusy('save')
    setError(null)
    try {
      const saved = await saveInitiative(inputOf(next), config?.revision ?? 0)
      setDraft({ ...saved })
      setNote(saved.enabled ? L('Salvo.', 'Saved.') : L('Salvo. Está desligada: nada roda até você ligar.', 'Saved. It is off: nothing runs until you turn it on.'))
      if (close) onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))
    } finally {
      setBusy(null)
    }
  }

  const patch = (p: Partial<InitiativeInput>): void => setDraft((d) => (d ? { ...d, ...p } : d))

  // The switch is the state, so a refusal belongs under it: pressed from the footer the reason showed far
  // below the press and read as a switch that does nothing. A check-in with nothing to look after is
  // refused by the core, so it is refused here first, in the same words.
  const setEnabled = (on: boolean): void => {
    if (busy || !draft) return
    if (on && !draft.brief.trim()) {
      setError(L('Escreva o que ele deve cuidar, e ligue depois.', 'Write what it should look after, then turn it on.'))
      return
    }
    setError(null)
    void save({ ...draft, enabled: on })
  }
  const toggleIn = <T extends string>(list: T[], id: T): T[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const reach = conversations.filter((c) => (c.kind === 'dm' ? c.members[0] !== agentId : true))
  const st = view?.status
  const paused = !!st?.paused

  return (
    <Modal title={L('Iniciativa do bot', "Your bot's initiative")} onClose={onClose} className="initiative-modal">
      {!view || !draft ? (
        <p className="muted">{L('Lendo…', 'Reading…')}</p>
      ) : (
        <div className="initiative">
          <p className="initiative__state">
            {st?.paused ? (
              <b>{L('O app está pausado: nada roda até você despausar.', 'The app is paused: nothing runs until you unpause it.')}</b>
            ) : running ? (
              <b>{L('Conferindo agora…', 'Checking now…')}</b>
            ) : config?.enabled ? (
              <b>
                {st?.dueAt ? L(`Próxima conferida em ${until(st.dueAt - Date.now())}.`, `Next check-in in ${until(st.dueAt - Date.now())}.`) : L('Ligada.', 'On.')}
              </b>
            ) : (
              <b>{L('Desligada: nada roda.', 'Off: nothing runs.')}</b>
            )}
            {st && (
              <span className="muted">
                {' '}
                {L(
                  `${st.today.reviews} de ${draft.dailyReviews} conferidas hoje · ${tokens(st.today.tokens)} de ${tokens(draft.dailyTokens)} tokens · ${st.open} em aberto, ${st.waitingOnPerson} esperando você`,
                  `${st.today.reviews} of ${draft.dailyReviews} check-ins today · ${tokens(st.today.tokens)} of ${tokens(draft.dailyTokens)} tokens · ${st.open} open, ${st.waitingOnPerson} waiting on you`
                )}
              </span>
            )}
          </p>

          <div className="initiative__actions">
            <button
              className="btn btn--primary btn--sm"
              disabled={!!busy || paused || running || !config?.enabled}
              onClick={() => {
                setBusy('check')
                setError(null)
                void checkInNow()
                  .then((r) => {
                    if (!r.started) setError(whyNot(r.why))
                    else setNote(L('Conferindo…', 'Checking…'))
                  })
                  .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
                  .finally(() => setBusy(null))
              }}
            >
              <Icon name="zap" size={14} /> {running ? L('Conferindo…', 'Checking…') : L('Conferir agora', 'Check now')}
            </button>
            <button
              className="btn btn--ghost btn--sm"
              disabled={!!busy || !config?.enabled}
              onClick={() => {
                setBusy('stop')
                void save({ ...draft, enabled: false })
                  .then(() => setNote(L('Desligada.', 'Off.')))
                  .finally(() => setBusy(null))
              }}
            >
              {L('Desligar', 'Turn off')}
            </button>
            <span className="spacer" />
            <Toggle on={draft.enabled} onChange={setEnabled} />
            <span className="small">{draft.enabled ? L('ligada', 'on') : L('desligada', 'off')}</span>
          </div>

          {error && (
            <p className="initiative__error" role="alert">
              {error}
            </p>
          )}
          {!error && !draft.enabled && !draft.brief.trim() && (
            <p className="hint">{L('Escreva o pedido para poder ligar.', 'Write the brief, then you can turn it on.')}</p>
          )}
          {!error && note && <p className="hint">{note}</p>}

          <Field label={L('O que ele cuida pra você', 'What it looks after for you')} hint={L('Nas suas palavras. É o que ele lê em cada conferida.', 'In your words. It is what it reads on every check-in.')}>
            <textarea className="input" rows={4} value={draft.brief} onChange={(e) => patch({ brief: e.target.value })} />
          </Field>

          <div className="initiative__grid">
            <Field label={L('De quanto em quanto tempo', 'How often')}>
              <select className="input" value={draft.cadenceMinutes} onChange={(e) => patch({ cadenceMinutes: Number(e.target.value) })}>
                {[5, 10, 15, 30, 60, 120, 240].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? L(`${m} minutos`, `${m} minutes`) : L(`${m / 60} hora${m === 60 ? '' : 's'}`, `${m / 60} hour${m === 60 ? '' : 's'}`)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={L('Quando interromper você', 'When to interrupt you')}>
              <select className="input" value={draft.notify} onChange={(e) => patch({ notify: e.target.value as NotifyMode })}>
                <option value="material">{L('achados que importam', 'findings that matter')}</option>
                <option value="decisions">{L('só o que precisa de decisão', 'only what needs a decision')}</option>
                <option value="none">{L('nunca', 'never')}</option>
              </select>
            </Field>
            <Field label={L('Conferidas por dia', 'Check-ins a day')}>
              <input className="input" type="number" min={1} max={96} value={draft.dailyReviews} onChange={(e) => patch({ dailyReviews: Number(e.target.value) })} />
            </Field>
            <Field label={L('Teto de tokens por dia', 'Token ceiling a day')}>
              <input className="input" type="number" min={1000} step={100_000} value={draft.dailyTokens} onChange={(e) => patch({ dailyTokens: Number(e.target.value) })} />
            </Field>
          </div>

          <Field label={L('Onde ele pode olhar', 'Where it may look')} hint={L('Só o que você já vê. Vazio: só esta conversa.', 'Only what you already see. Empty: this conversation alone.')} group>
            <div className="initiative__pick">
              {reach.map((c) => (
                <label key={c.id} className="initiative__check">
                  <input
                    type="checkbox"
                    checked={draft.observe.conversations.includes(c.id)}
                    onChange={() =>
                      patch({
                        observe: { conversations: toggleIn(draft.observe.conversations, c.id) },
                        // What it may act in never passes what it may read: both go together here.
                        work: { ...draft.work, conversations: toggleIn(draft.work.conversations, c.id) }
                      })
                    }
                  />
                  <span>{c.kind === 'dm' ? c.name : `#${c.name}`}</span>
                </label>
              ))}
            </div>
          </Field>

          <Field label={L('O que ele pode fazer fora daqui', 'What it may do out there')} hint={L('A Autonomia do bot decide cada chamada; isto só estreita.', "The bot's Autonomy decides every call; this only narrows it.")} group>
            <div className="initiative__pick">
              {ACTION_KINDS.map((k) => (
                <label key={k} className="initiative__check">
                  <input type="checkbox" checked={draft.work.kinds.includes(k)} onChange={() => patch({ work: { ...draft.work, kinds: toggleIn(draft.work.kinds, k) } })} />
                  <span>{actionVerb(k)}</span>
                </label>
              ))}
            </div>
          </Field>

          <div className="initiative__buttons">
            <button className="btn btn--primary btn--sm" disabled={!!busy || !draft.brief.trim()} onClick={() => void save()}>
              {busy === 'save' ? L('Salvando…', 'Saving…') : L('Salvar', 'Save')}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={onClose}>
              {L('Fechar', 'Close')}
            </button>
          </div>

          <Commitments
            items={view.commitments}
            onSave={(c) => void saveCommitment(c).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
            onOpen={(id) => {
              openDialog(null)
              navigate({ kind: 'conversation', id })
            }}
          />
          <Activity wakes={view.wakes} />
        </div>
      )}
    </Modal>
  )
}

// Why a check-in did not start, in words a person can act on.
const whyNot = (why?: string): string =>
  why === 'paused'
    ? L('O app está pausado.', 'The app is paused.')
    : why === 'busy'
      ? L('Já tem uma conferida rodando.', 'One is already running.')
      : why === 'cap'
        ? L('As conferidas de hoje acabaram.', "Today's check-ins are spent.")
        : why === 'allowance'
          ? L('O teto de tokens de hoje acabou.', "Today's token ceiling is spent.")
          : why === 'off'
            ? L('Ligue a iniciativa primeiro.', 'Turn initiative on first.')
            : L('Não deu pra começar agora.', "Couldn't start it now.")

// ---------- what it holds ----------

function Commitments({ items, onSave, onOpen }: { items: Commitment[]; onSave: (c: CommitmentInput) => void; onOpen: (conversationId: string) => void }): ReactNode {
  const live = items.filter((c) => c.state !== 'dismissed' && c.state !== 'done')
  const closed = items.filter((c) => c.state === 'dismissed' || c.state === 'done')
  return (
    <Card title={L('O que ele está tocando', "What it's carrying")} lead={live.length ? undefined : L('Nada em aberto.', 'Nothing open.')}>
      <ul className="initiative__list">
        {[...live, ...closed].map((c) => (
          <li key={c.id} className={`initiative__item ${c.state === 'done' || c.state === 'dismissed' ? 'is-closed' : ''}`}>
            <div className="initiative__item-top">
              <span className={`initiative__pill state-${c.state}`}>{STATE(c.state)}</span>
              <span className="initiative__desc">{c.description}</span>
            </div>
            {c.note && <p className="small muted">{c.note}</p>}
            {c.links.length > 0 && (
              <p className="small muted">
                {L('depende de', 'rests on')}: {c.links.map((l) => `${l.kind} ${l.id.slice(0, 8)}`).join(', ')}
              </p>
            )}
            <div className="initiative__item-actions">
              {/* Where it was read: the person goes there rather than hunting for it. */}
              <button className="btn btn--ghost btn--sm" onClick={() => onOpen(c.conversationId)}>
                {L('Abrir conversa', 'Open conversation')}
              </button>
              {c.state !== 'done' && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => onSave({ id: c.id, agentId: c.agentId, conversationId: c.conversationId, by: c.by, description: c.description, scope: c.scope, state: 'done', evidence: c.evidence, links: c.links })}
                >
                  {L('Concluir', 'Mark done')}
                </button>
              )}
              {c.state !== 'dismissed' && c.state !== 'done' && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => onSave({ id: c.id, agentId: c.agentId, conversationId: c.conversationId, by: c.by, description: c.description, scope: c.scope, state: 'dismissed', evidence: c.evidence, links: c.links })}
                >
                  {L('Dispensar', 'Dismiss')}
                </button>
              )}
              {c.state === 'done' && (
                <button
                  className="btn btn--ghost btn--sm"
                  onClick={() => onSave({ id: c.id, agentId: c.agentId, conversationId: c.conversationId, by: c.by, description: c.description, scope: c.scope, state: 'open', evidence: c.evidence, links: c.links })}
                >
                  {L('Reabrir', 'Reopen')}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ---------- what it did ----------

function Activity({ wakes }: { wakes: InitiativeWake[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const shown = open ? wakes : wakes.slice(0, 6)
  return (
    <Card title={L('O que ele fez', 'What it did')} lead={wakes.length ? L('As últimas conferidas, da mais nova pra mais velha.', 'The last check-ins, newest first.') : L('Ainda não conferiu nada.', "It hasn't checked yet.")}>
      <ol className="initiative__runs">
        {shown.map((w) => (
          <li key={w.id} className={`initiative__run outcome-${w.outcome} ${w.deduped ? 'is-deduped' : ''}`}>
            <span className="initiative__when">{when(w.at)}</span>
            <span className="initiative__why">{WHY(w)}</span>
            {w.text && w.outcome !== 'quiet' && <span className="initiative__said">{w.text.length > 240 ? `${w.text.slice(0, 240)}…` : w.text}</span>}
            <span className="initiative__cost">{w.tokens ? `${tokens(w.tokens)} tokens` : ''}</span>
          </li>
        ))}
      </ol>
      {wakes.length > 6 && (
        <button className="btn btn--ghost btn--sm" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? L('Mostrar menos', 'Show less') : L(`Mostrar tudo (${wakes.length})`, `Show all (${wakes.length})`)}
        </button>
      )}
    </Card>
  )
}
