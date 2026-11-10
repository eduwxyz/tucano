import { L, locale, type Lang } from '../../../shared/lang'
import { hasMonthlyLimit } from '../../../shared/limits'
import { instructionLengthNote } from '../../../shared/instructions'
import { useEffect, useId, useState, type CSSProperties, type ReactNode } from 'react'
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
  setConnectorToken,
  removeConnector,
  updateTool,
  updateSettings,
  setJevKey,
  browserAction,
  setTelegramToken,
  unpairTelegram,
  exportTeam,
  importAgents,
  importTeam,
  backupNow,
  openBackups,
  type TelegramInfo,
  useStore,
  EFFORTS,
  ENGINES,
  MAX_AGENT_ROUTINES,
  MAX_CHAIN_DEPTH,
  chainDepthCap,
  RUN_BUDGET_PCT,
  routineCap,
  RUN_STALL_MINUTES,
  archiveAgent,
  setTab,
  saveSkill,
  skillApplies,
  modelInfo,
  MODELS,
  type Agent,
  type AgentColor,
  type Message,
  type Connector,
  type ConnectorAuth,
  type EngineId,
  type GrantLevel,
  type MemoryMode,
  type Skill,
  type ToolClass,
  isTeam,
  reachable,
  voiceDownload,
  voiceRemoveModel,
  type VoiceModelId,
  type VoiceSettings,
  amAdmin,
  amOwner,
  teamMode,
  windowless,
  exportBackup,
  restoreCheck,
  restoreApply,
  restoreCancel,
  restoreInfo,
  type BackupSummary
} from '../store'
import { ActivityPane, AdminOnly, PeoplePane } from './People'
import { voiceRefusal } from '../../../shared/voice'
import { ACTION_KINDS, actionHint, actionMode, AUTONOMY_LEVELS, autonomyHint, autonomyLabel, COMPUTADOR, kindLabel, modeLabel, shellActions, type ActionKind, type ActionMode, type ActionRules, type Autonomy, type Policy } from '../../../shared/actions'
import { useVoice, VOICE_CHOICES, VoiceSetup } from './VoiceSetup'
import { AccountPicker, AccountsCard, HarnessList, HarnessMcps, ModelPicker, onGateway, OutsideGateway, usableEngines } from './Harness'
import { AppsCard } from './Apps'
import { AgentModelsPanel } from './AgentModelsPanel'
import { ConnectorGrid, OwnAppSetup, ThirdPartyWarning } from './ConnectorStore'
import { entryOf } from '../../../shared/connector-catalog'
import { directReports, possibleBosses } from '../../../shared/org'
import { perCallTool } from '../../../shared/composio'
import { ApprovalCard, QuestionCard, questionDrafts, toolWords } from './Conversation'
import { ProposalCard } from './Tuca'
import { confirmDialog } from './Dialogs'
import { Modal } from './Modal'
import { AgentAvatar, AVATARS, Icon, NumberInput, SleepingToucan, time, tokens, UsageBar } from './ui'
import { Select } from './Select'
import { UpdateSettings } from './Update'
import type { NotifyState } from '../rpc'
import { hasServers, ServersCard } from './Servers'
import { HomePhoneCard } from './HomePhone'
import { useWorkspaceList } from './Workspaces'
import { workspaceLabel } from '../../../shared/workspaces'
import exportSkill from '../assets/tucano-export-skill.md?raw'

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

// A square of 128 px: enough for any place it shows.
async function pictureFrom(file: File): Promise<string> {
  const image = await createImageBitmap(file)
  const side = Math.min(image.width, image.height)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  canvas.getContext('2d')!.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128)
  image.close()
  return canvas.toDataURL('image/webp', 0.85)
}

const COLORS: AgentColor[] = ['sky', 'indigo', 'violet', 'rose', 'amber', 'green', 'teal', 'graphite']

// The eight colors and one of the person's own, here and in the onboarding.
export function ColorPicker({ agent, patch }: { agent: Pick<Agent, 'color' | 'customColor'>; patch: (p: Partial<Agent>) => void }): ReactNode {
  return (
    <div className="swatches">
      {COLORS.map((c) => (
        <button key={c} className={`swatch c-${c} ${!agent.customColor && agent.color === c ? 'is-active' : ''}`} onClick={() => patch({ color: c, customColor: undefined })} aria-label={c} />
      ))}
      <label className={`swatch swatch--custom ${agent.customColor ? 'is-active' : ''}`} style={agent.customColor ? ({ '--agent': agent.customColor } as CSSProperties) : undefined} title={L('Outra cor', 'Another color')}>
        <input type="color" aria-label={L('Outra cor', 'Another color')} value={agent.customColor ?? '#888888'} onChange={(e) => patch({ customColor: e.target.value })} />
      </label>
    </div>
  )
}

