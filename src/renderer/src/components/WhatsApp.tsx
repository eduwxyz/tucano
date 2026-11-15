// Settings › WhatsApp (admins): the numbers the team gave its agents, and one number's screen.
// Everything saves as soon as it changes; a change that fails goes back and says why.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ALL_CHATS, clampSettings, phoneDigits, type WhatsAppAccess, type WhatsAppChat, type WhatsAppNumber, type WhatsAppSettings, type WhatsAppState } from '../../../shared/whatsapp'
import { call } from '../rpc'
import { useStore, type Agent } from '../store'
import { confirmDialog } from './Dialogs'
import { Card } from './Pages'
import { Qr } from './People'
import { AddNumber, ChatPicker } from './WhatsAppAdd'
import { AccessCard, CloudCard, DraftText, InboundCard, KindTag, LimitsCard, StatusTag, WaIcon, errText, phoneText } from './WhatsAppParts'
import { AgentAvatar, Icon } from './ui'

export function WhatsAppPane(): ReactNode {
  const rev = useStore((s) => s.whatsappRev)
  const agents = useStore((s) => s.agents)
  const [state, setState] = useState<WhatsAppState | null>(null)
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const seq = useRef(0)

  // The latest answer wins: two reads in a row can come back in the other order.
  const load = useCallback(async (): Promise<void> => {
    const mine = ++seq.current
    try {
      const next = await call('whatsappState')
      if (mine !== seq.current) return
      setState(next)
      setError('')
    } catch (e) {
      if (mine === seq.current) setError(errText(e))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [rev, load])

  // A number that went away while its screen was open (removed from another window): back to the list.
  useEffect(() => {
    if (openId && state && !state.numbers.some((n) => n.id === openId)) setOpenId(null)
  }, [state, openId])

  const replace = useCallback((n: WhatsAppNumber): void => {
    setState((s) => (s ? { ...s, numbers: s.numbers.map((x) => (x.id === n.id ? n : x)) } : s))
  }, [])

  const open = openId ? state?.numbers.find((n) => n.id === openId) : undefined
  if (!state)
    return error ? (
      <Card title={L('Números de WhatsApp', 'WhatsApp numbers')}>
        <p className="note note--error" role="alert">{error}</p>
        <button className="btn" onClick={() => void load()}>{L('Tentar de novo', 'Try again')}</button>
      </Card>
    ) : (
      <Card title={L('Números de WhatsApp', 'WhatsApp numbers')} lead={L('Carregando os seus números…', 'Loading your numbers…')}>
        <div className="wa-skeleton" aria-hidden />
        <div className="wa-skeleton" aria-hidden />
      </Card>
    )

  if (open) return <NumberScreen n={open} agents={agents} cloud={state.cloud} replace={replace} reload={load} loadError={error} onBack={() => setOpenId(null)} />

  const add = (
    <button className="btn btn--primary btn--sm" onClick={() => setAdding(true)}>
      <Icon name="plus" size={14} />
      {L('Adicionar número', 'Add a number')}
    </button>
  )
  return (
    <>
      {error && (
        <div className="note note--error" role="alert">
          <p>{error}</p>
          <button className="btn btn--sm" onClick={() => void load()}>{L('Tentar de novo', 'Try again')}</button>
        </div>
      )}
      <Card title={L('Números de WhatsApp', 'WhatsApp numbers')} lead={L('Dê um número aos seus agentes. Cada agente só vê as conversas que você liberar.', 'Give your agents a number. Each agent only sees the conversations you allow.')} action={state.numbers.length > 0 ? add : undefined}>
        {state.numbers.length === 0 ? (
          <div className="empty empty--card wa-empty">
            <span className="wa-mark"><WaIcon size={22} /></span>
            <p><strong>{L('Nenhum número ainda', 'No number yet')}</strong></p>
            <p className="muted">{L('Seus agentes podem ler e responder no WhatsApp. Você escolhe o número, as conversas e se cada resposta pede a sua aprovação.', 'Your agents can read and answer on WhatsApp. You choose the number, the conversations, and whether each answer asks for your approval.')}</p>
            <div className="wa-empty__go">{add}</div>
          </div>
        ) : (
          <div className="table">
            {state.numbers.map((n) => (
              <NumberRow key={n.id} n={n} agents={agents} onOpen={() => setOpenId(n.id)} onChanged={() => void load()} />
            ))}
          </div>
        )}
        <p className="hint">
          <Icon name="shield" size={13} />
          {L('As mensagens ficam guardadas no Tucano, só das conversas que você liberou.', 'Messages are kept in Tucano, only for the conversations you allowed.')}
        </p>
      </Card>
      {adding && (
        <AddNumber
          cloud={state.cloud}
          onClose={() => setAdding(false)}
          onAdded={(n) => {
            setState((s) => (s ? { ...s, numbers: [...s.numbers.filter((x) => x.id !== n.id), n] } : s))
            setAdding(false)
            setOpenId(n.id)
            void load()
          }}
        />
      )}
    </>
  )
}

// ---------- the list ----------

function NumberRow({ n, agents, onOpen, onChanged }: { n: WhatsAppNumber; agents: Agent[]; onOpen: () => void; onChanged: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const off = n.status === 'disconnected'
  const everyone = n.access.some((a) => a.chat === ALL_CHATS)
  const chatCount = new Set(n.access.filter((a) => a.chat !== ALL_CHATS).map((a) => a.chat)).size
  const who = [...new Set(n.access.map((a) => a.agentId))].flatMap((id) => agents.filter((a) => a.id === id))
  const usage = everyone
    ? L('quem escrever para o número', 'whoever writes to the number')
    : chatCount > 0
      ? L(`${chatCount} ${chatCount === 1 ? 'conversa liberada' : 'conversas liberadas'}`, `${chatCount} ${chatCount === 1 ? 'conversation allowed' : 'conversations allowed'}`)
      : L('nenhuma conversa liberada ainda', 'no conversation allowed yet')
  const reconnect = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await call('whatsappConnect', { id: n.id })
      onChanged()
      // A QR number shows its code only inside its own screen, so the person lands there.
      if (n.kind === 'qr') onOpen()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }
  const key = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onOpen()
    }
  }
  return (
    <div className="table__row table__row--btn wa-row" role="button" tabIndex={0} onClick={onOpen} onKeyDown={key}>
      <span className={`wa-mark ${off ? 'wa-mark--off' : ''}`}><WaIcon /></span>
      <div className="grow">
        <div className="row wa-wrap wa-row__title">
          <strong>{n.name}</strong>
          <StatusTag n={n} />
          <KindTag kind={n.kind} />
        </div>
        {n.description && <div className="muted small">{n.description}</div>}
        {off && n.error && <div className="small wa-row__error">{n.error}</div>}
        {error && <div className="small wa-row__error" role="alert">{error}</div>}
        <div className="muted small wa-row__meta">{[phoneText(n.phone), usage].filter(Boolean).join(' · ')}</div>
      </div>
      {who.length > 0 && (
        <span className="stack" aria-label={who.map((a) => a.name).join(', ')}>
          {who.slice(0, 4).map((a) => (
            <span className="stack__item" key={a.id} title={a.name}><AgentAvatar agent={a} size={22} still /></span>
          ))}
          {who.length > 4 && <span className="stack__count">+{who.length - 4}</span>}
        </span>
      )}
      {off && (
        <button className="btn btn--sm" disabled={busy} onClick={(e) => { e.stopPropagation(); void reconnect() }}>
          {busy ? L('Conectando…', 'Connecting…') : L('Reconectar', 'Reconnect')}
        </button>
      )}
      <Icon name="chevron" size={16} />
    </div>
  )
}

