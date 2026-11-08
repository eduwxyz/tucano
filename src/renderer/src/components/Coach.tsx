// The tour, done instead of read: a balloon over the real screen at the moment it matters, once
// each. The first message waiting in #geral; the first time an agent asks for something (only when
// one really does: nothing is staged, and its words follow how far that agent goes on its own); then
// the Tuca, for help; then the missions. The screen
// stays usable under it (the shade lets clicks through), each one closes on its own or with
// "Entendi", and "Pular tour" ends them all.
import { L } from '../../../shared/lang'
import { tourCount, tourOn, type TourMark } from '../../../shared/onboarding'
import { levelOf, policyOf, type Autonomy } from '../../../shared/actions'
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { agentById, amOwner, getState, messagesIn, navigate, teamMode, updateSettings, useStore } from '../store'
import { missionFacts } from './Missions'
import { TucaMark } from './ui'

// What an agent asks the person, in the conversation on screen: an approval, its questions, a proposal.
const ASKS = '.main .approval--pending, .main .ask--answer, .main .draft-card:not(.is-settled)'
const ANCHOR: Record<TourMark, string> = { first: '.main .composer', ask: ASKS, tuca: '[data-coach="tuca"]', missions: '[data-coach="missions"]' }

const done = (mark: TourMark): void => {
  const o = getState().settings.onboarding
  if (!o?.tour) return
  updateSettings({ onboarding: { ...o, tour: { ...o.tour, done: [...new Set([...(o.tour.done ?? []), mark])] } } })
}
const skip = (): void => {
  const o = getState().settings.onboarding
  if (o?.tour) updateSettings({ onboarding: { ...o, tour: { ...o.tour, skipped: true } } })
}

type Box = { top: number; left: number; width: number; height: number }

export function CoachLayer(): ReactNode {
  const onboarding = useStore((s) => s.settings.onboarding)
  const channel = onboarding?.channel
  const here = useStore((s) => (s.view?.kind === 'conversation' ? s.view.id : null))
  const sent = useStore((s) => !!channel && messagesIn(s, channel).some((m) => m.author.kind === 'person'))
  const replied = useStore((s) => missionFacts(s).replied)
  const missions = useStore((s) => amOwner(s) && !!s.settings.onboarding?.done && !s.settings.onboarding.checklistHidden)
  const [found, setFound] = useState<{ mark: TourMark; box: Box } | null>(null)
  const showing = useRef<TourMark | null>(null)

  // The first message went: its balloon is done, wherever it was sent from.
  useEffect(() => {
    if (sent && tourOn(onboarding, 'first')) done('first')
  }, [sent, onboarding])

  const on = !!onboarding?.tour && !onboarding.tour.skipped
  // Which balloon is due, and where its target is now: looked up a few times a second while the tour
  // runs (the target moves with the scroll, the window, a reply coming in).
  useEffect(() => {
    if (!on) return setFound(null)
    const look = (): void => {
      const box = (sel: string): Box | null => {
        const el = [...document.querySelectorAll<HTMLElement>(sel)].find((x) => x.offsetParent !== null)
        if (!el) return null
        const r = el.getBoundingClientRect()
        return r.width && r.height ? { top: r.top, left: r.left, width: r.width, height: r.height } : null
      }
      const due = (): { mark: TourMark; box: Box } | null => {
        const ask = box(ANCHOR.ask)
        if (tourOn(onboarding, 'first') && channel && here === channel && !sent) {
          const b = box(ANCHOR.first)
          return b && { mark: 'first', box: b }
        }
        if (tourOn(onboarding, 'ask') && ask) return { mark: 'ask', box: ask }
        if (tourOn(onboarding, 'first')) return null
        if (tourOn(onboarding, 'tuca') && replied && !ask) {
          const b = box(ANCHOR.tuca)
          return b && { mark: 'tuca', box: b }
        }
        if (tourOn(onboarding, 'missions') && missions && !tourOn(onboarding, 'tuca') && !ask) {
          const b = box(ANCHOR.missions)
          return b && { mark: 'missions', box: b }
        }
        return null
      }
      const next = due()
      // The request it pointed at was answered (or went): that one is done.
      if (showing.current === 'ask' && next?.mark !== 'ask' && tourOn(onboarding, 'ask')) done('ask')
      showing.current = next?.mark ?? null
      setFound((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next))
    }
    look()
    const t = setInterval(look, 400)
    return () => clearInterval(t)
  }, [on, onboarding, channel, here, sent, replied, missions])

  if (!found) return null
  return <Balloon mark={found.mark} box={found.box} missions={missions} />
}

