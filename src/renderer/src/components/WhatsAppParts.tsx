// WhatsApp for agents, the small pieces the number's screen is built from: its cards (who may use it,
// what happens when a message arrives, the limits, the official API's address) and the helpers they share.
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ALL_CHATS, LIMITS, type WhatsAppAccess, type WhatsAppChat, type WhatsAppNumber, type WhatsAppSettings, type WhatsAppTemplate } from '../../../shared/whatsapp'
import { call } from '../rpc'
import { isTeam, toast, type Agent } from '../store'
import { confirmDialog } from './Dialogs'
import { Card, Toggle } from './Pages'
import { Select } from './Select'
import { AgentAvatar, Icon, UsageBar } from './ui'

// What a person reads when a call failed: the core's sentence, without the transport's prefix.
export const errText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export const phoneText = (digits?: string): string => (digits ? `+${digits}` : '')

const initialsOf = (name: string): string => {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const letters = words.length > 1 ? `${words[0]![0] ?? ''}${words[1]![0] ?? ''}` : (words[0] ?? '').slice(0, 2)
  return letters.toUpperCase() || '?'
}

// The chat bubble of WhatsApp, drawn like the app's other icons.
export function WaIcon({ size = 18 }: { size?: number }): ReactNode {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20l1.3-4.1A8 8 0 1 1 8.4 19L4 20z" />
      <path d="M9.2 8.6c-.5 2.6 3 6 5.8 6l1-1.6-1.9-1-.9.8c-.9-.3-1.9-1.3-2.2-2.2l.8-.9-1-1.9-1.6.8z" />
    </svg>
  )
}

export function StatusTag({ n }: { n: WhatsAppNumber }): ReactNode {
  if (n.status === 'connected') return <span className="tag tag--ok">{L('Conectado', 'Connected')}</span>
  if (n.status === 'connecting')
    return (
      <span className="tag wa-tag-live">
        <span className="pulse" />
        {L('Conectando…', 'Connecting…')}
      </span>
    )
  if (n.status === 'pairing') return <span className="tag tag--warn">{L('Esperando o celular', 'Waiting for the phone')}</span>
  return <span className="tag tag--warn">{L('Desconectado', 'Disconnected')}</span>
}

export function KindTag({ kind }: { kind: WhatsAppNumber['kind'] }): ReactNode {
  return kind === 'cloud' ? <span className="tag tag--agent">{L('API oficial', 'Official API')}</span> : <span className="tag">{L('QR code', 'QR code')}</span>
}

function Who({ chat, all }: { chat?: WhatsAppChat; all?: boolean }): ReactNode {
  if (all) return <span className="wa-who"><Icon name="users" size={15} /></span>
  return <span className={`wa-who ${chat?.kind === 'group' ? 'wa-who--group' : ''}`}>{initialsOf(chat?.name ?? '?')}</span>
}

// "Grupo · 42" / "Contato", the small tag beside a conversation's name.
export function ChatKind({ chat }: { chat: WhatsAppChat }): ReactNode {
  return <span className="tag">{chat.kind === 'group' ? (chat.size ? L(`Grupo · ${chat.size}`, `Group · ${chat.size}`) : L('Grupo', 'Group')) : L('Contato', 'Contact')}</span>
}

export const ChatWho = Who

// A text that is typed locally and saved when you leave the field: a screen that reads again
// (a number's status changed) must not wipe what is being typed.
export function DraftText({ value, onCommit, label, multiline, maxLength, placeholder, required, className }: {
  value: string
  onCommit: (v: string) => void
  label: string
  multiline?: boolean
  maxLength: number
  placeholder?: string
  required?: boolean
  className?: string
}): ReactNode {
  const [text, setText] = useState(value)
  const [empty, setEmpty] = useState(false)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(value)
  }, [value])
  const finish = (): void => {
    focused.current = false
    const next = text.trim()
    // A required field left empty is not saved: it says so until the person types again.
    if (required && !next) return setEmpty(true)
    setEmpty(false)
    if (next === value.trim()) return setText(value)
    setText(next)
    onCommit(next)
  }
  const shared = {
    value: text,
    maxLength,
    placeholder,
    className,
    'aria-label': label,
    'aria-invalid': empty || undefined,
    onFocus: () => { focused.current = true },
    onBlur: finish,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setEmpty(false)
      setText(e.target.value)
    }
  }
  const field = multiline ? (
    <textarea {...shared} rows={2} />
  ) : (
    <input {...shared} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
  )
  return empty ? (
    <>
      {field}
      <span className="field__error" role="alert">{L('Esse campo não pode ficar vazio.', 'This field can’t be empty.')}</span>
    </>
  ) : (
    field
  )
}

