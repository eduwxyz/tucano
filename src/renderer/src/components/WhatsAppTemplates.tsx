// The approved templates of an official-API number: a list made to hold many. Each one is a single
// line (name, the start of its text, language, variables); its whole text opens on a click.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { WhatsAppStatus, WhatsAppTemplate } from '../../../shared/whatsapp'
import { call } from '../rpc'
import { Icon } from './ui'
import { errText } from './WhatsAppParts'

const SEARCH_FROM = 6 // fewer than this fit in a glance: no search field

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const keyOf = (t: WhatsAppTemplate): string => `${t.name}/${t.language}`

export function Templates({ numberId, status }: { numberId: string; status: WhatsAppStatus }): ReactNode {
  const [templates, setTemplates] = useState<WhatsAppTemplate[] | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState('')
  const seq = useRef(0)
  const load = async (): Promise<void> => {
    const mine = ++seq.current
    setError('')
    try {
      const list = await call('whatsappTemplates', { id: numberId })
      if (mine === seq.current) setTemplates(list)
    } catch (e) {
      if (mine === seq.current) setError(errText(e))
    }
  }
  useEffect(() => {
    void load()
  }, [numberId, status])

  const all = templates ?? []
  const needle = fold(q.trim())
  const shown = needle ? all.filter((t) => fold(`${t.name} ${t.body}`).includes(needle)) : all
  return (
    <div className="wa-templates">
      <div className="wa-templates__head">
        <div className="grow">
          <strong>
            {L('Mensagens modelo aprovadas', 'Approved templates')}
            {all.length > 0 && <span className="tag wa-templates__count">{all.length}</span>}
          </strong>
          <p className="muted small">{L('Com elas um agente começa uma conversa, ou escreve depois de um dia sem resposta.', 'With them an agent starts a conversation, or writes after a day with no answer.')}</p>
        </div>
        {all.length >= SEARCH_FROM && (
          <input className="wa-templates__search" type="search" value={q} placeholder={L('Buscar modelo', 'Search a template')} aria-label={L('Buscar modelo', 'Search a template')} onChange={(e) => setQ(e.target.value)} />
        )}
      </div>
      {error ? (
        <div className="note note--error">
          <p>{error}</p>
          <button className="btn btn--sm" onClick={() => void load()}>{L('Tentar de novo', 'Try again')}</button>
        </div>
      ) : templates === null ? (
        <p className="muted small"><span className="spinner wa-inline-spinner" />{L('Buscando na Meta…', 'Fetching from Meta…')}</p>
      ) : all.length === 0 ? (
        <p className="muted small">{L('Nenhum modelo aprovado ainda. Crie um no painel da Meta.', 'No approved template yet. Create one in Meta’s panel.')}</p>
      ) : shown.length === 0 ? (
        <p className="muted small">{L(`Nenhum modelo com “${q.trim()}”.`, `No template with “${q.trim()}”.`)}</p>
      ) : (
        <div className="table wa-templates__list">
          {shown.map((t) => {
            const key = keyOf(t)
            const on = open === key
            return (
              <div className={`wa-template ${on ? 'is-open' : ''}`} key={key}>
                <button type="button" className="wa-template__row" aria-expanded={on} onClick={() => setOpen(on ? '' : key)}>
                  <Icon name="chevron" size={14} />
                  <strong className="mono wa-template__name">{t.name}</strong>
                  <span className="muted small wa-template__preview">{on ? '' : t.body.replace(/\s+/g, ' ').trim()}</span>
                  <span className="tag">{t.language}</span>
                  {t.variables > 0 && <span className="tag">{t.variables === 1 ? L('1 variável', '1 variable') : L(`${t.variables} variáveis`, `${t.variables} variables`)}</span>}
                </button>
                {on && <div className="small wa-template__body">{t.body || L('Este modelo não tem texto.', 'This template has no text.')}</div>}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
