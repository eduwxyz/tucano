import { L, locale, type Lang } from '../../../shared/lang'
import { useEffect, useState, type ReactNode } from 'react'
import {
  agentById,
  navigate,
  newAgentDraft,
  openDm,
  refreshEngines,
  saveAgent,
  settleDraft,
  setGrant,
  slug,
  patchAgent,
  computerAction,
  computerOf,
  folderAction,
  lendFolder,
  openExternal,
  stopService,
  addConnector,
  authorizeConnector,
  reconnectConnector,
  removeConnector,
  updateTool,
  updateSettings,
  wslDistributions,
  setJevKey,
  browserAction,
  setTelegramToken,
  unpairTelegram,
  setGithubToken,
  exportTeam,
  importTeam,
  backupNow,
  openBackups,
  type TelegramInfo,
  useStore,
  EFFORTS,
  ENGINES,
  RUN_BUDGET_PCT,
  RUN_STALL_MINUTES,
  archiveAgent,
  setTab,
  saveSkill,
  skillApplies,
  modelInfo,
  type Agent,
  type AgentColor,
  type Connector,
  type ConnectorAuth,
  type EngineId,
  type GrantLevel,
  type MemoryMode,
  type Skill,
  type ToolClass,
  type WslDistribution,
  isTeam,
  reachable
} from '../store'
import { HarnessList, HarnessMcps, ModelPicker, onGateway, OutsideGateway } from './Harness'
import { ApprovalCard } from './Conversation'
import { AgentAvatar, Icon, NumberInput, SleepingToucan, time, tokens, UsageBar } from './ui'
import { UpdateSettings } from './Update'

export function Page({ title, subtitle, actions, children }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <section className="page">
      <header className="topbar">
        <div className="topbar__title">
          <h1>{title}</h1>
        </div>
        <div className="topbar__actions">{actions}</div>
      </header>
      <div className="page__scroll">
        <div className="page__inner">
          {subtitle && <p className="page__subtitle">{subtitle}</p>}
          {children}
        </div>
      </div>
    </section>
  )
}

// The cleaner page: a big title and one line, no bar on top (a strip still drags the window).
// `fill` gives the content the rest of the height instead of scrolling the page.
export function Sheet({
  title,
  lede,
  actions,
  back,
  fill,
  wide,
  children
}: {
  title: ReactNode
  lede?: ReactNode
  actions?: ReactNode
  back?: { label: string; onClick: () => void } // a page inside the page: the way out, above the title
  fill?: boolean
  wide?: boolean
  children: ReactNode
}): ReactNode {
  const head = (
    <header className="sheet__head">
      <div>
        {back && (
          <button className="text-btn sheet__back" onClick={back.onClick}>
            ← {back.label}
          </button>
        )}
        <h1>{title}</h1>
        {lede && <p className="sheet__lede">{lede}</p>}
      </div>
      {actions && <div className="sheet__actions">{actions}</div>}
    </header>
  )
  return (
    <section className={`page sheet ${fill ? 'sheet--fill' : ''}`}>
      <div className="sheet__drag" />
      {fill ? (
        <>
          {head}
          {children}
        </>
      ) : (
        <div className="page__scroll">
          <div className={`sheet__inner ${wide ? 'is-wide' : ''}`}>
            {head}
            {children}
          </div>
        </div>
      )}
    </section>
  )
}

// ---------- Agent profile / creation ----------

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']
const MEMORY_MODES = (): { value: MemoryMode; label: string; hint: string }[] => [
  { value: 'auto', label: L('Grava sozinho', 'Saves on its own'), hint: L('Guarda e avisa na mensagem, com Desfazer.', 'Keeps it and says so in the message, with Undo.') },
  { value: 'approve', label: L('Pede aprovação', 'Asks for approval'), hint: L('Cada memória nova espera você guardar.', 'Each new memory waits for you to keep it.') },
  { value: 'read', label: L('Só lê', 'Read only'), hint: L('Usa as memórias, mas não guarda novas.', 'Uses memories but doesn’t keep new ones.') }
]
const LEVELS = (): { value: GrantLevel; label: string }[] => [
  { value: 'none', label: L('Sem acesso', 'No access') },
  { value: 'read', label: L('Ler', 'Read') },
  { value: 'read_write', label: L('Ler e escrever', 'Read and write') }
]