// A number typed as digits only. `onCommit` brings it inside what is allowed and answers with the
// number kept, which is what the field then shows.
export function DigitsField({ value, onCommit, label }: { value: number; onCommit: (n: number) => number; label: string }): ReactNode {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])
  const finish = (): void => {
    focused.current = false
    const n = Number(text)
    if (!text || !Number.isFinite(n)) return setText(String(value))
    // The same number as before: nothing to save, so no call and no "Salvo".
    if (n === value) return setText(String(value))
    setText(String(onCommit(n)))
  }
  return (
    <input
      className="wa-digits"
      inputMode="numeric"
      pattern="[0-9]*"
      aria-label={label}
      value={text}
      onFocus={() => { focused.current = true }}
      onChange={(e) => setText(e.target.value.replace(/\D/g, '').slice(0, 7))}
      onBlur={finish}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
    />
  )
}

// ---------- who may use the number ----------

function AccessRow({ n, a, onChange, onRemove }: { n: WhatsAppNumber; a: WhatsAppAccess; onChange: (patch: Partial<WhatsAppAccess>) => void; onRemove: () => void }): ReactNode {
  const all = a.chat === ALL_CHATS
  const chat = all ? undefined : n.chats.find((c) => c.id === a.chat)
  const name = all ? L('Todas as conversas', 'Every conversation') : (chat?.name ?? L('Conversa sem nome', 'Unnamed conversation'))
  return (
    <div className="wa-chat">
      <div className="wa-chat__who">
        <Who chat={chat} all={all} />
        <div className="grow">
          <strong className="wa-chat__name">{name}</strong> {chat && <ChatKind chat={chat} />}
          {all && <div className="muted small">{L('Quem escrever para este número, inclusive gente nova.', 'Whoever writes to this number, including new people.')}</div>}
        </div>
      </div>
      <div className="wa-chat__ctl">
        <div className="segmented" role="radiogroup" aria-label={L('O que o agente pode fazer', 'What the agent may do')}>
          <button type="button" role="radio" aria-checked={a.level === 'read'} className={a.level === 'read' ? 'is-active' : ''} onClick={() => a.level !== 'read' && onChange({ level: 'read', send: 'ask' })}>
            {L('Só ler', 'Read only')}
          </button>
          <button type="button" role="radio" aria-checked={a.level === 'reply'} className={a.level === 'reply' ? 'is-active' : ''} onClick={() => a.level !== 'reply' && onChange({ level: 'reply' })}>
            {L('Ler e responder', 'Read and reply')}
          </button>
        </div>
        {a.level === 'reply' && (
          <div className="wa-select">
            <Select
              aria-label={L('Como a resposta sai', 'How the answer leaves')}
              value={a.send}
              onChange={(v) => onChange({ send: v === 'auto' ? 'auto' : 'ask' })}
              options={[
                { value: 'ask', label: L('Pede aprovação', 'Asks for approval') },
                { value: 'auto', label: L('Envia sozinho', 'Sends on its own') }
              ]}
            />
          </div>
        )}
        <button className="icon-btn icon-btn--sm" title={L('Tirar esta conversa', 'Remove this conversation')} aria-label={L('Tirar esta conversa', 'Remove this conversation')} onClick={onRemove}>
          <Icon name="x" size={14} />
        </button>
      </div>
      {all && a.level === 'reply' && a.send === 'auto' && (
        <p className="hint hint--warn wa-chat__warn">
          <Icon name="shield" size={13} />
          {L('Vale para qualquer pessoa. A primeira mensagem para alguém novo continua pedindo aprovação.', 'It applies to anyone. The first message to someone new still asks for approval.')}
        </p>
      )}
    </div>
  )
}

