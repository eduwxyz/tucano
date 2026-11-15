// WhatsApp for agents, what an approval card says for each WhatsApp tool: a send (text, answer to a
// message, file, poll, template), a correction of a sent message, and a group change.
// `args` come from the core, but an old approval or another version may have other shapes: every
// field is read defensively and a card that can't be understood falls back to a plain sentence.
import type { ReactNode } from 'react'
import { L } from '../../../shared/lang'
import type { Approval } from '../../../shared/types'
import { Icon } from './ui'

type Args = Record<string, unknown>

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
const rec = (v: unknown): Args | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Args) : undefined)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strings = (v: unknown): string[] => list(v).map(str).filter(Boolean)

// "Always send in this conversation" only makes sense for a plain send to someone who already wrote.
// A correction, a group change, a first contact and anything marked high risk are decided one by one.
export function whatsappCanAlways(a: Approval): boolean {
  return a.tool === 'whatsapp_enviar' && rec(a.args)?.['primeiro_contato'] !== true && !a.highRisk
}

type Person = { name: string; phone: string }

// The people of a group change. A phone is shown only when the id really is one: other ids are
// internal and would look like a random number.
function peopleOf(v: unknown): Person[] {
  return list(v).flatMap((p): Person[] => {
    const o = rec(p)
    const raw = typeof p === 'string' ? p : str(o?.['id'])
    const digits = /^\d{6,15}(@s\.whatsapp\.net)?$/.test(raw) ? raw.replace(/\D/g, '') : ''
    const name = str(o?.['nome'])
    if (!name && !digits) return []
    return [{ name: name && name !== digits ? name : '', phone: digits ? `+${digits}` : '' }]
  })
}

const countText = (n: number): string => (n === 1 ? L('1 pessoa', '1 person') : L(`${n} pessoas`, `${n} people`))

// ---------- the title ----------

export function WhatsAppTitle({ approval, agent }: { approval: Approval; agent: string }): ReactNode {
  const a = rec(approval.args) ?? {}
  const number = str(a['numero'])
  const where = number ? ` (${number})` : ''
  const chat = str(a['conversa'])
  const who = chat ? <strong>{chat}</strong> : null

  if (approval.tool === 'whatsapp_corrigir') {
    return (
      <>
        {agent} {L('quer corrigir uma mensagem', 'wants to correct a message')} {who ? <>{L('em', 'in')} {who}</> : L('no WhatsApp', 'on WhatsApp')}
        {where}
      </>
    )
  }

  if (approval.tool === 'whatsapp_grupo') {
    const action = str(a['acao'])
    const group = str(a['grupo'])
    const name = str(a['nome'])
    const count = peopleOf(a['pessoas']).length
    const groupTag = group ? <strong>{group}</strong> : L('um grupo', 'a group')
    let sentence: ReactNode
    if (action === 'criar') sentence = name ? <>{L('quer criar o grupo', 'wants to create the group')} <strong>{name}</strong></> : L('quer criar um grupo', 'wants to create a group')
    else if (action === 'adicionar') sentence = <>{count ? L(`quer adicionar ${countText(count)} a`, `wants to add ${countText(count)} to`) : L('quer adicionar pessoas a', 'wants to add people to')} {groupTag}</>
    else if (action === 'remover') sentence = <>{count ? L(`quer remover ${countText(count)} de`, `wants to remove ${countText(count)} from`) : L('quer remover pessoas de', 'wants to remove people from')} {groupTag}</>
    else if (action === 'convite') sentence = <>{L('quer gerar o link de convite de', 'wants to make the invite link of')} {groupTag}</>
    else sentence = L('quer mudar um grupo no WhatsApp', 'wants to change a group on WhatsApp')
    return (
      <>
        {agent} {sentence}
        {where}
      </>
    )
  }

  if (approval.tool === 'whatsapp_enviar') {
    const kind = rec(a['enquete']) ? 'poll' : rec(a['arquivo']) ? 'file' : rec(a['responder_a']) ? 'reply' : 'text'
    const target = (words: ReactNode, noTarget: string): ReactNode =>
      who ? (
        <>
          {words} {who}
          {where}
        </>
      ) : (
        noTarget
      )
    return (
      <>
        {agent}{' '}
        {kind === 'poll'
          ? target(L('quer enviar uma enquete no WhatsApp para', 'wants to send a poll on WhatsApp to'), L('quer enviar uma enquete no WhatsApp', 'wants to send a poll on WhatsApp'))
          : kind === 'file'
            ? target(L('quer enviar um arquivo no WhatsApp para', 'wants to send a file on WhatsApp to'), L('quer enviar um arquivo no WhatsApp', 'wants to send a file on WhatsApp'))
            : kind === 'reply'
              ? target(L('quer responder a uma mensagem no WhatsApp, em', 'wants to answer a message on WhatsApp, in'), L('quer responder a uma mensagem no WhatsApp', 'wants to answer a message on WhatsApp'))
              : target(L('quer enviar no WhatsApp para', 'wants to send on WhatsApp to'), L('quer enviar uma mensagem no WhatsApp', 'wants to send a message on WhatsApp'))}
      </>
    )
  }

  return (
    <>
      {agent} {L('quer fazer algo no WhatsApp', 'wants to do something on WhatsApp')}
      {who ? <> {L('em', 'in')} {who}</> : null}
      {where}
    </>
  )
}

