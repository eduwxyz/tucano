// The harnesses agents run on (Claude Code, Codex, OpenCode, Pi), each used
// as the person set it up: their plan, their company's gateway or the
// providers they have logins for. Here they pick which ones the agents use,
// test them, and pick models from what each harness offers.
import { L } from '../../../shared/lang'
import { useEffect, useState, type ReactNode } from 'react'
import {
  ENGINES,
  ENGINE_IDS,
  MODELS,
  startsPicked,
  customModel,
  engineModels,
  harnessMcps,
  importHarnessMcp,
  loginEngine,
  modelInfo,
  testEngine,
  updateSettings,
  useStore,
  type EngineId,
  type EngineStatus,
  type HarnessMcp,
  type Settings
} from '../store'
import { Icon } from './ui'

// The harnesses agents may run on now: picked (or all, if never picked), ready, and runnable.
export const usableEngines = (s: Settings): EngineId[] => ENGINE_IDS.filter((e) => s.engines[e].loggedIn)
// Some harness in use goes through a gateway: Jev and Telegram would send data around it.
export const onGateway = (s: Settings): boolean => usableEngines(s).some((e) => s.engines[e].route === 'gateway')

// ---------- models ----------

export interface ModelOption {
  value: string // a listed model's id, or "<engine>:<name>"
  label: string
  hint?: string
}

// A model list asked once per harness and route (and again after "Verificar de novo").
const lists = new Map<string, Promise<{ models: string[]; error?: string }>>()

// What a harness offers: the app's list on a plan; what OpenCode or Pi list; what the gateway lists.
export function useEngineModels(engine: EngineId | undefined): { options: ModelOption[]; loading: boolean; error?: string } {
  const st = useStore((s) => (engine ? s.settings.engines[engine] : undefined))
  const plan = !!engine && (engine === 'claude' || engine === 'codex') && st?.route !== 'gateway'
  const id = engine && st?.installed && !plan ? `${engine}|${st.route}|${st.gateway ?? ''}|${st.account ?? ''}` : ''
  const [got, setGot] = useState<{ id: string; models: string[]; error?: string } | null>(null)
  useEffect(() => {
    if (!id || !engine) return
    if (!lists.has(id)) lists.set(id, engineModels(engine).catch((e: unknown) => ({ models: [], error: String(e) })))
    let live = true
    void lists.get(id)!.then((r) => live && setGot({ id, ...r }))
    return () => {
      live = false
    }
  }, [id, engine])
  if (!engine) return { options: [], loading: false }
  if (plan) return { options: MODELS.filter((m) => m.engine === engine).map((m) => ({ value: m.id, label: m.label, hint: m.hint })), loading: false }
  const mine = got?.id === id ? got : undefined
  return { options: (mine?.models ?? []).map((m) => ({ value: customModel(engine, m), label: m })), loading: !!id && !mine, error: mine?.error }
}

const OTHER = '__outro__'

// A model to run with: the harness, then its model from the list, or another by name.
// jev adds TypeSafe's Jev (the router). Engines limits the harnesses offered.
export function ModelPicker({ value, onChange, engines, jev }: { value: string; onChange: (v: string) => void; engines?: EngineId[]; jev?: boolean }): ReactNode {
  const usable = useStore((s) => usableEngines(s.settings))
  const statuses = useStore((s) => s.settings.engines)
  const choices = (engines ?? usable).filter((e) => usable.includes(e))
  const m = value && value !== 'jev' ? modelInfo(value) : undefined
  const engine: EngineId | undefined = m && choices.includes(m.engine) ? m.engine : choices[0]
  const { options, loading, error } = useEngineModels(engine)
  const inList = options.some((o) => o.value === value)
  const [typing, setTyping] = useState(false)
  const other = value !== 'jev' && !!engine && (typing || (!!m?.id && m.engine === engine && !inList && !loading))
  const name = m && m.engine === engine && !MODELS.some((x) => x.id === value) ? m.id : ''

  // A harness's own card passes just that harness: it's already chosen there, so no select.
  const fixed = engines?.length === 1 && !jev
  if (!engine && !jev) return <p className="hint hint--warn">{L('Nenhum harness pronto. Veja em Configurações → Modelos.', 'No harness ready. See Settings → Models.')}</p>
  return (
    <div className="model-picker">
      {!fixed && (
        <select
          value={value === 'jev' ? 'jev' : engine}
          onChange={(e) => {
            setTyping(false)
            const v = e.target.value
            // On a plan, the harness's first model; otherwise the person picks from its list.
            const plan = v !== 'jev' && statuses[v as EngineId].route === 'plan' ? MODELS.find((x) => x.engine === v) : undefined
            onChange(v === 'jev' ? 'jev' : (plan?.id ?? customModel(v as EngineId, '')))
          }}
        >
          {choices.map((e) => (
            <option key={e} value={e}>
              {ENGINES[e].label}
            </option>
          ))}
          {jev && <option value="jev">TypeSafe · Jev</option>}
        </select>
      )}
      {value !== 'jev' && engine && (
        <select
          className="grow"
          value={other ? OTHER : inList ? value : ''}
          onChange={(e) => {
            const v = e.target.value
            if (v === OTHER) {
              setTyping(true)
              onChange(customModel(engine, name))
            } else {
              setTyping(false)
              onChange(v)
            }
          }}
        >
          {!inList && !other && (
            <option value="" disabled>
              {loading ? L('Buscando os modelos…', 'Fetching the models…') : options.length ? L('Escolha um modelo…', 'Pick a model…') : L('Sem lista: use Outro modelo', 'No list: use Other model')}
            </option>
          )}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.hint ? ` · ${o.hint}` : ''}
            </option>
          ))}
          <option value={OTHER}>{L('Outro modelo…', 'Other model…')}</option>
        </select>
      )}
      {other && engine && (
        <input className="model-name grow" autoFocus={typing && !name} value={name} spellCheck={false} placeholder={L('O nome exato do modelo', 'The exact model name')} onChange={(e) => onChange(customModel(engine, e.target.value))} />
      )}
      {error && other && <span className="hint">{L('Não deu pra pegar a lista', 'Couldn’t get the list')}: {error}</span>}
    </div>
  )
}

