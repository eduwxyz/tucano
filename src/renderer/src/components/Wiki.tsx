// The wiki: what you and the team know, as linked pages (an LLM wiki, after Karpathy). The
// pages are Markdown files in a folder Obsidian opens as is; the agents read them, search
// them and cite them as [[Title]]. Here: one place with a rail (the home, what waits for you,
// the sources, what needs care, and the pages by kind) and, beside it, the map of the pages,
// a page with what links to it, the sources, the review; the editor takes the whole screen.
import { L, locale } from '../../../shared/lang'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Markdown from 'react-markdown'
import { safeUrl } from '../links'
import remarkGfm from 'remark-gfm'
import { call } from '../rpc'
import { agentById, amAdmin, navigate, openExternal, personName, setTab, updateSettings, useStore, type State, type View, type WikiChange, type WikiFinding, type WikiGitStatus, type WikiGitTest, type WikiHit, type WikiImport, type WikiPage, type WikiPageInfo, type WikiReview, type WikiSource, type WikiVersion } from '../store'
import { Sheet, Toggle } from './Pages'
import { AdminOnly } from './People'
import { confirmDialog } from './Dialogs'
import { AgentAvatar, Icon, type IconName } from './ui'
import { screenOf } from '../../../shared/screens'

const DEFAULT_KINDS = (): string[] => [L('Pessoa', 'Person'), L('Projeto', 'Project'), L('Assunto', 'Topic'), L('Decisão', 'Decision')]
const CODE = /```[\s\S]*?```|`[^`\n]*`/g

type Graph = { nodes: { title: string; kind: string; links: number; missing?: boolean }[]; edges: [string, string][] }
type WikiData = { dir: string; pages: WikiPageInfo[]; kinds: string[]; log: string[]; pending: number; findings: number; server: boolean; graph: Graph; recent: Omit<WikiVersion, 'before' | 'after'>[]; sources: number; held?: { title: string; at: number }[]; heritage?: { at: number }; git?: { readOnly: boolean; state: WikiGitStatus['state']; lastSync?: number } }
type WikiViewState = Extract<View, { kind: 'wiki' }>

// ---------- small things used everywhere ----------

// Each kind of page has a color: the usual four always the same one, any other one by its name.
const KNOWN: Record<string, string> = { pessoa: 'rose', pessoas: 'rose', person: 'rose', people: 'rose', projeto: 'indigo', projetos: 'indigo', project: 'indigo', projects: 'indigo', assunto: 'teal', assuntos: 'teal', topic: 'teal', topics: 'teal', decisao: 'amber', decisoes: 'amber', decision: 'amber', decisions: 'amber', cliente: 'violet', clientes: 'violet', client: 'violet', clients: 'violet' }
const PALETTE = ['indigo', 'rose', 'teal', 'amber', 'violet', 'sky', 'green', 'graphite']
const fold = (s: string): string => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim()
// The wiki's other kinds (an Obsidian vault's folders, say) take the colors the usual ones
// leave free, the most used first, so no two kinds look alike while there are colors left.
let given = new Map<string, string>()
export function setKinds(kinds: [string, number][]): void {
  const next = new Map<string, string>()
  const taken = new Set<string>()
  for (const [k] of kinds) if (KNOWN[fold(k)] && !taken.has(KNOWN[fold(k)]!)) (next.set(fold(k), KNOWN[fold(k)]!), taken.add(KNOWN[fold(k)]!))
  for (const [k] of kinds) {
    if (next.has(fold(k))) continue
    const free = PALETTE.find((c) => !taken.has(c)) ?? PALETTE[next.size % PALETTE.length]!
    next.set(fold(k), free)
    taken.add(free)
  }
  given = next
}
export function kindColor(kind: string): string {
  if (!kind) return 'var(--text-3)'
  const k = fold(kind)
  const c = given.get(k) ?? KNOWN[k]
  if (c) return `var(--c-${c})`
  let h = 0
  for (const ch of k) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return `var(--c-${PALETTE[h % PALETTE.length]})`
}

function KindPill({ kind, small }: { kind: string; small?: boolean }): ReactNode {
  if (!kind) return null
  return (
    <span className={`wk-pill ${small ? 'wk-pill--sm' : ''}`} style={{ ['--k' as string]: kindColor(kind) }}>
      <i />
      {kind}
    </span>
  )
}

function rel(t: number): string {
  const s = (Date.now() - t) / 1000
  const f = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  if (s < 50) return L('agora', 'just now')
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute')
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour')
  if (s < 86400 * 7) return f.format(-Math.round(s / 86400), 'day')
  return new Date(t).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })
}
const when = (t: number): string => new Date(t).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' })

// Who changed something: a person (by their id; "me" from before people is whoever this is), an
// agent, the curator, the review, or another app (Obsidian). Someone who left keeps their name.
export function wikiWho(state: Pick<State, 'you' | 'me' | 'people' | 'former' | 'agents'>): (by: string) => string {
  return (by) =>
    by === 'me'
      ? state.me.name
      : by === 'outside'
        ? L('fora do Tucano', 'outside Tucano')
        : by === 'auto'
          ? L('o curador', 'the curator')
          : by === 'review'
            ? L('a revisão', 'the review')
            : by === 'import'
              ? L('veio do Obsidian', 'came from Obsidian')
              : (agentById(state as State, by)?.name ?? (by === state.you || state.people.some((p) => p.id === by) || state.former?.some((p) => p.id === by) ? personName(state, by) : by))
}
function useWho(): (by: string) => string {
  const you = useStore((s) => s.you)
  const me = useStore((s) => s.me)
  const people = useStore((s) => s.people)
  const former = useStore((s) => s.former)
  const agents = useStore((s) => s.agents)
  return useMemo(() => wikiWho({ you, me, people, former, agents }), [you, me, people, former, agents])
}
function Who({ by, size = 22 }: { by: string; size?: number }): ReactNode {
  const me = useStore((s) => s.me)
  const agent = useStore((s) => (by.length > 20 ? agentById(s, by) : undefined))
  const person = useStore((s) => (by === 'me' || by === s.you ? undefined : (s.people.find((p) => p.id === by) ?? s.former.find((p) => p.id === by))))
  if (agent) return <AgentAvatar agent={agent} size={size} />
  const icon: IconName | null = by === 'auto' ? 'layers' : by === 'review' ? 'shield' : by === 'outside' || by === 'import' ? 'folder' : null
  const initials = person ? person.name.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') : me.initials
  return (
    <span className={`wk-who ${by === 'auto' || by === 'review' ? 'wk-who--curator' : ''}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {icon ? <Icon name={icon} size={Math.round(size * 0.55)} /> : initials}
    </span>
  )
}

// The Tucano got its second person: a line for its owner saying what changed, and the pages that came
// from their private conversations, held for them until they release each one.
export function WikiHeritage({ held, notice }: { held: { title: string; at: number }[]; notice: boolean }): ReactNode {
  const [busy, setBusy] = useState('')
  if (!notice && !held.length) return null
  const release = (title: string): void => {
    setBusy(title)
    void call('wikiRelease', { title }).finally(() => setBusy(''))
  }
  return (
    <div className="wk-heritage">
      {notice && (
        <p>
          {L(
            'Seu Tucano agora tem mais gente: os resumos dos canais foram refeitos sem o que veio das suas DMs, o histórico da wiki de antes continua só seu, e as páginas feitas das suas conversas privadas ficam só com você até você liberar.',
            "Your Tucano has more people now: the channels' summaries were made again without what came from your DMs, the wiki's history from before stays yours alone, and the pages made from your private conversations stay with you until you release them."
          )}
          <button className="text-btn" onClick={() => void call('heritageSeen')}>
            {L('Entendi', 'Got it')}
          </button>
        </p>
      )}
      {held.length > 0 && (
        <>
          <h5>{L('Páginas que vieram das suas conversas privadas', 'Pages that came from your private conversations')}</h5>
          <ul>
            {held.map((h) => (
              <li key={h.title}>
                <button className="text-btn" onClick={() => navigate({ kind: 'wiki', title: h.title })}>
                  {h.title}
                </button>
                <button className="btn btn--ghost btn--sm" disabled={busy === h.title} onClick={() => release(h.title)}>
                  {L('Liberar pro time', 'Release to the team')}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function useWikiData(): WikiData | null {
  const rev = useStore((s) => s.wikiRev)
  const [data, setData] = useState<WikiData | null>(null)
  useEffect(() => void call('wiki').then((d) => setData(d as WikiData)), [rev])
  return data
}

// ---------- links ----------

// [[Title]] and [[Title|shown]] as links the Markdown renderer can hand to WikiLink, outside code.
export function wikiLinks(text: string): string {
  const swap = (t: string): string =>
    t
      .replace(/^(>\s*)\[!(\w+)\][+-]?[ \t]*(.*)$/gm, (_, q: string, type: string, title: string) => `${q}**${title.trim() || type.charAt(0).toUpperCase() + type.slice(1)}**  `) // an Obsidian callout: its title in bold
      .replace(/\s?\((\[\[fontes\/[^\]\n]+\]\])\)/g, ' $1') // "(source)" after a passage: the badge says it
      // ![[foto.png]]: an attachment in the vault, shown by name
      .replace(/!\[\[([^\]|#\n]+\.(?!md\])[a-z0-9]{2,5})(?:\|[^\]\n]*)?\]\]/gi, (_, file: string) => `[${file.split('/').pop()}](#att/${encodeURIComponent(file)})`)
      // [[Clientes/Marcos Lima]] is the page Marcos Lima, as in Obsidian
      .replace(/!?\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|([^\]\n]+))?\]\]/g, (_, target: string, shown?: string) => {
        const t = target.trim()
        const title = t.startsWith('fontes/') ? t : t.replace(/\.md$/i, '').split('/').pop()!.trim()
        return `[${(shown ?? title).trim()}](#wiki/${encodeURIComponent(title)})`
      })
  let out = ''
  let last = 0
  for (const m of text.matchAll(CODE)) {
    out += swap(text.slice(last, m.index)) + m[0]
    last = m.index! + m[0].length
  }
  return out + swap(text.slice(last))
}

// What a link points to, shown when the pointer rests on it.
const peeks = new Map<string, Promise<WikiPage | null>>()
let peekRev = -1
function peek(title: string, rev: number): Promise<WikiPage | null> {
  if (rev !== peekRev) (peeks.clear(), (peekRev = rev))
  let p = peeks.get(title)
  if (!p) peeks.set(title, (p = call('wikiPage', { title })))
  return p
}

function Peek({ title, rect }: { title: string; rect: DOMRect }): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [page, setPage] = useState<WikiPage | null | undefined>(undefined)
  useEffect(() => void peek(title, rev).then(setPage), [title, rev])
  if (page === undefined) return null
  const below = rect.top < 220
  const style = { left: Math.min(Math.max(12, rect.left + rect.width / 2 - 160), window.innerWidth - 332), ...(below ? { top: rect.bottom + 8 } : { bottom: window.innerHeight - rect.top + 8 }) }
  return createPortal(
    <div className="wk-peek" style={style}>
      {page ? (
        <>
          <KindPill kind={page.kind} small />
          <b>{page.title}</b>
          {page.summary && <p>{page.summary}</p>}
          <small>
            {L('atualizada', 'updated')} {rel(page.updatedAt)}
            {page.backlinks.length > 0 && ` · ${page.backlinks.length === 1 ? L('1 página liga pra ela', '1 page links here') : L(`${page.backlinks.length} páginas ligam pra ela`, `${page.backlinks.length} pages link here`)}`}
          </small>
        </>
      ) : (
        <>
          <b>{title}</b>
          <p>{L('Ainda não existe. Clique pra escrever.', "Doesn't exist yet. Click to write it.")}</p>
        </>
      )}
    </div>,
    document.body
  )
}

// A link inside rendered Markdown: a wiki page opens here; anything else stays a link.
// A link to one of the app's screens (the Tuca's "[Abrir Conectores](#abrir/conectores)"): a button that goes there.
function ScreenLink({ target, children }: { target: NonNullable<ReturnType<typeof screenOf>>; children?: ReactNode }): ReactNode {
  const agent = useStore((s) => (target.agentHandle ? s.agents.find((a) => a.handle === target.agentHandle) : undefined))
  if (target.agentHandle && !agent) return <>{children}</>
  const go = (): void => {
    if (agent) return navigate({ kind: 'agent', id: agent.id })
    const { screen } = target
    if (!screen) return
    if (screen.tab) setTab(screen.view, screen.tab)
    navigate({ kind: screen.view } as View)
  }
  return (
    <button type="button" className="screen-link" onClick={go}>
      {children}
      <Icon name="chevron" size={11} />
    </button>
  )
}

export function WikiLink({ href, children, missing }: { href?: string; children?: ReactNode; missing?: Set<string> }): ReactNode {
  const [hover, setHover] = useState<DOMRect | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const screen = screenOf(href)
  if (screen) return <ScreenLink target={screen}>{children}</ScreenLink>
  if (href?.startsWith('#att/'))
    return (
      <span className="wiki-link wiki-link--source wiki-link--file" title={decodeURIComponent(href.slice(5))}>
        <Icon name="image" size={11} />
        {children}
      </span>
    )
  if (!href?.startsWith('#wiki/')) return <a href={href}>{children}</a>
  const title = decodeURIComponent(href.slice(6))
  if (title.startsWith('fontes/'))
    return (
      <button type="button" className="wiki-link wiki-link--source" title={L('Abrir a fonte', 'Open the source')} onClick={() => navigate({ kind: 'wiki', source: title })}>
        <Icon name="book" size={11} />
        {children}
      </button>
    )
  const isMissing = missing?.has(title.toLowerCase())
  return (
    <>
      <button
        type="button"
        className={`wiki-link ${isMissing ? 'is-missing' : ''}`}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          timer.current = setTimeout(() => setHover(r), 380)
        }}
        onMouseLeave={() => (clearTimeout(timer.current), setHover(null))}
        onClick={() => (clearTimeout(timer.current), setHover(null), navigate({ kind: 'wiki', title, ...(isMissing ? { edit: true } : {}) }))}
      >
        {children}
      </button>
      {hover && <Peek title={title} rect={hover} />}
    </>
  )
}

const mdLinks = (missing?: Set<string>) => ({ a: (p: { href?: string; children?: ReactNode }) => <WikiLink href={p.href} missing={missing}>{p.children}</WikiLink> })

// ---------- the map ----------

type Pos = { x: number; y: number }
type Cam = { x: number; y: number; k: number }
type Body = { x: number; y: number; vx: number; vy: number; held?: boolean }
const SPREAD = 1.6 // from the simulation's units to the map's

// One step of the forces: pages push each other away, links pull, the middle holds them.
// A page being dragged stays under the pointer and pulls its neighbors along.
function tick(bodies: Body[], links: (readonly [number, number])[], deg: Uint16Array, heat: number): void {
  const n = bodies.length
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const a = bodies[i]!
      const b = bodies[j]!
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d2 = Math.max(dx * dx + dy * dy, 30)
      const f = 70 / d2
      a.vx += dx * f
      a.vy += dy * f
      b.vx -= dx * f
      b.vy -= dy * f
    }
  for (const [i, j] of links) {
    const a = bodies[i]!
    const b = bodies[j]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const f = ((d - 70) / d) * 0.06
    a.vx += dx * f
    a.vy += dy * f
    b.vx -= dx * f
    b.vy -= dy * f
  }
  for (let i = 0; i < n; i++) {
    const b = bodies[i]!
    // a page with no links would drift off; it's held closer
    const g = deg[i]! ? 0.009 : 0.03
    b.vx -= b.x * g
    b.vy -= b.y * g * 1.6
    if (b.held) {
      b.vx = 0
      b.vy = 0
      continue
    }
    b.x += b.vx * heat
    b.y += b.vy * heat
    b.vx *= 0.55
    b.vy *= 0.55
  }
}

// The pages as bodies of a small physics, kept across renders: a new page lands next to one it
// links to and the rest makes room; the first time, it settles before it's shown.
function useBodies(graph: Graph): { bodies: Map<string, Body>; kick: (heat: number) => void; frame: number } {
  const bodies = useRef(new Map<string, Body>()).current
  const heat = useRef(0)
  const loop = useRef(0)
  const [frame, setFrame] = useState(0)
  const parts = useRef<{ list: Body[]; links: (readonly [number, number])[]; deg: Uint16Array }>({ list: [], links: [], deg: new Uint16Array() })

  useMemo(() => {
    const first = bodies.size === 0
    const titles = new Set(graph.nodes.map((n) => n.title))
    for (const t of [...bodies.keys()]) if (!titles.has(t)) bodies.delete(t)
    graph.nodes.forEach((nd, i) => {
      if (bodies.has(nd.title)) return
      const friend = graph.edges.find(([a, b]) => (a === nd.title && bodies.has(b)) || (b === nd.title && bodies.has(a)))
      const near = friend ? bodies.get(friend[0] === nd.title ? friend[1] : friend[0])! : null
      // a golden spiral to start from, so the same wiki always lands the same way
      const r = 16 * Math.sqrt(i + 1)
      const a = i * 2.399963
      bodies.set(nd.title, near ? { x: near.x + Math.cos(a) * 30, y: near.y + Math.sin(a) * 30, vx: 0, vy: 0 } : { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0 })
    })
    const idx = new Map(graph.nodes.map((n, i) => [n.title, i]))
    const list = graph.nodes.map((n) => bodies.get(n.title)!)
    const links = graph.edges.map(([a, b]) => [idx.get(a), idx.get(b)] as const).filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined)
    const deg = new Uint16Array(list.length)
    for (const [a, b] of links) deg[a]!++, deg[b]!++
    parts.current = { list, links, deg }
    if (first) for (let it = 0, iters = list.length > 250 ? 140 : 300; it < iters; it++) tick(list, links, deg, 0.3 + (1 - it / iters))
    else heat.current = Math.max(heat.current, 0.6)
  }, [graph])

  const run = (): void => {
    const { list, links, deg } = parts.current
    tick(list, links, deg, heat.current)
    heat.current *= 0.965
    setFrame((f) => f + 1)
    const busy = list.some((b) => b.held)
    if (heat.current > 0.02 || busy) loop.current = requestAnimationFrame(run)
    else loop.current = 0
  }
  const kick = (h: number): void => {
    heat.current = Math.max(heat.current, h)
    if (!loop.current) loop.current = requestAnimationFrame(run)
  }
  useEffect(() => {
    if (heat.current > 0.02) kick(heat.current)
  }, [graph])
  useEffect(() => () => cancelAnimationFrame(loop.current), [])
  return { bodies, kick, frame }
}

function useSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e!.contentRect.width), h: Math.round(e!.contentRect.height) }))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

