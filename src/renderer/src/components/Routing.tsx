// Settings › Routing: the pools Jev picks from, the roles that own a chain of their own, and the
// thin line over a reply that says what it read and what it chose. Everything the person edits here
// is exactly what the core routes on: src/shared/routing.ts holds the shapes both sides share.
import { L } from '../../../shared/lang'
import { useMemo, useState, type ReactNode } from 'react'
import { ENGINES, modelInfo, type Effort, type EngineId } from '../../../shared/types'
import {
  defaultRouting,
  isTier,
  normalizeRouting,
  POOLS,
  TIERS,
  roleBars,
  targetId,
  type FreePolicy,
  type Pool,
  type PoolSetting,
  type RoleCandidate,
  type RoleSetting,
  type RouteTarget,
  type RouteTrace,
  type RoutingConfig,
  type Tier
} from '../../../shared/routing'
import { navigate, setTab, updateSettings, useStore } from '../store'
import { Select } from './Select'
import { Card, Field, JevKey, Toggle } from './Pages'
import { useEngineModels, usableEngines } from './Harness'
import { Icon } from './ui'

// ---------- names ----------

// The five capability tiers and the free pool, in the words the screen and the line use. Read through
// a function, not a module-level table: L() answers in the language set when it's called, and a table
// built at import time would freeze the one the app started with.
export function poolName(p: Pool): string {
  return {
    free: L('Grátis', 'Free'),
    t1: L('Tier 1 · Rápido', 'Tier 1 · Quick'),
    t2: L('Tier 2 · Comum', 'Tier 2 · Standard'),
    t3: L('Tier 3 · Forte', 'Tier 3 · High'),
    t4: L('Tier 4 · Premium', 'Tier 4 · Premium'),
    t5: L('Tier 5 · Ultra premium', 'Tier 5 · Ultra premium')
  }[p]
}

// The same tiers by the word alone, without the "Tier N ·". The thin line says this one beside the
// demand bar: with the number gone the row reads as a judgment, and the rail still carries "Tier 3"
// where the ladder itself is being edited.
export function tierWord(p: Pool): string {
  return {
    free: L('Grátis', 'Free'),
    t1: L('Rápido', 'Quick'),
    t2: L('Comum', 'Standard'),
    t3: L('Forte', 'High'),
    t4: L('Premium', 'Premium'),
    t5: L('Ultra premium', 'Ultra premium')
  }[p]
}

// The first roles, in the order they show: the work that most often needs a different model.
const FIRST_ROLES = ['code', 'review', 'plan', 'debug'] as const

const ROLE_NAMES: Record<string, [string, string]> = {
  code: ['Código', 'Code'],
  review: ['Revisão', 'Review'],
  plan: ['Plano', 'Plan'],
  debug: ['Depuração', 'Debug'],
  refactor: ['Refatorar', 'Refactor'],
  research: ['Pesquisa', 'Research'],
  write: ['Escrita', 'Write'],
  explain: ['Explicar', 'Explain'],
  operate: ['Operar', 'Operate'],
  chat: ['Conversa', 'Chat']
}

export function roleName(id: string): string {
  const name = ROLE_NAMES[id]
  return name ? L(name[0], name[1]) : id
}

// The four thinking levels Tucano's engines take, and what each is called.
const thinkingLabel = (effort: Effort): string =>
  effort === 'low' ? L('Baixo', 'Low') : effort === 'medium' ? L('Médio', 'Medium') : effort === 'high' ? L('Alto', 'High') : effort === 'xhigh' ? L('Máximo', 'Extra high') : effort

const thinkingOptions = (): { value: string; label: string }[] => ['low', 'medium', 'high', 'xhigh'].map((e) => ({ value: e, label: thinkingLabel(e as Effort) }))
const engineLabel = (engine: EngineId): string => ENGINES[engine]?.label ?? engine
// The model as people know it: its label when it's one of the list's, its id otherwise.
const modelLabel = (model: string): string => modelInfo(model)?.label ?? model

