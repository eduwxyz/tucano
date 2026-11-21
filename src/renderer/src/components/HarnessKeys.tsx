// Configurações › Harnesses: the person's own harness (Claude Code, Codex, Cursor…) connected to this
// Tucano over MCP (src/core/mcp.ts). Each key acts as this person, up to its level; it's shown once.
// On the desktop, one click writes the connection into the harness's config (core/harness-connect.ts).
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { CONNECTABLE, CONNECTABLE_LABEL, DEFAULT_HARNESS_LEVEL, harnessSnippets, HARNESS_LEVELS, MAX_HARNESS_NAME, type Connectable, type HarnessKey, type HarnessLevel, type McpInfo } from '../../../shared/harness-keys'
import { connectHarness, createHarnessKey, harnessKeys, mcpInfo, removeHarnessKey, toast } from '../store'
import { confirmDialog } from './Dialogs'
import { message } from './Invite'
import { Card, Field } from './Pages'
import { ago, Icon } from './ui'

export const levelLabel = (l: HarnessLevel): string => ({ read: L('Ler', 'Read'), talk: L('Conversar', 'Talk'), configure: L('Configurar', 'Configure') })[l]
const levelHint = (l: HarnessLevel): string =>
  ({
    read: L('Entende o Tucano e vê o time, as conversas e o que rodou.', 'Understands Tucano and sees the team, the conversations and what ran.'),
    talk: L('Também manda mensagens aos agentes e espera a resposta.', 'Also sends messages to the agents and waits for the answer.'),
    configure: L('Também cria e muda agentes, canais, rotinas, skills, conectores e memórias.', 'Also creates and changes agents, channels, routines, skills, connectors and memories.')
  })[l]

function Copy({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = (): void =>
    void navigator.clipboard.writeText(text).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1600)),
      () => toast(L('Não consegui copiar. Selecione o texto e copie.', "I couldn't copy. Select the text and copy it."))
    )
  return (
    <button className="btn btn--sm" onClick={copy} aria-label={label}>
      <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? L('Copiado', 'Copied') : L('Copiar', 'Copy')}
    </button>
  )
}

// The address: the core's, or (a server with no public address set) the one this page came from.
const addressOf = (info: McpInfo | null): string | undefined => info?.url ?? (info && !info.local && typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? `${location.origin}/mcp` : undefined)

export function HarnessesPane(): ReactNode {
  const [info, setInfo] = useState<McpInfo | null>(null)
  const [keys, setKeys] = useState<HarnessKey[]>([])
  const reload = (): void => void harnessKeys().then(setKeys, () => {})
  useEffect(() => {
    void mcpInfo().then(setInfo, () => setInfo({ local: false }))
    reload()
  }, [])
  const url = addressOf(info)
  return (
    <>
      <Card
        title="Harnesses"
        lead={L(
          'Conecte o seu harness (Claude Code, Codex, Cursor, OpenCode…) a este Tucano. De lá, ele entende o time, conversa com os agentes e configura agentes, canais, rotinas e skills, como você faria aqui.',
          'Connect your harness (Claude Code, Codex, Cursor, OpenCode…) to this Tucano. From there it understands the team, talks to the agents and sets up agents, channels, routines and skills, as you would here.'
        )}
      >
        {info?.error && <p className="field__error">{info.error}</p>}
        {url && (
          <div className="field">
            <span className="field__label">{L('Endereço do MCP', 'MCP address')}</span>
            <div className="row">
              <input className="grow mono" readOnly value={url} onFocus={(e) => e.target.select()} aria-label={L('Endereço do MCP', 'MCP address')} />
              <Copy text={url} label={L('Copiar o endereço', 'Copy the address')} />
            </div>
            <span className="hint">
              {info?.local
                ? L('Só programas neste computador chegam a este endereço, e só com o Tucano aberto. O claude.ai e o ChatGPT não chegam.', 'Only programs on this computer reach this address, and only with Tucano open. claude.ai and ChatGPT don’t.')
                : url.startsWith('https://')
                  ? L('Qualquer harness com uma chave chega aqui, de qualquer lugar.', 'Any harness with a key reaches it, from anywhere.')
                  : L('Harnesses na mesma rede chegam aqui. O claude.ai e o ChatGPT precisam de um endereço https público.', 'Harnesses on the same network reach it. claude.ai and ChatGPT need a public https address.')}
            </span>
          </div>
        )}
        {info?.local && url && <OneClick onDone={reload} />}
      </Card>
      <NewKey url={url} onMade={reload} />
      {keys.length > 0 && <KeyList keys={keys} onChange={reload} />}
    </>
  )
}

