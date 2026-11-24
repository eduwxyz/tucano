// Settings › Connections › Traces: where the agents' traces go, from the screen, to any OTLP backend.
// The examples only fill the address. The headers go to the core and never come back.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { TracesTest, TracesView } from '../../../shared/types'
import { loadTraces, saveTraces, testTraces } from '../store'
import { message } from './Invite'
import { Card, Toggle } from './Pages'
import { Icon } from './ui'

// Each one's documented base address: /v1/traces goes after it.
const examples = (): { label: string; url: string }[] => [
  { label: 'Langfuse', url: 'https://cloud.langfuse.com/api/public/otel' },
  { label: 'Grafana Cloud', url: 'https://otlp-gateway-prod-us-east-0.grafana.net/otlp' },
  { label: L('Collector local', 'Local Collector'), url: 'http://localhost:4318' }
]

type Said = { ok: boolean; text: string }

const tested = (r: TracesTest): Said =>
  r.ok
    ? { ok: true, text: L('O backend recebeu o trace de teste.', 'The backend took the test trace.') }
    : r.status
      ? { ok: false, text: r.status === 401 || r.status === 403 ? L(`O backend recusou (HTTP ${r.status}): confira a chave nos cabeçalhos.`, `The backend refused it (HTTP ${r.status}): check the key in the headers.`) : L(`O backend respondeu HTTP ${r.status}.`, `The backend answered HTTP ${r.status}.`) }
      : { ok: false, text: L('Não deu pra alcançar esse endereço.', "Couldn't reach that address.") }

export function TracesPane(): ReactNode {
  const [view, setView] = useState<TracesView | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let live = true
    loadTraces().then(
      (v) => live && setView(v),
      (e: unknown) => live && setFailed(message(e))
    )
    return () => void (live = false)
  }, [])

  const lead = L(
    'Mande os traces do trabalho dos agentes para qualquer backend OpenTelemetry (OTLP por HTTP): Langfuse, Grafana, Honeycomb, Datadog, um Collector seu.',
    "Send traces of the agents' work to any OpenTelemetry backend (OTLP over HTTP): Langfuse, Grafana, Honeycomb, Datadog, your own Collector."
  )
  if (!view) return <Card title="Traces" lead={lead}>{failed ? <p className="hint hint--warn">{failed}</p> : <p className="hint">{L('Abrindo…', 'Opening…')}</p>}</Card>
  if (view.fromEnv)
    return (
      <Card title="Traces" lead={lead}>
        <div className="traces">
          <p>
            <strong>{L('Configurado pelo ambiente do servidor', "Configured by the server's environment")}</strong>: {view.fromEnv}
          </p>
          <p className="hint">{L('As variáveis OTEL_ do servidor decidem para onde os traces vão. Para mudar, mude as variáveis.', "The server's OTEL_ variables decide where traces go. To change it, change them.")}</p>
        </div>
      </Card>
    )
  return <TracesForm view={view} onSaved={setView} lead={lead} />
}