// ---------- the harnesses ----------

const ROUTE = (): Record<NonNullable<EngineStatus['route']>, { label: string; tone: string }> => ({
  plan: { label: L('plano', 'plan'), tone: 'tag--ok' },
  gateway: { label: 'gateway', tone: 'tag--ok' },
  apikey: { label: L('chave de API', 'API key'), tone: 'tag--warn' },
  providers: { label: L('provedores', 'providers'), tone: 'tag--ok' }
})

// Every harness, with what was found in its own setup, a box to use it or not, and a test.
export function HarnessList(): ReactNode {
  const engines = useStore((s) => s.settings.engines)
  const chosen = useStore((s) => s.settings.harnesses)
  // Unpicked: the ones ready to run. Picking one off keeps the rest as they are.
  const picked = (e: EngineId): boolean => (chosen ? chosen.includes(e) : startsPicked(engines[e]))
  const toggle = (e: EngineId): void => {
    const now = ENGINE_IDS.filter(picked)
    updateSettings({ harnesses: now.includes(e) ? now.filter((x) => x !== e) : [...now, e] })
  }
  return (
    <div className="harnesses">
      {ENGINE_IDS.map((e) => (
        <HarnessRow key={e} engine={e} st={engines[e]} picked={picked(e)} toggle={() => toggle(e)} />
      ))}
    </div>
  )
}

