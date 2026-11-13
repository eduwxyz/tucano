// The harnesses agents run on (Claude Code, Codex, OpenCode, Pi), each used
// as the person set it up: their plan, their company's gateway or the
// providers they have logins for. Here they pick which ones the agents use,
// test them, and pick models from what each harness offers.
import { L } from '../../../shared/lang'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import {
  ACCOUNT_ENGINES,
  addAccount,
  ENGINES,
  ENGINE_IDS,
  loginAccount,
  removeAccount,
  MODELS,
  startsPicked,
  codexValue,
  customModel,
  engineModels,
  harnessMcps,
  importHarnessMcp,
  installEngine,
  loginEngine,
  modelInfo,
  navigate,
  openExternal,
  rememberModels,
  setTab,
  testEngine,
  updateSettings,
  useStore,
  type Account,
  type AccountEngine,
  type Agent,
  type EngineId,
  type EngineStatus,
  type HarnessMcp,
  type Settings
} from '../store'
import { Icon } from './ui'
import { EngineProblem } from './EngineProblem'
import { Select } from './Select'

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
type Listed = { models: string[]; labels?: Record<string, { label: string; hint?: string }>; error?: string }
const lists = new Map<string, Promise<Listed>>()

// What a harness offers: the app's list on Claude's plan; Codex's own catalog (newest first);
// what OpenCode or Pi list; what the gateway lists.
export function useEngineModels(engine: EngineId | undefined): { options: ModelOption[]; loading: boolean; error?: string } {
  const st = useStore((s) => (engine ? s.settings.engines[engine] : undefined))
  const plan = !!engine && (engine === 'claude' || engine === 'codex') && st?.route !== 'gateway'
  const fixed = plan && engine === 'claude'
  const id = engine && st?.installed && !fixed ? `${engine}|${st.route}|${st.gateway ?? ''}|${st.account ?? ''}` : ''
  const [got, setGot] = useState<({ id: string } & Listed) | null>(null)
  useEffect(() => {
    if (!id || !engine) return
    if (!lists.has(id)) lists.set(id, engineModels(engine).catch((e: unknown) => ({ models: [], error: String(e) })))
    let live = true
    void lists.get(id)!.then((r) => {
      // Codex's names, for wherever a model shows (an agent's page, a card).
      if (engine === 'codex' && r.labels) rememberModels(Object.entries(r.labels).map(([slug, l]) => ({ id: slug, engine, label: l.label, hint: l.hint ?? '' })))
      if (live) setGot({ id, ...r })
    })
    return () => {
      live = false
    }
  }, [id, engine])
  if (!engine) return { options: [], loading: false }
  const mine = got?.id === id ? got : undefined
  const app = (): ModelOption[] => MODELS.filter((m) => m.engine === engine).map((m) => ({ value: m.id, label: m.label, hint: m.hint }))
  if (fixed) return { options: app(), loading: false }
  // Codex on a plan or a key: its catalog, the app's own list until it comes (or if it can't).
  if (plan)
    return mine?.models.length
      ? { options: mine.models.map((slug) => ({ value: codexValue(slug), label: mine.labels?.[slug]?.label ?? slug, hint: L('', mine.labels?.[slug]?.hint ?? '') || undefined })), loading: false }
      : { options: app(), loading: false }
  // OpenCode's free models (opencode/…-free) run on its free tier, up to its usage limit.
  const free = (m: string): string | undefined => (engine === 'opencode' && /^opencode\/.+-free$/.test(m) ? L('grátis', 'free') : undefined)
  return { options: (mine?.models ?? []).map((m) => ({ value: customModel(engine, m), label: m, hint: free(m) })), loading: !!id && !mine, error: mine?.error }
}

const OTHER = '__outro__'

