import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { ALL_PARTS, suggestWorkspaceCopyName, sortWorkspaces, WORKSPACE_PARTS, workspaceParts, type WorkspacePart, type WorkspaceParts } from '../../../shared/workspaces'
import { updateSettings, useStore } from '../store'
import { Modal } from './Modal'
import { Icon } from './ui'
import { useWorkspaceList } from './Workspaces'

const PARTS = (): Record<WorkspacePart, { label: string; about: string }> => ({
  general: { label: L('Configurações gerais', 'General settings'), about: L('Seu nome, o idioma, os modelos do roteador e da memória, limites, horário de silêncio e voz.', 'Your name, the language, the router and memory models, limits, quiet hours and voice.') },
  context: { label: L('Contexto', 'Context'), about: L('O texto que entra em toda conversa: quem você é, o que faz, o que importa.', 'The text that goes in every conversation: who you are, what you do, what matters.') },
  wiki: { label: L('Wiki', 'Wiki'), about: L('A mesma wiki, não uma cópia: o que um workspace guarda o outro lê. Sem ela, começa com uma wiki vazia.', 'The same wiki, not a copy: what one workspace keeps the other reads. Without it, it starts with an empty wiki.') },
  agents: { label: L('Agentes', 'Agents'), about: L('Instruções, modelos, computadores e pastas emprestadas, sem as memórias nem os arquivos.', 'Instructions, models, computers and lent folders, without their memories or files.') },
  channels: { label: L('Canais', 'Channels'), about: L('Nomes, temas e quem está em cada um, sem as mensagens.', 'Names, topics and who is in each, without the messages.') },
  skills: { label: L('Skills', 'Skills'), about: L('Sem os agentes, as de agentes específicos vêm arquivadas.', 'Without the agents, those of specific agents come archived.') },
  connectors: { label: L('Conectores e credenciais', 'Connectors and credentials'), about: L('Os conectores com suas chaves e logins, e o GitHub. Sem eles, os agentes vêm sem permissões.', 'The connectors with their keys and sign-ins, and GitHub. Without them, agents come with no grants.') },
  routines: { label: L('Rotinas', 'Routines'), about: L('As ligadas rodam aqui também, com endereços de gatilho novos. Vêm com os agentes.', 'Enabled ones run here too, with new trigger addresses. They come with the agents.') }
})

// Creating and duplicating are the same: a name, and what comes along from a workspace.
type Draft = { from: { id: string; name: string }; name: string; parts: WorkspaceParts; duplicate: boolean }