const targetLabel = (t: RouteTarget): string => `${engineLabel(t.engine)} · ${modelLabel(t.model)} · ${thinkingLabel(t.effort)}`

const count = (chain: RouteTarget[]): number => chain.length

// ---------- the switch, in the Jev block ----------

// One switch turns the feature on and reveals the tab; it never opts an agent in by itself.
export function SmartRoutingSwitch(): ReactNode {
  const settings = useStore((s) => s.settings)
  const routing = settings.routing?.enabled === true
  const on = settings.routing ?? defaultRouting()
  const set = (enabled: boolean, rest: Partial<RoutingConfig> = {}): void => updateSettings({ routing: normalizeRouting({ ...on, ...rest, enabled }) })
  return (
    <div className="field">
      <div className="row row--between">
        <span className="field__label">{L('Roteamento inteligente', 'Smart model routing')}</span>
        <Toggle on={routing} onChange={(v) => set(v)} />
      </div>
      <span className="hint">
        {L(
          'O Jev lê cada pedido e escolhe o modelo nos seus pools. Acrescenta a aba Rotas às Configurações; nenhum agente passa a usá-lo sozinho.',
          'Jev reads each prompt and picks the model from your pools. Adds the Routing tab to Settings; no agent starts using it on its own.'
        )}
      </span>
      {routing && (
        <p className="small">
          <a
            className="link"
            href="#routing"
            onClick={(ev) => {
              ev.preventDefault()
              navigate({ kind: 'settings' })
              setTab('settings', 'roteamento')
            }}
          >
            {L('Configurar as rotas', 'Configure routing')}
          </a>
        </p>
      )}
      {routing && !settings.jevKey && (
        <>
          <p className="hint hint--warn">{L('Falta a chave do TypeSafe pra começar a rotear.', 'Add a TypeSafe key to start routing.')}</p>
          <JevKey saved={false} />
        </>
      )}
    </div>
  )
}

// ---------- the tab ----------