// The desktop: the connection written into the harness's own config, with a key made for it.
function OneClick({ onDone }: { onDone: () => void }): ReactNode {
  const [busy, setBusy] = useState<Connectable | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const go = async (h: Connectable, replace = false): Promise<void> => {
    setBusy(h)
    setNote(null)
    try {
      const r = await connectHarness(h, replace)
      if (r.exists && !replace) {
        const ok = await confirmDialog({
          title: L(`Trocar a conexão do ${CONNECTABLE_LABEL[h]}?`, `Replace ${CONNECTABLE_LABEL[h]}’s connection?`),
          body: L(`Já existe uma entrada “${r.name}” em ${r.where}. Ela passa a usar uma chave nova, e a antiga para de funcionar.`, `There’s already an entry “${r.name}” in ${r.where}. It moves to a new key, and the old one stops working.`),
          confirm: L('Trocar', 'Replace')
        })
        if (ok) return void (await go(h, true))
      } else if (r.done) setNote({ ok: true, text: L(`Pronto: o ${CONNECTABLE_LABEL[h]} já enxerga o Tucano (em ${r.where}). Se ele estiver aberto, reinicie a sessão.`, `Done: ${CONNECTABLE_LABEL[h]} now sees Tucano (in ${r.where}). If it’s open, restart the session.`) })
      else setNote({ ok: false, text: r.error ?? L('Não deu pra escrever a configuração. Gere uma chave abaixo e cole à mão.', 'Couldn’t write the configuration. Make a key below and paste it by hand.') })
    } catch (e) {
      setNote({ ok: false, text: message(e) })
    } finally {
      setBusy(null)
      onDone()
    }
  }
  return (
    <div className="field">
      <span className="field__label">{L('Conectar em um clique', 'Connect in one click')}</span>
      <div className="row row--wrap">
        {CONNECTABLE.map((h) => (
          <button key={h} className="btn btn--sm" disabled={!!busy} onClick={() => void go(h)}>
            {busy === h ? L('Conectando…', 'Connecting…') : CONNECTABLE_LABEL[h]}
          </button>
        ))}
      </div>
      {note ? <span className={note.ok ? 'hint' : 'field__error'}>{note.text}</span> : <span className="hint">{L('Escreve o endereço e uma chave nova (nível Configurar) na configuração do harness.', 'Writes the address and a new key (Configure level) into the harness’s configuration.')}</span>}
    </div>
  )
}