// The first request's balloon, true at every level: it shows only when something really asks, and says
// what asks at the level the agent is on (src/shared/actions.ts), never that everything does.
export const askTitle = (name: string | undefined): string => (name ? L(`Quando ${name} precisar de você, pede aqui.`, `When ${name} needs you, it asks here.`) : L('Quando um agente precisar de você, pede aqui.', 'When an agent needs you, it asks here.'))
export const askBody = (level: Autonomy, guard = true): string =>
  ({
    careful: L('Antes de mudar qualquer coisa, pede o seu ok: aprove, recuse ou responda.', 'Before changing anything, it asks for your ok: approve, refuse or answer.'),
    normal: L('Antes de enviar, apagar, publicar ou pagar, pede o seu ok: aprove, recuse ou responda.', 'Before sending, deleting, publishing or paying, it asks for your ok: approve, refuse or answer.'),
    free: guard
      ? L('Sem travas, só pede o que é de alto risco ou o que vai pra fora depois de ler algo de fora. Perguntas também chegam aqui.', 'With no guardrails, it asks only for what’s high risk or what goes out after reading something from outside. Questions land here too.')
      : L('Sem travas, só pede o que é de alto risco. Perguntas também chegam aqui.', 'With no guardrails, it asks only for what’s high risk. Questions land here too.')
  })[level]

const WIDTH: Record<TourMark, number> = { first: 440, ask: 370, tuca: 360, missions: 360 }

// Where the balloon goes: above the message field, else beside its target (right first), kept on screen.
function place(mark: TourMark, b: Box, height: number): { style: CSSProperties; arrow: CSSProperties } {
  const w = Math.min(WIDTH[mark], window.innerWidth - 32)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  if (mark === 'first') {
    const left = clamp(b.left + b.width - w - 30, 16, window.innerWidth - w - 16)
    const top = Math.max(16, b.top - height - 22)
    return { style: { left, top, width: w }, arrow: { left: clamp(b.left + b.width - 70 - left, 24, w - 40), bottom: -9 } }
  }
  const right = b.left + b.width + 22
  const side = right + w <= window.innerWidth - 16 ? right : Math.max(16, b.left - w - 22)
  const top = clamp(b.top + b.height / 2 - height / 2, 16, window.innerHeight - height - 16)
  const arrowTop = clamp(b.top + b.height / 2 - top - 9, 18, height - 30)
  return { style: { left: side, top, width: w }, arrow: side >= right ? { left: -9, top: arrowTop } : { right: -9, top: arrowTop } }
}