// `create`: opened from the switcher's +, straight to naming the new workspace.
export function WorkspaceManager({ onClose, create = false }: { onClose: () => void; create?: boolean }): ReactNode {
  const { list, error: loadError } = useWorkspaceList()
  const selectedId = list?.selected
  const workspaces = sortWorkspaces(list?.workspaces)
  const onboarding = useStore((s) => s.settings.onboarding)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.tucano.workspaces
  const available = list?.workspaces.filter((w) => w.status === 'ready') ?? []
  const allPaused = available.length > 0 && available.every((w) => w.paused)
  useEffect(() => {
    if (api && !onboarding?.workspaceManagerSeen) updateSettings({ onboarding: { ...(onboarding ?? { done: true }), workspaceManagerSeen: true } })
  }, [api, onboarding])
  const newDraft = (): Draft | null => {
    const here = list?.workspaces.find((w) => w.id === list.selected)
    return here ? { from: { id: here.id, name: here.name }, name: '', parts: workspaceParts({ general: true }), duplicate: false } : null
  }
  // From the switcher's +: the form as soon as the list says which workspace this is.
  useEffect(() => {
    if (create && list && !draft) setDraft(newDraft())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [create, list])
  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const back = (): void => { if (create) onClose(); else { setDraft(null); setError('') } }
  const close = (): void => { if (!busy) { if (draft) back(); else onClose() } }
  const save = (): Promise<void> => perform(async () => {
    if (!api || !draft || !draft.name.trim()) return
    if (!WORKSPACE_PARTS.some((p) => draft.parts[p])) return api.create(draft.name.trim())
    const id = await api.duplicate(draft.from.id, draft.name.trim(), draft.parts)
    await api.switch(id)
  })
  if (!api) return null
  if (create && !draft) return null // waiting for the list
  if (draft) {
    const info = PARTS()
    const nothing = !WORKSPACE_PARTS.some((p) => draft.parts[p])
    const pick = (p: WorkspacePart, on: boolean): void => setDraft({ ...draft, parts: workspaceParts({ ...draft.parts, [p]: on }) })
    const title = draft.duplicate ? L('Duplicar workspace', 'Duplicate workspace') : L('Criar workspace', 'Create Workspace')
    return <Modal key="draft" title={title} onClose={close} className="workspace-manager">
      <div className="workspace-manager__body">
        <label className="field">
          <span className="field__label">{L('Nome do workspace', 'Workspace name')}</span>
          <input autoFocus maxLength={120} disabled={busy} value={draft.name} placeholder={L('Ex.: Empresa, Pessoal', 'E.g. Company, Personal')} onChange={(event) => setDraft({ ...draft, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter' && !busy && draft.name.trim()) { event.preventDefault(); void save() } }} />
        </label>
        <div className="field">
          <span className="field__label">{L(`O que levar de “${draft.from.name}”?`, `What to bring from “${draft.from.name}”?`)}</span>
          <div className="workspace-manager__parts">
            {WORKSPACE_PARTS.map((p) => {
              const locked = p === 'routines' && !draft.parts.agents
              return <label key={p} className={`check workspace-manager__carry ${locked ? 'is-locked' : ''}`}>
                <input type="checkbox" checked={draft.parts[p]} disabled={busy || locked} onChange={(event) => pick(p, event.target.checked)} />
                <span>
                  <strong>{info[p].label}</strong>
                  <small className="muted">{info[p].about}</small>
                </span>
              </label>
            })}
          </div>
        </div>
        <p className="small muted">{nothing
          ? L('Sem nada marcado, começa vazio, com a introdução.', 'With nothing ticked, it starts empty, with the introduction.')
          : draft.parts.agents
            ? L('Com os agentes, um workspace já configurado pula a introdução.', 'With the agents, a set-up workspace skips the introduction.')
            : L('Sem os agentes, começa pela introdução, já com o que veio.', 'Without the agents, it starts with the introduction, from what came.')}</p>
        <p className="small muted">{L('Nunca vêm: mensagens, memórias, resumos, aprovações, histórico de uso, arquivos dos computadores, sessões do navegador e as contas extras do Claude Code, do Codex e do Grok (na cópia, os agentes usam o login padrão). O Telegram fica no workspace padrão. Mudanças aqui não alteram o original; pastas emprestadas continuam sendo as mesmas.', 'Never coming: messages, memories, summaries, approvals, usage history, computers’ files, browser sessions and the extra Claude Code, Codex and Grok accounts (in the copy, agents use the usual sign-in). Telegram stays in the default workspace. Changes here don’t change the original; lent folders are still the same ones.')}</p>
        {error && <p className="field__error" role="alert">{error}</p>}
      </div>
      <footer className="modal__foot">
        <button className="btn btn--ghost btn--sm" disabled={busy} onClick={back}>{L('Cancelar', 'Cancel')}</button>
        <button className="btn btn--primary btn--sm" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? L('Criando…', 'Creating…') : title}</button>
      </footer>
    </Modal>
  }
  return <Modal key="manager" title={L('Gerenciar workspaces', 'Manage workspaces')} onClose={close} className="workspace-manager" actions={
    <button className="btn btn--sm" disabled={busy || !available.length} title={allPaused ? L('Ativar todas as rotinas', 'Resume all routines') : L('Pausar todas as rotinas', 'Pause all routines')} aria-label={allPaused ? L('Ativar todas as rotinas', 'Resume all routines') : L('Pausar todas as rotinas', 'Pause all routines')} onClick={() => void perform(() => api.setPaused(!allPaused))}>
      <Icon name={allPaused ? 'play' : 'pause'} size={14} />{allPaused ? L('Retomar todos', 'Resume all') : L('Pausar todos', 'Pause all')}
    </button>
  }>
    <p className="muted small modal__lead">{L('Cada workspace tem seus próprios agentes, conversas, memórias e configurações.', 'Each workspace has its own agents, conversations, memories and settings.')}</p>
    <div className="workspace-manager__list">
      {!list && !loadError && <p className="muted small">{L('Carregando…', 'Loading…')}</p>}
      {workspaces.map((w) => {
        const selected = w.id === selectedId
        const switchTitle = selected ? L(`Workspace atual: ${w.name}`, `Current workspace: ${w.name}`) : L(`Trocar para ${w.name}`, `Switch to ${w.name}`)
        const duplicateTitle = L(`Duplicar ${w.name}`, `Duplicate ${w.name}`)
        const pauseTitle = w.paused ? L(`Retomar as rotinas de ${w.name}`, `Resume ${w.name}'s routines`) : L(`Pausar as rotinas de ${w.name}`, `Pause ${w.name}'s routines`)
        const deleteTitle = w.isDefault ? L('O workspace padrão não pode ser excluído.', 'The default workspace cannot be deleted.') : L(`Excluir ${w.name}`, `Delete ${w.name}`)
        return <div className="workspace-manager__row" key={w.id}>
          <div className="workspace-manager__name">
            <span>{w.name}</span>
            <span className="workspace-manager__id" title={w.id}>{w.id.slice(-7)}</span>
          </div>
          <div className="row">
            <button className="icon-btn workspace-manager__switch" disabled={busy || selected} aria-pressed={selected} title={switchTitle} aria-label={switchTitle} onClick={() => void perform(() => api.switch(w.id))}><Icon name="check" size={16} /></button>
            <button className="icon-btn workspace-manager__pause" disabled={busy || w.status !== 'ready'} aria-pressed={w.paused} title={pauseTitle} aria-label={pauseTitle} onClick={() => void perform(() => api.setPaused(!w.paused, w.id))}><Icon name={w.paused ? 'play' : 'pause'} size={16} /></button>
            <button className="icon-btn" disabled={busy || w.status !== 'ready'} title={duplicateTitle} aria-label={duplicateTitle} onClick={() => { setError(''); setDraft({ from: { id: w.id, name: w.name }, name: suggestWorkspaceCopyName(w.name, (list?.workspaces ?? []).map((workspace) => workspace.name)), parts: ALL_PARTS, duplicate: true }) }}><Icon name="copy" size={16} /></button>
            <button className="icon-btn workspace-manager__delete" disabled={busy || w.isDefault} title={deleteTitle} aria-label={deleteTitle} onClick={() => void perform(() => api.delete(w.id))}><Icon name="trash" size={16} /></button>
          </div>
        </div>
      })}
    </div>
    {(error || loadError) && <p className="field__error modal__lead" role="alert">{error || loadError}</p>}
    <footer className="modal__foot">
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={onClose}>{L('Fechar', 'Close')}</button>
      <button className="btn btn--primary btn--sm" disabled={busy || !list} onClick={() => { setError(''); setDraft(newDraft()) }}><Icon name="plus" size={14} />{L('Criar workspace', 'Create Workspace')}</button>
    </footer>
  </Modal>
}