function HarnessRow({ engine, st, picked, toggle }: { engine: EngineId; st: EngineStatus; picked: boolean; toggle: () => void }): ReactNode {
  const [testing, setTesting] = useState(false)
  const [model, setModel] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  // No terminal could be opened: the command, for the person to run.
  const [manual, setManual] = useState<string | null>(null)
  const windows = useStore((s) => s.platform === 'windows')
  const ready = st.loggedIn
  const found = st.installed && !!st.route // what its setup says, picked or not

  async function test(): Promise<void> {
    setResult(null)
    try {
      setResult(await testEngine(model))
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return (
    <div className={`harness ${picked ? 'is-picked' : ''} ${st.soon ? 'is-soon' : ''}`}>
      <div className="harness__head">
        <button className={`harness__check ${picked ? 'is-on' : ''}`} disabled={!!st.soon || !st.installed} onClick={toggle} aria-label={L(`Usar o ${ENGINES[engine].label}`, `Use ${ENGINES[engine].label}`)}>
          {picked && <Icon name="check" size={12} />}
        </button>
        <div className="grow">
          <strong>{ENGINES[engine].label}</strong>
          <span className="harness__account">
            {!st.installed ? L('Não instalado', 'Not installed') : st.account ?? (st.loggedIn ? L('Pronto', 'Ready') : L('Falta entrar', 'Not signed in'))}
          </span>
        </div>
        {st.soon ? (
          <span className="tag">{L('em breve', 'coming soon')}</span>
        ) : found && st.route ? (
          <span className={`tag ${ROUTE()[st.route].tone}`}>{ROUTE()[st.route].label}</span>
        ) : st.installed ? (
          <span className="tag tag--warn">{L('falta entrar', 'not signed in')}</span>
        ) : null}
        {picked && ready && (
          <button className="btn btn--sm" onClick={() => setTesting(!testing)}>
            {L('Testar', 'Test')}
          </button>
        )}
        {st.installed && !st.loggedIn && !st.soon && (
          <button
            className="btn btn--sm btn--primary"
            title={L(`Abre um terminal com: ${ENGINES[engine].login}`, `Opens a terminal with: ${ENGINES[engine].login}`)}
            onClick={() => void loginEngine(engine).then((r) => setManual(r.opened ? null : r.command))}
          >
            {L('Entrar', 'Sign in')}
          </button>
        )}
      </div>
      {manual && !st.loggedIn && (
        <div className="harness__body">
          <span className="hint">{L('Não achei um terminal pra abrir. Pra entrar, cole no seu terminal:', "Couldn't find a terminal to open. To sign in, paste in your terminal:")}</span>
          <code className="harness__cmd">{manual}</code>
        </div>
      )}
      {!st.installed && (
        <div className="harness__body">
          <span className="hint">{windows ? L('Pra instalar, cole no PowerShell:', 'To install, paste in PowerShell:') : L('Pra instalar, cole no terminal:', 'To install, paste in a terminal:')}</span>
          <code className="harness__cmd">{(windows && ENGINES[engine].windows) || ENGINES[engine].install}</code>
        </div>
      )}
      {st.warning && <p className="hint hint--warn harness__body">{st.warning}</p>}
      {st.route === 'gateway' && picked && <p className="hint harness__body">{L(`Os agentes usam esse mesmo gateway. A telemetria do ${ENGINES[engine].label} fica desligada, pra nada sair por fora dele.`, `Agents use this same gateway. ${ENGINES[engine].label}'s telemetry stays off, so nothing leaves around it.`)}</p>}
      {st.soon && st.installed && <p className="hint harness__body">{L(`Já achei a sua configuração. O Tucano ainda não roda agentes no ${ENGINES[engine].label}: chega numa próxima versão.`, `Found your setup. Tucano doesn't run agents on ${ENGINES[engine].label} yet: it's coming in a future version.`)}</p>}
      {testing && (
        <div className="harness__body">
          <div className="harness__test">
            <ModelPicker value={model} onChange={setModel} engines={[engine]} />
            <button className="btn btn--primary btn--sm" disabled={!modelInfo(model)?.id} onClick={() => void test()}>
              {L('Mandar teste', 'Send a test')}
            </button>
          </div>
          {result && (
            <p className={`note ${result.ok ? 'note--ok' : 'note--error'}`}>
              <Icon name={result.ok ? 'check' : 'x'} size={14} /> {result.ok ? `${L('Funcionando.', 'Working.')} ${result.message}` : result.message}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// At a gateway: this sends data outside it. Allowed, but said plainly.
export function OutsideGateway({ what }: { what: string }): ReactNode {
  return (
    <p className="hint hint--warn">
      <Icon name="shield" size={13} /> {L('Fora do gateway:', 'Outside the gateway:')} {what} {L('Ligue só se a empresa permitir.', 'Only turn it on if your company allows it.')}
    </p>
  )
}

// ---------- their MCP servers ----------

// The MCP servers already set up in the harnesses. Adding one makes it a
// connector: agents reach it through the gateway, with grants and approvals.
export function HarnessMcps({ onAdded }: { onAdded: (id: string) => void }): ReactNode {
  const connectors = useStore((s) => s.connectors.length)
  const [found, setFound] = useState<HarnessMcp[] | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  useEffect(() => {
    let live = true
    void harnessMcps().then((f) => live && setFound(f))
    return () => {
      live = false
    }
  }, [connectors])

  async function add(m: HarnessMcp): Promise<void> {
    setBusy(m.key)
    setError(null)
    try {
      onAdded(await importHarnessMcp(m.key))
    } catch (err) {
      setError({ key: m.key, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy('')
    }
  }

  if (!found?.length) return null
  return (
    <section className="card from-harness">
      <div className="from-harness__head">
        <strong>{L('Nos seus harnesses', 'In your harnesses')}</strong>
        <span className="muted small">{L('Os servidores MCP que você já configurou. Ao adicionar, os agentes passam a usar pelo Tucano, com as permissões e aprovações daqui.', 'The MCP servers you already set up. Once added, agents use them through Tucano, with the permissions and approvals set here.')}</span>
      </div>
      {found.map((m) => (
        <div key={m.key} className="from-harness__row">
          <span className="connector__icon">
            <Icon name={m.kind === 'stdio' ? 'terminal' : 'globe'} />
          </span>
          <span className="grow">
            <strong>{m.name}</strong>
            <span className="muted small mono truncate">{m.address}</span>
            {m.missing && !m.added && <span className="hint hint--warn">{L('Usa cabeçalhos que o Tucano não manda', 'Uses headers Tucano doesn’t send')} ({m.missing.join(', ')}){L(': pode não conectar.', ': it may not connect.')}</span>}
            {error?.key === m.key && <span className="hint hint--warn">{error.message}</span>}
          </span>
          {m.harnesses.map((e) => (
            <span key={e} className="tag">
              {ENGINES[e].label}
            </span>
          ))}
          {m.added ? (
            <span className="tag tag--ok">{L('adicionado', 'added')}</span>
          ) : (
            <button className="btn btn--sm" disabled={busy === m.key} onClick={() => void add(m)}>
              {busy === m.key ? L('Adicionando…', 'Adding…') : L('Adicionar', 'Add')}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