export function RoutingPane(): ReactNode {
  const settings = useStore((s) => s.settings)
  const config = useMemo(() => normalizeRouting(settings.routing ?? defaultRouting()), [settings.routing])
  const [pool, setPool] = useState<Pool>('t2')
  const [role, setRole] = useState('') // '': the pool's own chain; otherwise a role's
  const save = (next: RoutingConfig): void => updateSettings({ routing: next })

  const setPoolSetting = (p: Pool, patch: Partial<PoolSetting>): void => save({ ...config, pools: { ...config.pools, [p]: { ...config.pools[p]!, ...patch } } })
  const setRoleSetting = (r: string, patch: Partial<RoleSetting>): void => save({ ...config, roles: { ...config.roles, [r]: { ...config.roles[r]!, ...patch } } })

  const enabled = config.enabled
  const anyModel = POOLS.some((p) => config.pools[p].chain.length > 0) || Object.values(config.roles).some((r) => r.chain.length > 0)
  const roleIds = useMemo(() => Object.keys(config.roles), [config.roles])
  const rest = roleIds.filter((r) => !(FIRST_ROLES as readonly string[]).includes(r))
  const chain: RoleCandidate[] = role ? (config.roles[role]?.chain ?? []) : config.pools[pool].chain
  const setChain = (next: RoleCandidate[]): void => (role ? setRoleSetting(role, { chain: next }) : setPoolSetting(pool, { chain: next as RouteTarget[] }))

  return (
    <div className="routing">
      <div className="routing__head">
        <div>
          <h2 className="routing__title">{L('Rotas', 'Routing')}</h2>
          <p className="muted small">
            {enabled
              ? L('O Jev lê cada pedido e escolhe o modelo nos pools abaixo.', 'Jev reads each prompt and picks the model from the pools below.')
              : L('Desligado: nada é roteado até você ligar em Agentes › Roteador.', 'Off: nothing is routed until you turn it on under Agents › Router.')}
          </p>
        </div>
        <span className={`routing__status ${enabled ? 'is-on' : ''}`}>{enabled ? L('Ligado', 'On') : L('Desligado', 'Off')}</span>
      </div>

      {enabled && !settings.jevKey && (
        <Card title={L('Chave do TypeSafe', 'TypeSafe key')} lead={L('O Jev é do TypeSafe e usa a mesma chave dos outros classificadores do app.', 'Jev is TypeSafe’s and uses the same key as the app’s other classifiers.')}>
          <JevKey saved={!!settings.jevKey} />
        </Card>
      )}
      {enabled && !anyModel && (
        <p className="hint hint--warn">{L('Nenhum pool tem modelo ainda. Eles rodam no modelo do próprio agente até você pôr um.', 'No pool has a model yet. Until you add one, replies run on the agent’s own model.')}</p>
      )}

      <div className="routing__body">
        <nav className="routing__rail" role="tablist" aria-label={L('Pools', 'Pools')} aria-orientation="vertical">
          {POOLS.map((p) => {
            const n = count(config.pools[p].chain)
            const active = !role && p === pool
            return (
              <button
                key={p}
                role="tab"
                aria-selected={active}
                className={`routing__pool ${active ? 'is-active' : ''}`}
                aria-label={n ? `${poolName(p)} · ${n}` : `${poolName(p)} · ${L('sem modelo', 'not configured')}`}
                onClick={() => {
                  setPool(p)
                  setRole('')
                }}
              >
                <span className="routing__pool-name">{poolName(p)}</span>
                <span className={`routing__pool-count ${n ? '' : 'is-empty'}`} title={n ? undefined : L('Sem modelo', 'Not configured')}>
                  {n}
                </span>
              </button>
            )
          })}
        </nav>

        <section className="routing__editor">
          <div className="routing__roles" role="tablist" aria-label={L('Corrente', 'Chain')}>
            <button role="tab" aria-selected={!role} className={`routing__role ${!role ? 'is-active' : ''}`} onClick={() => setRole('')}>
              {L('O pool', 'The pool')}
            </button>
            {FIRST_ROLES.map((r) =>
              config.roles[r] ? (
                <button key={r} role="tab" aria-selected={role === r} className={`routing__role ${role === r ? 'is-active' : ''}`} onClick={() => setRole(r)}>
                  {roleName(r)}
                </button>
              ) : null
            )}
            {rest.length > 0 && (
              <Select
                className="routing__role-more"
                value={rest.includes(role) ? role : null}
                placeholder={L('Mais papéis…', 'More roles…')}
                options={rest.map((r) => ({ value: r, label: roleName(r) }))}
                onChange={(v) => {
                  if (v) setRole(v)
                }}
              />
            )}
          </div>

          {role ? (
            <RoleEditor
              role={role}
              setting={config.roles[role]!}
              floor={config.roleFloor[role]}
              pool={pool}
              onDescriptor={(descriptor) => setRoleSetting(role, { descriptor })}
              onFloor={(floor) => {
                const roleFloor = { ...config.roleFloor }
                if (floor && isTier(floor)) roleFloor[role] = floor
                else delete roleFloor[role]
                save({ ...config, roleFloor })
              }}
            />
          ) : (
            <PoolEditor
              pool={pool}
              setting={config.pools[pool]}
              policy={config.free.policy}
              allowTier5={config.allowTier5}
              onDescriptor={(descriptor) => setPoolSetting(pool, { descriptor })}
              onPolicy={(policy) => save({ ...config, free: { policy } })}
              onAllowTier5={(allowTier5) => save({ ...config, allowTier5 })}
            />
          )}

          <ChainEditor
            label={role ? L(`Modelos só do papel ${roleName(role)}`, `Models for ${roleName(role)} only`) : L(`Modelos do ${poolName(pool)}`, `${poolName(pool)} models`)}
            note={
              role
                ? L('Tentados antes dos do pool, quando o pedido cai num tier igual ou acima do piso do papel.', 'Tried before the pool’s, when the prompt lands on a tier at or above the role’s floor.')
                : L('Na ordem. O primeiro que existir e estiver logado responde.', 'In order. The first that exists and is signed in answers.')
            }
            chain={chain}
            onChange={setChain}
            specialists={!!role}
          />
        </section>
      </div>
    </div>
  )
}