// How an agent looks, here and in the onboarding: the face, a drawn character or a picture
// of the person's own (scaled down here). One at a time.
export function LookPicker({ agent, patch }: { agent: Pick<Agent, 'name' | 'color' | 'customColor' | 'picture' | 'avatar'>; patch: (p: Partial<Agent>) => void }): ReactNode {
  const [error, setError] = useState('')
  const base = { name: agent.name || '?', color: agent.color, customColor: agent.customColor }
  return (
    <>
      <div className="looks">
        <button type="button" className={`look ${!agent.picture && !agent.avatar ? 'is-active' : ''}`} title={L('Rosto padrão', 'Default face')} onClick={() => patch({ avatar: undefined, picture: undefined })}>
          <AgentAvatar agent={base} size={30} />
        </button>
        {AVATARS.map((a) => (
          <button key={a.id} type="button" className={`look ${!agent.picture && agent.avatar?.id === a.id ? 'is-active' : ''}`} title={a.name} onClick={() => patch({ avatar: a, picture: undefined })}>
            <AgentAvatar agent={{ ...base, avatar: a }} size={30} />
          </button>
        ))}
      </div>
      <div className="row row--center">
        <label className="btn btn--sm">
          {L('Enviar imagem', 'Upload image')}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) pictureFrom(file).then((picture) => (setError(''), patch({ picture, avatar: undefined })), () => setError(L('Essa imagem não abriu. Tente outra, em PNG ou JPG.', "That image didn't open. Try another one, in PNG or JPG.")))
            }}
          />
        </label>
        {agent.picture && (
          <>
            <AgentAvatar agent={{ ...base, picture: agent.picture }} size={30} />
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => patch({ picture: undefined })}>
              {L('Tirar a imagem', 'Remove the image')}
            </button>
          </>
        )}
      </div>
      {error && <span className="field__error">{error}</span>}
    </>
  )
}
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
  const globalRules = useStore((s) => s.settings.actionRules)
  const globalAutonomy = useStore((s) => s.settings.autonomy)
  const globalGuard = useStore((s) => s.settings.outsideGuard)

  const [draft, setDraft] = useState<Agent>(() => existing ?? proposed ?? newAgentDraft())
  const [chosen, setChosen] = useState<string[]>(() => (id ? channels.filter((c) => c.members.includes(id)).map((c) => c.id) : []))
  const [saved, setSaved] = useState(false)
  const [grantSaved, setGrantSaved] = useState<string | null>(null)
  const [memorySaved, setMemorySaved] = useState(false)
  const [saveError, setSaveError] = useState('') // why the core refused it (a person's name, a taken @)

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
    setSaveError('')
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaveError('')
    try {
      await saveAgent(draft, chosen)
    } catch (e) {
      return setSaveError(e instanceof Error ? e.message : String(e))
    }
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
  // Agents are the admins': a member sees the page, changes nothing.
  const admin = useStore(amAdmin)

  return (
    <Page
      title={
        <span className="row row--center">
          <AgentAvatar agent={{ ...draft, name: draft.name || '?' }} size={26} />
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
          {admin && !isNew && !archived && (
            <button
              className="btn btn--ghost"
              title={L('Tira da barra lateral e para de responder; dá pra reativar', 'Takes it out of the sidebar and it stops replying; you can reactivate it')}
              onClick={() =>
                void confirmDialog({
                  title: L(`Arquivar ${draft.name}?`, `Archive ${draft.name}?`),
                  body: L('Sai da barra lateral e para de responder; as rotinas dele desligam. O histórico e os recibos ficam, e dá pra reativar em "Arquivados", no fim da lista de agentes.', 'It leaves the sidebar and stops replying; its routines turn off. History and receipts stay, and you can reactivate it from "Archived", at the end of the agent list.'),
                  confirm: L(`Arquivar ${draft.name}`, `Archive ${draft.name}`)
                }).then((ok) => {
                  if (ok) void archiveAgent(draft.id, true)
                })
              }
            >
              {L('Arquivar', 'Archive')}
            </button>
          )}
          {saved && <span className="saved">{L('Salvo', 'Saved')}</span>}
          {saveError && <span className="field__error" role="alert">{saveError}</span>}
          {admin && (
            <button className="btn btn--primary" disabled={!canSave} onClick={() => void save()}>
              {isNew ? L('Criar agente', 'Create agent') : L('Salvar', 'Save')}
            </button>
          )}
        </>
      }
    >
      {archived && (
        <div className="archived-banner">
          <Icon name="archive" size={15} />
          <span className="grow">
            <strong>{L(`${draft.name} está arquivado.`, `${draft.name} is archived.`)}</strong> {L('Não responde, não roda rotinas e não é escolhido pra responder nos canais.', 'It doesn’t reply, doesn’t run routines and isn’t picked to answer in channels.')}
          </span>
          {admin && (
            <button className="btn btn--sm btn--primary" onClick={() => void archiveAgent(draft.id, false)}>
              {L('Reativar', 'Reactivate')}
            </button>
          )}
        </div>
      )}
      {!isNew && <Tabs page="agent" tabs={AGENT_TABS()} />}
      {!admin && <div className="admin-only--lead"><AdminOnly>{L('Só um admin muda os agentes. Você pode conversar com eles e ver como estão configurados.', 'Only an admin changes the agents. You can chat with them and see how they’re set up.')}</AdminOnly></div>}
      <fieldset className="member-lock" disabled={!admin}>
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
              <Field label={L('Papel', 'Role')} hint={L('Uma linha. Ajuda a decidir quem responde nos canais.', 'One line. It helps decide who replies in channels.')}>
                <input value={draft.role} placeholder={L('Ex.: Engenharia', 'E.g. Engineering')} onChange={(e) => patch({ role: e.target.value })} />
              </Field>
              <Field label={L('Cor', 'Color')}>
                <ColorPicker agent={draft} patch={patch} />
              </Field>
              <div className="field">
                <span className="field__label">{L('Aparência', 'Look')}</span>
                <LookPicker agent={draft} patch={patch} />
              </div>
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
              {instructionLengthNote(draft.instructions.length) && <p className="hint hint--warn">{instructionLengthNote(draft.instructions.length)}</p>}
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

          {pane('canais') && draft.kind !== 'tuca' && <ReportsTo draft={draft} patch={patch} />}

          {!isNew && pane('canais') && <AgentSkills agentId={draft.id} name={draft.name} />}

          {pane('ferramentas') && (
            <Card
              title={L('Ferramentas e acesso', 'Tools and access')}
              lead={`${L('Um nível por conector. O que fica de fora nem aparece pro modelo.', 'One level per connector. What’s left out doesn’t even reach the model.')}${isNew || !admin ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
            >
              {connectors.length === 0 && (
                <p className="muted small">
                  {L('Nenhum conector ainda.', 'No connectors yet.')}{' '}
                  {admin && (
                    <button className="link" onClick={() => navigate({ kind: 'connectors' })}>
                      {L('Adicionar em Conectores', 'Add in Connectors')}
                    </button>
                  )}
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
                                {L('Precisa autorizar', 'Needs authorization')}
                                {admin && (
                                  <>
                                    {' · '}
                                    <button className="link" onClick={() => authorizeConnector(c.id)}>
                                      {L('Autorizar no navegador', 'Authorize in the browser')}
                                    </button>
                                  </>
                                )}
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
                <Icon name="shield" size={13} /> {L('Ferramentas sensíveis (publicar código, colocar no ar, apagar, enviar algo pra fora) viram pedido de aprovação no chat, a não ser as que você marcou como "sempre permitir".', 'Sensitive tools (publishing code, putting things live, deleting, sending something out) become an approval request in the chat, except the ones you marked as "always allow".')}
              </p>
              {!isNew && (draft.autoApprove?.length ?? 0) > 0 && (
                <div className="always">
                  <span className="small muted">{L('Sempre permitido, sem pedir:', 'Always allowed, without asking:')}</span>
                  {draft.autoApprove!.map((rule) => {
                    const [cid, tool] = rule.split(':')
                    return (
                      <span key={rule} className="chip is-on always__rule">
                        {connectors.find((c) => c.id === cid)?.name ?? L('conector', 'connector')} · {toolWords(tool ?? '')}
                        {admin && (
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
                        )}
                      </span>
                    )
                  })}
                </div>
              )}
            </Card>
          )}

          {pane('ferramentas') && (
            <Card
              title={L('Autonomia', 'Autonomy')}
              lead={`${L(
                `Até onde ${draft.name || 'o agente'} vai sozinho e o que pede sua aprovação antes, com um botão na conversa. Ler e investigar nunca pede.`,
                `How far ${draft.name || 'the agent'} goes on its own and what asks for your approval first, with a button in the conversation. Reading and looking into things never asks.`
              )}${isNew || !admin ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
            >
              <AutonomyControls
                own={{ autonomy: draft.autonomy, actionRules: draft.actionRules, outsideGuard: draft.outsideGuard }}
                inherited={{ autonomy: globalAutonomy, actionRules: globalRules, outsideGuard: globalGuard }}
                perAgent
                readOnly={!admin}
                onChange={(p) => (isNew ? patch(p) : (setDraft((d) => ({ ...d, ...p })), patchAgent(draft.id, p)))}
              />
            </Card>
          )}

          {pane('ferramentas') && (
            <Card title="Web" lead={`${L('Pesquisa e lê páginas com a ferramenta do próprio Claude Code ou Codex, na sua assinatura. Cada busca aparece nos passos da resposta.', 'Searches and reads pages with Claude Code’s or Codex’s own tool, on your subscription. Every search shows up in the reply’s steps.')}${isNew || !admin ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}>
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
              lead={`${L('Um Chrome só dele: abre páginas, clica, preenche e lê como uma pessoa, com logins separados dos seus (você entra pelo Assumir). Clique que compra, publica, envia ou apaga pede sua aprovação.', 'A Chrome of its own: opens pages, clicks, fills in and reads like a person, with logins separate from yours (you sign in via Take over). A click that buys, publishes, sends or deletes asks for your approval.')}${isNew || !admin ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
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
                    onClick={() =>
                      void confirmDialog({
                        title: L(`Apagar os logins do navegador de ${draft.name}?`, `Delete the logins in ${draft.name}'s browser?`),
                        body: L(`Saem os logins, os cookies e o histórico. ${draft.name} vai precisar que você entre de novo nas contas (pelo Assumir).`, `Logins, cookies and history go. ${draft.name} will need you to sign in to the accounts again (via Take over).`),
                        confirm: L('Apagar logins', 'Delete logins'),
                        danger: true
                      }).then((ok) => ok && browserAction(draft.id, 'clear'))
                    }
                  >
                    {L('Apagar logins', 'Delete logins')}
                  </button>
                </div>
              )}
            </Card>
          )}

          {pane('ferramentas') && (
            <Card
              title={L('Apps do computador', 'Computer apps')}
              lead={`${L('Os seus apps (Notas, Calendário, Mail…) que ele pode usar como uma pessoa, sem mexer no seu mouse. Em cada um, só ler ou também mexer; clique que envia, paga, publica ou apaga pede sua aprovação.', 'Your apps (Notes, Calendar, Mail…) it may use like a person, without moving your mouse. For each, read only or also change things; a click that sends, pays, publishes or deletes asks for your approval.')}${isNew || !admin ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
            >
              <AppsCard apps={draft.apps ?? []} onChange={(apps) => (isNew ? patch({ apps }) : (setDraft((d) => ({ ...d, apps })), patchAgent(draft.id, { apps })))} />
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
              lead={`${L('Memórias sobre você valem pra todos os agentes; as notas de trabalho são só dele.', 'Memories about you apply to every agent; work notes are its own.')}${isNew || !admin ? '' : L(' Muda na hora, sem precisar salvar.', ' Takes effect right away, no need to save.')}`}
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

          {pane('memoria') && (
            <Card
              title="Wiki"
              lead={L('A wiki é o que você e o time sabem, em páginas. Com acesso, o agente consulta antes de responder e cita as páginas.', 'The wiki is what you and the team know, as pages. With access, the agent looks there before replying and cites the pages.')}
            >
              <div className="segmented segmented--wide" role="radiogroup" aria-label="Wiki">
                {([['read', L('Lê a wiki', 'Reads the wiki')], ['none', L('Sem acesso', 'No access')]] as const).map(([value, label]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={(draft.wiki ?? 'read') === value}
                    className={(draft.wiki ?? 'read') === value ? 'is-active' : ''}
                    onClick={() => {
                      if (isNew) return patch({ wiki: value })
                      setDraft((d) => ({ ...d, wiki: value }))
                      patchAgent(draft.id, { wiki: value })
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="muted small">
                <button className="link" onClick={() => navigate({ kind: 'wiki' })}>
                  {L('Abrir a wiki', 'Open the wiki')}
                </button>
              </p>
            </Card>
          )}

          {pane('perfil') && (
            <Card title={L('Onde roda e modelo', 'Where it runs and model')} lead={L('O agente roda no Claude Code, no Codex ou em outro que você já usa, do jeito que você configurou: no seu plano, no gateway da empresa ou no seu provedor.', 'The agent runs in Claude Code, Codex or another one you already use, the way you set it up: on your plan, your company’s gateway or your provider.')}>
              <ModelPicker value={draft.modelId} onChange={(modelId) => patch({ modelId })} />
              <AccountPicker draft={draft} patch={patch} />
              <ReserveModel draft={draft} patch={patch} />
              {!engineStatus.loggedIn && !draft.accountId && (
                <p className="hint hint--warn">
                  <Icon name="lock" size={13} />{' '}
                  {engineStatus.soon
                    ? L(
                        `O ${ENGINES[engine].label} ainda não roda agentes: troque o modelo pra ${draft.name || 'o agente'} responder.`,
                        `${ENGINES[engine].label} doesn’t run agents yet: change the model so ${draft.name || 'the agent'} can reply.`
                      )
                    : L(
                        `O ${ENGINES[engine].label} ${engineStatus.off ? 'está desligado' : 'não está pronto'}: ${draft.name || 'o agente'} não responde até você ${engineStatus.off ? 'ligar o' : 'entrar no'} ${ENGINES[engine].label} (Configurações → Modelos) ou trocar o modelo.`,
                        `${ENGINES[engine].label} ${engineStatus.off ? 'is off' : 'isn’t ready'}: ${draft.name || 'the agent'} won’t reply until you ${engineStatus.off ? 'turn on' : 'sign in to'} ${ENGINES[engine].label} (Settings → Models) or change the model.`
                      )}{' '}
                  {!engineStatus.soon && admin && (
                    <button className="link" onClick={() => (setTab('settings', 'modelos'), navigate({ kind: 'settings' }))}>
                      {L('Abrir Modelos', 'Open Models')}
                    </button>
                  )}
                </p>
              )}
              <div className="grid2">
                {/* Cursor's models carry the effort in the name (…-high, …-xhigh): no separate pick. */}
                {engine !== 'cursor' && (
                  <Field label={L('Esforço de raciocínio', 'Reasoning effort')} hint={L('Mais esforço pensa mais e gasta mais do plano.', 'More effort thinks longer and uses more of your plan.')}>
                    <Select
                      value={draft.effort ?? null}
                      onChange={(v) => { if (v) patch({ effort: v as Agent['effort'] }) }}
                      options={EFFORTS.map((ef) => ({ value: ef.id, label: ef.label }))}
                      placeholder={L('Escolha o esforço', 'Pick an effort')}
                    />
                  </Field>
                )}
                <Field label={L('Limite mensal (milhões de tokens)', 'Monthly limit (millions of tokens)')} hint={L(`Conferido antes de cada turno. No limite, ${draft.name || 'o agente'} para e avisa. Zero é sem limite.`, `Checked before every turn. At the limit, ${draft.name || 'the agent'} stops and tells you. Zero means no limit.`)}>
                  <NumberInput
                    min={0}
                    step={0.5}
                    value={draft.limit / 1_000_000}
                    onChange={(n) => patch({ limit: Math.max(0, Math.round(n * 1_000_000)) })}
                    className="input--short"
                  />
                </Field>
                <Field label={L('Máx. rotinas ligadas', 'Max. enabled routines')} hint={L('Quantas rotinas o agente pode ter ligadas ao mesmo tempo.', 'How many routines the agent can have enabled at the same time.')}>
                  <NumberInput
                    min={1}
                    step={1}
                    value={draft.maxRoutines ?? MAX_AGENT_ROUTINES}
                    onChange={(n) => patch({ maxRoutines: routineCap(n) })}
                    className="input--short"
                  />
                </Field>
              </div>
            </Card>
          )}
        </div>

        <aside className="agent-side">
          <div className="profile-card">
            <AgentAvatar agent={{ ...draft, name: draft.name || '?' }} size={72} />
            <strong className="profile-card__name">{draft.name || L('Sem nome', 'No name')}</strong>
            <span className="muted">@{draft.handle || 'handle'}</span>
            {draft.role && <p className="profile-card__role">{draft.role}</p>}
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
                  <strong>{tokens(draft.used)}</strong>{' '}
                  <span className="muted">
                    {/* No limit set: "of 0 tokens" would read as a cap spent, so say there isn't one. */}
                    {hasMonthlyLimit(draft.limit) ? L(`de ${tokens(draft.limit)} tokens`, `of ${tokens(draft.limit)} tokens`) : L('sem limite no mês', 'no monthly limit')}
                  </span>
                </span>
                <UsageBar used={draft.used} limit={draft.limit} />
              </div>
            )}
          </div>
        </aside>
      </div>
      </fieldset>
    </Page>
  )
}

const COMPUTER_STATE = (): Record<string, { label: string; tone: string }> => ({
  off: { label: L('desligado', 'off'), tone: '' },
  stopped: { label: L('parado', 'stopped'), tone: 'tag--warn' },
  starting: { label: L('ligando', 'starting'), tone: 'tag--warn' },
  running: { label: L('ligado', 'running'), tone: 'tag--ok' },
  no_docker: { label: L('sem Docker', 'no Docker'), tone: 'tag--warn' },
  error: { label: L('não ligou', 'didn’t start'), tone: 'tag--danger' }
})

type ComputerChoice = 'none' | 'linux' | 'mac'
const COMPUTER_CHOICES = (): { value: ComputerChoice; label: string }[] => [
  { value: 'none', label: L('Nenhum', 'None') },
  { value: 'linux', label: L('Linux isolado', 'Isolated Linux') },
  { value: 'mac', label: L('Este computador', 'This computer') }
]

function ComputerCard({ agentId, kind, onChange }: { agentId: string; kind: ComputerChoice; onChange: (k: ComputerChoice) => void }): ReactNode {
  const info = useStore((s) => computerOf(s, agentId))
  // Looking is anyone's; starting, stopping, erasing and opening its folder, the admins'.
  const admin = useStore(amAdmin)
  const [confirmErase, setConfirmErase] = useState(false)
  const [confirmMac, setConfirmMac] = useState(false)
  useEffect(() => computerAction(agentId, 'refresh'), [agentId])
  // "Este computador" picked but not let yet: the choice shows picked, and only its confirmation
  // shows under it. Before, the card kept the last kind's panel (Linux's Docker, folders, erase)
  // under the confirmation, with Linux still picked, and that mix read as this computer's full card.
  const confirming = confirmMac && kind !== 'mac'
  const shown: ComputerChoice = confirming ? 'mac' : kind
  const on = kind === 'linux' && !confirming
  const state = on ? (info && info.state !== 'off' ? info.state : 'stopped') : 'off'
  const st = COMPUTER_STATE()[state]!
  const isolated = useStore((s) => s.isolatedComputers)

  return (
    <Card
      title={L('Computador', 'Computer')}
      lead={L(
        'Onde ele roda comandos, instala, cria e testa. O Linux é uma máquina só dele, isolada do seu computador e sem credenciais. Neste computador, ele usa o que você já tem instalado, mas alcança tudo o que você alcança.',
        'Where it runs commands, installs, builds and tests. Linux is a machine of its own, isolated from your computer and with no credentials. On this computer, it uses what you already have installed, but reaches everything you can.'
      )}
    >
      <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Computador', 'Computer')}>
        {COMPUTER_CHOICES()
          .filter((c) => c.value !== 'linux' || isolated || kind === 'linux') // on a server without Docker there's none to have
          .map((c) => (
            <button
              key={c.value}
              role="radio"
              aria-checked={shown === c.value}
              className={shown === c.value ? 'is-active' : ''}
              onClick={() => {
                if (kind === c.value) return setConfirmMac(false)
                if (c.value === 'mac') return setConfirmMac(true)
                setConfirmMac(false)
                onChange(c.value)
              }}
            >
              {c.label}
            </button>
          ))}
      </div>
      {confirming && (
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
              'Continua valendo: cada comando aparece no chat, as travas de loop e de limite seguem, e as chaves do app (GitHub, Telegram, conectores) não vão junto. Os comandos começam na pasta dele. Dá pra voltar pro Linux ou desligar quando quiser.',
              'Still true: every command shows up in the chat, the loop and limit guards still apply, and the app’s keys (GitHub, Telegram, connectors) don’t come along. Commands start in its folder. You can go back to Linux or turn it off any time.'
            )}
          </p>
          <div className="row">
            <button className="btn btn--sm btn--danger" onClick={() => (setConfirmMac(false), onChange('mac'))}>
              {L('Liberar o computador pra ele', 'Let it use this computer')}
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
            <span className="muted small grow">
              {L(
                'Liberado: os comandos rodam direto no seu computador, como você, e começam na pasta dele. Ele alcança as suas pastas sem emprestar e não precisa do Docker.',
                'Allowed: its commands run right on your computer, as you, and start in its folder. It reaches your folders without lending them and needs no Docker.'
              )}
            </span>
          </div>
          <Services agentId={agentId} />
          {admin && (
            <div className="row computer__actions">
              <button className="btn btn--sm btn--ghost" onClick={() => computerAction(agentId, 'open_folder')}>
                {L('Abrir pasta dele', 'Open its folder')}
              </button>
              <button className="btn btn--sm btn--ghost" disabled={!info?.services.some((x) => x.running)} onClick={() => computerAction(agentId, 'restart')}>
                {L('Parar serviços', 'Stop services')}
              </button>
            </div>
          )}
        </>
      )}
      {on && (
        <>
          <div className="computer">
            <span className={`tag ${st.tone}`}>{st.label}</span>
            <span className="muted small grow">
              {state === 'no_docker'
                ? `${info?.detail ?? L('Precisa do Docker aberto. Abra o Docker Desktop (ou instale).', 'It needs Docker open. Open Docker Desktop (or install it).')} ${L('Depois, clique em Verificar de novo.', 'Then click Check again.')}`
                : state === 'error'
                  ? `${info?.detail ? `${info.detail} ` : ''}${L('Tente ligar de novo; se continuar, apague o computador e comece do zero.', 'Try starting it again; if it keeps failing, erase the computer and start fresh.')}`
                  : (info?.detail ?? (state === 'running' ? L('Pronto. Pasta de trabalho: /work', 'Ready. Work folder: /work') : state === 'stopped' ? L('Liga sozinho quando ele precisar.', 'Starts on its own when it needs to.') : ''))}
            </span>
            {admin && (state === 'stopped' || state === 'error') && (
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
          {admin && <div className="row computer__actions">
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
          </div>}
        </>
      )}
    </Card>
  )
}

// What the agent left running (servers, dashboards), on its computer or on the Mac.
function Services({ agentId }: { agentId: string }): ReactNode {
  const info = useStore((s) => computerOf(s, agentId))
  const admin = useStore(amAdmin)
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
                  {admin && (
                    <button className="btn btn--sm btn--ghost" onClick={() => stopService(agentId, svc.name)}>
                      {L('Parar', 'Stop')}
                    </button>
                  )}
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
          <p className="hint">{L('Emprestar ou devolver reinicia o computador: os serviços param, o que ele instalou fica. Sem credenciais lá dentro, publicar o código e colocar no ar ficam com você.', 'Lending or giving back restarts the computer: services stop, what it installed stays. With no credentials inside, publishing the code and putting it live stay with you.')}</p>
        </>
      )}
      {error && <p className="field__error">{error}</p>}
    </div>
  )
}

// Before an agent (or every agent) goes with no guardrails: here, in Settings and in the introduction.
export const confirmNoGuardrails = (): Promise<boolean> =>
  confirmDialog({
    title: L('Deixar agir sem travas?', 'Let it act with no guardrails?'),
    body: L(
      'Envia, apaga, publica, paga e clica sem te perguntar. Continua pedindo o que você marcou como alto risco e, com a proteção ligada, o que vai pra fora depois de ler algo de fora. Tudo fica nos passos de cada resposta.',
      'It sends, deletes, publishes, pays and clicks without asking you. It still asks for what you marked high risk and, with the guard on, for what goes out after reading something from outside. Everything stays in each reply’s steps.'
    ),
    confirm: L('Sem travas', 'No guardrails'),
    danger: true
  })

// How far an agent goes on its own (in Settings, every agent): a level, the outside-content guard, and a rule
// per kind of action for whoever wants it finer. On an agent's page, `inherited` is Settings and "Padrão"
// follows them. `readOnly`: someone who only looks at the agent.
type Autonomous = { autonomy?: Autonomy; actionRules?: ActionRules; outsideGuard?: boolean }

function AutonomyControls({ own, inherited, perAgent, readOnly, onChange }: { own: Autonomous; inherited?: Autonomous; perAgent?: boolean; readOnly?: boolean; onChange: (patch: Autonomous) => void }): ReactNode {
  const level = own.autonomy
  const effective: Autonomy = level ?? inherited?.autonomy ?? 'normal'
  const guard = own.outsideGuard ?? inherited?.outsideGuard ?? true
  const pick = async (next: Autonomy | undefined): Promise<void> => {
    if ((next ?? inherited?.autonomy) === 'free' && effective !== 'free') {
      if (!(await confirmNoGuardrails())) return
    }
    onChange({ autonomy: next })
  }
  const options: (Autonomy | 'default')[] = perAgent ? ['default', ...AUTONOMY_LEVELS] : [...AUTONOMY_LEVELS]
  const value = perAgent ? (level ?? 'default') : effective
  // What a kind does when its own row says nothing: the level (the agent's or Settings'), then Settings' rule.
  const base: Policy = perAgent ? { agentLevel: level, globalRules: inherited?.actionRules, globalLevel: inherited?.autonomy } : { globalLevel: own.autonomy }
  return (
    <div className="autonomy">
      <div className="segmented segmented--wide" role="radiogroup" aria-label={L('Autonomia', 'Autonomy')}>
        {options.map((o) => (
          <button key={o} role="radio" aria-checked={value === o} className={value === o ? 'is-active' : ''} disabled={readOnly} onClick={() => value !== o && void pick(o === 'default' ? undefined : o)}>
            {o === 'default' ? L('Padrão', 'Default') : autonomyLabel(o)}
          </button>
        ))}
      </div>
      <p className="muted small">
        {autonomyHint(effective)}
        {effective === 'free' && guard ? ` ${L('Com a proteção abaixo ligada, o que não tem volta depois de ler algo de fora também pede.', 'With the guard below on, what can’t be undone after reading something from outside asks too.')}` : ''}
        {perAgent && !level ? ` ${L(`“Padrão” segue Configurações › Agentes: ${autonomyLabel(effective).toLowerCase()}.`, `“Default” follows Settings › Agents: ${autonomyLabel(effective).toLowerCase()}.`)}` : ''}
      </p>
      <div className="key-row">
        <Icon name="shield" />
        <div className="grow">
          <strong>{L('Depois de ler algo de fora, pedir antes do que não tem volta', 'After reading something from outside, ask before what can’t be undone')}</strong>
          <p className="muted small">
            {L(
              'Um e-mail, uma página ou uma issue podem trazer instruções escritas por outra pessoa. Com isso ligado, depois de ler algo assim, enviar, publicar, pagar, apagar e clicar no que é arriscado pedem sua aprovação, mesmo onde uma regra deixa fazer sozinho.',
              'An email, a page or an issue can carry instructions someone else wrote. With this on, after reading something like that, sending, publishing, paying, deleting and risky clicks ask for your approval, even where a rule lets it do them alone.'
            )}
          </p>
        </div>
        <Toggle on={guard} onChange={(v) => !readOnly && onChange({ outsideGuard: v })} />
      </div>
      <details className="autonomy__rules">
        <summary>{L('Ajustar ação por ação', 'Fine-tune action by action')}</summary>
        <ActionRulesList rules={own.actionRules ?? {}} fallback={(k) => actionMode(k, base)} readOnly={readOnly} onChange={(actionRules) => onChange({ actionRules })} />
      </details>
    </div>
  )
}

// One row per action that matters, each with what the agent does about it. "Pelo nível" clears the row's own
// rule: then the level decides, and where it says nothing (normal), the tool's class, as always.
function ActionRulesList({ rules, fallback, readOnly, onChange }: { rules: ActionRules; fallback: (k: ActionKind) => ActionMode | undefined; readOnly?: boolean; onChange: (r: ActionRules) => void }): ReactNode {
  const set = (k: ActionKind, m: ActionMode | undefined): void => {
    const next: ActionRules = { ...rules }
    if (m) next[k] = m
    else delete next[k]
    onChange(next)
  }
  return (
    <div className="grants rules">
      {ACTION_KINDS.map((k) => {
        const own = rules[k]
        const by = fallback(k)
        const value: ActionMode | 'default' = own ?? 'default'
        const options: (ActionMode | 'default')[] = ['default', 'ask', 'auto', 'off']
        return (
          <div key={k} className="grant">
            <div className="grant__name">
              <Icon name="shield" size={15} />
              <div>
                <strong>{kindLabel(k)}</strong>
                <span className="muted small">
                  {actionHint(k)}
                  {!own ? ` · ${L('pelo nível', 'by the level')}: ${by ? modeLabel(by).toLowerCase() : k === 'browser' || k === 'apps' ? modeLabel('ask').toLowerCase() : L('pede só se a ferramenta for sensível', 'asks only if the tool is sensitive')}` : ''}
                </span>
              </div>
            </div>
            <div className="segmented" role="radiogroup" aria-label={kindLabel(k)}>
              {options.map((o) => (
                <button key={o} role="radio" aria-checked={value === o} className={value === o ? 'is-active' : ''} disabled={readOnly} onClick={() => set(k, o === 'default' ? undefined : o)}>
                  {o === 'default' ? L('Pelo nível', 'By level') : modeLabel(o)}
                </button>
              ))}
            </div>
          </div>
        )
      })}
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

// `group`: what's inside is a set of buttons (a segmented choice). A label around buttons would name
// each one with the whole field and click the first on any click; a named group names the set only.
export function Field({ label, hint, error, group, children }: { label: string; hint?: string; error?: string | null; group?: boolean; children: ReactNode }): ReactNode {
  const id = useId()
  if (group)
    return (
      <div className={`field ${error ? 'has-error' : ''}`} role="group" aria-labelledby={`${id}-label`} aria-describedby={error || hint ? `${id}-hint` : undefined}>
        <span className="field__label" id={`${id}-label`}>
          {label}
        </span>
        {children}
        {error ? <span className="field__error" id={`${id}-hint`}>{error}</span> : hint ? <span className="hint" id={`${id}-hint`}>{hint}</span> : null}
      </div>
    )
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
  const team = useStore(teamMode)
  if (team) return <InboxPage />
  return <MyApprovals />
}

function MyApprovals(): ReactNode {
  const approvals = useStore((s) => s.approvals)
  const pending = approvals.filter((a) => a.state === 'pending')
  const past = approvals.filter((a) => a.state !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
  const conversations = useStore((s) => s.conversations)
  const agents = useStore((s) => s.agents)

  return (
    <Page title={L('Aprovações', 'Approvals')} subtitle={L('Nada sensível acontece sem você. Cada aprovação cobre uma ação exata.', 'Nothing sensitive happens without you. Each approval covers one exact action.')}>
      {pending.length === 0 ? (
        <div className="empty empty--rest">
          <SleepingToucan />
          <p>{L('Nada esperando por você.', 'Nothing waiting for you.')}</p>
          <p className="muted">{L('Quando um agente quiser publicar código, colocar algo no ar, apagar ou enviar algo pra fora, o pedido aparece aqui e na conversa.', 'When an agent wants to publish code, put something live, delete or send something out, the request shows up here and in the conversation.')}</p>
        </div>
      ) : (
        <div className="stack-list">
          {pending.map((a) => {
            const conv = conversations.find((c) => c.id === a.conversationId)
            const who = agents.find((x) => x.id === a.agentId)?.name
            return (
              <div key={a.id}>
                <div className="row row--between small muted list-meta">
                  <span>
                    {conv?.kind === 'channel' ? L(`em #${conv.name}`, `in #${conv.name}`) : who ? L(`na DM com ${who}`, `in the DM with ${who}`) : L('na DM', 'in the DM')} · {time(a.createdAt)}
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

// With a team, "Pra você": what waits on me (approvals I decide, questions to me, and for admins the
// cards members sent), then what I asked that waits on someone else, then the history.
export function InboxPage(): ReactNode {
  const inbox = useStore((s) => s.inbox)
  const you = useStore((s) => s.you)
  const conversations = useStore((s) => s.conversations)
  const agents = useStore((s) => s.agents)
  const people = useStore((s) => s.people)
  const approvals = useStore((s) => s.approvals)
  const mine = new Set(inbox.approvals.map((a) => a.id))
  const asked = approvals.filter((a) => a.state === 'pending' && !mine.has(a.id) && a.requestedBy === you)
  const past = approvals.filter((a) => a.state !== 'pending').sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
  const proposals = inbox.proposals ?? []
  // One answered by someone else while I was typing stays, with what I typed and who answered.
  const gone = (inbox.answered ?? []).filter((q) => questionDrafts.get(q.id)?.trim() && !inbox.questions.some((x) => x.id === q.id))
  const questions = [...inbox.questions.map((q) => ({ q, done: false })), ...gone.map((q) => ({ q, done: true }))]
  const nothing = inbox.approvals.length + questions.length + proposals.length === 0
  const where = (conversationId: string | undefined, agentId: string): string => {
    const conv = conversations.find((c) => c.id === conversationId)
    const who = agents.find((x) => x.id === agentId)?.name
    return conv?.kind === 'channel' ? L(`em #${conv.name}`, `in #${conv.name}`) : conv ? (who ? L(`na sua DM com ${who}`, `in your DM with ${who}`) : L('na sua DM', 'in your DM')) : L('numa conversa que você não vê', "in a conversation you don't see")
  }
  const meta = (conversationId: string | undefined, agentId: string, at: number): ReactNode => (
    <div className="row row--between small muted list-meta">
      <span>
        {where(conversationId, agentId)} · {time(at)}
      </span>
      {conversationId && conversations.some((c) => c.id === conversationId) && (
        <button className="link" onClick={() => navigate({ kind: 'conversation', id: conversationId })}>
          {L('Ver na conversa', 'See in the conversation')}
        </button>
      )}
    </div>
  )
  return (
    <Page title={L('Pra você', 'For you')} subtitle={L('O que espera por você: aprovações que você decide e perguntas dos agentes a você.', 'What waits on you: approvals you decide and the agents’ questions to you.')}>
      {nothing && (
        <div className="empty empty--rest">
          <SleepingToucan />
          <p>{L('Nada esperando por você.', 'Nothing waiting for you.')}</p>
          <p className="muted">{L('Quando um agente precisar da sua aprovação ou te fizer uma pergunta, aparece aqui e na conversa.', 'When an agent needs your approval or asks you something, it shows up here and in the conversation.')}</p>
        </div>
      )}
      {inbox.approvals.length > 0 && (
        <>
          <h3 className="section-title">{L('Aprovações', 'Approvals')}</h3>
          <div className="stack-list">
            {inbox.approvals.map((a) => (
              <div key={a.id}>
                {meta(a.conversationId, a.agentId, a.createdAt)}
                <ApprovalCard approval={approvals.find((x) => x.id === a.id) ?? a} />
              </div>
            ))}
          </div>
        </>
      )}
      {questions.length > 0 && (
        <>
          <h3 className="section-title">{L('Perguntas', 'Questions')}</h3>
          <div className="stack-list">
            {questions.map(({ q, done }) => (
              <div key={q.id}>
                {meta(q.conversationId, q.agentId, q.createdAt)}
                <QuestionCard id={q.id} agentName={agents.find((x) => x.id === q.agentId)?.name} askedTo={q.askedTo} question={q.text} {...(q.decisions ? { decisions: q.decisions, ...(q.answers ? { answers: q.answers } : {}), ...(q.recommended ? { recommended: q.recommended } : {}) } : {})} answered={done} {...(q.answeredBy ? { answeredBy: q.answeredBy } : {})} inbox />
              </div>
            ))}
          </div>
        </>
      )}
      {proposals.length > 0 && (
        <>
          <h3 className="section-title">{L('Pedidos pra um admin aplicar', 'Requests for an admin to apply')}</h3>
          <div className="stack-list">
            {proposals.map((p) => (
              <div key={`${p.id}:${p.index ?? 0}`}>
                <div className="row row--between small muted list-meta">
                  <span>
                    {L(`${people.find((x) => x.id === p.by)?.name ?? 'Alguém'} pediu`, `${people.find((x) => x.id === p.by)?.name ?? 'Someone'} asked`)} · {time(p.at)}
                  </span>
                </div>
                <ProposalCard message={{ id: p.id, conversationId: '', author: { kind: 'agent', id: p.agentId }, text: '', at: p.at, run: { status: 'done' } } as Message} index={p.index ?? 0} proposal={p.proposal} />
              </div>
            ))}
          </div>
        </>
      )}
      {asked.length > 0 && (
        <>
          <h3 className="section-title">{L('Você pediu, esperando outra pessoa', 'You asked, waiting on someone else')}</h3>
          <div className="stack-list">
            {asked.map((a) => (
              <div key={a.id}>
                {meta(a.conversationId, a.agentId, a.createdAt)}
                <ApprovalCard approval={a} />
              </div>
            ))}
          </div>
        </>
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

// A long tool name wraps inside its own column; the rest of the row keeps its size.
export function HistoryRow({ id }: { id: string }): ReactNode {
  const a = useStore((s) => s.approvals.find((x) => x.id === id)!)
  const agent = useStore((s) => agentById(s, a.agentId))
  return (
    <div className="table__row history-row">
      {agent && <AgentAvatar agent={agent} size={22} />}
      <span className="history-row__what">
        {a.connectorId === COMPUTADOR ? shellActions(String(a.args['command'] ?? '')).map(kindLabel).join(', ') || toolWords(a.tool) : toolWords(a.tool)} <span className="muted">· {a.connectorName}</span>
      </span>
      {a.outcome && <span className="muted small history-row__outcome" title={a.outcome}>{a.outcome}</span>}
      <span className={`tag ${a.state === 'approved' ? 'tag--ok' : a.state === 'refused' ? 'tag--danger' : ''}`}>{a.state === 'approved' ? L('aprovado', 'approved') : a.state === 'refused' ? L('recusado', 'refused') : L('expirado', 'expired')}</span>
      <span className="muted small">{a.decidedAt ? time(a.decidedAt) : ''}</span>
    </div>
  )
}

// ---------- Connectors ----------

const CLASS_LABEL = (): Record<ToolClass, string> => ({ read: L('leitura', 'read'), write: L('escrita', 'write'), sensitive: L('sensível', 'sensitive') })

export const STATUS = (): Record<Connector['status'], { label: string; tone: string }> => ({
  connected: { label: L('conectado', 'connected'), tone: 'tag--ok' },
  connecting: { label: L('conectando…', 'connecting…'), tone: '' },
  needs_auth: { label: L('precisa autorizar', 'needs authorization'), tone: 'tag--warn' },
  error: { label: L('não conectou', 'didn’t connect'), tone: 'tag--danger' },
  disconnected: { label: L('desconectado', 'disconnected'), tone: 'tag--warn' }
})

const address = (c: Connector): string => (c.kind === 'remote' ? (c.url ?? '') : [c.command, ...(c.args ?? [])].join(' '))

// The token of a connector, set or replaced without removing it (which would lose the agents' access).
function ConnectorToken({ id }: { id: string }): ReactNode {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = (): void => {
    setBusy(true)
    setError(null)
    setConnectorToken(id, token)
      .then(() => setToken(''))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="row">
      <input className="grow" type="password" value={token} placeholder={L('Token ou op://… (substitui o atual)', 'Token or op://… (replaces the current one)')} onChange={(e) => setToken(e.target.value)} />
      <button className="btn btn--sm" disabled={busy || !token.trim()} onClick={save}>
        {L('Salvar token', 'Save token')}
      </button>
      {error && <span className="note note--error">{error}</span>}
    </div>
  )
}

export function ConnectorsPage(): ReactNode {
  const connectors = useStore((s) => s.connectors)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const open = connectors.find((c) => c.id === openId)
  const admin = useStore(amAdmin)

  // Connectors are the admins': a member sees which the agents have, and how they are.
  if (!admin)
    return (
      <Page title={L('Conectores', 'Connectors')} subtitle={L('Os serviços com que os agentes do time trabalham. Cada chamada passa pelas permissões e aprovações.', 'The services the team’s agents work with. Every call goes through permissions and approvals.')}>
        {connectors.length === 0 ? (
          <p className="muted">{L('Nenhum conector ainda.', 'No connectors yet.')}</p>
        ) : (
          <div className="table">
            {connectors.map((c) => (
              <div key={c.id} className="table__row">
                <Icon name="plug" size={15} />
                <span className="grow">
                  <strong>{c.name}</strong> <span className="muted small">· {L(`${c.tools.filter((t) => t.enabled).length} ferramentas`, `${c.tools.filter((t) => t.enabled).length} tools`)}</span>
                </span>
                <span className={`tag ${STATUS()[c.status].tone}`}>{STATUS()[c.status].label}</span>
              </div>
            ))}
          </div>
        )}
        <AdminOnly>{L('Só um admin adiciona, autoriza ou muda conectores.', 'Only an admin adds, authorizes or changes connectors.')}</AdminOnly>
      </Page>
    )

  return (
    <Page
      title={L('Conectores', 'Connectors')}
      subtitle={L(
        'Os serviços com que seus agentes trabalham. O login é pelo navegador e o acesso fica neste computador (menos nos que passam por terceiros, como a Composio); cada chamada dos agentes passa pelas permissões e aprovações.',
        'The services your agents work with. You sign in through the browser and the access stays on this computer (except for those that go through a third party, like Composio); every call the agents make goes through permissions and approvals.'
      )}
      actions={
        !adding && (
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> {L('Adicionar personalizado', 'Add custom')}
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
      <ConnectorGrid status={STATUS()} onManage={setOpenId} />
      <HarnessMcps onAdded={setOpenId} />
      {open && <ConnectorDetails c={open} onClose={() => setOpenId(null)} />}
    </Page>
  )
}

// A connector's state, who uses it and its tools, in a window over the page.
function ConnectorDetails({ c, onClose }: { c: Connector; onClose: () => void }): ReactNode {
  const users = useStore((s) => s.agents.filter((a) => (a.grants[c.id] ?? 'none') !== 'none'))
  const entry = entryOf(c)
  const own = entry?.app // signs in with the person's own app: it can be changed here
  const [changing, setChanging] = useState(false)
  return (
    <Modal title={c.name} onClose={onClose} className="connector-modal">
      <div className="connector-modal__body">
        <div className="row connector-modal__meta">
          <span className={`tag ${STATUS()[c.status].tone}`}>{STATUS()[c.status].label}</span>
          <span className="muted small mono truncate grow">{address(c)}</span>
        </div>
        <p className="muted small">
          {users.length ? (
            <>
              {L('Quem usa:', 'Used by:')} {users.map((a) => a.name).join(', ')}
            </>
          ) : (
            L('Nenhum agente usa ainda. Dê acesso na página de cada agente, em Ferramentas.', "No agent uses it yet. Give access on each agent's page, under Tools.")
          )}
        </p>
        {entry?.warning && <ThirdPartyWarning text={entry.warning()} />}
        {c.kind === 'stdio' && (
          <p className="warn-box">
            <Icon name="terminal" size={14} /> {L('Conector local: roda um processo no seu computador com o seu usuário.', 'Local connector: runs a process on your computer as your user.')}
          </p>
        )}
        {c.error && (
          <div className="note note--error">
            {c.error}
            {c.status === 'error' && ` ${L('Clique em Conectar de novo. Se continuar, confira o endereço e o login.', 'Click Reconnect. If it keeps happening, check the address and the sign-in.')}`}
            {c.errorDetail && c.errorDetail !== c.error && (
              <details className="engine-problem__more note__more">
                <summary>{L('Ver detalhes', 'See details')}</summary>
                <pre>{c.errorDetail}</pre>
              </details>
            )}
          </div>
        )}
        {c.kind === 'remote' && c.auth === 'token' && <ConnectorToken id={c.id} />}
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
          {own && (
            <button className="btn btn--ghost btn--sm" onClick={() => setChanging(true)}>
              {own.provider === 'google' ? L('Seu app do Google', 'Your Google app') : L('Seu app do Slack', 'Your Slack app')}
            </button>
          )}
          <span className="grow" />
          <button
            className="btn btn--ghost btn--sm"
            onClick={() =>
              void confirmDialog({
                title: L(`Remover ${c.name}?`, `Remove ${c.name}?`),
                body: L('Os agentes perdem acesso às ferramentas dele. Pra voltar, é só adicionar o conector de novo.', 'The agents lose access to its tools. To get it back, just add the connector again.'),
                confirm: L(`Remover ${c.name}`, `Remove ${c.name}`)
              }).then((ok) => ok && (removeConnector(c.id), onClose()))
            }
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
        {c.tools.map((t) => {
          // A runner (Composio's) has no class of its own: each call counts as what it runs.
          const runner = perCallTool(c.url, t.name)
          return (
            <div key={t.name} className={`tools__row ${t.enabled ? '' : 'is-off'}`} title={t.description}>
              <code>
                {t.name}
                {t.isNew && <span className="tag tag--warn tools__new">{L('nova', 'new')}</span>}
              </code>
              {runner ? (
                <span className="small muted" title={L('Leituras rodam na hora; escritas pedem acesso de escrita; ações sensíveis pedem aprovação a cada chamada.', 'Reads run right away; writes need write access; sensitive actions ask for approval on each call.')}>
                  {L('por chamada', 'per call')}
                </span>
              ) : (
                <Select
                  value={t.cls ?? null}
                  onChange={(v) => { if (v) updateTool(c.id, t.name, { cls: v as ToolClass }) }}
                  options={(Object.keys(CLASS_LABEL()) as ToolClass[]).map((k) => ({ value: k, label: CLASS_LABEL()[k] }))}
                  placeholder={L('Escolha a classe', 'Pick a class')}
                />
              )}
              <input
                type="checkbox"
                disabled={t.cls !== 'sensitive' && !runner}
                checked={t.highRisk && (t.cls === 'sensitive' || runner)}
                onChange={(e) => updateTool(c.id, t.name, { highRisk: e.target.checked })}
              />
              <Toggle on={t.enabled} onChange={(v) => updateTool(c.id, t.name, { enabled: v })} />
            </div>
          )
        })}
        <p className="hint">{L('Ferramentas novas que o servidor publicar depois entram desligadas até você revisar. Sensíveis sempre pedem aprovação.', 'New tools the server publishes later come in off until you review them. Sensitive ones always ask for approval.')}</p>
      </div>
      {changing && own && <OwnAppSetup provider={own.provider} onClose={() => setChanging(false)} />}
    </Modal>
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
            <Select
              value={auth ?? null}
              onChange={(v) => { if (v) setAuth(v as ConnectorAuth) }}
              options={[
                { value: 'oauth', label: L('OAuth (abre o navegador pra autorizar)', 'OAuth (opens the browser to authorize)') },
                { value: 'token', label: L('Token (cabeçalho Authorization: Bearer)', 'Token (Authorization: Bearer header)') },
                { value: 'none', label: L('Nenhuma', 'None') }
              ]}
              placeholder={L('Escolha a autenticação', 'Pick an authentication')}
            />
          </Field>
          {auth === 'token' && (
            <Field label="Token" hint={L('Ou uma referência do 1Password (op://Cofre/Item/campo), lida a cada conexão.', 'Or a 1Password reference (op://Vault/Item/field), read on each connection.')}>
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
          <Field label={L('Variáveis de ambiente', 'Environment variables')} hint={L('Uma por linha, NOME=valor. Os valores ficam cifrados; um valor op://Cofre/Item/campo vem do 1Password.', 'One per line, NAME=value. Values are encrypted; an op://Vault/Item/field value comes from 1Password.')}>
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
// With a team, Pessoas (everyone) and Atividade (admins); a member sees only what's theirs to change.
// The phone (Telegram) is the owner's alone.
export const SETTINGS_TABS = (team = false, admin = true, owner = true): TabList => [
  ['geral', L('Geral', 'General')],
  ...(admin
    ? ([
        ['modelos', L('Modelos', 'Models')],
        ['agentes', L('Agentes', 'Agents')],
        ...(owner ? [['integracoes', L('Celular', 'Phone')]] : [])
      ] as [string, string][])
    : []),
  ...(team ? [['pessoas', L('Pessoas', 'People')] as [string, string]] : []),
  ...(team && admin ? [['atividade', L('Atividade', 'Activity')] as [string, string]] : []),
  ...(admin && hasServers() ? [['servidores', L('Servidores', 'Servers')] as [string, string]] : [])
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

// Whom the agent answers to (src/shared/org.ts). With that set, the one above hands it work in its own
// channel and gets the answer back; with no one answering to anyone, nothing changes.
function ReportsTo({ draft, patch }: { draft: Agent; patch: (p: Partial<Agent>) => void }): ReactNode {
  const agents = useStore((s) => s.agents)
  const bosses = possibleBosses(agents, draft.id)
  const below = directReports(agents, draft.id)
  const boss = bosses.find((a) => a.id === draft.reportsTo)
  const none = L('Ninguém', 'No one')
  return (
    <Card
      title={L('Time', 'Team')}
      lead={L(
        'Quem está acima passa trabalho a quem está abaixo, no canal de cada um, e recebe a resposta de volta. Sem ninguém marcado, tudo funciona como sempre.',
        'Whoever is above hands work to those below, in each one’s channel, and gets the answer back. With no one set, everything works as it always did.'
      )}
    >
      <label className="field">
        <span className="field__label">{L('Responde a', 'Answers to')}</span>
        <Select
          value={boss?.id ?? null}
          onChange={(v) => patch({ reportsTo: v || undefined })}
          options={[{ value: '', label: none }, ...bosses.map((a) => ({ value: a.id, label: a.role ? `${a.name} · ${a.role}` : a.name }))]}
          placeholder={none}
        />
        {boss && (
          <span className="hint">
            {L(
              `${boss.name} pode pedir trabalho a ${draft.name || 'este agente'}. O pedido vira uma thread no primeiro canal marcado acima, e a resposta volta pra ${boss.name}.`,
              `${boss.name} can ask ${draft.name || 'this agent'} for work. The request becomes a thread in the first channel checked above, and the answer goes back to ${boss.name}.`
            )}
          </span>
        )}
      </label>
      {below.length > 0 && (
        <p className="hint">
          {L('Respondem a ', 'Answering to ')}
          {draft.name || L('este agente', 'this agent')}: {below.map((a) => a.name).join(', ')}.
        </p>
      )}
    </Card>
  )
}

// A model to run with, from what each harness in use offers, or another by name.
// Where the agent's replies go when its model's subscription is out (a 5-hour or weekly limit, a 429).
// Off by default. Turned on, it starts on another login of the same harness when there is one (the
// limit is the account's), else on another harness, since the same subscription is out for both.
function ReserveModel({ draft, patch }: { draft: Agent; patch: (p: Partial<Agent>) => void }): ReactNode {
  const usable = useStore((s) => usableEngines(s.settings))
  const accounts = useStore((s) => s.settings.accounts) ?? []
  const main = modelInfo(draft.modelId)?.engine
  const mainAccount = accounts.find((a) => a.id === draft.accountId && a.engine === main)
  const on = !!draft.fallbackModelId
  const first = (): Partial<Agent> => {
    const other = accounts.find((a) => a.engine === main && a.id !== mainAccount?.id)
    if (other) return { fallbackModelId: draft.modelId, fallbackAccountId: other.id }
    if (mainAccount) return { fallbackModelId: draft.modelId, fallbackAccountId: undefined } // the harness's usual login
    const engine = usable.find((e) => e !== main) ?? usable[0]
    return { fallbackModelId: MODELS.find((m) => m.engine === engine)?.id ?? draft.modelId, fallbackAccountId: undefined }
  }
  const reserve = draft.fallbackModelId ? modelInfo(draft.fallbackModelId) : undefined
  const reserveAccounts = accounts.filter((a) => a.engine === reserve?.engine)
  const reserveAccount = reserveAccounts.find((a) => a.id === draft.fallbackAccountId)
  const sameLogin = !!reserve && reserve.engine === main && reserveAccount?.id === mainAccount?.id
  return (
    <div className="reserve">
      <div className="key-row">
        <Icon name="layers" />
        <div className="grow">
          <strong>{L('Modelo reserva', 'Reserve model')}</strong>
          <p className="muted small">
            {L(
              `Quando a assinatura do modelo principal chega no limite (o de 5 horas ou o semanal), a resposta segue no reserva, que pode estar em outro programa (Claude Code, Codex…) ou em outra conta. Na resposta seguinte, ${draft.name || 'o agente'} tenta o principal de novo.`,
              `When the main model’s subscription hits its limit (the 5-hour or the weekly one), the reply goes on with the reserve, which can be in another program (Claude Code, Codex…) or another account. On the next reply, ${draft.name || 'the agent'} tries the main one again.`
            )}
          </p>
        </div>
        <Toggle on={on} onChange={(v) => patch(v ? first() : { fallbackModelId: undefined, fallbackAccountId: undefined })} />
      </div>
      {on && (
        <ModelPicker
          value={draft.fallbackModelId!}
          onChange={(fallbackModelId) => patch({ fallbackModelId, ...(modelInfo(fallbackModelId)?.engine !== reserve?.engine ? { fallbackAccountId: undefined } : {}) })}
        />
      )}
      {on && reserve && reserveAccounts.length > 0 && (
        <label className="field">
          <span className="field__label">{L('Conta da reserva', 'Reserve account')}</span>
          <Select
            value={reserveAccount?.id ?? null}
            onChange={(v) => patch({ fallbackAccountId: v || undefined })}
            options={[
              { value: '', label: L(`A de sempre do ${ENGINES[reserve.engine].label}`, `${ENGINES[reserve.engine].label}’s usual one`) },
              ...reserveAccounts.map((a) => ({ value: a.id, label: a.name + (a.loggedIn ? '' : L(' (falta entrar)', ' (not signed in)')) }))
            ]}
            placeholder={L(`A de sempre do ${ENGINES[reserve.engine].label}`, `${ENGINES[reserve.engine].label}’s usual one`)}
          />
          {reserveAccount && !reserveAccount.loggedIn && <span className="hint hint--warn">{L('Essa conta ainda não entrou: a reserva só funciona depois que você entrar nela em Configurações › Modelos.', 'This account isn’t signed in yet: the reserve only works once you sign in under Settings › Models.')}</span>}
        </label>
      )}
      {on && sameLogin && (
        <p className="hint hint--warn">
          {draft.fallbackModelId === draft.modelId
            ? L('É o mesmo modelo, na mesma conta do principal: a reserva não vai ser usada.', 'It’s the same model, on the same account as the main one: the reserve won’t be used.')
            : L('É o mesmo programa, na mesma conta do principal: se o limite for da assinatura, ele também vai estar sem.', 'It’s the same program, on the same account as the main one: if the limit is the subscription’s, it’ll be out too.')}
          {reserveAccounts.length > 0 ? L(' Escolha outra conta em “Conta da reserva”.', ' Pick another one under “Reserve account”.') : ''}
        </p>
      )}
    </div>
  )
}

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
// The team as a file, and backups of everything.
const MAX_UPLOAD = 40_000_000 // a browser's request has a cap (64 MB) and base64 grows a third
function TeamCard(): ReactNode {
  const [note, setNote] = useState('')
  const settings = useStore((s) => s.settings)
  // Grok Bot has no export: one of the person's agents there runs this skill and writes our .zip.
  const grokSkill = (): void => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([exportSkill], { type: 'text/markdown' }))
    a.download = 'SKILL.md'
    a.click()
    URL.revokeObjectURL(a.href)
    setNote(
      L(
        'Baixei o SKILL.md. No Grok Bot, dê a skill a um dos seus agentes (ou cole o texto numa conversa com ele) e peça: "Exporte meus agentes pro Tucano". Ele te devolve um .zip, que você abre em "Importar de outro app…". É experimental: ainda não foi testada dentro do Grok Bot, então confira o resumo da importação.',
        'I downloaded SKILL.md. In Grok Bot, give the skill to one of your agents (or paste its text in a chat with it) and ask: "Export my agents to Tucano". It gives you back a .zip, which you open with "Import from another app…". It\'s experimental: it hasn\'t been tried inside Grok Bot yet, so check the import summary.'
      )
    )
  }
  const download = (): void => {
    setNote('')
    exportTeam().then((md) => {
      const safe = workspaceLabel(settings)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'workspace'
      const file = `${L('time-tucano', 'tucano-team')}-${safe}-${new Date().toISOString().slice(0, 10)}.md`
      const a = document.createElement('a')
      a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }))
      a.download = file
      a.click()
      URL.revokeObjectURL(a.href)
      setNote(L(`Exportação feita: ${file}.`, `Exported: ${file}.`))
    }).catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)))
  }
  const failed = (e: unknown): void => setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
  const upload = (file?: File): void => {
    if (!file) return
    void file.text().then(importTeam).then(setNote, failed)
  }
  // Another app's export: on the desktop the core reads the file where it is; in a browser it goes up whole.
  const fromApp = (file?: File): void => {
    if (!file) return
    setNote(L('Lendo o arquivo…', 'Reading the file…'))
    const path = window.tucano.pathOf?.(file)
    if (path) return void importAgents({ path }).then(setNote, failed)
    if (file.size > MAX_UPLOAD) return setNote(L('Arquivo grande demais pra mandar pelo navegador. Importe no app do computador, ou exporte sem os arquivos.', 'File too big to send through the browser. Import it in the desktop app, or export without the files.'))
    void file
      .arrayBuffer()
      .then((b) => {
        const bytes = new Uint8Array(b)
        let bin = ''
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        return importAgents({ data: btoa(bin) })
      })
      .then(setNote, failed)
  }
  return (
    <Card title={L('Time', 'Team')} lead={L('O time num arquivo .md (agentes, skills, canais e rotinas, sem credenciais nem conversas), pra guardar ou levar pra outro computador. Os agentes do OpenBot e do Grok Bot também entram, sem nenhum conector e com a busca na web desligada.', 'The team in a .md file (agents, skills, channels and routines, without credentials or conversations), to keep or take to another computer. Agents from OpenBot and Grok Bot come in too, with no connector and web search off.')}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="btn btn--sm" onClick={download}>
          {L('Exportar time', 'Export team')}
        </button>
        <label className="btn btn--sm">
          {L('Importar time…', 'Import team…')}
          <input type="file" accept=".md,text/markdown" hidden onChange={(e) => upload(e.target.files?.[0])} />
        </label>
        <label
          className="btn btn--sm"
          title={L(
            'OpenBot: Configurações do servidor → Transfer → Export from this server, com os arquivos. Grok Bot: o .zip feito com a skill do Tucano.',
            "OpenBot: Server settings → Transfer → Export from this server, with the files. Grok Bot: the .zip made with Tucano's skill."
          )}
        >
          {L('Importar de outro app…', 'Import from another app…')}
          <input
            type="file"
            accept=".zip,application/zip"
            hidden
            onChange={(e) => {
              fromApp(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </label>
        <button
          className="btn btn--sm"
          onClick={grokSkill}
          title={L('Experimental: a skill que exporta seus agentes do Grok Bot pro Tucano. Ainda não foi testada dentro do Grok Bot.', "Experimental: the skill that exports your agents from Grok Bot to Tucano. It hasn't been tried inside Grok Bot yet.")}
        >
          {L('Skill pro Grok Bot (experimental)', 'Skill for Grok Bot (experimental)')}
        </button>
      </div>
      {note && <p className="small muted" style={{ whiteSpace: 'pre-line' }}>{note}</p>}
    </Card>
  )
}

// A whole Tucano, taken somewhere else: the desktop app exports it in one .zip, and a Tucano on a
// server (its owner) restores it, replacing what's there (src/core/restore.ts).
export function BackupCard(): ReactNode {
  const owner = useStore(amOwner)
  const web = windowless()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [found, setFound] = useState<BackupSummary | null>(null)
  const [info, setInfo] = useState<{ at: number; routines: number } | null>(null)
  useEffect(() => {
    if (web && owner) void restoreInfo().then(setInfo).catch(() => {})
  }, [web, owner])
  if (!owner) return null
  const failed = (e: unknown): void => setNote(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
  const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const what = (s: BackupSummary): string =>
    L(
      `${n(s.agents, 'agente', 'agentes')}, ${n(s.channels, 'canal', 'canais')}, ${n(s.messages, 'mensagem', 'mensagens')}, ${n(s.memories, 'memória', 'memórias')}, ${n(s.wikiPages, 'página da wiki', 'páginas da wiki')} e ${n(s.files, 'arquivo', 'arquivos')}`,
      `${n(s.agents, 'agent', 'agents')}, ${n(s.channels, 'channel', 'channels')}, ${n(s.messages, 'message', 'messages')}, ${n(s.memories, 'memory', 'memories')}, ${n(s.wikiPages, 'wiki page', 'wiki pages')} and ${n(s.files, 'file', 'files')}`
    )
  const day = (at: number): string => new Date(at).toLocaleDateString(L('pt-BR', 'en'))
  const exportAll = (): void => {
    setBusy(true)
    setNote(L('Preparando o arquivo…', 'Preparing the file…'))
    exportBackup()
      .then((r) => {
        const name = r.path.split(/[\\/]/).pop() ?? r.path
        const left = r.filesLeftOut ? L(` ${r.filesLeftOut === 1 ? '1 arquivo dos agentes ficou' : `${r.filesLeftOut} arquivos dos agentes ficaram`} de fora pra caber num envio só.`, ` ${r.filesLeftOut === 1 ? '1 of the agents’ files was' : `${r.filesLeftOut} of the agents' files were`} left out to fit in one upload.`) : ''
        setNote(
          L(
            `Pronto: ${name}, em Downloads, com ${what(r)}.${left} No Tucano do servidor, abra Configurações › Geral › Restaurar um backup e escolha esse arquivo.`,
            `Done: ${name}, in Downloads, with ${what(r)}.${left} On the server's Tucano, open Settings › General › Restore a backup and pick that file.`
          )
        )
      })
      .catch(failed)
      .finally(() => setBusy(false))
  }
  const pick = (file?: File): void => {
    const upload = window.tucano.upload
    if (!file || !upload) return
    setFound(null)
    setBusy(true)
    setNote(L(`Enviando ${file.name} (${Math.max(1, Math.round(file.size / 1e6))} MB)…`, `Sending ${file.name} (${Math.max(1, Math.round(file.size / 1e6))} MB)…`))
    upload(file)
      .then((path) => restoreCheck(path))
      .then((s) => {
        setFound(s)
        setNote('')
      })
      .catch(failed)
      .finally(() => setBusy(false))
  }
  // The server restarts with the backup; the page comes back once it answers again.
  const back = (): void => {
    void fetch('./', { cache: 'no-store' })
      .then((r) => (r.ok ? location.reload() : setTimeout(back, 2000)))
      .catch(() => setTimeout(back, 2000))
  }
  const apply = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: L('Trocar tudo por este backup?', 'Replace everything with this backup?'),
      body: L(
        'Os agentes, conversas, memórias, a wiki e os arquivos deste Tucano dão lugar aos do backup. O que está aqui agora fica guardado no servidor, mas só volta com ajuda do suporte. Você continua conectado.',
        "This Tucano's agents, conversations, memories, wiki and files give way to the backup's. What's here now is kept on the server, but only comes back with support's help. You stay signed in."
      ),
      confirm: L('Restaurar', 'Restore'),
      danger: true
    })
    if (!ok) return
    setBusy(true)
    try {
      await restoreApply()
      setNote(L('Restaurando… o Tucano reinicia, e esta página volta sozinha em alguns segundos.', 'Restoring… Tucano restarts, and this page comes back on its own in a few seconds.'))
      setTimeout(back, 4000)
    } catch (e) {
      failed(e)
      setBusy(false)
    }
  }
  return (
    <Card
      title={L('Backup completo', 'Full backup')}
      lead={
        web
          ? L(
              'Trouxe o Tucano do seu computador? No app do computador, use Exportar tudo (Configurações › Geral) e envie o arquivo aqui: agentes, conversas, memórias, wiki e arquivos substituem os deste Tucano. Um backup diário (.db, da pasta de backups) também serve, só com o banco.',
              "Bringing the Tucano from your computer? In the desktop app, use Export everything (Settings › General) and send the file here: agents, conversations, memories, wiki and files replace this Tucano's. A daily backup (.db, from the backups folder) works too, with the database only."
            )
          : L(
              'Tudo deste Tucano num arquivo .zip: agentes, conversas, memórias, wiki e arquivos, pra levar pra um Tucano num servidor (como o Tucano Pro). As senhas dos conectores e os logins de IA não vão: eles ficam presos a este computador.',
              "Everything of this Tucano in one .zip: agents, conversations, memories, wiki and files, to take to a Tucano on a server (such as Tucano Pro). Connector passwords and AI logins don't go: they're tied to this computer."
            )
      }
    >
      {web && info && (
        <p className="small" style={{ whiteSpace: 'pre-line' }}>
          {L(
            `Backup restaurado em ${new Date(info.at).toLocaleString('pt-BR')}. Falta:\n• conferir se a sua IA está conectada aqui (Configurações › Modelos)\n• reconectar os conectores (Conectores)${info.routines ? `\n• ligar as rotinas que quiser aqui (${info.routines} chegaram desligadas, pra não rodarem em dobro com o computador)` : ''}`,
            `Backup restored on ${new Date(info.at).toLocaleString('en')}. Left to do:\n• check that your AI is signed in here (Settings › Models)\n• reconnect the connectors (Connectors)${info.routines ? `\n• turn on the routines you want here (${info.routines} came in off, so they don't run twice with your computer)` : ''}`
          )}
        </p>
      )}
      {!web && (
        <div className="row">
          <button className="btn btn--sm" disabled={busy} onClick={exportAll}>
            {L('Exportar tudo', 'Export everything')}
          </button>
        </div>
      )}
      {web && window.tucano.upload && !found && (
        <div className="row">
          <label className="btn btn--sm">
            {L('Restaurar um backup…', 'Restore a backup…')}
            <input
              type="file"
              accept=".zip,.db,application/zip"
              hidden
              disabled={busy}
              onChange={(e) => {
                pick(e.target.files?.[0])
                e.target.value = ''
              }}
            />
          </label>
        </div>
      )}
      {found && (
        <>
          <p className="small">
            {L(
              `Esse backup${found.workspace ? ` (“${found.workspace}”` : ' ('}${found.app ? `, Tucano ${found.app}` : ''}, de ${day(found.madeAt)}) tem ${what(found)}.`,
              `This backup${found.workspace ? ` (“${found.workspace}”` : ' ('}${found.app ? `, Tucano ${found.app}` : ''}, from ${day(found.madeAt)}) has ${what(found)}.`
            )}
          </p>
          <div className="row">
            <button className="btn btn--sm btn--danger" disabled={busy} onClick={() => void apply()}>
              {L('Restaurar este backup', 'Restore this backup')}
            </button>
            <button
              className="btn btn--sm btn--ghost"
              disabled={busy}
              onClick={() => {
                setFound(null)
                void restoreCancel()
              }}
            >
              {L('Cancelar', 'Cancel')}
            </button>
          </div>
        </>
      )}
      {note && <p className="small muted" style={{ whiteSpace: 'pre-line' }}>{note}</p>}
    </Card>
  )
}

function WorkspaceDangerArea(): ReactNode {
  const name = useStore((s) => workspaceLabel(s.settings))
  const defaultWorkspace = useStore((s) => s.defaultWorkspace)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const remove = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try { await window.tucano.workspaces?.delete() }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <section className="workspace-danger" aria-label={L('Área de perigo', 'Danger area')}>
    <Card title={L('Área de perigo', 'Danger area')}>
      <div className="workspace-danger__section">
        <h3>{L('Backups', 'Backups')}</h3>
        <p className="small muted">{L('Faça uma cópia antes de apagar dados. O backup automático guarda as últimas 7 cópias diárias.', 'Make a copy before deleting data. Automatic backup keeps the last 7 daily copies.')}</p>
        <div className="row">
          <button className="btn btn--sm" disabled={busy} onClick={() => { backupNow().then((file) => setNote(L(`Backup feito: ${file.split('/').pop()}`, `Backup done: ${file.split('/').pop()}`))).catch((e: unknown) => setError(String(e))) }}>{L('Fazer backup agora', 'Back up now')}</button>
          <button className="btn btn--sm btn--ghost" onClick={openBackups}>{L('Abrir pasta', 'Open folder')}</button>
        </div>
        {note && <p className="small muted">{note}</p>}
      </div>
      {window.tucano.workspaces && <div className="workspace-danger__section">
        <h3>{L('Excluir workspace', 'Delete workspace')}</h3>
        <p className="small muted">{defaultWorkspace ? L('O workspace padrão não pode ser excluído. Você ainda pode fazer backup ou duplicá-lo.', 'The default workspace cannot be deleted. You can still back it up or duplicate it.') : L(`Excluir “${name}” apaga também seus backups locais, agentes, conversas, memórias, credenciais e rotinas. Copie o backup para fora deste workspace antes. Os outros workspaces e suas pastas de projetos ficam intactos.`, `Deleting “${name}” also deletes its local backups, agents, conversations, memories, credentials and routines. Copy your backup outside this workspace first. Other workspaces and project folders are kept.`)}</p>
        <button className="btn btn--danger btn--sm" disabled={busy || defaultWorkspace} onClick={() => void remove()}>{busy ? L('Aguarde…', 'Please wait…') : L('Excluir workspace e todos os dados', 'Delete workspace and all data')}</button>
      </div>}
      {error && <p className="field__error" role="alert">{error}</p>}
    </Card>
  </section>
}

function WorkspaceTelegramNotice(): ReactNode {
  const { list, error: loadError } = useWorkspaceList()
  const workspace = list?.workspaces.find((w) => w.isDefault)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const switchWorkspace = async (): Promise<void> => {
    if (!workspace || !window.tucano.workspaces) return
    setBusy(true)
    setError('')
    try { await window.tucano.workspaces.switch(workspace.id) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  return <Card title="Telegram" lead={L('O bot do Telegram fica no workspace padrão. Dois workspaces não podem consultar o mesmo token.', 'The Telegram bot stays in the default workspace. Two workspaces cannot poll the same token.')}>
    {workspace ? <p className="muted small">
      {L('Para configurar o Telegram, abra o workspace ', 'To configure Telegram, open workspace ')}
      <button className="link" disabled={busy} title={L(`Trocar para ${workspace.name}`, `Switch to ${workspace.name}`)} onClick={() => void switchWorkspace()}>{workspace.name}</button>.
    </p> : !loadError && <p className="muted small">{L('Carregando o workspace padrão…', 'Loading the default workspace…')}</p>}
    {(error || loadError) && <p className="field__error" role="alert">{error || loadError}</p>}
  </Card>
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
            {L('Desconectar este chat', 'Disconnect this chat')}
          </button>
          <button className="btn btn--sm btn--ghost" onClick={() => save(null)}>
            {L('Remover bot', 'Remove bot')}
          </button>
        </div>
      )}
      {error ? (
        <p className="note note--error">{error}</p>
      ) : (
        info?.error && (
          <div className="note note--error">
            <p>{L('O Telegram não respondeu. Confira a internet ou troque o token do bot.', 'Telegram didn’t respond. Check the internet connection or change the bot token.')}</p>
            <p className="small muted mono">{info.error}</p>
          </div>
        )
      )}
      <p className="hint">
        <Icon name="shield" size={13} /> {L('O Telegram recebe o texto das aprovações e perguntas (ferramenta, argumentos, motivo) e as respostas das rotinas. O token fica no cofre do sistema. Uma ação de alto risco pede dois toques.', 'Telegram receives the text of approvals and questions (tool, arguments, reason) and the routines’ replies. The token stays in the system’s vault. A high-risk action takes two taps.')}
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

function VoiceCard(): ReactNode {
  const voice = useStore((s) => s.settings.voice)
  const status = useVoice()
  const [error, setError] = useState('')
  const save = (patch: VoiceSettings): void => {
    const next = { ...voice, ...patch }
    const why = voiceRefusal(next)
    setError(why ?? '')
    if (!why) updateSettings({ voice: next })
  }
  const choice = (id: VoiceModelId) => VOICE_CHOICES().find((c) => c.id === id)!
  const other = status?.ownModel === 'recommended' ? 'light' : 'recommended'
  return (
    <Card title={L('Ditado', 'Dictation')} lead={L('Fale em vez de digitar: clique no microfone do campo de mensagem, ou ⌥ Espaço no Mac e Ctrl+Espaço nos outros, e clique de novo para terminar. O áudio vira texto neste computador, sem internet, e o texto fica no campo para você revisar antes de enviar.', 'Speak instead of typing: click the microphone in the message field, or ⌥ Space on a Mac and Ctrl+Space elsewhere, and click again to finish. The audio becomes text on this computer, offline, and the text stays in the field for you to review before sending.')}>
      {status && !status.ready && <VoiceSetup status={status} />}
      <div className="voice-prefs">
        {status?.ready && (
          <div className="voice-on">
            <p className="small">
              <Icon name="check" size={13} />{' '}
              {status.ownModel
                ? L(`Ativado, com o modelo ${choice(status.ownModel).name} (${choice(status.ownModel).size}).`, `On, with the ${choice(status.ownModel).name} model (${choice(status.ownModel).size}).`)
                : L(`Ativado, com o modelo que já estava instalado: ${status.model?.split(/[\\/]/).pop()}.`, `On, with the model already installed: ${status.model?.split(/[\\/]/).pop()}.`)}
            </p>
            {status.downloading ? (
              <VoiceSetup status={status} />
            ) : (
              status.ownModel && (
                <div className="row">
                  <button className="btn btn--sm" onClick={() => void voiceDownload(other)}>
                    {L(`Trocar pelo ${choice(other).name} (${choice(other).size})`, `Switch to ${choice(other).name} (${choice(other).size})`)}
                  </button>
                  <button className="btn btn--ghost btn--sm" onClick={() => void voiceRemoveModel(status.ownModel!)}>
                    {L('Remover o modelo', 'Remove the model')}
                  </button>
                </div>
              )
            )}
            {status.error && <p className="field__error">{status.error}</p>}
          </div>
        )}
        <label className="row row--center small">
          <input type="checkbox" checked={!voice?.hidden} onChange={(e) => save({ hidden: !e.target.checked })} />
          {L('Mostrar o microfone no campo de mensagem', 'Show the microphone in the message field')}
        </label>
        <details className="voice-advanced">
          <summary className="small muted">{L('Avançado', 'Advanced')}</summary>
          <label className="row row--center small">
            <input type="checkbox" checked={!!voice?.detect} onChange={(e) => save({ detect: e.target.checked })} />
            {L('Detectar o idioma, em vez de usar o do app', 'Detect the language, instead of using the app’s')}
          </label>
          <Field label={L('Caminho do whisper-cli', 'Path to whisper-cli')} hint={status?.bin && !voice?.bin ? L(`Em uso: ${status.bin}`, `In use: ${status.bin}`) : L('Opcional: sem isso, o app usa o que veio com ele.', 'Optional: without it, the app uses the one it came with.')}>
            <input defaultValue={voice?.bin ?? ''} placeholder="/opt/homebrew/bin/whisper-cli" onBlur={(e) => save({ bin: e.target.value.trim() || undefined })} />
          </Field>
          <Field label={L('Caminho do modelo', 'Path to the model')} hint={status?.model && !voice?.model ? L(`Em uso: ${status.model}`, `In use: ${status.model}`) : L('Opcional: um modelo ggml (.bin) que você já tenha.', 'Optional: a ggml model (.bin) you already have.')} error={error}>
            <input defaultValue={voice?.model ?? ''} placeholder="/caminho/para/ggml-large-v3-turbo.bin" onBlur={(e) => save({ model: e.target.value.trim() || undefined })} />
          </Field>
        </details>
      </div>
    </Card>
  )
}

export function SettingsPage(): ReactNode {
  const settings = useStore((s) => s.settings)
  const packaged = useStore((s) => s.packaged)
  const defaultWorkspace = useStore((s) => s.defaultWorkspace)
  // At work, Jev and Telegram stay: the person decides, told what leaves the gateway.
  const work = onGateway(settings)
  const team = useStore(teamMode)
  const admin = useStore(amAdmin)
  const owner = useStore(amOwner)
  const tabs = SETTINGS_TABS(team, admin, owner)
  const tab = useTab('settings', tabs)
  const pane = (t: string): boolean => tab === t
  return (
    <Page title={L('Configurações', 'Settings')}>
      <Tabs page="settings" tabs={tabs} />
      <div className="agent-form">
        {pane('pessoas') && <PeoplePane />}
        {pane('atividade') && admin && <ActivityPane />}
        {/* A member's own: the language, the theme and the sounds (their name is in Pessoas). */}
        {pane('geral') && !admin && (
          <Card title={L('Pra você', 'Yours')} lead={L('Como o Tucano aparece pra você. Muda só pra você.', 'How Tucano looks to you. It changes only for you.')}>
            <div className="field">
              <span className="field__label">Idioma · Language</span>
              <LanguagePicker />
              <span className="hint">{L('O idioma do app pra você. Os agentes respondem no idioma do Tucano.', 'The app’s language for you. The agents reply in the Tucano’s language.')}</span>
            </div>
            <div className="field">
              <span className="field__label">{L('Tema', 'Theme')}</span>
              <div className="segmented" role="radiogroup" aria-label={L('Tema', 'Theme')}>
                {(['system', 'light', 'dark'] as const).map((t) => (
                  <button key={t} type="button" role="radio" aria-checked={settings.theme === t} className={settings.theme === t ? 'is-active' : ''} onClick={() => updateSettings({ theme: t })}>
                    {t === 'system' ? L('Do sistema', 'System') : t === 'light' ? L('Claro', 'Light') : L('Escuro', 'Dark')}
                  </button>
                ))}
              </div>
            </div>
            <AdminOnly>{L('Só um admin muda os modelos, os agentes, o contexto e as outras configurações do Tucano.', 'Only an admin changes the models, the agents, the context and the Tucano’s other settings.')}</AdminOnly>
          </Card>
        )}
        {pane('geral') && admin && (
          <Card title="Workspace">
            <p className="muted small">{L('Agentes, conversas, conectores e memórias ficam neste workspace. Os logins do Claude Code e OpenCode continuam compartilhados no computador. Um workspace não é uma sandbox do sistema.', 'Agents, conversations, connectors and memories stay in this workspace. Claude Code and OpenCode sign-ins are still shared on this computer. A workspace is not an OS sandbox.')}</p>
            {window.tucano.workspaces && (
              <Field label={L('Nome do workspace', 'Workspace name')}>
                <input value={settings.workspaceLabel ?? ''} placeholder={settings.workspaceName} maxLength={120} onChange={(e) => updateSettings({ workspaceLabel: e.target.value })} />
              </Field>
            )}
            {owner && (
              <Field label={L('Como os agentes te chamam', 'What the agents call you')}>
                <input value={settings.workspaceName} onChange={(e) => updateSettings({ workspaceName: e.target.value })} />
              </Field>
            )}
            <div className="field">
              <span className="field__label">Idioma · Language</span>
              <LanguagePicker />
              <span className="hint">{L('O idioma do app e o que os agentes usam pra responder.', 'The app’s language, and the one the agents reply in.')}</span>
            </div>
            <Field label={L('Contexto', 'Context')} hint={L('Entra em toda conversa de todo agente: quem você é, o que faz, o que importa agora e o que nunca fazer.', 'Goes into every conversation of every agent: who you are, what you do, what matters now and what never to do.')}>
              <textarea rows={5} value={settings.context} onChange={(e) => updateSettings({ context: e.target.value })} />
            </Field>
            <div className="row">
              {/* What the person already set (the short sidebar, the tour) stays as it was. */}
              <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { ...settings.onboarding, done: false } })}>
                {L('Rever a introdução', 'See the introduction again')}
              </button>
              {settings.onboarding?.checklistHidden && (
                <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { ...settings.onboarding, done: true, checklistHidden: false } })}>
                  {L('Mostrar as missões', 'Show the missions')}
                </button>
              )}
              {settings.onboarding?.fresh && !settings.onboarding.showAll && (
                <button className="btn btn--sm" onClick={() => updateSettings({ onboarding: { ...settings.onboarding!, showAll: true } })}>
                  {L('Mostrar a barra lateral inteira', 'Show the whole sidebar')}
                </button>
              )}
            </div>
          </Card>
        )}

        {pane('geral') && admin && <VoiceCard />}

        {pane('geral') && (
          <Card title={L('Notificações', 'Notifications')}>
            <div className="key-row">
              <Icon name="volume" />
              <div className="grow">
                <strong>{L('Sons', 'Sounds')}</strong>
                <p className="muted small">{L('O toque quando um agente precisa de você e quando termina. Desligado, as notificações continuam aparecendo, em silêncio.', 'The chirp when an agent needs you and when it’s done. Off, notifications still show up, silently.')}</p>
              </div>
              <Toggle on={settings.sounds !== false} onChange={(v) => updateSettings({ sounds: v })} />
            </div>
            <NotifyTest />
          </Card>
        )}

        {pane('geral') && admin && (
          <Card title={L('Atualizações', 'Updates')}>
            <UpdateSettings />
          </Card>
        )}

        {pane('modelos') && admin && <AgentModelsPanel />}

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
          <Card
            title={L('Contas', 'Accounts')}
            lead={L(
              'Mais de um login do Claude Code ou do Codex, como a conta do trabalho e a pessoal. Cada agente escolhe a conta na página dele. O login acontece no próprio CLI: o Tucano não vê nem guarda a senha.',
              'More than one Claude Code or Codex login, like a work account and a personal one. Each agent picks its account on its page. You sign in through the CLI itself: Tucano never sees or stores the password.'
            )}
          >
            <AccountsCard />
          </Card>
        )}

        {pane('modelos') && (
          <Card title={L('Roteador', 'Router')} lead={L('Modelo pequeno que lê a conversa e decide quem responde nos canais. Não concede permissão nenhuma.', 'A small model that reads the conversation and decides who replies in channels. It grants no permissions at all.')}>
            <Field label={L('Modelo do roteador', 'Router model')} hint={L('Prefira um modelo rápido: ele roda antes de cada resposta num canal.', 'Go for a fast model: it runs before every reply in a channel.')}>
              <ModelSelect value={settings.routerModel} onChange={(routerModel) => updateSettings({ routerModel })} jev />
            </Field>
            {settings.routerModel === 'jev' && <JevKey saved={!!settings.jevKey} />}
            {settings.routerModel === 'jev' && work && <OutsideGateway what={L('cada mensagem sem @menção vai pra TypeSafe escolher quem responde.', 'every message without an @mention goes to TypeSafe to pick who replies.')} />}
          </Card>
        )}

        {pane('agentes') && (
          <Card
            title={L('Autonomia', 'Autonomy')}
            lead={L(
              'Pra todos os agentes: até onde eles vão sozinhos e o que pede sua aprovação antes, com um botão na conversa. Na página de cada agente dá pra mudar só pra ele. Ler e investigar nunca pede.',
              'For every agent: how far they go on their own and what asks for your approval first, with a button in the conversation. On each agent’s page you can change it for that agent only. Reading and looking into things never asks.'
            )}
          >
            <AutonomyControls own={{ autonomy: settings.autonomy, actionRules: settings.actionRules, outsideGuard: settings.outsideGuard }} onChange={(p) => updateSettings(p)} />
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

        {pane('agentes') && (
          <Card
            title={L('Jev como classificador', 'Jev as a classifier')}
            lead={L(
              'O Jev, do TypeSafe, lê um pedido e responde uma pergunta de múltipla escolha em menos de um segundo, com a probabilidade de cada opção. Aqui ele sugere qual opção de uma pergunta de agente você deve escolher, com um selo na opção.',
              "TypeSafe's Jev reads a request and answers a multiple-choice question in under a second, with each option's probability. Here it suggests which option of an agent's question you should pick, with a pill on the option."
            )}
          >
            <div className="key-row">
              <Icon name="spark" />
              <div className="grow">
                <strong>{L('Marcar a opção recomendada', 'Mark the recommended option')}</strong>
                <p className="muted small">
                  {L(
                    'Desligado por padrão. Ligado, cada pergunta de agente com duas ou mais opções vai pro TypeSafe com o texto e as opções, e volta com a sugestão. É só uma sugestão: quem escolhe continua sendo você, e "Outra coisa" nunca é sugerida.',
                    'Off by default. On, every agent question with two or more options goes to TypeSafe with its text and options, and comes back with a suggestion. It is only a suggestion: you still choose, and "Something else" is never suggested.'
                  )}
                </p>
              </div>
              <Toggle on={!!settings.jevRecommend} onChange={(v) => updateSettings({ jevRecommend: v })} />
            </div>
            <div className="key-row">
              <Icon name="spark" />
              <div className="grow">
                <strong>{L('Marcar só os próximos passos que importam', 'Tick only the next steps worth doing')}</strong>
                <p className="muted small">
                  {L(
                    'Desligado por padrão. Ligado, cada passo de um card de próximos passos vai pro TypeSafe com o que o agente disse antes, e só os que ele consideraria pra agora começam marcados; o resto espera no card, a um clique. Nunca deixa a lista vazia: se nenhum for marcado, todos ficam.',
                    'Off by default. On, every step of a next-steps card goes to TypeSafe with what the agent said before it, and only the ones it would do now start ticked; the rest waits in the card, one click away. It never empties the list: if none is picked, all of them stay ticked.'
                  )}
                </p>
              </div>
              <Toggle on={!!settings.jevNextSteps} onChange={(v) => updateSettings({ jevNextSteps: v })} />
            </div>
            {settings.jevRecommend && work && (
              <OutsideGateway what={L('cada pergunta de agente com opções, com o texto da pergunta e das opções, vai pro TypeSafe.', "every agent question with options, with the question's and the options' text, goes to TypeSafe.")} />
            )}
            {settings.jevRecommend && (
              <JevKey
                saved={!!settings.jevKey}
                hint={L(
                  'Sem a chave, o selo não aparece e a pergunta fica como está hoje: nenhuma opção marcada.',
                  'Without the key, the pill never shows and the question stays as it is today: no option marked.'
                )}
              />
            )}
          </Card>
        )}

        {pane('integracoes') && work && <OutsideGateway what={L('as aprovações, as perguntas dos agentes e o fim das rotinas vão pro seu Telegram, com o texto de cada uma.', 'approvals, the agents’ questions and routine results go to your Telegram, with the text of each.')} />}
        {pane('integracoes') && window.tucano.phone && <HomePhoneCard />}
        {pane('integracoes') && (defaultWorkspace ? <PhoneCard info={settings.telegram} /> : <WorkspaceTelegramNotice />)}

        {pane('modelos') && (
          <Card title={L('Memória', 'Memory')} lead={L('Um modelo pequeno resume o que sai da janela de cada conversa e, do mesmo trecho, tira o que vale lembrar sobre você.', 'A small model summarizes what leaves each conversation’s window and, from the same stretch, picks what’s worth remembering about you.')}>
            <div className="grid2">
              <Field label={L('Modelo da memória', 'Memory model')} hint={L('Roda a cada ~20 mensagens numa conversa longa.', 'Runs every ~20 messages in a long conversation.')}>
                <ModelSelect value={settings.memoryModel} onChange={(memoryModel) => updateSettings({ memoryModel })} />
              </Field>
              <Field label={L('O que ele aprende sobre você', 'What it learns about you')} hint={L('Só conta o que você disse, nunca o que um agente supôs.', 'Only what you said counts, never what an agent assumed.')}>
                <Select
                  value={settings.memoryLearning ?? null}
                  onChange={(v) => { if (v) updateSettings({ memoryLearning: v as typeof settings.memoryLearning }) }}
                  options={[
                    { value: 'approve', label: L('Vira sugestão pra você aprovar', 'A suggestion for you to approve') },
                    { value: 'auto', label: L('Grava sozinho', 'Saved on its own') },
                    { value: 'off', label: L('Nada (só resume)', 'Nothing (just summarizes)') }
                  ]}
                  placeholder={L('Escolha', 'Pick')}
                />
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
              <Toggle on={!!settings.openAtLogin && packaged && defaultWorkspace} onChange={(v) => packaged && defaultWorkspace && updateSettings({ openAtLogin: v })} />
            </div>
            {!defaultWorkspace && <p className="muted small">{L('Abrir ao ligar o computador é uma configuração do app: ajuste no workspace padrão. Todos os workspaces iniciam juntos.', 'Opening at login is an app setting: change it in the default workspace. All workspaces start together.')}</p>}
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


        {pane('geral') && admin && <TeamCard />}
        {pane('geral') && <BackupCard />}
        {pane('servidores') && <ServersCard />}

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
              <Field label={L('Limite por resposta (% do limite do mês)', 'Limit per reply (% of the monthly limit)')} hint={L('Chegou nele, o agente pausa e você decide se continua.', 'When it hits it, the agent pauses and you decide whether it continues.')}>
                <NumberInput
                  min={1}
                  max={100}
                  value={settings.runBudgetPct ?? RUN_BUDGET_PCT}
                  onChange={(n) => updateSettings({ runBudgetPct: Math.min(100, Math.max(1, Math.round(n))) })}
                />
              </Field>
              <Field label={L('Considerar travado após (min sem sinal)', 'Treat as stuck after (min with no sign)')} hint={L('Sem texto nem ferramenta terminando. Trabalho longo que anda não é cortado.', 'No text and no tool finishing. Long work that’s moving isn’t cut off.')}>
                <NumberInput
                  min={5}
                  value={settings.runStallMinutes ?? RUN_STALL_MINUTES}
                  onChange={(n) => updateSettings({ runStallMinutes: Math.max(5, Math.round(n)) })}
                />
              </Field>
              <Field label={L('Respostas seguidas entre agentes', 'Agent replies in a row')} hint={L('Quantas respostas os agentes podem dar em sequência, passando a vez entre si, antes de parar e esperar você. De 1 a 10.', 'How many replies agents can give in a row, passing the turn between them, before they stop and wait for you. From 1 to 10.')}>
                <NumberInput
                  min={1}
                  max={MAX_CHAIN_DEPTH}
                  value={chainDepthCap(settings.chainDepth)}
                  onChange={(n) => updateSettings({ chainDepth: chainDepthCap(n) })}
                />
              </Field>
              <Field label={L('Expiração de aprovações', 'Approvals expire after')}>
                <Select
                  value={settings.approvalTtlHours ? String(settings.approvalTtlHours) : null}
                  onChange={(v) => { if (v) updateSettings({ approvalTtlHours: Number(v) }) }}
                  options={[
                    { value: '1', label: L('1 hora', '1 hour') },
                    { value: '24', label: L('24 horas', '24 hours') },
                    { value: '168', label: L('7 dias', '7 days') }
                  ]}
                  placeholder={L('Escolha', 'Pick')}
                />
              </Field>
            </div>
          </Card>
        )}
        {pane('geral') && owner && <WorkspaceDangerArea />}
      </div>
    </Page>
  )
}

// Why notifications can't come here, or what to check when one was sent and didn't show.
export function notifyHint(state: NotifyState | 'shown', mac: boolean): string | null {
  const elsewhere = L(
    'Pra ser avisado, use o app do Tucano no computador (Configurações › Servidores), o app do iPhone ou o Telegram (Configurações › Celular).',
    'To be told, use the Tucano app on your computer (Settings › Servers), the iPhone app or Telegram (Settings › Phone).'
  )
  if (state === 'insecure') return L('O navegador não mostra notificações de um endereço sem HTTPS (como o do Tailscale, http://100.…). ', "Browsers don't show notifications from an address without HTTPS (like Tailscale's, http://100.…). ") + elsewhere
  if (state === 'blocked') return L('O navegador bloqueou as notificações deste endereço. Libere nas permissões do site e recarregue a página. ', 'The browser blocked notifications from this address. Allow them in the site’s permissions and reload the page. ') + elsewhere
  if (state === 'unsupported') return L('Aqui não dá pra mostrar notificações. ', "Notifications can't be shown here. ") + elsewhere
  if (state === 'shown')
    return mac
      ? L('Mandei uma. Se não apareceu, confira Ajustes do Sistema › Notificações › Tucano (permitir, e o estilo Faixas ou Alertas) e se um modo Foco está ligado.', 'Sent one. If it didn’t show, check System Settings › Notifications › Tucano (allowed, with Banners or Alerts) and whether a Focus is on.')
      : L('Mandei uma. Se não apareceu, confira as notificações do sistema e do navegador para o Tucano, e o modo Não perturbe.', 'Sent one. If it didn’t show, check the system’s and the browser’s notification settings for Tucano, and Do Not Disturb.')
  return null
}

function NotifyTest(): ReactNode {
  const [state, setState] = useState<NotifyState | 'shown' | null>(() => window.tucano.notifyState?.() ?? null)
  if (!window.tucano.testNotify) return null
  const hint = state ? notifyHint(state, /Mac/i.test(navigator.userAgent)) : null
  const off = state === 'insecure' || state === 'unsupported'
  return (
    <div className="key-row">
      <Icon name="send" />
      <div className="grow">
        <strong>{L('Testar', 'Test')}</strong>
        <p className="muted small">{hint ?? L('Manda uma notificação agora, pra ver se chega.', 'Sends a notification now, to see that it comes.')}</p>
      </div>
      {!off && (
        <button className="btn btn--sm" onClick={() => void window.tucano.testNotify?.().then(setState, () => setState('unsupported'))}>
          {L('Mandar uma', 'Send one')}
        </button>
      )}
    </div>
  )
}