const PANEL = 560 // the panel's width; the map keeps what's left of it in view
const ease = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2)

// The whole wiki as a map you can move around: drag the empty map to move it, drag a page to
// pull it (and what it links to) around, pinch or the mouse wheel (or ⌘/Ctrl + scroll) to zoom. A page picked flies to
// the middle of what the panel leaves free, with its links lit.
function WikiCanvas({ graph, selected, pending, only, panel }: { graph: Graph; selected?: string; pending: Set<string>; only: string | null; panel: boolean }): ReactNode {
  const [ref, size] = useSize()
  const { bodies, kick } = useBodies(graph)
  const world = (t: string): Pos | undefined => {
    const b = bodies.get(t)
    return b && { x: b.x * SPREAD, y: b.y * SPREAD }
  }
  const [cam, setCam] = useState<Cam | null>(null)
  const camRef = useRef(cam)
  camRef.current = cam
  const anim = useRef(0)
  const [hover, setHover] = useState<string | null>(null)
  const [panning, setPanning] = useState(false)
  const [holding, setHolding] = useState<string | null>(null)
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean; page?: string | null; missing?: boolean } | null>(null)
  const free = (): { w: number; h: number } => ({ w: size.w - (panel && size.w > 980 ? PANEL + 24 : 0), h: size.h })

  const fit = (): Cam => {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const b of bodies.values()) (x0 = Math.min(x0, b.x * SPREAD)), (x1 = Math.max(x1, b.x * SPREAD)), (y0 = Math.min(y0, b.y * SPREAD)), (y1 = Math.max(y1, b.y * SPREAD))
    if (!isFinite(x0)) return { x: 0, y: 0, k: 1 }
    const a = free()
    const k = Math.max(0.3, Math.min((a.w - 260) / Math.max(1, x1 - x0), (a.h - 180) / Math.max(1, y1 - y0), 1.5))
    return { k, x: a.w / 2 - ((x0 + x1) / 2) * k, y: a.h / 2 - ((y0 + y1) / 2) * k }
  }
  const fly = (to: Cam, ms = 700): void => {
    cancelAnimationFrame(anim.current)
    const from = camRef.current
    if (!from) return setCam(to)
    const t0 = performance.now()
    const step = (t: number): void => {
      const e = ease(Math.min(1, (t - t0) / ms))
      setCam({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e })
      if (e < 1) anim.current = requestAnimationFrame(step)
    }
    anim.current = requestAnimationFrame(step)
  }
  const zoom = (f: number, at?: Pos): void => {
    const c = camRef.current
    if (!c) return
    const k = Math.max(0.3, Math.min(3, c.k * f))
    const p = at ?? { x: free().w / 2, y: size.h / 2 }
    setCam({ k, x: p.x - (p.x - c.x) * (k / c.k), y: p.y - (p.y - c.y) * (k / c.k) })
  }

  // the first look fits it all; then it follows the page that's open, and fits again when it closes
  const had = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!size.w) return
    const p = selected ? world(selected) : undefined
    const was = had.current
    had.current = selected
    if (!camRef.current) {
      const f = fit()
      const k = Math.max(f.k, 1.15)
      setCam(p ? { k, x: free().w / 2 - p.x * k, y: size.h / 2 - p.y * k } : f)
      return
    }
    if (p) {
      const k = Math.max(camRef.current.k, 1.15)
      fly({ k, x: free().w / 2 - p.x * k, y: size.h / 2 - p.y * k })
    } else if (was && !panel) fly(fit())
  }, [selected, panel, size.w > 0])
  useEffect(() => () => cancelAnimationFrame(anim.current), [])

  // scrolling moves it; pinching (or ⌘/Ctrl + scroll) zooms where the pointer is
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      cancelAnimationFrame(anim.current)
      const r = el.getBoundingClientRect()
      // a mouse wheel (notches of 100 or 120, or lines) zooms too; a trackpad's two fingers move
      const wheel = e.deltaMode !== 0 || (e.deltaX === 0 && e.deltaY !== 0 && (Math.abs(e.deltaY) % 100 === 0 || Math.abs(e.deltaY) % 120 === 0))
      if (e.ctrlKey || e.metaKey || wheel) zoom(Math.exp(-(wheel ? Math.sign(e.deltaY) * 0.18 : e.deltaY * 0.012)), { x: e.clientX - r.left, y: e.clientY - r.top })
      else {
        const c = camRef.current
        if (c) setCam({ ...c, x: c.x - e.deltaX, y: c.y - e.deltaY })
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const near = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [a, b] of graph.edges) (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b), (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a)
    return m
  }, [graph])
  const lit = holding ?? hover ?? selected ?? null
  const around = lit ? near.get(lit) : undefined
  const isNear = (t: string): boolean => !lit || t === lit || !!around?.has(t)
  const kindOf = new Map(graph.nodes.map((n) => [n.title, n.kind]))
  const shown = (t: string): boolean => !only || kindOf.get(t) === only

  const k = cam?.k ?? 1
  const at = (t: string): Pos | null => {
    const p = world(t)
    return p && cam ? { x: p.x * k + cam.x, y: p.y * k + cam.y } : null
  }
  const scale = 0.8 + 0.2 * Math.min(k, 1.8)
  const many = graph.nodes.length > 40
  return (
    <div
      ref={ref}
      className={`wk-canvas ${panning ? 'is-panning' : ''} ${holding ? 'is-holding' : ''}`}
      style={cam ? { backgroundPosition: `${cam.x}px ${cam.y}px`, backgroundSize: `${26 * k}px ${26 * k}px` } : undefined}
      onPointerDown={(e) => {
        if (!cam || e.button !== 0) return
        cancelAnimationFrame(anim.current)
        const hit = (e.target as Element).closest('[data-page]')
        drag.current = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false, page: hit?.getAttribute('data-page'), missing: !!hit?.getAttribute('data-missing') }
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || !cam) return
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (!d.moved && Math.hypot(dx, dy) > 4) {
          d.moved = true
          if (d.page) setHolding(d.page)
          else setPanning(true)
        }
        if (!d.moved) return
        if (d.page) {
          // the page follows the pointer; its links pull the others after it
          const b = bodies.get(d.page)
          const r = ref.current!.getBoundingClientRect()
          if (b) {
            b.held = true
            b.x = (e.clientX - r.left - cam.x) / cam.k / SPREAD
            b.y = (e.clientY - r.top - cam.y) / cam.k / SPREAD
            kick(0.5)
          }
        } else setCam({ ...cam, x: d.cx + dx, y: d.cy + dy })
      }}
      onPointerUp={() => {
        const d = drag.current
        drag.current = null
        setPanning(false)
        setHolding(null)
        if (!d) return
        if (d.moved && d.page) {
          const b = bodies.get(d.page)
          if (b) b.held = false
          kick(0.5)
        } else if (!d.moved) {
          // a click: on a page opens it; on the empty map closes what's open
          if (d.page) navigate({ kind: 'wiki', title: d.page, ...(d.missing ? { edit: true } : {}) })
          else if (panel) navigate({ kind: 'wiki' })
        }
      }}
    >
      {cam && (
        <svg width={size.w} height={size.h}>
          <g className="wk-canvas__edges">
            {graph.edges.map(([a, b]) => {
              const p = at(a)
              const q = at(b)
              if (!p || !q) return null
              const hot = !!lit && (a === lit || b === lit)
              const off = !shown(a) && !shown(b)
              return <line key={`${a}\n${b}`} x1={p.x} y1={p.y} x2={q.x} y2={q.y} className={hot ? 'is-hot' : lit || off ? 'is-dim' : ''} />
            })}
          </g>
          {graph.nodes.map((nd, i) => {
            const p = at(nd.title)
            if (!p) return null
            const r = (nd.title === selected || nd.title === holding ? 9 : 5 + Math.sqrt(nd.links) * 2.4) * scale
            const label = !many || k > 1.05 || nd.links >= 3 || (!!lit && isNear(nd.title))
            const dim = !isNear(nd.title) || !shown(nd.title)
            return (
              <g
                key={nd.title}
                data-page={nd.title}
                data-missing={nd.missing ? '1' : undefined}
                className={`wk-node ${nd.missing ? 'is-missing' : ''} ${dim ? 'is-dim' : ''} ${nd.title === lit ? 'is-lit' : ''} ${nd.title === selected ? 'is-sel' : ''} ${nd.title === holding ? 'is-held' : ''}`}
                style={{ ['--k' as string]: kindColor(nd.kind), ['--i' as string]: i }}
                transform={`translate(${p.x} ${p.y})`}
                onPointerEnter={() => !drag.current && setHover(nd.title)}
                onPointerLeave={() => setHover((h) => (h === nd.title ? null : h))}
              >
                <circle className="wk-node__hit" r={r + 12} />
                {pending.has(nd.title) && <circle className="wk-node__ping" r={r + 4} />}
                <circle className="wk-node__halo" r={r + 8} />
                <circle className="wk-node__dot" r={r} />
                {label && (
                  <text y={r + 15} textAnchor="middle">
                    {nd.title.length > 28 ? `${nd.title.slice(0, 26)}…` : nd.title}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      )}
      <div className="wk-zoom" onPointerDown={(e) => e.stopPropagation()} style={{ right: panel && size.w > 980 ? PANEL + 40 : 16 }}>
        <button title={L('Afastar', 'Zoom out')} onClick={() => zoom(1 / 1.3)}>
          −
        </button>
        <button title={L('Ver tudo', 'Fit all')} onClick={() => fly(fit(), 500)}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M1.5 4.5v-3h3M8.5 1.5h3v3M11.5 8.5v3h-3M4.5 11.5h-3v-3" />
          </svg>
        </button>
        <button title={L('Aproximar', 'Zoom in')} onClick={() => zoom(1.3)}>
          +
        </button>
      </div>
    </div>
  )
}

// ---------- the place: the map, and a panel over it ----------

export function WikiView(): ReactNode {
  const view = useStore((s) => s.view)
  if (view?.kind !== 'wiki') return null
  if (view.edit) return <WikiEditor key={`edit:${view.title ?? ''}`} title={view.title} />
  return <WikiShell view={view} />
}

// The search shortcut as the keyboard in front of the person says it (a browser on a server included).
const SEARCH_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'

function WikiShell({ view }: { view: WikiViewState }): ReactNode {
  const data = useWikiData()
  const rev = useStore((s) => s.wikiRev)
  const admin = useStore(amAdmin)
  const [searching, setSearching] = useState(false)
  const [settings, setSettings] = useState(false)
  const [dropping, setDropping] = useState(0)
  const [dropError, setDropError] = useState<string[]>([])
  const [only, setOnly] = useState<string | null>(null)
  const [pending, setPending] = useState<WikiChange[]>([])
  const [reading, setReading] = useState<WikiSource[]>([])
  useEffect(() => void Promise.all([call('wikiChanges', { state: 'pending' }), call('wikiChanges', { state: 'conflict' })]).then(([a, b]) => setPending([...a, ...b].filter((c) => c.by !== 'review'))), [rev])
  useEffect(() => void call('wikiSources').then((l) => setReading(l.filter((s) => s.status === 'reading'))), [rev])
  const panel = !!(view.title || view.source || view.tab)
  const close = (): void => navigate({ kind: 'wiki' })
  const [imported, setImported] = useState<WikiImport | { error: string } | 'busy' | null>(null)
  const startImport = (): void => {
    const failed = (e: Error): void => setImported({ error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    // On a server the vault is on the person's computer, not there: it goes up as a .zip.
    const upload = window.tucano.upload
    if (upload) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.zip,application/zip'
      input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        setSettings(false)
        setImported('busy')
        void upload(file).then((path) => call('wikiImportZip', { path })).then(setImported, failed)
      }
      input.click()
      return
    }
    const pick = (window.tucano as unknown as { pickFolder?: () => Promise<string | null> }).pickFolder
    void pick?.().then((dir) => {
      if (!dir) return
      setSettings(false)
      setImported('busy')
      void call('wikiImport', { dir }).then(setImported, (e: Error) => setImported({ error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') }))
    })
  }

  // ⌘K or / searches, N writes a new page, E edits the open one, Esc closes the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return void (e.preventDefault(), setSearching(true))
      if (typing || e.metaKey || e.ctrlKey || e.altKey || searching || settings) return
      if (e.key === '/') setSearching(true)
      else if (e.key.toLowerCase() === 'n') navigate({ kind: 'wiki', edit: true, title: '' })
      else if (e.key.toLowerCase() === 'e' && view.title) navigate({ kind: 'wiki', title: view.title, edit: true })
      else if (e.key === 'Escape' && panel) close()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const drop = {
    onDragEnter: (e: React.DragEvent) => e.dataTransfer.types.includes('Files') && setDropping((n) => n + 1),
    onDragLeave: () => setDropping((n) => Math.max(0, n - 1)),
    onDragOver: (e: React.DragEvent) => e.dataTransfer.types.includes('Files') && e.preventDefault(),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      setDropping(0)
      const fs = [...e.dataTransfer.files]
      if (fs.length) void addWikiFiles(fs).then((errs) => (setDropError(errs), navigate({ kind: 'wiki', tab: 'sources' })))
    }
  }

  const count = data?.pages.length ?? 0
  const links = data?.graph.edges.length ?? 0
  const touched = useMemo(() => new Set(pending.flatMap((c) => c.ops.map((o) => o.page))), [pending])
  const kinds = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of data?.pages ?? []) m.set(p.kind, (m.get(p.kind) ?? 0) + 1)
    const list = [...m.entries()].sort((a, b) => b[1] - a[1])
    setKinds(list)
    return list
  }, [data])
  // The curator's decisions, the review and the wiki's place are the admins'; anyone reads and writes pages.
  const curating = admin ? (view.tab === 'pending' ? <WikiPending /> : view.tab === 'review' ? <WikiReviewPane /> : null) : view.tab === 'pending' || view.tab === 'review' ? <AdminOnly>{L('Só um admin decide o que o curador muda e revisa a wiki.', "Only an admin decides the curator's changes and reviews the wiki.")}</AdminOnly> : null
  const content = view.source ? <WikiSourceView key={view.source} id={view.source} /> : view.title ? <WikiPageView key={view.title} title={view.title} data={data} /> : view.tab === 'sources' ? <WikiSources errors={dropError} /> : curating

  return (
    <Sheet
      fill
      title={L('Wiki', 'Wiki')}
      lede={
        count > 0
          ? [count === 1 ? L('1 página', '1 page') : L(`${count} páginas`, `${count} pages`), links === 1 ? L('1 ligação', '1 link') : L(`${links} ligações`, `${links} links`)].join(' · ')
          : L('O que você e o seu time sabem, em páginas ligadas.', 'What you and your team know, as linked pages.')
      }
      actions={
        <>
          {kinds.length > 1 && (
            <div className="wk-kinds" role="group" aria-label={L('Mostrar só um tipo', 'Show only one kind')}>
              {kinds.slice(0, 6).map(([k, n]) => (
                <button key={k} className={only === k ? 'is-on' : only ? 'is-dim' : ''} style={{ ['--k' as string]: kindColor(k) }} title={only === k ? L('Mostrar todas', 'Show all') : `${k} · ${n}`} onClick={() => setOnly(only === k ? null : k)}>
                  <i />
                  {k}
                </button>
              ))}
            </div>
          )}
          <button className="wk-search-btn" title={L(`Buscar (${SEARCH_KEY})`, `Search (${SEARCH_KEY})`)} onClick={() => setSearching(true)}>
            <Icon name="search" size={14} />
            <kbd>{SEARCH_KEY}</kbd>
          </button>
          {admin && (
            <button className="btn btn--ghost btn--sm wk-icon-btn" title={L('Ajustes da wiki', 'Wiki settings')} onClick={() => setSettings(true)}>
              <Icon name="gear" size={15} />
            </button>
          )}
          {data?.git?.readOnly && (
            <span className="wk-ro" title={L('A chave do Tucano só lê o repositório git: a wiki mostra o que está lá e não aceita escrita.', "Tucano's key only reads the git repository: the wiki shows what's there and takes no writes.")}>
              <Icon name="lock" size={12} /> {L('Só leitura', 'Read-only')}
            </span>
          )}
          <button className="btn btn--primary btn--sm" disabled={!!data?.git?.readOnly} title={data?.git?.readOnly ? L('A wiki está só leitura', 'The wiki is read-only') : L('Nova página (N)', 'New page (N)')} onClick={() => navigate({ kind: 'wiki', edit: true, title: '' })}>
            <Icon name="plus" size={14} /> {L('Nova página', 'New page')}
          </button>
        </>
      }
    >
      {admin && (pending.length > 0 || reading.length > 0 || (data?.findings ?? 0) > 0) && (
        <div className="cal-watch wk-watch">
          {pending.length > 0 && <span className="cal-watch__label">{L('Esperando você', 'Waiting for you')}</span>}
          {pending.slice(0, 3).map((c) => (
            <button key={c.id} className="cal-watch__chip wk-watch__chip wk-watch__chip--pending" onClick={() => navigate({ kind: 'wiki', tab: 'pending' })}>
              <i />
              <span>{c.reason || [...new Set(c.ops.map((o) => o.page))].join(', ')}</span>
            </button>
          ))}
          {pending.length > 3 && (
            <button className="cal-watch__chip" onClick={() => navigate({ kind: 'wiki', tab: 'pending' })}>
              {L(`+${pending.length - 3}`, `+${pending.length - 3}`)}
            </button>
          )}
          {reading.map((s) => (
            <button key={s.id} className="cal-watch__chip wk-watch__chip" onClick={() => navigate({ kind: 'wiki', source: s.file })}>
              <span className="wk-spin" />
              <span>{L(`Lendo ${s.title}`, `Reading ${s.title}`)}</span>
            </button>
          ))}
          {(data?.findings ?? 0) > 0 && (
            <button className="cal-watch__chip wk-watch__chip wk-watch__chip--care" onClick={() => navigate({ kind: 'wiki', tab: 'review' })}>
              <i />
              {data!.findings === 1 ? L('1 coisa pra cuidar', '1 thing to look after') : L(`${data!.findings} coisas pra cuidar`, `${data!.findings} things to look after`)}
            </button>
          )}
        </div>
      )}

      {data && <WikiHeritage held={data.held ?? []} notice={!!data.heritage} />}
      <div className="wk-stage" {...drop}>
        {data && count === 0 && !panel ? <WikiEmpty onImport={startImport} /> : data && <WikiCanvas graph={data.graph} selected={view.title} pending={touched} only={only} panel={panel} />}
        {panel && content && (
          <aside className="wk-panel" key={JSON.stringify([view.title, view.tab, view.source])}>
            <button className="wk-panel__close" title={L('Fechar (Esc)', 'Close (Esc)')} onClick={close}>
              <Icon name="x" size={15} />
            </button>
            {content}
          </aside>
        )}
        {dropping > 0 && (
          <div className="wk-drop">
            <div>
              <Icon name="down" size={22} />
              <b>{L('Solte pra trazer pra wiki', 'Drop to bring it into the wiki')}</b>
              <small>{L('PDF, Word, planilha ou texto. O curador lê e escreve nas páginas.', 'PDF, Word, spreadsheet or text. The curator reads it and writes in the pages.')}</small>
            </div>
          </div>
        )}
      </div>

      <footer className="cal-foot wk-foot">
        <button className="text-btn" onClick={() => navigate({ kind: 'wiki', tab: 'sources' })}>
          <Icon name="book" size={13} /> {data?.sources === 1 ? L('1 fonte', '1 source') : L(`${data?.sources ?? 0} fontes`, `${data?.sources ?? 0} sources`)}
        </button>
        {admin && (
          <>
            <button className="text-btn" onClick={() => navigate({ kind: 'wiki', tab: 'pending' })}>
              <Icon name="hand" size={13} /> {L('Decisões do curador', "The curator's changes")}
            </button>
            <button className="text-btn" onClick={() => navigate({ kind: 'wiki', tab: 'review' })}>
              <Icon name="shield" size={13} /> {L('Revisar a wiki', 'Review the wiki')}
            </button>
          </>
        )}
        <span className="grow" />
        <span>{L('Arraste um arquivo pra cá pra trazer pra wiki', 'Drag a file here to bring it in')}</span>
      </footer>
      {searching && <WikiSearch pages={data?.pages ?? []} onClose={() => setSearching(false)} />}
      {settings && <WikiSettingsDialog data={data} onClose={() => setSettings(false)} onImport={startImport} />}
      {imported && <ImportResult result={imported} onClose={() => setImported(null)} />}
    </Sheet>
  )
}

function WikiEmpty({ onImport }: { onImport: () => void }): ReactNode {
  // a little constellation, to show what it becomes
  const dots = [
    [120, 70, 'rose'],
    [210, 40, 'indigo'],
    [290, 95, 'teal'],
    [190, 135, 'amber'],
    [70, 140, 'violet'],
    [330, 30, 'indigo']
  ] as const
  const lines = [
    [0, 1],
    [1, 2],
    [1, 3],
    [0, 3],
    [0, 4],
    [2, 5],
    [1, 5]
  ]
  return (
    <div className="wk-empty">
      <svg viewBox="0 0 400 170" className="wk-empty__art">
        {lines.map(([a, b]) => (
          <line key={`${a}${b}`} x1={dots[a!]![0]} y1={dots[a!]![1]} x2={dots[b!]![0]} y2={dots[b!]![1]} />
        ))}
        {dots.map(([x, y, c], i) => (
          <circle key={i} cx={x} cy={y} r={i === 1 ? 11 : 7} style={{ fill: `var(--c-${c})`, ['--i' as string]: i }} />
        ))}
      </svg>
      <h2>{L('Tudo o que você sabe, num lugar só', 'Everything you know, in one place')}</h2>
      <p>
        {L(
          'Pessoas, clientes, projetos, decisões. Cada página liga com as outras, e os agentes leem tudo antes de responder. Você escreve, ou deixa o curador escrever pelas conversas e pelos documentos que você traz.',
          'People, clients, projects, decisions. Each page links to the others, and the agents read it all before replying. You write it, or let the curator write it from the conversations and the documents you bring.'
        )}
      </p>
      <div className="wk-empty__actions">
        <button className="btn btn--primary" onClick={() => navigate({ kind: 'wiki', edit: true, title: '' })}>
          <Icon name="edit" size={14} /> {L('Escrever a primeira página', 'Write the first page')}
        </button>
        <button className="btn" onClick={onImport}>
          <Icon name="folder" size={14} /> {L('Importar do Obsidian', 'Import from Obsidian')}
        </button>
      </div>
      <small className="muted">{L('Já tem um cofre no Obsidian? Ele entra como está, com pastas, links e anexos. O original fica onde está.', 'Already have an Obsidian vault? It comes in as it is, with folders, links and attachments. The original stays where it is.')}</small>
    </div>
  )
}

// What came in from a vault: how much, of what kinds, and what to look at next.
function ImportResult({ result, onClose }: { result: WikiImport | { error: string } | 'busy'; onClose: () => void }): ReactNode {
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && result !== 'busy' && onClose()}>
      <div className="form-modal wk-settings wk-import">
        {result === 'busy' ? (
          <div className="wk-import__busy">
            <span className="wk-spin" />
            <b>{L('Trazendo as notas…', 'Bringing the notes in…')}</b>
            <small className="muted">{L('Copiando as pastas e lendo os links.', 'Copying the folders and reading the links.')}</small>
          </div>
        ) : 'error' in result ? (
          <>
            <header>
              <h2>{L('Não deu pra importar', "Couldn't import")}</h2>
            </header>
            <p className="field__error">{result.error}</p>
            <div className="wk-row">
              <button className="btn btn--sm" onClick={onClose}>
                {L('Fechar', 'Close')}
              </button>
            </div>
          </>
        ) : (
          <>
            <header>
              <h2>{L(`${result.from} chegou`, `${result.from} is in`)}</h2>
            </header>
            <div className="wk-import__stats">
              <span>
                <b>{result.pages}</b>
                {result.pages === 1 ? L('nota', 'note') : L('notas', 'notes')}
              </span>
              <span>
                <b>{result.links}</b>
                {result.links === 1 ? L('ligação', 'link') : L('ligações', 'links')}
              </span>
              <span>
                <b>{result.attachments}</b>
                {result.attachments === 1 ? L('anexo', 'attachment') : L('anexos', 'attachments')}
              </span>
            </div>
            {result.kinds.length > 0 && (
              <div className="wk-page__chips">
                {result.kinds.slice(0, 10).map(([k, n]) => (
                  <span key={k} className="wk-pill" style={{ ['--k' as string]: kindColor(k) }}>
                    <i />
                    {k} · {n}
                  </span>
                ))}
              </div>
            )}
            <small className="muted">
              {L('Os agentes já leem essas páginas e citam elas nas respostas. O cofre original não mudou.', 'The agents already read these pages and cite them in their replies. The original vault is unchanged.')}
              {result.missing > 0 && ' ' + L(`${result.missing} ${result.missing === 1 ? 'link aponta' : 'links apontam'} pra notas que ainda não existem: aparecem tracejados no mapa.`, `${result.missing} ${result.missing === 1 ? 'link points' : 'links point'} to notes that don't exist yet: they're dashed on the map.`)}
              {result.skipped.length > 0 && ' ' + L(`${result.skipped.length} ${result.skipped.length === 1 ? 'arquivo já existia e ficou' : 'arquivos já existiam e ficaram'} como estava.`, `${result.skipped.length} ${result.skipped.length === 1 ? 'file was already here and was left' : 'files were already here and were left'} as they were.`)}
            </small>
            <div className="wk-row">
              <button className="btn btn--primary btn--sm" onClick={onClose}>
                {L('Ver o mapa', 'See the map')}
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => (onClose(), navigate({ kind: 'wiki', tab: 'review' }))}>
                {L('Revisar o que chegou', 'Review what came in')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- search ----------

function WikiSearch({ pages, onClose }: { pages: WikiPageInfo[]; onClose: () => void }): ReactNode {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<WikiHit[] | null>(null)
  const [at, setAt] = useState(0)
  useEffect(() => {
    if (!q.trim()) return setHits(null)
    const t = setTimeout(() => void call('wikiSearch', { q }).then((h) => (setHits(h), setAt(0))), 120)
    return () => clearTimeout(t)
  }, [q])
  const titleHits = q.trim() ? pages.filter((p) => fold(p.title).includes(fold(q))) : []
  const rows: { title: string; kind: string; snippet?: string }[] = q.trim()
    ? [...titleHits.map((p) => ({ title: p.title, kind: p.kind, snippet: p.summary })), ...(hits ?? []).filter((h) => !titleHits.some((p) => p.title === h.title))]
    : [...pages].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7).map((p) => ({ title: p.title, kind: p.kind, snippet: p.summary }))
  const open = (t?: string): void => {
    onClose()
    if (t) navigate({ kind: 'wiki', title: t })
    else if (q.trim()) navigate({ kind: 'wiki', title: q.trim(), edit: true })
  }
  return (
    <div className="modal wk-palette-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wk-palette">
        <div className="wk-palette__input">
          <Icon name="search" size={16} />
          <input
            autoFocus
            placeholder={L('Buscar uma pessoa, um projeto, uma decisão…', 'Search a person, a project, a decision…')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose()
              else if (e.key === 'ArrowDown') (e.preventDefault(), setAt((a) => Math.min(a + 1, rows.length)))
              else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((a) => Math.max(a - 1, 0)))
              else if (e.key === 'Enter') open(rows[at]?.title)
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="wk-palette__list">
          {!q.trim() && rows.length > 0 && <div className="wk-palette__label">{L('Mexidas há pouco', 'Recently touched')}</div>}
          {rows.map((r, i) => (
            <button key={r.title} className={`wk-palette__row ${i === at ? 'is-on' : ''}`} style={{ ['--k' as string]: kindColor(r.kind) }} onMouseEnter={() => setAt(i)} onClick={() => open(r.title)}>
              <i />
              <span>
                <b>{r.title}</b>
                {r.snippet && (
                  <small>
                    <Markdown urlTransform={safeUrl} allowedElements={['p', 'strong', 'em']} unwrapDisallowed>
                      {r.snippet}
                    </Markdown>
                  </small>
                )}
              </span>
              <em>{r.kind}</em>
            </button>
          ))}
          {q.trim() && (
            <button className={`wk-palette__row wk-palette__new ${at === rows.length ? 'is-on' : ''}`} onMouseEnter={() => setAt(rows.length)} onClick={() => open()}>
              <Icon name="plus" size={14} />
              <span>
                <b>{L(`Escrever “${q.trim()}”`, `Write “${q.trim()}”`)}</b>
                <small>{rows.length ? L('Uma página nova com esse título', 'A new page with that title') : L('Nada com esse nome ainda', 'Nothing by that name yet')}</small>
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- settings ----------

function WikiSettingsDialog({ data, onClose, onImport }: { data: WikiData | null; onClose: () => void; onImport: () => void }): ReactNode {
  const s = useStore((st) => st.settings)
  const capture = s.wikiCapture !== false
  const edits = s.wikiEdits ?? 'approve'
  const [dir, setDir] = useState(data?.dir ?? '')
  const [error, setError] = useState('')
  const pick = (window.tucano as unknown as { pickFolder?: () => Promise<string | null> }).pickFolder
  const move = (to: string | null): void => void call('setWikiDir', { dir: to }).then((d) => (setDir(d), setError('')), (e: Error) => setError(e.message))
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => void (e.key === 'Escape' && onClose())
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="form-modal wk-settings">
        <header>
          <h2>{L('Ajustes da wiki', 'Wiki settings')}</h2>
          <button className="btn btn--ghost btn--sm wk-icon-btn" onClick={onClose}>
            <Icon name="x" size={15} />
          </button>
        </header>

        <section>
          <h4>{L('O curador', 'The curator')}</h4>
          <div className="wk-setting">
            <span>
              <b>{L('Guardar das conversas', 'Keep from conversations')}</b>
              <small>{L('Depois que uma conversa assenta, ele guarda as decisões, os fatos e os resultados nas páginas. Dá pra desligar por canal ou DM, no menu da conversa.', 'Once a conversation settles, it keeps the decisions, facts and results in the pages. It can be turned off per channel or DM, from the conversation menu.')}</small>
            </span>
            <Toggle on={capture} onChange={(v) => updateSettings({ wikiCapture: v })} />
          </div>
          <div className="wk-setting">
            <span>
              <b>{L('Mudar uma página que já existe', 'Changing a page that exists')}</b>
              <small>{L('Páginas novas sempre entram direto. No automático, o que já estava esperando entra junto. Tudo fica no histórico, com Desfazer.', 'New pages always go in right away. On automatic, what was already waiting goes in too. It all stays in the history, with Undo.')}</small>
            </span>
            <div className="segmented">
              <button className={edits === 'approve' ? 'is-active' : ''} onClick={() => updateSettings({ wikiEdits: 'approve' })}>
                {L('Pede aprovação', 'Asks first')}
              </button>
              <button className={edits === 'auto' ? 'is-active' : ''} onClick={() => (updateSettings({ wikiEdits: 'auto' }), void call('wikiApplyWaiting').catch((e: Error) => setError(e.message)))}>
                {L('Automático', 'Automatic')}
              </button>
            </div>
          </div>
          <div className="wk-setting">
            <span>
              <b>{L('Revisar sozinha toda semana', 'Review on its own every week')}</b>
              <small>{L('Procura o que não bate, o que ficou velho e o que está repetido. O que achar espera você em Cuidados.', 'Looks for what disagrees, what got old and what repeats. What it finds waits for you in Care.')}</small>
            </span>
            <Toggle on={s.wikiReview === 'weekly'} onChange={(v) => updateSettings({ wikiReview: v ? 'weekly' : 'off' })} />
          </div>
        </section>

        <section>
          <h4>{L('A pasta', 'The folder')}</h4>
          <code className="wk-folder" title={dir}>
            <Icon name="folder" size={14} />
            {dir.replace(/^\/Users\/[^/]+/, '~')}
          </code>
          <small className="muted">{L('Markdown puro: abre no Obsidian, vai pro iCloud ou pro git. Pode ser o seu cofre do Obsidian.', 'Plain Markdown: it opens in Obsidian, goes to iCloud or git. It can be your Obsidian vault.')}</small>
          <div className="wk-row">
            {data && !data.server && (
              <button className="btn btn--sm" onClick={() => void call('openWikiFolder')}>
                {L('Abrir pasta', 'Open folder')}
              </button>
            )}
            {pick && !data?.git && (
              <button
                className="btn btn--sm"
                onClick={() =>
                  void pick().then((p) => {
                    if (!p) return
                    void confirmDialog({
                      title: L('Trocar a pasta da wiki?', "Change the wiki's folder?"),
                      body: L(`A wiki passa a mostrar o que está em ${p}. As páginas da pasta atual continuam lá.`, `The wiki will show what's in ${p}. The pages in the current folder stay there.`),
                      confirm: L('Usar essa pasta', 'Use this folder')
                    }).then((ok) => {
                      if (ok) move(p)
                    })
                  })
                }
              >
                {L('Trocar pasta…', 'Change folder…')}
              </button>
            )}
            {s.wikiDir && !data?.git && (
              <button className="btn btn--ghost btn--sm" onClick={() => move(null)}>
                {L('Voltar pra pasta do Tucano', "Back to Tucano's folder")}
              </button>
            )}
          </div>
          {error && <small className="field__error">{error}</small>}
          <GitSync dir={dir} onDir={setDir} />
        </section>

        <section>
          <h4>{L('Trazer o que você já tem', 'Bring what you already have')}</h4>
          <div className="wk-setting">
            <span>
              <b>{L('Importar um cofre do Obsidian', 'Import an Obsidian vault')}</b>
              <small>
                {window.tucano.upload
                  ? L('Compacte a pasta do cofre num .zip e envie: as notas entram como estão, com as pastas, os links e os anexos.', 'Zip the vault’s folder and send it: the notes come in as they are, with their folders, links and attachments.')
                  : L('As notas entram como estão, com as pastas, os links e os anexos. O cofre original não muda.', 'The notes come in as they are, with their folders, links and attachments. The original vault stays as it was.')}
              </small>
            </span>
            <button className="btn btn--sm" onClick={onImport}>
              {L('Importar…', 'Import…')}
            </button>
          </div>
        </section>

        <section>
          <h4>{L('As regras', 'The rules')}</h4>
          <div className="wk-setting">
            <span>
              <b>{L('Esquema da wiki', 'Wiki schema')}</b>
              <small>{L('Os tipos de página e como escrever. Os agentes e o curador seguem esta página.', 'The kinds of page and how to write. The agents and the curator follow this page.')}</small>
            </span>
            <button className="btn btn--sm" onClick={() => (onClose(), navigate({ kind: 'wiki', edit: true }))}>
              {L('Editar', 'Edit')}
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}

// ---------- the folder in a git repository ----------

const hostName = (h?: string): string => (h === 'github' ? 'GitHub' : h === 'gitlab' ? 'GitLab' : h === 'bitbucket' ? 'Bitbucket' : h === 'gitea' ? 'Gitea' : '')
const errText = (e: Error): string => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// Ajustes da wiki › A pasta › Sincronizar com git: the address, the deploy key, a test, then connected.
function GitSync({ dir, onDir }: { dir: string; onDir: (d: string) => void }): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [st, setSt] = useState<WikiGitStatus | null>(null)
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'' | 'setup' | 'test' | 'connect' | 'sync'>('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [test, setTest] = useState<WikiGitTest | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => void call('wikiGitStatus').then(setSt, () => {}), [rev])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(t)
  }, [])
  if (!st) return null
  const run = <T,>(what: typeof busy, p: Promise<T>, then?: (v: T) => void): void => {
    setBusy(what)
    setError('')
    void p.then(
      (v) => (then?.(v), setBusy('')),
      (e: Error) => (setError(errText(e)), setBusy(''))
    )
  }
  const shownTest = test ?? st.test ?? null
  const setup = st.setup

  if (st.state === 'off' && !open)
    return (
      <div className="wk-setting wk-git">
        <span>
          <b>{L('Sincronizar com git', 'Sync with git')}</b>
          <small>{L('A wiki vira um clone do seu repositório (o cofre do Obsidian no GitHub, por exemplo): o que muda lá aparece aqui, e o que muda aqui vai pra lá.', 'The wiki becomes a clone of your repository (your Obsidian vault on GitHub, say): what changes there shows up here, and what changes here goes there.')}</small>
        </span>
        <button className="btn btn--sm" onClick={() => setOpen(true)}>
          {L('Configurar…', 'Set up…')}
        </button>
      </div>
    )

  // ---------- connected ----------
  if (st.state === 'ok' || st.state === 'syncing' || st.state === 'error') {
    const ago = st.lastSync ? rel(st.lastSync) : ''
    return (
      <div className="wk-git wk-git--on">
        <div className="wk-git__status">
          <i className={`wk-git__dot wk-git__dot--${st.state === 'error' ? 'bad' : st.state === 'syncing' ? 'busy' : 'ok'}`} />
          <span>
            <b>{st.state === 'syncing' ? L('Sincronizando…', 'Syncing…') : st.state === 'error' ? L('A sincronização parou', 'Syncing stopped') : L('Sincronizada com git', 'Synced with git')}</b>
            <small>
              {setup?.sshUrl ?? ''}
              {st.branch ? ` · ${st.branch}` : ''}
              {ago ? ` · ${L(`última vez ${ago}`, `last ${ago}`)}` : ''}
            </small>
          </span>
          {st.readOnly && (
            <span className="wk-ro">
              <Icon name="lock" size={12} /> {L('Só leitura', 'Read-only')}
            </span>
          )}
        </div>
        {st.error && (
          <p className="wk-git__error">
            {st.error.message}
            {st.nextTry && st.nextTry > now ? ` ${L(`Tento de novo em ${Math.max(1, Math.round((st.nextTry - now) / 60_000))} min.`, `Trying again in ${Math.max(1, Math.round((st.nextTry - now) / 60_000))} min.`)}` : ''}
          </p>
        )}
        {st.readOnly && (
          <p className="wk-git__note">
            {L('A chave do Tucano só pode ler esse repositório: a wiki mostra o que está lá e não aceita escrita (nem sua, nem dos agentes, nem do curador). O que não chegou a ir ficou na pasta (uma página que o repositório também tem, como "(versão do Tucano)"). Pra escrever, marque "Allow write access" na chave de deploy e toque em Tentar escrever de novo.', "Tucano's key can only read this repository: the wiki shows what's there and takes no writes (yours, the agents' or the curator's). What didn't get sent stayed in the folder (a page the repository has too, as \"(Tucano’s version)\"). To write, tick \"Allow write access\" on the deploy key and click Try writing again.")}
          </p>
        )}
        {st.skipped.length > 0 && (
          <p className="wk-git__note">
            {L('Ficaram fora do repositório (mais de 50 MB): ', 'Kept out of the repository (over 50 MB): ')}
            {st.skipped.map((f) => `${f.path} (${f.mb} MB)`).join(', ')}
          </p>
        )}
        <div className="wk-row">
          <button className={`btn btn--sm ${busy === 'sync' || st.state === 'syncing' ? 'is-busy' : ''}`} disabled={!!busy || st.state === 'syncing'} onClick={() => run('sync', call('wikiGitSync', {}), setSt)}>
            {busy === 'sync' || st.state === 'syncing' ? <span className="wk-spin" /> : null} {L('Sincronizar agora', 'Sync now')}
          </button>
          {st.readOnly && (
            <button className="btn btn--sm" disabled={!!busy} onClick={() => run('sync', call('wikiGitSync', { write: true }), setSt)}>
              {L('Tentar escrever de novo', 'Try writing again')}
            </button>
          )}
          {setup?.deployKeyUrl && (
            <button className="btn btn--ghost btn--sm" onClick={() => openExternal(setup.deployKeyUrl!)}>
              {L('Chaves do repositório', "The repository's keys")}
            </button>
          )}
          <button
            className="btn btn--ghost btn--sm"
            onClick={() =>
              void confirmDialog({
                title: L('Desconectar do git?', 'Disconnect from git?'),
                body: L('A wiki para de sincronizar e o Tucano apaga a chave dele. A pasta continua como está, com as páginas. No repositório, apague também a chave de deploy.', "The wiki stops syncing and Tucano deletes its key. The folder stays as it is, with the pages. In the repository, delete the deploy key too."),
                confirm: L('Desconectar', 'Disconnect')
              }).then((ok) => ok && run('sync', call('wikiGitDisconnect'), (v) => (setSt(v), setOpen(false), setTest(null))))
            }
          >
            {L('Desconectar', 'Disconnect')}
          </button>
        </div>
        {error && <small className="field__error">{error}</small>}
      </div>
    )
  }

  // ---------- setting up ----------
  const connect = (how: 'repo' | 'merge'): void =>
    run('connect', call('wikiGitConnect', { how }), (v) => {
      setSt(v)
      setTest(null)
      void call('wiki').then((d) => onDir((d as WikiData).dir || dir))
    })
  return (
    <div className="wk-git wk-git--setup">
      <b>{L('Sincronizar com git', 'Sync with git')}</b>
      <label className="wk-git__step">
        <span>{L('1. O endereço SSH do repositório', "1. The repository's SSH address")}</span>
        <div className="wk-row">
          <input className="input" placeholder="git@github.com:voce/cofre.git" value={url || (setup ? setup.sshUrl : '')} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
          <button className={`btn btn--sm ${busy === 'setup' ? 'is-busy' : ''}`} disabled={!!busy || !url.trim()} onClick={() => run('setup', call('wikiGitSetup', { url }), () => (setUrl(''), setTest(null), void call('wikiGitStatus').then(setSt)))}>
            {setup ? L('Trocar', 'Change') : L('Continuar', 'Continue')}
          </button>
        </div>
        <small className="muted">{L('No GitHub: o botão Code › SSH. Um endereço https também serve: o Tucano mostra o SSH dele.', 'On GitHub: the Code button › SSH. An https address works too: Tucano shows its SSH one.')}</small>
      </label>
      {setup && (
        <>
          {setup.converted && <small className="wk-git__note">{L(`Esse endereço era https. O Tucano usa o SSH dele: ${setup.sshUrl}`, `That address was https. Tucano uses its SSH one: ${setup.sshUrl}`)}</small>}
          <div className="wk-git__step">
            <span>{L('2. A chave do Tucano pra esse repositório', "2. Tucano's key for this repository")}</span>
            <code className="wk-git__key">{setup.publicKey}</code>
            <div className="wk-row">
              <button className="btn btn--sm" onClick={() => void navigator.clipboard.writeText(setup.publicKey).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
                <Icon name={copied ? 'check' : 'copy'} size={13} /> {copied ? L('Copiada', 'Copied') : L('Copiar', 'Copy')}
              </button>
              {setup.deployKeyUrl && (
                <button className="btn btn--sm" onClick={() => openExternal(setup.deployKeyUrl!)}>
                  <Icon name="globe" size={13} /> {L(`Adicionar no ${hostName(setup.provider)}`, `Add it on ${hostName(setup.provider)}`)}
                </button>
              )}
            </div>
            <ol className="wk-git__steps">
              <li>{setup.deployKeyUrl ? L(`Na página que abre (Deploy keys › Add deploy key), cole a chave em Key. No título, algo como Tucano.`, 'On the page that opens (Deploy keys › Add deploy key), paste the key into Key. For the title, something like Tucano.') : L(`Nas configurações do repositório em ${setup.host}, procure Deploy keys e adicione a chave.`, `In the repository's settings on ${setup.host}, find Deploy keys and add the key.`)}</li>
              <li>{setup.provider === 'bitbucket' ? L('No Bitbucket, a chave de acesso só lê: a wiki fica só leitura.', 'On Bitbucket, an access key only reads: the wiki will be read-only.') : L('Marque "Allow write access" pra o Tucano ler e escrever. Sem marcar, a wiki fica só leitura.', 'Tick "Allow write access" for Tucano to read and write. Leave it off and the wiki is read-only.')}</li>
              <li>{L('Salve a chave e volte aqui.', 'Save the key and come back here.')}</li>
            </ol>
          </div>
          <div className="wk-git__step">
            <span>{L('3. Testar', '3. Test')}</span>
            <div className="wk-row">
              <button className={`btn btn--sm ${busy === 'test' ? 'is-busy' : ''}`} disabled={!!busy} onClick={() => run('test', call('wikiGitTest'), (t) => (setTest(t), void call('wikiGitStatus').then(setSt)))}>
                {busy === 'test' ? <span className="wk-spin" /> : null} {busy === 'test' ? L('Testando…', 'Testing…') : L('Testar conexão', 'Test the connection')}
              </button>
            </div>
            {shownTest && (
              <p className="wk-git__ok">
                <Icon name="check" size={13} />{' '}
                {shownTest.empty
                  ? L('Conectou. O repositório está vazio: as páginas daqui vão ser o começo dele.', "Connected. The repository is empty: the pages here will be its start.")
                  : L(`Conectou. O repositório tem ${shownTest.pages} ${shownTest.pages === 1 ? 'página' : 'páginas'}, ${shownTest.pdfs} PDF${shownTest.pdfs === 1 ? '' : 's'} e ${shownTest.docx} docx, na branch ${shownTest.branch}.`, `Connected. The repository has ${shownTest.pages} ${shownTest.pages === 1 ? 'page' : 'pages'}, ${shownTest.pdfs} PDF${shownTest.pdfs === 1 ? '' : 's'} and ${shownTest.docx} docx, on the ${shownTest.branch} branch.`)}
              </p>
            )}
          </div>
          {shownTest && (
            <div className="wk-git__step">
              <span>{L('4. Conectar', '4. Connect')}</span>
              {shownTest.currentPages > 0 ? (
                <>
                  <small className="muted">
                    {L(
                      `A wiki daqui já tem ${shownTest.currentPages} ${shownTest.currentPages === 1 ? 'página' : 'páginas'}. Nos dois jeitos, a pasta atual fica guardada como está, e a wiki passa a ser o clone do repositório.`,
                      `The wiki here already has ${shownTest.currentPages} ${shownTest.currentPages === 1 ? 'page' : 'pages'}. Either way, the current folder stays as it is, and the wiki becomes the repository's clone.`
                    )}
                  </small>
                  <div className="wk-git__choices">
                    <button className="wk-git__choice" disabled={!!busy} onClick={() => connect('repo')}>
                      <b>{L('Usar o repositório', 'Use the repository')}</b>
                      <small>{L('A wiki mostra só o que está no repositório. As páginas daqui ficam na pasta antiga, de backup.', 'The wiki shows only what is in the repository. The pages here stay in the old folder, as a backup.')}</small>
                    </button>
                    <button className="wk-git__choice" disabled={!!busy} onClick={() => connect('merge')}>
                      <b>{L('Juntar com as daqui', 'Merge with these')}</b>
                      <small>{L('As páginas daqui entram no repositório. Nada de lá é sobrescrito: uma página com o mesmo nome entra como "(versão do Tucano)".', 'The pages here go into the repository. Nothing there is overwritten: a page with the same name comes in as "(Tucano’s version)".')}</small>
                    </button>
                  </div>
                </>
              ) : (
                <div className="wk-row">
                  <button className={`btn btn--primary btn--sm ${busy === 'connect' ? 'is-busy' : ''}`} disabled={!!busy} onClick={() => connect('repo')}>
                    {L('Conectar', 'Connect')}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
      {error && <small className="field__error">{error}</small>}
      {st.state === 'off' && (
        <div className="wk-row">
          <button className="btn btn--ghost btn--sm" onClick={() => (setOpen(false), setError(''))}>
            {L('Cancelar', 'Cancel')}
          </button>
        </div>
      )}
      {st.state === 'setup' && (
        <div className="wk-row">
          <button className="btn btn--ghost btn--sm" disabled={!!busy} onClick={() => run('sync', call('wikiGitDisconnect'), (v) => (setSt(v), setOpen(false), setTest(null)))}>
            {L('Cancelar e apagar a chave', 'Cancel and delete the key')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- changes ----------

// One change, as the curator wrote it: what goes where. What leaves and what comes in are each
// labelled and wrap in full; a long change opens short, with "Ver tudo" for the rest.
function OpView({ op }: { op: WikiChange['ops'][number] }): ReactNode {
  const md = (t?: string): ReactNode => (
    <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={mdLinks()}>
      {wikiLinks(t ?? '')}
    </Markdown>
  )
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const fit = (): void => setLong(el.scrollHeight > DIFF_FOLD + 140)
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [op])
  const added = (op.op === 'replace' ? op.new : op.text) ?? ''
  const folded = long && !open
  return (
    <div className={`wiki-op wiki-op--${op.op}`}>
      <div className="wiki-op__head">
        <span className="wiki-op__verb">{op.op === 'create' ? L('Página nova', 'New page') : op.op === 'append' ? L('Acrescenta em', 'Adds to') : L('Troca em', 'Swaps in')}</span>
        <button className="wiki-link" onClick={() => navigate({ kind: 'wiki', title: op.page })}>
          {op.page}
        </button>
        {op.section && <span className="muted">› {op.section}</span>}
      </div>
      <div ref={box} className={`wiki-diff${folded ? ' is-folded' : ''}`} style={folded ? { maxHeight: DIFF_FOLD } : undefined}>
        {op.op === 'replace' && (
          <div className="wiki-diff__old">
            <span className="wiki-diff__tag">{L('Sai', 'Out')}</span>
            <div className="md">{md(op.old)}</div>
          </div>
        )}
        <div className={`wiki-diff__new${added.trim() ? '' : ' wiki-diff__new--none'}`}>
          {op.op !== 'create' && <span className="wiki-diff__tag">{L('Entra', 'In')}</span>}
          {added.trim() ? <div className="md">{md(added)}</div> : <p className="muted">{L('Nada no lugar: o trecho só sai da página.', 'Nothing in its place: the passage just leaves the page.')}</p>}
        </div>
      </div>
      {long && (
        <button className="text-btn wiki-diff__more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? L('Ver menos', 'Show less') : L('Ver tudo', 'Show all')}
        </button>
      )}
    </div>
  )
}
const DIFF_FOLD = 360 // px a long change shows before "Ver tudo"; a bit longer than that shows whole

const STATE_LABEL = (s: WikiChange['state']): string =>
  s === 'pending' ? L('Esperando você', 'Waiting for you') : s === 'conflict' ? L('A página mudou depois', 'The page changed since') : s === 'applied' ? L('Entrou', 'Went in') : s === 'undone' ? L('Desfeita', 'Undone') : L('Recusada', 'Refused')

export function ChangeCard({ change, compact, bare }: { change: WikiChange; compact?: boolean; bare?: boolean }): ReactNode {
  const [error, setError] = useState('')
  const who = useWho()
  const act = (p: Promise<unknown>): void => void p.then(() => setError(''), (e: Error) => setError(e.message))
  return (
    <section className={`wiki-change wiki-change--${change.state}`}>
      {!bare && (
        <header>
          {change.state !== 'pending' && <span className={`wiki-change__state wiki-change__state--${change.state}`}>{STATE_LABEL(change.state)}</span>}
          {change.reason && <b className="wiki-change__why">{change.reason}</b>}
          <small className="muted">
            {who(change.by)} · {rel(change.at)}
            {change.source && (
              <>
                {' · '}
                <button className="text-btn" onClick={() => navigate({ kind: 'wiki', source: change.source!.file })}>
                  {L('de onde veio', 'where it came from')}
                </button>
              </>
            )}
          </small>
        </header>
      )}
      {!compact && <div className="wiki-change__ops">{change.ops.map((op, k) => <OpView key={k} op={op} />)}</div>}
      {error && <p className="field__error">{error}</p>}
      {(change.state === 'pending' || change.state === 'conflict') && (
        <div className="wiki-change__actions">
          {change.state === 'conflict' && (
            <>
              <small className="muted">{L('A página mudou depois dessa sugestão. O curador refaz a mudança sobre a versão nova, sem perder o que mudou.', 'The page changed after this suggestion. The curator makes the change again on the newer version, keeping what changed.')}</small>
              <button className="btn btn--primary btn--sm" onClick={() => act(call('wikiRedoChange', { id: change.id }))}>
                {L('Refazer sobre a versão nova', 'Redo on the newer version')}
              </button>
            </>
          )}
          {change.state === 'pending' && (
            <button className="btn btn--primary btn--sm" onClick={() => act(call('wikiApplyChange', { id: change.id }))}>
              <Icon name="check" size={13} /> {L('Aprovar', 'Approve')}
            </button>
          )}
          <button className="btn btn--ghost btn--sm" onClick={() => act(call('wikiRefuseChange', { id: change.id }))}>
            {L('Recusar', 'Refuse')}
          </button>
        </div>
      )}
      {change.state === 'applied' && !compact && (
        <div className="wiki-change__actions">
          <button className="btn btn--ghost btn--sm" onClick={() => act(call('wikiUndoChange', { id: change.id }))}>
            {L('Desfazer', 'Undo')}
          </button>
        </div>
      )}
    </section>
  )
}

function PaneHead({ icon, title, lede, children }: { icon: IconName; title: string; lede: ReactNode; children?: ReactNode }): ReactNode {
  return (
    <header className="wk-pane-head">
      <span className="wk-pane-head__icon">
        <Icon name={icon} size={18} />
      </span>
      <div>
        <h2>{title}</h2>
        <p>{lede}</p>
      </div>
      {children && <div className="wk-pane-head__actions">{children}</div>}
    </header>
  )
}

function WikiPending(): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [list, setList] = useState<WikiChange[] | null>(null)
  const [recent, setRecent] = useState<WikiChange[]>([])
  const [showRecent, setShowRecent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => void Promise.all([call('wikiChanges', { state: 'pending' }), call('wikiChanges', { state: 'conflict' })]).then(([a, b]) => setList([...a, ...b].filter((c) => c.by !== 'review'))), [rev])
  useEffect(() => void call('wikiChanges', {}).then((all) => setRecent(all.filter((c) => c.state !== 'pending' && c.state !== 'conflict' && c.by !== 'review').slice(0, 12))), [rev])
  if (!list) return null
  return (
    <div className="wk-pane">
      <PaneHead icon="hand" title={L('Esperando você', 'Waiting for you')} lede={L('O que o curador quer mudar em páginas que já existem. Aprove, recuse, ou mude o jeito nos ajustes.', 'What the curator wants to change in pages that already exist. Approve, refuse, or change how it works in the settings.')}>
        {list.length > 1 && (
          <button className="btn btn--primary btn--sm" disabled={busy} onClick={() => (setBusy(true), setError(''), void call('wikiApplyWaiting').then((r) => r.left && setError(L(`${r.left} não deu pra aprovar sozinha: a página mudou demais. Refaça cada uma abaixo.`, `${r.left} couldn't be approved on their own: the page changed too much. Redo each one below.`)), (e: Error) => setError(e.message)).finally(() => setBusy(false)))}>
            <Icon name="check" size={13} /> {L(`Aprovar todas (${list.length})`, `Approve all (${list.length})`)}
          </button>
        )}
      </PaneHead>
      {error && <p className="field__error">{error}</p>}
      {list.length === 0 ? (
        <div className="wk-calm">
          <Icon name="check" size={18} />
          <span>{L('Nada esperando você.', 'Nothing waiting for you.')}</span>
        </div>
      ) : (
        list.map((c) => <ChangeCard key={c.id} change={c} />)
      )}
      {recent.length > 0 && (
        <>
          <button className="text-btn wk-more" onClick={() => setShowRecent(!showRecent)}>
            {L('Decididas há pouco', 'Recently decided')} ({recent.length}) {showRecent ? '▾' : '▸'}
          </button>
          {showRecent && recent.map((c) => <ChangeCard key={c.id} change={c} />)}
        </>
      )}
    </div>
  )
}

// ---------- looking after the wiki ----------

const FINDING_LABEL: Record<WikiFinding['kind'], () => string> = {
  contradiction: () => L('Não batem', "Don't agree"),
  stale: () => L('Desatualizada', 'Out of date'),
  duplicate: () => L('Repetida', 'Duplicate'),
  link: () => L('Falta ligar', 'Missing link'),
  broken: () => L('Página por escrever', 'Page to write'),
  missing: () => L('Sem página', 'No page'),
  orphan: () => L('Ninguém liga pra elas', 'Nothing links to them'),
  log: () => L('Parece um registro', 'Reads like a log'),
  git: () => L('Repositório git', 'Git repository')
}
const FINDING_TONE: Record<WikiFinding['kind'], 'danger' | 'warn' | 'calm'> = { contradiction: 'danger', stale: 'warn', duplicate: 'warn', link: 'calm', broken: 'calm', missing: 'calm', orphan: 'calm', log: 'warn', git: 'warn' }
const FINDING_ORDER: WikiFinding['kind'][] = ['git', 'contradiction', 'stale', 'duplicate', 'log', 'link', 'broken', 'missing', 'orphan']

function WikiReviewPane(): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [r, setR] = useState<WikiReview | null>(null)
  useEffect(() => void call('wikiReview').then(setR), [rev])
  if (!r) return null
  const sorted = [...r.findings].sort((a, b) => FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind))
  const md = (t: string): ReactNode => (
    <Markdown urlTransform={safeUrl} components={{ ...mdLinks(), p: (p) => <span>{p.children}</span> }}>{wikiLinks(t)}</Markdown>
  )
  return (
    <div className="wk-pane">
      <PaneHead
        icon="shield"
        title={L('Cuidados', 'Care')}
        lede={
          r.running
            ? L('Lendo as páginas… Leva um ou dois minutos.', 'Reading the pages… It takes a minute or two.')
            : r.at
              ? L(`Revisada ${rel(r.at)}. A próxima lê só o que mudou desde então.`, `Reviewed ${rel(r.at)}. The next one reads only what changed since.`)
              : L('Uma leitura da wiki inteira: o que não bate, o que ficou velho, o que está repetido, links quebrados. Nada muda sem você.', 'A read of the whole wiki: what disagrees, what got old, what repeats, broken links. Nothing changes without you.')
        }
      >
        <button className={`btn btn--primary btn--sm ${r.running ? 'is-busy' : ''}`} disabled={r.running} onClick={() => (setR({ ...r, running: true }), void call('wikiRunReview'))}>
          {r.running ? <span className="wk-spin" /> : <Icon name="spark" size={13} />} {r.running ? L('Revisando…', 'Reviewing…') : L('Revisar agora', 'Review now')}
        </button>
      </PaneHead>
      {r.error && <p className="field__error">{L(`A última revisão não conseguiu ler as páginas com o modelo: ${r.error}`, `The last review couldn't read the pages with the model: ${r.error}`)}</p>}
      {!r.at && !r.running && sorted.length === 0 && (
        <div className="wk-checks">
          {(
            [
              ['danger', L('Não batem', "Don't agree"), L('Duas páginas dizendo coisas diferentes sobre o mesmo valor, data ou prazo.', 'Two pages saying different things about the same amount, date or deadline.')],
              ['warn', L('Desatualizada', 'Out of date'), L('"Aguardando resposta" numa página, "contrato assinado" em outra.', '"Waiting for an answer" on one page, "contract signed" on another.')],
              ['warn', L('Repetida', 'Duplicate'), L('Duas páginas sobre a mesma pessoa ou o mesmo projeto. Ela junta, sem perder nada.', 'Two pages about the same person or project. It merges them, losing nothing.')],
              ['warn', L('Parece um registro', 'Reads like a log'), L('Um histórico que virou diário do que foi feito. Ela resume no que vale hoje.', 'A history that turned into a diary of what was done. It condenses it into what holds today.')],
              ['calm', L('Solta', 'Loose'), L('Links pra páginas que não existem, nomes sem página, páginas que ninguém cita.', 'Links to missing pages, names with no page, pages nothing cites.')]
            ] as const
          ).map(([tone, t, d]) => (
            <div key={t} className="wk-check" style={{ ['--tone' as string]: tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--text-3)' }}>
              <i />
              <span>
                <b>{t}</b>
                <small>{d}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      {r.at && !r.running && sorted.length === 0 && (
        <div className="wk-calm">
          <Icon name="check" size={18} />
          <span>{L('Tudo em ordem. Nada pra cuidar agora.', 'All in order. Nothing to look after now.')}</span>
        </div>
      )}
      {sorted.map((f) => (
        <section key={f.id} className={`wk-finding wk-finding--${FINDING_TONE[f.kind]}`}>
          <div className="wk-finding__head">
            <span className="wk-finding__kind">{FINDING_LABEL[f.kind]()}</span>
            <div className="wk-finding__text md">{md(f.text)}</div>
          </div>
          {f.change ? (
            <ChangeCard change={f.change} bare />
          ) : (
            <div className="wk-finding__actions">
              {f.name && (f.kind === 'broken' || f.kind === 'missing') && (
                <button className="btn btn--sm" onClick={() => navigate({ kind: 'wiki', title: f.name!, edit: true })}>
                  <Icon name="edit" size={13} /> {L('Escrever a página', 'Write the page')}
                </button>
              )}
              <button className="btn btn--ghost btn--sm" onClick={() => void call('wikiDismissFinding', { id: f.id })}>
                {L('Deixar assim', 'Leave it')}
              </button>
            </div>
          )}
        </section>
      ))}
    </div>
  )
}

// ---------- sources ----------

const ACCEPT = '.pdf,.docx,.xlsx,.csv,.txt,.md,.markdown,.json'

// Files as base64, one after the other; what fails says why.
export async function addWikiFiles(files: File[]): Promise<string[]> {
  const errors: string[] = []
  for (const f of files) {
    try {
      const data = await new Promise<string>((res, rej) => {
        const r = new FileReader()
        r.onload = () => res(String(r.result).split(',')[1] ?? '')
        r.onerror = () => rej(r.error ?? new Error('read'))
        r.readAsDataURL(f)
      })
      await call('wikiAddFile', { name: f.name, data })
    } catch (e) {
      errors.push(`${f.name}: ${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)}`)
    }
  }
  return errors
}

// What a source is, as a small badge: the file's type, or an icon.
function SourceBadge({ s }: { s: Pick<WikiSource, 'kind' | 'title' | 'origin'> }): ReactNode {
  if (s.kind === 'file') {
    const ext = ((s.origin.original ?? s.title).split('.').pop() ?? '').toLowerCase()
    const [label, color] = ext === 'pdf' ? ['PDF', 'rose'] : ext === 'docx' ? ['DOC', 'indigo'] : ext === 'xlsx' || ext === 'csv' ? ['XLS', 'green'] : ['TXT', 'graphite']
    return (
      <span className="wk-badge-file" style={{ ['--k' as string]: `var(--c-${color})` }}>
        {label}
      </span>
    )
  }
  const icon: IconName = s.kind === 'link' ? 'globe' : s.kind === 'note' ? 'edit' : 'hash'
  return (
    <span className="wk-badge-file wk-badge-file--icon">
      <Icon name={icon} size={14} />
    </span>
  )
}
const KIND_LABEL = (k: WikiSource['kind']): string => ({ conversation: L('conversa', 'conversation'), message: L('mensagem guardada', 'kept message'), note: L('anotação', 'note'), file: L('arquivo', 'file'), link: 'link' })[k]

function SourceStatus({ s }: { s: WikiSource }): ReactNode {
  if (s.status === 'reading')
    return (
      <span className="wk-status wk-status--reading">
        <span className="wk-spin" /> {L('o curador está lendo', 'the curator is reading')}
      </span>
    )
  if (s.status === 'failed')
    return (
      <span className="wk-status wk-status--failed" title={s.error}>
        {L('não deu pra ler', "couldn't read it")}
      </span>
    )
  if (s.status === 'done') return <span className="wk-status wk-status--done">{s.changes ? (s.changes === 1 ? L('virou 1 mudança', 'became 1 change') : L(`virou ${s.changes} mudanças`, `became ${s.changes} changes`)) : L('nada novo', 'nothing new')}</span>
  return null
}

function AddSources({ errors: dropped }: { errors: string[] }): ReactNode {
  const [link, setLink] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [errors, setErrors] = useState<string[]>(dropped)
  useEffect(() => setErrors(dropped), [dropped])
  const files = (list: FileList | null): void => {
    if (!list?.length) return
    setBusy(L('Lendo os arquivos…', 'Reading the files…'))
    void addWikiFiles([...list]).then((errs) => (setErrors(errs), setBusy('')))
  }
  const addLink = (): void => {
    if (!link.trim()) return
    setBusy(L('Baixando a página…', 'Fetching the page…'))
    void call('wikiAddLink', { url: link }).then(
      () => (setLink(''), setBusy(''), setErrors([])),
      (e: Error) => (setBusy(''), setErrors([e.message]))
    )
  }
  const addNote = (): void => {
    if (!note.trim()) return
    void call('wikiAddNote', { text: note }).then(() => setNote(''))
  }
  return (
    <div className="wk-add">
      <label className="wk-add__tile wk-add__tile--file">
        <span className="wk-add__icons">
          <span className="wk-badge-file" style={{ ['--k' as string]: 'var(--c-rose)' }}>PDF</span>
          <span className="wk-badge-file" style={{ ['--k' as string]: 'var(--c-indigo)' }}>DOC</span>
          <span className="wk-badge-file" style={{ ['--k' as string]: 'var(--c-green)' }}>XLS</span>
        </span>
        <b>{L('Um arquivo', 'A file')}</b>
        <small>{L('Escolha, ou arraste pra qualquer lugar da wiki', 'Choose one, or drag it anywhere in the wiki')}</small>
        <input type="file" multiple accept={ACCEPT} hidden onChange={(e) => (files(e.target.files), (e.target.value = ''))} />
      </label>
      <div className="wk-add__tile">
        <span className="wk-add__icons">
          <span className="wk-badge-file wk-badge-file--icon">
            <Icon name="globe" size={14} />
          </span>
        </span>
        <b>{L('Um link', 'A link')}</b>
        <div className="wk-add__line">
          <input placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addLink()} />
          <button className="btn btn--sm" disabled={!link.trim()} onClick={addLink}>
            {L('Trazer', 'Bring')}
          </button>
        </div>
      </div>
      <div className="wk-add__tile">
        <span className="wk-add__icons">
          <span className="wk-badge-file wk-badge-file--icon">
            <Icon name="edit" size={14} />
          </span>
        </span>
        <b>{L('Uma anotação', 'A note')}</b>
        <div className="wk-add__line">
          <input placeholder={L('A Helena prefere WhatsApp…', 'Helen prefers texting…')} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addNote()} />
          <button className="btn btn--sm" disabled={!note.trim()} onClick={addNote}>
            {L('Guardar', 'Keep')}
          </button>
        </div>
      </div>
      {(busy || errors.length > 0) && (
        <div className="wk-add__msg">
          {busy && <small className="muted">{busy}</small>}
          {errors.map((e) => (
            <small key={e} className="field__error">
              {e}
            </small>
          ))}
        </div>
      )}
    </div>
  )
}

function WikiSources({ errors }: { errors: string[] }): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [list, setList] = useState<WikiSource[] | null>(null)
  useEffect(() => void call('wikiSources').then(setList), [rev])
  return (
    <div className="wk-pane">
      <PaneHead icon="book" title={L('Fontes', 'Sources')} lede={L('O material de onde a wiki sai. O curador lê cada fonte e escreve nas páginas, citando de onde veio.', 'What the wiki is made from. The curator reads each source and writes in the pages, citing where it came from.')} />
      <AddSources errors={errors} />
      {list && list.length > 0 && (
        <div className="wk-sources">
          {list.map((s) => (
            <button key={s.id} className="wk-source" onClick={() => navigate({ kind: 'wiki', source: s.file })}>
              <SourceBadge s={s} />
              <span className="wk-source__main">
                <b>{s.title}</b>
                <small>
                  {KIND_LABEL(s.kind)} · {rel(s.addedAt)}
                </small>
              </span>
              <SourceStatus s={s} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// On a server the original comes to the browser, as a download.
function download(file: { name: string; data: string } | null): void {
  if (!file) return
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([Uint8Array.from(atob(file.data), (c) => c.charCodeAt(0))]))
  a.download = file.name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

function WikiSourceView({ id }: { id: string }): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [src, setSrc] = useState<(WikiSource & { text: string }) | null | undefined>(undefined)
  // Admins of a team may delete a source for good (the pages made from it stay); one person alone sees it as always.
  const canRemove = useStore((s) => amAdmin(s) && s.people.length > 1)
  const [removing, setRemoving] = useState(false)
  useEffect(() => void call('wikiSource', { id }).then(setSrc), [id, rev])
  if (src === undefined) return null
  if (!src)
    return (
      <div className="wk-read">
        <p className="muted">{L('Essa fonte não existe mais.', 'This source no longer exists.')}</p>
      </div>
    )
  return (
    <div className="wk-read">
      <button className="text-btn wk-back" onClick={() => navigate({ kind: 'wiki', tab: 'sources' })}>
        ← {L('Fontes', 'Sources')}
      </button>
      <div className="wk-read__kicker">
        <SourceBadge s={src} />
        <span>
          {KIND_LABEL(src.kind)} · {when(src.addedAt)}
        </span>
        <SourceStatus s={src} />
      </div>
      <h1 className="wk-read__title">{src.title}</h1>
      {src.private && <p className="muted">{L('Veio da conversa privada de alguém: só essa pessoa lê o que ela diz. Dá pra apagar a fonte, junto com as mudanças feitas dela.', "It came from someone's private conversation: only they read what it says. You can delete the source, along with the changes made from it.")}</p>}
      <div className="wk-row">
        {src.origin.conversationId && (
          <button className="btn btn--sm" onClick={() => navigate({ kind: 'conversation', id: src.origin.conversationId! })}>
            {L('Abrir a conversa', 'Open the conversation')}
          </button>
        )}
        {src.origin.original && (
          <button className="btn btn--sm" onClick={() => void call('wikiOpenOriginal', { id: src.id }).then(download)}>
            {L('Abrir o arquivo original', 'Open the original file')}
          </button>
        )}
        {src.origin.url && (
          <button className="btn btn--sm" onClick={() => void call('openExternal', { url: src.origin.url! })}>
            {L('Abrir o link', 'Open the link')}
          </button>
        )}
        {src.status === 'failed' && (
          <button className="btn btn--sm" onClick={() => void call('wikiIngestAgain', { id: src.id })}>
            {L('Tentar de novo', 'Try again')}
          </button>
        )}
        {canRemove &&
          (removing ? (
            <button className="btn btn--sm btn--danger" onClick={() => void call('wikiRemoveSource', { id: src.id }).then(() => navigate({ kind: 'wiki', tab: 'sources' }))}>
              {L('Apagar de vez (as páginas ficam)', 'Delete for good (the pages stay)')}
            </button>
          ) : (
            <button className="btn btn--sm" onClick={() => setRemoving(true)}>
              {L('Apagar a fonte', 'Delete the source')}
            </button>
          ))}
      </div>
      {src.error && <p className="field__error">{src.error}</p>}
      {!src.private && (
        <article className="wk-doc md wk-doc--source">
          <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]}>{src.text.trimStart().replace(/^# .*\n+/, '')}</Markdown>
        </article>
      )}
    </div>
  )
}

// ---------- in the conversation ----------

// Under a reply: what the curator kept from this exchange, with Undo (or Approve, if it waits).
export function WikiChip({ id }: { id: string }): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const [c, setC] = useState<WikiChange | null>(null)
  useEffect(() => void call('wikiChange', { id }).then(setC), [id, rev])
  if (!c || c.state === 'refused') return null
  const pages = [...new Set(c.ops.map((o) => o.page))]
  const label = c.state === 'applied' ? L('Guardou na wiki', 'Kept in the wiki') : c.state === 'undone' ? L('Desfeito na wiki', 'Undone in the wiki') : c.state === 'conflict' ? L('Mudança na wiki com conflito', 'Wiki change with a conflict') : L('Quer guardar na wiki', 'Wants to keep in the wiki')
  return (
    <div className={`memory-chip wiki-chip wiki-chip--${c.state}`}>
      <Icon name="layers" size={13} />
      <span className="memory-chip__label">{label}:</span>
      <span className="memory-chip__text">
        {pages.map((t) => (
          <button key={t} className="wiki-link" onClick={() => navigate({ kind: 'wiki', title: t })}>
            {t}
          </button>
        ))}
      </span>
      {c.state === 'applied' && (
        <button className="link" onClick={() => void call('wikiUndoChange', { id })}>
          {L('Desfazer', 'Undo')}
        </button>
      )}
      {c.state === 'pending' && (
        <>
          <button className="btn btn--xs btn--primary" onClick={() => void call('wikiApplyChange', { id })}>
            {L('Guardar', 'Keep')}
          </button>
          <button className="btn btn--xs btn--ghost" onClick={() => navigate({ kind: 'wiki', tab: 'pending' })}>
            {L('Ver', 'See')}
          </button>
        </>
      )}
    </div>
  )
}

// "Keep in the wiki", on a message: the curator reads it now and keeps it.
export function KeepInWiki({ messageId }: { messageId: string }): ReactNode {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'none'>('idle')
  const [error, setError] = useState('')
  if (state === 'done') return null // the chip above says what was kept
  return (
    <span className="wiki-keep">
      <button
        className="link"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy')
          void call('wikiKeepMessage', { messageId }).then(
            (n) => setState(n ? 'done' : 'none'),
            (e: Error) => (setState('idle'), setError(e.message))
          )
        }}
      >
        {state === 'busy' ? L('Guardando…', 'Keeping…') : state === 'none' ? L('Nada pra guardar', 'Nothing to keep') : L('Guardar na wiki', 'Keep in the wiki')}
      </button>
      {error && <small className="field__error"> {error}</small>}
    </span>
  )
}

// ---------- a page ----------

// The sources a page cites, once each, in the order they appear.
function sourcesIn(body: string): { file: string; label: string }[] {
  const out = new Map<string, string>()
  for (const m of body.matchAll(/\[\[(fontes\/[^\]|\n]+)(?:\|([^\]\n]+))?\]\]/g)) {
    const file = m[1]!.trim()
    const name = file.replace(/^fontes\/\d{4}-\d\d-\d\d \d{4} /, '')
    if (!out.has(file)) out.set(file, m[2] && !/^(fonte|source)$/i.test(m[2].trim()) ? m[2].trim() : name)
  }
  return [...out].map(([file, label]) => ({ file, label }))
}

function WikiPageView({ title, data }: { title: string; data: WikiData | null }): ReactNode {
  const rev = useStore((s) => s.wikiRev)
  const who = useWho()
  const [page, setPage] = useState<WikiPage | null | undefined>(undefined)
  const [history, setHistory] = useState<WikiVersion[] | null>(null)
  const [sources, setSources] = useState<WikiSource[]>([])
  const [error, setError] = useState('')
  useEffect(() => void call('wikiPage', { title }).then(setPage), [title, rev])
  useEffect(() => void call('wikiSources').then(setSources), [rev])
  useEffect(() => {
    if (history) void call('wikiHistory', { title }).then(setHistory)
  }, [rev])
  if (page === undefined) return null
  if (page === null)
    return (
      <div className="wk-read">
        <h1 className="wk-read__title">{title}</h1>
        <p className="muted">{L('Essa página não existe (ainda).', "This page doesn't exist (yet).")}</p>
        <button className="btn btn--primary" onClick={() => navigate({ kind: 'wiki', title, edit: true })}>
          {L('Escrever essa página', 'Write this page')}
        </button>
      </div>
    )
  const missing = new Set(page.missing.map((t) => t.toLowerCase()))
  const cited = sourcesIn(page.body)
  const remove = (): void =>
    void confirmDialog({
      title: L(`Apagar “${page.title}”?`, `Delete “${page.title}”?`),
      body: L('Dá pra restaurar pelo histórico.', 'It can be restored from the history.'),
      confirm: L(`Apagar “${page.title}”`, `Delete “${page.title}”`)
    }).then((ok) => {
      if (ok) void call('wikiRemove', { title: page.title }).then(() => navigate({ kind: 'wiki' }))
    })
  const kindOf = (t: string): string => data?.pages.find((p) => p.title === t)?.kind ?? ''
  return (
    <article className="wk-page" style={{ ['--k' as string]: kindColor(page.kind) }}>
      <div className="wk-page__kicker">
        <KindPill kind={page.kind} />
        <span className="wk-page__meta">
          <Who by={page.updatedBy} size={18} />
          {L(`${who(page.updatedBy)} · ${rel(page.updatedAt)}`, `${who(page.updatedBy)} · ${rel(page.updatedAt)}`)}
        </span>
      </div>
      <h1 className="wk-page__title">{page.title}</h1>
      <div className="wk-doc md">
        <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={mdLinks(missing)}>
          {wikiLinks(page.body)}
        </Markdown>
      </div>

      {page.backlinks.length > 0 && (
        <section className="wk-page__more">
          <h5>{L('Quem cita esta página', 'Pages that cite this one')}</h5>
          <div className="wk-page__chips">
            {page.backlinks.map((t) => (
              <button key={t} className="wk-pill" style={{ ['--k' as string]: kindColor(kindOf(t)) }} onClick={() => navigate({ kind: 'wiki', title: t })}>
                <i />
                {t}
              </button>
            ))}
          </div>
        </section>
      )}
      {cited.length > 0 && (
        <section className="wk-page__more">
          <h5>{L('De onde veio', 'Where it came from')}</h5>
          {cited.map((c) => {
            const s = sources.find((x) => x.file === c.file)
            return (
              <button key={c.file} className="wk-page__source" onClick={() => navigate({ kind: 'wiki', source: c.file })}>
                {s ? <SourceBadge s={s} /> : <Icon name="book" size={13} />}
                <span>
                  <b>{s?.title ?? c.label}</b>
                  {s && <small>{rel(s.addedAt)}</small>}
                </span>
              </button>
            )
          })}
        </section>
      )}
      {history && (
        <section className="wk-page__more">
          <h5>{L('Histórico', 'History')}</h5>
          {error && <p className="field__error">{error}</p>}
          <ol className="wk-history">
            {history.map((v) => (
              <li key={v.id}>
                <Who by={v.by} size={18} />
                <span>
                  <b>{who(v.by)}</b> {v.action === 'create' ? L('escreveu', 'wrote') : v.action === 'delete' ? L('apagou', 'deleted') : L('mudou', 'changed')}
                  <small>
                    {when(v.at)}
                    {v.reason ? ` · ${v.reason}` : ''}
                  </small>
                </span>
                {v.after !== null && v.after !== page.body && (
                  <button className="text-btn" onClick={() => void call('wikiRestore', { id: v.id }).then(() => setError(''), (e: Error) => setError(e.message))}>
                    {L('voltar a esta', 'restore')}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      <footer className="wk-page__tools">
        <button className="btn btn--primary btn--sm" title={L('Editar (E)', 'Edit (E)')} onClick={() => navigate({ kind: 'wiki', title: page.title, edit: true })}>
          <Icon name="edit" size={13} /> {L('Editar', 'Edit')}
        </button>
        <button className="btn btn--ghost btn--sm" onClick={() => (history ? setHistory(null) : void call('wikiHistory', { title: page.title }).then(setHistory))}>
          <Icon name="clock" size={13} /> {history ? L('Esconder histórico', 'Hide history') : L('Histórico', 'History')}
        </button>
        <span className="grow" />
        <button className="btn btn--ghost btn--sm wk-icon-btn" title={L('Apagar', 'Delete')} onClick={remove}>
          <Icon name="trash" size={14} />
        </button>
      </footer>
    </article>
  )
}

// ---------- the editor (a page, or the schema when there's no title at all) ----------

function WikiEditor({ title }: { title?: string }): ReactNode {
  const schemaMode = title === undefined
  const [page, setPage] = useState<WikiPage | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState(title ?? '')
  const [kind, setKind] = useState('')
  const [body, setBody] = useState('')
  const [kinds, setKinds] = useState<string[]>(DEFAULT_KINDS())
  const [error, setError] = useState('')
  useEffect(() => {
    if (schemaMode) {
      void call('wikiSchema').then((t) => (setBody(t), setLoaded(true)))
      return
    }
    void call('wiki').then((w) => setKinds([...new Set([...DEFAULT_KINDS(), ...w.kinds])]))
    if (!title) return setLoaded(true)
    void call('wikiPage', { title }).then((p) => {
      setPage(p)
      if (p) (setName(p.title), setKind(p.kind), setBody(p.body.replace(/^\s*\n/, '')))
      else setBody('')
      setLoaded(true)
    })
  }, [])
  if (!loaded) return null
  const save = (): void => {
    setError('')
    if (schemaMode) return void call('wikiSaveSchema', { text: body }).then(() => navigate({ kind: 'wiki' }))
    void call('wikiSave', { title: name, body, kind: kind || DEFAULT_KINDS()[2]!, ...(page ? { expectedHash: page.hash, rename: page.title } : {}) }).then(
      (p) => navigate({ kind: 'wiki', title: p.title }),
      (e: Error) => setError(e.message)
    )
  }
  const back = (): void => navigate(schemaMode || !page ? { kind: 'wiki' } : { kind: 'wiki', title: page.title })
  return (
    <Sheet
      fill
      title={schemaMode ? L('Esquema da wiki', 'Wiki schema') : page ? L('Editando', 'Editing') : L('Nova página', 'New page')}
      lede={schemaMode ? L('As regras da wiki: os tipos de página e como escrever. Os agentes e o curador seguem esta página.', 'The wiki rules: the kinds of page and how to write. The agents and the curator follow this page.') : L('Markdown. Ligue páginas com [[Título]]; uma que ainda não existe vira um convite pra escrever.', "Markdown. Link pages with [[Title]]; one that doesn't exist yet becomes an invitation to write it.")}
      back={{ label: L('Voltar', 'Back'), onClick: back }}
      actions={
        <>
          <button className="btn btn--ghost btn--sm" onClick={back}>
            {L('Cancelar', 'Cancel')}
          </button>
          <button className="btn btn--primary btn--sm" disabled={!schemaMode && !name.trim()} onClick={save}>
            {L('Salvar', 'Save')}
          </button>
        </>
      }
    >
      <div className="wiki-editor">
        {!schemaMode && (
          <div className="wiki-editor__head" style={{ ['--k' as string]: kindColor(kind) }}>
            <input className="wiki-editor__title" placeholder={L('Título, ex.: Marcos Lima', 'Title, e.g. Mark Lee')} value={name} onChange={(e) => setName(e.target.value)} autoFocus={!title} />
            <div className="wiki-editor__kinds">
              {kinds.map((k) => (
                <button key={k} type="button" className={`wk-pill ${fold(k) === fold(kind) ? 'is-on' : ''}`} style={{ ['--k' as string]: kindColor(k) }} onClick={() => setKind(k)}>
                  <i />
                  {k}
                </button>
              ))}
              <input className="wiki-editor__kind" placeholder={L('outro tipo…', 'another kind…')} value={kinds.some((k) => fold(k) === fold(kind)) ? '' : kind} onChange={(e) => setKind(e.target.value)} />
            </div>
          </div>
        )}
        {error && <p className="field__error">{error}</p>}
        <div className="wiki-editor__panes">
          <textarea className="wiki-editor__text" value={body} onChange={(e) => setBody(e.target.value)} spellCheck placeholder={L('Comece com uma frase que diga o que é. Depois, seções com ##.', 'Start with one sentence that says what it is. Then sections with ##.')} />
          <div className="wiki-editor__preview wk-doc md">
            {body.trim() ? (
              <Markdown urlTransform={safeUrl} remarkPlugins={[remarkGfm]} components={mdLinks()}>
                {wikiLinks(body)}
              </Markdown>
            ) : (
              <p className="muted">{L('A prévia aparece aqui.', 'The preview shows up here.')}</p>
            )}
          </div>
        </div>
      </div>
    </Sheet>
  )
}