function PoolEditor({
  pool,
  setting,
  policy,
  allowTier5,
  onDescriptor,
  onPolicy,
  onAllowTier5
}: {
  pool: Pool
  setting: PoolSetting
  policy: FreePolicy
  allowTier5: boolean
  onDescriptor: (v: string) => void
  onPolicy: (v: FreePolicy) => void
  onAllowTier5: (v: boolean) => void
}): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="routing__pool-editor">
      <Field label={L('Descrição', 'Descriptor')} hint={L('Para que serve este pool, nas suas palavras. É só pra você: quem decide é o tier do Jev.', 'What this pool is for, in your words. It’s for you: Jev’s tier is what decides.')}>
        <input
          value={draft ?? setting.descriptor}
          maxLength={400}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null && draft !== setting.descriptor) onDescriptor(draft)
            setDraft(null)
          }}
        />
      </Field>
      {pool === 'free' && (
        <Field
          label={L('Quando usar os grátis', 'When to use free')}
          hint={L(
            'Os grátis ficam fora dos tiers: o tier que o Jev pediu continua registrado, mesmo quando um grátis responde.',
            'Free sits outside the tiers: the tier Jev asked for stays on the record even when a free model answers.'
          )}
        >
          <Select
            value={policy}
            onChange={(v) => v && onPolicy(v as FreePolicy)}
            options={[
              { value: 'prefer', label: L('Antes dos pagos', 'Before the paid pools') },
              { value: 'fallback', label: L('Só quando faltar modelo pago', 'Only when no paid model can run') },
              { value: 'off', label: L('Nunca', 'Never') }
            ]}
          />
        </Field>
      )}
      {pool === 't5' && (
        <div className="field">
          <div className="row row--between">
            <span className="field__label">{L('Deixar o Jev chegar aqui sozinho', 'Let Jev reach tier 5 on its own')}</span>
            <Toggle on={allowTier5} onChange={onAllowTier5} />
          </div>
          <span className="hint">
            {L(
              'Desligado, o tier 5 só existe se você escolher. Ligado, um pedido que o Jev julgar no máximo e sobre o qual ele estiver seguro pode rodar aqui sem perguntar.',
              'Off, tier 5 is only ever your own pick. On, a prompt Jev judges maximal, and is sure about, may run here without asking.'
            )}
          </span>
        </div>
      )}
      <p className="hint">
        {pool === 'free'
          ? L('Os grátis ficam fora dos tiers: são um pool à parte, com corrente própria.', 'Free sits outside the tiers: its own pool, with a chain of its own.')
          : L('Sem modelo que possa rodar aqui, a resposta desce para o tier de baixo. Nunca sobe.', 'When nothing here can run, the reply walks down to the tier below. It never walks up.')}
      </p>
    </div>
  )
}

