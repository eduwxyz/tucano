// Importing from Hermes Agent (spec §26): the core reads the Hermes folder where it is and says what
// would come in; nothing is added until the person picks the profiles and confirms.
import { useEffect, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { HermesPreview, HermesProfile } from '../../../shared/hermes-import'
import { hermesPreview, importHermes } from '../store'
import { Modal } from './Modal'

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))
const n = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

// What one profile brings, in one line: "instruções, 12 memórias, 3 sobre você, 5 skills, 2 rotinas".
function brings(p: HermesProfile): string {
  const parts = [
    p.instructions && L('instruções (SOUL.md)', 'instructions (SOUL.md)'),
    p.memories > 0 && L(n(p.memories, 'memória', 'memórias'), n(p.memories, 'memory', 'memories')),
    p.userMemories > 0 && L(`${n(p.userMemories, 'memória', 'memórias')} sobre você`, `${n(p.userMemories, 'memory', 'memories')} about you`),
    p.skills > 0 && n(p.skills, 'skill', 'skills'),
    p.routines > 0 && L(n(p.routines, 'rotina', 'rotinas'), n(p.routines, 'routine', 'routines'))
  ].filter((x): x is string => !!x)
  return parts.length ? parts.join(', ') : L('só o nome', 'just the name')
}

export function HermesImport({ onClose, onDone }: { onClose: () => void; onDone: (summary: string) => void }): ReactNode {
  const [preview, setPreview] = useState<HermesPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [chosen, setChosen] = useState<string[]>([])

  const read = (path?: string): void => {
    setBusy(true)
    setError('')
    hermesPreview(path)
      .then((p) => {
        setPreview(p)
        setChosen(p.profiles.map((x) => x.key))
      })
      .catch((e: unknown) => {
        setPreview(null)
        setError(message(e))
      })
      .finally(() => setBusy(false))
  }
  // First the usual folder ($HERMES_HOME or ~/.hermes): most people never need to pick one.
  useEffect(() => read(), [])

  const pick = (): void => {
    void window.tucano.pickFolder({ start: '.hermes', hidden: true }).then((path) => path && read(path))
  }
  const apply = (): void => {
    if (!preview || !chosen.length) return
    setBusy(true)
    importHermes(preview.path, chosen)
      .then((summary) => {
        onDone(summary)
        onClose()
      })
      .catch((e: unknown) => (setError(message(e)), setBusy(false)))
  }
  const flip = (key: string, on: boolean): void => setChosen((c) => (on ? [...c, key] : c.filter((k) => k !== key)))

  const many = (preview?.profiles.length ?? 0) > 1
  const names = preview
    ? [
        { label: L('Servidores MCP', 'MCP servers'), items: preview.servers },
        { label: L('Gateways', 'Gateways'), items: preview.gateways },
        { label: L('Modelo', 'Model'), items: preview.models }
      ].filter((g) => g.items.length)
    : []
  const leftOut = preview?.profiles.flatMap((p) => p.routinesAsNames.map((r) => L(`a rotina “${r}” (a agenda não cabe aqui)`, `the “${r}” routine (its schedule doesn't fit here)`))) ?? []

  return (
    <Modal title={L('Importar do Hermes', 'Import from Hermes')} onClose={onClose} className="hermes-import">
      <div className="hermes-import__where">
        <span className="small muted mono">{preview?.path ?? (busy ? L('Procurando a pasta do Hermes…', 'Looking for the Hermes folder…') : '')}</span>
        <button className="btn btn--ghost btn--sm" onClick={pick} disabled={busy}>
          {preview ? L('Outra pasta…', 'Another folder…') : L('Escolher pasta…', 'Choose folder…')}
        </button>
      </div>

      {error && <p className="hint hint--warn">{error}</p>}
      {!preview && !busy && !error && <p className="small muted">{L('Escolha a pasta do Hermes (normalmente ~/.hermes).', 'Choose the Hermes folder (usually ~/.hermes).')}</p>}

      {preview && (
        <div className="hermes-import__body">
          <section>
            <h4>{many ? L('Perfis: cada um vira um agente', 'Profiles: each one becomes an agent') : L('Vira um agente', 'Becomes an agent')}</h4>
            <div className="checks checks--skills">
              {preview.profiles.map((p) => (
                <label key={p.key} className="check check--skill">
                  {many && <input type="checkbox" checked={chosen.includes(p.key)} disabled={busy} onChange={(e) => flip(p.key, e.target.checked)} />}
                  <span>
                    <strong>{p.name}</strong>
                    {p.key !== 'default' && p.key !== p.name && <span className="tag">{p.key}</span>}
                    <span className="small skill__desc muted">{brings(p)}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <h4>{L('Como entra', 'How it comes in')}</h4>
            <ul className="small">
              <li>{L('Sem nenhum conector, sem busca na web e sem computador: você libera o que quiser depois.', 'No connectors, web search or computer are enabled. You can enable them later.')}</li>
              <li>{L('As memórias esperam você confirmar, em Memórias.', 'Memories wait for you to confirm them, in Memories.')}</li>
              <li>{L('As rotinas chegam desligadas.', 'Routines come in turned off.')}</li>
            </ul>
          </section>

          {names.length > 0 && (
            <section>
              <h4>{L('Fica só o nome, pra configurar aqui à mão', 'Names only; configure manually')}</h4>
              <dl className="hermes-import__names small">
                {names.map((g) => (
                  <div key={g.label}>
                    <dt className="muted">{g.label}</dt>
                    <dd>{g.items.join(', ')}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {(leftOut.length > 0 || preview.notes.length > 0) && (
            <section>
              <h4>{L('Fica de fora', 'Stays out')}</h4>
              <ul className="small muted">
                {[...leftOut, ...preview.notes].map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <footer className="modal__foot">
        <span className="small muted">{preview && many && !chosen.length ? L('Escolha pelo menos um perfil.', 'Choose at least one profile.') : ''}</span>
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {L('Cancelar', 'Cancel')}
        </button>
        <button className="btn btn--primary btn--sm" onClick={apply} disabled={!preview || !chosen.length || busy}>
          {chosen.length > 1 ? L(`Importar ${chosen.length} agentes`, `Import ${chosen.length} agents`) : L('Importar', 'Import')}
        </button>
      </footer>
    </Modal>
  )
}