// Provider of a model value: "<provider>/<model>" takes the part before "/",
// otherwise "<engine>:<name>" takes the part before ":", else a fallback group.
const providerOf = (value: string): string => {
  const parts = value.split('/')
  if (parts.length > 1) return parts[0]!
  const colon = value.split(':')
  if (colon.length > 1) return colon[0]!
  return L('Outros', 'Others')
}

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

  // Engine/harness choices for the first pick.
  const engineOptions = useMemo(
    () => [...choices.map((e) => ({ value: e, label: ENGINES[e].label })), ...(jev ? [{ value: 'jev', label: 'TypeSafe · Jev' }] : [])],
    [choices, jev]
  )
  // The models, grouped by provider (part before "/", or before ":") when there's more than one;
  // "Other model…" last either way.
  const modelChoices = useMemo((): { groups?: Record<string, Record<string, string>>; options?: { value: string; label: string }[] } => {
    const label = (o: (typeof options)[number]): string => (o.hint ? `${o.label} · ${o.hint}` : o.label)
    const otherOne = { value: OTHER, label: L('Outro modelo…', 'Other model…') }
    const byProvider: Record<string, Record<string, string>> = {}
    for (const o of options) (byProvider[providerOf(o.value)] ??= {})[o.value] = label(o)
    if (Object.keys(byProvider).length < 2) return { options: [...options.map((o) => ({ value: o.value, label: label(o) })), otherOne] }
    return { groups: { ...byProvider, [otherOne.label]: { [OTHER]: otherOne.label } } }
  }, [options])

  // A harness's own card passes just that harness: it's already chosen there, so no select.
  const fixed = engines?.length === 1 && !jev
  if (!engine && !jev)
    return (
      <p className="hint hint--warn">
        {L('Nenhum Claude Code ou Codex pronto ainda.', 'No Claude Code or Codex ready yet.')}{' '}
        <button className="link" onClick={() => (setTab('settings', 'modelos'), navigate({ kind: 'settings' }))}>
          {L('Configurar', 'Set up')}
        </button>
      </p>
    )
  return (
    <div className="model-picker">
      {!fixed && (
        <Select
          value={value === 'jev' ? 'jev' : engine}
          onChange={(v) => {
            setTyping(false)
            const vv = v ?? ''
            // On a plan, the harness's first model; otherwise the person picks from its list.
            const plan = vv !== 'jev' && statuses[vv as EngineId].route === 'plan' ? MODELS.find((x) => x.engine === vv) : undefined
            onChange(vv === 'jev' ? 'jev' : (plan?.id ?? customModel(vv as EngineId, '')))
          }}
          options={engineOptions}
        />
      )}
      {value !== 'jev' && engine && (
        <>
          <Select
            className="grow"
            value={other ? OTHER : inList ? value : null}
            searchable
            {...modelChoices}
            placeholder={loading ? L('Buscando os modelos…', 'Fetching the models…') : options.length ? L('Escolha um modelo…', 'Pick a model…') : L('Sem lista: use Outro modelo', 'No list: use Other model')}
            onChange={(v) => {
              if (v === OTHER) {
                setTyping(true)
                onChange(customModel(engine, name))
                return
              }
              setTyping(false)
              onChange(v ?? '')
            }}
          />
          {other && (
            <input className="model-name grow" autoFocus={typing && !name} value={name} spellCheck={false} placeholder={L('O nome exato do modelo', 'The exact model name')} onChange={(e) => onChange(customModel(engine, e.target.value))} />
          )}
        </>
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
  const checkId = useId()
  const [model, setModel] = useState('')
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)
  // No terminal could be opened: the command, for the person to run.
  const [manual, setManual] = useState<string | null>(null)
  // The install: started in a terminal, or blocked on Node.js for an npm package.
  const [install, setInstall] = useState<'started' | 'node' | null>(null)
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
        <button id={checkId} className={`harness__check ${picked ? 'is-on' : ''}`} disabled={!!st.soon || !st.installed} onClick={toggle} aria-label={L(`Usar o ${ENGINES[engine].label}`, `Use ${ENGINES[engine].label}`)}>
          {picked && <Icon name="check" size={12} />}
        </button>
        {/* The name is the check's label: a click on it is a click on the check, disabled when it is. */}
        <label className="grow harness__name" htmlFor={checkId}>
          <strong>{ENGINES[engine].label}</strong>
          <span className="harness__account">
            {st.checking ? L('Conferindo…', 'Checking…') : !st.installed ? L('Não instalado', 'Not installed') : st.account ?? (st.loggedIn ? L('Pronto', 'Ready') : L('Falta entrar', 'Not signed in'))}
          </span>
        </label>
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
        {!st.installed && !st.soon && (
          <button
            className="btn btn--sm btn--primary"
            title={L('Abre um terminal que instala pra você', 'Opens a terminal that installs it for you')}
            onClick={() => void installEngine(engine).then((r) => setInstall(r.needsNode ? 'node' : r.opened ? 'started' : null))}
          >
            {L('Instalar', 'Install')}
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
          <span className="hint">{L('Não deu pra abrir um terminal daqui. Pra entrar, cole isto no seu terminal:', "A terminal couldn't be opened from here. To sign in, paste this in your terminal:")}</span>
          <code className="harness__cmd">{manual}</code>
        </div>
      )}
      {!st.installed && install === 'started' && <p className="hint harness__body">{L('Instalando no terminal que abriu. Quando terminar, ele aparece aqui sozinho.', 'Installing in the terminal that opened. Once it finishes, it shows up here on its own.')}</p>}
      {!st.installed && install === 'node' && (
        <p className="hint hint--warn harness__body">
          {L(`O ${ENGINES[engine].label} precisa do Node.js. Instale o Node.js e depois clique em Instalar de novo.`, `${ENGINES[engine].label} needs Node.js. Install Node.js, then click Install again.`)}{' '}
          <button className="btn btn--ghost btn--sm" onClick={() => openExternal('https://nodejs.org/')}>
            {L('Baixar o Node.js', 'Get Node.js')}
          </button>
        </p>
      )}
      {!st.installed && (
        <div className="harness__body">
          {/* npm.cmd: PowerShell blocks npm's .ps1 on a fresh Windows (scripts disabled). */}
          <span className="hint">{windows ? L('Ou cole no PowerShell:', 'Or paste in PowerShell:') : L('Ou cole no terminal:', 'Or paste in a terminal:')}</span>
          <code className="harness__cmd">{windows ? (ENGINES[engine].windows ?? ENGINES[engine].install).replace(/^npm /, 'npm.cmd ') : ENGINES[engine].install}</code>
        </div>
      )}
      {st.warning && <p className="hint hint--warn harness__body">{st.warning}</p>}
      {st.route === 'gateway' && picked && <p className="hint harness__body">{L(`Os agentes usam esse mesmo gateway. A telemetria do ${ENGINES[engine].label} fica desligada, pra nada sair por fora dele.`, `Agents use this same gateway. ${ENGINES[engine].label}'s telemetry stays off, so nothing leaves around it.`)}</p>}
      {st.soon && st.installed && <p className="hint harness__body">{L(`A sua configuração já foi encontrada. O Tucano ainda não roda agentes no ${ENGINES[engine].label}: chega numa próxima versão.`, `Your setup was found. Tucano doesn't run agents on ${ENGINES[engine].label} yet: it's coming in a future version.`)}</p>}
      {testing && (
        <div className="harness__body">
          <div className="harness__test">
            <ModelPicker value={model} onChange={setModel} engines={[engine]} />
            <button className="btn btn--primary btn--sm" disabled={!modelInfo(model)?.id} onClick={() => void test()}>
              {L('Mandar teste', 'Send a test')}
            </button>
          </div>
          {result &&
            (result.ok ? (
              <p className="note note--ok">
                <Icon name="check" size={14} /> {`${L('Funcionando.', 'Working.')} ${result.message}`}
              </p>
            ) : (
              <EngineProblem engine={engine} message={result.message} onSignIn={() => void loginEngine(engine).then((r) => setManual(r.opened ? null : r.command))} onRetry={() => void test()} />
            ))}
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
        <strong>{L('No Claude Code, Codex e outros que você usa', 'In Claude Code, Codex and others you use')}</strong>
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

// More logins of Claude Code, Codex and Grok: a work account beside a personal one. Each lives in a
// folder of its own and is signed into through the CLI, in a terminal; an agent picks one on its page.
export function AccountsCard(): ReactNode {
  const accounts = useStore((s) => s.settings.accounts ?? [])
  const engines = useStore((s) => s.settings.engines)
  const [engine, setEngine] = useState<AccountEngine>('claude')
  const [name, setName] = useState('')
  const [manual, setManual] = useState<Record<string, string>>({})
  const [removing, setRemoving] = useState<string | null>(null)
  const [leftBehind, setLeftBehind] = useState(false)
  const add = async (): Promise<void> => {
    const a = await addAccount(engine, name)
    setName('')
    const r = await loginAccount(a.id)
    if (!r.opened) setManual((m) => ({ ...m, [a.id]: r.command }))
  }
  // Removing takes the account out of the list whatever happens next; the folder with its login can
  // still be held by a CLI someone left open, and then it goes at the next launch instead.
  const drop = async (id: string): Promise<void> => {
    try {
      const r = await removeAccount(id)
      setLeftBehind(!r.folder)
    } finally {
      setRemoving(null)
    }
  }
  return (
    <div className="accounts">
      {accounts.map((a: Account) => (
        <div key={a.id} className="key-row">
          <Icon name="user" />
          <div className="grow">
            <strong>{a.name}</strong>
            <p className="muted small">
              {ENGINES[a.engine].label} · {a.loggedIn ? (a.detail ?? L('Pronta', 'Ready')) : L('Falta entrar', 'Not signed in')}
            </p>
            {manual[a.id] && !a.loggedIn && (
              <>
                <span className="hint">{L('Não deu pra abrir um terminal daqui. Pra entrar, cole isto no seu terminal:', "A terminal couldn't be opened from here. To sign in, paste this in your terminal:")}</span>
                <code className="harness__cmd">{manual[a.id]}</code>
              </>
            )}
          </div>
          {!a.loggedIn && (
            <button className="btn btn--sm btn--primary" onClick={() => void loginAccount(a.id).then((r) => setManual((m) => ({ ...m, [a.id]: r.opened ? '' : r.command })))}>
              {L('Entrar', 'Sign in')}
            </button>
          )}
          {removing === a.id ? (
            <button className="btn btn--sm btn--danger" onClick={() => void drop(a.id)}>
              {L('Remover', 'Remove')}
            </button>
          ) : (
            <button className="btn btn--ghost btn--sm" onClick={() => setRemoving(a.id)}>
              {L('Remover', 'Remove')}
            </button>
          )}
        </div>
      ))}
      <div className="row row--center accounts__add">
        <Select
          value={engine}
          onChange={(v) => { if (v) void setEngine(v as AccountEngine) }}
          options={ACCOUNT_ENGINES.filter((e) => engines[e].installed).map((e) => ({ value: e, label: ENGINES[e].label }))}
          placeholder={L('Motor', 'Engine')}
        />
        <input className="grow" placeholder={L('Nome da conta (ex.: Trabalho)', 'Account name (e.g. Work)')} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <button className="btn btn--sm" disabled={!engines[engine].installed} onClick={() => void add()}>
          {L('Adicionar e entrar', 'Add and sign in')}
        </button>
      </div>
      {removing && (
        <p className="hint hint--warn">
          {L(
            `Os agentes dessa conta voltam pro login de sempre do ${ENGINES[accounts.find((a) => a.id === removing)?.engine ?? 'claude'].label}, e o login dela sai deste computador.`,
            `Its agents go back to ${ENGINES[accounts.find((a) => a.id === removing)?.engine ?? 'claude'].label}’s usual login, and its sign-in leaves this computer.`
          )}
        </p>
      )}
      {leftBehind && (
        <p className="hint hint--warn">
          {L(
            'O login dessa conta não saiu agora porque o CLI dela ainda estava aberto: feche a janela dele. Ele sai na próxima vez que o Tucano abrir.',
            'That account’s sign-in did not leave now because its CLI was still open: close its window. It goes the next time Tucano opens.'
          )}
        </p>
      )}
    </div>
  )
}

// Which login of its harness an agent runs on: the usual one, or one of the accounts added in Settings.
export function AccountPicker({ draft, patch }: { draft: Agent; patch: (p: Partial<Agent>) => void }): ReactNode {
  const engine = modelInfo(draft.modelId)?.engine
  const accounts = useStore((s) => (s.settings.accounts ?? []).filter((a) => a.engine === engine))
  if (!accounts.length || !engine) return null
  const value = accounts.some((a) => a.id === draft.accountId) ? draft.accountId! : ''
  const chosen = accounts.find((a) => a.id === value)
  const usualLabel = L(`A de sempre do ${ENGINES[engine].label}`, `${ENGINES[engine].label}’s usual one`)
  return (
    <label className="field">
      <span className="field__label">{L('Conta', 'Account')}</span>
      <Select
        value={value || null}
        onChange={(v) => patch({ accountId: v || undefined })}
        options={[
          { value: '', label: usualLabel },
          ...accounts.map((a) => ({ value: a.id, label: a.name + (a.loggedIn ? '' : L(' (falta entrar)', ' (not signed in)')) }))
        ]}
        placeholder={usualLabel}
      />
      {chosen && !chosen.loggedIn && <span className="hint hint--warn">{L('Essa conta ainda não entrou: o agente não responde até você entrar nela em Configurações › Modelos.', 'This account isn’t signed in yet: the agent won’t reply until you sign in under Settings › Models.')}</span>}
    </label>
  )
}