function RoleEditor({ role, setting, floor, pool, onDescriptor, onFloor }: { role: string; setting: RoleSetting; floor?: Tier; pool: Pool; onDescriptor: (v: string) => void; onFloor: (v: string | null) => void }): ReactNode {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <div className="routing__pool-editor">
      <Field
        label={L('O que é este papel', 'What this role is')}
        hint={L('É o critério que o Jev lê para escolher este papel. Muda como ele classifica; não muda o preço.', 'This is the criterion Jev reads to pick the role. It changes how it classifies; not the price.')}
      >
        <textarea rows={2} value={draft ?? setting.descriptor} maxLength={400} onChange={(e) => setDraft(e.target.value)} onBlur={() => { if (draft !== null && draft !== setting.descriptor) onDescriptor(draft); setDraft(null) }} />
      </Field>
      <Field label={L('Nunca abaixo de', 'Never below')} hint={L('Um piso para o tier deste papel: revisão e plano não descem de um modelo forte.', 'A floor for this role’s tier: review and planning don’t drop to a weak model.')}>
        <Select
          value={floor ?? 'none'}
          onChange={(v) => onFloor(v === 'none' ? null : v)}
          options={[{ value: 'none', label: L('Sem piso', 'No floor') }, ...TIERS.map((t) => ({ value: t, label: poolName(t) }))]}
        />
      </Field>
      <p className="hint">
        {setting.chain.length
          ? L(`No ${poolName(pool)} e acima, os modelos deste papel são tentados primeiro.`, `On ${poolName(pool)} and above, this role’s models are tried first.`)
          : L(`Sem modelos próprios: o ${poolName(pool)} decide.`, `No models of its own: ${poolName(pool)} decides.`)}
        {setting.chain.length > 0 &&
          L(' Cada modelo abaixo tem o tier mínimo em que pode ser gasto.', ' Each model below says the lowest tier it may be spent from.')}
      </p>
    </div>
  )
}

// The ordered chain: harness, model, how hard it thinks, and the order itself. In a role's chain each
// entry also says the lowest tier it may be spent from — the person's own eligibility call, which is a
// different thing from the role's floor above.
function ChainEditor({
  label,
  note,
  chain,
  onChange,
  specialists = false
}: {
  label: string
  note: string
  chain: RoleCandidate[]
  onChange: (next: RoleCandidate[]) => void
  specialists?: boolean
}): ReactNode {
  const move = (from: number, to: number): void => {
    if (to < 0 || to >= chain.length) return
    const next = [...chain]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row!)
    onChange(next)
  }
  const set = (at: number, target: RoleCandidate): void => onChange(chain.map((t, i) => (i === at ? target : t)))
  return (
    <div className="routing__chain">
      <div className="row row--between">
        <strong>{label}</strong>
        <span className="muted small">{note}</span>
      </div>
      {chain.length === 0 && <p className="hint">{L('Vazio. Acrescente o primeiro modelo abaixo.', 'Empty. Add the first model below.')}</p>}
      <ol className="route-list">
        {chain.map((t, i) => (
          <TargetRow
            key={`${i}-${t.engine}-${t.model}-${t.effort}`}
            target={t}
            ordinal={i + 1}
            first={i === 0}
            last={i === chain.length - 1}
            onChange={(next) => set(i, next)}
            onUp={() => move(i, i - 1)}
            onDown={() => move(i, i + 1)}
            onRemove={() => onChange(chain.filter((_, j) => j !== i))}
            {...(specialists
              ? {
                  minTier: t.minTier,
                  onMinTier: (minTier?: Tier) => set(i, { ...t, ...(minTier ? { minTier } : { minTier: undefined }) })
                }
              : {})}
          />
        ))}
      </ol>
      <AddTarget onAdd={(t) => onChange([...chain, t])} />
    </div>
  )
}

const withIdentity = (t: RouteTarget | RoleCandidate): RoleCandidate => ({
  ...t,
  id: targetId({ engine: t.engine, ...(t.accountId ? { accountId: t.accountId } : {}), model: t.model, effort: t.effort })
})

