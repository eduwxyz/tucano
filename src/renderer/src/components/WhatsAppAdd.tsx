// WhatsApp for agents, the two windows over a number's screen: adding a number, and choosing
// which conversations an agent may use.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ALL_CHATS, DESCRIPTION_MAX, NAME_MAX, type WhatsAppAccess, type WhatsAppChat, type WhatsAppCloudInput, type WhatsAppLevel, type WhatsAppNumber, type WhatsAppState } from '../../../shared/whatsapp'
import { call } from '../rpc'
import { useStore, type Agent } from '../store'
import { Modal } from './Modal'
import { ChatWho, errText } from './WhatsAppParts'
import { AgentAvatar, Icon, ago } from './ui'

// ---------- adding a number ----------

const EMPTY_KEYS: WhatsAppCloudInput = { phoneId: '', wabaId: '', token: '', appSecret: '' }

export function AddNumber({ cloud, onClose, onAdded }: { cloud: WhatsAppState['cloud']; onClose: () => void; onAdded: (n: WhatsAppNumber) => void }): ReactNode {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<'qr' | 'cloud'>('qr')
  const [keys, setKeys] = useState<WhatsAppCloudInput>(EMPTY_KEYS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const filled = kind === 'qr' || Object.values(keys).every((v) => v.trim())
  const ready = name.trim().length > 0 && filled
  const key = (k: keyof WhatsAppCloudInput, v: string): void => setKeys((cur) => ({ ...cur, [k]: v }))

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      const trimmed: WhatsAppCloudInput = { phoneId: keys.phoneId.trim(), wabaId: keys.wabaId.trim(), token: keys.token.trim(), appSecret: keys.appSecret.trim() }
      const n = await call('whatsappAdd', { number: { name: name.trim(), description: description.trim(), kind, ...(kind === 'cloud' ? { cloud: trimmed } : {}) } })
      onAdded(n)
    } catch (err) {
      setError(errText(err))
      setBusy(false)
    }
  }

  const fields: { k: keyof WhatsAppCloudInput; label: string; where: string; secret?: boolean }[] = [
    { k: 'phoneId', label: L('ID do número de telefone', 'Phone number ID'), where: L('No painel do seu app na Meta: WhatsApp › Configuração da API, logo abaixo do número.', 'In your app’s panel at Meta: WhatsApp › API Setup, right under the number.') },
    { k: 'wabaId', label: L('ID da conta do WhatsApp Business', 'WhatsApp Business account ID'), where: L('Na mesma página, em “ID da conta do WhatsApp Business”. É de lá que vêm os modelos de mensagem.', 'On the same page, under “WhatsApp Business Account ID”. The message templates come from there.') },
    { k: 'token', label: L('Token de acesso', 'Access token'), where: L('Em Configurações do negócio › Usuários do sistema, gere um token que não expira.', 'In Business settings › System users, generate a token that doesn’t expire.'), secret: true },
    { k: 'appSecret', label: L('Chave secreta do app', 'App secret'), where: L('No painel do app: Configurações › Básico › Chave secreta do app.', 'In the app’s panel: Settings › Basic › App secret.'), secret: true }
  ]

  return (
    <Modal title={L('Adicionar número', 'Add a number')} onClose={busy ? () => undefined : onClose} className="wa-modal">
      <form className="wa-modal__body" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span className="field__label">{L('Nome', 'Name')}</span>
          <input autoFocus value={name} maxLength={NAME_MAX} placeholder={L('Ex.: Atendimento', 'E.g. Support')} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">{L('Para que serve (os agentes leem isto)', 'What it’s for (the agents read this)')}</span>
          <textarea rows={2} value={description} maxLength={DESCRIPTION_MAX} placeholder={L('Ex.: Suporte aos alunos e grupos das turmas.', 'E.g. Support for students and class groups.')} onChange={(e) => setDescription(e.target.value)} />
        </label>

        <span className="field__label wa-modal__label">{L('Como conectar', 'How to connect')}</span>
        <div className="wa-opts" role="radiogroup" aria-label={L('Como conectar', 'How to connect')}>
          <button type="button" role="radio" aria-checked={kind === 'qr'} className={`wa-opt ${kind === 'qr' ? 'is-on' : ''}`} onClick={() => setKind('qr')}>
            <strong>{L('Escanear QR code', 'Scan a QR code')} <span className="tag tag--ok">{L('Pronto em 1 minuto', 'Ready in 1 minute')}</span></strong>
            <ul>
              <li><b className="wa-yes">✓</b>{L('Usa um WhatsApp que você já tem', 'Uses a WhatsApp you already have')}</li>
              <li><b className="wa-yes">✓</b>{L('Contatos e grupos', 'Contacts and groups')}</li>
              <li><b className="wa-no">!</b>{L('Não é oficial: sem envio em massa, ou o número pode ser bloqueado', 'Not official: no bulk sending, or the number may get blocked')}</li>
            </ul>
          </button>
          <button type="button" role="radio" aria-checked={kind === 'cloud'} disabled={!cloud.available} className={`wa-opt ${kind === 'cloud' ? 'is-on' : ''}`} onClick={() => setKind('cloud')}>
            <strong>{L('API oficial da Meta', 'Meta’s official API')} <span className="tag">{L('Para volume', 'For volume')}</span></strong>
            <ul>
              <li><b className="wa-yes">✓</b>{L('Oficial, sem risco de bloqueio', 'Official, no risk of a block')}</li>
              <li><b className="wa-no">!</b>{L('Só contatos, sem grupos', 'Contacts only, no groups')}</li>
              <li><b className="wa-no">!</b>{L('Pede conta Meta Business e o Tucano num servidor', 'Needs a Meta Business account and Tucano on a server')}</li>
            </ul>
            {!cloud.available && <span className="wa-opt__why">{cloud.why || L('Só funciona com o Tucano num servidor com https.', 'Only works with Tucano on a server with https.')}</span>}
          </button>
        </div>

        {kind === 'cloud' ? (
          <div className="wa-keys">
            {fields.map((f) => (
              <label className="field" key={f.k}>
                <span className="field__label">{f.label}</span>
                <input type={f.secret ? 'password' : 'text'} autoComplete="off" value={keys[f.k]} onChange={(e) => key(f.k, e.target.value)} />
                <span className="hint">{f.where}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="hint">
            <Icon name="shield" size={13} />
            {L('Depois de adicionar, aparece um código para escanear com o celular. Nenhum agente vê nada até você liberar as conversas.', 'After adding, a code shows up to scan with the phone. No agent sees anything until you allow conversations.')}
          </p>
        )}

        {error && <p className="note note--error" role="alert">{error}</p>}
        <div className="row wa-modal__foot">
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={onClose}>{L('Cancelar', 'Cancel')}</button>
          <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
            {busy ? (kind === 'cloud' ? L('Conferindo com a Meta…', 'Checking with Meta…') : L('Adicionando…', 'Adding…')) : L('Adicionar número', 'Add number')}
          </button>
        </div>
      </form>
    </Modal>
  )
}

// ---------- choosing conversations ----------

type Filter = 'all' | 'contact' | 'group'

export function ChatPicker({ n, agent, onClose, onSubmit }: {
  n: WhatsAppNumber
  agent: Agent
  onClose: () => void
  // Saves the new rows (and the conversations' names, for the screen to show at once); throws a sentence.
  onSubmit: (rows: WhatsAppAccess[], chats: WhatsAppChat[]) => Promise<void>
}): ReactNode {
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [chats, setChats] = useState<WhatsAppChat[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [level, setLevel] = useState<WhatsAppLevel>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  // The phone's conversations arrive over time: each change to the numbers reads the list again.
  const rev = useStore((s) => s.whatsappRev)
  const known = useRef(new Map<string, WhatsAppChat>())
  const seq = useRef(0)
  const have = new Set(n.access.filter((a) => a.agentId === agent.id).map((a) => a.chat))

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const mine = ++seq.current
    setLoadError('')
    call('whatsappChats', { id: n.id, ...(query ? { q: query } : {}) })
      .then((list) => {
        if (mine !== seq.current) return
        for (const c of list) known.current.set(c.id, c)
        setChats(list)
      })
      .catch((e: unknown) => {
        if (mine === seq.current) setLoadError(errText(e))
      })
  }, [n.id, n.status, query, attempt, rev])

  const shown = (chats ?? []).filter((c) => !have.has(c.id) && (filter === 'all' || c.kind === filter) && (n.kind !== 'cloud' || c.kind === 'contact'))
  const showAll = !query && filter === 'all' && !have.has(ALL_CHATS)
  const toggle = (id: string): void =>
    setPicked((cur) => {
      const next = new Set(cur)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const submit = async (): Promise<void> => {
    if (!picked.size || busy) return
    setBusy(true)
    setError('')
    const rows: WhatsAppAccess[] = [...picked].map((chat) => ({ agentId: agent.id, chat, level, send: 'ask' }))
    const names = [...picked].flatMap((id) => {
      const c = known.current.get(id)
      return c ? [c] : []
    })
    try {
      await onSubmit(rows, names)
      onClose()
    } catch (e) {
      setError(errText(e))
      setBusy(false)
    }
  }

  const count = picked.size
  const emptyText = (): string => {
    if (query) return L('Nada com esse nome. Tente outra parte do nome.', 'Nothing with that name. Try another part of the name.')
    if (n.status !== 'connected' && n.kind === 'qr') return L('Este número ainda não está conectado. Conecte o celular para ver as conversas.', 'This number isn’t connected yet. Connect the phone to see its conversations.')
    if (n.kind === 'cloud') return L('Com a API oficial, a conversa aparece aqui depois que a pessoa escrever para o número.', 'With the official API, a conversation shows up here once the person writes to the number.')
    if (chats && chats.length > 0) return L('Não sobrou nada neste filtro. As outras conversas já estão liberadas ou estão em outra aba.', 'Nothing left in this filter. The other conversations are already allowed or in another tab.')
    return L('Ainda não apareceu nenhuma conversa. Assim que alguém escrever, ela aparece aqui.', 'No conversation has shown up yet. As soon as someone writes, it will appear here.')
  }

  return (
    <Modal title={L(`Liberar conversas para ${agent.name}`, `Allow conversations for ${agent.name}`)} onClose={busy ? () => undefined : onClose} className="wa-modal">
      <div className="wa-modal__body wa-picker">
        <div className="wa-picker__agent">
          <AgentAvatar agent={agent} size={24} still />
          <span className="muted small">{L(`${agent.name} só vai ver o que você marcar aqui.`, `${agent.name} will only see what you tick here.`)}</span>
        </div>
        <input autoFocus type="search" value={q} placeholder={L('Buscar contato ou grupo', 'Search a contact or group')} aria-label={L('Buscar contato ou grupo', 'Search a contact or group')} onChange={(e) => setQ(e.target.value)} />
        {n.kind === 'qr' && (
          <div className="wa-chips" role="radiogroup" aria-label={L('Tipo de conversa', 'Kind of conversation')}>
            {(['all', 'contact', 'group'] as const).map((f) => (
              <button key={f} type="button" role="radio" aria-checked={filter === f} className={`chip ${filter === f ? 'is-on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? L('Todos', 'All') : f === 'contact' ? L('Contatos', 'Contacts') : L('Grupos', 'Groups')}
              </button>
            ))}
          </div>
        )}

        <div className="member-list wa-picker__list">
          {showAll && (
            <button type="button" className={`member ${picked.has(ALL_CHATS) ? 'is-on' : ''}`} aria-pressed={picked.has(ALL_CHATS)} onClick={() => toggle(ALL_CHATS)}>
              <span className="member__check">{picked.has(ALL_CHATS) && <Icon name="check" size={12} />}</span>
              <ChatWho all />
              <span className="member__text grow">
                <strong>{L('Todas as conversas', 'Every conversation')}</strong>
                <span className="muted small">{L('Quem escrever para o número, inclusive gente nova', 'Whoever writes to the number, including new people')}</span>
              </span>
            </button>
          )}
          {shown.map((c) => (
            <button type="button" key={c.id} className={`member ${picked.has(c.id) ? 'is-on' : ''}`} aria-pressed={picked.has(c.id)} onClick={() => toggle(c.id)}>
              <span className="member__check">{picked.has(c.id) && <Icon name="check" size={12} />}</span>
              <ChatWho chat={c} />
              <span className="member__text grow">
                <strong className="wa-chat__name">{c.name}</strong>
                <span className="muted small">
                  {c.kind === 'group' ? (c.size ? L(`Grupo · ${c.size} pessoas`, `Group · ${c.size} people`) : L('Grupo', 'Group')) : L('Contato', 'Contact')}
                  {c.lastAt ? ` · ${ago(c.lastAt)}` : ''}
                </span>
              </span>
            </button>
          ))}
          {chats === null && !loadError && (
            <p className="wa-picker__note muted small"><span className="spinner wa-inline-spinner" />{L('Buscando as conversas…', 'Looking for the conversations…')}</p>
          )}
          {loadError && (
            <div className="wa-picker__note note note--error">
              <p>{loadError}</p>
              <button className="btn btn--sm" onClick={() => setAttempt((a) => a + 1)}>{L('Tentar de novo', 'Try again')}</button>
            </div>
          )}
          {chats !== null && !loadError && shown.length === 0 && !showAll && <p className="wa-picker__note muted small">{emptyText()}</p>}
        </div>

        {picked.has(ALL_CHATS) && (
          <p className="hint hint--warn">
            <Icon name="shield" size={13} />
            {L(`Com “Todas as conversas”, ${agent.name} lê tudo o que chegar neste número. Prefira marcar só o que ele precisa.`, `With “Every conversation”, ${agent.name} reads everything that reaches this number. Prefer ticking only what it needs.`)}
          </p>
        )}
        {error && <p className="note note--error" role="alert">{error}</p>}
        <div className="row row--between wa-wrap wa-modal__foot">
          <div className="segmented" role="radiogroup" aria-label={L('O que o agente pode fazer', 'What the agent may do')}>
            <button type="button" role="radio" aria-checked={level === 'read'} className={level === 'read' ? 'is-active' : ''} onClick={() => setLevel('read')}>{L('Só ler', 'Read only')}</button>
            <button type="button" role="radio" aria-checked={level === 'reply'} className={level === 'reply' ? 'is-active' : ''} onClick={() => setLevel('reply')}>{L('Ler e responder', 'Read and reply')}</button>
          </div>
          <button className="btn btn--primary" disabled={count === 0 || busy} onClick={() => void submit()}>
            {busy ? L('Liberando…', 'Allowing…') : count === 0 ? L('Marque uma conversa', 'Tick a conversation') : L(`Liberar ${count} ${count === 1 ? 'conversa' : 'conversas'}`, `Allow ${count} ${count === 1 ? 'conversation' : 'conversations'}`)}
          </button>
        </div>
        {level === 'reply' && <p className="hint">{L('As respostas começam pedindo a sua aprovação. Você muda isso em cada conversa depois.', 'Answers start by asking for your approval. You change that per conversation later.')}</p>}
      </div>
    </Modal>
  )
}
