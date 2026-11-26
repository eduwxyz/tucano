// The right column of an open document, shown on demand: what is behind it in folded sections,
// one open at a time: where it came from, its versions, who sees it. (The summary sits under the title.)
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { L } from '../../../../shared/lang'
import { describeSchedule } from '../../../../shared/types'
import type { Doc, DocAction, DocEvent, DocFolder, DocsTree, DocVersion } from '../../../../shared/docs'
import { call } from '../../rpc'
import { amAdmin, navigate, toast, useStore } from '../../store'
import { message } from '../Invite'
import { confirmDialog } from '../Dialogs'
import { ago, Icon } from '../ui'
import { DocAccessDialog } from './DocAccess'
import { WhoAvatar } from './doc-ui'
import { useActors, useRoutineOf, type AccessWords } from './useDocs'

export interface History {
  versions: DocVersion[]
  events: DocEvent[]
}

// <details name="…"> shuts the others when one opens, in the browsers that know it, and nothing is lost in the ones that don't.
const group = { name: 'dc-about' } as object

// `detail` is the event's own words (the note asked, the folder it was put in); the others ignore it.
const STEP: Record<DocAction, (who: string, detail: string) => string> = {
  created: (w) => L(`${w} guardou o arquivo`, `${w} kept the file`),
  version: (w) => L(`${w} guardou uma versão nova`, `${w} kept a new version`),
  moved: (w) => L(`${w} mudou de pasta`, `${w} moved it to another folder`),
  renamed: (w) => L(`${w} mudou o nome`, `${w} renamed it`),
  trashed: (w) => L(`${w} mandou para a lixeira`, `${w} sent it to the trash`),
  restored: (w) => L(`${w} trouxe de volta da lixeira`, `${w} brought it back from the trash`),
  reverted: (w) => L(`${w} voltou para uma versão antiga`, `${w} went back to an older version`),
  'saved-from-chat': (w) => L(`${w} guardou da conversa`, `${w} kept it from the chat`),
  approved: (w) => L(`${w} aprovou`, `${w} approved it`),
  'changes-asked': (w, d) => L(`${w} pediu ajuste${d ? `: ${d}` : ''}`, `${w} asked for changes${d ? `: ${d}` : ''}`),
  'made-official': (w) => L(`${w} marcou como oficial`, `${w} marked it as official`),
  filed: (_w, d) => L(`o Tuca guardou em ${d || 'uma pasta'}`, `Tuca kept it in ${d || 'a folder'}`),
  unfiled: (w) => L(`${w} desfez: voltou para Só meus`, `${w} undid it: back in Only mine`),
  'sent-to-wiki': (w) => L(`${w} mandou para a wiki`, `${w} sent it to the wiki`)
}
// Events whose detail is already in their sentence.
const SAID: ReadonlySet<DocAction> = new Set(['approved', 'changes-asked', 'filed'])

function Fold({ title, meta, children, open }: { title: string; meta?: string; children: ReactNode; open?: boolean }): ReactNode {
  return (
    <details className="dc-fold" {...group} open={open}>
      <summary>
        <span>{title}</span>
        {meta && <em>{meta}</em>}
        <Icon name="chevron" size={13} />
      </summary>
      <div className="dc-fold__body">{children}</div>
    </details>
  )
}