function NewKey({ url, onMade }: { url: string | undefined; onMade: () => void }): ReactNode {
  const [name, setName] = useState('')
  const [level, setLevel] = useState<HarnessLevel>(DEFAULT_HARNESS_LEVEL)
  const [error, setError] = useState('')
  const [made, setMade] = useState<{ key: string; name: string } | null>(null)
  const [tab, setTab] = useState(0)
  const make = (): void =>
    void createHarnessKey(name.trim(), level).then(
      (r) => (setMade({ key: r.key, name: r.harness.name }), setName(''), setError(''), onMade()),
      (e: unknown) => setError(message(e))
    )
  const snippets = made && url ? harnessSnippets(url, made.key) : []
  const shown = snippets[tab]
  return (
    <Card title={L('Gerar uma chave', 'Make a key')} lead={L('Uma chave por harness. Ele age como você, com o que você pode fazer aqui, até o nível escolhido.', 'One key per harness. It acts as you, with what you can do here, up to the level you pick.')}>
      {!made && (
        <>
          <Field label={L('Nome', 'Name')} hint={L('O harness e onde ele roda: “Claude Code no notebook”.', 'The harness and where it runs: “Claude Code on the laptop”.')} error={error || null}>
            <input value={name} maxLength={MAX_HARNESS_NAME} placeholder={L('Claude Code no notebook', 'Claude Code on the laptop')} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && make()} />
          </Field>
          <Field label={L('O que ele pode', 'What it can do')} hint={levelHint(level)} group>
            <div className="segmented" role="radiogroup" aria-label={L('O que ele pode', 'What it can do')}>
              {[...HARNESS_LEVELS].reverse().map((l) => (
                <button key={l} type="button" role="radio" aria-checked={level === l} className={level === l ? 'is-active' : ''} onClick={() => setLevel(l)}>
                  {levelLabel(l)}
                </button>
              ))}
            </div>
          </Field>
          <div className="row">
            <button className="btn btn--primary btn--sm" disabled={!name.trim()} onClick={make}>
              {L('Gerar chave', 'Make key')}
            </button>
          </div>
        </>
      )}
      {made && (
        <>
          <div className="field">
            <span className="field__label">{L(`Chave de “${made.name}”`, `Key for “${made.name}”`)}</span>
            <div className="row">
              <input className="grow mono" readOnly value={made.key} onFocus={(e) => e.target.select()} aria-label={L('Chave', 'Key')} />
              <Copy text={made.key} label={L('Copiar a chave', 'Copy the key')} />
            </div>
            <span className="hint">{L('Ela aparece só agora: cole já no harness (ou guarde num lugar seguro).', 'It shows only now: paste it into the harness now (or keep it somewhere safe).')}</span>
          </div>
          {shown && (
            <div className="field">
              <div className="segmented" role="tablist">
                {snippets.map((sn, i) => (
                  <button key={sn.id} type="button" role="tab" aria-selected={tab === i} className={tab === i ? 'is-active' : ''} onClick={() => setTab(i)}>
                    {sn.label}
                  </button>
                ))}
              </div>
              <span className="field__label">{shown.where === 'terminal' ? L('Rode no terminal', 'Run in the terminal') : L(`Em ${shown.where}`, `In ${shown.where}`)}</span>
              <pre className="mono small harness-snippet">{shown.text}</pre>
              <div className="row">
                <Copy text={shown.text} label={L('Copiar a configuração', 'Copy the configuration')} />
              </div>
            </div>
          )}
          <div className="row">
            <button className="btn btn--ghost btn--sm" onClick={() => (setMade(null), setTab(0))}>
              {L('Pronto', 'Done')}
            </button>
          </div>
        </>
      )}
    </Card>
  )
}

function KeyList({ keys, onChange }: { keys: HarnessKey[]; onChange: () => void }): ReactNode {
  const remove = (k: HarnessKey): void =>
    void confirmDialog({
      title: L(`Tirar a chave “${k.name}”?`, `Remove the key “${k.name}”?`),
      body: L('O harness que usa essa chave perde o acesso agora.', 'The harness using this key loses access now.'),
      confirm: L('Tirar', 'Remove'),
      danger: true
    }).then((ok) => ok && void removeHarnessKey(k.id).then(onChange, (e: unknown) => toast(message(e))))
  return (
    <Card title={L('Suas chaves', 'Your keys')}>
      <div className="table">
        {keys.map((k) => (
          <div key={k.id} className="table__row">
            <div className="grow person-row__who">
              <span>
                <strong>{k.name}</strong> <span className="tag">{levelLabel(k.level)}</span>
              </span>
              <span className="muted small">{[L(`criada ${ago(k.createdAt)}`, `made ${ago(k.createdAt)}`), k.seenAt ? L(`usada ${ago(k.seenAt)}`, `used ${ago(k.seenAt)}`) : L('nunca usada', 'never used')].join(' · ')}</span>
            </div>
            <button className="btn btn--ghost btn--sm" onClick={() => remove(k)}>
              {L('Tirar', 'Remove')}
            </button>
          </div>
        ))}
      </div>
    </Card>
  )
}