function Balloon({ mark, box, missions }: { mark: TourMark; box: Box; missions: boolean }): ReactNode {
  const title = useId()
  const card = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(180)
  const onboarding = useStore((s) => s.settings.onboarding)
  const fresh = !!onboarding?.fresh && !onboarding.showAll
  const forYou = useStore((s) => (teamMode(s) ? L('Pra você', 'For you') : L('Aprovações', 'Approvals')))
  // The agent the first message calls: the one in the introduction's channel.
  const agent = useStore((s) => {
    const c = s.conversations.find((x) => x.id === s.settings.onboarding?.channel)
    const a = c?.members.map((id) => agentById(s, id)).find(Boolean)
    return a ? { name: a.name, handle: a.handle, level: levelOf(policyOf(a, s.settings)), guard: policyOf(a, s.settings).guard !== false } : null
  })
  useEffect(() => {
    if (card.current) setHeight(card.current.offsetHeight)
  })
  // Esc closes the balloon, unless it's meant for a field (a menu, a recording).
  useEffect(() => {
    const keys = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t && t !== document.body && !card.current?.contains(t)) return
      done(mark)
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [mark])

  const { style, arrow } = place(mark, box, height)
  const count = tourCount(onboarding, missions)
  const kicker = mark === 'first' ? L('ÚLTIMO PASSO', 'LAST STEP') : L(`TOUR · ${count.at} DE ${count.of}`, `TOUR · ${count.at} OF ${count.of}`)
  const text: Record<TourMark, { title: string; body: ReactNode; foot?: ReactNode }> = {
    first: {
      title: agent ? L(`Sua primeira mensagem pra ${agent.name}.`, `Your first message to ${agent.name}.`) : L('Sua primeira mensagem.', 'Your first message.'),
      body: (
        <>
          {L('É como um chat: o ', 'It’s like a chat: ')}
          <b>@{agent?.handle ?? L('agente', 'agent')}</b>
          {L(' chama quem você quer. Mude o texto se quiser, e aperte enviar.', ' calls who you want. Change the text if you like, and press send.')}
        </>
      ),
      foot: (
        <button className="coach__ok coach__ok--quiet" onClick={() => done('first')}>
          {L('Entendi', 'Got it')}
        </button>
      )
    },
    ask: {
      title: askTitle(agent?.name),
      body: (
        <>
          {askBody(agent?.level ?? 'normal', agent?.guard ?? true)} {L('O que esperar por você também aparece em ', 'Whatever waits for you also shows up in ')}
          <b>{forYou}</b>.
        </>
      ),
      foot: <span className="coach__hint">{L('Escolha uma resposta pra seguir', 'Pick an answer to go on')}</span>
    },
    tuca: {
      title: L('Travou? Chama o Tuca.', 'Stuck? Call Tuca.'),
      body: L('Ele monta outros agentes, muda o que você quiser e explica o app. Fica aqui, no topo da barra.', 'He builds more agents, changes whatever you want and explains the app. He’s right here, at the top of the sidebar.')
    },
    missions: {
      title: L('Suas missões.', 'Your missions.'),
      body: fresh ? L('Cada uma te mostra uma parte do Tucano, fazendo. A barra lateral cresce conforme você avança.', 'Each one shows you a part of Tucano by doing it. The sidebar grows as you go.') : L('Cada uma te mostra uma parte do Tucano e se marca sozinha quando você usa.', 'Each one shows you a part of Tucano and checks itself off when you use it.')
    }
  }
  const t = text[mark]
  return (
    <div className="coach" aria-live="polite">
      <div className="coach__hole" style={{ top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 }} />
      <div ref={card} className={`coach__card coach__card--${mark}`} style={style} role="dialog" aria-modal="false" aria-labelledby={title}>
        <span className="coach__kicker">
          {mark === 'first' && <TucaMark size={34} />}
          {kicker}
        </span>
        <b id={title} className="coach__title">
          {t.title}
        </b>
        <span className="coach__body">{t.body}</span>
        <span className="coach__foot">
          {t.foot ?? (
            <button className="coach__ok" onClick={() => (done(mark), mark === 'missions' && navigate({ kind: 'missions' }))}>
              {mark === 'missions' ? L('Ver as missões', 'See the missions') : L('Entendi', 'Got it')}
            </button>
          )}
          <button className="coach__skip" onClick={skip}>
            {L('Pular tour', 'Skip the tour')}
          </button>
        </span>
        <span className="coach__arrow" style={arrow} aria-hidden />
      </div>
    </div>
  )
}