export function DocAbout({ doc, folder, tree, words, may, history, historyError, viewing, onView, onClose }: { doc: Doc; folder: DocFolder; tree: DocsTree; words: AccessWords; may: boolean; history: History | null; historyError: string; viewing: number | null; onView: (n: number | null) => void; onClose: () => void }): ReactNode {
  const admin = useStore(amAdmin)
  const who = useActors()
  const conversation = useStore((s) => (doc.origin.conversationId ? s.conversations.some((c) => c.id === doc.origin.conversationId) : false))
  const [access, setAccess] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const routine = useRoutineOf(doc.routineId)
  const side = useRef<HTMLElement>(null)
  // In narrow windows this column sits below the document, so bring it into view when it opens.
  useEffect(() => {
    if (window.matchMedia('(max-width: 900px)').matches) side.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const events = history?.events.slice().sort((a, b) => a.at - b.at) ?? []
  const versions = history?.versions.slice().sort((a, b) => b.n - a.n) ?? []
  const origin = doc.origin
  const asker = origin.askedBy ? who(`person:${origin.askedBy}`) : null
  const maker = origin.agentId ? who(`agent:${origin.agentId}`) : null
  const sources = origin.sources?.filter(Boolean) ?? []
  // Only worth saying when the official version is not the one on screen.
  const official = doc.officialVersion !== null && doc.officialVersion < doc.version

  const revert = async (v: DocVersion): Promise<void> => {
    const ok = await confirmDialog({
      title: L(`Voltar para a versão ${v.n}?`, `Go back to version ${v.n}?`),
      body: L(`Ela vira a versão ${doc.version + 1}. As outras continuam guardadas.`, `It becomes version ${doc.version + 1}. The others stay kept.`),
      confirm: L('Voltar para esta', 'Go back to this one')
    })
    if (!ok) return
    setBusy(v.n)
    call('docRestoreVersion', { id: doc.id, n: v.n }).then(
      () => (toast(L(`Voltou para a versão ${v.n}.`, `Went back to version ${v.n}.`)), onView(null), setBusy(null)),
      (e: unknown) => (toast(`${L('Não consegui voltar a versão.', "I couldn't go back to that version.")} ${message(e)}`), setBusy(null))
    )
  }

  // The line for who asked (or made it) counts as a step too, with what the history holds.
  const steps = events.length + (asker || maker ? 1 : 0)

  return (
    <aside ref={side} className="dc-side">
      <div className="dc-side__body">
        <div className="dc-side__head">
          <h5>{L('Detalhes', 'Details')}</h5>
          <button className="icon-btn" title={L('Fechar detalhes', 'Close details')} aria-label={L('Fechar detalhes', 'Close details')} onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </div>

        <Fold title={L('De onde veio', 'Where it came from')} meta={steps ? (steps === 1 ? L('1 passo', '1 step') : L(`${steps} passos`, `${steps} steps`)) : undefined}>
          {historyError && <p className="muted small">{historyError}</p>}
          {!history && !historyError && <p className="muted small">{L('Abrindo a história…', 'Opening the history…')}</p>}
          {history && (
            <ul className="dc-tl">
              {(asker || maker) && (
                <li>
                  <WhoAvatar who={(asker ?? maker)!} size={22} />
                  <b>{asker ? L(`${asker.name} pediu`, `${asker.name} asked`) : L(`${maker!.name} fez`, `${maker!.name} made it`)}</b>
                  {asker && maker && <small>{L(`${maker.name} fez para essa pessoa`, `${maker.name} made it for them`)}</small>}
                  {origin.routineId && <small>{L('Feito por uma rotina automática', 'Made by an automatic routine')}</small>}
                </li>
              )}
              {doc.routineId && (
                <li>
                  <span className="dc-tl__ico">
                    <Icon name="clock" size={12} />
                  </span>
                  <b>{routine?.enabled ? L(`Atualizado pela rotina ${routine.name}`, `Kept up to date by the routine ${routine.name}`) : L('A rotina que atualizava este arquivo parou.', 'The routine that updated this file stopped.')}</b>
                  {routine?.enabled && !routine.trigger && <small>{describeSchedule(routine.schedule)}</small>}
                </li>
              )}
              {sources.length > 0 && (
                <li>
                  <span className="dc-tl__ico">
                    <Icon name="book" size={12} />
                  </span>
                  <b>{L('Baseado em', 'Based on')}</b>
                  <small>{sources.join(' · ')}</small>
                </li>
              )}
              {events.map((e, i) => {
                const w = who(e.by)
                return (
                  <li key={`${e.at}-${i}`}>
                    <WhoAvatar who={w} size={22} />
                    <b>{STEP[e.action](w.name, e.detail)}</b>
                    <small>
                      {ago(e.at)}
                      {e.detail && !SAID.has(e.action) ? ` · ${e.detail}` : ''}
                    </small>
                  </li>
                )
              })}
            </ul>
          )}
          {conversation && (
            <button className="btn btn--sm" onClick={() => navigate({ kind: 'conversation', id: origin.conversationId!, ...(origin.messageId ? { message: origin.messageId } : {}) })}>
              <Icon name="thread" size={13} /> {L('Abrir a conversa', 'Open the conversation')}
            </button>
          )}
        </Fold>

        <Fold title={L('Versões', 'Versions')} meta={String(doc.version)}>
          {!history && <p className="muted small">{historyError || L('Abrindo as versões…', 'Opening the versions…')}</p>}
          {versions.map((v) => {
            const now = v.n === doc.version
            const seen = viewing === v.n || (now && viewing === null)
            const w = who(v.by)
            return (
              <div key={v.n} className={`dc-ver ${now ? 'is-now' : ''} ${seen && !now ? 'is-seen' : ''}`}>
                <strong>
                  <span>{now ? L(`Versão ${v.n} · atual`, `Version ${v.n} · current`) : L(`Versão ${v.n}`, `Version ${v.n}`)}</span>
                  {official && v.n === doc.officialVersion && <em className="dc-ver__off">{L('a oficial', 'the official one')}</em>}
                </strong>
                <p>{v.note || L('Sem observação.', 'No note.')}</p>
                <small>
                  {w.name} · {ago(v.at)}
                </small>
                {!now && (
                  <div className="dc-ver__actions">
                    <button className="btn btn--sm" disabled={seen} onClick={() => onView(v.n)}>
                      {seen ? L('Vendo agora', 'Showing now') : L('Ver', 'View')}
                    </button>
                    {may && (
                      <button className="btn btn--sm btn--ghost" disabled={busy === v.n} onClick={() => void revert(v)}>
                        {busy === v.n ? L('Voltando…', 'Going back…') : L('Voltar para esta', 'Go back to this one')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </Fold>

        <Fold title={L('Quem vê', 'Who sees it')} meta={words.short(folder.id)}>
          <p className="dc-who-words">{words.long(folder.id)}</p>
          {admin && !folder.privateTo && (
            <button className="btn btn--sm" onClick={() => setAccess(true)}>
              {L('Mudar acesso', 'Change access')}
            </button>
          )}
        </Fold>
      </div>
      {access && <DocAccessDialog folder={folder} tree={tree} onClose={() => setAccess(false)} />}
    </aside>
  )
}