function TargetRow({
  target,
  ordinal,
  first,
  last,
  onChange,
  onUp,
  onDown,
  onRemove,
  minTier,
  onMinTier
}: {
  target: RoleCandidate
  ordinal: number
  first: boolean
  last: boolean
  onChange: (t: RoleCandidate) => void
  onUp: () => void
  onDown: () => void
  onRemove: () => void
  minTier?: Tier
  onMinTier?: (t?: Tier) => void
}): ReactNode {
  const usable = useStore((s) => usableEngines(s.settings))
  const engines = useMemo(() => [...new Set([target.engine, ...usable])], [target.engine, usable])
  const { options } = useEngineModels(target.engine)
  const models = useMemo(() => {
    const list = options.map((o) => ({ value: o.value, label: o.hint ? `${o.label} · ${o.hint}` : o.label }))
    if (!list.some((o) => o.value === target.model)) list.unshift({ value: target.model, label: modelLabel(target.model) })
    return list
  }, [options, target.model])
  return (
    <li className="route-row">
      <span className="route-row__n" aria-hidden="true">{ordinal}</span>
      <Select
        className="route-row__engine"
        value={target.engine}
        aria-label={L('Harness', 'Harness')}
        options={engines.map((e) => ({ value: e, label: engineLabel(e) }))}
        onChange={(v) => v && onChange(withIdentity({ ...target, engine: v as EngineId }))}
      />
      <Select
        className="route-row__model grow"
        value={target.model}
        searchable
        aria-label={L('Modelo', 'Model')}
        options={models}
        placeholder={L('Escolha o modelo', 'Pick the model')}
        onChange={(v) => v && onChange(withIdentity({ ...target, model: v }))}
      />
      <Select
        className="route-row__effort"
        value={target.effort}
        aria-label={L('Raciocínio', 'Thinking')}
        options={thinkingOptions()}
        onChange={(v) => v && onChange(withIdentity({ ...target, effort: v as Effort }))}
      />
      {onMinTier && (
        <Select
          className="route-row__min"
          value={minTier ?? 'any'}
          aria-label={L('Tier mínimo', 'Lowest tier')}
          options={[{ value: 'any', label: L('De qualquer tier', 'Any tier') }, ...TIERS.map((t) => ({ value: t, label: poolName(t) }))]}
          onChange={(v) => onMinTier(v && v !== 'any' && isTier(v) ? v : undefined)}
        />
      )}
      <span className="route-row__actions">
        <button type="button" className="icon-btn" aria-label={L('Subir', 'Move up')} disabled={first} onClick={onUp}>
          <Icon name="chevron" size={12} />
        </button>
        <button type="button" className="icon-btn route-row__down" aria-label={L('Descer', 'Move down')} disabled={last} onClick={onDown}>
          <Icon name="chevron" size={12} />
        </button>
        <button type="button" className="icon-btn" aria-label={L('Tirar', 'Remove')} onClick={onRemove}>
          <Icon name="x" size={12} />
        </button>
      </span>
    </li>
  )
}

function AddTarget({ onAdd }: { onAdd: (t: RouteTarget) => void }): ReactNode {
  const usable = useStore((s) => usableEngines(s.settings))
  const engines = usable.length ? usable : (Object.keys(ENGINES) as EngineId[])
  const [engine, setEngine] = useState<EngineId>(engines[0]!)
  const { options } = useEngineModels(engine)
  const [model, setModel] = useState<string>('')
  const [effort, setEffort] = useState<Effort>('medium')
  const chosen = model || options[0]?.value || ''
  const models = options.length ? options.map((o) => ({ value: o.value, label: o.hint ? `${o.label} · ${o.hint}` : o.label })) : [{ value: chosen, label: chosen || L('Sem lista de modelos', 'No model list') }]
  return (
    <div className="route-add">
      <Select value={engine} aria-label={L('Harness', 'Harness')} options={engines.map((e) => ({ value: e, label: engineLabel(e) }))} onChange={(v) => { if (v) { setEngine(v as EngineId); setModel('') } }} />
      <Select className="grow" value={chosen || null} searchable aria-label={L('Modelo', 'Model')} options={models} placeholder={L('Escolha o modelo', 'Pick the model')} onChange={(v) => setModel(v ?? '')} />
      <Select value={effort} aria-label={L('Raciocínio', 'Thinking')} options={thinkingOptions()} onChange={(v) => v && setEffort(v as Effort)} />
      <button type="button" className="btn btn--sm" disabled={!chosen} onClick={() => { onAdd(withIdentity({ id: '', engine, model: chosen, effort })); setModel('') }}>
        {L('Acrescentar', 'Add')}
      </button>
    </div>
  )
}