export function AgentPage({ id, draft: proposed, fromMessage }: { id?: string; draft?: Agent; fromMessage?: string }): ReactNode {
  const existing = useStore((s) => (id ? agentById(s, id) : undefined))
  const engines = useStore((s) => s.settings.engines)
  const connectors = useStore((s) => s.connectors)
  const channels = useStore((s) => s.conversations.filter((c) => c.kind === 'channel'))
  const handles = useStore((s) => s.agents.map((a) => [a.id, a.handle] as const))
  const notes = useStore((s) => (id ? s.memories.filter((m) => m.scope === id && m.state === 'active').length : 0))

  const [draft, setDraft] = useState<Agent>(() => existing ?? proposed ?? newAgentDraft())
  const [chosen, setChosen] = useState<string[]>(() => (id ? channels.filter((c) => c.members.includes(id)).map((c) => c.id) : []))
  const [saved, setSaved] = useState(false)
  const [grantSaved, setGrantSaved] = useState<string | null>(null)
  const [memorySaved, setMemorySaved] = useState(false)

  useEffect(() => {
    if (existing) {
      setDraft(existing)
      setChosen(channels.filter((c) => c.members.includes(existing.id)).map((c) => c.id))
    }
    // Only reset when switching agents, not on every store change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const isNew = !existing
  const handleError = !/^[a-z0-9][a-z0-9_-]{1,31}$/.test(draft.handle)
    ? L('Use 2 a 32 letras minúsculas, números, - ou _.', 'Use 2 to 32 lowercase letters, numbers, - or _.')
    : handles.some(([aid, h]) => h === draft.handle && aid !== draft.id)
      ? L(`@${draft.handle} já existe.`, `@${draft.handle} already exists.`)
      : null
  const canSave = draft.name.trim().length > 0 && !handleError && !!modelInfo(draft.modelId)?.id
  const [handleTyped, setHandleTyped] = useState(false)
  const patch = (p: Partial<Agent>): void => {
    setDraft((d) => ({ ...d, ...p }))
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    await saveAgent(draft, chosen)
    if (isNew && fromMessage) settleDraft(fromMessage, draft.id) // the Tuca's card shows it was created
    if (isNew) navigate({ kind: 'agent', id: draft.id })
    else setSaved(true)
  }

  const model = modelInfo(draft.modelId)
  const engine: EngineId = model?.engine ?? 'claude'
  const engineStatus = engines[engine]

  // A new agent shows everything at once; an existing one, a tab at a time.
  const tab = useTab('agent', AGENT_TABS())
  const pane = (t: string): boolean => isNew || tab === t
  const archived = !!existing?.archived

  return (
    <Page
      title={
        <span className="row row--center">
          <AgentAvatar agent={{ name: draft.name || '?', color: draft.color }} size={26} />
          {isNew ? L('Novo agente', 'New agent') : draft.name}
        </span>
      }
      actions={
        <>
          {!isNew && !archived && (
            <button className="btn btn--ghost" onClick={() => void openDm(draft.id)}>
              {L('Abrir DM', 'Open DM')}
            </button>
          )}
          {!isNew && !archived && (
            <button
              className="btn btn--ghost"
              title={L('Tira da barra lateral e para de responder; dá pra reativar', 'Takes it out of the sidebar and it stops replying; you can bring it back')}
              onClick={() => {
                if (confirm(L(`Arquivar ${draft.name}?\n\nSai da barra lateral e para de responder; as rotinas dele desligam. O histórico e os recibos ficam, e dá pra reativar em "Arquivados", no fim da lista de agentes.`, `Archive ${draft.name}?\n\nIt leaves the sidebar and stops replying; its routines turn off. History and receipts stay, and you can bring it back from "Archived", at the end of the agent list.`))) void archiveAgent(draft.id, true)
              }}
            >
              {L('Arquivar', 'Archive')}
            </button>
          )}
          {saved && <span className="saved">{L('Salvo', 'Saved')}</span>}
          <button className="btn btn--primary" disabled={!canSave} onClick={() => void save()}>
            {isNew ? L('Criar agente', 'Create agent') : L('Salvar', 'Save')}
          </button>
        </>
      }
    >
      {archived && (
        <div className="archived-banner">
          <Icon name="layers" size={15} />
          <span className="grow">
            <strong>{L(`${draft.name} está arquivado.`, `${draft.name} is archived.`)}</strong> {L('Não responde, não roda rotinas e não aparece pro router.', 'It doesn’t reply, doesn’t run routines and the router doesn’t see it.')}
          </span>
          <button className="btn btn--sm btn--primary" onClick={() => void archiveAgent(draft.id, false)}>
            {L('Reativar', 'Bring back')}
          </button>
        </div>
      )}
      {!isNew && <Tabs page="agent" tabs={AGENT_TABS()} />}
      <div className="agent-layout">
        <div className="agent-form">
          {pane('perfil') && (
            <Card title={L('Identidade', 'Identity')} lead={L('Como você chama e reconhece o agente no chat.', 'How you call and recognize the agent in chat.')}>
              <div className="grid2">
                <Field label={L('Nome', 'Name')}>
                  {/* A new agent's @handle follows the name until you type one yourself. */}
                  <input value={draft.name} placeholder={L('Ex.: Lia', 'E.g. Lia')} onChange={(e) => patch({ name: e.target.value, ...(isNew && !handleTyped ? { handle: slug(e.target.value) } : {}) })} />
                </Field>
                <Field label="@handle" error={draft.handle ? handleError : null}>
                  <input
                    value={draft.handle}
                    placeholder={L('Ex.: lia', 'E.g. lia')}
                    onChange={(e) => (setHandleTyped(true), patch({ handle: e.target.value.toLowerCase().replace(/\s/g, '') }))}
                  />
                </Field>
              </div>
              <Field label={L('Papel', 'Role')} hint={L('Uma linha. O router usa isso pra decidir quem responde.', 'One line. The router uses it to decide who replies.')}>
                <input value={draft.role} placeholder={L('Ex.: Engenharia', 'E.g. Engineering')} onChange={(e) => patch({ role: e.target.value })} />
              </Field>
              <Field label={L('Cor', 'Color')}>
                <div className="swatches">
                  {COLORS.map((c) => (
                    <button
                      key={c}
                      className={`swatch c-${c} ${draft.color === c ? 'is-active' : ''}`}
                      onClick={() => patch({ color: c })}
                      aria-label={c}
                    />
                  ))}
                </div>
              </Field>
            </Card>
          )}

          {pane('perfil') && (
            <Card title={L('Instruções', 'Instructions')} lead={L('Escreva como escreveria pra um colega novo: o que fazer, o que evitar, quando perguntar.', 'Write it as you would for a new colleague: what to do, what to avoid, when to ask.')}>
              <textarea
                rows={6}
                value={draft.instructions}
                placeholder={L('Ex.: Responde dúvidas no #suporte com base na documentação. Quando não souber, chama alguém.', 'E.g. Answers questions in #support based on the docs. When unsure, calls someone.')}
                onChange={(e) => patch({ instructions: e.target.value })}
              />
              <p className="hint">{L('O contexto do workspace já entra em toda conversa. Aqui vai só o que é deste agente.', 'The workspace context already goes into every conversation. Here goes only what’s specific to this agent.')}</p>
            </Card>
          )}

          {pane('canais') && (
            <Card title={L('Onde participa', 'Where it takes part')}>
              <div className="checks">
                {channels.map((c) => (
                  <label key={c.id} className="check">
                    <input
                      type="checkbox"
                      checked={chosen.includes(c.id)}
                      onChange={(e) => {
                        setChosen(e.target.checked ? [...chosen, c.id] : chosen.filter((x) => x !== c.id))
                        setSaved(false)
                      }}
                    />
                    <Icon name="hash" size={14} /> {c.name}
                  </label>
                ))}
              </div>
              <p className="hint">{L(`Fora desses canais, chame com @${draft.handle || 'handle'} ou mande DM.`, `Outside these channels, call it with @${draft.handle || 'handle'} or send a DM.`)}</p>
            </Card>
          )}

          {!isNew && pane('canais') && <AgentSkills agentId={draft.id} name={draft.name} />}

          {pane('ferramentas') && (
            <Card
              title={L('Ferramentas e acesso', 'Tools and access')}
              lead={`${L('Um nível por conector. O que fica de fora nem aparece pro modelo.', 'One level per connector. What’s left out doesn’t even reach the model.')}${isNew ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
            >
              {connectors.length === 0 && (
                <p className="muted small">
                  {L('Nenhum conector ainda.', 'No connectors yet.')}{' '}
                  <button className="link" onClick={() => navigate({ kind: 'connectors' })}>
                    {L('Adicionar em Conectores', 'Add in Connectors')}
                  </button>
                </p>
              )}
              <div className="grants">
                {connectors.map((c) => {
                  const level = draft.grants[c.id] ?? 'none'
                  const sensitive = c.tools.filter((t) => t.cls === 'sensitive' && t.enabled && !draft.autoApprove?.includes(`${c.id}:${t.name}`))
                  return (
                    <div key={c.id} className="grant">
                      <div className="grant__name">
                        <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} />
                        <div>
                          <strong>
                            {c.name} {grantSaved === c.id && <span className="saved">{L('Salvo', 'Saved')}</span>}
                          </strong>
                          <span className="muted small">
                            {c.status === 'needs_auth' ? (
                              <>
                                {L('Precisa autorizar', 'Needs authorization')} ·{' '}
                                <button className="link" onClick={() => authorizeConnector(c.id)}>
                                  {L('Autorizar no navegador', 'Authorize in the browser')}
                                </button>
                              </>
                            ) : level === 'none'
                              ? L('Nenhuma ferramenta exposta', 'No tools exposed')
                              : level === 'read'
                                ? L(`${c.tools.filter((t) => t.cls === 'read' && t.enabled).length} ferramentas de leitura`, `${c.tools.filter((t) => t.cls === 'read' && t.enabled).length} read tools`)
                                : L(
                                    `${c.tools.filter((t) => t.enabled).length} ferramentas${sensitive.length ? ` · ${sensitive.length} ${sensitive.length === 1 ? 'pede' : 'pedem'} aprovação` : ''}`,
                                    `${c.tools.filter((t) => t.enabled).length} tools${sensitive.length ? ` · ${sensitive.length} ${sensitive.length === 1 ? 'asks' : 'ask'} for approval` : ''}`
                                  )}
                          </span>
                        </div>
                      </div>
                      <div className="segmented">
                        {LEVELS().map((l) => (
                          <button
                            key={l.value}
                            className={level === l.value ? 'is-active' : ''}
                            onClick={() => {
                              // Access changes take effect right away for existing agents; no Save needed.
                              if (isNew) return patch({ grants: { ...draft.grants, [c.id]: l.value } })
                              setDraft((d) => ({ ...d, grants: { ...d.grants, [c.id]: l.value } }))
                              setGrant(draft.id, c.id, l.value)
                              setGrantSaved(c.id)
                            }}
                          >
                            {l.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="hint">
                <Icon name="shield" size={13} /> {L('Ferramentas sensíveis (merge, deploy, apagar, enviar) viram pedido de aprovação no chat, a não ser as que você marcou como "sempre permitir".', 'Sensitive tools (merge, deploy, delete, send) become an approval request in the chat, except the ones you marked as "always allow".')}
              </p>
              {!isNew && (draft.autoApprove?.length ?? 0) > 0 && (
                <div className="always">
                  <span className="small muted">{L('Sempre permitido, sem pedir:', 'Always allowed, without asking:')}</span>
                  {draft.autoApprove!.map((rule) => {
                    const [cid, tool] = rule.split(':')
                    return (
                      <span key={rule} className="chip is-on always__rule">
                        {connectors.find((c) => c.id === cid)?.name ?? L('conector', 'connector')} · {tool}
                        <button
                          className="always__x"
                          title={L('Voltar a pedir aprovação', 'Ask for approval again')}
                          onClick={() => {
                            const autoApprove = draft.autoApprove!.filter((r) => r !== rule)
                            setDraft((d) => ({ ...d, autoApprove }))
                            patchAgent(draft.id, { autoApprove })
                          }}
                        >
                          <Icon name="x" size={11} />
                        </button>
                      </span>
                    )
                  })}
                </div>
              )}
            </Card>
          )}

          {pane('ferramentas') && (
            <Card title="Web" lead={`${L('Pesquisa e lê páginas com a ferramenta do próprio Claude Code ou Codex, na sua assinatura. Cada busca aparece nos passos da resposta.', 'Searches and reads pages with Claude Code’s or Codex’s own tool, on your subscription. Every search shows up in the reply’s steps.')}${isNew ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}>
              <div className="segmented segmented--wide" role="radiogroup" aria-label="Web">
                {[false, true].map((v) => (
                  <button
                    key={String(v)}
                    role="radio"
                    aria-checked={(draft.web !== false) === v}
                    className={(draft.web !== false) === v ? 'is-active' : ''}
                    onClick={() => (isNew ? patch({ web: v }) : (setDraft((d) => ({ ...d, web: v })), patchAgent(draft.id, { web: v })))}
                  >
                    {v ? L('Ligada', 'On') : L('Desligada', 'Off')}
                  </button>
                ))}
              </div>
            </Card>
          )}

          {pane('ferramentas') && (
            <Card
              title={L('Navegador', 'Browser')}
              lead={`${L('Um Chrome só dele: abre páginas, clica, preenche e lê como uma pessoa, com logins separados dos seus (você entra pelo Assumir). Clique que compra, publica, envia ou apaga pede sua aprovação.', 'A Chrome of its own: opens pages, clicks, fills in and reads like a person, with logins separate from yours (you sign in via Take over). A click that buys, publishes, sends or deletes asks for your approval.')}${isNew ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
            >
              <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Navegador', 'Browser')}>
                {[false, true].map((v) => (
                  <button
                    key={String(v)}
                    role="radio"
                    aria-checked={!!draft.browser === v}
                    className={!!draft.browser === v ? 'is-active' : ''}
                    onClick={() => (isNew ? patch({ browser: v }) : (setDraft((d) => ({ ...d, browser: v })), patchAgent(draft.id, { browser: v })))}
                  >
                    {v ? L('Ligado', 'On') : L('Desligado', 'Off')}
                  </button>
                ))}
              </div>
              {!isNew && draft.browser && (
                <div className="row computer__actions">
                  <button className="btn btn--sm btn--ghost" title={L('Abre a janela do navegador dele pra você entrar nas contas', 'Opens its browser window so you can sign in to accounts')} onClick={() => browserAction(draft.id, 'show')}>
                    {L('Abrir o navegador dele', 'Open its browser')}
                  </button>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => confirm(L(`Apagar os logins, cookies e histórico do navegador de ${draft.name}?`, `Delete the logins, cookies and history of ${draft.name}'s browser?`)) && browserAction(draft.id, 'clear')}
                  >
                    {L('Apagar logins', 'Delete logins')}
                  </button>
                </div>
              )}
            </Card>
          )}

          {!isNew && pane('ferramentas') && (
            <ComputerCard
              agentId={draft.id}
              kind={draft.computer ? (draft.computerKind ?? 'linux') : 'none'}
              onChange={(k) => {
                const patch = { computer: k !== 'none', computerKind: k === 'none' ? (draft.computerKind ?? 'linux') : k }
                setDraft((d) => ({ ...d, ...patch }))
                patchAgent(draft.id, patch)
              }}
            />
          )}

          {pane('memoria') && (
            <Card
              title={L('Memória', 'Memory')}
              lead={`${L('Memórias sobre você valem pra todos os agentes; as notas de trabalho são só dele.', 'Memories about you apply to every agent; work notes are its own.')}${isNew ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
            >
              <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Memória', 'Memory')}>
                {MEMORY_MODES().map((m) => (
                  <button
                    key={m.value}
                    role="radio"
                    aria-checked={draft.memory === m.value}
                    className={draft.memory === m.value ? 'is-active' : ''}
                    onClick={() => {
                      if (isNew) return patch({ memory: m.value })
                      setDraft((d) => ({ ...d, memory: m.value }))
                      patchAgent(draft.id, { memory: m.value })
                      setMemorySaved(true)
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <p className="hint">
                {MEMORY_MODES().find((m) => m.value === draft.memory)?.hint} {memorySaved && <span className="saved">{L('Salvo', 'Saved')}</span>}
              </p>
              {!isNew && (
                <p className="muted small">
                  {notes ? L(`${notes} nota${notes === 1 ? '' : 's'} de trabalho.`, `${notes} work note${notes === 1 ? '' : 's'}.`) : L('Nenhuma nota de trabalho ainda.', 'No work notes yet.')}{' '}
                  <button className="link" onClick={() => navigate({ kind: 'memory' })}>
                    {L('Ver em Memória', 'See in Memory')}
                  </button>
                </p>
              )}
            </Card>
          )}

          {pane('perfil') && (
            <Card title={L('Harness e modelo', 'Harness and model')} lead={L('O agente roda num dos harnesses que você usa, como você o configurou: no seu plano, no gateway da empresa ou no seu provedor.', 'The agent runs on one of the harnesses you use, the way you set it up: on your plan, your company’s gateway or your provider.')}>
              <ModelPicker value={draft.modelId} onChange={(modelId) => patch({ modelId })} />
              {!engineStatus.loggedIn && (
                <p className="hint hint--warn">
                  <Icon name="lock" size={13} />{' '}
                  {L(
                    `O ${ENGINES[engine].label} ${engineStatus.off ? 'está desligado nos harnesses' : engineStatus.soon ? 'ainda não roda agentes' : 'não está pronto'}: ${draft.name || 'o agente'} não responde até você trocar o modelo ou resolver.`,
                    `${ENGINES[engine].label} ${engineStatus.off ? 'is off in the harnesses' : engineStatus.soon ? 'doesn’t run agents yet' : 'isn’t ready'}: ${draft.name || 'the agent'} won’t reply until you change the model or fix it.`
                  )}{' '}
                  <button className="link" onClick={() => navigate({ kind: 'settings' })}>
                    {L('Configurações', 'Settings')}
                  </button>
                </p>
              )}
              <div className="grid2">
                <Field label={L('Esforço de raciocínio', 'Reasoning effort')} hint={L('Mais esforço pensa mais e gasta mais do plano.', 'More effort thinks longer and uses more of your plan.')}>
                  <select value={draft.effort} onChange={(e) => patch({ effort: e.target.value as Agent['effort'] })}>
                    {EFFORTS.map((ef) => (
                      <option key={ef.id} value={ef.id}>
                        {ef.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={L('Limite mensal (milhões de tokens)', 'Monthly limit (millions of tokens)')} hint={L(`Conferido antes de cada turno. No limite, ${draft.name || 'o agente'} para e avisa.`, `Checked before every turn. At the limit, ${draft.name || 'the agent'} stops and tells you.`)}>
                  <NumberInput
                    min={0}
                    step={0.5}
                    value={draft.limit / 1_000_000}
                    onChange={(n) => patch({ limit: Math.max(0, Math.round(n * 1_000_000)) })}
                    className="input--short"
                  />
                </Field>
              </div>
            </Card>
          )}
        </div>

        <aside className="agent-side">
          <div className="profile-card">
            <AgentAvatar agent={{ name: draft.name || '?', color: draft.color }} size={72} />
            <strong className="profile-card__name">{draft.name || L('Sem nome', 'No name')}</strong>
            <span className="muted">@{draft.handle || 'handle'}</span>
            {draft.role && <span className="tag">{draft.role}</span>}
            <div className="profile-card__rows">
              <div>
                <span className="muted small">{L('Motor', 'Engine')}</span>
                <span>{ENGINES[engine].label}</span>
              </div>
              <div>
                <span className="muted small">{L('Modelo', 'Model')}</span>
                <span>{model?.label}</span>
              </div>
              <div>
                <span className="muted small">{L('Canais', 'Channels')}</span>
                <span>{chosen.length || '—'}</span>
              </div>
              <div>
                <span className="muted small">{L('Conectores', 'Connectors')}</span>
                <span>{Object.values(draft.grants).filter((g) => g !== 'none').length || '—'}</span>
              </div>
            </div>
            {!isNew && (
              <div className="profile-card__budget">
                <span className="muted small">{L('Uso em', 'Usage in')} {new Date().toLocaleDateString(locale(), { month: 'long' })}</span>
                <span>
                  <strong>{tokens(draft.used)}</strong> <span className="muted">{L(`de ${tokens(draft.limit)} tokens`, `of ${tokens(draft.limit)} tokens`)}</span>
                </span>
                <UsageBar used={draft.used} limit={draft.limit} />
              </div>
            )}
          </div>
        </aside>
      </div>
    </Page>
  )
}

const COMPUTER_STATE = (): Record<string, { label: string; tone: string }> => ({
  off: { label: L('desligado', 'off'), tone: '' },
  stopped: { label: L('parado', 'stopped'), tone: 'tag--warn' },
  starting: { label: L('ligando', 'starting'), tone: 'tag--warn' },
  running: { label: L('ligado', 'running'), tone: 'tag--ok' },
  no_docker: { label: L('sem Docker', 'no Docker'), tone: 'tag--danger' },
  error: { label: L('com problema', 'having trouble'), tone: 'tag--danger' }
})

type ComputerChoice = 'none' | 'linux' | 'mac'
const COMPUTER_CHOICES = (): { value: ComputerChoice; label: string }[] => [
  { value: 'none', label: L('Nenhum', 'None') },
  { value: 'linux', label: L('Linux isolado', 'Isolated Linux') },
  { value: 'mac', label: L('Este computador', 'This computer') }
]

function ComputerCard({ agentId, kind, onChange }: { agentId: string; kind: ComputerChoice; onChange: (k: ComputerChoice) => void }): ReactNode {
  const info = useStore((s) => computerOf(s, agentId))
  const [confirmErase, setConfirmErase] = useState(false)
  const [confirmMac, setConfirmMac] = useState(false)
  useEffect(() => computerAction(agentId, 'refresh'), [agentId])
  const on = kind === 'linux'
  const state = on ? (info && info.state !== 'off' ? info.state : 'stopped') : 'off'
  const st = COMPUTER_STATE()[state]!

  return (
    <Card
      title={L('Computador', 'Computer')}
      lead={L(
        'Onde ele roda comandos, instala, cria e testa. O Linux é uma máquina só dele, isolada do seu computador e sem credenciais. Neste computador, ele usa o que você já tem instalado, mas alcança tudo o que você alcança.',
        'Where it runs commands, installs, builds and tests. Linux is a machine of its own, isolated from your computer and with no credentials. On this computer, it uses what you already have installed, but reaches everything you can.'
      )}
    >
      <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Computador', 'Computer')}>
        {COMPUTER_CHOICES().map((c) => (
          <button
            key={c.value}
            role="radio"
            aria-checked={kind === c.value}
            className={kind === c.value ? 'is-active' : ''}
            onClick={() => {
              if (kind === c.value) return
              if (c.value === 'mac') return setConfirmMac(true)
              setConfirmMac(false)
              onChange(c.value)
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      {confirmMac && kind !== 'mac' && (
        <div className="mac-confirm">
          <p>
            <strong>{L('Os comandos dele vão rodar direto no seu computador, como você.', 'Its commands will run right on your computer, as you.')}</strong>{' '}
            {L(
              'Ele passa a alcançar seus arquivos, seus outros projetos, as credenciais que estiverem no disco (tokens, ~/.ssh) e as contas em que o terminal está logado. Uma página da web ou um arquivo com instruções escondidas pode tentar usar isso.',
              'It can reach your files, your other projects, credentials on disk (tokens, ~/.ssh) and the accounts the terminal is signed in to. A web page or a file with hidden instructions may try to use that.'
            )}
          </p>
          <p className="muted small">
            {L(
              'Continua valendo: cada comando aparece no chat, as travas de loop e de teto seguem, e as chaves do app (GitHub, Telegram, conectores) não vão junto. Os comandos começam na pasta dele. Dá pra voltar pro Linux ou desligar quando quiser.',
              'Still true: every command shows up in the chat, the loop and ceiling guards still apply, and the app’s keys (GitHub, Telegram, connectors) don’t come along. Commands start in its folder. You can go back to Linux or turn it off any time.'
            )}
          </p>
          <div className="row">
            <button className="btn btn--sm btn--danger" onClick={() => (setConfirmMac(false), onChange('mac'))}>
              {L('Liberar o computador pra ele', 'Give it this computer')}
            </button>
            <button className="btn btn--sm btn--ghost" onClick={() => setConfirmMac(false)}>
              {L('Cancelar', 'Cancel')}
            </button>
          </div>
        </div>
      )}
      {kind === 'mac' && (
        <>
          <div className="computer">
            <span className="tag tag--warn">{L('no seu computador', 'on your computer')}</span>
            <span className="muted small grow">{L('Os comandos começam na pasta dele.', 'Commands start in its folder.')}</span>
          </div>
          <Services agentId={agentId} />
          <div className="row computer__actions">
            <button className="btn btn--sm btn--ghost" onClick={() => computerAction(agentId, 'open_folder')}>
              {L('Abrir pasta dele', 'Open its folder')}
            </button>
            <button className="btn btn--sm btn--ghost" disabled={!info?.services.some((x) => x.running)} onClick={() => computerAction(agentId, 'restart')}>
              {L('Parar serviços', 'Stop services')}
            </button>
          </div>
        </>
      )}
      {on && (
        <>
          <div className="computer">
            <span className={`tag ${st.tone}`}>{st.label}</span>
            <span className="muted small grow">{info?.detail ?? (state === 'running' ? L('Pronto. Pasta de trabalho: /work', 'Ready. Work folder: /work') : state === 'stopped' ? L('Liga sozinho quando ele precisar.', 'Starts on its own when it needs to.') : '')}</span>
            {state === 'stopped' && (
              <button className="btn btn--sm" onClick={() => computerAction(agentId, 'start')}>
                {L('Ligar agora', 'Start now')}
              </button>
            )}
            {state === 'no_docker' && (
              <button className="btn btn--sm" onClick={() => computerAction(agentId, 'refresh')}>
                {L('Verificar de novo', 'Check again')}
              </button>
            )}
          </div>
          <Services agentId={agentId} />
          <LentFolders agentId={agentId} />
          <div className="row computer__actions">
            <button className="btn btn--sm btn--ghost" onClick={() => computerAction(agentId, 'open_folder')}>
              {L('Abrir pasta', 'Open folder')}
            </button>
            <button className="btn btn--sm btn--ghost" disabled={state !== 'running'} onClick={() => computerAction(agentId, 'restart')}>
              {L('Reiniciar', 'Restart')}
            </button>
            {confirmErase ? (
              <>
                <button className="btn btn--sm btn--danger" onClick={() => (computerAction(agentId, 'erase'), setConfirmErase(false))}>
                  {L('Apagar tudo, inclusive /work', 'Erase everything, including /work')}
                </button>
                <button className="btn btn--sm btn--ghost" onClick={() => setConfirmErase(false)}>
                  {L('Cancelar', 'Cancel')}
                </button>
              </>
            ) : (
              <button className="btn btn--sm btn--ghost" onClick={() => setConfirmErase(true)}>
                {L('Apagar computador', 'Erase computer')}
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  )
}

// What the agent left running (servers, dashboards), on its computer or on the Mac.
function Services({ agentId }: { agentId: string }): ReactNode {
  const info = useStore((s) => computerOf(s, agentId))
  return (
    <>
      {info && info.services.length > 0 && (
        <div className="table computer__services">
          {info.services.map((svc) => (
            <div key={svc.name} className="table__row">
              <Icon name="globe" size={14} />
              <span className="grow">
                <strong>{svc.name}</strong> <span className="muted small">{L('porta', 'port')} {svc.port} · {svc.running ? L('no ar', 'live') : L('parado', 'stopped')}</span>
              </span>
              {svc.running && svc.url && (
                <>
                  <button className="btn btn--sm btn--ghost" onClick={() => openExternal(reachable(svc.url!))}>
                    {L('Abrir', 'Open')}
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => stopService(agentId, svc.name)}>
                    {L('Parar', 'Stop')}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

// Folders of the Mac this agent's computer sees at /projetos/<name>.
function LentFolders({ agentId }: { agentId: string }): ReactNode {
  const folders = useStore((s) => agentById(s, agentId)?.folders ?? [])
  const [error, setError] = useState<string | null>(null)
  const home = useStore((s) => s.computers.find((c) => c.agentId === agentId)?.folder.match(/^\/(?:Users|home)\/[^/]+/)?.[0])
  const short = (p: string): string => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)
  return (
    <div className="folders">
      <div className="row row--between">
        <strong className="small">{L('Pastas do seu computador', 'Folders from your computer')}</strong>
        <button className="btn btn--sm" onClick={() => void lendFolder(agentId).then(setError)}>
          {L('Emprestar pasta…', 'Lend a folder…')}
        </button>
      </div>
      {folders.length === 0 ? (
        <p className="muted small">{L('Empreste a pasta de um projeto pra ele trabalhar nela. Ele mexe nos arquivos de verdade, então use git pra poder desfazer.', 'Lend it a project folder to work in. It changes the real files, so use git to be able to undo.')}</p>
      ) : (
        <>
          <div className="table">
            {folders.map((f) => (
              <div key={f.name} className="table__row folder">
                <Icon name="folder" size={14} />
                <span className="grow folder__body">
                  <code>/projetos/{f.name}</code>
                  <span className="muted small">{short(f.path)}</span>
                </span>
                <div className="segmented" role="radiogroup" aria-label={L(`Acesso a ${f.name}`, `Access to ${f.name}`)}>
                  {(['read_write', 'read_only'] as const).map((a) => (
                    <button key={a} role="radio" aria-checked={f.readOnly === (a === 'read_only')} className={f.readOnly === (a === 'read_only') ? 'is-active' : ''} onClick={() => f.readOnly !== (a === 'read_only') && folderAction(agentId, f.name, a)}>
                      {a === 'read_only' ? L('Só ler', 'Read only') : L('Pode mudar', 'Can change')}
                    </button>
                  ))}
                </div>
                <button className="btn btn--sm btn--ghost" onClick={() => folderAction(agentId, f.name, 'return')}>
                  {L('Devolver', 'Give back')}
                </button>
              </div>
            ))}
          </div>
          <p className="hint">{L('Emprestar ou devolver reinicia o computador: os serviços param, o que ele instalou fica. Sem credenciais lá dentro, push e deploy ficam com você.', 'Lending or giving back restarts the computer: services stop, what it installed stays. With no credentials inside, push and deploy stay with you.')}</p>
        </>
      )}
      {error && <p className="field__error">{error}</p>}
    </div>
  )
}

export function Card({ title, lead, action, children }: { title: string; lead?: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <div className="card">
      <div className="card__head">
        <div className="row row--between">
          <h2>{title}</h2>
          {action}
        </div>
        {lead && <p className="muted">{lead}</p>}
      </div>
      {children}
    </div>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: ReactNode }): ReactNode {
  return (
    <label className={`field ${error ? 'has-error' : ''}`}>
      <span className="field__label">{label}</span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}

// ---------- Approvals ----------

export function ApprovalsPage(): ReactNode {
  const approvals = useStore((s) => s.approvals)
  const pending = approvals.filter((a) => a.state === 'pending')
  const past = approvals.filter((a) => a.state !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
  const conversations = useStore((s) => s.conversations)

  return (
    <Page title={L('Aprovações', 'Approvals')} subtitle={L('Nada sensível acontece sem você. Cada aprovação cobre uma ação exata.', 'Nothing sensitive happens without you. Each approval covers one exact action.')}>
      {pending.length === 0 ? (
        <div className="empty empty--rest">
          <SleepingToucan />
          <p>{L('Nada esperando por você.', 'Nothing waiting for you.')}</p>
          <p className="muted">{L('Quando um agente quiser mergear, fazer deploy, apagar ou enviar algo pra fora, o pedido aparece aqui e na conversa.', 'When an agent wants to merge, deploy, delete or send something out, the request shows up here and in the conversation.')}</p>
        </div>
      ) : (
        <div className="stack-list">
          {pending.map((a) => {
            const conv = conversations.find((c) => c.id === a.conversationId)
            return (
              <div key={a.id}>
                <div className="row row--between small muted list-meta">
                  <span>
                    {L('em', 'in')} {conv?.kind === 'channel' ? `#${conv.name}` : 'DM'} · {time(a.createdAt)}
                  </span>
                  <button className="link" onClick={() => navigate({ kind: 'conversation', id: a.conversationId })}>
                    {L('Ver na conversa', 'See in the conversation')}
                  </button>
                </div>
                <ApprovalCard approval={a} />
              </div>
            )
          })}
        </div>
      )}

      {past.length > 0 && (
        <>
          <h3 className="section-title">{L('Histórico', 'History')}</h3>
          <div className="table">
            {past.map((a) => (
              <HistoryRow key={a.id} id={a.id} />
            ))}
          </div>
        </>
      )}
    </Page>
  )
}