// ---------- the body ----------

function Plain(): ReactNode {
  return <p className="muted small wa-plain">{L('Não consegui mostrar os detalhes aqui. Confira o que o agente pediu antes de aprovar.', 'I couldn’t show the details here. Check what the agent asked before approving.')}</p>
}

function SendBody({ a }: { a: Args }): ReactNode {
  const text = str(a['texto'])
  const model = rec(a['modelo'])
  const values = strings(model?.['variaveis']).join(', ')
  const first = a['primeiro_contato'] === true
  const quote = str(rec(a['responder_a'])?.['texto'])
  const replying = rec(a['responder_a']) !== undefined
  const file = rec(a['arquivo'])
  const fileName = str(file?.['nome'])
  const poll = rec(a['enquete'])
  const question = str(poll?.['pergunta'])
  const options = strings(poll?.['opcoes'])
  const mentions = strings(a['mencionar'])
  const hasBody = Boolean(text || model || file || poll)
  return (
    <div className="wa-send">
      {first && (
        <p className="wa-send__first">
          <span className="tag tag--warn">{L('Primeiro contato', 'First contact')}</span>
          <span className="muted small">{L('Essa pessoa nunca escreveu para este número.', 'This person has never written to this number.')}</span>
        </p>
      )}
      {replying && (
        <div className="wa-quote">
          <span className="wa-quote__label">{L('Em resposta a', 'Answering')}</span>
          <span className="wa-quote__text">{quote || L('uma mensagem da conversa', 'a message in the conversation')}</span>
        </div>
      )}
      {hasBody ? (
        <div className="wa-bubble">
          {model ? (
            <>
              <strong>{L('Mensagem modelo', 'Template message')} “{str(model['nome'])}”</strong>
              {values && <div>{values}</div>}
            </>
          ) : poll ? (
            <>
              <span className="wa-poll__label"><Icon name="chart" size={13} />{poll['multipla'] === true ? L('Enquete · várias respostas', 'Poll · several answers') : L('Enquete · uma resposta', 'Poll · one answer')}</span>
              <strong className="wa-poll__q">{question || L('Enquete sem pergunta', 'Poll without a question')}</strong>
              {options.length > 0 && (
                <ul className="wa-poll__opts">
                  {options.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <>
              {file && (
                <span className="wa-file">
                  <Icon name="clip" size={14} />
                  <span className="wa-file__name">{fileName || L('Arquivo', 'File')}</span>
                </span>
              )}
              {text}
            </>
          )}
        </div>
      ) : (
        <Plain />
      )}
      {mentions.length > 0 && (
        <p className="wa-mentions">
          <span className="muted small">{L('Marca:', 'Tags:')}</span>
          {mentions.map((m, i) => (
            <span className="tag" key={i}>@{m.replace(/^@/, '')}</span>
          ))}
        </p>
      )}
    </div>
  )
}

function EditBody({ a }: { a: Args }): ReactNode {
  const before = str(a['texto_antigo'])
  const after = str(a['texto'])
  if (!after) return <Plain />
  return (
    <div className="wa-send wa-edit">
      {before && (
        <>
          <span className="wa-edit__label">{L('Estava assim', 'It said')}</span>
          <div className="wa-bubble wa-bubble--old">{before}</div>
        </>
      )}
      <span className="wa-edit__label">{L('Vai ficar assim', 'It will say')}</span>
      <div className="wa-bubble">{after}</div>
    </div>
  )
}

function GroupBody({ a }: { a: Args }): ReactNode {
  const action = str(a['acao'])
  const people = peopleOf(a['pessoas'])
  const name = str(a['nome'])
  if (!['criar', 'adicionar', 'remover', 'convite'].includes(action)) return <Plain />
  return (
    <div className="wa-send wa-group">
      {action === 'criar' && name && <p className="wa-group__line"><span className="muted small">{L('Nome do grupo', 'Group name')}</span> <strong>{name}</strong></p>}
      {action === 'convite' && <p className="muted small wa-group__line">{L('Quem receber o link consegue entrar no grupo.', 'Anyone who gets the link can join the group.')}</p>}
      {action !== 'convite' && people.length > 0 && (
        <>
          <span className="wa-edit__label">{action === 'remover' ? L('Quem sai', 'Who leaves') : action === 'adicionar' ? L('Quem entra', 'Who joins') : L('Quem participa', 'Who is in')}</span>
          <ul className="wa-people">
            {people.map((p, i) => (
              <li key={i}>
                <span className="wa-people__name">{p.name || p.phone}</span>
                {p.name && p.phone && <span className="muted small">{p.phone}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {action !== 'convite' && people.length === 0 && action !== 'criar' && <Plain />}
    </div>
  )
}

export function WhatsAppBody({ approval }: { approval: Approval }): ReactNode {
  const a = rec(approval.args) ?? {}
  if (approval.tool === 'whatsapp_corrigir') return <EditBody a={a} />
  if (approval.tool === 'whatsapp_grupo') return <GroupBody a={a} />
  if (approval.tool === 'whatsapp_enviar') return <SendBody a={a} />
  return <Plain />
}
