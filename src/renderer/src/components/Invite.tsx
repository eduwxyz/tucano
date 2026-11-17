// A new invite: role, what they do, and what they will see; then the link to send.
import { useState, type ReactNode } from 'react'
import { L } from '../../../shared/lang'
import { EVERYTHING } from '../../../shared/access'
import { createInvite, inviteLink, roleLabel, toast, type PersonAccess } from '../store'
import { Card, Field } from './Pages'
import { AccessChoice } from './PersonAccess'
import { Icon } from './ui'

export const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

export function CopyLink({ link }: { link: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = (): void =>
    void navigator.clipboard.writeText(link).then(
      () => (setCopied(true), setTimeout(() => setCopied(false), 1600)),
      () => toast(L('Não consegui copiar. Selecione o link e copie.', "I couldn't copy. Select the link and copy it."))
    )
  return (
    <div className="row invite-link">
      <input className="grow mono" readOnly value={link} onFocus={(e) => e.target.select()} aria-label={L('Link do convite', 'Invite link')} />
      <button className="btn btn--sm" onClick={copy}>
        <Icon name={copied ? 'check' : 'copy'} size={14} /> {copied ? L('Copiado', 'Copied') : L('Copiar link', 'Copy link')}
      </button>
    </div>
  )
}

export function InviteCard({ onClose, owner }: { onClose: () => void; owner: boolean }): ReactNode {
  const [role, setRoleChoice] = useState<'member' | 'admin'>('member')
  const [about, setAbout] = useState('')
  const [access, setAccess] = useState<PersonAccess>(EVERYTHING)
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const make = (): void =>
    void createInvite(role, about.trim(), undefined, role === 'member' && access.mode === 'picked' ? access : undefined).then(
      (r) => setLink(inviteLink(r.code)),
      (e: unknown) => setError(message(e))
    )
  return (
    <Card title={L('Convidar alguém', 'Invite someone')} lead={L('O link vale uma vez, por 7 dias. Quem usa entra com o próprio nome, no navegador ou no app.', 'The link works once, for 7 days. Whoever uses it comes in with their own name, in the browser or the app.')}>
      <div className="grid2">
        <Field label={L('Papel', 'Role')} hint={role === 'admin' ? L('Admins mexem em agentes, conectores, skills, configurações e pessoas.', 'Admins handle agents, connectors, skills, settings and people.') : L('Membros conversam, criam canais e rotinas pra si.', 'Members chat, create channels and their own routines.')}>
          <select value={role} disabled={!!link} onChange={(e) => setRoleChoice(e.target.value as 'member' | 'admin')}>
            <option value="member">{roleLabel('member')}</option>
            {owner && <option value="admin">{roleLabel('admin')}</option>}
          </select>
        </Field>
        <Field label={L('O que faz', 'What they do')} hint={L('Pros agentes saberem com quem falam. A pessoa pode mudar depois.', 'So the agents know who they talk to. They can change it later.')}>
          <input value={about} disabled={!!link} maxLength={200} placeholder={L('Ex.: cuida do financeiro', 'E.g. handles finance')} onChange={(e) => setAbout(e.target.value)} />
        </Field>
      </div>
      {!link && (
        <Field group label={L('O que a pessoa vê', 'What they see')}>
          {role === 'admin' ? <p className="muted small">{L('Admins sempre veem tudo.', 'Admins always see everything.')}</p> : <AccessChoice value={access} onChange={setAccess} />}
        </Field>
      )}
      {link ? (
        <Field label={L('Link do convite', 'Invite link')} hint={L('Mande por onde preferir. Ele some daqui quando você fechar: um novo convite gera outro link.', 'Send it however you like. It leaves this screen when you close it: a new invite makes another link.')}>
          <CopyLink link={link} />
        </Field>
      ) : null}
      {error && <p className="note note--error">{error}</p>}
      <div className="row row--end">
        <button className="btn btn--ghost btn--sm" onClick={onClose}>
          {link ? L('Fechar', 'Close') : L('Cancelar', 'Cancel')}
        </button>
        {!link && (
          <button className="btn btn--primary btn--sm" onClick={make}>
            {L('Criar convite', 'Create invite')}
          </button>
        )}
      </div>
    </Card>
  )
}