function HistoryRow({ id }: { id: string }): ReactNode {
  const a = useStore((s) => s.approvals.find((x) => x.id === id)!)
  const agent = useStore((s) => agentById(s, a.agentId))
  return (
    <div className="table__row">
      {agent && <AgentAvatar agent={agent} size={22} />}
      <span className="grow">
        {a.tool.replace(/_/g, ' ')} <span className="muted">· {a.connectorName}</span>
      </span>
      {a.outcome && <span className="muted small">{a.outcome}</span>}
      <span className={`tag ${a.state === 'approved' ? 'tag--ok' : 'tag--danger'}`}>{a.state === 'approved' ? L('aprovado', 'approved') : a.state === 'refused' ? L('recusado', 'refused') : L('expirado', 'expired')}</span>
      <span className="muted small">{a.decidedAt ? time(a.decidedAt) : ''}</span>
    </div>
  )
}

// ---------- Connectors ----------

const CLASS_LABEL = (): Record<ToolClass, string> => ({ read: L('leitura', 'read'), write: L('escrita', 'write'), sensitive: L('sensível', 'sensitive') })

const STATUS = (): Record<Connector['status'], { label: string; tone: string }> => ({
  connected: { label: L('conectado', 'connected'), tone: 'tag--ok' },
  connecting: { label: L('conectando…', 'connecting…'), tone: '' },
  needs_auth: { label: L('precisa autorizar', 'needs authorization'), tone: 'tag--warn' },
  error: { label: L('com problema', 'having trouble'), tone: 'tag--danger' },
  disconnected: { label: L('desconectado', 'disconnected'), tone: 'tag--warn' }
})