// ---------- the thin line over a reply ----------

// One read of the prompt, drawn small: three bars for Jev's judgment, then the pool and the model it
// chose. It persists with the reply, and what it says is the trace the core kept, never a recount.
export function RouteLine({ route }: { route: RouteTrace }): ReactNode {
  const [open, setOpen] = useState(false)
  const reading = route.reading
  const pool = route.requested
  const target = route.selected ?? route.baseline
  const state =
    route.state === 'unavailable'
      ? L('Rotas indisponíveis', 'Routing unavailable')
      : route.state === 'exhausted'
        ? L('Não enviada', 'Not sent')
        : route.state === 'fallback'
          ? L('Alternativa', 'Fallback')
          : route.state === 'kept'
            ? L('Mantido', 'Kept')
            : undefined
  const why = route.state === 'unavailable' ? route.error : route.state === 'exhausted' ? route.error : undefined
  // The tier as one word beside the bar, and the model's thinking only when it isn't that same word:
  // "High → gpt-6.1-sol · High" said the same thing twice on one 32 px row.
  const tier = tierWord(route.policy ?? pool)
  const thinking = thinkingLabel(target.effort)
  const showThinking = thinking !== tier
  return (
    <div className={`route-line ${open ? 'is-open' : ''} route-line--${route.state}`}>
      <button type="button" className="route-line__row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="route-line__jev">Jev</span>
        {reading ? <span className="route-line__role">{roleName(reading.role)}</span> : <span className="route-line__role">{state}</span>}
        {reading && <DemandBar value={route.rawDemand} />}
        {reading && <span className="route-line__pool">{tier}</span>}
        {route.effective === 'free' && <span className="route-line__state">{L('grátis', 'free')}</span>}
        <span className="route-line__arrow" aria-hidden="true">→</span>
        <span className="route-line__model">
          {route.state === 'kept' ? `${modelLabel(target.model)} · ${L('mantido', 'kept')}` : route.state === 'exhausted' ? L('nenhum modelo elegível', 'no eligible model') : modelLabel(target.model)}
          {showThinking && <span className="route-line__thinking"> · {thinking}</span>}
        </span>
        {state && route.state !== 'kept' && <span className="route-line__state">{state}</span>}
        <span className="route-line__chev" aria-hidden="true">
          <Icon name="chevron" size={12} />
        </span>
      </button>
      {why && !open && <p className="route-line__why">{why}</p>}
      {open && (
        <div className="route-line__detail">
          {reading && (
            <div className="route-line__group">
              <span className="route-line__label">{L('Julgamento', 'Judgment')}</span>
              {/* The three criteria, each with its own bar, and the one weight they add up to. */}
              <Scores reading={reading} combined={route.rawDemand} />
              <ul>
                <li>
                  {L('Papel', 'Role')}: <strong>{roleName(reading.role)}</strong>
                  {reading.confidence !== undefined && <span className="muted"> · {Math.round(reading.confidence * 100)}%</span>}
                </li>
                {roleBars(reading.probabilities, 4)
                  .filter((r) => r.role !== reading.role)
                  .slice(0, 2)
                  .map((r) => (
                    <li key={r.role} className="muted small">
                      {roleName(r.role)} · {Math.round(r.p * 100)}%
                    </li>
                  ))}
                {route.demand !== undefined && Math.abs(route.demand - route.rawDemand) > 0.05 && (
                  <li>
                    {L('Exigência em vigor', 'Demand in force')}: {route.demand.toFixed(2)}/3
                  </li>
                )}
                {reading.ms > 0 && <li className="muted small">{reading.ms} ms</li>}
              </ul>
            </div>
          )}
          <div className="route-line__group">
            <span className="route-line__label">{L('Rota', 'Route')}</span>
            <ul>
              <li>{L('Tier julgado', 'Judged tier')}: {poolName(pool)}</li>
              {route.policy !== pool && <li>{L('Tier aplicado', 'Tier in force')}: {poolName(route.policy)}</li>}
              {route.effective && route.effective !== pool && (
                <li>
                  {L('De onde veio o modelo', 'Where the model came from')}: {poolName(route.effective)}
                </li>
              )}
              {route.source === 'role' && <li>{L('Veio da corrente do papel', 'Came from the role’s own chain')}</li>}
              <li>
                {L('Modelo', 'Model')}: {targetLabel(target)}
              </li>
              <li>
                {L('Sem rotas, este agente roda em', 'Without routing, this agent runs on')}: {targetLabel(route.baseline)}
              </li>
              {(route.notes ?? []).map((n) => (
                <li key={n} className="muted small">
                  {n}
                </li>
              ))}
              {why && <li className="route-line__warn">{why}</li>}
            </ul>
          </div>
          {route.attempts && route.attempts.length > 1 && (
            <div className="route-line__group">
              <span className="route-line__label">{L('Tentativas', 'Attempts')}</span>
              <ol className="route-line__attempts">
                {route.attempts.map((a, i) => (
                  <li key={`${i}-${a.engine}-${a.model}`}>
                    {targetLabel(a)}{' '}
                    {a.skip ? (
                      <span className="muted">· {a.skip}</span>
                    ) : route.selected && a.engine === route.selected.engine && a.model === route.selected.model && a.effort === route.selected.effort ? (
                      <strong>· {L('escolhido', 'chosen')}</strong>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The read as one weight, for the thin line: complexity and capability, with the scale tipped by
// whether the work needs deep reasoning — the same sum the core turns into a tier, so the bar and the
// tier name beside it never disagree. The three bars behind it are in the opened line.
function DemandBar({ value }: { value: number }): ReactNode {
  const v = Number.isFinite(value) ? Math.min(3, Math.max(0, value)) : 0
  const share = Math.max(5, Math.round((v / 3) * 100))
  const said = L(`Exigência ${v.toFixed(1)} de 3`, `Demand ${v.toFixed(1)} of 3`)
  return (
    <span className="route-demand" role="meter" aria-valuemin={0} aria-valuemax={3} aria-valuenow={v} aria-label={said} title={said}>
      <span className="route-demand__fill" style={{ width: `${share}%` }} />
    </span>
  )
}

// What Jev read, criterion by criterion, and the weight they add up to: shown only when the line is
// opened, where there is room for the bars, the numbers and the words.
function Scores({ reading, combined }: { reading: NonNullable<RouteTrace['reading']>; combined: number }): ReactNode {
  const rows = [
    { key: 'complexity', label: L('Complexidade', 'Complexity'), value: reading.complexity / 3, text: `${reading.complexity.toFixed(1)}/3` },
    { key: 'capability', label: L('Capacidade', 'Capability'), value: reading.capability / 3, text: `${reading.capability.toFixed(1)}/3` },
    { key: 'reasoning', label: L('Raciocínio', 'Reasoning'), value: reading.deepReasoning, text: `${Math.round(reading.deepReasoning * 100)}%` },
    { key: 'demand', label: L('Exigência', 'Demand'), value: combined / 3, text: `${combined.toFixed(1)}/3`, sum: true }
  ]
  return (
    <div className="route-scores">
      {rows.map((r) => (
        <div key={r.key} className={`route-scores__row ${r.sum ? 'route-scores__row--sum' : ''}`}>
          <span className="route-scores__label">{r.label}</span>
          <span className="route-scores__track">
            <span className="route-scores__fill" style={{ width: `${Math.max(4, Math.round(Math.min(1, Math.max(0, r.value)) * 100))}%` }} />
          </span>
          <span className="route-scores__value">{r.text}</span>
        </div>
      ))}
    </div>
  )
}