export function AccessCard({ n, agents, onAccess, onPick }: {
  n: WhatsAppNumber
  agents: Agent[]
  // Changes the list by what it is now: the screen applies the change to the newest copy of it.
  onAccess: (edit: (rows: WhatsAppAccess[]) => WhatsAppAccess[]) => void
  onPick: (agentId: string) => void
}): ReactNode {
  const byAgent = new Map<string, WhatsAppAccess[]>()
  for (const a of n.access) byAgent.set(a.agentId, [...(byAgent.get(a.agentId) ?? []), a])
  // The "every conversation" row first, then the others in the order they were given.
  const ordered = (rows: WhatsAppAccess[]): WhatsAppAccess[] => [...rows.filter((r) => r.chat === ALL_CHATS), ...rows.filter((r) => r.chat !== ALL_CHATS)]
  const free = agents.filter((a) => isTeam(a) && !byAgent.has(a.id))
  const same = (x: WhatsAppAccess, y: WhatsAppAccess): boolean => x.agentId === y.agentId && x.chat === y.chat
  const adder = (
    <div className="wa-select wa-select--add">
      <Select
        aria-label={L('Adicionar agente', 'Add agent')}
        placeholder={free.length ? L('Adicionar agente', 'Add agent') : L('Todos já estão aqui', 'All of them are here')}
        value={null}
        disabled={free.length === 0}
        onChange={(v) => v && onPick(v)}
        options={free.map((a) => ({ value: a.id, label: a.role ? `${a.name} · ${a.role}` : a.name }))}
      />
    </div>
  )
  const removeAgent = async (agentId: string, name: string): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Tirar ${name} deste número?`, `Remove ${name} from this number?`),
      body: L('Ele deixa de ler e de enviar por aqui. Você pode liberar de novo quando quiser.', 'It stops reading and sending through here. You can allow it again any time.'),
      confirm: L('Tirar', 'Remove'),
      danger: true
    })
    if (ok) onAccess((rows) => rows.filter((r) => r.agentId !== agentId))
  }
  return (
    <Card title={L('Quem pode usar', 'Who can use it')} lead={L('O agente não enxerga nenhuma conversa fora desta lista.', 'The agent can’t see any conversation outside this list.')} action={byAgent.size > 0 ? adder : undefined}>
      {byAgent.size === 0 ? (
        <div className="wa-empty">
          <p>
            <strong>{L('Nenhum agente tem acesso ainda.', 'No agent has access yet.')}</strong>
          </p>
          <p className="muted small">{agents.some(isTeam) ? L('Escolha um agente e depois as conversas que ele pode usar.', 'Pick an agent, then the conversations it may use.') : L('Crie um agente primeiro. Depois volte aqui para liberar este número.', 'Create an agent first. Then come back here to allow this number.')}</p>
          {adder}
        </div>
      ) : (
        [...byAgent.entries()].map(([agentId, rows]) => {
          const agent = agents.find((a) => a.id === agentId)
          const name = agent?.name ?? L('Agente removido', 'Removed agent')
          return (
            <div className="wa-agent" key={agentId}>
              <div className="wa-agent__head">
                {agent ? <AgentAvatar agent={agent} size={28} still /> : <span className="wa-who"><Icon name="user" size={15} /></span>}
                <div className="grow">
                  <strong>{name}</strong> {agent?.role && <span className="muted small">{agent.role}</span>}
                </div>
                {agent && isTeam(agent) && (
                  <button className="btn btn--sm btn--ghost" onClick={() => onPick(agentId)}>
                    <Icon name="plus" size={14} />
                    {L('Liberar conversa', 'Allow a conversation')}
                  </button>
                )}
                <button className="icon-btn icon-btn--sm" title={L('Tirar este agente', 'Remove this agent')} aria-label={L('Tirar este agente', 'Remove this agent')} onClick={() => void removeAgent(agentId, name)}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
              {ordered(rows).map((a) => (
                <AccessRow
                  key={a.chat}
                  n={n}
                  a={a}
                  onChange={(patch) => onAccess((rows) => rows.map((r) => (same(r, a) ? { ...r, ...patch } : r)))}
                  onRemove={() => onAccess((rows) => rows.filter((r) => !same(r, a)))}
                />
              ))}
            </div>
          )
        })
      )}
    </Card>
  )
}

// ---------- when a message arrives ----------

export function InboundCard({ n, onSettings }: { n: WhatsAppNumber; onSettings: (patch: Partial<WhatsAppSettings>) => void }): ReactNode {
  const s = n.settings
  const choice = (id: WhatsAppSettings['inbound'], title: ReactNode, text: string): ReactNode => (
    <button type="button" role="radio" aria-checked={s.inbound === id} className={`wa-choice ${s.inbound === id ? 'is-on' : ''}`} onClick={() => s.inbound !== id && onSettings({ inbound: id })}>
      <strong>{title}</strong>
      <span>{text}</span>
    </button>
  )
  return (
    <Card title={L('Quando chega uma mensagem', 'When a message arrives')} lead={L('Vale para as conversas com “Ler e responder”.', 'It applies to the conversations set to “Read and reply”.')}>
      <div className="wa-choices" role="radiogroup" aria-label={L('Quando chega uma mensagem', 'When a message arrives')}>
        {choice('store', L('Só guarda', 'Only keeps it'), L('A mensagem fica guardada. O agente lê quando você pedir ou numa rotina.', 'The message is kept. The agent reads it when you ask or in a routine.'))}
        {choice(
          'wake',
          <>
            {L('Avisa o agente', 'Tells the agent')} <span className="tag tag--agent">{L('Recomendado', 'Recommended')}</span>
          </>,
          L('O agente é avisado na hora e prepara a resposta. Ela espera você ou sai sozinha, conforme o que você marcou em cada conversa.', 'The agent is told right away and prepares the answer. It waits for you or goes on its own, depending on what you set for each conversation.')
        )}
      </div>
      {n.kind === 'qr' && (
        <div className="wa-toggles">
          <div className="key-row" role="group" aria-labelledby="wa-groups-title">
            <div className="grow">
              <strong id="wa-groups-title">{L('Em grupos, só quando chamarem o número', 'In groups, only when the number is called')}</strong>
              <p className="muted small">{L('Responde a quem marcar o número ou responder a uma mensagem dele. Não a toda mensagem do grupo.', 'It answers whoever mentions the number or replies to one of its messages, not every message in the group.')}</p>
            </div>
            <Toggle on={s.groupsOnlyMention} onChange={(v) => onSettings({ groupsOnlyMention: v })} />
          </div>
          <div className="key-row" role="group" aria-labelledby="wa-pause-title">
            <div className="grow">
              <strong id="wa-pause-title">{L('Pausar quando eu responder pelo celular', 'Pause when I answer from the phone')}</strong>
              <p className="muted small">
                {s.pauseOnHumanMin > 0
                  ? L(`Se você entrar na conversa, os agentes ficam quietos nela por ${s.pauseOnHumanMin} minutos.`, `If you step into the conversation, the agents stay quiet there for ${s.pauseOnHumanMin} minutes.`)
                  : L('Desligado: os agentes continuam mesmo se você responder.', 'Off: the agents carry on even if you answer.')}
              </p>
            </div>
            <Toggle on={s.pauseOnHumanMin > 0} onChange={(v) => onSettings({ pauseOnHumanMin: v ? 30 : 0 })} />
          </div>
        </div>
      )}
    </Card>
  )
}

// ---------- limits ----------

export function LimitsCard({ n, onSettings }: { n: WhatsAppNumber; onSettings: (patch: Partial<WhatsAppSettings>) => WhatsAppSettings }): ReactNode {
  const max = LIMITS[n.kind]
  const s = n.settings
  // The screen clamps the change (the new-conversations ceiling follows the daily one) and answers with
  // what was kept, which is what the field shows.
  const commit = (field: 'dailyLimit' | 'newChatsLimit', v: number): number =>
    onSettings(field === 'dailyLimit' ? { dailyLimit: v } : { newChatsLimit: v })[field]
  const fmt = (v: number): string => v.toLocaleString()
  return (
    <Card title={L('Limites', 'Limits')} lead={L('Quantas mensagens os agentes mandam por este número em um dia.', 'How many messages the agents send from this number in a day.')}>
      <div className="wa-limits">
        <div className="wa-limit">
          <span className="field__label">{L('Mensagens por dia', 'Messages per day')}</span>
          <DigitsField label={L('Mensagens por dia', 'Messages per day')} value={s.dailyLimit} onCommit={(v) => commit('dailyLimit', v)} />
          <UsageBar used={n.sentToday} limit={s.dailyLimit} />
          <span className="muted small">{L(`Hoje: ${fmt(n.sentToday)} de ${fmt(s.dailyLimit)}`, `Today: ${fmt(n.sentToday)} of ${fmt(s.dailyLimit)}`)}</span>
          <span className="hint wa-limit__max">{L(`No máximo ${fmt(max.dailyMax)}`, `At most ${fmt(max.dailyMax)}`)}</span>
        </div>
        <div className="wa-limit">
          <span className="field__label">{L('Conversas novas por dia', 'New conversations per day')}</span>
          <DigitsField label={L('Conversas novas por dia', 'New conversations per day')} value={s.newChatsLimit} onCommit={(v) => commit('newChatsLimit', v)} />
          <span className="hint">{L('Conversa nova é com alguém que nunca escreveu para este número. Essa primeira mensagem sempre pede a sua aprovação.', 'A new conversation is with someone who never wrote to this number. That first message always asks for your approval.')}</span>
          <UsageBar used={n.newToday} limit={s.newChatsLimit} />
          <span className="muted small">{L(`Hoje: ${fmt(n.newToday)} de ${fmt(s.newChatsLimit)}`, `Today: ${fmt(n.newToday)} of ${fmt(s.newChatsLimit)}`)}</span>
          <span className="hint wa-limit__max">{L(`No máximo ${fmt(Math.min(s.dailyLimit, max.newChatsMax))}`, `At most ${fmt(Math.min(s.dailyLimit, max.newChatsMax))}`)}</span>
          <span className="hint">{L('Nunca passa do limite de mensagens por dia.', 'Never above the messages-per-day limit.')}</span>
        </div>
      </div>
      <p className="hint hint--text wa-why">
        {n.kind === 'qr'
          ? L('Um número ligado por QR code não foi feito para envio em massa: o WhatsApp bloqueia números que se comportam como disparador. Por isso o Tucano segura o ritmo e espera alguns segundos entre uma mensagem e outra.', 'A number linked by QR code isn’t made for bulk sending: WhatsApp blocks numbers that behave like a sender. That’s why Tucano keeps the pace and waits a few seconds between messages.')
          : L('A API oficial é a que aguenta volume, dentro das regras da Meta: passado um dia da última mensagem da pessoa, só vai mensagem modelo aprovada, e a Meta tem os próprios limites.', 'The official API is the one for volume, within Meta’s rules: a day after the person’s last message, only an approved template goes, and Meta has its own limits.')}
      </p>
      <div className="key-row">
        <Icon name="lock" size={16} />
        <div className="grow">
          <strong>{L('Primeira mensagem para alguém novo pede aprovação', 'The first message to someone new asks for approval')}</strong>
          <p className="muted small">{L('Sempre, mesmo em conversa marcada como “Envia sozinho”.', 'Always, even in a conversation set to “Sends on its own”.')}</p>
        </div>
      </div>
    </Card>
  )
}

// ---------- the official API: address for Meta, templates ----------

function CopyRow({ label, value }: { label: string; value: string }): ReactNode {
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast(L('Copiado.', 'Copied.'))
    } catch {
      toast(L('Não consegui copiar. Selecione o texto e copie à mão.', 'I couldn’t copy. Select the text and copy it by hand.'))
    }
  }
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="row">
        <input className="grow mono" readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn btn--sm" onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          {L('Copiar', 'Copy')}
        </button>
      </div>
    </div>
  )
}

export function CloudCard({ n, webhookUrl, verifyToken }: { n: WhatsAppNumber; webhookUrl?: string; verifyToken?: string }): ReactNode {
  const [templates, setTemplates] = useState<WhatsAppTemplate[] | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)
  const load = async (): Promise<void> => {
    const mine = ++seq.current
    setError('')
    try {
      const list = await call('whatsappTemplates', { id: n.id })
      if (mine === seq.current) setTemplates(list)
    } catch (e) {
      if (mine === seq.current) setError(errText(e))
    }
  }
  useEffect(() => {
    void load()
  }, [n.id, n.status])
  return (
    <Card title={L('API oficial: endereço e modelos', 'Official API: address and templates')} lead={L('A Meta avisa o Tucano de cada mensagem nova por este endereço (webhook).', 'Meta tells Tucano about each new message through this address (webhook).')}>
      {webhookUrl && verifyToken ? (
        <>
          <ol className="small steps-list">
            <li>{L('No painel da Meta, abra o seu app e vá em WhatsApp › Configuração.', 'In Meta’s panel, open your app and go to WhatsApp › Configuration.')}</li>
            <li>{L('Em “Webhook”, cole o endereço e o código de verificação abaixo.', 'Under “Webhook”, paste the address and verification code below.')}</li>
            <li>{L('Assine o campo “messages”.', 'Subscribe to the “messages” field.')}</li>
          </ol>
          <CopyRow label={L('Endereço do webhook', 'Webhook address')} value={webhookUrl} />
          <CopyRow label={L('Código de verificação', 'Verification code')} value={verifyToken} />
        </>
      ) : (
        <p className="muted small">{L('O endereço aparece aqui quando o Tucano estiver num servidor com https.', 'The address shows up here when Tucano runs on a server with https.')}</p>
      )}
      <div className="wa-templates">
        <strong>{L('Mensagens modelo aprovadas', 'Approved templates')}</strong>
        {error ? (
          <div className="note note--error">
            <p>{error}</p>
            <button className="btn btn--sm" onClick={() => void load()}>{L('Tentar de novo', 'Try again')}</button>
          </div>
        ) : templates === null ? (
          <p className="muted small"><span className="spinner wa-inline-spinner" />{L('Buscando na Meta…', 'Fetching from Meta…')}</p>
        ) : templates.length === 0 ? (
          <p className="muted small">{L('Nenhum modelo aprovado ainda. Crie um no painel da Meta: é com ele que se começa uma conversa.', 'No approved template yet. Create one in Meta’s panel: that’s how a conversation starts.')}</p>
        ) : (
          <div className="table">
            {templates.map((t) => (
              <div className="table__row wa-template" key={`${t.name}/${t.language}`}>
                <div className="grow">
                  <div className="row wa-wrap">
                    <strong className="mono">{t.name}</strong>
                    <span className="tag">{t.language}</span>
                    {t.variables > 0 && <span className="tag">{L(`${t.variables} variáveis`, `${t.variables} variables`)}</span>}
                  </div>
                  <div className="muted small wa-template__body">{t.body}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  )
}

// ---------- the send an agent asks approval for (Conversation.tsx) ----------

// The message as it will look in WhatsApp, not as JSON. A template goes by its name and values.
export function WhatsAppSend({ args }: { args: Record<string, unknown> }): ReactNode {
  const text = typeof args['texto'] === 'string' ? args['texto'] : ''
  const model = typeof args['modelo'] === 'object' && args['modelo'] !== null ? (args['modelo'] as Record<string, unknown>) : undefined
  const raw: unknown = model?.['variaveis']
  const values = Array.isArray(raw) ? raw.map(String).join(', ') : ''
  const first = args['primeiro_contato'] === true
  return (
    <div className="wa-send">
      {first && (
        <p className="wa-send__first">
          <span className="tag tag--warn">{L('Primeiro contato', 'First contact')}</span>
          <span className="muted small">{L('Essa pessoa nunca escreveu para este número.', 'This person has never written to this number.')}</span>
        </p>
      )}
      <div className="wa-bubble">
        {model ? (
          <>
            <strong>{L('Mensagem modelo', 'Template message')} “{String(model['nome'] ?? '')}”</strong>
            {values && <div>{values}</div>}
          </>
        ) : (
          text
        )}
      </div>
    </div>
  )
}