const address = (c: Connector): string => (c.kind === 'remote' ? (c.url ?? '') : [c.command, ...(c.args ?? [])].join(' '))

export function ConnectorsPage(): ReactNode {
  const connectors = useStore((s) => s.connectors)
  const agents = useStore((s) => s.agents)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  return (
    <Page
      title={L('Conectores', 'Connectors')}
      subtitle={L('Servidores MCP conectados uma vez, pelo app. Os agentes nunca falam com eles direto: cada chamada passa pelas permissões e aprovações.', 'MCP servers connected once, by the app. Agents never talk to them directly: every call goes through permissions and approvals.')}
      actions={
        !adding && (
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> {L('Adicionar conector', 'Add connector')}
          </button>
        )
      }
    >
      {adding && (
        <AddConnector
          onDone={(id) => {
            setAdding(false)
            if (id) setOpenId(id)
          }}
        />
      )}
      <HarnessMcps onAdded={setOpenId} />
      {connectors.length === 0 && !adding && (
        <div className="empty empty--card">
          <Icon name="plug" size={22} />
          <p>{L('Nenhum conector ainda.', 'No connectors yet.')}</p>
          <p className="muted">{L('Adicione um servidor MCP remoto (GitHub, Linear, Sentry…) ou um local, que roda como processo no seu computador.', 'Add a remote MCP server (GitHub, Linear, Sentry…) or a local one, which runs as a process on your computer.')}</p>
        </div>
      )}
      <div className="stack-list">
        {connectors.map((c) => {
          const users = agents.filter((a) => (a.grants[c.id] ?? 'none') !== 'none')
          const open = openId === c.id
          const fresh = c.tools.filter((t) => t.isNew).length
          return (
            <div key={c.id} className={`card connector ${open ? 'is-open' : ''}`}>
              <button className="connector__head" onClick={() => setOpenId(open ? null : c.id)}>
                <span className="connector__icon">
                  <Icon name={c.kind === 'stdio' ? 'terminal' : 'globe'} />
                </span>
                <span className="grow">
                  <strong>{c.name}</strong>
                  <span className="muted small mono truncate">{address(c)}</span>
                </span>
                {fresh > 0 && <span className="tag tag--warn">{L(`${fresh} nova${fresh === 1 ? '' : 's'}`, `${fresh} new`)}</span>}
                <span className={`tag ${STATUS()[c.status].tone}`}>{STATUS()[c.status].label}</span>
                <span className="stack">
                  {users.map((a) => (
                    <span key={a.id} className="stack__item">
                      <AgentAvatar agent={a} size={20} />
                    </span>
                  ))}
                </span>
                <span className={`chev ${open ? 'is-open' : ''}`}>
                  <Icon name="chevron" size={14} />
                </span>
              </button>
              {open && (
                <div className="tools">
                  {c.kind === 'stdio' && (
                    <p className="warn-box">
                      <Icon name="terminal" size={14} /> {L('Conector local: roda um processo no seu computador com o seu usuário.', 'Local connector: runs a process on your computer as your user.')}
                    </p>
                  )}
                  {c.error && <p className="note note--error">{c.error}</p>}
                  <div className="row connector__actions">
                    {c.status === 'needs_auth' && (
                      <button className="btn btn--primary btn--sm" onClick={() => authorizeConnector(c.id)}>
                        {L('Autorizar no navegador', 'Authorize in the browser')}
                      </button>
                    )}
                    {c.status !== 'connecting' && (
                      <button className="btn btn--sm" onClick={() => reconnectConnector(c.id)}>
                        {c.status === 'connected' ? L('Atualizar ferramentas', 'Refresh tools') : L('Conectar de novo', 'Reconnect')}
                      </button>
                    )}
                    <span className="grow" />
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => {
                        if (confirm(L(`Remover ${c.name}? Os agentes perdem acesso às ferramentas dele.`, `Remove ${c.name}? The agents lose access to its tools.`))) removeConnector(c.id)
                      }}
                    >
                      {L('Remover', 'Remove')}
                    </button>
                  </div>
                  {c.tools.length > 0 && (
                    <div className="tools__head small muted">
                      <span>{L('Ferramenta', 'Tool')}</span>
                      <span>{L('Classe', 'Class')}</span>
                      <span>{L('Alto risco', 'High risk')}</span>
                      <span>{L('Ligada', 'On')}</span>
                    </div>
                  )}
                  {c.tools.map((t) => (
                    <div key={t.name} className={`tools__row ${t.enabled ? '' : 'is-off'}`} title={t.description}>
                      <code>
                        {t.name}
                        {t.isNew && <span className="tag tag--warn tools__new">{L('nova', 'new')}</span>}
                      </code>
                      <select value={t.cls} onChange={(e) => updateTool(c.id, t.name, { cls: e.target.value as ToolClass })}>
                        {(Object.keys(CLASS_LABEL()) as ToolClass[]).map((k) => (
                          <option key={k} value={k}>
                            {CLASS_LABEL()[k]}
                          </option>
                        ))}
                      </select>
                      <input
                        type="checkbox"
                        disabled={t.cls !== 'sensitive'}
                        checked={t.highRisk && t.cls === 'sensitive'}
                        onChange={(e) => updateTool(c.id, t.name, { highRisk: e.target.checked })}
                      />
                      <Toggle on={t.enabled} onChange={(v) => updateTool(c.id, t.name, { enabled: v })} />
                    </div>
                  ))}
                  <p className="hint">{L('Ferramentas novas que o servidor publicar depois entram desligadas até você revisar. Sensíveis sempre pedem aprovação.', 'New tools the server publishes later come in off until you review them. Sensitive ones always ask for approval.')}</p>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </Page>
  )
}

// "a b 'c d'" -> ["a", "b", "c d"]
const splitArgs = (line: string): string[] => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!)

function AddConnector({ onDone }: { onDone: (id?: string) => void }): ReactNode {
  const demo = useStore((s) => s.demoServer)
  const [kind, setKind] = useState<'remote' | 'stdio'>('remote')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [auth, setAuth] = useState<ConnectorAuth>('oauth')
  const [token, setToken] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [env, setEnv] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const envMap = Object.fromEntries(
        env
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
      )
      const id = await addConnector(
        kind === 'remote' ? { kind, name, url, auth, token: auth === 'token' ? token : undefined } : { kind, name, command, args: splitArgs(args), env: envMap }
      )
      onDone(id)
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error: /, '') : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={L('Novo conector', 'New connector')} lead={L('Credenciais ficam cifradas no cofre do sistema e nunca aparecem de novo.', 'Credentials are encrypted in the system vault and never shown again.')}>
      <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Tipo', 'Type')}>
        <button role="radio" aria-checked={kind === 'remote'} className={kind === 'remote' ? 'is-active' : ''} onClick={() => setKind('remote')}>
          {L('Remoto (URL)', 'Remote (URL)')}
        </button>
        <button role="radio" aria-checked={kind === 'stdio'} className={kind === 'stdio' ? 'is-active' : ''} onClick={() => setKind('stdio')}>
          {L('Local (comando)', 'Local (command)')}
        </button>
      </div>
      <Field label={L('Nome', 'Name')}>
        <input value={name} placeholder={kind === 'remote' ? L('Ex.: Linear', 'E.g. Linear') : L('Ex.: Postgres', 'E.g. Postgres')} onChange={(e) => setName(e.target.value)} />
      </Field>
      {kind === 'remote' ? (
        <>
          <Field label={L('URL do servidor MCP', 'MCP server URL')}>
            <input value={url} placeholder="https://mcp.linear.app/mcp" onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field label={L('Autenticação', 'Authentication')}>
            <select value={auth} onChange={(e) => setAuth(e.target.value as ConnectorAuth)}>
              <option value="oauth">{L('OAuth (abre o navegador pra autorizar)', 'OAuth (opens the browser to authorize)')}</option>
              <option value="token">{L('Token (cabeçalho Authorization: Bearer)', 'Token (Authorization: Bearer header)')}</option>
              <option value="none">{L('Nenhuma', 'None')}</option>
            </select>
          </Field>
          {auth === 'token' && (
            <Field label="Token">
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} />
            </Field>
          )}
        </>
      ) : (
        <>
          <p className="warn-box">
            <Icon name="terminal" size={14} /> {L('Vai rodar um processo no seu computador, com o seu usuário. Só adicione comandos em que você confia.', 'It will run a process on your computer, as your user. Only add commands you trust.')}
          </p>
          <div className="grid2">
            <Field label={L('Comando', 'Command')}>
              <input value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <Field label={L('Argumentos', 'Arguments')}>
              <input value={args} placeholder="-y @modelcontextprotocol/server-postgres postgres://…" onChange={(e) => setArgs(e.target.value)} />
            </Field>
          </div>
          <Field label={L('Variáveis de ambiente', 'Environment variables')} hint={L('Uma por linha, NOME=valor. Os valores ficam cifrados.', 'One per line, NAME=value. Values are encrypted.')}>
            <textarea rows={2} value={env} onChange={(e) => setEnv(e.target.value)} />
          </Field>
          {demo && (
            <button
              className="link small"
              onClick={() => {
                setName(L('Tarefas (demo)', 'Tasks (demo)'))
                setCommand(demo.command)
                setArgs(demo.args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' '))
              }}
            >
              {L('Preencher com o servidor de demonstração (lista de tarefas local)', 'Fill in with the demo server (a local task list)')}
            </button>
          )}
        </>
      )}
      {error && <p className="note note--error">{error}</p>}
      <div className="row connector__actions">
        <span className="grow" />
        <button className="btn btn--ghost" onClick={() => onDone()}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary" disabled={busy || !name.trim()} onClick={() => void submit()}>
          {busy ? L('Conectando…', 'Connecting…') : L('Conectar', 'Connect')}
        </button>
      </div>
    </Card>
  )
}