function TracesForm({ view, onSaved, lead }: { view: TracesView; onSaved: (v: TracesView) => void; lead: string }): ReactNode {
  const [on, setOn] = useState(view.on)
  const [endpoint, setEndpoint] = useState(view.endpoint)
  const [headers, setHeaders] = useState('')
  const [text, setText] = useState(view.text)
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [said, setSaid] = useState<Said | null>(null) // the last save's or test's outcome
  // A change to the form: what the last save or test said was about something else.
  const changed =
    <T,>(set: (v: T) => void) =>
    (v: T): void => {
      setSaid(null)
      set(v)
    }

  async function run(what: 'save' | 'test', work: () => Promise<Said | null>): Promise<void> {
    setBusy(what)
    setSaid(null)
    try {
      setSaid(await work())
    } catch (e) {
      setSaid({ ok: false, text: message(e) })
    } finally {
      setBusy(null)
    }
  }
  const save = (remove = false): Promise<void> =>
    run('save', async () => {
      const saved = await saveTraces({ on, endpoint: endpoint.trim(), text, ...(remove ? { headers: null } : headers.trim() ? { headers } : {}) })
      setText(saved.text)
      setHeaders('')
      onSaved(saved)
      return text && !saved.text ? { ok: false, text: L('O texto ficou desligado porque o endereço ou os cabeçalhos mudaram. Ligue de novo se quiser mandar o texto para eles.', 'The text stayed off because the address or headers changed. Turn it on again to send the text there.') } : null
    })
  const test = (): Promise<void> => run('test', async () => tested(await testTraces({ endpoint: endpoint.trim(), ...(headers.trim() ? { headers } : {}) })))

  return (
    <Card title="Traces" lead={lead}>
      <div className="traces">
        <div className="traces__row">
          <span className="grow">
            <strong>{L('Enviar traces', 'Send traces')}</strong>
            <span className="hint">{L('Um trace por resposta de agente, com as ferramentas, o tempo, os tokens e o custo.', 'One trace per agent reply, with its tools, time, tokens and cost.')}</span>
          </span>
          <Toggle on={on} onChange={changed(setOn)} label={L('Enviar traces', 'Send traces')} />
        </div>
        <div className="endpoint__presets">
          {examples().map((x) => (
            <button key={x.label} type="button" className={`chip ${endpoint === x.url ? 'is-on' : ''}`} onClick={() => changed(setEndpoint)(x.url)}>
              {x.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span className="field__label">{L('Endereço', 'Address')}</span>
          <input value={endpoint} spellCheck={false} placeholder="https://otel.example.com" onChange={(e) => changed(setEndpoint)(e.target.value)} />
          <span className="hint">{L('O endereço base que o backend informa. O Tucano acrescenta /v1/traces.', 'The base address your backend gives. Tucano adds /v1/traces.')}</span>
        </label>
        <label className="field">
          <span className="field__label">{L('Cabeçalhos', 'Headers')}</span>
          <textarea rows={2} value={headers} autoComplete="off" spellCheck={false} placeholder={view.headers ? L('Salvos. Escreva para trocar.', 'Saved. Type to replace them.') : 'Authorization: Basic …'} onChange={(e) => changed(setHeaders)(e.target.value)} />
          <span className="hint">{L('Um por linha, como o backend mostra. Onde vai a chave: guardada criptografada, e não aparece de novo aqui.', 'One per line, as your backend shows them. This is where the key goes: stored encrypted, and never shown here again.')}</span>
        </label>
        {view.headers && (
          <button type="button" className="text-btn traces__remove" disabled={busy !== null} onClick={() => void save(true)}>
            {L('Remover os cabeçalhos salvos', 'Remove the saved headers')}
          </button>
        )}
        <div className="traces__row">
          <span className="grow">
            <strong>{L('Enviar o texto das conversas', 'Send the conversation text')}</strong>
            <span className="hint">
              {L(
                'O pedido e a resposta final de cada agente, com as chaves do Cofre e tokens conhecidos mascarados. Só das conversas que você pode ler. Ferramentas, anexos, memória e wiki nunca vão.',
                "Each agent's request and final reply, with the Vault's keys and known tokens masked. Only from conversations you can read. Tools, attachments, memory and wiki never go."
              )}
            </span>
          </span>
          <Toggle on={text} onChange={changed(setText)} label={L('Enviar o texto das conversas', 'Send the conversation text')} />
        </div>
        <p className="hint traces__what">
          {text
            ? L('Vai: agente, tempo, ferramentas, tokens, custo, status, e o texto do pedido e da resposta.', 'Goes: agent, time, tools, tokens, cost, status, and the text of the request and reply.')
            : L('Vai: agente, tempo, ferramentas, tokens, custo e status. Nenhum texto das conversas.', 'Goes: agent, time, tools, tokens, cost and status. No conversation text.')}
        </p>
        {said &&
          (said.ok ? (
            <p className="note note--ok">
              <Icon name="check" size={14} /> {said.text}
            </p>
          ) : (
            <p className="hint hint--warn">{said.text}</p>
          ))}
        <div className="endpoint__actions">
          <button type="button" className="btn btn--primary btn--sm" disabled={busy !== null} onClick={() => void save()}>
            {busy === 'save' ? L('Salvando…', 'Saving…') : L('Salvar', 'Save')}
          </button>
          <button type="button" className="btn btn--sm" disabled={!endpoint.trim() || busy !== null} onClick={() => void test()}>
            {busy === 'test' ? L('Testando…', 'Testing…') : L('Testar conexão', 'Test connection')}
          </button>
        </div>
      </div>
    </Card>
  )
}
