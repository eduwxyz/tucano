import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { generalSettings, suggestWorkspaceCopyName, sortWorkspaces, workspaceLabel, type WorkspaceSummary } from '../../../shared/workspaces'
import { getState, updateSettings, useStore } from '../store'
import { Modal } from './Modal'
import { Icon } from './ui'
import { useWorkspaceList } from './Workspaces'

// `create`: opened from the switcher's +, straight to naming the new workspace.
export function WorkspaceManager({ onClose, create = false }: { onClose: () => void; create?: boolean }): ReactNode {
  const { list, error: loadError } = useWorkspaceList()
  const selectedId = list?.selected
  const workspaces = sortWorkspaces(list?.workspaces)
  const onboarding = useStore((s) => s.settings.onboarding)
  const [confirm, setConfirm] = useState<WorkspaceSummary | null>(null)
  const [copyName, setCopyName] = useState('')
  const [creating, setCreating] = useState(create)
  const [newName, setNewName] = useState('')
  const [carry, setCarry] = useState(true)
  const here = useStore((s) => workspaceLabel(s.settings))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const api = window.tucano.workspaces
  const available = list?.workspaces.filter((w) => w.status === 'ready') ?? []
  const allPaused = available.length > 0 && available.every((w) => w.paused)
  useEffect(() => {
    if (api && !onboarding?.workspaceManagerSeen) updateSettings({ onboarding: { ...(onboarding ?? { done: true }), workspaceManagerSeen: true } })
  }, [api, onboarding])
  const perform = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const back = (): void => { if (create) onClose(); else { setCreating(false); setError('') } }
  const close = (): void => { if (!busy) { if (confirm) setConfirm(null); else if (creating) back(); else onClose() } }
  const make = (): Promise<void> => perform(async () => {
    if (!api || !newName.trim()) return
    await api.create(newName.trim(), carry ? generalSettings(getState().settings) : undefined)
  })
  const duplicate = (): Promise<void> => perform(async () => {
    if (!api || !confirm || !copyName.trim()) return
    const id = await api.duplicate(confirm.id, copyName.trim())
    await api.switch(id)
  })
  if (!api) return null
  if (creating) return <Modal key="create" title={L('Criar workspace', 'Create Workspace')} onClose={close}>
    <div className="workspace-manager__body">
      <label className="field">
        <span className="field__label">{L('Nome do workspace', 'Workspace name')}</span>
        <input autoFocus maxLength={120} disabled={busy} value={newName} placeholder={L('Ex.: Empresa, Pessoal', 'E.g. Company, Personal')} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !busy && newName.trim()) { event.preventDefault(); void make() } }} />
      </label>
      <label className="check workspace-manager__carry">
        <input type="checkbox" checked={carry} disabled={busy} onChange={(event) => setCarry(event.target.checked)} />
        <span>
          <strong>{L(`Trazer as configurações gerais de “${here}”`, `Bring the general settings of “${here}”`)}</strong>
          <small className="muted">{L('Seu nome, o idioma, os modelos do roteador e da memória, limites, horário de silêncio e voz. A introdução começa deles.', 'Your name, the language, the router and memory models, limits, quiet hours and voice. The introduction starts from them.')}</small>
        </span>
      </label>
      <p className="small muted">{L('Começa vazio, com a introdução: agentes, conversas, conectores, credenciais e memórias dos outros workspaces não vêm junto. Para levar a configuração de um deles, use Duplicar.', 'It starts empty, with the introduction: agents, conversations, connectors, credentials and memories from other workspaces don’t come along. To take one’s setup, use Duplicate.')}</p>
      {error && <p className="field__error" role="alert">{error}</p>}
    </div>
    <footer className="modal__foot">
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={back}>{L('Cancelar', 'Cancel')}</button>
      <button className="btn btn--primary btn--sm" disabled={busy || !newName.trim()} onClick={() => void make()}>{busy ? L('Criando…', 'Creating…') : L('Criar workspace', 'Create Workspace')}</button>
    </footer>
  </Modal>
  if (confirm) return <Modal key="duplicate" title={L('Duplicar workspace', 'Duplicate workspace')} onClose={close}>
    <div className="workspace-manager__body">
      <p>{L(`Criar uma cópia independente de “${confirm.name}”?`, `Create an independent copy of “${confirm.name}”?`)}</p>
      <label className="field">
        <span className="field__label">{L('Nome do workspace', 'Workspace name')}</span>
        <input autoFocus maxLength={120} disabled={busy} value={copyName} onChange={(event) => setCopyName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !busy && copyName.trim()) { event.preventDefault(); void duplicate() } }} />
      </label>
      <p className="small muted">{L('Copia modelos, agentes, instruções, canais e membros, conectores e suas credenciais/permissões, skills, rotinas e configurações. Se o original já está configurado, a cópia pula a introdução; se não, ainda precisa concluir a configuração.', 'Copies models, agents, instructions, channels and members, connectors and their credentials/grants, skills, routines and settings. A configured workspace skips onboarding in the copy; an unfinished one still needs setup.')}</p>
      <p className="small muted">{L('Não leva mensagens, memórias, resumos, aprovações, histórico de uso, arquivos dos computadores ou sessões do navegador. As contas extras do Claude Code e do Codex ficam no original: na cópia, os agentes usam o login padrão. O Telegram continua apenas no workspace padrão. Conectores OAuth podem precisar de nova autorização.', 'Does not copy messages, memories, summaries, approvals, usage history, computer files or browser sessions. Extra Claude Code and Codex accounts stay in the original: in the copy, agents use the usual sign-in. Telegram stays in the default workspace only. OAuth connectors may need authorization again.')}</p>
      <p className="small muted">{L('Rotinas ativas continuam ativas na cópia e rodam separadamente. Os endereços dos gatilhos são novos. Mudanças na cópia não alteram o original; pastas externas emprestadas continuam apontando para os mesmos arquivos.', 'Enabled routines stay enabled in the copy and run independently. Webhook addresses are new. Changes in the copy do not change the original; lent external folders still point to the same files.')}</p>
      {error && <p className="field__error" role="alert">{error}</p>}
    </div>
    <footer className="modal__foot">
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => setConfirm(null)}>{L('Cancelar', 'Cancel')}</button>
      <button className="btn btn--primary btn--sm" disabled={busy || !copyName.trim()} onClick={() => void duplicate()}>{busy ? L('Duplicando…', 'Duplicating…') : L('Duplicar workspace', 'Duplicate workspace')}</button>
    </footer>
  </Modal>
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
            <button className="icon-btn" disabled={busy || w.status !== 'ready'} title={duplicateTitle} aria-label={duplicateTitle} onClick={() => { setError(''); setCopyName(suggestWorkspaceCopyName(w.name, (list?.workspaces ?? []).map((workspace) => workspace.name))); setConfirm(w) }}><Icon name="copy" size={16} /></button>
            <button className="icon-btn workspace-manager__delete" disabled={busy || w.isDefault} title={deleteTitle} aria-label={deleteTitle} onClick={() => void perform(() => api.delete(w.id))}><Icon name="trash" size={16} /></button>
          </div>
        </div>
      })}
    </div>
    {(error || loadError) && <p className="field__error modal__lead" role="alert">{error || loadError}</p>}
    <footer className="modal__foot">
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={onClose}>{L('Fechar', 'Close')}</button>
      <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => { setError(''); setNewName(''); setCreating(true) }}><Icon name="plus" size={14} />{L('Criar workspace', 'Create Workspace')}</button>
    </footer>
  </Modal>
}