// The skills this agent follows: a box per active skill. Changes save right away.
function AgentSkills({ agentId, name }: { agentId: string; name: string }): ReactNode {
  const skills = useStore((s) => s.skills.filter((k) => k.state === 'active'))
  const everyone = useStore((s) => s.agents.filter(isTeam).map((a) => a.id))
  const toggle = (k: Skill, on: boolean): void => {
    let agents = on ? (k.agents.length === 0 ? [] : [...k.agents, agentId]) : (k.agents.length === 0 ? everyone : k.agents).filter((x) => x !== agentId)
    if (on && agents.length >= everyone.length && everyone.every((id) => agents.includes(id))) agents = [] // everyone again
    void saveSkill({ id: k.id, name: k.name, description: k.description, body: k.body, agents, source: k.source })
  }
  return (
    <Card title="Skills" lead={L(`As receitas que ${name || 'o agente'} segue. Ele vê o nome e quando usar de cada uma, e lê a receita quando a tarefa bate.`, `The recipes ${name || 'the agent'} follows. It sees each one's name and when to use it, and reads the recipe when the task matches.`)}>
      {skills.length === 0 ? (
        <p className="muted small">
          {L('Nenhuma skill ainda.', 'No skills yet.')}{' '}
          <button className="link" onClick={() => navigate({ kind: 'skills' })}>
            {L('Criar ou trazer do Claude Code', 'Create one or bring it from Claude Code')}
          </button>
        </p>
      ) : (
        <div className="checks checks--skills">
          {skills.map((k) => {
            const on = skillApplies(k, agentId)
            const only = on && k.agents.length === 1
            return (
              <label key={k.id} className="check check--skill" title={only ? L(`Só ${name || 'este agente'} usa: pra ninguém usar, arquive em Skills`, `Only ${name || 'this agent'} uses it: to have no one use it, archive it in Skills`) : undefined}>
                <input type="checkbox" checked={on} disabled={only} onChange={(e) => toggle(k, e.target.checked)} />
                <span>
                  <strong>{k.name}</strong>
                  {k.source && <span className="tag">{L('do seu', 'from your')} {k.source.includes('/.codex/') ? 'Codex' : 'Claude Code'}</span>}
                  <span className="muted small">{k.agents.length === 0 ? L('todos os agentes', 'all agents') : `${k.agents.length} ${k.agents.length === 1 ? L('agente', 'agent') : L('agentes', 'agents')}`}</span>
                  <span className="small skill__desc">{k.description}</span>
                </span>
              </label>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// ---------- tabs ----------

type TabList = readonly (readonly [string, string])[]
const SETTINGS_TABS = (): TabList => [
  ['geral', L('Geral', 'General')],
  ['modelos', L('Modelos', 'Models')],
  ['agentes', L('Agentes', 'Agents')],
  ['integracoes', L('Celular e GitHub', 'Phone and GitHub')]
]
const AGENT_TABS = (): TabList => [
  ['perfil', L('Perfil', 'Profile')],
  ['canais', L('Canais e skills', 'Channels and skills')],
  ['ferramentas', L('Ferramentas', 'Tools')],
  ['memoria', L('Memória', 'Memory')]
]

// The page's open tab, kept while the app is open; the first one when the kept one isn't there.
function useTab(page: string, tabs: TabList): string {
  const kept = useStore((s) => s.tabs[page])
  return tabs.some(([id]) => id === kept) ? kept! : tabs[0]![0]
}

function Tabs({ page, tabs }: { page: string; tabs: TabList }): ReactNode {
  const active = useTab(page, tabs)
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([id, label]) => (
        <button key={id} role="tab" aria-selected={active === id} className={active === id ? 'is-active' : ''} onClick={() => setTab(page, id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

// A model to run with, from what each harness in use offers, or another by name.
export function ModelSelect(p: { value: string; onChange: (v: string) => void; jev?: boolean; engines?: EngineId[] }): ReactNode {
  return <ModelPicker {...p} />
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }): ReactNode {
  return <button className={`toggle ${on ? 'is-on' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)} />
}

// ---------- Settings ----------

// Português or English: the app's, and the language agents answer in. Labeled in both, so anyone finds it.
export function LanguagePicker({ className = '' }: { className?: string }): ReactNode {
  const language = useStore((s) => s.settings.language)
  return (
    <div className={`segmented lang-picker ${className}`} role="radiogroup" aria-label="Idioma · Language">
      {(['pt', 'en'] as const satisfies readonly Lang[]).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={language === l} className={language === l ? 'is-active' : ''} onClick={() => language !== l && updateSettings({ language: l })}>
          {l === 'pt' ? 'Português' : 'English'}
        </button>
      ))}
    </div>
  )
}

// Issue to PR (spec §22): the token the app pushes agent/* branches and opens PRs with.
function GithubCard({ info }: { info?: { user?: string; error?: string } }): ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = (value: string | null): void => {
    setBusy(true)
    setError('')
    setGithubToken(value)
      .then(() => setToken(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Card
      title={L('GitHub (push e PR)', 'GitHub (push and PR)')}
      lead={L(
        'Pros agentes publicarem o que fazem nas pastas que você emprestou: o git do computador deles passa pelo app, que põe o token fora do computador e só aceita push em branches agent/*. Abrir PR é um pedido de aprovação.',
        'So agents can publish what they do in the folders you lent: their computer’s git goes through the app, which keeps the token outside the computer and only accepts pushes to agent/* branches. Opening a PR is an approval request.'
      )}
    >
      {info?.user ? (
        <div className="row row--center">
          <span className="tag tag--ok">{L('Conectado', 'Connected')}</span>
          <span className="small grow">
            {L('como', 'as')} <strong>{info.user}</strong>
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            {L('Remover token', 'Remove token')}
          </button>
        </div>
      ) : (
        <>
          <p className="small">
            {L('Crie um token fine-grained em github.com → Settings → Developer settings →', 'Create a fine-grained token at github.com → Settings → Developer settings →')} <strong>Fine-grained tokens</strong>
            {L(', só com os repositórios dessas pastas e as permissões', ', with only these folders’ repositories and the permissions')} <strong>Contents: read and write</strong> {L('e', 'and')} <strong>Pull requests: read and write</strong>.
          </p>
          <div className="row">
            <input className="grow" type="password" value={token} placeholder="github_pat_…" onChange={(e) => setToken(e.target.value)} />
            <button className="btn" disabled={busy || !token.trim()} onClick={() => save(token)}>
              {busy ? L('Conferindo…', 'Checking…') : L('Salvar', 'Save')}
            </button>
          </div>
        </>
      )}
      {(error || info?.error) && <p className="note note--error">{error || info?.error}</p>}
      <p className="hint">
        <Icon name="shield" size={13} /> {L('O token fica no cofre do sistema e nunca entra no computador dos agentes. main e as outras branches são recusadas no caminho.', 'The token stays in the system’s vault and never enters the agents’ computer. main and the other branches are refused on the way.')}
      </p>
    </Card>
  )
}

// The team as a file, and backups of everything.
function TeamCard(): ReactNode {
  const [note, setNote] = useState('')
  const download = (): void => {
    void exportTeam().then((md) => {
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = `${L('time-tucano', 'tucano-team')}-${new Date().toISOString().slice(0, 10)}.md`
      a.click()
      URL.revokeObjectURL(a.href)
    })
  }
  const upload = (file?: File): void => {
    if (!file) return
    void file
      .text()
      .then(importTeam)
      .then(setNote, (e: unknown) => setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }
  return (
    <Card title={L('Time e backup', 'Team and backup')} lead={L('O time num arquivo .md (agentes, skills, canais e rotinas, sem credenciais nem conversas), pra guardar ou levar pra outro computador. E uma cópia de tudo uma vez por dia (as últimas 7).', 'The team in a .md file (agents, skills, channels and routines, without credentials or conversations), to keep or take to another computer. And a copy of everything once a day (the last 7).')}>
      <div className="row">
        <button className="btn btn--sm" onClick={download}>
          {L('Exportar time', 'Export team')}
        </button>
        <label className="btn btn--sm">
          {L('Importar time…', 'Import team…')}
          <input type="file" accept=".md,text/markdown" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </label>
        <span className="grow" />
        <button className="btn btn--sm" onClick={() => void backupNow().then((f) => setNote(L(`Backup feito: ${f.split('/').pop()}`, `Backup done: ${f.split('/').pop()}`)))}>
          {L('Fazer backup agora', 'Back up now')}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={openBackups}>
          {L('Abrir pasta', 'Open folder')}
        </button>
      </div>
      {note && <p className="small muted">{note}</p>}
    </Card>
  )
}

// The phone (spec §19): a Telegram bot of the user's own, paired with a code.
function PhoneCard({ info }: { info?: TelegramInfo }): ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = (value: string | null): void => {
    setBusy(true)
    setError('')
    setTelegramToken(value)
      .then(() => setToken(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <Card title={L('Celular (Telegram)', 'Phone (Telegram)')} lead={L('Aprovações com botões, as perguntas dos agentes (é só responder a mensagem) e o fim das rotinas, no seu Telegram. Útil pra rotina que pede aprovação de madrugada.', 'Approvals with buttons, the agents’ questions (just reply to the message) and routine results, in your Telegram. Handy for a routine that asks for approval in the middle of the night.')}>
      {!info?.bot ? (
        <>
          <ol className="small steps-list">
            <li>
              {L('No Telegram, abra o', 'In Telegram, open')} <strong>@BotFather</strong>, {L('mande', 'send')} <code>/newbot</code> {L('e escolha um nome.', 'and pick a name.')}
            </li>
            <li>
              {L('Ele devolve um token (algo como', 'It gives you a token (something like')} <code>123456:ABC…</code>{L('). Cole aqui:', '). Paste it here:')}
            </li>
          </ol>
          <div className="row">
            <input className="grow" type="password" value={token} placeholder={L('Token do bot', 'Bot token')} onChange={(e) => setToken(e.target.value)} />
            <button className="btn" disabled={busy || !token.trim()} onClick={() => save(token)}>
              {busy ? L('Conferindo…', 'Checking…') : L('Salvar', 'Save')}
            </button>
          </div>
        </>
      ) : !info.chat ? (
        <div className="stack">
          <p className="small">
            {L('Agora abra o', 'Now open')} <strong>{info.bot}</strong> {L('no Telegram e mande:', 'in Telegram and send:')}
          </p>
          <p>
            <code className="phone-code">/start {info.code}</code>
          </p>
          <p className="muted small">{L('Só quem mandar este código fica com o bot. Esperando…', 'Only whoever sends this code gets the bot. Waiting…')}</p>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            {L('Trocar de bot', 'Change bot')}
          </button>
        </div>
      ) : (
        <div className="row row--center">
          <span className="tag tag--ok">{L('Pareado', 'Paired')}</span>
          <span className="small grow">
            {info.bot} {L('manda pra', 'sends to')} <strong>{info.chat}</strong>.
          </span>
          <button className="btn btn--sm btn--ghost" onClick={() => unpairTelegram()}>
            {L('Desparear', 'Unpair')}
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            {L('Remover bot', 'Remove bot')}
          </button>
        </div>
      )}
      {(error || info?.error) && <p className="note note--error">{error || L(`O Telegram não está respondendo: ${info?.error}`, `Telegram isn't responding: ${info?.error}`)}</p>}
      <p className="hint">
        <Icon name="shield" size={13} /> {L('O Telegram recebe o texto das aprovações e perguntas (ferramenta, argumentos, motivo). O token fica no cofre do sistema. Uma ação de alto risco pede dois toques.', 'Telegram receives the text of approvals and questions (tool, arguments, reason). The token stays in the system’s vault. A high-risk action takes two taps.')}
      </p>
    </Card>
  )
}

// The TypeSafe key for the Jev router: checked by the core, kept encrypted, never shown again.
export function JevKey({ saved, hint }: { saved: boolean; hint?: string }): ReactNode {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = (value: string | null): void => {
    setBusy(true)
    setError('')
    setJevKey(value)
      .then(() => setKey(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <>
      <p className="hint">
        <Icon name="shield" size={13} />{' '}
        {hint ?? L('Decide em menos de 1 segundo, mas cada decisão manda as últimas 10 mensagens do canal pra TypeSafe e é cobrada na sua conta de lá (centavos por mês). Se ele falhar, o Haiku decide.', 'Decides in under 1 second, but each decision sends the channel’s last 10 messages to TypeSafe and is billed to your account there (cents a month). If it fails, Haiku decides.')}
      </p>
      {saved ? (
        <div className="row">
          <span className="tag tag--ok">{L('Chave salva', 'Key saved')}</span>
          <span className="muted small grow">{L('Guardada no cofre do sistema.', 'Kept in the system’s vault.')}</span>
          <button className="btn btn--sm btn--ghost" disabled={busy} onClick={() => save(null)}>
            {L('Remover chave', 'Remove key')}
          </button>
        </div>
      ) : (
        <Field label={L('Chave do TypeSafe', 'TypeSafe key')} hint={L('Crie em console.typesafe.ai → API Keys. O app confere antes de guardar.', 'Create one at console.typesafe.ai → API Keys. The app checks it before saving.')}>
          <div className="row">
            <input className="grow" type="password" value={key} placeholder={L('Cole a chave aqui', 'Paste the key here')} onChange={(e) => setKey(e.target.value)} />
            <button className="btn" disabled={busy || !key.trim()} onClick={() => save(key)}>
              {busy ? L('Conferindo…', 'Checking…') : L('Salvar', 'Save')}
            </button>
          </div>
        </Field>
      )}
      {error && <p className="note note--error">{error}</p>}
    </>
  )
}

export function SettingsPage(): ReactNode {
  const settings = useStore((s) => s.settings)
  const packaged = useStore((s) => s.packaged)
  const platform = useStore((s) => s.platform)
  const [distros, setDistros] = useState<WslDistribution[]>([])
  const [wslError, setWslError] = useState('')
  const [checkingTarget, setCheckingTarget] = useState(false)
  const selectedDistro = settings.executionTarget?.kind === 'wsl' ? settings.executionTarget.distro : ''
  const wslIssue = settings.executionTarget?.kind === 'wsl' && Object.values(settings.engines).every((engine) => !engine.installed) ? Object.values(settings.engines).find((engine) => engine.warning)?.warning : undefined
  const changeExecutionTarget = (executionTarget: NonNullable<typeof settings.executionTarget>): void => {
    setCheckingTarget(true)
    void updateSettings({ executionTarget })
      .catch((error: unknown) => setWslError(error instanceof Error ? error.message : String(error)))
      .finally(() => setCheckingTarget(false))
  }
  useEffect(() => {
    if (platform !== 'windows') return
    let current = true
    void wslDistributions().then(
      (found) => current && setDistros(found),
      (error: unknown) => current && setWslError(error instanceof Error ? error.message : String(error))
    )
    return () => {
      current = false
    }
  }, [platform])
  // At work, Jev and Telegram stay: the person decides, told what leaves the gateway.
  const work = onGateway(settings)
  const tabs = SETTINGS_TABS()
  const tab = useTab('settings', tabs)
  const pane = (t: string): boolean => tab === t
  return (
    <Page title={L('Configurações', 'Settings')}>
      <Tabs page="settings" tabs={tabs} />
      <div className="agent-form">
        {pane('geral') && (
          <Card title="Workspace">
            <Field label={L('Nome', 'Name')}>
              <input value={settings.workspaceName} onChange={(e) => updateSettings({ workspaceName: e.target.value })} />
            </Field>
            <div className="field">
              <span className="field__label">Idioma · Language</span>
              <LanguagePicker />
              <span className="hint">{L('O idioma do app e o que os agentes usam pra responder.', 'The app’s language, and the one the agents reply in.')}</span>
            </div>
            <Field label={L('Contexto', 'Context')} hint={L('Entra em toda conversa de todo agente: quem você é, o que faz, o que importa agora e o que nunca fazer.', 'Goes into every conversation of every agent: who you are, what you do, what matters now and what never to do.')}>
              <textarea rows={5} value={settings.context} onChange={(e) => updateSettings({ context: e.target.value })} />
            </Field>
            <div className="row">
              <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { done: false } })}>
                {L('Rever a introdução', 'See the introduction again')}
              </button>
              {settings.onboarding?.checklistHidden && (
                <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { done: true } })}>
                  {L('Mostrar os primeiros passos', 'Show getting started')}
                </button>
              )}
            </div>
          </Card>
        )}

        {pane('geral') && platform === 'windows' && (
          <Card title={L('Onde os agentes rodam', 'Agent execution')} lead={L('Escolha onde todos os harnesses e os comandos do seu computador rodam. O app e seus dados continuam no Windows.', 'Choose where all harnesses and your-computer commands run. The app and its data stay on Windows.')}>
            <Field label={L('Ambiente', 'Environment')}>
              <select
                value={settings.executionTarget?.kind ?? 'windows'}
                onChange={(e) => {
                  if (e.target.value === 'windows') return changeExecutionTarget({ kind: 'windows' })
                  const current = selectedDistro || undefined
                  const distro = distros.find((d) => d.version === 2 && d.name === current) ?? distros.find((d) => d.version === 2 && d.isDefault) ?? distros.find((d) => d.version === 2)
                  if (distro) changeExecutionTarget({ kind: 'wsl', distro: distro.name })
                }}
              >
                <option value="windows">Windows</option>
                <option value="wsl" disabled={!distros.some((d) => d.version === 2) && settings.executionTarget?.kind !== 'wsl'}>WSL 2</option>
              </select>
            </Field>
            {settings.executionTarget?.kind === 'wsl' && (
              <Field label={L('Distribuição', 'Distribution')}>
                <select
                  value={distros.some((d) => d.version === 2 && d.name === selectedDistro) ? selectedDistro : ''}
                  onChange={(e) => e.target.value && changeExecutionTarget({ kind: 'wsl', distro: e.target.value })}
                >
                  <option value="">{L('Escolha uma distribuição WSL 2', 'Choose a WSL 2 distribution')}</option>
                  {distros.filter((d) => d.version === 2).map((d) => <option key={d.name} value={d.name}>{d.name}{d.isDefault ? L(' · padrão', ' · default') : ''}</option>)}
                </select>
              </Field>
            )}
            {wslError && <p className="hint">{wslError}</p>}
            {checkingTarget && <p className="hint">{L('Verificando os harnesses nessa distribuição…', 'Checking for harnesses in this distribution…')}</p>}
            {wslIssue && <p className="hint hint--warn">{wslIssue}</p>}
            {!wslError && !distros.some((d) => d.version === 2) && <p className="hint">{L('Não encontrei uma distribuição WSL 2. Instale ou atualize uma distribuição e abra o Tucano de novo.', 'No WSL 2 distribution was found. Install or upgrade a distribution, then reopen Tucano.')}</p>}
          </Card>
        )}

        {pane('geral') && (
          <Card title={L('Atualizações', 'Updates')}>
            <UpdateSettings />
          </Card>
        )}

        {pane('modelos') && (
          <Card
            title="Harnesses"
            lead={L(
              'Os programas em que os agentes rodam, cada um como você configurou: no seu plano, no gateway da empresa ou nos seus provedores. O Tucano nunca vê nem guarda as suas credenciais.',
              'The programs the agents run on, each one the way you set it up: on your plan, your company’s gateway or your providers. Tucano never sees or stores your credentials.'
            )}
            action={
              <button className="btn btn--ghost btn--sm" onClick={refreshEngines}>
                {L('Verificar de novo', 'Check again')}
              </button>
            }
          >
            <HarnessList />
          </Card>
        )}

        {pane('modelos') && (
          <Card title="Router" lead={L('Modelo pequeno que lê a conversa e decide quem responde. Não concede permissão nenhuma.', 'A small model that reads the conversation and decides who replies. It grants no permissions at all.')}>
            <Field label={L('Modelo do router', 'Router model')} hint={L('Prefira um modelo rápido: ele roda antes de cada resposta num canal.', 'Go for a fast model: it runs before every reply in a channel.')}>
              <ModelSelect value={settings.routerModel} onChange={(routerModel) => updateSettings({ routerModel })} jev />
            </Field>
            {settings.routerModel === 'jev' && <JevKey saved={!!settings.jevKey} />}
            {settings.routerModel === 'jev' && work && <OutsideGateway what={L('cada mensagem sem @menção vai pra TypeSafe escolher quem responde.', 'every message without an @mention goes to TypeSafe to pick who replies.')} />}
          </Card>
        )}

        {pane('agentes') && (
          <Card title={L('Navegador dos agentes', 'Agents’ browser')} lead={L('Como o app acha o que o agente pede pra clicar (“o botão Buscar”). Pelo texto é de graça e resolve a maioria; quando não acha, o agente usa o número do elemento.', 'How the app finds what the agent asks to click (“the Search button”). By text it’s free and handles most cases; when it can’t find it, the agent uses the element’s number.')}>
            <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Navegador dos agentes', 'Agents’ browser')}>
              {[false, true].map((v) => (
                <button key={String(v)} role="radio" aria-checked={!!settings.browserJev === v} className={!!settings.browserJev === v ? 'is-active' : ''} onClick={() => updateSettings({ browserJev: v })}>
                  {v ? 'Jev (TypeSafe)' : L('Só pelo texto da página', 'Only by the page’s text')}
                </button>
              ))}
            </div>
            {settings.browserJev && work && <OutsideGateway what={L('a lista de elementos das páginas, e às vezes o print delas, vai pra TypeSafe.', 'the pages’ element list, and sometimes their screenshot, goes to TypeSafe.')} />}
            {settings.browserJev && (
              <JevKey
                saved={!!settings.jevKey}
                hint={L(
                  'Acha o elemento em menos de 1 segundo, até sem texto (pelo print da tela). Mas cada clique que o texto não resolve manda pra TypeSafe a lista de elementos da página e, às vezes, o print dela, inclusive em áreas logadas.',
                  'Finds the element in under 1 second, even without text (from the screenshot). But every click text can’t resolve sends TypeSafe the page’s element list and sometimes its screenshot, including signed-in areas.'
                )}
              />
            )}
          </Card>
        )}

        {pane('integracoes') && work && <OutsideGateway what={L('as aprovações, as perguntas dos agentes e o fim das rotinas vão pro seu Telegram, com o texto de cada uma.', 'approvals, the agents’ questions and routine results go to your Telegram, with the text of each.')} />}
        {pane('integracoes') && <PhoneCard info={settings.telegram} />}

        {pane('modelos') && (
          <Card title={L('Memória', 'Memory')} lead={L('Um modelo pequeno resume o que sai da janela de cada conversa e, do mesmo trecho, tira o que vale lembrar sobre você.', 'A small model summarizes what leaves each conversation’s window and, from the same stretch, picks what’s worth remembering about you.')}>
            <div className="grid2">
              <Field label={L('Modelo da memória', 'Memory model')} hint={L('Roda a cada ~20 mensagens numa conversa longa.', 'Runs every ~20 messages in a long conversation.')}>
                <ModelSelect value={settings.memoryModel} onChange={(memoryModel) => updateSettings({ memoryModel })} />
              </Field>
              <Field label={L('O que ele aprende sobre você', 'What it learns about you')} hint={L('Só conta o que você disse, nunca o que um agente supôs.', 'Only what you said counts, never what an agent assumed.')}>
                <select value={settings.memoryLearning} onChange={(e) => updateSettings({ memoryLearning: e.target.value as typeof settings.memoryLearning })}>
                  <option value="approve">{L('Vira sugestão pra você aprovar', 'A suggestion for you to approve')}</option>
                  <option value="auto">{L('Grava sozinho', 'Saved on its own')}</option>
                  <option value="off">{L('Nada (só resume)', 'Nothing (just summarizes)')}</option>
                </select>
              </Field>
            </div>
          </Card>
        )}

        {pane('agentes') && (
          <Card title={L('Rotinas', 'Routines')} lead={L('As rotinas rodam enquanto o app está aberto, mesmo com a janela fechada.', 'Routines run while the app is open, even with the window closed.')}>
            <div className="key-row">
              <Icon name="clock" />
              <div className="grow">
                <strong>{L('Abrir ao ligar o computador', 'Open when the computer starts')}</strong>
                <p className="muted small">{packaged ? L('Assim nenhuma rotina depende de você lembrar de abrir o app.', 'So no routine depends on you remembering to open the app.') : L('Só no app instalado. Rodando com npm run dev, fica desligado.', 'Only in the installed app. Running with npm run dev, it stays off.')}</p>
              </div>
              <Toggle on={!!settings.openAtLogin && packaged} onChange={(v) => packaged && updateSettings({ openAtLogin: v })} />
            </div>
            <div className="key-row">
              <Icon name="moon" />
              <div className="grow">
                <strong>{L('Horário de silêncio', 'Quiet hours')}</strong>
                <p className="muted small">{L('Rotinas e gatilhos esperam e rodam quando ele acaba (como atrasados). O que você mandar continua sendo respondido.', 'Routines and triggers wait and run when it ends (as late ones). What you send still gets answered.')}</p>
                {settings.quietHours && (
                  <div className="row row--center quiet">
                    <span className="small">{L('das', 'from')}</span>
                    <input type="time" value={settings.quietHours.from} onChange={(e) => updateSettings({ quietHours: { ...settings.quietHours!, from: e.target.value } })} />
                    <span className="small">{L('às', 'to')}</span>
                    <input type="time" value={settings.quietHours.to} onChange={(e) => updateSettings({ quietHours: { ...settings.quietHours!, to: e.target.value } })} />
                  </div>
                )}
              </div>
              <Toggle on={!!settings.quietHours} onChange={(v) => updateSettings({ quietHours: v ? { from: '22:00', to: '07:00' } : null })} />
            </div>
          </Card>
        )}

        {pane('integracoes') && <GithubCard info={settings.github} />}

        {pane('geral') && <TeamCard />}

        {pane('agentes') && (
          <Card title={L('Limites', 'Limits')}>
            <div className="grid2">
              <Field label={L('Limite padrão por agente (milhões de tokens/mês)', 'Default limit per agent (millions of tokens/month)')}>
                <NumberInput
                  min={0}
                  step={0.5}
                  value={settings.defaultLimit / 1_000_000}
                  onChange={(n) => updateSettings({ defaultLimit: Math.max(0, Math.round(n * 1_000_000)) })}
                />
              </Field>
              <Field label={L('Teto por resposta (% do limite do mês)', 'Ceiling per reply (% of the monthly limit)')} hint={L('Chegou nele, o agente pausa e você decide se continua.', 'When it hits it, the agent pauses and you decide whether it continues.')}>
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.runBudgetPct ?? RUN_BUDGET_PCT}
                  onChange={(n) => updateSettings({ runBudgetPct: Math.min(100, Math.max(1, Math.round(n))) })}
                />
              </Field>
              <Field label={L('Travado depois de (minutos sem sinal)', 'Stalled after (minutes without a sign)')} hint={L('Sem texto nem ferramenta terminando. Trabalho longo que anda não é cortado.', 'No text and no tool finishing. Long work that’s moving isn’t cut off.')}>
                <NumberInput
                  min={5}
                  value={settings.runStallMinutes ?? RUN_STALL_MINUTES}
                  onChange={(n) => updateSettings({ runStallMinutes: Math.max(5, Math.round(n)) })}
                />
              </Field>
              <Field label={L('Expiração de aprovações', 'Approvals expire after')}>
                <select value={settings.approvalTtlHours} onChange={(e) => updateSettings({ approvalTtlHours: Number(e.target.value) })}>
                  <option value="1">{L('1 hora', '1 hour')}</option>
                  <option value="24">{L('24 horas', '24 hours')}</option>
                  <option value="168">{L('7 dias', '7 days')}</option>
                </select>
              </Field>
            </div>
          </Card>
        )}
      </div>
    </Page>
  )
}