// ---------- one number ----------

function NumberScreen({ n, agents, cloud, replace, reload, loadError, onBack }: {
  n: WhatsAppNumber
  agents: Agent[]
  cloud: WhatsAppState['cloud']
  replace: (n: WhatsAppNumber) => void
  reload: () => Promise<void>
  loadError: string
  onBack: () => void
}): ReactNode {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [saved, setSaved] = useState(false)
  const [pickFor, setPickFor] = useState<string | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(savedTimer.current), [])

  // The newest copy of the number. Every change starts from it, never from a copy captured earlier.
  const latest = useRef(n)
  latest.current = n
  // Saves go one after another, so a second change is always built on what the first one left.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const pending = useRef(0)

  // Shows the change at once and sends it in line. If the core refuses, the number is read again from
  // the server and the reason is said.
  const save = (optimistic: WhatsAppNumber, run: () => Promise<WhatsAppNumber>): Promise<void> => {
    latest.current = optimistic
    replace(optimistic)
    pending.current++
    const step = async (): Promise<void> => {
      try {
        const kept = await run()
        // Only the last save in line shows the server's copy; an earlier one would hide the changes still waiting.
        if (pending.current === 1) {
          latest.current = kept
          replace(kept)
        }
        setSaved(true)
        clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setSaved(false), 1800)
      } catch (e) {
        void reload()
        throw e
      } finally {
        pending.current--
      }
    }
    queue.current = queue.current.then(step, step)
    return queue.current
  }
  const go = (p: Promise<void>): void => {
    setError('')
    p.catch((e: unknown) => setError(errText(e)))
  }
  const act = async (key: string, fn: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError('')
    try {
      await fn()
      await reload()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy('')
    }
  }

  const rename = (name: string): void => go(save({ ...latest.current, name }, () => call('whatsappUpdate', { id: n.id, name })))
  const describe = (description: string): void => go(save({ ...latest.current, description }, () => call('whatsappUpdate', { id: n.id, description })))
  // Merged and clamped from the newest copy. A change that leaves the settings as they were is not sent.
  const settings = (patch: Partial<WhatsAppSettings>): WhatsAppSettings => {
    const base = latest.current
    const next = clampSettings(base.kind, { ...base.settings, ...patch })
    const same = (Object.keys(next) as (keyof WhatsAppSettings)[]).every((k) => next[k] === base.settings[k])
    if (!same) go(save({ ...base, settings: next }, () => call('whatsappUpdate', { id: n.id, settings: next })))
    return next
  }
  // The access list is one whole list on the core, so each change is applied to its newest copy.
  const setAccess = (edit: (rows: WhatsAppAccess[]) => WhatsAppAccess[], names: WhatsAppChat[] = []): Promise<void> => {
    const base = latest.current
    const next = edit(base.access)
    return save({ ...base, access: next, chats: [...base.chats.filter((c) => !names.some((x) => x.id === c.id)), ...names] }, () => call('whatsappSetAccess', { id: n.id, access: next }))
  }

  const remove = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Remover ${n.name}?`, `Remove ${n.name}?`),
      body: L('O celular é desconectado e o Tucano esquece as conversas guardadas e as regras deste número. Não dá para desfazer.', 'The phone is disconnected and Tucano forgets the saved conversations and the rules of this number. This can’t be undone.'),
      confirm: L('Remover número', 'Remove number'),
      danger: true
    })
    if (ok) await act('remove', async () => { await call('whatsappRemove', { id: n.id }); onBack() })
  }

  const disconnect = async (ask: boolean): Promise<void> => {
    if (ask) {
      const ok = await confirmDialog({
        title: L('Desconectar este número?', 'Disconnect this number?'),
        body: L('Os agentes param de ler e de enviar por este número. Para voltar a usar, você vai precisar ler o código de novo com o celular.', 'Agents stop reading and sending through this number. To use it again, you will need to scan the code again with the phone.'),
        confirm: L('Desconectar', 'Disconnect')
      })
      if (!ok) return
    }
    await act('disconnect', () => call('whatsappDisconnect', { id: n.id }))
  }

  const pickAgent = pickFor ? agents.find((a) => a.id === pickFor) : undefined
  return (
    <>
      <div className="wa-top">
        <button className="btn btn--ghost btn--sm" onClick={onBack}>
          <Icon name="back" size={14} />
          {L('Números', 'Numbers')}
        </button>
        <span className="grow" />
        {saved && <span className="tag tag--ok wa-saved" role="status"><Icon name="check" size={11} />{L('Salvo', 'Saved')}</span>}
      </div>
      {loadError && (
        <div className="note note--error" role="alert">
          <p>{loadError}</p>
          <button className="btn btn--sm" onClick={() => void reload()}>{L('Tentar de novo', 'Try again')}</button>
        </div>
      )}
      {error && <p className="note note--error" role="alert">{error}</p>}

      <Card title={L('Sobre o número', 'About the number')}>
        <label className="field">
          <span className="field__label">{L('Nome', 'Name')}</span>
          <DraftText label={L('Nome', 'Name')} value={n.name} maxLength={60} required onCommit={rename} />
        </label>
        <label className="field">
          <span className="field__label">{L('Para que serve (os agentes leem isto)', 'What it’s for (the agents read this)')}</span>
          <DraftText label={L('Para que serve', 'What it’s for')} multiline value={n.description} maxLength={300} placeholder={L('Ex.: Suporte aos alunos e grupos das turmas.', 'E.g. Support for students and class groups.')} onCommit={describe} />
        </label>
      </Card>

      <ConnectionCard n={n} busy={busy} onConnect={(phone) => void act('connect', () => call('whatsappConnect', { id: n.id, ...(phone ? { phone } : {}) }))} onDisconnect={(ask) => void disconnect(ask)} />

      <AccessCard n={n} agents={agents} onAccess={(edit) => go(setAccess(edit))} onPick={setPickFor} />
      <InboundCard n={n} onSettings={settings} />
      <LimitsCard n={n} onSettings={settings} />
      {n.kind === 'cloud' && <CloudCard n={n} webhookUrl={cloud.webhookUrl} verifyToken={cloud.verifyToken} />}

      <Card title={L('Remover número', 'Remove number')} lead={L('Desconecta o celular e apaga as conversas guardadas e as regras deste número.', 'Disconnects the phone and deletes the saved conversations and the rules of this number.')}>
        <button className="btn btn--danger" disabled={busy === 'remove'} onClick={() => void remove()}>
          {busy === 'remove' ? L('Removendo…', 'Removing…') : L('Remover número', 'Remove number')}
        </button>
      </Card>

      {pickAgent && <ChatPicker n={n} agent={pickAgent} onClose={() => setPickFor(null)} onSubmit={(rows, names) => setAccess((cur) => [...cur, ...rows], names)} />}
    </>
  )
}

// ---------- link status ----------

function ConnectionCard({ n, busy, onConnect, onDisconnect }: { n: WhatsAppNumber; busy: string; onConnect: (phone?: string) => void; onDisconnect: (ask: boolean) => void }): ReactNode {
  const working = busy === 'connect' || busy === 'disconnect'
  const [byPhone, setByPhone] = useState(false)
  const [phone, setPhone] = useState('')
  const digits = phoneDigits(phone)
  const phoneForm = byPhone && (
    <div className="wa-phone">
      <label className="field">
        <span className="field__label">{L('Número do celular, com código do país e DDD', 'Phone number, with country and area code')}</span>
        <div className="row">
          <input className="grow" inputMode="tel" autoComplete="off" value={phone} placeholder="5511999990000" onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 15))} onKeyDown={(e) => e.key === 'Enter' && digits && onConnect(digits)} />
          <button className="btn" disabled={!digits || working} onClick={() => digits && onConnect(digits)}>
            {working ? L('Gerando…', 'Making it…') : L('Gerar código', 'Get code')}
          </button>
        </div>
        <span className="hint">{L('Só números. Aparece um código de 8 caracteres para digitar no celular.', 'Digits only. An 8-character code shows up to type on the phone.')}</span>
      </label>
    </div>
  )
  const phoneLink = n.kind === 'qr' && (
    <button className="btn btn--sm btn--ghost wa-link" onClick={() => setByPhone((v) => !v)}>
      {byPhone ? L('Voltar ao QR code', 'Back to the QR code') : L('Conectar com código de 8 caracteres', 'Connect with an 8-character code')}
    </button>
  )
  return (
    <Card title={L('Conexão', 'Connection')}>
      <div className="row wa-wrap wa-conn">
        <StatusTag n={n} />
        {n.phone && <span className="num mono muted small">{phoneText(n.phone)}</span>}
        <span className="grow" />
        {n.status === 'connected' && n.kind === 'qr' && (
          <button className="btn btn--sm" disabled={working} onClick={() => onDisconnect(true)}>
            {busy === 'disconnect' ? L('Desconectando…', 'Disconnecting…') : L('Desconectar', 'Disconnect')}
          </button>
        )}
        {n.status === 'pairing' && (
          <button className="btn btn--sm btn--ghost" disabled={working} onClick={() => onDisconnect(false)}>{L('Cancelar', 'Cancel')}</button>
        )}
        {n.status === 'disconnected' && (
          <button className="btn btn--primary btn--sm" disabled={working} onClick={() => onConnect()}>
            {busy === 'connect' ? L('Conectando…', 'Connecting…') : n.error || n.phone ? L('Reconectar', 'Reconnect') : L('Conectar', 'Connect')}
          </button>
        )}
      </div>
      {n.status === 'connected' && <p className="muted small wa-conn__text">{L('Tudo certo: os agentes liberados já podem usar este número.', 'All good: the allowed agents can already use this number.')}</p>}
      {n.status === 'connected' && n.kind === 'cloud' && (
        <p className="muted small wa-conn__text">{L('Este número fica sempre ligado pela Meta. Para parar de usar, tire o acesso dos agentes ou remova o número.', 'This number is always on through Meta. To stop using it, take the agents’ access away or remove the number.')}</p>
      )}
      {n.status === 'connecting' && <p className="muted small wa-conn__text"><span className="spinner wa-inline-spinner" />{L('Conectando ao WhatsApp. Costuma levar alguns segundos.', 'Connecting to WhatsApp. It usually takes a few seconds.')}</p>}
      {n.status === 'disconnected' && (
        <>
          {n.error ? <p className="note note--error">{n.error}</p> : <p className="muted small wa-conn__text">{n.kind === 'qr' ? L('Este número ainda não está ligado a um celular. Toque em Conectar para ver o código.', 'This number isn’t linked to a phone yet. Press Connect to see the code.') : L('Este número está desconectado. Os agentes não leem nem enviam por ele.', 'This number is disconnected. The agents neither read nor send through it.')}</p>}
          {phoneLink}
          {phoneForm}
        </>
      )}
      {n.status === 'pairing' && (
        <>
          {byPhone && !n.pairingCode ? (
            phoneForm
          ) : n.pairingCode ? (
            <div className="wa-pair">
              <code className="phone-code wa-code">{n.pairingCode}</code>
              <div className="grow">
                <ol className="small steps-list">
                  <li>{L('No celular, abra o', 'On the phone, open')} <strong>WhatsApp</strong>.</li>
                  <li>{L('Toque em', 'Tap')} <strong>{L('Aparelhos conectados', 'Linked devices')}</strong> › <strong>{L('Conectar aparelho', 'Link a device')}</strong>.</li>
                  <li>{L('Escolha “Conectar com número de telefone” e digite o código.', 'Choose “Link with phone number instead” and type the code.')}</li>
                </ol>
                <p className="small muted"><span className="pulse wa-pulse" />{L('Esperando você digitar o código…', 'Waiting for you to type the code…')}</p>
              </div>
            </div>
          ) : n.qr ? (
            <div className="wa-pair">
              <Qr text={n.qr} />
              <div className="grow">
                <ol className="small steps-list">
                  <li>{L('No celular, abra o', 'On the phone, open')} <strong>WhatsApp</strong>.</li>
                  <li>{L('Toque em', 'Tap')} <strong>{L('Aparelhos conectados', 'Linked devices')}</strong> › <strong>{L('Conectar aparelho', 'Link a device')}</strong>.</li>
                  <li>{L('Aponte a câmera para este código.', 'Point the camera at this code.')}</li>
                </ol>
                <p className="small muted"><span className="pulse wa-pulse" />{L('Esperando você escanear… o código se renova sozinho.', 'Waiting for you to scan… the code renews itself.')}</p>
              </div>
            </div>
          ) : (
            <p className="muted small wa-conn__text"><span className="spinner wa-inline-spinner" />{L('Preparando o código…', 'Getting the code ready…')}</p>
          )}
          {!n.pairingCode && phoneLink}
        </>
      )}
      {n.status !== 'disconnected' && n.error && <p className="note note--error">{n.error}</p>}
    </Card>
  )
}
